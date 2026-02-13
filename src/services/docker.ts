// ============================================================================
// Docker Container Service
// ============================================================================

import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { dockerIsRunning } from 'build-strap';
import { $ } from 'bun';
import { nanoid } from 'nanoid';
import packageJson from '../../package.json' with { type: 'json' };
// Import both Dockerfiles as text - Bun's bundler embeds these in the binary
import FULL_DOCKERFILE from '../../sandbox/full.Dockerfile' with {
  type: 'text',
};
import SLIM_DOCKERFILE from '../../sandbox/slim.Dockerfile' with {
  type: 'text',
};
import { runDockerSetupScreen } from '../components/DockerSetup';
import {
  enterSubprocessScreen,
  formatShellError,
  resetTerminal,
  type ShellError,
} from '../utils';
import { getClaudeConfigFiles } from './claude';
import {
  type AgentType,
  type HermesConfig,
  projectConfigDir,
  readConfig,
  userConfigDir,
} from './config';
import { getGhConfigFiles } from './gh';
import type { RepoInfo } from './git';
import { log } from './logger';
import { getOpencodeConfigFiles } from './opencode';
import { runInDocker, type VirtualFile } from './runInDocker';

/**
 * Escape a string for safe use in shell commands using base64 encoding.
 * This approach avoids any shell interpretation of special characters
 * by encoding the entire string and decoding it at runtime.
 */
function base64Encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

export const toVolumeArgs = (volumes: string[]): string[] =>
  volumes.flatMap((v) => ['-v', v]);

export const getCredentialFiles = async (): Promise<VirtualFile[]> => {
  const [claudeFiles, opencodeFiles, ghFiles] = await Promise.all([
    getClaudeConfigFiles(),
    getOpencodeConfigFiles(),
    getGhConfigFiles(),
  ]);
  return [...claudeFiles, ...opencodeFiles, ...ghFiles];
};

// ============================================================================
// Container Labels
// ============================================================================

export type ExecType = 'agent' | 'shell';

export interface HermesContainerLabels {
  /** Session display name */
  name: string;
  /** Branch name (often same as name) */
  branch: string;
  /** Agent type (claude or opencode) */
  agent: AgentType;
  /** Execution type: agent session or shell */
  execType?: ExecType;
  /** Repository full name */
  repo?: string;
  /** The user prompt */
  prompt?: string;
  /** Whether this is an interactive session */
  interactive?: boolean;
  /** Model ID */
  model?: string;
  /** Mounted host directory (absolute path) */
  mount?: string;
  /** Set when not in a git repo */
  noGit?: boolean;
  /** Container name this was resumed from */
  resumedFrom?: string;
  /** Docker image used for resume */
  resumeImage?: string;
}

/**
 * Build Docker container labels for hermes-managed containers.
 * Automatically sets `hermes.managed=true` and `hermes.created` timestamp.
 * Returns a Record suitable for passing to `runInDocker({ labels })`.
 */
export function buildHermesLabels(
  input: HermesContainerLabels,
): Record<string, string> {
  const result: Record<string, string> = {
    'hermes.managed': 'true',
    'hermes.name': input.name,
    'hermes.branch': input.branch,
    'hermes.agent': input.agent,
    'hermes.exec-type': input.execType ?? 'agent',
    'hermes.repo': input.repo ?? 'local',
    'hermes.created': new Date().toISOString(),
  };
  if (input.prompt != null) result['hermes.prompt'] = input.prompt;
  if (input.interactive != null)
    result['hermes.interactive'] = String(input.interactive);
  if (input.model) result['hermes.model'] = input.model;
  if (input.mount) result['hermes.mount'] = input.mount;
  if (input.noGit) result['hermes.no-git'] = 'true';
  if (input.resumedFrom) result['hermes.resumed-from'] = input.resumedFrom;
  if (input.resumeImage) result['hermes.resume-image'] = input.resumeImage;
  return result;
}

/**
 * Create local directories for overlay mounts and return volume mount strings.
 * Overlay mounts are stored in .hermes/overlayMounts/<containerName>/<path>
 * and bind-mounted into the container at /work/app/<path>.
 */
async function createOverlayDirs(
  containerName: string,
  overlayMounts?: string[],
): Promise<string[]> {
  if (!overlayMounts?.length) return [];
  const volumes: string[] = [];
  for (const overlayPath of overlayMounts) {
    const hostDir = join(
      projectConfigDir(),
      'overlayMounts',
      containerName,
      overlayPath,
    );
    await mkdir(hostDir, { recursive: true });
    volumes.push(`${resolve(hostDir)}:/work/app/${overlayPath}`);
  }
  return volumes;
}

/**
 * Clean up overlay mount directories for a container.
 * Runs cleanup inside a Docker container first to handle files owned by
 * the container UID (10000), then removes the empty directory from the host.
 */
async function cleanupOverlayDirs(containerName: string): Promise<void> {
  const overlaysRoot = join(projectConfigDir(), 'overlayMounts');
  try {
    // Clean up inside a Docker container to handle files owned by container UID
    await $`docker run --rm -v ${resolve(overlaysRoot)}:/cleanup alpine rm -rf /cleanup/${containerName}`.quiet();
  } catch {
    // Ignore docker cleanup errors
  }
  try {
    // Remove the directory from the host (may already be gone after docker cleanup)
    await rm(join(overlaysRoot, containerName), {
      recursive: true,
      force: true,
    });
  } catch {
    // Ignore host cleanup errors
  }
}

const escapePrompt = (cmd: string, prompt?: string | null): string =>
  prompt
    ? `
HERMES_PROMPT="$(echo '${base64Encode(prompt)}' | base64 -d)"
exec ${cmd} "$HERMES_PROMPT"
`.trim()
    : `exec ${cmd}`;

// ============================================================================
// Sandbox Image Configuration
// ============================================================================

const DOCKER_IMAGE_NAME = 'hermes-sandbox';

// GHCR (GitHub Container Registry) base path
const GHCR_BASE = 'ghcr.io/timescale/hermes';

