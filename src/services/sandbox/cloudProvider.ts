// ============================================================================
// Cloud Sandbox Provider - Deno Deploy implementation using @deno/sandbox SDK
// ============================================================================

import type { Sandbox } from '@deno/sandbox';
import { runCloudSetupScreen } from '../../components/CloudSetup.tsx';
import {
  enterSubprocessScreen,
  resetTerminal,
  shellEscape,
} from '../../utils.ts';
import { buildAgentCommand, buildContinueCommand } from '../agentCommand.ts';
import type { AgentType } from '../config.ts';
import { readConfig } from '../config.ts';
import { ensureDenoToken, getDenoToken } from '../deno.ts';
import { getCredentialFiles } from '../docker.ts';
import { log } from '../logger.ts';
import { ensureCloudSnapshot } from './cloudSnapshot.ts';
import { DenoApiClient, denoSlug, type ResolvedSandbox } from './denoApi.ts';
import { sandboxExec } from './sandboxExec.ts';
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
// Constants
// ============================================================================

/** Name of the tmux session used for agent processes inside cloud sandboxes. */
const TMUX_SESSION = 'hermes';

/** Check whether an error message indicates a concurrency/quota limit. */
function isConcurrencyLimitError(message: string): boolean {
  return (
    message.includes('limit') ||
    message.includes('concurrent') ||
    message.includes('quota')
  );
}

// ============================================================================
// Credential Injection
// ============================================================================

/**
 * Write all credential files (Claude, OpenCode, gh CLI) into a sandbox
 * using the SDK's filesystem API. Resolves the default user's $HOME first
 * so paths are correct for the sandbox environment.
 */
async function injectCredentials(sandbox: Sandbox): Promise<void> {
  const homeResult = await sandboxExec(sandbox, 'echo $HOME', {
    capture: true,
  });
  const home = homeResult.trim();
  const credFiles = await getCredentialFiles(home);
  for (const file of credFiles) {
    const dir = file.path.substring(0, file.path.lastIndexOf('/'));
    await sandbox.fs.mkdir(dir, { recursive: true });
    await sandbox.fs.writeTextFile(file.path, file.value);
  }
}

// ============================================================================
// SSH Helper
// ============================================================================

/**
 * Expose SSH on a sandbox and run an interactive SSH session.
 *
 * @param options.command  Shell command to execute on the remote side.
 * @param options.tmux     If true, wrap the command in a persistent tmux
 *                         session so the agent survives SSH disconnects.
 *                         ctrl+\ detaches (configured in ~/.tmux.conf).
 *                         When reattaching (command omitted, tmux true),
 *                         connects to the existing tmux session.
 */
