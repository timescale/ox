// ============================================================================
// Docker Container Service
// ============================================================================

import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { $ } from 'bun';
import { nanoid } from 'nanoid';
// Import agent install scripts as text - embedded in the binary
import INSTALL_CLAUDE from '../../sandbox/agents/install-claude.sh' with {
  type: 'text',
};
import INSTALL_CODEX from '../../sandbox/agents/install-codex.sh' with {
  type: 'text',
};
import INSTALL_OPENCODE from '../../sandbox/agents/install-opencode.sh' with {
  type: 'text',
};
import INSTALL_TIGER from '../../sandbox/agents/install-tiger.sh' with {
  type: 'text',
};
// Import Dockerfile as text - Bun's bundler embeds this in the binary
import BASE_DOCKERFILE from '../../sandbox/base.Dockerfile' with {
  type: 'text',
};
import toolVersions from '../../sandbox/versions.json' with { type: 'json' };
import { runDockerSetupScreen } from '../components/DockerSetup';
import {
  CLI_SUBPROCESS_OPTS,
  enterSubprocessScreen,
  formatShellError,
  resetTerminal,
  type ShellError,
  shellEscape,
} from '../utils/shell.ts';
import { buildAgentCommand, wrapWithPrompt } from './agentCommand';
import { BuildError } from './buildError.ts';
import { getClaudeConfigFiles, hasValidClaudeFileCredentials } from './claude';
import { getCodexConfigFiles, hasValidCodexFileCredentials } from './codex';
import {
  type AgentType,
  type OxConfig,
  projectConfigDir,
  readConfig,
} from './config';
import { CONTAINER_HOME, writeFileToContainer } from './dockerFiles';
import { getGhConfigFiles } from './gh';
import type { RepoInfo } from './git';
import { log } from './logger';
import {
  getOpencodeConfigFiles,
  hasValidOpencodeFileCredentials,
} from './opencode';
import { runInDocker, type VirtualFile } from './runInDocker';
import type { AgentMode, AttachOptions } from './sandbox/types';

export const toVolumeArgs = (volumes: string[]): string[] =>
  volumes.flatMap((v) => ['-v', v]);

export const getCredentialFiles = async (
  homeDir = CONTAINER_HOME,
): Promise<VirtualFile[]> => {
  const [claudeFiles, opencodeFiles, codexFiles, ghFiles] = await Promise.all([
    getClaudeConfigFiles(),
    getOpencodeConfigFiles(),
    getCodexConfigFiles(),
    getGhConfigFiles(),
  ]);
  const files = [...claudeFiles, ...opencodeFiles, ...codexFiles, ...ghFiles];
  // Rewrite paths if a different home directory was requested
  if (homeDir !== CONTAINER_HOME) {
    return files.map((f) => ({
      ...f,
      path: f.path.replace(CONTAINER_HOME, homeDir),
    }));
  }
  return files;
};

// ============================================================================
// Container Labels
// ============================================================================

export type ExecType = 'agent' | 'shell';

export interface OxContainerLabels {
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
  /** How the agent runs in the sandbox (async, interactive, plan) */
  agentMode?: AgentMode;
}

/**
 * Build Docker container labels for ox-managed containers.
 * Automatically sets `ox.managed=true` and `ox.created` timestamp.
 * Returns a Record suitable for passing to `runInDocker({ labels })`.
 */
export function buildOxLabels(
  input: OxContainerLabels,
): Record<string, string> {
  const result: Record<string, string> = {
    'ox.managed': 'true',
    'ox.name': input.name,
    'ox.branch': input.branch,
    'ox.agent': input.agent,
    'ox.exec-type': input.execType ?? 'agent',
    'ox.repo': input.repo ?? 'local',
    'ox.created': new Date().toISOString(),
  };
  if (input.prompt != null) result['ox.prompt'] = input.prompt;
  if (input.interactive != null)
    result['ox.interactive'] = String(input.interactive);
  if (input.model) result['ox.model'] = input.model;
  if (input.mount) result['ox.mount'] = input.mount;
  if (input.noGit) result['ox.no-git'] = 'true';
  if (input.resumedFrom) result['ox.resumed-from'] = input.resumedFrom;
  if (input.resumeImage) result['ox.resume-image'] = input.resumeImage;
  if (input.agentMode) result['ox.agent-mode'] = input.agentMode;
  return result;
}

/**
 * Create local directories for overlay mounts and return volume mount strings.
 * Overlay mounts are stored in .ox/overlayMounts/<containerName>/<path>
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

/**
 * Build the final command line for agent startup scripts.
 *
 * For interactive sessions, wraps the agent in a tmux session so that
 * `docker attach` connects to tmux (which provides uniform mouse support,
 * true-color, and detach behavior across all agents).  PID 1 becomes
 * `tmux attach`, keeping the container alive.
 *
 * Non-interactive (async/detached) sessions skip tmux and exec directly.
 *
 * Prompt injection is delegated to {@link wrapWithPrompt} which uses a
 * shell variable (`$OX_PROMPT`) so stdin stays connected to the terminal.
 */
const escapePrompt = (
  cmd: string,
  agent: AgentType,
  prompt?: string | null,
  interactive?: boolean,
): string => {
  const wrapped = wrapWithPrompt(cmd, agent, prompt);

  if (interactive) {
    // Wrap in tmux: start a detached session running the agent, then attach.
    // PID 1 becomes `tmux attach`, keeping the container alive while the
    // agent runs inside the tmux session.
    // -u forces UTF-8 mode so block/box-drawing characters render correctly
    // (matches the Deno cloud sandbox's tmux invocation).
    // The inner command is a single string passed to tmux (which runs it via
    // sh -c), so semicolons work fine as separators.
    return `tmux -u new-session -d -s main ${shellEscape(wrapped)}\nexec tmux -u attach -t main`;
  }

  // Non-interactive (async/detached): exec the agent directly.
  // When there's a prompt, wrapWithPrompt produces a single line:
  //   OX_PROMPT="$(...)"; cmd "$OX_PROMPT"
  // We need the variable assignment on its own line so `exec` applies to
  // the agent command, not to the assignment.  Replace the first "; "
  // (which separates the assignment from the command) with a newline+exec.
  if (prompt && prompt.trim().length > 0) {
    const sep = wrapped.indexOf('; ');
    return `${wrapped.slice(0, sep)}\nexec ${wrapped.slice(sep + 2)}`;
  }
  return `exec ${wrapped}`;
};

