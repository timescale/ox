// ============================================================================
// Docker Sandbox Provider - Adapts existing Docker functions to SandboxProvider
// ============================================================================

import { type AgentType, readConfig } from '../config.ts';
import {
  attachToContainer,
  type OxSession as DockerSession,
  getSession as dockerGetSession,
  ensureDockerImage,
  ensureDockerImageForAgent,
  ensureDockerSandbox,
  ensureProjectSetupLayer,
  getContainerLogs,
  getContainerStats,
  listOxSessions,
  removeContainer,
  resumeSession,
  shellInContainer,
  startContainer,
  startShellContainer,
  stopContainer,
  streamContainerLogs,
} from '../docker.ts';
import { readFileFromContainer, writeFileToContainer } from '../dockerFiles.ts';
import { log } from '../logger.ts';
import {
  getPortUrls,
  setupPortForwarding,
  teardownPortForwarding,
} from '../portForwarding/index.ts';
import type {
  AttachOptions,
  CreateSandboxOptions,
  CreateShellSandboxOptions,
  LogStream,
  OxSession,
  ResumeSandboxOptions,
  SandboxBuildProgress,
  SandboxProvider,
  SandboxStats,
  ShellSession,
} from './types.ts';

// ============================================================================
// Session Mapping
// ============================================================================

/**
 * Map a Docker OxSession to the unified OxSession type.
 * Status mapping: 'running' -> 'running', 'exited' -> 'exited',
 * 'created' -> 'unknown' (never started),
 * all others ('paused', 'restarting', 'dead') -> 'stopped'.
 */
export function mapDockerSession(docker: DockerSession): OxSession {
  let status: OxSession['status'];
  switch (docker.status) {
    case 'running':
      status = 'running';
      break;
    case 'exited':
      status = 'exited';
      break;
    case 'created':
      status = 'unknown';
      break;
    default:
      status = 'stopped';
      break;
  }

  return {
    id: docker.containerId,
    name: docker.name,
    provider: 'docker',
    status,
    exitCode: docker.exitCode,
    agent: docker.agent,
    model: docker.model,
    prompt: docker.prompt,
    branch: docker.branch,
    repo: docker.repo,
    created: docker.created,
    interactive: docker.interactive,
    execType: docker.execType,
    resumedFrom: docker.resumedFrom,
    mountDir: docker.mountDir,
    containerName: docker.containerName,
    startedAt: docker.startedAt,
    finishedAt: docker.finishedAt,
    agentMode: docker.agentMode,
  };
}

/**
 * Map Docker ContainerStats to the unified SandboxStats type.
 */
export function mapDockerStats(
  stats: Map<
    string,
    {
      containerId: string;
      cpuPercent: number;
      memUsage: string;
      memPercent: number;
    }
  >,
): Map<string, SandboxStats> {
  const result = new Map<string, SandboxStats>();
  for (const [key, value] of stats) {
    result.set(key, {
      id: value.containerId,
      cpuPercent: value.cpuPercent,
      memUsage: value.memUsage,
      memPercent: value.memPercent,
    });
  }
  return result;
}

// ============================================================================
// Docker Provider Implementation
// ============================================================================

export class DockerSandboxProvider implements SandboxProvider {
  readonly type = 'docker' as const;

  async ensureReady(): Promise<void> {
    await ensureDockerSandbox();
  }

  async ensureImage(options?: {
    agent?: AgentType;
    force?: boolean;
    onProgress?: (progress: SandboxBuildProgress) => void;
  }): Promise<string> {
    if (options?.agent) {
      return ensureDockerImageForAgent(options.agent, {
        onProgress: options?.onProgress,
        force: options?.force,
      });
    }
    const baseImage = await ensureDockerImage({
      onProgress: options?.onProgress,
      force: options?.force,
    });

    // Chain through project setup layer if configured
    const config = await readConfig();
    if (config.projectSetupLayer) {
      return ensureProjectSetupLayer(baseImage, config.projectSetupLayer, {
        onProgress: options?.onProgress,
        force: options?.force,
      });
    }

    return baseImage;
  }

  async create(options: CreateSandboxOptions): Promise<OxSession> {
    log.debug(
      {
        branchName: options.branchName,
        agent: options.agent,
        interactive: options.interactive,
      },
      'Creating Docker sandbox',
    );
    const { onProgress, requestSudo } = options;

    // Ensure agent-specific overlay image exists
    onProgress?.('Preparing agent image');
    const agentImage = await this.ensureImage({ agent: options.agent });

    onProgress?.('Starting container');
    const containerName = await startContainer({
      branchName: options.branchName,
      prompt: options.prompt,
      repoInfo: options.repoInfo,
      agent: options.agent,
      model: options.model,
      interactive: options.interactive,
      envVars: options.envVars,
      mountDir: options.mountDir,
      isGitRepo: options.isGitRepo,
      agentArgs: options.agentArgs,
      agentMode: options.agentMode,
      dockerImage: agentImage,
      initScript: options.initScript,
      rootInitScript: options.rootInitScript,
      overlayMounts: options.overlayMounts,
    });

    // Fetch the full session info for the container
    onProgress?.('Loading session');
    const session = await dockerGetSession(containerName);
    if (!session) {
      throw new Error('Failed to find created Docker session');
    }
    log.debug(
      { sessionId: session.containerId, name: session.name },
      'Docker sandbox created',
    );
    const mapped = mapDockerSession(session);

    // Set up port forwarding (best-effort — won't block session creation)
    onProgress?.('Configuring port forwarding');
    const portUrls = await setupPortForwarding(
      containerName,
      containerName,
      requestSudo,
    );
    if (portUrls) {
      mapped.portUrls = portUrls;
    }

    return mapped;
  }