// ============================================================================
// Pull TTL - avoid excessive pulls by tracking last pull time
// ============================================================================

/** How long before we re-pull an image tag (4 hours) */
const PULL_TTL_MS = 4 * 60 * 60 * 1000;

function getPullStatusPath(): string {
  return join(userConfigDir(), 'pull-status.json');
}

interface PullStatus {
  [imageTag: string]: number; // timestamp (ms) of last successful pull
}

const readPullStatus = (): Promise<PullStatus> =>
  Bun.file(getPullStatusPath())
    .json()
    .catch(() => ({}));

async function recordPullTime(imageTag: string): Promise<void> {
  try {
    const status = await readPullStatus();
    status[imageTag] = Date.now();
    await Bun.write(getPullStatusPath(), JSON.stringify(status));
  } catch (error) {
    log.error({ error, imageTag }, 'Failed to record pull time');
  }
}

async function shouldPull(imageTag: string): Promise<boolean> {
  const status = await readPullStatus();
  const lastPull = status[imageTag];
  if (lastPull == null) return true;
  return Date.now() - lastPull > PULL_TTL_MS;
}

type DockerfileVariant = 'slim' | 'full';

function computeDockerfileHash(content: string): string {
  const hasher = new Bun.CryptoHasher('md5');
  hasher.update(content);
  return hasher.digest('hex').slice(0, 12);
}

function getGhcrImageTags(variant: DockerfileVariant): {
  version: string;
  latest: string;
} {
  const imageName = `${GHCR_BASE}/sandbox-${variant}`;
  return {
    version: `${imageName}:${packageJson.version}`,
    latest: `${imageName}:latest`,
  };
}

/**
 * Get the Dockerfile content based on config.
 * Returns null if building is not configured.
 */
async function getDockerfileContent(
  which?: string | boolean | null,
): Promise<{ content: string; variant: DockerfileVariant | 'custom' } | null> {
  if (!which) return null;

  if (which === true || which === 'slim') {
    return { content: SLIM_DOCKERFILE, variant: 'slim' };
  }

  if (which === 'full') {
    return { content: FULL_DOCKERFILE, variant: 'full' };
  }

  // Custom path - read file
  const file = Bun.file(which);
  if (!(await file.exists())) {
    throw new Error(`Dockerfile not found: ${which}`);
  }
  return { content: await file.text(), variant: 'custom' };
}

async function getDockerfileInfo(
  which?: string | boolean | null,
): Promise<null | {
  image: string;
  tag: string;
  content: string;
  variant: DockerfileVariant | 'custom';
}> {
  const result = await getDockerfileContent(which);
  if (!result) return null;
  const { content, variant } = result;
  const hash = computeDockerfileHash(content);
  const tag = `md5-${hash}`;
  return {
    image: `${DOCKER_IMAGE_NAME}:md5-${hash}`,
    tag,
    content,
    variant,
  };
}

/**
 * Configuration for resolved sandbox image.
 */
export interface SandboxImageConfig {
  /** The image:tag to use for running containers */
  image: string;
  /** Whether this image needs to be built (vs just pulled) */
  needsBuild: boolean;
  /** Dockerfile content if building */
  dockerfileContent?: string;
  /** Which GHCR variant to use for cache ('slim' | 'full') */
  cacheVariant: DockerfileVariant;
}

/**
 * Resolve which Docker image to use based on configuration.
 *
 * Priority:
 * 1. buildSandboxFromDockerfile - build from Dockerfile (highest)
 * 2. sandboxBaseImage - use explicit image
 * 3. Default - pull GHCR sandbox-slim image
 *
 * @param configOverride - Optional config to use instead of reading from filesystem (useful for testing)
 */
export async function resolveSandboxImage(
  configOverride?: HermesConfig,
): Promise<SandboxImageConfig> {
  const config = configOverride ?? (await readConfig());

  // Highest precedence: buildSandboxFromDockerfile
  if (config.buildSandboxFromDockerfile) {
    const dockerfile = await getDockerfileInfo(
      config.buildSandboxFromDockerfile,
    );
    if (!dockerfile) {
      throw new Error('Failed to get Dockerfile content');
    }

    const variant: DockerfileVariant =
      dockerfile.variant === 'full' ? 'full' : 'slim';

    return {
      image: dockerfile.image,
      needsBuild: true,
      dockerfileContent: dockerfile.content,
      cacheVariant: variant,
    };
  }

  // Second precedence: sandboxBaseImage (explicit override)
  if (config.sandboxBaseImage) {
    return {
      image: config.sandboxBaseImage,
      needsBuild: false,
      cacheVariant: 'slim', // Not used when needsBuild is false
    };
  }

  // Default: use GHCR sandbox-slim image
  // Always return the version-tagged image. The caller (ensureDockerImage)
  // handles pulling and falling back to :latest if the versioned image
  // isn't available. We intentionally don't fall back to :latest here,
  // because that would cause dockerImageExists() to return true and skip
  // the pull flow entirely — meaning the versioned image would never be pulled.
  const ghcrTags = getGhcrImageTags('slim');

  return {
    image: ghcrTags.version,
    needsBuild: false,
    cacheVariant: 'slim',
  };
}

// ============================================================================
/**
 * Check if a specific Docker image exists locally.
 */
async function imageExists(imageName: string): Promise<boolean> {
  try {
    const proc = await $`docker image ls --format json ${imageName}`.quiet();
    const output = proc.json();
    const exists =
      proc.exitCode === 0 && imageName === `${output.Repository}:${output.Tag}`;
    log.debug({ imageName, exists }, 'imageExists');
    return exists;
  } catch {
    return false;
  }
}

/**
 * Check if the resolved sandbox Docker image exists locally.
 */
export async function dockerImageExists(): Promise<boolean> {
  const imageConfig = await resolveSandboxImage();
  return imageExists(imageConfig.image);
}