// ============================================================================
// Sandbox Image Configuration
// ============================================================================

const DOCKER_IMAGE_NAME = 'ox-sandbox';

// GHCR (GitHub Container Registry) base path
const GHCR_BASE = 'ghcr.io/timescale/ox';

// ============================================================================
// Image name for GHCR
// ============================================================================

const GHCR_IMAGE_NAME = `${GHCR_BASE}/sandbox`;

/**
 * Docker CE install script for the Docker sandbox provider.
 * Assumes the default ox base image (Ubuntu 24.04 / noble, user `ox`).
 * Custom `sandboxBaseImage` overrides may need their own Docker setup
 * via `projectSetupLayer` instead of `dockerInSandbox`.
 */
const DOCKER_SANDBOX_SETUP_SCRIPT = `set -exo pipefail
apt-get update
apt-get install -y ca-certificates curl fuse-overlayfs

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

cat >/etc/apt/sources.list.d/docker.sources <<'EOF'
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
rm -rf /var/lib/apt/lists/*
usermod -aG docker ox
mkdir -p /var/run
`;

const DOCKER_SANDBOX_ROOT_INIT_SCRIPT = `dockerd --host=unix:///var/run/docker.sock --storage-driver=fuse-overlayfs >/tmp/dockerd.log 2>&1 &
DOCKERD_PID=$!
for i in $(seq 1 30); do
  docker info >/dev/null 2>&1 && break
  kill -0 $DOCKERD_PID 2>/dev/null || { cat /tmp/dockerd.log; exit 1; }
  sleep 1
done`;

export function computeDockerfileHash(content: string): string {
  const hasher = new Bun.CryptoHasher('md5');
  hasher.update(content);
  // Base image hash only includes the Dockerfile content — agent versions
  // are encoded in the overlay image tag, not the base.
  return hasher.digest('hex').slice(0, 12);
}

/**
 * Compute a content hash for the project setup layer.
 * Combines the base image hash and the setup script content so the
 * layer rebuilds when either the base or the script changes.
 */
export function computeProjectSetupHash(
  baseHash: string,
  script: string,
): string {
  const hasher = new Bun.CryptoHasher('md5');
  hasher.update(baseHash);
  hasher.update(script);
  return hasher.digest('hex').slice(0, 12);
}

/**
 * Compute the project setup layer image tag.
 * Always uses the local `ox-sandbox` name — project setup layers are built
 * locally and never published to GHCR.
 * Format: ox-sandbox:md5-<baseHash>-l-<setupHash>
 */
export function getProjectSetupTag(baseImage: string, script: string): string {
  // Extract the base hash from the image tag, regardless of whether it's
  // a local (ox-sandbox:md5-{hash}) or GHCR (ghcr.io/.../sandbox:{hash}) tag.
  const tagPart = baseImage.split(':')[1] ?? baseImage;
  const baseHash = tagPart.replace(/^md5-/, '');
  const setupHash = computeProjectSetupHash(baseHash, script);
  return `${DOCKER_IMAGE_NAME}:md5-${baseHash}-l-${setupHash}`;
}

export function computeDockerSandboxSetupHash(baseHash: string): string {
  const hasher = new Bun.CryptoHasher('md5');
  hasher.update(baseHash);
  hasher.update(DOCKER_SANDBOX_SETUP_SCRIPT);
  return hasher.digest('hex').slice(0, 12);
}

export function getDockerSandboxSetupTag(baseImage: string): string {
  const tagPart = baseImage.split(':')[1] ?? baseImage;
  const baseHash = tagPart.replace(/^md5-/, '');
  const setupHash = computeDockerSandboxSetupHash(baseHash);
  return `${DOCKER_IMAGE_NAME}:md5-${baseHash}-dkr-${setupHash}`;
}

export function buildDockerSandboxRootInitScript(
  config: Pick<OxConfig, 'dockerInSandbox' | 'rootInitScript'>,
): string | undefined {
  if (!config.dockerInSandbox) {
    return config.rootInitScript;
  }
  return config.rootInitScript
    ? `${DOCKER_SANDBOX_ROOT_INIT_SCRIPT}\n${config.rootInitScript}`
    : DOCKER_SANDBOX_ROOT_INIT_SCRIPT;
}

export function resolveDockerSandboxPrivilege(
  config: Pick<OxConfig, 'dockerInSandbox' | 'privileged'>,
): { privileged: boolean; warning?: string } {
  if (!config.dockerInSandbox) {
    return { privileged: config.privileged ?? false };
  }
  if (config.privileged === false) {
    return {
      privileged: false,
      warning:
        'dockerInSandbox is enabled, but config also sets privileged: false. Docker may fail to start in Docker sandboxes.',
    };
  }
  return { privileged: true };
}

