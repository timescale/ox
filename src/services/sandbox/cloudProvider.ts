// ============================================================================
// Cloud Sandbox Provider - Deno Deploy implementation using @deno/sandbox SDK
// ============================================================================

import type { Database } from 'bun:sqlite';
import type { Sandbox } from '@deno/sandbox';
import { runCloudSetupScreen } from '../../components/CloudSetup.tsx';
import {
  enterSubprocessScreen,
  resetTerminal,
  type SubprocessScreenOptions,
  shellEscape,
  TUI_SUBPROCESS_OPTS,
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
  getSession as dbGetSession,
  listSessions as dbListSessions,
  openSessionDb,
  softDeleteSession,
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
  ShellSession,
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

/** Check whether an error indicates the sandbox has been permanently terminated. */
export function isSandboxTerminatedError(err: unknown): boolean {
  if (
    err != null &&
    typeof err === 'object' &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string'
  ) {
    const code = (err as { code: string }).code;
    return (
      code === 'SANDBOX_ALREADY_TERMINATED' || code === 'SANDBOX_NOT_FOUND'
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('already been terminated') ||
    message.includes('SANDBOX_ALREADY_TERMINATED') ||
    message.includes('SANDBOX_NOT_FOUND')
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
// Sandbox Logging
// ============================================================================

/** Append a timestamped status line to the agent log inside the sandbox. */
async function logToSandbox(sandbox: Sandbox, message: string): Promise<void> {
  try {
    // Use shell append (>>) for atomicity — avoids racing with the agent
    // process which also appends to this file.
    await sandboxExec(
      sandbox,
      `echo ${shellEscape(message)} >> /work/agent.log`,
    );
  } catch {
    // Best-effort — don't crash provisioning if logging fails
  }
}

// ============================================================================
// Cloud Resource Cleanup
// ============================================================================

/**
 * Best-effort cleanup of cloud sandbox resources after a failure.
 * Closes the WebSocket, kills the sandbox (freeing the concurrency slot),
 * deletes the volume, and marks the session as exited in SQLite.
 */
async function cleanupSandboxResources(
  sandbox: Sandbox,
  client: DenoApiClient,
  sessionId: string,
  volumeSlug: string,
): Promise<void> {
  try {
    await sandbox.close();
  } catch (err) {
    log.debug({ err, sessionId }, 'Failed to close sandbox WebSocket');
  }
  try {
    await client.killSandbox(sessionId);
  } catch (err) {
    log.debug({ err, sessionId }, 'Failed to kill sandbox during cleanup');
  }
  try {
    await client.deleteVolume(volumeSlug);
  } catch (err) {
    log.debug(
      { err, sessionId, volumeSlug },
      'Failed to delete volume during cleanup',
    );
  }
  try {
    const db = openSessionDb();
    updateSessionStatus(db, sessionId, 'exited');
  } catch (err) {
    log.debug({ err, sessionId }, 'Failed to mark session as exited');
  }
}

// ============================================================================
// Provisioning Helpers
// ============================================================================

/**
 * Run provisioning steps 4-7 (credentials, repo clone, init script, agent
 * start) inside an already-booted sandbox. On success the WebSocket
 * connection is closed. On failure resources are torn down and the session
 * is marked as exited.
 */
async function provisionSandbox(
  sandbox: ResolvedSandbox,
  client: DenoApiClient,
  sessionId: string,
  volumeSlug: string,
  options: CreateSandboxOptions,
): Promise<void> {
  const { onProgress } = options;

  try {
    await logToSandbox(sandbox, 'Provisioning sandbox environment...');

    // Inject credential files
    onProgress?.('Setting up credentials');
    await logToSandbox(sandbox, 'Setting up credentials...');
    await injectCredentials(sandbox);

    // Clone repo and create branch
    if (options.repoInfo && options.isGitRepo !== false) {
      const fullName = options.repoInfo.fullName;
      onProgress?.('Cloning repository');
      await logToSandbox(sandbox, `Cloning repository ${fullName}...`);
      const branchRef = `hermes/${options.branchName}`;
      await sandboxExec(
        sandbox,
        `cd /work && gh auth setup-git && gh repo clone ${shellEscape(fullName)} app && cd app && git switch -c ${shellEscape(branchRef)}`,
      );
    } else {
      await sandboxExec(sandbox, 'mkdir -p /work/app');
    }

    // Run init script if configured
    if (options.initScript) {
      onProgress?.('Running init script');
      await logToSandbox(sandbox, 'Running init script...');
      await sandboxExec(sandbox, `cd /work/app && ${options.initScript}`);
    }

    // Start agent process
    onProgress?.('Starting agent');
    await logToSandbox(sandbox, 'Starting agent...');
    const agentCommand = buildAgentCommand({
      agent: options.agent,
      mode: options.interactive ? 'interactive' : 'detached',
      model: options.model,
      agentArgs: options.agentArgs,
      prompt: options.prompt,
    });
    if (options.interactive) {
      await sandboxExec(
        sandbox,
        `tmux new-session -d -s ${TMUX_SESSION} -c /work/app ${shellEscape(agentCommand)}`,
      );
    } else {
      await sandboxExec(
        sandbox,
        `cd /work/app && nohup ${agentCommand} >> /work/agent.log 2>&1 &`,
      );
    }

    // Close our WebSocket connection — the sandbox keeps running
    await sandbox.close();
  } catch (err) {
    // Setup failed — tear down cloud sandbox and volume so we don't
    // leak resources (especially important given the 5-sandbox limit).
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, sessionId }, `Sandbox provisioning failed: ${message}`);
    await logToSandbox(sandbox, `ERROR: Provisioning failed — ${message}`);
    await cleanupSandboxResources(sandbox, client, sessionId, volumeSlug);
    throw err;
  }
}

/**
 * Run provisioning steps for a resumed session (credentials + agent start).
 * On success the WebSocket connection is closed. On failure resources are
 * cleaned up and the session is marked as exited.
 */
async function provisionResume(
  sandbox: ResolvedSandbox,
  client: DenoApiClient,
  sessionId: string,
  volumeSlug: string,
  options: ResumeSandboxOptions & { agent: AgentType; existingModel?: string },
): Promise<void> {
  const { onProgress } = options;

  try {
    await logToSandbox(sandbox, 'Resuming session...');

    // Inject fresh credentials
    onProgress?.('Setting up credentials');
    await logToSandbox(sandbox, 'Setting up credentials...');
    await injectCredentials(sandbox);

    // Start agent with continue flag
    const model = options.model ?? options.existingModel;
    const isInteractive =
      options.mode === 'interactive' || options.mode === 'shell';

    onProgress?.('Starting agent');
    await logToSandbox(sandbox, 'Starting agent...');
    const agentCmd = buildAgentCommand({
      agent: options.agent,
      mode: isInteractive ? 'interactive' : 'detached',
      model,
      agentArgs: options.agentArgs,
      continue: true,
      prompt: isInteractive ? undefined : options.prompt,
    });

    if (isInteractive) {
      await sandboxExec(
        sandbox,
        `tmux new-session -d -s ${TMUX_SESSION} -c /work/app ${shellEscape(agentCmd)}`,
      );
    } else {
      await sandboxExec(
        sandbox,
        `cd /work/app && nohup ${agentCmd} >> /work/agent.log 2>&1 &`,
      );
    }

    // Close our WebSocket connection — the sandbox keeps running
    await sandbox.close();
  } catch (err) {
    // Resume failed — tear down cloud resources and mark session as exited
    const message = err instanceof Error ? err.message : String(err);
    await logToSandbox(
      sandbox,
      `ERROR: Resume provisioning failed — ${message}`,
    );
    await cleanupSandboxResources(sandbox, client, sessionId, volumeSlug);
    throw err;
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
    /**
     * Terminal screen options. Pass `TUI_SUBPROCESS_OPTS` when called
     * from the TUI (alternate screen isolation). Omit or pass `{}` when
     * called from standalone CLI commands like `hermes shell`.
     */
    screen?: SubprocessScreenOptions;
  },
): Promise<void> {
  const { command, tmux, tmuxResumeCommand, screen = {} } = options ?? {};
  const sshInfo = await sandbox.exposeSsh();
  enterSubprocessScreen(screen);
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
    // Detect dead connections: send a keepalive probe every 15 s and
    // disconnect after 3 missed responses (~45 s).  Without this, a
    // silently-dropped TCP connection (laptop sleep, Wi-Fi switch, NAT
    // timeout) causes SSH to hang indefinitely, freezing the user's
    // terminal with no way to regain control.
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
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
    resetTerminal(screen);
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
    if (options.mountDir) {
      log.warn(
        'Mount mode is not supported for cloud sandboxes — ignoring mountDir',
      );
    }

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

    // Record in SQLite immediately after boot (before provisioning)
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

    // 4-7. Provision sandbox (credentials, repo clone, init script, agent)
    if (options.interactive) {
      // Interactive sessions: caller needs SSH ready, so await provisioning
      await provisionSandbox(
        sandbox,
        client,
        sessionId,
        rootVolume.slug,
        options,
      );
    } else {
      // Non-interactive: fire-and-forget so we return to session details early
      provisionSandbox(
        sandbox,
        client,
        sessionId,
        rootVolume.slug,
        options,
      ).catch((err) =>
        log.error({ err, sessionId }, 'Background provisioning failed'),
      );
    }

    return session;
  }

  async createShell(options: CreateShellSandboxOptions): Promise<ShellSession> {
    const { onProgress } = options;
    const client = await this.getClient();
    const region = await this.resolveRegion();

    onProgress?.('Preparing sandbox image');
    const baseSnapshot = await this.ensureImage();

    // Create an ephemeral root volume from the base snapshot so installed
    // tools are visible (snapshot-direct boot uses a read-only overlay).
    onProgress?.('Creating volume');
    const shellVolume = await client.createVolume({
      slug: denoSlug('hsh'),
      region,
      capacity: '10GiB',
      from: baseSnapshot,
    });

    onProgress?.('Starting cloud sandbox');
    const sandbox = await client.createSandbox({
      region: region as 'ord' | 'ams',
      root: shellVolume.slug,
      timeout: '30m',
      memory: '2GiB',
      labels: { 'hermes.managed': 'true' },
    });

    // Inject credentials
    onProgress?.('Injecting credentials');
    await injectCredentials(sandbox);
    await sandboxExec(sandbox, 'mkdir -p /work');

    // Clone repo if available
    if (options.repoInfo && options.isGitRepo !== false) {
      onProgress?.('Cloning repository');
      const fullName = options.repoInfo.fullName;
      await sandboxExec(
        sandbox,
        `cd /work && gh auth setup-git && gh repo clone ${shellEscape(fullName)} app`,
      );
    }

    return {
      connect: async () => {
        onProgress?.('Connecting to sandbox');
        await sshIntoSandbox(sandbox);
      },
      cleanup: async () => {
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
        try {
          await client.deleteVolume(shellVolume.id);
        } catch {
          // Best-effort cleanup
        }
      },
    };
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

    // Record in SQLite immediately after boot (before provisioning)
    const resumeSessionId = sandbox.resolvedId || sandbox.id;
    if (!resumeSessionId) {
      throw new Error(
        'Cannot persist resumed session: sandbox has no resolvedId or id',
      );
    }

    const isInteractive =
      options.mode === 'interactive' || options.mode === 'shell';

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
      interactive: isInteractive,
      region,
      volumeSlug: bootVolumeSlug,
      resumedFrom: sessionId,
    };
    upsertSession(db, newSession);

    // 3-4. Provision resume (credentials + agent start)
    const resumeProvisionOptions = {
      ...options,
      agent: existing.agent as AgentType,
      existingModel: existing.model,
    };

    if (isInteractive) {
      // Interactive/shell: caller needs SSH ready, so await provisioning
      await provisionResume(
        sandbox,
        client,
        resumeSessionId,
        bootVolumeSlug,
        resumeProvisionOptions,
      );
    } else {
      // Detached: fire-and-forget so we return to session details early
      provisionResume(
        sandbox,
        client,
        resumeSessionId,
        bootVolumeSlug,
        resumeProvisionOptions,
      ).catch((err) =>
        log.error(
          { err, sessionId: resumeSessionId },
          'Background resume provisioning failed',
        ),
      );
    }

    return newSession;
  }

  // --------------------------------------------------------------------------
  // Session Management
  // --------------------------------------------------------------------------

  async list(): Promise<HermesSession[]> {
    const db = openSessionDb();

    // Return sessions from SQLite immediately for fast startup.
    // Fire off a background sync against the Deno API so that stale
    // "running" statuses get corrected on the next poll/refresh.
    const dbSessions = dbListSessions(db, { provider: 'cloud' });

    this.syncSessionStatuses(db, dbSessions).catch((err) => {
      log.debug({ err }, 'Failed to sync cloud session status');
    });

    return dbSessions;
  }

  /**
   * Background sync: reconcile locally-cached session statuses against
   * the Deno Deploy API. Sessions marked "running" locally that are no
   * longer running in the API are updated to "exited".
   */
  private async syncSessionStatuses(
    db: Database,
    sessions: HermesSession[],
  ): Promise<void> {
    const client = await this.getClient();
    const runningSandboxes = await client.listSandboxes({
      'hermes.managed': 'true',
    });

    const runningIds = new Set(
      runningSandboxes.filter((s) => s.status === 'running').map((s) => s.id),
    );

    for (const session of sessions) {
      if (session.status === 'running' && !runningIds.has(session.id)) {
        updateSessionStatus(db, session.id, 'exited');
        session.status = 'exited';
      }
    }
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
        const runningIds = new Set(
          runningSandboxes
            .filter((s) => s.status === 'running')
            .map((s) => s.id),
        );
        if (!runningIds.has(session.id)) {
          updateSessionStatus(db, session.id, 'exited');
          session.status = 'exited';
        }
      } catch (err) {
        log.debug(
          { err, sessionId },
          'Failed to sync cloud session status in get()',
        );
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

    // Soft-delete from local DB regardless of cleanup results
    softDeleteSession(db, sessionId);
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

    const db = openSessionDb();
    const session = dbGetSession(db, sessionId);
    const resumeCmd = session
      ? buildContinueCommand(session.agent, session.model)
      : undefined;

    // Try to connect with retries for transient errors
    const MAX_ATTEMPTS = 3;
    const RETRY_BASE_MS = 2_000;
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const sandbox = await new DenoApiClient(token).connectSandbox(
          sessionId,
        );
        try {
          await sshIntoSandbox(sandbox, {
            tmux: true,
            tmuxResumeCommand: resumeCmd,
            screen: TUI_SUBPROCESS_OPTS,
          });
          return; // Success — done
        } finally {
          await sandbox.close();
        }
      } catch (err) {
        lastError = err;

        // Sandbox is permanently gone — auto-resume with a new sandbox
        if (isSandboxTerminatedError(err)) {
          log.info(
            { sessionId },
            'Sandbox terminated — auto-resuming with new sandbox',
          );
          updateSessionStatus(db, sessionId, 'exited');

          if (!session) {
            throw new Error(
              'Sandbox has been terminated and session metadata is missing — cannot auto-resume.',
            );
          }

          console.log('Cloud sandbox has stopped. Starting a new one...');
          const resumed = await this.resume(sessionId, {
            mode: 'interactive',
          });
          // Attach to the freshly resumed sandbox
          const newSandbox = await new DenoApiClient(token).connectSandbox(
            resumed.id,
          );
          try {
            const newResumeCmd = buildContinueCommand(
              session.agent,
              session.model,
            );
            await sshIntoSandbox(newSandbox, {
              tmux: true,
              tmuxResumeCommand: newResumeCmd,
              screen: TUI_SUBPROCESS_OPTS,
            });
            return;
          } finally {
            await newSandbox.close();
          }
        }

        // Transient error — retry with backoff
        if (attempt < MAX_ATTEMPTS) {
          const delay = RETRY_BASE_MS * attempt;
          log.warn(
            { err, attempt, maxAttempts: MAX_ATTEMPTS, sessionId },
            'Failed to connect to sandbox for attach — retrying',
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    // All retries exhausted
    throw lastError;
  }

  async shell(sessionId: string): Promise<void> {
    const token = await getDenoToken();
    if (!token) throw new Error('No Deno Deploy token available');

    const MAX_ATTEMPTS = 3;
    const RETRY_BASE_MS = 2_000;
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const sandbox = await new DenoApiClient(token).connectSandbox(
          sessionId,
        );
        try {
          await sshIntoSandbox(sandbox, {
            screen: TUI_SUBPROCESS_OPTS,
          });
          return;
        } finally {
          await sandbox.close();
        }
      } catch (err) {
        lastError = err;

        if (isSandboxTerminatedError(err)) {
          const db = openSessionDb();
          updateSessionStatus(db, sessionId, 'exited');
          throw new Error(
            'Sandbox has been terminated. Resume the session to start a new sandbox.',
          );
        }

        if (attempt < MAX_ATTEMPTS) {
          const delay = RETRY_BASE_MS * attempt;
          log.warn(
            { err, attempt, maxAttempts: MAX_ATTEMPTS, sessionId },
            'Failed to connect to sandbox for shell — retrying',
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
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

      let sandbox: Sandbox | null = null;
      const MAX_CONNECT_ATTEMPTS = 5;
      const CONNECT_RETRY_BASE_MS = 2_000;

      for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt++) {
        if (signal.aborted) return;
        try {
          sandbox = await new DenoApiClient(token).connectSandbox(sessionId);
          break;
        } catch (err) {
          // Sandbox is permanently gone — no point retrying
          if (isSandboxTerminatedError(err)) {
            throw new Error('Sandbox has been terminated.');
          }
          log.warn(
            { err, attempt, maxAttempts: MAX_CONNECT_ATTEMPTS, sessionId },
            'Failed to connect to sandbox for log streaming',
          );
          if (attempt >= MAX_CONNECT_ATTEMPTS) {
            throw new Error(
              `Failed to connect to sandbox after ${MAX_CONNECT_ATTEMPTS} attempts: ${err}`,
            );
          }
          // Exponential back-off before retrying
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
              return;
            }
            const delay = CONNECT_RETRY_BASE_MS * attempt;
            const timer = setTimeout(resolve, delay);
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
      }
      if (!sandbox) return;

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
