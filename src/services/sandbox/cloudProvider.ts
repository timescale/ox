// ============================================================================
// Cloud Sandbox Provider - Deno Deploy implementation
// ============================================================================

import packageJson from '../../../package.json' with { type: 'json' };
import { runCloudSetupScreen } from '../../components/CloudSetup.tsx';
import { enterSubprocessScreen, resetTerminal } from '../../utils.ts';
import type { AgentType } from '../config.ts';
import { readConfig } from '../config.ts';
import { ensureDenoToken, getDenoToken } from '../deno.ts';
import { getCredentialFiles } from '../docker.ts';
import { log } from '../logger.ts';
import { ensureCloudSnapshot } from './cloudSnapshot.ts';
import { DenoApiClient } from './denoApi.ts';
import {
  deleteSession as dbDeleteSession,
  getSession as dbGetSession,
  listSessions as dbListSessions,
  openSessionDb,
  updateSessionSnapshot,
  updateSessionStatus,
  upsertSession,
} from './sessionDb.ts';
import type {
  CreateSandboxOptions,
  CreateShellSandboxOptions,
  HermesSession,
  LogStream,
  ResumeSandboxOptions,
  SandboxBuildProgress,
  SandboxProvider,
} from './types.ts';

// ============================================================================
// Agent Command Builder
// ============================================================================

/**
 * Build the shell command string that starts an AI agent inside a sandbox.
 * Uses base64 encoding to safely pass the prompt through the shell.
 */
function buildAgentCommand(options: CreateSandboxOptions): string {
  const modelArg = options.model ? ` --model ${options.model}` : '';
  const extraArgs = options.agentArgs?.length
    ? ` ${options.agentArgs.join(' ')}`
    : '';
  const hasPrompt = options.prompt.trim().length > 0;

  if (options.agent === 'claude') {
    const hasPlanArgs =
      options.agentArgs?.includes('--permission-mode') ?? false;
    const skipPermsFlag = hasPlanArgs
      ? '--allow-dangerously-skip-permissions'
      : '--dangerously-skip-permissions';
    const asyncFlag = !options.interactive ? ' -p' : '';
    return hasPrompt
      ? `echo '${Buffer.from(options.prompt).toString('base64')}' | base64 -d | claude${asyncFlag}${extraArgs}${modelArg} ${skipPermsFlag}`
      : `claude${asyncFlag}${extraArgs}${modelArg} ${skipPermsFlag}`;
  }

  if (!options.interactive) {
    return hasPrompt
      ? `echo '${Buffer.from(options.prompt).toString('base64')}' | base64 -d | opencode${modelArg}${extraArgs} run`
      : `opencode${modelArg}${extraArgs} run`;
  }

  return hasPrompt
    ? `opencode${modelArg}${extraArgs} --prompt '${options.prompt.replace(/'/g, "'\\''")}'`
    : `opencode${modelArg}${extraArgs}`;
}

// ============================================================================
// Credential Injection
// ============================================================================

/**
 * Write all credential files (Claude, OpenCode, gh CLI) into a sandbox.
 */
async function injectCredentials(
  client: DenoApiClient,
  sandboxId: string,
  region: string,
): Promise<void> {
  const credFiles = await getCredentialFiles();
  for (const file of credFiles) {
    const dir = file.path.substring(0, file.path.lastIndexOf('/'));
    await client.execInSandbox(sandboxId, region, ['mkdir', '-p', dir]);
    await client.writeFile(sandboxId, region, file.path, file.value);
  }
}

// ============================================================================
// SSH Helper
// ============================================================================

/**
 * Expose SSH on a sandbox and run an interactive SSH session.
 */