export const ensureDockerSandbox = async (): Promise<void> => {
  // Check if Docker is running and image exists
  // If either is false, run the setup screen which handles both
  if (!(await dockerIsRunning()) || !(await dockerImageExists())) {
    const dockerResult = await runDockerSetupScreen();
    log.debug({ dockerResult }, 'ensureDockerSandbox');
    if (dockerResult.type === 'cancelled') {
      throw new Error('Docker setup was cancelled by the user');
    }
    if (dockerResult.type === 'error') {
      throw new Error(`Docker setup failed: ${dockerResult.error}`);
    }
  }
};

// ============================================================================
// GHCR (GitHub Container Registry) Image Pull
// ============================================================================

/**
 * Try to pull a specific image tag
 * Returns true if successful, false otherwise
 */
async function tryPullImage(imageTag: string): Promise<boolean> {
  try {
    await $`docker pull ${imageTag}`.quiet();
    await recordPullTime(imageTag);
    return true;
  } catch {
    return false;
  }
}

type ProgressCallback = (message: string) => void;

/**
 * Pull GHCR image for use as build cache.
 * Tries version-tagged image first, falls back to latest.
 * Returns the image tag that was successfully pulled, or null if all pulls failed.
 */
async function pullGhcrImageForCache(
  ghcrTags: { version: string; latest: string },
  onProgress?: ProgressCallback,
): Promise<string | null> {
  // Try version-tagged image first (closer cache match)
  onProgress?.('Pulling versioned sandbox image');
  if (await tryPullImage(ghcrTags.version)) {
    return ghcrTags.version;
  }
  log.warn(
    { image: ghcrTags.version },
    'Versioned GHCR image not found, falling back to latest',
  );

  // Fall back to latest
  onProgress?.('Pulling latest sandbox image');
  if (await tryPullImage(ghcrTags.latest)) {
    return ghcrTags.latest;
  }
  log.error({ image: ghcrTags.latest }, 'Latest GHCR image not found');

  return null;
}

/**
 * Build docker image from Dockerfile content, optionally using a pulled image as cache.
 */
async function buildDockerImage(
  imageName: string,
  dockerfileContent: string,
  cacheFromImage?: string | null,
): Promise<void> {
  const proc = Bun.spawn(
    [
      'docker',
      'build',
      '-q',
      ...(cacheFromImage ? ['--cache-from', cacheFromImage] : []),
      '-t',
      imageName,
      '-',
    ],
    {
      stdin: Buffer.from(dockerfileContent),
      stdout: 'ignore',
      stderr: 'ignore',
    },
  );

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`Docker build failed with exit code ${exitCode}`);
  }
}

export type ImageBuildProgress =
  | { type: 'checking' }
  | { type: 'exists' }
  | { type: 'pulling'; message: string }
  | { type: 'pulling-cache'; message: string }
  | { type: 'building'; message: string }
  | { type: 'done' };

export interface EnsureDockerImageOptions {
  onProgress?: (progress: ImageBuildProgress) => void;
}

/**
 * Ensure the sandbox Docker image is available.
 * Handles three flows based on configuration:
 * 1. buildSandboxFromDockerfile - build from Dockerfile (uses GHCR for cache)
 * 2. sandboxBaseImage - pull explicit image (fails if unavailable)
 * 3. Default - pull GHCR sandbox-slim image (version first, then latest)
 *
 * @returns The resolved image name that was ensured
 */
export async function ensureDockerImage(
  options: EnsureDockerImageOptions = {},
): Promise<string> {
  const { onProgress } = options;
  const imageConfig = await resolveSandboxImage();
  const config = await readConfig();

  onProgress?.({ type: 'checking' });

  // Flow 1: Build from Dockerfile
  if (imageConfig.needsBuild) {
    // Check if image already exists locally
    if (await imageExists(imageConfig.image)) {
      onProgress?.({ type: 'exists' });
      return imageConfig.image;
    }

    // Try to pull GHCR image for cache
    onProgress?.({
      type: 'pulling-cache',
      message: 'Pulling sandbox image for cache',
    });
    const ghcrTags = getGhcrImageTags(imageConfig.cacheVariant);
    const cacheImage = await pullGhcrImageForCache(ghcrTags, (message) =>
      onProgress?.({ type: 'pulling-cache', message }),
    );

    // Build from Dockerfile
    onProgress?.({
      type: 'building',
      message: 'Building sandbox docker image',
    });
    if (!imageConfig.dockerfileContent) {
      throw new Error('Dockerfile content is required for building');
    }
    await buildDockerImage(
      imageConfig.image,
      imageConfig.dockerfileContent,
      cacheImage,
    );

    onProgress?.({ type: 'done' });
    return imageConfig.image;
  }

  // Flow 2: sandboxBaseImage configured - must pull, fail if unavailable
  if (config.sandboxBaseImage) {
    // Check if already exists locally
    if (await imageExists(imageConfig.image)) {
      onProgress?.({ type: 'exists' });
      return imageConfig.image;
    }

    onProgress?.({
      type: 'pulling',
      message: `Pulling ${imageConfig.image}`,
    });
    const pulled = await tryPullImage(imageConfig.image);
    if (!pulled) {
      throw new Error(
        `Failed to pull configured sandbox image: ${imageConfig.image}`,
      );
    }
    onProgress?.({ type: 'done' });
    return imageConfig.image;
  }

  // Flow 3: Default - pull GHCR image (version first, then latest)
  const ghcrTags = getGhcrImageTags('slim');

  // Check if versioned image exists locally (exact version match, no pull needed)
  if (await imageExists(ghcrTags.version)) {
    onProgress?.({ type: 'exists' });
    return ghcrTags.version;
  }

  // Try to pull versioned image
  onProgress?.({
    type: 'pulling',
    message: 'Pulling versioned sandbox image',
  });
  if (await tryPullImage(ghcrTags.version)) {
    onProgress?.({ type: 'done' });
    return ghcrTags.version;
  }

  // Versioned image not available — fall back to :latest
  // If :latest exists locally, re-pull it if the TTL has expired to ensure freshness
  const latestExistsLocally = await imageExists(ghcrTags.latest);
  if (latestExistsLocally && (await shouldPull(ghcrTags.latest))) {
    onProgress?.({
      type: 'pulling',
      message: 'Refreshing latest sandbox image',
    });
    await tryPullImage(ghcrTags.latest);
    // Use the local image regardless of whether the refresh pull succeeded
    onProgress?.({ type: 'done' });
    return ghcrTags.latest;
  }
  if (latestExistsLocally) {
    // TTL has not expired — use the local image as-is
    onProgress?.({ type: 'exists' });
    return ghcrTags.latest;
  }

  // :latest doesn't exist locally either — pull it
  onProgress?.({
    type: 'pulling',
    message: 'Pulling latest sandbox image',
  });
  if (await tryPullImage(ghcrTags.latest)) {
    onProgress?.({ type: 'done' });
    return ghcrTags.latest;
  }

  // Final fallback: build the slim image locally
  const info = await getDockerfileInfo('slim');
  if (!info) {
    throw new Error('Failed to get Dockerfile content embedded slim image.');
  }
  await buildDockerImage(info.image, info.content);
  onProgress?.({ type: 'done' });
  return info.image;
}

