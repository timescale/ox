// ============================================================================
// Docker Sandbox Provider - Adapts existing Docker functions to SandboxProvider
// ============================================================================

import {
  attachToContainer,
  type HermesSession as DockerSession,
  getSession as dockerGetSession,
  ensureDockerImage,
  ensureDockerSandbox,
  getContainerLogs,
  getContainerStats,
  listHermesSessions,
  removeContainer,
  resumeSession,
  shellInContainer,
  startContainer,
  startShellContainer,
  stopContainer,
  streamContainerLogs,
} from '../docker.ts';
import { log } from '../logger.ts';
import type {
  CreateSandboxOptions,
  CreateShellSandboxOptions,
  HermesSession,
  LogStream,
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
 * Map a Docker HermesSession to the unified HermesSession type.
 * Status mapping: 'running' -> 'running', 'exited' -> 'exited',
 * 'created' -> 'unknown' (never started),
 * all others ('paused', 'restarting', 'dead') -> 'stopped'.
 */
export function mapDockerSession(docker: DockerSession): HermesSession {
  let status: HermesSession['status'];
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
    onProgress?: (progress: SandboxBuildProgress) => void;
  }): Promise<string> {
    return ensureDockerImage({ onProgress: options?.onProgress });
  }

  async create(options: CreateSandboxOptions): Promise<HermesSession> {
    log.debug(
      {
        branchName: options.branchName,
        agent: options.agent,
        interactive: options.interactive,
      },
      'Creating Docker sandbox',
    );
    const { onProgress } = options;
    onProgress?.('Starting container');
    const containerName = await startContainer({
      branchName: options.branchName,
      prompt: options.prompt,
      repoInfo: options.repoInfo,
      agent: options.agent,
      model: options.model,
      detach: options.detach,
      interactive: options.interactive,
      envVars: options.envVars,
      mountDir: options.mountDir,
      isGitRepo: options.isGitRepo,
      agentArgs: options.agentArgs,
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
    return mapDockerSession(session);
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
  ): Promise<HermesSession> {
    log.debug({ sessionId }, 'Resuming Docker sandbox');
    const { onProgress } = options;
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
    return mapDockerSession(session);
  }

  async list(): Promise<HermesSession[]> {
    const sessions = await listHermesSessions();
    log.debug({ count: sessions.length }, 'Listed Docker sessions');
    return sessions.map(mapDockerSession);
  }

  async get(sessionId: string): Promise<HermesSession | null> {
    const session = await dockerGetSession(sessionId);
    return session ? mapDockerSession(session) : null;
  }

  async remove(sessionId: string): Promise<void> {
    log.debug({ sessionId }, 'Removing Docker sandbox');
    await removeContainer(sessionId);
  }

  async stop(sessionId: string): Promise<void> {
    log.debug({ sessionId }, 'Stopping Docker sandbox');
    await stopContainer(sessionId);
  }

  async attach(sessionId: string): Promise<void> {
    log.debug({ sessionId }, 'Attaching to Docker sandbox');
    await attachToContainer(sessionId);
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

  async getStats(sessionIds: string[]): Promise<Map<string, SandboxStats>> {
    const stats = await getContainerStats(sessionIds);
    return mapDockerStats(stats);
  }
}