async function ensureRootScriptLayer(
  baseImage: string,
  setupTag: string,
  script: string,
  progressMessage: string,
  options?: {
    onProgress?: (progress: ImageBuildProgress) => void;
    force?: boolean;
    stream?: boolean;
  },
): Promise<string> {
  if (!options?.force && (await imageExists(setupTag))) {
    log.debug({ setupTag }, `${progressMessage} image already exists`);
    return setupTag;
  }

  log.info({ setupTag, baseImage }, `Building ${progressMessage} image`);
  options?.onProgress?.({
    type: 'building',
    message: progressMessage,
  });

  const containerName = `ox-setup-${nanoid(6).toLowerCase()}`;

  try {
    await $`docker run -d --name ${containerName} ${baseImage} sleep infinity`.quiet();
    await writeFileToContainer(containerName, '/tmp/project-setup.sh', script);

    const outputLines: string[] = [];
    const proc = Bun.spawn(
      [
        'docker',
        'exec',
        '--user',
        'root',
        containerName,
        'bash',
        '/tmp/project-setup.sh',
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );

    const processStream = async (
      readable: ReadableStream<Uint8Array> | null,
    ) => {
      if (!readable) return;
      const shouldStream = options?.stream;
      const shouldReport = !shouldStream && options?.onProgress;
      let partial = '';
      for await (const chunk of readable) {
        if (shouldStream) {
          process.stderr.write(chunk);
        }
        partial += new TextDecoder().decode(chunk);
        const lines = partial.split('\n');
        partial = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) {
            outputLines.push(trimmed);
            if (shouldReport) {
              options?.onProgress?.({
                type: 'building',
                message: progressMessage,
                detail: trimmed,
              });
            }
          }
        }
      }
      const trimmed = partial.trim();
      if (trimmed) {
        outputLines.push(trimmed);
        if (shouldReport) {
          options?.onProgress?.({
            type: 'building',
            message: progressMessage,
            detail: trimmed,
          });
        }
      }
    };

    await Promise.all([
      processStream(proc.stdout),
      processStream(proc.stderr),
      proc.exited,
    ]);

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw Object.assign(new Error(`Failed with exit code ${exitCode}`), {
        exitCode,
        stderr: '',
        stdout: '',
        outputLines,
      });
    }

    await $`docker exec --user root ${containerName} rm -f /tmp/project-setup.sh`.quiet();
    await $`docker commit ${containerName} ${setupTag}`.quiet();
    invalidateImageExistsCache(setupTag);

    log.info({ setupTag }, `${progressMessage} image built successfully`);
    return setupTag;
  } catch (err) {
    log.error({ err, setupTag }, `Failed to build ${progressMessage} image`);
    const detail =
      err != null && typeof err === 'object' && 'stderr' in err && err.stderr
        ? String(err.stderr).trim()
        : '';
    const lines: string[] =
      err != null &&
      typeof err === 'object' &&
      'outputLines' in err &&
      Array.isArray(err.outputLines)
        ? (err.outputLines as string[])
        : [];
    const base = `Failed to build ${progressMessage} (exit code ${(err as { exitCode?: number }).exitCode ?? '?'})`;
    throw new BuildError(detail ? `${base}\n${detail}` : base, lines);
  } finally {
    await $`docker rm -f ${containerName}`.quiet().nothrow();
  }
}

// ============================================================================
// Agent Install Scripts & Overlay Images
// ============================================================================

/** Map of agent type to embedded install script content */
const AGENT_INSTALL_SCRIPTS: Record<string, string> = {
  claude: INSTALL_CLAUDE,
  opencode: INSTALL_OPENCODE,
  codex: INSTALL_CODEX,
  tiger: INSTALL_TIGER,
};

/** Get the pinned version for an agent from sandbox/versions.json */
export function getAgentVersion(agent: AgentType): string {
  switch (agent) {
    case 'claude':
      return toolVersions.claudeCode;
    case 'opencode':
      return toolVersions.opencode;
    case 'codex':
      return toolVersions.codex;
  }
}

/** Get the embedded install script content for an agent */
export function getAgentInstallScript(agent: AgentType | 'tiger'): string {
  const script = AGENT_INSTALL_SCRIPTS[agent];
  if (!script) {
    throw new Error(`No install script for agent: ${agent}`);
  }
  return script;
}

/**
 * Compute the overlay image tag for a given base image and agent.
 * Format: <baseImage>-<agent>-<agentVersion>
 */
export function getAgentOverlayTag(
  baseImage: string,
  agent: AgentType,
): string {
  const version = getAgentVersion(agent);
  return `${baseImage}-${agent}-${version}`;
}

/**
 * Ensure a project-specific setup layer image exists on top of the base image.
 *
 * Resolution:
 * 1. Check if setup layer image exists locally → return if yes
 * 2. Build locally via docker run + exec + commit
 *
 * The setup layer tag encodes the base hash and script content hash
 * so that any change to either triggers a rebuild.
 *
 * @returns The setup layer image tag (to be used as base for agent overlay)
 */
export async function ensureProjectSetupLayer(
  baseImage: string,
  script: string,
  options?: {
    onProgress?: (progress: ImageBuildProgress) => void;
    force?: boolean;
    /** Stream the setup script's stdout/stderr to the terminal */
    stream?: boolean;
  },
): Promise<string> {
  const setupTag = getProjectSetupTag(baseImage, script);

  return ensureRootScriptLayer(
    baseImage,
    setupTag,
    script,
    'Running project setup layer',
    options,
  );
}

export async function ensureDockerSandboxSetupLayer(
  baseImage: string,
  options?: EnsureDockerImageOptions & { stream?: boolean },
): Promise<string> {
  const setupTag = getDockerSandboxSetupTag(baseImage);
  return ensureRootScriptLayer(
    baseImage,
    setupTag,
    DOCKER_SANDBOX_SETUP_SCRIPT,
    'Installing Docker in sandbox layer',
    options,
  );
}

/**
 * Ensure an agent-specific overlay image exists on top of the base image.
 *
 * Resolution order:
 * 1. Check if overlay exists locally
 * 2. Try to pull from GHCR (pre-built agent image)
 * 3. Build locally via docker run + exec + commit
 *
 * The overlay image tag encodes the base hash, agent name, and version
 * so that any change to the base or agent version triggers a rebuild.
 */
