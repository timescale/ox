// ============================================================================
// Docker Container Service
// ============================================================================

import { dockerIsRunning } from 'build-strap';
import { $ } from 'bun';
import { nanoid } from 'nanoid';
import packageJson from '../../package.json' with { type: 'json' };
// Import the Dockerfile as text - Bun's bundler embeds this in the binary
import SANDBOX_DOCKERFILE from '../../sandbox/Dockerfile' with { type: 'text' };
import { runDockerSetupScreen } from '../components/DockerSetup';
import { formatShellError, type ShellError } from '../utils';
import { ghConfigVolume } from './auth';
import { CLAUDE_CONFIG_VOLUME } from './claude';
import type { AgentType } from './config';
import type { RepoInfo } from './git';
import { log } from './logger';
import { OPENCODE_CONFIG_VOLUME } from './opencode';
import { runInDocker } from './runInDocker';

// Compute MD5 hash of the Dockerfile content for versioned tagging
const hasher = new Bun.CryptoHasher('md5');
hasher.update(SANDBOX_DOCKERFILE);
const dockerfileHash = hasher.digest('hex').slice(0, 12);

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

const DOCKER_IMAGE_NAME = 'hermes-sandbox';
const DOCKER_IMAGE_TAG = `md5-${dockerfileHash}`;
export const HASHED_SANDBOX_DOCKER_IMAGE = `${DOCKER_IMAGE_NAME}:${DOCKER_IMAGE_TAG}`;

// GHCR (GitHub Container Registry) configuration for public image cache
const GHCR_IMAGE_NAME = 'ghcr.io/timescale/hermes/sandbox';
const GHCR_IMAGE_TAG_LATEST = `${GHCR_IMAGE_NAME}:latest`;
const GHCR_IMAGE_TAG_VERSION = `${GHCR_IMAGE_NAME}:${packageJson.version}`;

// ============================================================================
// Docker Image Management
// ============================================================================

export async function dockerImageExists(): Promise<boolean> {
  try {
    const proc =
      await $`docker image ls --format json ${HASHED_SANDBOX_DOCKER_IMAGE}`.quiet();
    const output = proc.json();
    log.debug({ output }, 'dockerImageExists');
    return output.Tag === DOCKER_IMAGE_TAG;
  } catch {
    return false;
  }
}

export const ensureDockerSandbox = async (): Promise<void> => {
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
 * Pull GHCR image for use as build cache
 * The image is public, so no authentication is needed.
 * Tries version-tagged image first, falls back to latest.
 * Returns the image tag that was successfully pulled, or null if all pulls failed.
 */
async function pullGhcrImageForCache(
  onProgress?: ProgressCallback,
): Promise<string | null> {
  // Try version-tagged image first (closer cache match)
  onProgress?.('Pulling versioned sandbox image');
  if (await tryPullImage(GHCR_IMAGE_TAG_VERSION)) {
    return GHCR_IMAGE_TAG_VERSION;
  }
  log.debug(
    { image: GHCR_IMAGE_TAG_VERSION },
    'Versioned GHCR image not found, falling back to latest',
  );

  // Fall back to latest
  onProgress?.('Pulling latest sandbox image');
  if (await tryPullImage(GHCR_IMAGE_TAG_LATEST)) {
    return GHCR_IMAGE_TAG_LATEST;
  }
  log.error({ image: GHCR_IMAGE_TAG_LATEST }, 'Latest GHCR image not found');

  return null;
}

/**
 * Build docker image, optionally using a pulled image as cache
 */
async function buildDockerImage(cacheFromImage?: string | null): Promise<void> {
  const proc = Bun.spawn(
    [
      'docker',
      'build',
      '-q',
      ...(cacheFromImage ? ['--cache-from', cacheFromImage] : []),
      '-t',
      HASHED_SANDBOX_DOCKER_IMAGE,
      '-',
    ],
    {
      stdin: Buffer.from(SANDBOX_DOCKERFILE),
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
  | { type: 'pulling-cache'; message: string }
  | { type: 'building'; message: string }
  | { type: 'done' };

export interface EnsureDockerImageOptions {
  onProgress?: (progress: ImageBuildProgress) => void;
}

export async function ensureDockerImage(
  options: EnsureDockerImageOptions = {},
): Promise<void> {
  const { onProgress } = options;

  onProgress?.({ type: 'checking' });

  if (await dockerImageExists()) {
    onProgress?.({ type: 'exists' });
    return;
  }

  // Try to pull the public GHCR image for caching
  onProgress?.({
    type: 'pulling-cache',
    message: 'Pulling sandbox image from GHCR',
  });
  const cacheImage = await pullGhcrImageForCache((message) =>
    onProgress?.({ type: 'pulling-cache', message }),
  );

  onProgress?.({
    type: 'building',
    message: 'Building sandbox docker image',
  });
  await buildDockerImage(cacheImage);

  onProgress?.({ type: 'done' });
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
  const volumeArgs = toVolumeArgs([
    CLAUDE_CONFIG_VOLUME,
    OPENCODE_CONFIG_VOLUME,
    ghConfigVolume(),
  ]);

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

  const volumeArgs = toVolumeArgs([
    CLAUDE_CONFIG_VOLUME,
    OPENCODE_CONFIG_VOLUME,
    ghConfigVolume(),
  ]);

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

  const startupScript = `
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
        ${HASHED_SANDBOX_DOCKER_IMAGE} \
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
        ${HASHED_SANDBOX_DOCKER_IMAGE} \
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
      HASHED_SANDBOX_DOCKER_IMAGE,
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
}

/**
 * Start a fresh shell container (no agent, just bash).
 * Uses a random name and clones the repo to the default branch.
 */
export async function startShellContainer(
  options: StartShellContainerOptions,
): Promise<void> {
  const { repoInfo } = options;

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

  const volumeArgs = toVolumeArgs([
    CLAUDE_CONFIG_VOLUME,
    OPENCODE_CONFIG_VOLUME,
    ghConfigVolume(),
  ]);

  // Shell startup script: clone repo to default branch and drop into bash
  const startupScript = `
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