// ============================================================================
// Container Options
// ============================================================================

export interface StartContainerOptions {
  branchName: string;
  prompt: string;
  repoInfo: RepoInfo | null;
  agent: AgentType;
  model?: string;
  detach: boolean;
  interactive: boolean;
  envVars?: Record<string, string>;
  /** If set, mount this local directory into the container instead of git clone */
  mountDir?: string;
  /** Whether running from a git repository (affects git/gh operations and PR instructions) */
  isGitRepo?: boolean;
  /** Extra arguments to append to the agent command (e.g., ['--agent', 'plan']) */
  agentArgs?: string[];
}

// ============================================================================
// Container Listing and Status
// ============================================================================

export interface HermesSession {
  containerId: string;
  containerName: string;
  name: string;
  branch: string;
  agent: AgentType;
  execType?: ExecType;
  model?: string;
  repo: string;
  prompt: string;
  created: string;
  resumedFrom?: string;
  interactive: boolean;
  /** If set, the local directory that was mounted into the container */
  mountDir?: string;
  status: 'running' | 'exited' | 'paused' | 'restarting' | 'dead' | 'created';
  exitCode?: number;
  startedAt?: string;
  finishedAt?: string;
}

interface DockerInspectResult {
  Id: string;
  Name: string;
  State: {
    Status: string;
    Running: boolean;
    Paused: boolean;
    Restarting: boolean;
    Dead: boolean;
    ExitCode: number;
    StartedAt: string;
    FinishedAt: string;
  };
  Config: {
    Labels: Record<string, string>;
    Env?: string[];
  };
}

/**
 * List all hermes-managed containers with their metadata
 */
export async function listHermesSessions(): Promise<HermesSession[]> {
  try {
    // Get all containers (running and stopped) with hermes.managed=true label
    const result =
      await $`docker ps -a --filter label=hermes.managed=true --format {{.ID}}`.quiet();
    const containerIds = result.stdout
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);

    if (containerIds.length === 0) {
      return [];
    }

    // Inspect each container to get full details
    const inspectResult = await $`docker inspect ${containerIds}`.quiet();
    const containers: DockerInspectResult[] = JSON.parse(
      inspectResult.stdout.toString(),
    );

    return containers.map((container) => {
      const labels = container.Config.Labels;
      const state = container.State;

      let status: HermesSession['status'];
      if (state.Running) {
        status = 'running';
      } else if (state.Paused) {
        status = 'paused';
      } else if (state.Restarting) {
        status = 'restarting';
      } else if (state.Dead) {
        status = 'dead';
      } else if (state.Status === 'created') {
        status = 'created';
      } else {
        status = 'exited';
      }

      return {
        containerId: container.Id.slice(0, 12),
        containerName: container.Name.replace(/^\//, ''),
        name: labels['hermes.name'] || labels['hermes.branch'] || 'unknown',
        branch: labels['hermes.branch'] || 'unknown',
        agent: (labels['hermes.agent'] as AgentType) || 'opencode',
        execType: (labels['hermes.exec-type'] as ExecType) || undefined,
        model: labels['hermes.model'],
        repo: labels['hermes.repo'] || 'unknown',
        prompt: labels['hermes.prompt'] || '',
        created: labels['hermes.created'] || '',
        resumedFrom: labels['hermes.resumed-from'],
        interactive: labels['hermes.interactive'] === 'true',
        mountDir: labels['hermes.mount'],
        status,
        exitCode: status === 'exited' ? state.ExitCode : undefined,
        startedAt: state.StartedAt,
        finishedAt: status === 'exited' ? state.FinishedAt : undefined,
      };
    });
  } catch (error) {
    log.error({ error }, 'Failed to list hermes sessions');
    // If docker command fails, return empty array
    return [];
  }
}

/**
 * Remove a hermes container by name or ID
 */