export async function ensureAgentOverlay(
  baseImage: string,
  agent: AgentType,
  options?: {
    onProgress?: (progress: ImageBuildProgress) => void;
    force?: boolean;
  },
): Promise<string> {
  const overlayTag = getAgentOverlayTag(baseImage, agent);

  // Check if overlay already exists locally
  if (!options?.force && (await imageExists(overlayTag))) {
    log.debug(`${agent} overlay image already exists`);
    return overlayTag;
  }

  // Try to pull pre-built agent image from GHCR.
  // Skip when the base image is a project setup layer (contains '-l-')
  // since GHCR won't have project-specific agent overlays.
  const ghcrAgentTag = getGhcrAgentTag(agent);
  const isProjectSetupBase = baseImage.includes('-l-');
  if (!isProjectSetupBase) {
    log.debug({ ghcrAgentTag, agent }, 'Trying to pull agent image from GHCR');
    options?.onProgress?.({
      type: 'pulling',
      message: `Pulling ${agent} agent image`,
    });
    if (await tryPullImage(ghcrAgentTag)) {
      // Tag the GHCR image with the local overlay tag for consistency
      if (ghcrAgentTag !== overlayTag) {
        await $`docker tag ${ghcrAgentTag} ${overlayTag}`.quiet().nothrow();
        invalidateImageExistsCache(overlayTag);
      }
      log.info({ overlayTag, agent }, 'Agent overlay image pulled from GHCR');
      return overlayTag;
    }
  } else {
    log.debug(
      { overlayTag, ghcrAgentTag, agent },
      'Skipping GHCR pull — base image includes project setup layer',
    );
  }

  // Fall back to building locally
  log.info(
    { overlayTag, baseImage, agent },
    'Building agent overlay image locally',
  );
  options?.onProgress?.({
    type: 'building',
    message: `Installing ${agent} agent`,
  });

  const version = getAgentVersion(agent);
  const containerName = `ox-overlay-${agent}-${nanoid(6).toLowerCase()}`;

  try {
    // 1. Start a temporary container from the base image
    await $`docker run -d --name ${containerName} ${baseImage} sleep infinity`.quiet();

    // 2. Write install scripts into the container
    const agentScript = getAgentInstallScript(agent);
    const tigerScript = getAgentInstallScript('tiger');
    await writeFileToContainer(
      containerName,
      '/tmp/install-agent.sh',
      agentScript,
    );
    await writeFileToContainer(
      containerName,
      '/tmp/install-tiger.sh',
      tigerScript,
    );

    // 3. Execute install scripts as the ox user
    await $`docker exec ${containerName} bash /tmp/install-agent.sh ${version}`.quiet();
    await $`docker exec ${containerName} bash /tmp/install-tiger.sh`.quiet();

    // 4. Clean up temp files and commit
    await $`docker exec ${containerName} rm -f /tmp/install-agent.sh /tmp/install-tiger.sh`.quiet();
    await $`docker commit ${containerName} ${overlayTag}`.quiet();
    invalidateImageExistsCache(overlayTag);

    log.info({ overlayTag }, 'Agent overlay image built successfully');
    return overlayTag;
  } catch (err) {
    log.error({ err, overlayTag, agent }, 'Failed to build agent overlay');
    throw new Error(
      `Failed to build ${agent} overlay image: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    // Always clean up the temporary container
    await $`docker rm -f ${containerName}`.quiet().nothrow();
  }
}

/**
 * Get the GHCR image tag for the base sandbox image.
 * Tag is the content hash of the Dockerfile.
 */
export function getGhcrBaseTag(): string {
  const hash = computeDockerfileHash(BASE_DOCKERFILE);
  return `${GHCR_IMAGE_NAME}:${hash}`;
}

/**
 * Get the GHCR image tag for an agent overlay image.
 * Tag format: <dockerfile-hash>-<agent>-<agent-version>
 */
export function getGhcrAgentTag(agent: AgentType): string {
  const hash = computeDockerfileHash(BASE_DOCKERFILE);
  const version = getAgentVersion(agent);
  return `${GHCR_IMAGE_NAME}:${hash}-${agent}-${version}`;
}

/**
 * Get the Dockerfile content based on config.
 * Returns null if building is not configured.
 */
async function getDockerfileContent(
  which?: string | boolean | null,
): Promise<{ content: string; variant: 'base' | 'custom' } | null> {
  if (!which) return null;

  if (which === true) {
    return { content: BASE_DOCKERFILE, variant: 'base' };
  }

  // Custom path - read file
  const file = Bun.file(typeof which === 'string' ? which : '');
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
  variant: 'base' | 'custom';
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
}

/**
 * Resolve which Docker image to use based on configuration.
 *
 * Priority:
 * 1. buildSandboxFromDockerfile - build from Dockerfile (highest)
 * 2. sandboxBaseImage - use explicit image
 * 3. Default - pull GHCR sandbox image by content hash
 *
 * @param configOverride - Optional config to use instead of reading from filesystem (useful for testing)
 */
export async function resolveSandboxImage(
  configOverride?: OxConfig,
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

    return {
      image: dockerfile.image,
      needsBuild: true,
      dockerfileContent: dockerfile.content,
    };
  }

  // Second precedence: sandboxBaseImage (explicit override)
  if (config.sandboxBaseImage) {
    return {
      image: config.sandboxBaseImage,
      needsBuild: false,
    };
  }

  // Default: use GHCR sandbox image tagged by Dockerfile content hash.
  // The hash is deterministic — if the Dockerfile hasn't changed, the tag
  // is the same across versions. Once pulled, it never needs refreshing.
  return {
    image: getGhcrBaseTag(),
    needsBuild: false,
  };
}

// ============================================================================
// In-memory cache for imageExists — avoids redundant `docker image ls` calls
// during startup when multiple code paths check the same image in quick
// succession. Entries expire after IMAGE_EXISTS_CACHE_TTL_MS.
const IMAGE_EXISTS_CACHE_TTL_MS = 10_000;
const imageExistsCache = new Map<string, { exists: boolean; ts: number }>();

/**
 * Check if a specific Docker image exists locally.
 * Results are cached briefly to avoid redundant docker CLI calls.
 */
async function imageExists(imageName: string): Promise<boolean> {
  const cached = imageExistsCache.get(imageName);
  if (cached && Date.now() - cached.ts < IMAGE_EXISTS_CACHE_TTL_MS) {
    log.trace(
      { imageName, exists: cached.exists, cached: true },
      'imageExists',
    );
    return cached.exists;
  }

  try {
    const proc = await $`docker image ls --format json ${imageName}`.quiet();
    const output = proc.json();
    const exists =
      proc.exitCode === 0 && imageName === `${output.Repository}:${output.Tag}`;
    log.debug({ imageName }, `imageExists (${exists})`);
    imageExistsCache.set(imageName, { exists, ts: Date.now() });
    return exists;
  } catch {
    imageExistsCache.set(imageName, { exists: false, ts: Date.now() });
    return false;
  }
}

/** Invalidate cached imageExists result (e.g. after pulling or building). */
function invalidateImageExistsCache(imageName?: string): void {
  if (imageName) {
    imageExistsCache.delete(imageName);
  } else {
    imageExistsCache.clear();
  }
}

export interface DockerImageInfo {
  id: string;
  repository: string;
  tag: string;
  size: number;
  created: string;
}

/**
 * List all Docker images matching ox-related patterns.
 */
export async function listOxImages(): Promise<DockerImageInfo[]> {
  const patterns = [
    'ox-sandbox',
    `${GHCR_BASE}/sandbox`,
    // Legacy patterns for cleanup of old images
    `${GHCR_BASE}/sandbox-slim`,
    `${GHCR_BASE}/sandbox-full`,
    'ox-resume',
  ];

  const seen = new Set<string>();
  const images: DockerImageInfo[] = [];
  for (const pattern of patterns) {
    try {
      const result = await $`docker image ls --format json ${pattern}`.quiet();
      const lines = result.stdout.toString().trim().split('\n').filter(Boolean);
      for (const line of lines) {
        const info = JSON.parse(line);
        // Deduplicate by repository:tag since docker image ls can return
        // overlapping results across patterns (e.g. same underlying image
        // tagged in multiple repositories)
        const key = `${info.Repository}:${info.Tag}`;
        if (seen.has(key)) continue;
        seen.add(key);
        images.push({
          id: info.ID,
          repository: info.Repository,
          tag: info.Tag,
          size: parseDockerSize(info.Size),
          created: info.CreatedAt,
        });
      }
    } catch {
      // Pattern had no matches or docker not available
    }
  }
  return images;
}

/** Parse Docker size strings like "1.23GB", "456MB" to bytes */
function parseDockerSize(sizeStr: string): number {
  const match = sizeStr.match(/^([\d.]+)\s*(B|KB|MB|GB|TB)$/i);
  if (!match) return 0;
  const value = Number.parseFloat(match[1] ?? '0');
  const unit = (match[2] ?? 'B').toUpperCase();
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,
  };
  return Math.round(value * (multipliers[unit] ?? 1));
}

/**
 * Check if the resolved sandbox Docker image exists locally.
 */
export async function dockerImageExists(): Promise<boolean> {
  const imageConfig = await resolveSandboxImage();
  return imageExists(imageConfig.image);
}

export const ensureDockerSandbox = async (): Promise<void> => {
  const { useReadinessStore } = await import('../stores/readinessStore.ts');
  const state = useReadinessStore.getState();

  // If checks haven't run yet, run them now
  if (state.dockerInstalled === 'unknown') {
    await state.runChecks();
  }

  const afterChecks = useReadinessStore.getState();

  // If Docker is not installed, show the install TUI
  if (afterChecks.dockerInstalled === 'not-installed') {
    const dockerResult = await runDockerSetupScreen();
    log.debug({ dockerResult }, 'ensureDockerSandbox');
    if (dockerResult.type === 'cancelled') {
      throw new Error('Docker setup was cancelled by the user');
    }
    if (dockerResult.type === 'error') {
      throw new Error(`Docker setup failed: ${dockerResult.error}`);
    }
    // Re-run checks after installation
    useReadinessStore.getState().reset();
    await useReadinessStore.getState().runChecks();
  }

  const finalState = useReadinessStore.getState();
  if (finalState.dockerRunning !== 'running') {
    throw new Error('Docker is not running');
  }
  if (finalState.sandboxBaseImage !== 'ready') {
    throw new Error('Docker sandbox image is not available');
  }
};

// ============================================================================
// GHCR (GitHub Container Registry) Image Pull
// ============================================================================

/**
 * Try to pull a specific image tag
 * Returns true if successful, false otherwise
 */
async function tryPullImage(
  imageTag: string,
  onProgress?: (layers: PullLayer[]) => void,
): Promise<boolean> {
  const proc = Bun.spawn(['docker', 'pull', imageTag], {
    stdout: 'pipe',
    stderr: 'ignore',
  });

  const layers = new Map<string, PullLayerState>();
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value);
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const match = line.trim().match(/^([a-f0-9]+): (.+)$/);
      if (match) {
        const id = match[1];
        const status = match[2];
        if (!id || !status) continue;
        if (status.startsWith('Pulling') || status.startsWith('Waiting')) {
          layers.set(id, 'waiting');
        } else if (
          status.startsWith('Downloading') ||
          status.startsWith('Verifying')
        ) {
          layers.set(id, 'downloading');
        } else if (
          status.startsWith('Pull complete') ||
          status.startsWith('Download complete')
        ) {
          layers.set(id, 'complete');
        } else if (status.startsWith('Already exists')) {
          layers.set(id, 'exists');
        }
        onProgress?.(
          [...layers.entries()].map(([layerId, state]) => ({
            id: layerId,
            state,
          })),
        );
      }
    }
  }

  const exitCode = await proc.exited;
  if (exitCode === 0) {
    invalidateImageExistsCache(imageTag);
  }
  return exitCode === 0;
}

type ProgressCallback = (message: string, layers?: PullLayer[]) => void;

/**
 * Pull GHCR image for use as build cache.
 * Uses the content-hash-based tag. Returns the image tag if pulled, or null.
 */
async function pullGhcrImageForCache(
  onProgress?: ProgressCallback,
): Promise<string | null> {
  const ghcrTag = getGhcrBaseTag();
  onProgress?.('Pulling sandbox image for cache');
  if (
    await tryPullImage(ghcrTag, (layers) =>
      onProgress?.('Pulling sandbox image for cache', layers),
    )
  ) {
    return ghcrTag;
  }
  log.warn({ image: ghcrTag }, 'GHCR sandbox image not found for cache');
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
  invalidateImageExistsCache(imageName);
}

export type PullLayerState = 'waiting' | 'downloading' | 'complete' | 'exists';
export interface PullLayer {
  id: string;
  state: PullLayerState;
}

export type ImageBuildProgress =
  | { type: 'checking' }
  | { type: 'exists' }
  | { type: 'pulling'; message: string; layers?: PullLayer[] }
  | { type: 'pulling-cache'; message: string; layers?: PullLayer[] }
  | { type: 'building'; message: string; detail?: string }
  | { type: 'done' };

export interface EnsureDockerImageOptions {
  onProgress?: (progress: ImageBuildProgress) => void;
  /** Skip existence checks and force a rebuild */
  force?: boolean;
}

/**
 * Ensure the sandbox Docker image is available.
 * Handles three flows based on configuration:
 * 1. buildSandboxFromDockerfile - build from Dockerfile (uses GHCR for cache)
 * 2. sandboxBaseImage - pull explicit image (fails if unavailable)
 * 3. Default - pull GHCR sandbox image
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
    if (!options.force && (await imageExists(imageConfig.image))) {
      onProgress?.({ type: 'exists' });
      return imageConfig.image;
    }

    // Try to pull GHCR image for cache
    onProgress?.({
      type: 'pulling-cache',
      message: 'Pulling sandbox image for cache',
    });
    const cacheImage = await pullGhcrImageForCache((message, layers) =>
      onProgress?.({ type: 'pulling-cache', message, layers }),
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
    if (!options.force && (await imageExists(imageConfig.image))) {
      onProgress?.({ type: 'exists' });
      return imageConfig.image;
    }

    onProgress?.({
      type: 'pulling',
      message: `Pulling ${imageConfig.image}`,
    });
    const pulled = await tryPullImage(imageConfig.image, (layers) =>
      onProgress?.({
        type: 'pulling',
        message: `Pulling ${imageConfig.image}`,
        layers,
      }),
    );
    if (!pulled) {
      throw new Error(
        `Failed to pull configured sandbox image: ${imageConfig.image}`,
      );
    }
    onProgress?.({ type: 'done' });
    return imageConfig.image;
  }

  // Flow 3: Default - pull GHCR image by content hash
  // Hash-based tags are immutable: once pulled, never needs refreshing.

  // Check if image exists locally (no pull needed)
  if (!options.force && (await imageExists(imageConfig.image))) {
    onProgress?.({ type: 'exists' });
    return imageConfig.image;
  }

  // Try to pull from GHCR
  onProgress?.({
    type: 'pulling',
    message: 'Pulling sandbox image',
  });
  if (
    await tryPullImage(imageConfig.image, (layers) =>
      onProgress?.({
        type: 'pulling',
        message: 'Pulling sandbox image',
        layers,
      }),
    )
  ) {
    onProgress?.({ type: 'done' });
    return imageConfig.image;
  }

  // Final fallback: build the base image locally
  const info = await getDockerfileInfo(true);
  if (!info) {
    throw new Error(
      'Failed to get Dockerfile content for embedded base image.',
    );
  }
  onProgress?.({
    type: 'building',
    message: 'Building sandbox docker image',
  });
  await buildDockerImage(info.image, info.content);
  onProgress?.({ type: 'done' });
  return info.image;
}

// In-flight state for deduplicating concurrent ensureDockerImageForAgent
// calls for the same agent (e.g. prebuildAgentImage and credential check
// both firing when imageReady becomes true).
// Stores both the promise and a list of progress subscribers so that late
// callers still receive ongoing build progress.
interface InFlightAgentBuild {
  promise: Promise<string>;
  subscribers: Set<(progress: ImageBuildProgress) => void>;
  force: boolean;
}
const agentImageInFlight = new Map<AgentType, InFlightAgentBuild>();

/**
 * Ensure the base Docker image + agent overlay image are both available.
 * Returns the agent-specific overlay image tag, ready to use for containers.
 *
 * Concurrent calls for the same agent coalesce into a single resolution.
 * All callers' onProgress callbacks receive build progress updates.
 */
export async function ensureDockerImageForAgent(
  agent: AgentType,
  options: EnsureDockerImageOptions = {},
): Promise<string> {
  const existing = agentImageInFlight.get(agent);
  if (existing) {
    // Subscribe the new caller's progress callback to the in-flight build
    if (options.onProgress) {
      existing.subscribers.add(options.onProgress);
    }
    return existing.promise;
  }

  const subscribers = new Set<(progress: ImageBuildProgress) => void>();
  if (options.onProgress) {
    subscribers.add(options.onProgress);
  }

  // Fan-out progress to all subscribers
  const fanOutProgress = (progress: ImageBuildProgress) => {
    for (const cb of subscribers) {
      cb(progress);
    }
  };

  const coalesced: EnsureDockerImageOptions = {
    ...options,
    onProgress: fanOutProgress,
  };

  const promise = (async () => {
    const baseImage = await ensureDockerImage(coalesced);

    const config = await readConfig();
    let effectiveBase = baseImage;
    if (config.dockerInSandbox) {
      effectiveBase = await ensureDockerSandboxSetupLayer(
        effectiveBase,
        coalesced,
      );
    }

    // If projectSetupLayer is configured, apply it on top of the base
    if (config.projectSetupLayer) {
      effectiveBase = await ensureProjectSetupLayer(
        effectiveBase,
        config.projectSetupLayer,
        coalesced,
      );
    }

    return ensureAgentOverlay(effectiveBase, agent, coalesced);
  })();

  const entry: InFlightAgentBuild = {
    promise,
    subscribers,
    force: options.force ?? false,
  };
  agentImageInFlight.set(agent, entry);
  try {
    return await promise;
  } finally {
    agentImageInFlight.delete(agent);
  }
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
  interactive: boolean;
  envVars?: Record<string, string>;
  /** If set, mount this local directory into the container instead of git clone */
  mountDir?: string;
  /** Whether running from a git repository (affects git/gh operations and PR instructions) */
  isGitRepo?: boolean;
  /** Extra arguments to append to the agent command (e.g., ['--agent', 'plan']) */
  agentArgs?: string[];
  /** How the agent runs in the sandbox (async, interactive, plan) */
  agentMode?: AgentMode;
  /** Pre-resolved Docker image to use (e.g., agent overlay image). If not set, uses the default resolved image. */
  dockerImage?: string;
}

// ============================================================================
// Container Listing and Status
// ============================================================================

export interface OxSession {
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
  agentMode?: AgentMode;
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
 * List all ox-managed containers with their metadata
 */
export async function listOxSessions(): Promise<OxSession[]> {
  try {
    // Get all containers (running and stopped) with ox.managed=true label
    const result =
      await $`docker ps -a --filter label=ox.managed=true --format {{.ID}}`.quiet();
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

      let status: OxSession['status'];
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
        name: labels['ox.name'] || labels['ox.branch'] || 'unknown',
        branch: labels['ox.branch'] || 'unknown',
        agent: (labels['ox.agent'] as AgentType) || 'opencode',
        execType: (labels['ox.exec-type'] as ExecType) || undefined,
        model: labels['ox.model'],
        repo: labels['ox.repo'] || 'unknown',
        prompt: labels['ox.prompt'] || '',
        created: labels['ox.created'] || '',
        resumedFrom: labels['ox.resumed-from'],
        interactive: labels['ox.interactive'] === 'true',
        mountDir: labels['ox.mount'],
        agentMode:
          (labels['ox.agent-mode'] as AgentMode) ||
          (labels['ox.submit-mode'] as AgentMode) ||
          undefined,
        status,
        exitCode: status === 'exited' ? state.ExitCode : undefined,
        startedAt: state.StartedAt,
        finishedAt: status === 'exited' ? state.FinishedAt : undefined,
      };
    });
  } catch (error) {
    log.error({ error }, 'Failed to list ox sessions');
    // If docker command fails, return empty array
    return [];
  }
}

/**
 * Remove a ox container by name or ID
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
      resumeImage = container.Config.Labels?.['ox.resume-image'] ?? null;
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
 *
 * @param signal - Optional AbortSignal. When aborted the underlying
 *   `docker stats` process is killed and an empty map is returned.
 */
export async function getContainerStats(
  containerIds: string[],
  signal?: AbortSignal,
): Promise<Map<string, ContainerStats>> {
  const result = new Map<string, ContainerStats>();
  if (containerIds.length === 0 || signal?.aborted) return result;

  try {
    const proc = Bun.spawn(
      [
        'docker',
        'stats',
        '--no-stream',
        '--format',
        '{{json .}}',
        ...containerIds,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );

    // Wire up abort: kill the process immediately.
    if (signal) {
      const onAbort = () => {
        proc.kill();
      };
      if (signal.aborted) {
        proc.kill();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
        proc.exited.finally(() => signal.removeEventListener('abort', onAbort));
      }
    }

    const stdout = await new Response(proc.stdout).text();
    if (signal?.aborted) return result;

    for (const line of stdout.split('\n')) {
      if (!line) continue;
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
    if (!signal?.aborted) {
      log.warn({ err }, 'Failed to fetch container stats');
    }
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
 *
 * @param agent - The agent type running in the container. When `'opencode'`,
 *   mouse tracking is enabled so its TUI receives mouse events. For `'claude'`
 *   (or when unknown), mouse tracking is disabled to avoid garbled output.
 */
export async function attachToContainer(
  nameOrId: string,
  _options?: AttachOptions,
): Promise<void> {
  // Enter alternate screen so all container output is isolated from the
  // user's main screen buffer / scrollback history.
  // Mouse tracking is handled uniformly by tmux inside the container
  // (set -g mouse on in .tmux.conf) — no per-agent conditional needed.
  enterSubprocessScreen({
    alternateScreen: true,
  });

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
  enterSubprocessScreen(CLI_SUBPROCESS_OPTS);

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
  /** How the agent runs in the sandbox (async, interactive, plan) */
  agentMode?: AgentMode;
  /** Pre-resolved Docker image to use for the resumed container. If not set, commits from the stopped container. */
  dockerImage?: string;
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
  if (containerLabels['ox.managed'] !== 'true') {
    log.error(`Container ${nameOrId} is not managed by ox`);
    throw new Error('Container is not managed by ox');
  }

  if (container.State?.Running) {
    log.error(`Container ${nameOrId} is already running`);
    throw new Error('Container is already running');
  }

  const agent = (containerLabels['ox.agent'] as AgentType) || 'opencode';
  const model = options.model ?? containerLabels['ox.model'];
  const resumeSuffix = nanoid(6).toLowerCase();
  const resumeImage = `ox-resume:${container.Id.slice(0, 12)}-${resumeSuffix}`;

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
  // Ensure terminal env vars are current (may not have been in the original container)
  for (const key of ['TERM', 'COLORTERM']) {
    const value = process.env[key];
    if (value) {
      envArgs.push('-e', `${key}=${value}`);
    }
  }

  // Read config for overlay mounts and init script
  const config = await readConfig();
  const baseName = container.Name.replace(/\//g, '').trim();
  const containerName = `${baseName}-resumed-${resumeSuffix}`;
  const rootExecBeforeStart = buildDockerSandboxRootInitScript(config);
  const privilege = resolveDockerSandboxPrivilege(config);
  if (privilege.warning) {
    log.warn({ containerName }, privilege.warning);
  }

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
      : containerLabels['ox.prompt'] || '';
  const baseSessionName =
    containerLabels['ox.name'] || containerLabels['ox.branch'] || 'session';
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
${escapePrompt(buildAgentCommand({ agent, mode: mode === 'detached' ? 'detached' : 'interactive', model, agentArgs: options.agentArgs, continue: true }), agent, prompt, mode === 'interactive')}
`.trim();

  const oxLabels = buildOxLabels({
    name: resumeName,
    branch: containerLabels['ox.branch'] ?? 'unknown',
    agent,
    repo: containerLabels['ox.repo'] ?? 'unknown',
    prompt: resumePrompt,
    interactive: mode === 'interactive' || mode === 'shell',
    model,
    mount: absoluteMountDir,
    resumedFrom: container.Name.replace(/^\//, ''),
    resumeImage,
    agentMode:
      options.agentMode ??
      ((containerLabels['ox.agent-mode'] as AgentMode) ||
        (containerLabels['ox.submit-mode'] as AgentMode) ||
        undefined),
  });

  try {
    const result = await runInDocker({
      containerName,
      dockerArgs: [...envArgs, ...volumeArgs],
      cmdName: 'bash',
      cmdArgs: ['-c', resumeScript],
      dockerImage: resumeImage,
      // Always start detached — the caller uses provider.attach() for
      // interactive sessions.  allocateTty ensures the container has a
      // TTY so `docker attach` works correctly later.
      interactive: false,
      detached: true,
      allocateTty: mode !== 'detached',
      files,
      labels: oxLabels,
      privileged: privilege.privileged,
      rootExecBeforeStart,
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
export async function getSession(nameOrId: string): Promise<OxSession | null> {
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

    // Check if this is a ox-managed container
    if (labels['ox.managed'] !== 'true') {
      return null;
    }

    const state = container.State;

    let status: OxSession['status'];
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
      name: labels['ox.name'] || labels['ox.branch'] || 'unknown',
      branch: labels['ox.branch'] || 'unknown',
      agent: (labels['ox.agent'] as AgentType) || 'opencode',
      execType: (labels['ox.exec-type'] as ExecType) || undefined,
      model: labels['ox.model'],
      repo: labels['ox.repo'] || 'unknown',
      prompt: labels['ox.prompt'] || '',
      created: labels['ox.created'] || '',
      resumedFrom: labels['ox.resumed-from'],
      interactive: labels['ox.interactive'] === 'true',
      mountDir: labels['ox.mount'],
      agentMode:
        (labels['ox.agent-mode'] as AgentMode) ||
        (labels['ox.submit-mode'] as AgentMode) ||
        undefined,
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
): Promise<string> {
  const {
    branchName,
    prompt,
    repoInfo,
    agent,
    model,
    interactive,
    envVars,
    mountDir,
    isGitRepo = true,
    agentArgs,
    agentMode,
    dockerImage,
  } = options;

  const oxEnvPath = '.ox/.env';
  const oxEnvFile = Bun.file(oxEnvPath);

  // Create empty .ox/.env if it doesn't exist
  if (!(await oxEnvFile.exists())) {
    await Bun.write(oxEnvPath, '');
  }

  const containerName = `ox-${branchName}`;

  // Build env var arguments for docker run
  // Order matters for precedence: later values override earlier ones
  // Precedence (lowest to highest): hostEnvArgs -> --env-file -> envArgs

  // Pass through API keys from host environment (lowest precedence).
  // Only pass env-var keys that the active agent actually needs, and only
  // when valid file-based credentials aren't already present. Having both
  // an env-var key and file-based OAuth tokens causes some agents (notably
  // codex) to attempt conflicting auth flows, leading to noisy
  // "refresh_token_reused" errors.
  const hostEnvArgs: string[] = [];
  const pushEnv = (key: string) => {
    const value = process.env[key];
    if (value) {
      hostEnvArgs.push('-e', `${key}=${value}`);
    }
  };
  switch (agent) {
    case 'claude':
      if (!(await hasValidClaudeFileCredentials())) {
        pushEnv('ANTHROPIC_API_KEY');
      }
      break;
    case 'codex':
      if (!(await hasValidCodexFileCredentials())) {
        pushEnv('OPENAI_API_KEY');
        pushEnv('CODEX_API_KEY');
      }
      break;
    case 'opencode':
      if (!(await hasValidOpencodeFileCredentials())) {
        pushEnv('ANTHROPIC_API_KEY');
        pushEnv('OPENAI_API_KEY');
      }
      break;
  }

  // Pass through terminal environment for proper color rendering
  for (const key of ['TERM', 'COLORTERM']) {
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
  const rootExecBeforeStart = buildDockerSandboxRootInitScript(config);
  const privilege = resolveDockerSandboxPrivilege(config);
  if (privilege.warning) {
    log.warn({ containerName }, privilege.warning);
  }

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

  // Build the agent command based on the selected agent type, model, and mode.
  // Prompt injection is handled by escapePrompt() → wrapWithPrompt(), which
  // uses a shell variable ($OX_PROMPT) so stdin stays free for the TUI.
  const hasPrompt = prompt.trim().length > 0;
  const agentCommand = buildAgentCommand({
    agent,
    mode: interactive ? 'interactive' : 'detached',
    model,
    agentArgs,
  });

  // Only add PR instructions in async agent mode with a git repo
  const fullPrompt =
    agentMode === 'async' && isGitRepo
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
  git switch -c "ox/${branchName}"
fi
${config.initScript || ''}
${escapePrompt(agentCommand, agent, fullPrompt, interactive)}
`.trim();
    } else {
      // Mount mode outside a git repo - skip all git/gh operations
      startupScript = `
set -e
cd /work/app
${config.initScript || ''}
${escapePrompt(agentCommand, agent, fullPrompt, interactive)}
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
git switch -c "ox/${branchName}"
${config.initScript || ''}
${escapePrompt(agentCommand, agent, fullPrompt, interactive)}
`.trim();
  }

  const oxLabels = buildOxLabels({
    name: branchName,
    branch: branchName,
    agent,
    repo: repoInfo?.fullName,
    prompt,
    interactive,
    model,
    mount: absoluteMountDir,
    noGit: !isGitRepo || undefined,
    agentMode,
  });

  try {
    const result = await runInDocker({
      containerName,
      dockerArgs: [
        ...hostEnvArgs,
        '--env-file',
        oxEnvPath,
        ...envArgs,
        ...volumeArgs,
      ],
      cmdName: 'bash',
      cmdArgs: ['-c', startupScript],
      dockerImage,
      // Always start detached — the caller uses provider.attach() for
      // interactive sessions.  allocateTty ensures the container has a
      // TTY so `docker attach` works correctly later.
      interactive: false,
      detached: true,
      allocateTty: interactive,
      files,
      labels: oxLabels,
      privileged: privilege.privileged,
      rootExecBeforeStart,
    });
    await result.exited;
    return containerName;
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

  const oxEnvPath = '.ox/.env';
  const oxEnvFile = Bun.file(oxEnvPath);

  // Create empty .ox/.env if it doesn't exist
  if (!(await oxEnvFile.exists())) {
    await Bun.write(oxEnvPath, '');
  }

  const shellSuffix = nanoid(6).toLowerCase();
  const containerName = `ox-shell-${shellSuffix}`;

  // Pass through API keys and terminal env from host environment
  const hostEnvArgs: string[] = [];
  const apiKeysToPassthrough2 = [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
  ];
  for (const key of apiKeysToPassthrough2) {
    const value = process.env[key];
    if (value) {
      hostEnvArgs.push('-e', `${key}=${value}`);
    }
  }
  for (const key of ['TERM', 'COLORTERM']) {
    const value = process.env[key];
    if (value) {
      hostEnvArgs.push('-e', `${key}=${value}`);
    }
  }
  // Read config for overlay mounts and init script
  const config = await readConfig();
  const rootExecBeforeStart = buildDockerSandboxRootInitScript(config);
  const privilege = resolveDockerSandboxPrivilege(config);
  if (privilege.warning) {
    log.warn({ containerName }, privilege.warning);
  }

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

  const oxLabels = buildOxLabels({
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
    dockerArgs: [...hostEnvArgs, '--env-file', oxEnvPath, ...volumeArgs],
    cmdName: 'bash',
    cmdArgs: ['-c', startupScript],
    files,
    labels: oxLabels,
    privileged: privilege.privileged,
    rootExecBeforeStart,
  });
}
