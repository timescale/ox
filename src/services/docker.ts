// ============================================================================
// Docker Container Service
// ============================================================================

import { resolve } from 'node:path';
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
import { formatShellError, type ShellError } from '../utils';
import { ghConfigVolume } from './auth';
import { CLAUDE_CONFIG_VOLUME } from './claude';
import { type AgentType, readConfig } from './config';
import type { RepoInfo } from './git';
import { log } from './logger';
import { OPENCODE_CONFIG_VOLUME } from './opencode';
import { runInDocker } from './runInDocker';

/**
 * Escape a string for safe use in shell commands using base64 encoding.
 * This approach avoids any shell interpretation of special characters
 * by encoding the entire string and decoding it at runtime.
 */
function base64Encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

const toVolumeArgs = (volumes: string[]): string[] =>
  volumes.flatMap((v) => ['-v', v]);

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
 */
export async function resolveSandboxImage(): Promise<SandboxImageConfig> {
  const config = await readConfig();

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
  // Check what's actually available locally, with fallback order:
  // 1. Version-tagged image (preferred)
  // 2. Latest image (fallback)
  // 3. Return version-tagged if neither exists (will need to be pulled)
  const ghcrTags = getGhcrImageTags('slim');

  if (await imageExists(ghcrTags.version)) {
    return {
      image: ghcrTags.version,
      needsBuild: false,
      cacheVariant: 'slim',
    };
  }

  if (await imageExists(ghcrTags.latest)) {
    return {
      image: ghcrTags.latest,
      needsBuild: false,
      cacheVariant: 'slim',
    };
  }

  // Neither exists locally - return version-tagged (caller will need to pull)
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
    log.debug({ output, imageName, exists }, 'imageExists');
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

  // Check if versioned image exists locally
  if (await imageExists(ghcrTags.version)) {
    onProgress?.({ type: 'exists' });
    return ghcrTags.version;
  }

  // Pull versioned image
  onProgress?.({
    type: 'pulling',
    message: 'Pulling versioned sandbox image',
  });
  if (await tryPullImage(ghcrTags.version)) {
    onProgress?.({ type: 'done' });
    return ghcrTags.version;
  }

  // Check if latest image exists locally
  if (await imageExists(ghcrTags.latest)) {
    onProgress?.({ type: 'exists' });
    return ghcrTags.latest;
  }

  // Fall back to latest
  onProgress?.({
    type: 'pulling',
    message: 'Pulling latest sandbox image',
  });
  if (await tryPullImage(ghcrTags.latest)) {
    onProgress?.({ type: 'done' });
    return ghcrTags.latest;
  }

  // Final fallback, built the slim image locally
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
  repoInfo: RepoInfo;
  agent: AgentType;
  model?: string;
  detach: boolean;
  interactive: boolean;
  envVars?: Record<string, string>;
  /** If set, mount this local directory into the container instead of git clone */
  mountDir?: string;
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
  try {
    const result = await $`docker inspect ${nameOrId}`.quiet();
    const containers: DockerInspectResult[] = JSON.parse(
      result.stdout.toString(),
    );
    const container = containers[0];
    if (container) {
      resumeImage = container.Config.Labels?.['hermes.resume-image'] ?? null;
    }
  } catch {
    resumeImage = null;
  }

  await $`docker rm -f ${nameOrId}`.quiet();

  if (resumeImage) {
    try {
      await $`docker rmi ${resumeImage}`.quiet();
    } catch {
      // Ignore image removal errors
    }
  }
}

/**
 * Stop a running container gracefully
 */