export async function removeContainer(nameOrId: string): Promise<void> {
  let resumeImage: string | null = null;
  let containerName: string | null = null;
  try {
    const result = await $`docker inspect ${nameOrId}`.quiet();
    const containers: DockerInspectResult[] = JSON.parse(
      result.stdout.toString(),
    );
    const container = containers[0];
    if (container) {
      resumeImage = container.Config.Labels?.['hermes.resume-image'] ?? null;
      containerName = container.Name.replace(/^\//, '') ?? null;
    }
  } catch {
    resumeImage = null;
  }

  await $`docker rm -f ${nameOrId}`.quiet().nothrow();

  if (resumeImage) {
    await $`docker rmi ${resumeImage}`.quiet().nothrow();
  }

  // Clean up overlay mount directories for this container
  if (containerName) {
    await cleanupOverlayDirs(containerName);
  }
}

/**
 * Stop a running container gracefully
 */
export async function stopContainer(nameOrId: string): Promise<void> {
  await $`docker stop ${nameOrId}`.quiet().nothrow();
}

// ============================================================================
// Container Stats
// ============================================================================

export interface ContainerStats {
  containerId: string;
  cpuPercent: number;
  memUsage: string;
  memPercent: number;
}

interface DockerStatsJson {
  ID: string;
  CPUPerc: string;
  MemUsage: string;
  MemPerc: string;
}

/**
 * Fetch CPU/memory stats for the given container IDs (must be running).
 * Returns a Map keyed by container ID.
 */
export async function getContainerStats(
  containerIds: string[],
): Promise<Map<string, ContainerStats>> {
  const result = new Map<string, ContainerStats>();
  if (containerIds.length === 0) return result;

  try {
    for await (const line of $`docker stats --no-stream --format ${'{{json .}}'} ${containerIds}`.lines()) {
      try {
        const data: DockerStatsJson = JSON.parse(line);
        const id = data.ID.slice(0, 12);
        result.set(id, {
          containerId: id,
          cpuPercent: Number.parseFloat(data.CPUPerc.replace('%', '')) || 0,
          memUsage: data.MemUsage,
          memPercent: Number.parseFloat(data.MemPerc.replace('%', '')) || 0,
        });
      } catch (err) {
        log.warn({ line, err }, 'Failed to parse docker stats line');
      }
    }
    log.trace(
      { containerCount: containerIds.length },
      'Fetched container stats',
    );
  } catch (err) {
    log.warn({ err }, 'Failed to fetch container stats');
  }

  return result;
}

/**
 * Format CPU percentage for display (e.g. "12.3%")
 */
export function formatCpuPercent(cpu: number): string {
  return cpu < 10 ? `${cpu.toFixed(1)}%` : `${Math.round(cpu)}%`;
}

/**
 * Format memory usage string for compact display.
 * Input is Docker's format like "256MiB / 8GiB".
 * With short=true, returns only the usage portion: "256M"
 * With short=false, returns both parts: "256M / 8G"
 */
export function formatMemUsage(memUsage: string, short = false): string {
  const shorten = (s: string): string =>
    s
      .trim()
      .replace('GiB', 'G')
      .replace('MiB', 'M')
      .replace('KiB', 'K')
      .replace('TiB', 'T');

  const parts = memUsage.split('/');
  if (parts.length < 2) return shorten(memUsage);

  const usage = shorten(parts[0] ?? '');
  if (short) return usage;

  const limit = shorten(parts[1] ?? '');
  return `${usage} / ${limit}`;
}

/**
 * Normalize line endings for container logs.
 * Converts \r\n and standalone \r to \n.
 */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Get container logs (static snapshot)
 */
export async function getContainerLogs(
  nameOrId: string,
  tail?: number,
): Promise<string> {
  const tailArg = tail ? ['--tail', String(tail)] : [];
  const result = await $`docker logs ${tailArg} ${nameOrId} 2>&1`.quiet();
  return normalizeLineEndings(result.stdout.toString());
}

/**
 * Stream container logs in real-time
 */
export interface LogStream {
  lines: AsyncIterable<string>;
  stop: () => void;
}

export function streamContainerLogs(nameOrId: string): LogStream {
  const proc = Bun.spawn(['docker', 'logs', '-f', nameOrId], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let stopped = false;

  const stop = () => {
    stopped = true;
    proc.kill();
  };

  async function* generateLines(): AsyncIterable<string> {
    log.debug({ nameOrId }, 'Starting log stream for container');

    // Queue to collect lines from both streams as they arrive
    const lineQueue: string[] = [];
    let resolveWaiting: (() => void) | null = null;
    let streamsComplete = 0;
    const totalStreams = (proc.stdout ? 1 : 0) + (proc.stderr ? 1 : 0);

    // Process a stream and push lines to the shared queue
    async function processStream(stream: ReadableStream<Uint8Array>) {
      const decoder = new TextDecoder();
      let buffer = '';
      const reader = stream.getReader();

      try {
        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = normalizeLineEndings(
            decoder.decode(value, { stream: true }),
          );
          buffer += chunk;

          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            lineQueue.push(line);
            // Wake up the generator if it's waiting
            if (resolveWaiting) {
              resolveWaiting();
              resolveWaiting = null;
            }
          }
        }

        // Yield any remaining content
        if (buffer) {
          lineQueue.push(buffer);
          if (resolveWaiting) {
            resolveWaiting();
            resolveWaiting = null;
          }
        }
      } finally {
        reader.releaseLock();
        streamsComplete++;
        // Wake up generator when stream ends
        if (resolveWaiting) {
          resolveWaiting();
          resolveWaiting = null;
        }
      }
    }

    // Start processing both streams concurrently (don't await)
    if (proc.stdout) processStream(proc.stdout);
    if (proc.stderr) processStream(proc.stderr);

    // Yield lines as they arrive from either stream
    while (!stopped) {
      const nextLine = lineQueue.shift();
      if (nextLine !== undefined) {
        log.trace({ line: nextLine, stopped }, 'Log stream line received');
        yield nextLine;
      } else if (streamsComplete >= totalStreams) {
        // Both streams are done and queue is empty
        break;
      } else {
        // Wait for more data
        await new Promise<void>((resolve) => {
          resolveWaiting = resolve;
        });
      }
    }
  }

  return {
    lines: generateLines(),
    stop,
  };
}

/**
 * Attach to a running container's main process using docker attach.
 * Sends a WINCH signal first to trigger the TUI to redraw at the correct size.
 * After detaching, resets the terminal to a clean state since the container's
 * process may have altered terminal modes (alternate screen, raw mode, etc.).
 */
export async function attachToContainer(nameOrId: string): Promise<void> {
  // Enter alternate screen so all container output is isolated from the
  // user's main screen buffer / scrollback history.
  enterSubprocessScreen();

  const proc = Bun.spawn(
    ['docker', 'attach', '--detach-keys=ctrl-\\', nameOrId],
    {
      stdio: ['inherit', 'inherit', 'inherit'],
    },
  );
  await signalContainerTTYResize(nameOrId, -1);
  setTimeout(async () => {
    await signalContainerTTYResize(nameOrId);
  }, 100);

  await proc.exited;

  // Exit alternate screen and clean up terminal state after detaching.
  resetTerminal();
}