async function sshIntoSandbox(
  sandbox: Sandbox,
  options?: {
    command?: string;
    tmux?: boolean;
    /**
     * Command to run when re-creating a dead tmux session.
     * Used with `tmux: true` (no explicit `command`): if the named tmux
     * session still exists we attach to it, otherwise we create a new
     * one running this command.  Defaults to `bash -l`.
     */
    tmuxResumeCommand?: string;
  },
): Promise<void> {
  const { command, tmux, tmuxResumeCommand } = options ?? {};
  const sshInfo = await sandbox.exposeSsh();
  enterSubprocessScreen();
  const sshArgs = [
    'ssh',
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'UserKnownHostsFile=/dev/null',
    '-o',
    'LogLevel=ERROR',
    '-o',
    'SetEnv=TERM=xterm-256color',
  ];

  // Build the remote command
  // -u forces UTF-8 mode so block/box-drawing characters render correctly
  let remoteCmd: string | undefined;
  if (tmux && command) {
    // Start agent inside a named tmux session (or attach if it already exists)
    remoteCmd = `tmux -u new-session -A -s ${TMUX_SESSION} ${shellEscape(command)}`;
  } else if (tmux) {
    // Attach to existing tmux session, or create a new one running the
    // resume command (agent -c).  Uses new-session -A which attaches if
    // the session exists, or creates it otherwise.
    const resumeCmd = shellEscape(tmuxResumeCommand ?? 'bash -l');
    remoteCmd = `tmux -u new-session -A -s ${TMUX_SESSION} -c /work/app ${resumeCmd}`;
  } else if (command) {
    remoteCmd = command;
  }

  if (remoteCmd) {
    // Force PTY allocation — required for interactive TUIs and tmux
    sshArgs.push('-t');
    sshArgs.push(`${sshInfo.username}@${sshInfo.hostname}`);
    sshArgs.push(remoteCmd);
  } else {
    sshArgs.push(`${sshInfo.username}@${sshInfo.hostname}`);
  }

  try {
    const proc = Bun.spawn(sshArgs, {
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      log.warn({ exitCode }, 'SSH process exited with non-zero status');
    }
  } finally {
    resetTerminal();
  }
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
    log.debug('Checking if cloud provider setup is needed');
    const token = await getDenoToken();
    if (!token) {
      log.debug('No Deno Deploy token found, entering setup screen');
      const result = await runCloudSetupScreen();
      if (result.type !== 'ready') {
        throw new Error('Cloud setup was cancelled');
      }
    } else {
      log.debug('Deno Deploy token found');
    }
    // Verify we now have a valid token
    const validToken = await ensureDenoToken();
    if (!validToken) {
      throw new Error('No valid Deno Deploy token available');
    }
    this.client = new DenoApiClient(validToken);
    log.debug('Cloud provider setup complete');
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

  async create(options: CreateSandboxOptions): Promise<HermesSession> {
    const { onProgress } = options;
    const client = await this.getClient();
    const region = await this.resolveRegion();
    const baseSnapshot = await this.ensureImage();

    // 1. Create session-specific root volume from the base snapshot.
    onProgress?.('Creating volume');
    const volumeSlug = denoSlug('hs', options.branchName);
    const rootVolume = await client.createVolume({
      slug: volumeSlug,
      region,
      capacity: '10GiB',
      from: baseSnapshot,
    });

    // 2. Build env vars
    const env: Record<string, string> = { ...options.envVars };

    // 3. Boot sandbox from the session volume
    onProgress?.('Booting sandbox');
    let sandbox: ResolvedSandbox;
    try {
      sandbox = await client.createSandbox({
        region: region as 'ord' | 'ams',
        root: rootVolume.slug,
        timeout: '30m',
        memory: '2GiB',
        labels: {
          'hermes.managed': 'true',
          'hermes.name': options.branchName,
          'hermes.agent': options.agent,
          'hermes.repo': options.repoInfo?.fullName ?? 'local',
        },
        env,
      });
    } catch (err) {
      // Clean up the orphaned volume
      try {
        await client.deleteVolume(rootVolume.id);
      } catch (delErr) {
        log.debug(
          { err: delErr },
          'Failed to clean up volume after sandbox creation failure',
        );
      }

      const message = (err as { message?: string })?.message ?? String(err);
      if (isConcurrencyLimitError(message)) {
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

    try {
      // 4. Inject credential files
      onProgress?.('Setting up credentials');
      await injectCredentials(sandbox);

      // 5. Clone repo and create branch
      if (options.repoInfo && options.isGitRepo !== false) {
        onProgress?.('Cloning repository');
        const fullName = options.repoInfo.fullName;
        const branchRef = `hermes/${options.branchName}`;
        await sandboxExec(
          sandbox,
          `cd /work && gh auth setup-git && gh repo clone ${shellEscape(fullName)} app && cd app && git switch -c ${shellEscape(branchRef)}`,
        );
      } else {
        await sandboxExec(sandbox, 'mkdir -p /work/app');
      }

      // 6. Run init script if configured (dynamic — may contain shell syntax).
      // NOTE: initScript is intentionally interpolated without escaping — it IS
      // a shell command (like a post-create hook) and is expected to contain
      // arbitrary shell syntax.  The value comes from the user's own config
      // file and should be treated as trusted input.
      if (options.initScript) {
        onProgress?.('Running init script');
        await sandboxExec(sandbox, `cd /work/app && ${options.initScript}`);
      }

      // 7. Start agent process
      onProgress?.('Starting agent');
      const agentCommand = buildAgentCommand({
        agent: options.agent,
        mode: options.interactive ? 'interactive' : 'detached',
        model: options.model,
        agentArgs: options.agentArgs,
        prompt: options.prompt,
      });
      if (options.interactive) {
        // Start agent inside a detached tmux session so it's ready for
        // the caller to attach via SSH later (provider.attach()).
        await sandboxExec(
          sandbox,
          `tmux new-session -d -s ${TMUX_SESSION} -c /work/app ${shellEscape(agentCommand)}`,
        );
      } else {
        // Detached mode: start agent in background
        await sandboxExec(
          sandbox,
          `cd /work/app && nohup ${agentCommand} > /work/agent.log 2>&1 &`,
        );
      }
    } catch (err) {
      // Setup failed — tear down the cloud sandbox and volume so we don't
      // leak resources (especially important given the 5-sandbox limit).
      try {
        await sandbox.close();
      } catch {
        // best-effort
      }
      try {
        await client.killSandbox(sandbox.resolvedId || sandbox.id);
      } catch {
        // best-effort
      }
      try {
        await client.deleteVolume(rootVolume.id);
      } catch {
        // best-effort
      }
      throw err;
    }

    // Close our WebSocket connection — the sandbox keeps running
    await sandbox.close();

    // 8. Record in SQLite
    const sessionId = sandbox.resolvedId || sandbox.id;
    if (!sessionId) {
      throw new Error(
        'Cannot persist session: sandbox has no resolvedId or id',
      );
    }

    const session: HermesSession = {
      id: sessionId,
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
      volumeSlug: rootVolume.slug,
    };

    const db = openSessionDb();
    upsertSession(db, session);

    return session;
  }

  async createShell(options: CreateShellSandboxOptions): Promise<void> {
    const client = await this.getClient();
    const region = await this.resolveRegion();
    const baseSnapshot = await this.ensureImage();

    // Create an ephemeral root volume from the base snapshot so installed
    // tools are visible (snapshot-direct boot uses a read-only overlay).
    const shellVolume = await client.createVolume({
      slug: denoSlug('hsh'),
      region,
      capacity: '10GiB',
      from: baseSnapshot,
    });

    const sandbox = await client.createSandbox({
      region: region as 'ord' | 'ams',
      root: shellVolume.slug,
      timeout: '30m',
      memory: '2GiB',
      labels: { 'hermes.managed': 'true' },
    });

    try {
      // Inject credentials
      await injectCredentials(sandbox);
      await sandboxExec(sandbox, 'mkdir -p /work');

      // Clone repo if available
      if (options.repoInfo && options.isGitRepo !== false) {
        const fullName = options.repoInfo.fullName;
        await sandboxExec(
          sandbox,
          `cd /work && gh auth setup-git && gh repo clone ${shellEscape(fullName)} app`,
        );
      }

      // SSH into the sandbox
      await sshIntoSandbox(sandbox);
    } finally {
      // Kill sandbox after shell exits
      try {
        await sandbox.close();
      } catch {
        // Best-effort cleanup
      }
      try {
        await client.killSandbox(sandbox.resolvedId || sandbox.id);
      } catch {
        // Best-effort cleanup
      }
      // Clean up ephemeral volume
      try {
        await client.deleteVolume(shellVolume.id);
      } catch {
        // Best-effort cleanup
      }
    }
  }

  async resume(
    sessionId: string,
    options: ResumeSandboxOptions,
  ): Promise<HermesSession> {
    const { onProgress } = options;
    const client = await this.getClient();
    const db = openSessionDb();

    const existing = dbGetSession(db, sessionId);
    if (!existing?.snapshotSlug && !existing?.volumeSlug) {
      throw new Error(
        'No resume snapshot or volume available for this session',
      );
    }

    // Check region consistency — volumes/snapshots must stay in the same region
    const currentRegion = await this.resolveRegion();
    if (existing.region && existing.region !== currentRegion) {
      log.warn(
        { sessionRegion: existing.region, currentRegion },
        'Session region differs from current config region. Using session region.',
      );
    }
    const region = existing.region ?? currentRegion;

    // 1. Determine the root volume to boot from.
    let bootVolumeSlug: string;
    let createdNewVolume = false;

    if (existing.snapshotSlug) {
      onProgress?.('Creating volume from snapshot');
      const resumeVolumeSlug = denoSlug('hr', existing.name);
      const resumeVolume = await client.createVolume({
        slug: resumeVolumeSlug,
        region,
        from: existing.snapshotSlug,
        capacity: '10GiB',
      });
      bootVolumeSlug = resumeVolume.slug;
      createdNewVolume = true;
    } else {
      bootVolumeSlug = existing.volumeSlug as string;
      log.info(
        { volumeSlug: bootVolumeSlug },
        'No resume snapshot — booting directly from session volume',
      );
    }

    // 2. Boot new sandbox
    onProgress?.('Booting sandbox');
    let sandbox: ResolvedSandbox;
    try {
      sandbox = await client.createSandbox({
        region: region as 'ord' | 'ams',
        root: bootVolumeSlug,
        timeout: '30m',
        memory: '2GiB',
        labels: {
          'hermes.managed': 'true',
          'hermes.name': existing.name,
          'hermes.agent': existing.agent,
          'hermes.repo': existing.repo,
        },
      });
    } catch (err) {
      if (createdNewVolume) {
        try {
          await client.deleteVolume(bootVolumeSlug);
        } catch (delErr) {
          log.debug(
            { err: delErr },
            'Failed to clean up volume after sandbox creation failure',
          );
        }
      }

      const message = (err as { message?: string })?.message ?? String(err);
      if (isConcurrencyLimitError(message)) {
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

    try {
      // 3. Inject fresh credentials
      onProgress?.('Setting up credentials');
      await injectCredentials(sandbox);

      // 4. Start agent with continue flag
      const agent = existing.agent as AgentType;
      const model = options.model ?? existing.model;
      const isInteractive =
        options.mode === 'interactive' || options.mode === 'shell';

      onProgress?.('Starting agent');
      const agentCmd = buildAgentCommand({
        agent,
        mode: isInteractive ? 'interactive' : 'detached',
        model,
        agentArgs: options.agentArgs,
        continue: true,
        prompt: isInteractive ? undefined : options.prompt,
      });

      if (isInteractive) {
        // Start agent inside a detached tmux session (caller attaches via SSH)
        await sandboxExec(
          sandbox,
          `tmux new-session -d -s ${TMUX_SESSION} -c /work/app ${shellEscape(agentCmd)}`,
        );
      } else {
        // Detached: run agent in background
        await sandboxExec(
          sandbox,
          `cd /work/app && nohup ${agentCmd} > /work/agent.log 2>&1 &`,
        );
      }
    } finally {
      await sandbox.close();
    }

    // 5. Update SQLite
    const resumeSessionId = sandbox.resolvedId || sandbox.id;
    if (!resumeSessionId) {
      throw new Error(
        'Cannot persist resumed session: sandbox has no resolvedId or id',
      );
    }

    const newSession: HermesSession = {
      id: resumeSessionId,
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
      volumeSlug: bootVolumeSlug,
      resumedFrom: sessionId,
    };
    upsertSession(db, newSession);

    return newSession;
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
    const session = dbGetSession(db, sessionId);

    // Sync with Deno API: if the session looks running locally but the
    // sandbox no longer exists in the API, mark it as exited.  This mirrors
    // the reconciliation that list() performs and ensures callers polling
    // get() (e.g. SessionDetail) see up-to-date status.
    if (session?.status === 'running') {
      try {
        const client = await this.getClient();
        const runningSandboxes = await client.listSandboxes({
          'hermes.managed': 'true',
        });
        const runningIds = new Set(runningSandboxes.map((s) => s.id));
        if (!runningIds.has(session.id)) {
          updateSessionStatus(db, session.id, 'exited');
          session.status = 'exited';
        }
      } catch (err) {
        log.debug({ err }, 'Failed to sync cloud session status in get()');
      }
    }

    return session;
  }

  async remove(sessionId: string): Promise<void> {
    const db = openSessionDb();
    const session = dbGetSession(db, sessionId);

    // Best-effort cleanup of cloud resources.  Always remove the local
    // session record afterwards — cloud resources have TTLs and can be
    // cleaned up manually if individual deletes fail.
    try {
      const client = await this.getClient();

      // Kill sandbox if running
      try {
        await client.killSandbox(sessionId);
      } catch (err) {
        log.debug({ err, sessionId }, 'Failed to kill sandbox during remove');
      }

      // Delete snapshot BEFORE volume (snapshots depend on their source
      // volume — the API rejects volume deletion while snapshots exist).
      if (session?.snapshotSlug) {
        try {
          await client.deleteSnapshot(session.snapshotSlug);
        } catch (err) {
          log.debug(
            { err, snapshotSlug: session.snapshotSlug },
            'Failed to delete snapshot during remove',
          );
        }
      }

      // Delete volume (may fail if another session's snapshot references
      // it — that's expected and fine).
      if (session?.volumeSlug) {
        try {
          await client.deleteVolume(session.volumeSlug);
        } catch (err) {
          log.debug(
            { err, volumeSlug: session.volumeSlug },
            'Failed to delete volume during remove',
          );
        }
      }
    } catch (err) {
      log.debug({ err, sessionId }, 'Failed to initialize cloud cleanup');
    }

    // Always remove from local DB regardless of cleanup results
    dbDeleteSession(db, sessionId);
  }

  async stop(sessionId: string): Promise<void> {
    const db = openSessionDb();
    const session = dbGetSession(db, sessionId);
    const client = await this.getClient();

    // 1. Kill sandbox first (detaches the volume so it can be snapshotted)
    await client.killSandbox(sessionId);
    updateSessionStatus(db, sessionId, 'stopped');

    // Wait for the platform to fully detach the volume from the dead sandbox.
    // Without this delay, snapshotVolume can hit a 500 error.
    await new Promise((resolve) => setTimeout(resolve, 5_000));

    // 2. Best-effort snapshot for resume.  The volume is still available
    //    for direct boot even if the snapshot fails, so this is non-fatal.
    if (session?.volumeSlug) {
      // Delete any previous snapshot to avoid orphaned resources.
      // denoSlug generates a new random suffix each time, so repeated
      // stop() calls would otherwise create unreferenced snapshots.
      if (session.snapshotSlug) {
        try {
          await client.deleteSnapshot(session.snapshotSlug);
        } catch (err) {
          log.debug(
            { err, snapshotSlug: session.snapshotSlug },
            'Failed to delete previous snapshot — continuing with new snapshot',
          );
        }
      }

      const snapshotSlug = denoSlug('hsnap', session.name);
      try {
        await client.snapshotVolume(session.volumeSlug, {
          slug: snapshotSlug,
        });
        updateSessionSnapshot(db, sessionId, snapshotSlug);
      } catch (err) {
        log.warn(
          { err, volumeSlug: session.volumeSlug },
          'Failed to snapshot volume after stop — resume will boot from volume directly',
        );
      }
    }
  }

  // --------------------------------------------------------------------------
  // Interactive Access
  // --------------------------------------------------------------------------

  async attach(sessionId: string): Promise<void> {
    const token = await getDenoToken();
    if (!token) throw new Error('No Deno Deploy token available');

    // Look up session metadata so we can restart the agent if the tmux
    // session has died (e.g. user pressed ctrl+c in the agent).
    const db = openSessionDb();
    const session = dbGetSession(db, sessionId);
    const resumeCmd = session
      ? buildContinueCommand(session.agent, session.model)
      : undefined;

    const sandbox = await new DenoApiClient(token).connectSandbox(sessionId);
    try {
      // Reattach to the tmux session where the agent is running.
      // If the tmux session is gone, a new one is created running the
      // agent in continue mode so the user doesn't land in a bare shell.
      await sshIntoSandbox(sandbox, {
        tmux: true,
        tmuxResumeCommand: resumeCmd,
      });
    } finally {
      await sandbox.close();
    }
  }

  async shell(sessionId: string): Promise<void> {
    // Open a plain SSH shell (no tmux) for manual debugging
    const token = await getDenoToken();
    if (!token) throw new Error('No Deno Deploy token available');
    const sandbox = await new DenoApiClient(token).connectSandbox(sessionId);
    try {
      await sshIntoSandbox(sandbox);
    } finally {
      await sandbox.close();
    }
  }

  // --------------------------------------------------------------------------
  // Logs
  // --------------------------------------------------------------------------

  async getLogs(sessionId: string, tail?: number): Promise<string> {
    try {
      const token = await getDenoToken();
      if (!token) return '';
      const sandbox = await new DenoApiClient(token).connectSandbox(sessionId);
      try {
        const content = await sandbox.fs.readTextFile('/work/agent.log');
        if (tail) {
          const lines = content.split('\n');
          return lines.slice(-tail).join('\n');
        }
        return content;
      } finally {
        await sandbox.close();
      }
    } catch (err) {
      log.debug({ err }, 'Failed to read cloud sandbox logs');
      return '';
    }
  }

  streamLogs(sessionId: string): LogStream {
    const abortController = new AbortController();
    const { signal } = abortController;

    const stop = () => {
      abortController.abort();
    };

    async function* generateLines(): AsyncIterable<string> {
      // Resolve token and open a single sandbox connection for the
      // entire streaming session instead of reconnecting every poll.
      const token = await getDenoToken();
      if (!token) return;

      const sandbox = await new DenoApiClient(token).connectSandbox(sessionId);

      // Byte offset into the log file (tracks how far we have read).
      let byteOffset = 0;
      // Partial line buffer — incomplete trailing content from the
      // previous read that did not end with a newline.
      let partialLine = '';

      try {
        while (!signal.aborted) {
          try {
            const content = await sandbox.fs.readTextFile('/work/agent.log');

            // Only process bytes we have not seen yet.
            const newContent = content.substring(byteOffset);
            byteOffset = content.length;

            if (newContent) {
              const text = partialLine + newContent;
              const lines = text.split('\n');

              // The last element is either an empty string (content
              // ended with '\n') or a partial line still being written.
              // Keep it in the buffer for the next iteration.
              partialLine = lines.pop() ?? '';

              for (const line of lines) {
                if (line) yield line;
              }
            }
          } catch {
            // File might not exist yet or sandbox may be gone
          }

          // Poll every 2 seconds — bail early if aborted.
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
              return;
            }
            const timer = setTimeout(resolve, 2000);
            signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
        }

        // Flush any remaining partial line on shutdown.
        if (partialLine) {
          yield partialLine;
        }
      } finally {
        await sandbox.close();
      }
    }

    return { lines: generateLines(), stop };
  }
}