  async createShell(options: CreateShellSandboxOptions): Promise<ShellSession> {
    options.onProgress?.('Starting shell container');
    return {
      connect: () =>
        startShellContainer({
          repoInfo: options.repoInfo,
          mountDir: options.mountDir,
          isGitRepo: options.isGitRepo,
        }),
      // Docker uses --rm so containers auto-remove on exit
      cleanup: async () => {},
    };
  }

  async resume(
    sessionId: string,
    options: ResumeSandboxOptions,
  ): Promise<OxSession> {
    log.debug({ sessionId }, 'Resuming Docker sandbox');
    const { onProgress, requestSudo } = options;
    onProgress?.('Resuming container');
    const containerName = await resumeSession(sessionId, options);

    // Fetch the full session info for the resumed container
    onProgress?.('Loading session');
    const session = await dockerGetSession(containerName);
    if (!session) {
      throw new Error('Failed to find resumed Docker session');
    }
    log.debug(
      { sessionId: session.containerId, name: session.name },
      'Docker sandbox resumed',
    );
    const mapped = mapDockerSession(session);

    // Set up port forwarding (best-effort — won't block session creation)
    onProgress?.('Configuring port forwarding');
    const portUrls = await setupPortForwarding(
      containerName,
      containerName,
      requestSudo,
    );
    if (portUrls) {
      mapped.portUrls = portUrls;
    }

    return mapped;
  }

  async list(): Promise<OxSession[]> {
    const sessions = await listOxSessions();
    log.trace({ count: sessions.length }, 'Listed Docker sessions');
    const mapped = sessions.map(mapDockerSession);

    // Derive port URLs from config for running sessions
    for (const session of mapped) {
      if (session.status === 'running' && session.containerName) {
        session.portUrls =
          (await getPortUrls(session.containerName)) ?? undefined;
      }
    }

    return mapped;
  }

  async get(sessionId: string): Promise<OxSession | null> {
    const session = await dockerGetSession(sessionId);
    if (!session) return null;
    const mapped = mapDockerSession(session);

    // Derive port URLs from config for running sessions
    if (mapped.status === 'running' && mapped.containerName) {
      mapped.portUrls = (await getPortUrls(mapped.containerName)) ?? undefined;
    }

    return mapped;
  }

  async remove(sessionId: string): Promise<void> {
    log.debug({ sessionId }, 'Removing Docker sandbox');
    // Look up the container name so we can match the caddy_routes key
    // (routes are stored by container name, but sessionId is the container ID)
    const session = await dockerGetSession(sessionId);
    const containerName = session?.containerName ?? sessionId;
    await teardownPortForwarding(containerName, containerName);
    await removeContainer(sessionId);
  }

  async stop(sessionId: string): Promise<void> {
    log.debug({ sessionId }, 'Stopping Docker sandbox');
    // Look up the container name so we can match the caddy_routes key
    // (routes are stored by container name, but sessionId is the container ID)
    const session = await dockerGetSession(sessionId);
    const containerName = session?.containerName ?? sessionId;
    await teardownPortForwarding(containerName, containerName);
    await stopContainer(sessionId);
  }

  async attach(sessionId: string, options?: AttachOptions): Promise<void> {
    log.debug({ sessionId }, 'Attaching to Docker sandbox');
    await attachToContainer(sessionId, options);
  }

  async shell(sessionId: string): Promise<void> {
    log.debug({ sessionId }, 'Opening shell in Docker sandbox');
    await shellInContainer(sessionId);
  }

  async getLogs(sessionId: string, tail?: number): Promise<string> {
    return getContainerLogs(sessionId, tail);
  }

  streamLogs(sessionId: string): LogStream {
    return streamContainerLogs(sessionId);
  }

  async getStats(
    sessionIds: string[],
    signal?: AbortSignal,
  ): Promise<Map<string, SandboxStats>> {
    const stats = await getContainerStats(sessionIds, signal);
    return mapDockerStats(stats);
  }

  async readFile(sessionId: string, path: string): Promise<string | null> {
    try {
      return await readFileFromContainer(sessionId, path);
    } catch (err) {
      log.debug(
        { err, sessionId, path },
        'Failed to read file from Docker container',
      );
      return null;
    }
  }

  async writeFile(
    sessionId: string,
    path: string,
    content: string,
  ): Promise<void> {
    try {
      await writeFileToContainer(sessionId, path, content);
    } catch (err) {
      log.debug(
        { err, sessionId, path },
        'Failed to write file to Docker container',
      );
    }
  }
}