export async function signalContainerTTYResize(
  nameOrId: string,
  offset = 0,
): Promise<void> {
  // Force a fresh ioctl query — cached values may be stale if the terminal
  // was resized while attached to a Docker subprocess.
  process.stdout._refreshSize();
  const cols = (process.stdout.columns ?? 80) + offset;
  const rows = (process.stdout.rows ?? 24) + offset;
  log.debug({ nameOrId, cols, rows }, 'Sending WINCH signal to container');
  try {
    await Bun.$`docker exec -t ${nameOrId} bash -c ${`stty -F /dev/console cols ${cols} rows ${rows}; kill -WINCH 1`}`.quiet();
  } catch {
    // Best-effort: if the exec fails (e.g. no /dev/console), continue anyway
  }
}

/**
 * Open an interactive bash shell in a running container.
 * After the shell exits, resets the terminal to a clean state.
 */
export async function shellInContainer(nameOrId: string): Promise<void> {
  // Enter alternate screen so all shell output is isolated from the
  // user's main screen buffer / scrollback history.
  enterSubprocessScreen();

  const proc = Bun.spawn(['docker', 'exec', '-it', nameOrId, '/bin/bash'], {
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  await proc.exited;

  // Exit alternate screen and clean up terminal state after the shell exits.
  resetTerminal();
}

// ============================================================================
// Container Resume
// ============================================================================

export interface ResumeSessionOptions {
  mode: 'interactive' | 'detached' | 'shell';
  prompt?: string;
  model?: string; // Allow overriding model on resume
  /** If set, mount this local directory into the container */
  mountDir?: string;
  /** Extra arguments to append to the agent command (e.g., ['--agent', 'plan']) */
  agentArgs?: string[];
}

function buildResumeAgentCommand(
  agent: AgentType,
  mode: ResumeSessionOptions['mode'],
  model?: string,
  agentArgs?: string[],
): string {
  const modelArg = model ? ` --model ${model}` : '';
  const extraArgs = agentArgs?.length ? ` ${agentArgs.join(' ')}` : '';

  if (agent === 'claude') {
    const promptArg = mode === 'detached' ? ' -p' : '';
    const hasPlanArgs = agentArgs?.includes('--permission-mode') ?? false;
    const skipPermsFlag = hasPlanArgs
      ? '--allow-dangerously-skip-permissions'
      : '--dangerously-skip-permissions';
    return `claude -c${promptArg}${extraArgs}${modelArg} ${skipPermsFlag}`;
  }

  if (mode === 'detached') {
    return `opencode${modelArg}${extraArgs} run -c`;
  }

  return `opencode${modelArg}${extraArgs} -c`;
}

export async function resumeSession(
  nameOrId: string,
  options: ResumeSessionOptions,
): Promise<string> {
  const { mode, prompt } = options;

  if (mode === 'detached' && (!prompt || prompt.trim().length === 0)) {
    throw new Error('Prompt is required for detached resume');
  }

  let container: DockerInspectResult | undefined;
  try {
    const result = await $`docker inspect ${nameOrId}`.quiet();
    const containers: DockerInspectResult[] = JSON.parse(
      result.stdout.toString(),
    );
    container = containers[0];
  } catch (error) {
    log.error({ error }, `Failed to inspect container ${nameOrId}`);
    throw new Error(`Container ${nameOrId} not found`);
  }

  if (!container) {
    log.error(`Container ${nameOrId} not found`);
    throw new Error(`Container ${nameOrId} not found`);
  }

  const containerLabels = container.Config.Labels ?? {};
  if (containerLabels['hermes.managed'] !== 'true') {
    log.error(`Container ${nameOrId} is not managed by hermes`);
    throw new Error('Container is not managed by hermes');
  }

  if (container.State?.Running) {
    log.error(`Container ${nameOrId} is already running`);
    throw new Error('Container is already running');
  }

  const agent = (containerLabels['hermes.agent'] as AgentType) || 'opencode';
  const model = options.model ?? containerLabels['hermes.model'];
  const resumeSuffix = nanoid(6).toLowerCase();
  const resumeImage = `hermes-resume:${container.Id.slice(0, 12)}-${resumeSuffix}`;

  try {
    await $`docker commit ${container.Id} ${resumeImage}`.quiet();
  } catch (err) {
    log.error({ err }, 'Error creating resume image');
    throw formatShellError(err as ShellError);
  }

  const envArgs: string[] = [];
  for (const envVar of container.Config.Env ?? []) {
    envArgs.push('-e', envVar);
  }

  // Read config for overlay mounts and init script
  const config = await readConfig();

  const baseName = container.Name.replace(/\//g, '').trim();
  const containerName = `${baseName}-resumed-${resumeSuffix}`;

  // Build volume mounts (mountDir, overlay mounts, etc.)
  const volumes: string[] = [];
  const files = await getCredentialFiles();

  // Resolve mount directory to absolute path if provided
  const absoluteMountDir = options.mountDir
    ? resolve(options.mountDir)
    : undefined;
  if (absoluteMountDir) {
    volumes.push(`${absoluteMountDir}:/work/app`);

    // Add overlay bind mounts for paths that need container isolation
    const overlayVolumes = await createOverlayDirs(
      containerName,
      config.overlayMounts,
    );
    volumes.push(...overlayVolumes);
  }

  const volumeArgs = toVolumeArgs(volumes);

  const resumePrompt =
    mode === 'detached'
      ? prompt?.trim() || ''
      : containerLabels['hermes.prompt'] || '';
  const baseSessionName =
    containerLabels['hermes.name'] ||
    containerLabels['hermes.branch'] ||
    'session';
  const resumeName = `${baseSessionName}-resumed-${resumeSuffix}`;

  // For shell mode, just run bash; otherwise run the agent
  const resumeScript =
    mode === 'shell'
      ? `
set -e
cd /work/app
${config.initScript || ''}
exec bash
`.trim()
      : `
set -e
cd /work/app
${config.initScript || ''}
${escapePrompt(buildResumeAgentCommand(agent, mode, model, options.agentArgs), prompt)}
`.trim();

  const hermesLabels = buildHermesLabels({
    name: resumeName,
    branch: containerLabels['hermes.branch'] ?? 'unknown',
    agent,
    repo: containerLabels['hermes.repo'] ?? 'unknown',
    prompt: resumePrompt,
    interactive: mode === 'interactive' || mode === 'shell',
    model,
    mount: absoluteMountDir,
    resumedFrom: container.Name.replace(/^\//, ''),
    resumeImage,
  });

  try {
    const result = await runInDocker({
      containerName,
      dockerArgs: [...envArgs, ...volumeArgs],
      cmdName: 'bash',
      cmdArgs: ['-c', resumeScript],
      dockerImage: resumeImage,
      interactive: mode !== 'detached',
      detached: mode === 'detached',
      files,
      labels: hermesLabels,
    });
    await result.exited;
    return containerName;
  } catch (error) {
    log.error({ error }, 'Error resuming container');
    throw formatShellError(error as ShellError);
  }
}

/**
 * Get a single session by container ID or name
 */
export async function getSession(
  nameOrId: string,
): Promise<HermesSession | null> {
  try {
    const result = await $`docker inspect ${nameOrId}`.quiet();
    const containers: DockerInspectResult[] = JSON.parse(
      result.stdout.toString(),
    );

    const container = containers[0];
    if (!container) {
      return null;
    }

    const labels = container.Config.Labels;

    // Check if this is a hermes-managed container
    if (labels['hermes.managed'] !== 'true') {
      return null;
    }

    const state = container.State;

    let status: HermesSession['status'];
    if (state.Running) {
      status = 'running';
    } else if (state.Paused) {
      status = 'paused';
    } else if (state.Restarting) {
      status = 'restarting';
    } else if (state.Dead) {
      status = 'dead';
    } else if (state.Status === 'created') {
      status = 'created';
    } else {
      status = 'exited';
    }

    return {
      containerId: container.Id.slice(0, 12),
      containerName: container.Name.replace(/^\//, ''),
      name: labels['hermes.name'] || labels['hermes.branch'] || 'unknown',
      branch: labels['hermes.branch'] || 'unknown',
      agent: (labels['hermes.agent'] as AgentType) || 'opencode',
      execType: (labels['hermes.exec-type'] as ExecType) || undefined,
      model: labels['hermes.model'],
      repo: labels['hermes.repo'] || 'unknown',
      prompt: labels['hermes.prompt'] || '',
      created: labels['hermes.created'] || '',
      resumedFrom: labels['hermes.resumed-from'],
      interactive: labels['hermes.interactive'] === 'true',
      mountDir: labels['hermes.mount'],
      status,
      exitCode: status === 'exited' ? state.ExitCode : undefined,
      startedAt: state.StartedAt,
      finishedAt: status === 'exited' ? state.FinishedAt : undefined,
    };
  } catch {
    return null;
  }
}

export const printArgs = (args: readonly string[]): string => {
  return args.map((arg) => $.escape(arg)).join(' ');
};

// ============================================================================
// Container Creation
// ============================================================================

export async function startContainer(
  options: StartContainerOptions,
): Promise<string | null> {
  const {
    branchName,
    prompt,
    repoInfo,
    agent,
    model,
    detach,
    interactive,
    envVars,
    mountDir,
    isGitRepo = true,
    agentArgs,
  } = options;

  const hermesEnvPath = '.hermes/.env';
  const hermesEnvFile = Bun.file(hermesEnvPath);

  // Create empty .hermes/.env if it doesn't exist
  if (!(await hermesEnvFile.exists())) {
    await Bun.write(hermesEnvPath, '');
  }

  const containerName = `hermes-${branchName}`;

  // Build env var arguments for docker run
  // Order matters for precedence: later values override earlier ones
  // Precedence (lowest to highest): hostEnvArgs -> --env-file -> envArgs

  // Pass through API keys from host environment (lowest precedence)
  const hostEnvArgs: string[] = [];
  const apiKeysToPassthrough = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
  for (const key of apiKeysToPassthrough) {
    const value = process.env[key];
    if (value) {
      hostEnvArgs.push('-e', `${key}=${value}`);
    }
  }

  // Explicit env vars passed to startContainer (highest precedence)
  const envArgs: string[] = [];
  for (const [key, value] of Object.entries(envVars ?? {})) {
    envArgs.push('-e', `${key}=${value}`);
  }

  // Read config for overlay mounts and init script
  const config = await readConfig();

  // Build volume mounts (mountDir, overlay mounts, etc.)
  const volumes: string[] = [];
  const files = await getCredentialFiles();

  // Resolve mount directory to absolute path if provided
  const absoluteMountDir = mountDir ? resolve(mountDir) : undefined;
  if (absoluteMountDir) {
    // Mount local directory to /work/app in the container
    volumes.push(`${absoluteMountDir}:/work/app`);

    // Add overlay bind mounts for paths that need container isolation
    // These must come after the bind mount so they overlay on top
    const overlayVolumes = await createOverlayDirs(
      containerName,
      config.overlayMounts,
    );
    volumes.push(...overlayVolumes);
  }

  const volumeArgs = toVolumeArgs(volumes);

  // Build the agent command based on the selected agent type, model, and mode
  const hasPrompt = prompt.trim().length > 0;
  const modelArg = model ? ` --model ${model}` : '';
  const extraArgs = agentArgs?.length ? ` ${agentArgs.join(' ')}` : '';
  let agentCommand: string;
  if (agent === 'claude') {
    const hasPlanArgs = agentArgs?.includes('--permission-mode') ?? false;
    const skipPermsFlag = hasPlanArgs
      ? '--allow-dangerously-skip-permissions'
      : '--dangerously-skip-permissions';
    const asyncFlag = !interactive ? ' -p' : '';
    agentCommand = `claude${asyncFlag}${extraArgs}${modelArg} ${skipPermsFlag}`;
  } else {
    if (!interactive) {
      // Async (detached) mode — always uses 'run' subcommand
      agentCommand = `opencode${modelArg}${extraArgs} run`;
    } else if (hasPrompt) {
      // Interactive with prompt — use --prompt flag
      agentCommand = `opencode${modelArg}${extraArgs} --prompt`;
    } else {
      // Interactive without prompt — just open opencode
      agentCommand = `opencode${modelArg}${extraArgs}`;
    }
  }

  // Only add PR instructions in async mode (detached) with a git repo
  const fullPrompt =
    detach && isGitRepo
      ? `${prompt}

---
Unless otherwise instructed above, use the \`gh\` command to create a PR when done.`
      : hasPrompt
        ? prompt
        : null;

  // Different startup script based on mount mode and git repo status
  let startupScript: string;
  if (absoluteMountDir) {
    if (isGitRepo) {
      // Mount mode in a git repo - may create branch
      startupScript = `
set -e
cd /work/app
gh auth setup-git
# Only create branch if on main/master
current_branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$current_branch" = "main" ] || [ "$current_branch" = "master" ]; then
  git switch -c "hermes/${branchName}"
fi
${config.initScript || ''}
${escapePrompt(agentCommand, fullPrompt)}
`.trim();
    } else {
      // Mount mode outside a git repo - skip all git/gh operations
      startupScript = `
set -e
cd /work/app
${config.initScript || ''}
${escapePrompt(agentCommand, fullPrompt)}
`.trim();
    }
  } else {
    // Clone mode - requires git repo
    if (!repoInfo) {
      throw new Error('Cannot use clone mode without a git repository');
    }
    startupScript = `
set -e
cd /work
gh auth setup-git
gh repo clone ${repoInfo.fullName} app
cd app
git switch -c "hermes/${branchName}"
${config.initScript || ''}
${escapePrompt(agentCommand, fullPrompt)}
`.trim();
  }

  const hermesLabels = buildHermesLabels({
    name: branchName,
    branch: branchName,
    agent,
    repo: repoInfo?.fullName,
    prompt,
    interactive,
    model,
    mount: absoluteMountDir,
    noGit: !isGitRepo || undefined,
  });

  try {
    const result = await runInDocker({
      containerName,
      dockerArgs: [
        ...hostEnvArgs,
        '--env-file',
        hermesEnvPath,
        ...envArgs,
        ...volumeArgs,
      ],
      cmdName: 'bash',
      cmdArgs: ['-c', startupScript],
      interactive: !detach,
      detached: detach,
      files,
      labels: hermesLabels,
    });
    await result.exited;
    return detach ? result.text().trim() : null;
  } catch (error) {
    log.error({ error }, 'Error starting container');
    throw formatShellError(error as ShellError);
  }
}

export interface StartShellContainerOptions {
  repoInfo: RepoInfo | null;
  /** If set, mount this local directory instead of git clone */
  mountDir?: string;
  /** Whether running from a git repository (affects git/gh operations) */
  isGitRepo?: boolean;
}

/**
 * Start a fresh shell container (no agent, just bash).
 * Uses a random name and clones the repo to the default branch.
 */
export async function startShellContainer(
  options: StartShellContainerOptions,
): Promise<void> {
  const { repoInfo, mountDir, isGitRepo = true } = options;

  const hermesEnvPath = '.hermes/.env';
  const hermesEnvFile = Bun.file(hermesEnvPath);

  // Create empty .hermes/.env if it doesn't exist
  if (!(await hermesEnvFile.exists())) {
    await Bun.write(hermesEnvPath, '');
  }

  const shellSuffix = nanoid(6).toLowerCase();
  const containerName = `hermes-shell-${shellSuffix}`;

  // Pass through API keys from host environment
  const hostEnvArgs: string[] = [];
  const apiKeysToPassthrough = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
  for (const key of apiKeysToPassthrough) {
    const value = process.env[key];
    if (value) {
      hostEnvArgs.push('-e', `${key}=${value}`);
    }
  }
  // Read config for overlay mounts and init script
  const config = await readConfig();

  // Build volume mounts (mountDir, overlay mounts, etc.)
  const volumes: string[] = [];
  const files = await getCredentialFiles();

  // Resolve mount directory to absolute path if provided
  const absoluteMountDir = mountDir ? resolve(mountDir) : undefined;
  if (absoluteMountDir) {
    volumes.push(`${absoluteMountDir}:/work/app`);

    // Add overlay bind mounts for paths that need container isolation
    const overlayVolumes = await createOverlayDirs(
      containerName,
      config.overlayMounts,
    );
    volumes.push(...overlayVolumes);
  }

  const volumeArgs = toVolumeArgs(volumes);

  // Shell startup script: different based on mount mode and git repo status
  let startupScript: string;
  if (absoluteMountDir) {
    if (isGitRepo) {
      // Mount mode in a git repo
      startupScript = `
set -e
cd /work/app
gh auth setup-git
${config.initScript || ''}
exec bash
`.trim();
    } else {
      // Mount mode outside a git repo - skip git/gh operations
      startupScript = `
set -e
cd /work/app
${config.initScript || ''}
exec bash
`.trim();
    }
  } else {
    // Clone mode - requires git repo
    if (!repoInfo) {
      throw new Error('Cannot use clone mode without a git repository');
    }
    startupScript = `
set -e
cd /work
gh auth setup-git
gh repo clone ${repoInfo.fullName} app
cd app
${config.initScript || ''}
exec bash
`.trim();
  }

  const hermesLabels = buildHermesLabels({
    name: `shell-${shellSuffix}`,
    branch: `shell-${shellSuffix}`,
    agent: 'opencode',
    execType: 'shell',
    repo: repoInfo?.fullName,
    prompt: 'Interactive shell session',
    interactive: true,
    mount: absoluteMountDir,
    noGit: !isGitRepo || undefined,
  });

  await runInDocker({
    containerName,
    interactive: true,
    dockerArgs: [...hostEnvArgs, '--env-file', hermesEnvPath, ...volumeArgs],
    cmdName: 'bash',
    cmdArgs: ['-c', startupScript],
    files,
    labels: hermesLabels,
  });
}