async function sshIntoSandbox(
  client: DenoApiClient,
  sandboxId: string,
  region: string,
): Promise<void> {
  const sshInfo = await client.exposeSsh(sandboxId, region);
  enterSubprocessScreen();
  const proc = Bun.spawn(['ssh', `${sshInfo.username}@${sshInfo.hostname}`], {
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  await proc.exited;
  resetTerminal();
}

// ============================================================================
// Cloud Provider Implementation
// ============================================================================

export class CloudSandboxProvider implements SandboxProvider {
  readonly type = 'cloud' as const;

  private client: DenoApiClient | null = null;
  private region: string;

  constructor(region?: string) {
    this.region = region ?? 'ord';
  }

  // --------------------------------------------------------------------------
  // Private Helpers
  // --------------------------------------------------------------------------

  private async getClient(): Promise<DenoApiClient> {
    if (this.client) return this.client;
    const token = await getDenoToken();
    if (!token) throw new Error('No Deno Deploy token available');
    this.client = new DenoApiClient(token);
    return this.client;
  }

  private async resolveRegion(): Promise<string> {
    const config = await readConfig();
    return config.cloudRegion ?? this.region;
  }

  // --------------------------------------------------------------------------
  // Setup
  // --------------------------------------------------------------------------

  /**
   * Check whether the cloud provider needs setup (no token available).
   * Useful for UI to decide whether to show the setup flow before proceeding.
   */
  async needsSetup(): Promise<boolean> {
    const token = await getDenoToken();
    return !token;
  }

  async ensureReady(): Promise<void> {
    const token = await getDenoToken();
    if (!token) {
      const result = await runCloudSetupScreen();
      if (result.type !== 'ready') {
        throw new Error('Cloud setup was cancelled');
      }
    }
    // Verify we now have a valid token
    const validToken = await ensureDenoToken();
    if (!validToken) {
      throw new Error('No valid Deno Deploy token available');
    }
    this.client = new DenoApiClient(validToken);
  }

  // --------------------------------------------------------------------------
  // Image / Snapshot Management
  // --------------------------------------------------------------------------

  async ensureImage(options?: {
    onProgress?: (progress: SandboxBuildProgress) => void;
  }): Promise<string> {
    const token = await getDenoToken();
    if (!token) {
      throw new Error(
        'No Deno Deploy token configured. Run cloud setup first.',
      );
    }

    const region = await this.resolveRegion();

    const slug = await ensureCloudSnapshot({
      token,
      region,
      onProgress: (p) => {
        switch (p.type) {
          case 'checking':
            options?.onProgress?.({ type: 'checking' });
            break;
          case 'exists':
            options?.onProgress?.({ type: 'exists' });
            break;
          case 'creating-volume':
          case 'booting-sandbox':
          case 'installing':
          case 'snapshotting':
          case 'cleaning-up':
            options?.onProgress?.({ type: 'building', message: p.message });
            break;
          case 'done':
            options?.onProgress?.({ type: 'done' });
            break;
          case 'error':
            log.error({ error: p.message }, 'Snapshot build error');
            break;
        }
      },
    });

    return slug;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async create(options: CreateSandboxOptions): Promise<HermesSession | null> {
    const client = await this.getClient();
    const region = await this.resolveRegion();
    const baseSnapshot = `hermes-base-${packageJson.version}`;

    // 1. Create session-specific volume for /work
    const volumeSlug = `hermes-session-${options.branchName}-${Date.now()}`;
    const workVolume = await client.createVolume({
      slug: volumeSlug,
      region,
      capacity: '5GiB',
    });

    // 2. Build env vars
    const env: Record<string, string> = { ...options.envVars };

    // 3. Boot sandbox from base snapshot with work volume
    let sandbox: Awaited<ReturnType<typeof client.createSandbox>>;
    try {
      sandbox = await client.createSandbox({
        region,
        root: baseSnapshot,
        timeout: '30m',
        memory: '2GiB',
        volumes: { '/work': workVolume.slug },
        labels: {
          'hermes.managed': 'true',
          'hermes.name': options.branchName,
          'hermes.agent': options.agent,
          'hermes.repo': options.repoInfo?.fullName ?? 'local',
        },
        env,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.includes('limit') ||
        message.includes('concurrent') ||
        message.includes('quota')
      ) {
        const db = openSessionDb();
        const running = dbListSessions(db, {
          provider: 'cloud',
          status: 'running',
        });
        throw new Error(
          `Cloud sandbox limit reached (${running.length} running). ` +
            'Stop a running session or wait for one to finish.',
        );
      }
      throw err;
    }

    // 4. Inject credential files
    await injectCredentials(client, sandbox.id, region);

    // 5. Clone repo and create branch
    if (options.repoInfo && options.isGitRepo !== false) {
      await client.execInSandbox(
        sandbox.id,
        region,
        [
          'bash',
          '-c',
          `cd /work && gh auth setup-git && gh repo clone ${options.repoInfo.fullName} app && cd app && git switch -c "hermes/${options.branchName}"`,
        ],
        { user: 'hermes' },
      );
    } else {
      await client.execInSandbox(sandbox.id, region, [
        'bash',
        '-c',
        'mkdir -p /work/app',
      ]);
    }

    // 6. Run init script if configured
    if (options.initScript) {
      await client.execInSandbox(
        sandbox.id,
        region,
        ['bash', '-c', `cd /work/app && ${options.initScript}`],
        { user: 'hermes' },
      );
    }

    // 7. Start agent process
    const agentCommand = buildAgentCommand(options);
    if (options.interactive) {
      // Interactive mode: SSH into sandbox
      await sshIntoSandbox(client, sandbox.id, region);
    } else {
      // Detached mode: start agent in background
      await client.execInSandbox(
        sandbox.id,
        region,
        [
          'bash',
          '-c',
          `cd /work/app && nohup ${agentCommand} > /work/agent.log 2>&1 &`,
        ],
        { user: 'hermes' },
      );
    }

    // 8. Record in SQLite
    const session: HermesSession = {
      id: sandbox.id,
      name: options.branchName,
      provider: 'cloud',
      status: 'running',
      agent: options.agent,
      model: options.model,
      prompt: options.prompt,
      branch: options.branchName,
      repo: options.repoInfo?.fullName ?? 'local',
      created: new Date().toISOString(),
      interactive: options.interactive,
      region,
      volumeSlug: workVolume.slug,
    };

    const db = openSessionDb();
    upsertSession(db, session);

    return options.interactive ? null : session;
  }

  async createShell(options: CreateShellSandboxOptions): Promise<void> {
    const client = await this.getClient();
    const region = await this.resolveRegion();
    const baseSnapshot = `hermes-base-${packageJson.version}`;

    const sandbox = await client.createSandbox({
      region,
      root: baseSnapshot,
      timeout: '30m',
      memory: '2GiB',
      labels: { 'hermes.managed': 'true' },
    });

    // Inject credentials
    await injectCredentials(client, sandbox.id, region);

    // Clone repo if available
    if (options.repoInfo && options.isGitRepo !== false) {
      await client.execInSandbox(
        sandbox.id,
        region,
        [
          'bash',
          '-c',
          `cd /work && gh auth setup-git && gh repo clone ${options.repoInfo.fullName} app`,
        ],
        { user: 'hermes' },
      );
    }

    // SSH into the sandbox
    await sshIntoSandbox(client, sandbox.id, region);

    // Kill sandbox after shell exits
    try {
      await client.killSandbox(sandbox.id);
    } catch {
      // Best-effort cleanup
    }
  }

  async resume(
    sessionId: string,
    options: ResumeSandboxOptions,
  ): Promise<string> {
    const client = await this.getClient();
    const db = openSessionDb();

    const existing = dbGetSession(db, sessionId);
    if (!existing?.snapshotSlug) {
      throw new Error('No resume snapshot available for this session');
    }

    // Check region consistency — volumes/snapshots must stay in the same region
    const currentRegion = await this.resolveRegion();
    if (existing.region && existing.region !== currentRegion) {
      log.warn(
        { sessionRegion: existing.region, currentRegion },
        'Session region differs from current config region. Using session region.',
      );
    }
    // Use session's original region for consistency (volumes/snapshots are regional)
    const region = existing.region ?? currentRegion;

    // 1. Create new volume from resume snapshot
    const resumeVolumeSlug = `hermes-session-${existing.name}-r${Date.now()}`;
    const resumeVolume = await client.createVolume({
      slug: resumeVolumeSlug,
      region,
      from: existing.snapshotSlug,
      capacity: '5GiB',
    });

    // 2. Boot new sandbox from base snapshot + resume volume
    const baseSnapshot = `hermes-base-${packageJson.version}`;
    let sandbox: Awaited<ReturnType<typeof client.createSandbox>>;
    try {
      sandbox = await client.createSandbox({
        region,
        root: baseSnapshot,
        timeout: '30m',
        memory: '2GiB',
        volumes: { '/work': resumeVolume.slug },
        labels: {
          'hermes.managed': 'true',
          'hermes.name': existing.name,
          'hermes.agent': existing.agent,
          'hermes.repo': existing.repo,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.includes('limit') ||
        message.includes('concurrent') ||
        message.includes('quota')
      ) {
        const running = dbListSessions(db, {
          provider: 'cloud',
          status: 'running',
        });
        throw new Error(
          `Cloud sandbox limit reached (${running.length} running). ` +
            'Stop a running session or wait for one to finish.',
        );
      }
      throw err;
    }

    // 3. Inject fresh credentials
    await injectCredentials(client, sandbox.id, region);

    // 4. Start agent with continue flag or open shell
    const agent = existing.agent as AgentType;
    const model = options.model ?? existing.model;
    const modelArg = model ? ` --model ${model}` : '';
    const extraArgs = options.agentArgs?.length
      ? ` ${options.agentArgs.join(' ')}`
      : '';

    if (options.mode === 'shell' || options.mode === 'interactive') {
      await sshIntoSandbox(client, sandbox.id, region);
    } else {
      // Detached: run agent in background with continue flag
      let agentCmd: string;
      if (agent === 'claude') {
        const hasPlanArgs =
          options.agentArgs?.includes('--permission-mode') ?? false;
        const skipPermsFlag = hasPlanArgs
          ? '--allow-dangerously-skip-permissions'
          : '--dangerously-skip-permissions';
        const promptArg = ' -p';
        agentCmd = `claude -c${promptArg}${extraArgs}${modelArg} ${skipPermsFlag}`;
      } else {
        agentCmd = `opencode${modelArg}${extraArgs} run -c`;
      }

      if (options.prompt) {
        const b64 = Buffer.from(options.prompt).toString('base64');
        agentCmd = `echo '${b64}' | base64 -d | ${agentCmd}`;
      }

      await client.execInSandbox(
        sandbox.id,
        region,
        [
          'bash',
          '-c',
          `cd /work/app && nohup ${agentCmd} > /work/agent.log 2>&1 &`,
        ],
        { user: 'hermes' },
      );
    }

    // 5. Update SQLite
    const newSession: HermesSession = {
      id: sandbox.id,
      name: existing.name,
      provider: 'cloud',
      status: 'running',
      agent: existing.agent as AgentType,
      model: options.model ?? existing.model,
      prompt: options.prompt ?? existing.prompt,
      branch: existing.branch,
      repo: existing.repo,
      created: new Date().toISOString(),
      interactive: options.mode === 'interactive' || options.mode === 'shell',
      region,
      volumeSlug: resumeVolume.slug,
      resumedFrom: sessionId,
    };
    upsertSession(db, newSession);

    return sandbox.id;
  }

  // --------------------------------------------------------------------------
  // Session Management
  // --------------------------------------------------------------------------

  async list(): Promise<HermesSession[]> {
    const db = openSessionDb();

    // Get sessions from SQLite
    const dbSessions = dbListSessions(db, { provider: 'cloud' });

    // If we have a client, try to sync status from Deno API
    try {
      const client = await this.getClient();
      const runningSandboxes = await client.listSandboxes({
        'hermes.managed': 'true',
      });

      const runningIds = new Set(runningSandboxes.map((s) => s.id));

      // Update status for sessions that are no longer running
      for (const session of dbSessions) {
        if (session.status === 'running' && !runningIds.has(session.id)) {
          updateSessionStatus(db, session.id, 'exited');
          session.status = 'exited';
        }
      }
    } catch (err) {
      log.debug({ err }, 'Failed to sync cloud session status');
    }

    return dbSessions;
  }

  async get(sessionId: string): Promise<HermesSession | null> {
    const db = openSessionDb();
    return dbGetSession(db, sessionId);
  }

  async remove(sessionId: string): Promise<void> {
    const db = openSessionDb();
    const session = dbGetSession(db, sessionId);

    try {
      const client = await this.getClient();
      // Kill sandbox if running
      try {
        await client.killSandbox(sessionId);
      } catch {
        // May already be dead
      }
      // Delete volume
      if (session?.volumeSlug) {
        try {
          await client.deleteVolume(session.volumeSlug);
        } catch {
          // Best-effort cleanup
        }
      }
      // Delete resume snapshot
      if (session?.snapshotSlug) {
        try {
          await client.deleteSnapshot(session.snapshotSlug);
        } catch {
          // Best-effort cleanup
        }
      }
    } catch (err) {
      log.debug({ err }, 'Failed to clean up cloud resources');
    }

    dbDeleteSession(db, sessionId);
  }

  async stop(sessionId: string): Promise<void> {
    const db = openSessionDb();
    const session = dbGetSession(db, sessionId);

    try {
      const client = await this.getClient();

      // Snapshot work volume for resume
      if (session?.volumeSlug) {
        const snapshotSlug = `hermes-resume-${session.name}-${Date.now()}`;
        try {
          await client.snapshotVolume(session.volumeSlug, snapshotSlug);
          updateSessionSnapshot(db, sessionId, snapshotSlug);
        } catch (err) {
          log.warn({ err }, 'Failed to snapshot volume before stop');
        }
      }

      // Kill sandbox
      await client.killSandbox(sessionId);
    } catch (err) {
      log.debug({ err }, 'Failed to stop cloud sandbox');
    }

    updateSessionStatus(db, sessionId, 'stopped');
  }

  // --------------------------------------------------------------------------
  // Interactive Access
  // --------------------------------------------------------------------------

  async attach(sessionId: string): Promise<void> {
    const client = await this.getClient();
    const db = openSessionDb();
    const session = dbGetSession(db, sessionId);
    const region = session?.region ?? (await this.resolveRegion());
    await sshIntoSandbox(client, sessionId, region);
  }

  async shell(sessionId: string): Promise<void> {
    // Same as attach for cloud sandboxes
    await this.attach(sessionId);
  }

  // --------------------------------------------------------------------------
  // Logs
  // --------------------------------------------------------------------------

  async getLogs(sessionId: string, tail?: number): Promise<string> {
    try {
      const client = await this.getClient();
      const db = openSessionDb();
      const session = dbGetSession(db, sessionId);
      const region = session?.region ?? (await this.resolveRegion());
      const content = await client.readFile(
        sessionId,
        region,
        '/work/agent.log',
      );
      if (tail) {
        const lines = content.split('\n');
        return lines.slice(-tail).join('\n');
      }
      return content;
    } catch (err) {
      log.debug({ err }, 'Failed to read cloud sandbox logs');
      return '';
    }
  }

  streamLogs(sessionId: string): LogStream {
    let stopped = false;
    let lastOffset = 0;
    const resolveRegion = this.resolveRegion.bind(this);

    const stop = () => {
      stopped = true;
    };

    async function* generateLines(): AsyncIterable<string> {
      const db = openSessionDb();
      const session = dbGetSession(db, sessionId);
      const region = session?.region ?? (await resolveRegion());

      while (!stopped) {
        try {
          const token = await getDenoToken();
          if (!token) break;
          const client = new DenoApiClient(token);
          const content = await client.readFile(
            sessionId,
            region,
            '/work/agent.log',
          );
          const newContent = content.substring(lastOffset);
          lastOffset = content.length;

          if (newContent) {
            const lines = newContent.split('\n');
            for (const line of lines) {
              if (line) yield line;
            }
          }
        } catch {
          // File might not exist yet
        }

        // Poll every 2 seconds
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    return { lines: generateLines(), stop };
  }
}