export async function stopContainer(nameOrId: string): Promise<void> {
  await $`docker stop ${nameOrId}`.quiet();
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
 * Attach to a running container interactively.
 * This replaces the current process with docker attach.
 */
export async function attachToContainer(nameOrId: string): Promise<void> {
  const proc = Bun.spawn(['docker', 'exec', '-it', nameOrId, '/bin/bash'], {
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  await proc.exited;
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
}

function buildResumeAgentCommand(
  agent: AgentType,
  mode: ResumeSessionOptions['mode'],
  model?: string,
): string {
  const modelArg = model ? ` --model ${model}` : '';

  if (agent === 'claude') {
    const promptArg = mode === 'detached' ? ' -p' : '';
    return `claude -c${promptArg}${modelArg} --dangerously-skip-permissions`;
  }

  if (mode === 'detached') {
    return `opencode${modelArg} run -c`;
  }

  return `opencode${modelArg} -c`;
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

  const labels = container.Config.Labels ?? {};
  if (labels['hermes.managed'] !== 'true') {
    log.error(`Container ${nameOrId} is not managed by hermes`);
    throw new Error('Container is not managed by hermes');
  }

  if (container.State?.Running) {
    log.error(`Container ${nameOrId} is already running`);
    throw new Error('Container is already running');
  }

  const agent = (labels['hermes.agent'] as AgentType) || 'opencode';
  const model = options.model ?? labels['hermes.model'];
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

  // Mount config volumes for agent credentials and session continuity
  // If mountDir is provided, add it as a volume mount
  const volumes = [
    CLAUDE_CONFIG_VOLUME,
    OPENCODE_CONFIG_VOLUME,
    ghConfigVolume(),
  ];

  // Resolve mount directory to absolute path if provided
  const absoluteMountDir = options.mountDir
    ? resolve(options.mountDir)
    : undefined;
  if (absoluteMountDir) {
    volumes.push(`${absoluteMountDir}:/work/app`);
  }

  const volumeArgs = toVolumeArgs(volumes);

  const baseName = container.Name.replace(/\//g, '').trim();
  const containerName = `${baseName}-resumed-${resumeSuffix}`;

  const resumePrompt =
    mode === 'detached' ? prompt?.trim() || '' : labels['hermes.prompt'] || '';
  const baseSessionName =
    labels['hermes.name'] || labels['hermes.branch'] || 'session';
  const resumeName = `${baseSessionName}-resumed-${resumeSuffix}`;

  // For shell mode, just run bash; otherwise run the agent
  const resumeScript =
    mode === 'shell'
      ? 'cd /work/app && exec bash'
      : `
set -e
cd /work/app
${escapePrompt(buildResumeAgentCommand(agent, mode, model), prompt)}
`.trim();

  const labelArgs: string[] = [
    '--label',
    'hermes.managed=true',
    '--label',
    `hermes.name=${resumeName}`,
    '--label',
    `hermes.branch=${labels['hermes.branch'] ?? 'unknown'}`,
    '--label',
    `hermes.agent=${agent}`,
    '--label',
    `hermes.repo=${labels['hermes.repo'] ?? 'unknown'}`,
    '--label',
    `hermes.created=${new Date().toISOString()}`,
    '--label',
    `hermes.prompt=${resumePrompt}`,
    '--label',
    `hermes.resumed-from=${container.Name.replace(/^\//, '')}`,
    '--label',
    `hermes.resume-image=${resumeImage}`,
    '--label',
    `hermes.interactive=${mode === 'interactive' || mode === 'shell'}`,
  ];
  if (model) {
    labelArgs.push('--label', `hermes.model=${model}`);
  }
  // Track mount mode in labels
  if (absoluteMountDir) {
    labelArgs.push('--label', `hermes.mount=${absoluteMountDir}`);
  }

  try {
    if (mode === 'detached') {
      const result = await $`docker run -d \
        --name ${containerName} \
        ${labelArgs} \
        ${envArgs} \
        ${volumeArgs} \
        ${resumeImage} \
        bash -c ${resumeScript}`.quiet();
      return result.stdout.toString().trim();
    }

    const proc = Bun.spawn(
      [
        'docker',
        'run',
        '-it',
        '--name',
        containerName,
        ...labelArgs,
        ...envArgs,
        ...volumeArgs,
        resumeImage,
        'bash',
        '-c',
        resumeScript,
      ],
      {
        stdio: ['inherit', 'inherit', 'inherit'],
      },
    );
    await proc.exited;
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
  } = options;

  // Get the resolved sandbox image
  const imageConfig = await resolveSandboxImage();
  const dockerImage = imageConfig.image;

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

  // Build volume arguments - config volumes plus optional mount
  const volumes = [
    CLAUDE_CONFIG_VOLUME,
    OPENCODE_CONFIG_VOLUME,
    ghConfigVolume(),
  ];

  // Resolve mount directory to absolute path if provided
  const absoluteMountDir = mountDir ? resolve(mountDir) : undefined;
  if (absoluteMountDir) {
    // Mount local directory to /work/app in the container
    volumes.push(`${absoluteMountDir}:/work/app`);
  }

  const volumeArgs = toVolumeArgs(volumes);

  // Build the agent command based on the selected agent type, model, and mode
  const modelArg = model ? ` --model ${model}` : '';
  const agentCommand =
    agent === 'claude'
      ? `claude${interactive ? '' : ' -p'}${modelArg} --dangerously-skip-permissions`
      : `opencode${modelArg} ${interactive ? '--prompt' : 'run'}`;

  const fullPrompt = interactive
    ? prompt
    : `${prompt}

---
Unless otherwise instructed above, use the \`gh\` command to create a PR when done.`;

  // Different startup script for mount mode vs clone mode
  const startupScript = absoluteMountDir
    ? `
set -e
cd /work/app
gh auth setup-git
# Only create branch if on main/master
current_branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$current_branch" = "main" ] || [ "$current_branch" = "master" ]; then
  git switch -c "hermes/${branchName}"
fi
${escapePrompt(agentCommand, fullPrompt)}
`.trim()
    : `
set -e
cd /work
gh auth setup-git
gh repo clone ${repoInfo.fullName} app
cd app
git switch -c "hermes/${branchName}"
${escapePrompt(agentCommand, fullPrompt)}
`.trim();

  // Build label arguments for hermes metadata
  const labelArgs: string[] = [
    '--label',
    'hermes.managed=true',
    '--label',
    `hermes.name=${branchName}`,
    '--label',
    `hermes.branch=${branchName}`,
    '--label',
    `hermes.agent=${agent}`,
    '--label',
    `hermes.repo=${repoInfo.fullName}`,
    '--label',
    `hermes.created=${new Date().toISOString()}`,
    '--label',
    `hermes.interactive=${interactive}`,
  ];
  if (model) {
    labelArgs.push('--label', `hermes.model=${model}`);
  }
  // Track mount mode in labels
  if (absoluteMountDir) {
    labelArgs.push('--label', `hermes.mount=${absoluteMountDir}`);
  }
  // Store the full prompt in label (truncation is done only at display time)
  labelArgs.push('--label', `hermes.prompt=${prompt}`);

  try {
    if (detach) {
      log.debug(
        {
          cmd: `docker run -d \
        --name ${containerName} \
        ${printArgs(labelArgs)} \
        ${printArgs(hostEnvArgs)} \
        --env-file ${hermesEnvPath} \
        ${printArgs(envArgs)} \
        ${printArgs(volumeArgs)} \
        ${dockerImage} \
        bash -c ${$.escape(startupScript)}`,
        },
        'Starting docker container in detached mode',
      );
      const result = await $`docker run -d \
        --name ${containerName} \
        ${labelArgs} \
        ${hostEnvArgs} \
        --env-file ${hermesEnvPath} \
        ${envArgs} \
        ${volumeArgs} \
        ${dockerImage} \
        bash -c ${startupScript}`.quiet();
      return result.stdout.toString().trim();
    }

    // Interactive/foreground mode - use Bun.spawn with inherited stdio for proper TTY
    const spawnArgs = [
      'docker',
      'run',
      '-it',
      '--name',
      containerName,
      ...labelArgs,
      ...hostEnvArgs,
      '--env-file',
      hermesEnvPath,
      ...envArgs,
      ...volumeArgs,
      dockerImage,
      'bash',
      '-c',
      startupScript,
    ];
    log.debug({ spawnArgs }, 'Starting docker container');
    const proc = Bun.spawn(spawnArgs, {
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    await proc.exited;
    return null;
  } catch (error) {
    log.error({ error }, 'Error starting container');
    throw formatShellError(error as ShellError);
  }
}

export interface StartShellContainerOptions {
  repoInfo: RepoInfo;
  /** If set, mount this local directory instead of git clone */
  mountDir?: string;
}

/**
 * Start a fresh shell container (no agent, just bash).
 * Uses a random name and clones the repo to the default branch.
 */
export async function startShellContainer(
  options: StartShellContainerOptions,
): Promise<void> {
  const { repoInfo, mountDir } = options;

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

  // Build volume arguments - config volumes plus optional mount
  const volumes = [
    CLAUDE_CONFIG_VOLUME,
    OPENCODE_CONFIG_VOLUME,
    ghConfigVolume(),
  ];

  // Resolve mount directory to absolute path if provided
  const absoluteMountDir = mountDir ? resolve(mountDir) : undefined;
  if (absoluteMountDir) {
    volumes.push(`${absoluteMountDir}:/work/app`);
  }

  const volumeArgs = toVolumeArgs(volumes);

  // Shell startup script: different for mount vs clone mode
  const startupScript = absoluteMountDir
    ? `
set -e
cd /work/app
gh auth setup-git
exec bash
`.trim()
    : `
set -e
cd /work
gh auth setup-git
gh repo clone ${repoInfo.fullName} app
cd app
exec bash
`.trim();

  // Build label arguments for hermes metadata
  const labelArgs: string[] = [
    '--label',
    'hermes.managed=true',
    '--label',
    `hermes.name=shell-${shellSuffix}`,
    '--label',
    `hermes.branch=shell-${shellSuffix}`,
    '--label',
    'hermes.agent=shell',
    '--label',
    `hermes.repo=${repoInfo.fullName}`,
    '--label',
    `hermes.created=${new Date().toISOString()}`,
    '--label',
    'hermes.interactive=true',
    '--label',
    'hermes.prompt=Interactive shell session',
  ];
  // Track mount mode in labels
  if (absoluteMountDir) {
    labelArgs.push('--label', `hermes.mount=${absoluteMountDir}`);
  }

  await runInDocker({
    interactive: true,
    dockerArgs: [
      '--name',
      containerName,
      ...labelArgs,
      ...hostEnvArgs,
      '--env-file',
      hermesEnvPath,
      ...volumeArgs,
    ],
    cmdName: 'bash',
    cmdArgs: ['-c', startupScript],
  });
}
