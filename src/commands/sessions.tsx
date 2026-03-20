// ============================================================================
// Sessions Command - Unified TUI for ox
// ============================================================================

import { useKeyboard } from '@opentui/react';
import { YAML } from 'bun';
import { Command } from 'commander';
import { useEffect } from 'react';
import { BackgroundTaskIndicator } from '../components/BackgroundTaskIndicator.tsx';
import { BuildErrorScreen } from '../components/BuildErrorScreen.tsx';
import { CloudSetup } from '../components/CloudSetup.tsx';
import { CopyOnSelect } from '../components/CopyOnSelect.tsx';
import { DockerSetup } from '../components/DockerSetup.tsx';
import { FeedbackModal } from '../components/FeedbackModal.tsx';
import { ensureGhAuth } from '../components/GhAuth.tsx';
import { GlobalToast } from '../components/GlobalToast.tsx';
import { PromptScreen } from '../components/PromptScreen.tsx';

import { ResourcesList } from '../components/ResourcesList.tsx';
import { SessionDetail } from '../components/SessionDetail.tsx';
import { SessionsList } from '../components/SessionsList.tsx';
import { SetupDb } from '../components/SetupDb.tsx';
import { ShutdownOverlay } from '../components/ShutdownOverlay.tsx';
import { StartingScreen } from '../components/StartingScreen.tsx';
import { AGENT_INFO_MAP } from '../services/agents.ts';
import { ensureClaudeAuth } from '../services/claude.ts';
import { ensureCodexAuth } from '../services/codex.ts';
import {
  CommandPaletteHost,
  useRegisterCommands,
} from '../services/commands.tsx';
import type { AgentType } from '../services/config.ts';
import { projectConfig, readConfig, userConfig } from '../services/config.ts';
import { credentialWatcher } from '../services/credentialWatcher.ts';
import { ensureDockerImage } from '../services/docker.ts';
import { tryGetRepoInfo } from '../services/git.ts';
import { log } from '../services/logger.ts';
import { ensureOpencodeAuth } from '../services/opencode.ts';
import {
  type AgentMode,
  getDefaultProvider,
  getProviderForSession,
  getSandboxProvider,
  listAllSessions,
  type OxSession,
  type SandboxProvider,
  type SandboxProviderType,
} from '../services/sandbox/index.ts';
import { formatRelativeTime } from '../services/sessionDisplay.ts';
import {
  abortShutdown,
  getShutdownSignal,
  resetShutdown,
} from '../services/shutdown.ts';
import { createTui } from '../services/tui.ts';
import {
  checkForUpdate,
  isCompiledBinary,
  performUpdate,
} from '../services/updater.ts';
import { useBackgroundTaskStore } from '../stores/backgroundTaskStore.ts';
import { useFeedbackStore } from '../stores/feedbackStore.ts';
import {
  flushPromptSettings,
  usePromptSettingsStore,
} from '../stores/promptSettingsStore.ts';
import { useReadinessStore } from '../stores/readinessStore.ts';
import { useRepoStore } from '../stores/repoStore.ts';
import { type SessionsResult, useRouterStore } from '../stores/routerStore.ts';
import { useSessionWorkflowStore } from '../stores/sessionWorkflowStore.ts';
import { useToastStore } from '../stores/toastStore.ts';
import { Deferred } from '../types/deferred.ts';
import { somePromise } from '../utils/promise.ts';
import {
  CLI_SUBPROCESS_OPTS,
  enterSubprocessScreen,
  resetTerminal,
} from '../utils/shell.ts';
import { ConfigWizard } from './config.tsx';

interface GhAuthRetryState {
  nextView: SessionsAppProps['initialView'];
  nextPrompt: string;
  nextAgent: AgentType;
  nextModel: string;
  nextMountDir?: string;
  nextAutoSubmitAgentMode?: AgentMode;
}

export async function handleNeedsGhAuth(
  result: SessionsResult,
): Promise<GhAuthRetryState | null> {
  if (result.type !== 'needs-gh-auth' || !result.ghAuthInfo) {
    return null;
  }

  const { agent, model, prompt } = result.ghAuthInfo;

  await ensureDockerImage({
    signal: getShutdownSignal(),
    onProgress: (progress) => {
      if (progress.type === 'pulling' || progress.type === 'pulling-cache') {
        const layers = progress.layers ?? [];
        const done = layers.filter(
          (l) => l.state === 'complete' || l.state === 'exists',
        ).length;
        const total = layers.length;
        const suffix = total > 0 ? ` (${done}/${total} layers)` : '';
        process.stdout.write(`\r${progress.message}${suffix}`);
      }
    },
  });
  await ensureGhAuth();

  return {
    nextView: 'starting',
    nextPrompt: prompt,
    nextAgent: agent,
    nextModel: model,
    nextMountDir: result.ghAuthInfo.mountDir,
    nextAutoSubmitAgentMode: result.ghAuthInfo.mode,
  };
}

export interface RunSessionsTuiOptions {
  initialView?: 'prompt' | 'list' | 'starting' | 'detail' | 'resources';
  initialPrompt?: string;
  initialAgent?: AgentType;
  initialModel?: string;
  /** Session to display when initialView is 'detail' */
  initialSession?: OxSession;
  // Options for starting flow
  serviceId?: string;
  dbFork?: boolean;
  /** Mount local directory instead of git clone */
  mountDir?: string;
  /** Whether running from a git repository (affects git/gh operations) */
  isGitRepo?: boolean;
  /** Sandbox provider override from CLI flag (overrides config) */
  sandboxProvider?: SandboxProviderType;
  /**
   * When set with initialView='starting', auto-submit the prompt with this agent mode.
   * Skips the prompt screen and goes directly to session creation.
   */
  autoSubmitAgentMode?: 'async' | 'interactive' | 'plan';
}

// ============================================================================
// Unified Sessions App
// ============================================================================

interface SessionsAppProps {
  initialView: 'prompt' | 'list' | 'starting' | 'detail' | 'resources';
  initialPrompt?: string;
  initialAgent?: AgentType;
  initialModel?: string;
  /** Session to display when initialView is 'detail' */
  initialSession?: OxSession;
  provider: SandboxProvider;
  /** Explicit CLI --provider flag (undefined = not set, use config) */
  cliSandboxProvider?: SandboxProviderType;
  serviceId?: string;
  dbFork?: boolean;
  /** Mount local directory instead of git clone */
  initialMountDir?: string;
  autoSubmitAgentMode?: 'async' | 'interactive' | 'plan';
}

function SessionsApp({
  initialView,
  initialPrompt,
  initialAgent,
  initialModel,
  initialSession,
  provider,
  cliSandboxProvider,
  serviceId,
  dbFork = true,
  initialMountDir,
  autoSubmitAgentMode,
}: SessionsAppProps) {
  const view = useRouterStore((s) => s.view);

  // Initialize workflow store with provider and props
  const workflowInit = useSessionWorkflowStore((s) => s.initialize);
  useEffect(() => {
    workflowInit({
      provider,
      cliSandboxProvider,
      serviceId,
      dbFork,
      initialMountDir,
      initialView,
      initialPrompt,
      initialAgent,
      initialModel,
      initialSession,
      autoSubmitAgentMode,
    });
  }, [
    workflowInit,
    provider,
    cliSandboxProvider,
    serviceId,
    dbFork,
    initialMountDir,
    initialView,
    initialPrompt,
    initialAgent,
    initialModel,
    initialSession,
    autoSubmitAgentMode,
  ]);

  // Graceful shutdown: Ctrl+C handler
  const pendingCount = useBackgroundTaskStore((s) => s.pendingCount);
  const shuttingDown = useBackgroundTaskStore((s) => s.shuttingDown);
  const setShuttingDown = useBackgroundTaskStore((s) => s.setShuttingDown);

  useKeyboard((key) => {
    if (key.name === 'c' && key.ctrl) {
      if (shuttingDown) {
        // Second Ctrl+C: force quit
        process.exit(1);
      }
      // Trigger a 1→0 transition on pendingCount, which triggers the
      // auto-quit effect below. Without this, pressing Ctrl+C when no
      // cleanup tasks are spawned would never reach count 0.
      useBackgroundTaskStore.getState().triggerQuietTransition();
      abortShutdown();
      setShuttingDown(true);
      key.stopPropagation();
      key.preventDefault();
    }
  });

  // Auto-quit when shutting down and all tasks complete
  useEffect(() => {
    if (shuttingDown && pendingCount === 0) {
      useRouterStore.getState().quit();
    }
  }, [shuttingDown, pendingCount]);

  // Background auto-update check (fire-and-forget on mount)
  useEffect(() => {
    if (!isCompiledBinary()) return;

    let cancelled = false;

    (async () => {
      try {
        const update = await checkForUpdate();
        if (cancelled || !update) return;

        useToastStore
          .getState()
          .show(`Updating to v${update.latestVersion}...`, 'info');

        await performUpdate(update, (progress) => {
          if (cancelled) return;
          if (progress.phase === 'complete') {
            useToastStore.getState().show(progress.message, 'success');
          }
        });
      } catch (err) {
        log.debug({ err }, 'Background auto-update failed');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Global Feedback Modal (via store) ----
  const showFeedbackModal = useFeedbackStore((s) => s.isOpen);
  const openFeedback = useFeedbackStore((s) => s.open);
  const closeFeedback = useFeedbackStore((s) => s.close);
  useRegisterCommands(
    () => [
      {
        id: 'system.feedback',
        title: 'Send feedback',
        description: 'Share feedback, report a bug, or request a feature',
        category: 'System',
        onSelect: openFeedback,
      },
    ],
    [],
  );

  // Init: navigate to target view immediately, then kick off readiness checks
  const navigateToTargetView = useSessionWorkflowStore(
    (s) => s.navigateToTargetView,
  );
  useEffect(() => {
    if (view.type !== 'init') return;

    (async () => {
      // Only run the full config wizard for brand-new users (no config at all).
      // Returning users who open a new project get straight to the prompt —
      // their user-level preferences are sufficient.
      if (!(await somePromise([projectConfig.exists(), userConfig.exists()]))) {
        useRouterStore.getState().goToConfig();
        return;
      }

      // Read merged config
      const existingConfig = await readConfig();
      useSessionWorkflowStore.getState().setConfig(existingConfig);

      // Initialize prompt settings store from config + CLI flags.
      await usePromptSettingsStore.getState().initialize(existingConfig, {
        agent: initialAgent as AgentType | undefined,
        model: initialModel,
        sandboxProvider: cliSandboxProvider,
      });

      // Navigate to target view immediately (prompt screen renders fast)
      navigateToTargetView(existingConfig, initialView, initialPrompt);

      // Kick off readiness checks in the background
      useReadinessStore.getState().runChecks();
    })();
  }, [
    view.type,
    navigateToTargetView,
    initialView,
    initialPrompt,
    initialAgent,
    initialModel,
    cliSandboxProvider,
  ]);

  // Watch readiness store: transition to docker setup if not installed
  const dockerInstalled = useReadinessStore((s) => s.dockerInstalled);
  useEffect(() => {
    if (dockerInstalled === 'not-installed') {
      useRouterStore.getState().goToDocker();
    }
  }, [dockerInstalled]);

  // ---- Route content ----
  const handleDockerComplete = useSessionWorkflowStore(
    (s) => s.handleDockerComplete,
  );
  const handleCloudSetupComplete = useSessionWorkflowStore(
    (s) => s.handleCloudSetupComplete,
  );
  const handleConfigComplete = useSessionWorkflowStore(
    (s) => s.handleConfigComplete,
  );
  const handleSetupDbComplete = useSessionWorkflowStore(
    (s) => s.handleSetupDbComplete,
  );
  const promptKey = useRouterStore((s) => s.promptKey);

  let content: React.ReactNode;
  switch (view.type) {
    case 'init':
      content = <StartingScreen step="Initializing" />;
      break;
    case 'docker':
      content = (
        <DockerSetup
          title="Docker Setup"
          onComplete={handleDockerComplete}
          showBack={false}
        />
      );
      break;
    case 'cloud-setup':
      content = (
        <CloudSetup
          title="Cloud Setup"
          onComplete={handleCloudSetupComplete}
          showBack
          onBack={() => useRouterStore.getState().goToPrompt()}
        />
      );
      break;
    case 'config':
      content = <ConfigWizard onComplete={handleConfigComplete} />;
      break;
    case 'setup-db':
      content = <SetupDb onComplete={handleSetupDbComplete} />;
      break;
    case 'prompt':
      content = (
        <PromptScreen key={`${view.resumeSession?.id ?? 'new'}-${promptKey}`} />
      );
      break;
    case 'starting':
    case 'resuming': {
      const hint =
        view.mode === 'interactive' || view.mode === 'plan'
          ? 'Hint: press ctrl+\\ to detach an interactive session'
          : undefined;
      const detail = view.type === 'starting' ? view.detail : undefined;
      content = (
        <StartingScreen step={view.step} subDetail={detail} hint={hint} />
      );
      break;
    }
    case 'starting-shell':
      content = <StartingScreen step={view.step} subDetail={view.detail} />;
      break;
    case 'build-error':
      content = (
        <BuildErrorScreen
          title={view.title}
          message={view.message}
          outputLines={view.outputLines}
        />
      );
      break;
    case 'detail':
      content = <SessionDetail />;
      break;
    case 'resources':
      content = <ResourcesList />;
      break;
    default:
      content = <SessionsList />;
      break;
  }

  return (
    <>
      {content}
      <GlobalToast />
      <BackgroundTaskIndicator />
      <ShutdownOverlay />
      <CommandPaletteHost />
      {showFeedbackModal && (
        <FeedbackModal
          onClose={closeFeedback}
          onSuccess={() =>
            useToastStore.getState().show('Feedback sent!', 'success')
          }
          onError={(msg) => useToastStore.getState().show(msg, 'error')}
        />
      )}
    </>
  );
}

// ============================================================================
// TUI Runner
// ============================================================================

export async function runSessionsTui({
  initialView = 'list',
  initialPrompt,
  initialAgent,
  initialModel,
  serviceId,
  dbFork,
  mountDir,
  isGitRepo,
  sandboxProvider,
  autoSubmitAgentMode,
}: RunSessionsTuiOptions = {}): Promise<void> {
  resetShutdown();
  const provider = sandboxProvider
    ? getSandboxProvider(sandboxProvider)
    : await getDefaultProvider();

  // Detect current repo and seed the store before rendering.
  // When `isGitRepo` is explicitly passed (e.g. from auth retry), honour it;
  // otherwise detect from the git remote.
  const currentRepoInfo = await tryGetRepoInfo();
  const effectiveIsGitRepo = isGitRepo ?? currentRepoInfo !== null;
  useRepoStore
    .getState()
    .initialize(effectiveIsGitRepo ? currentRepoInfo : null);

  // Loop: after interactive actions (attach, shell, etc.), return to the TUI
  // instead of exiting the process.
  let nextView: SessionsAppProps['initialView'] = initialView;
  let nextPrompt = initialPrompt;
  let nextAgent = initialAgent;
  let nextModel = initialModel;
  let nextSession: OxSession | undefined;
  let nextMountDir = mountDir;
  let nextAutoSubmitAgentMode = autoSubmitAgentMode;

  // Circuit breaker: prevent infinite auth retry loops.
  const MAX_AUTH_RETRIES = 3;
  let consecutiveAgentAuthRetries = 0;
  let consecutiveGhAuthRetries = 0;

  while (true) {
    const deferredResult = new Deferred<SessionsResult>();

    // Initialize router store before rendering — this registers the
    // onComplete callback so exit actions can resolve the promise.
    useRouterStore.getState().init((result) => deferredResult.resolve(result));

    const { renderer, render, destroy } = await createTui();

    // Provide the renderer to the workflow store so it can handle sudo
    // prompts by suspending/resuming the TUI.
    useSessionWorkflowStore.getState().setRenderer(renderer);

    render(
      <CopyOnSelect>
        <SessionsApp
          initialView={nextView}
          initialPrompt={nextPrompt}
          initialAgent={nextAgent}
          initialModel={nextModel}
          initialSession={nextSession}
          provider={provider}
          cliSandboxProvider={sandboxProvider}
          serviceId={serviceId}
          dbFork={dbFork}
          initialMountDir={nextMountDir}
          autoSubmitAgentMode={nextAutoSubmitAgentMode}
        />
      </CopyOnSelect>,
    );

    const result = await deferredResult.promise;

    useSessionWorkflowStore.getState().setRenderer(null);
    await destroy();

    // After handling the action, default to returning to the session list
    nextView = 'list';
    nextPrompt = undefined;
    nextAgent = undefined;
    nextModel = undefined;
    nextSession = undefined;
    nextMountDir = mountDir;
    nextAutoSubmitAgentMode = undefined;

    // Reset auth retry counters when we get a non-auth result,
    // indicating the session progressed past the auth phase.
    if (result.type !== 'needs-agent-auth') {
      consecutiveAgentAuthRetries = 0;
    }
    if (result.type !== 'needs-gh-auth') {
      consecutiveGhAuthRetries = 0;
    }

    // Quit exits the loop
    if (result.type === 'quit') {
      // Flush pending config writes so user preferences are not lost
      await flushPromptSettings();
      // Wait for background tasks before exiting
      const bgStore = useBackgroundTaskStore.getState();
      if (bgStore.pendingCount > 0) {
        await bgStore.waitForAll();
      }
      credentialWatcher.stop();
      break;
    }

    // Handle attach action - needs to happen after TUI cleanup
    if (result.type === 'attach' && result.sessionId) {
      const actionProvider = result.session
        ? getProviderForSession(result.session)
        : provider;
      try {
        await actionProvider.attach(result.sessionId, {
          agent: result.session?.agent,
        });
      } catch (err) {
        log.error(
          { err, sessionId: result.sessionId },
          'Failed to attach to session',
        );
        useToastStore
          .getState()
          .show(
            `SSH connection dropped: ${err instanceof Error ? err.message : String(err)}`,
            'error',
            5000,
          );
      }
      // Return to the session detail view after detaching (or on error)
      if (result.session) {
        nextView = 'detail';
        nextSession = result.session;
      }
      continue;
    }

    // Handle exec-shell action - open a bash shell in a running container
    if (result.type === 'exec-shell' && result.sessionId) {
      const actionProvider = result.session
        ? getProviderForSession(result.session)
        : provider;
      try {
        await actionProvider.shell(result.sessionId);
      } catch (err) {
        log.error({ err, sessionId: result.sessionId }, 'Failed to open shell');
        console.error(
          `Failed to open shell: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Return to the session detail view after exiting the shell (or on error)
      if (result.session) {
        nextView = 'detail';
        nextSession = result.session;
      }
      continue;
    }

    // Handle attach-session — attach to a newly created/resumed interactive session
    if (result.type === 'attach-session' && result.sessionId) {
      const actionProvider = getSandboxProvider(
        result.attachProvider ?? provider.type,
      );
      try {
        await actionProvider.attach(result.sessionId, {
          agent: result.session?.agent,
        });
      } catch (err) {
        log.error(
          { err, sessionId: result.sessionId },
          'Failed to attach to new session',
        );
        useToastStore
          .getState()
          .show(
            `SSH connection dropped: ${err instanceof Error ? err.message : String(err)}`,
            'error',
            5000,
          );
      }
      // Return to the session detail view after detaching (or on error)
      if (result.session) {
        nextView = 'detail';
        nextSession = result.session;
      }
      continue;
    }

    // Handle shell action - resume a stopped container and open a shell in it
    if (result.type === 'shell' && result.resumeSessionId) {
      enterSubprocessScreen(CLI_SUBPROCESS_OPTS);
      try {
        const actionProvider = getSandboxProvider(
          result.resumeProvider ?? provider.type,
        );
        const resumed = await actionProvider.resume(result.resumeSessionId, {
          mode: 'shell',
        });
        await actionProvider.shell(resumed.id);
      } catch (err) {
        log.error({ err }, 'Failed to start shell');
        console.error(`Failed to start shell: ${err}`);
      }
      resetTerminal();
      continue;
    }

    // Handle connect-shell action - shell was prepared in the TUI, now connect
    if (result.type === 'connect-shell' && result.shellSession) {
      enterSubprocessScreen(CLI_SUBPROCESS_OPTS);
      try {
        await result.shellSession.connect();
      } catch (err) {
        log.error({ err }, 'Failed to connect to shell');
        console.error(`Failed to connect to shell: ${err}`);
      }
      resetTerminal();
      // Enqueue cleanup as a background task so the TUI returns immediately
      const { cleanup } = result.shellSession;
      useBackgroundTaskStore
        .getState()
        .enqueue('Cleaning up shell sandbox', cleanup);
      continue;
    }

    // Handle needs-agent-auth action - run interactive login and retry
    if (result.type === 'needs-agent-auth' && result.authInfo) {
      consecutiveAgentAuthRetries++;
      if (consecutiveAgentAuthRetries > MAX_AUTH_RETRIES) {
        console.error(
          `\nError: Agent authentication failed after ${MAX_AUTH_RETRIES} attempts. Exiting.`,
        );
        process.exit(1);
      }

      const { agent, model, prompt } = result.authInfo;
      const agentName = AGENT_INFO_MAP[agent].name;

      // Auth flows run inside Docker containers, so ensure the image is
      // available before attempting login.
      try {
        await ensureDockerImage({
          signal: getShutdownSignal(),
          onProgress: (progress) => {
            if (
              progress.type === 'pulling' ||
              progress.type === 'pulling-cache'
            ) {
              const layers = progress.layers ?? [];
              const done = layers.filter(
                (l) => l.state === 'complete' || l.state === 'exists',
              ).length;
              const total = layers.length;
              const suffix = total > 0 ? ` (${done}/${total} layers)` : '';
              process.stdout.write(`\r${progress.message}${suffix}`);
            }
          },
        });
      } catch (err) {
        console.error(
          `\nFailed to prepare Docker sandbox: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }

      console.log(`\n${agentName} credentials are missing or expired.`);
      console.log(`Starting ${agentName} login...\n`);

      let authResult: boolean;
      switch (agent) {
        case 'claude':
          authResult = await ensureClaudeAuth(model);
          break;
        case 'codex':
          authResult = await ensureCodexAuth(model);
          break;
        default:
          authResult = await ensureOpencodeAuth(model);
          break;
      }

      if (!authResult) {
        console.error(`\nError: ${agentName} login failed`);
        process.exit(1);
      }

      console.log(`\n${agentName} login successful. Resuming...\n`);

      // Clear stale cached auth state so the next TUI iteration re-checks
      // fresh credentials instead of reusing the previous 'invalid' result.
      useReadinessStore.getState().resetAgentAuth(agent);

      // Set up the next iteration to continue where we left off
      nextView = 'starting';
      nextPrompt = prompt;
      nextAgent = agent;
      nextModel = model;
      nextMountDir = result.authInfo.mountDir;
      nextAutoSubmitAgentMode = result.authInfo.mode;
    }

    // Handle needs-gh-auth action - run interactive GitHub login and retry
    if (result.type === 'needs-gh-auth' && result.ghAuthInfo) {
      consecutiveGhAuthRetries++;
      if (consecutiveGhAuthRetries > MAX_AUTH_RETRIES) {
        console.error(
          `\nError: GitHub authentication failed after ${MAX_AUTH_RETRIES} attempts. Exiting.`,
        );
        process.exit(1);
      }

      try {
        console.log('\nGitHub credentials are missing or expired.');
        console.log('Starting GitHub login...\n');

        const retry = await handleNeedsGhAuth(result);
        if (!retry) continue;

        const { nextAgent: agent, nextModel: model } = retry;

        nextView = retry.nextView;
        nextPrompt = retry.nextPrompt;
        nextAgent = agent;
        nextModel = model;
        nextMountDir = retry.nextMountDir;
        nextAutoSubmitAgentMode = retry.nextAutoSubmitAgentMode;

        console.log('\nGitHub login successful. Resuming...\n');

        // Clear stale cached GH auth state for the next TUI iteration.
        useReadinessStore.getState().resetGhAuth();
      } catch (err) {
        console.error(
          `\nError: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    }
  }
}

// ============================================================================
// CLI Output Functions
// ============================================================================

export type OutputFormat = 'tui' | 'table' | 'json' | 'yaml';

export interface SessionsOptions {
  output: OutputFormat;
  all: boolean;
}

export function getStatusDisplay(session: OxSession): string {
  switch (session.status) {
    case 'running':
      return '\x1b[32mrunning\x1b[0m'; // green
    case 'exited':
      if (session.exitCode === 0) {
        return '\x1b[34mcomplete\x1b[0m'; // blue
      }
      if (session.exitCode == null) {
        return '\x1b[33mexited\x1b[0m'; // yellow
      }
      return `\x1b[31mfailed (${session.exitCode})\x1b[0m`; // red
    case 'stopped':
      return '\x1b[33mstopped\x1b[0m'; // yellow
    case 'unknown':
      return '\x1b[90munknown\x1b[0m'; // gray
    default:
      return session.status;
  }
}

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 3)}...`;
}

export function printTable(sessions: OxSession[]): void {
  const headers = ['NAME', 'STATUS', 'AGENT', 'REPO', 'CREATED', 'PROMPT'];
  const rows = sessions.map((s) => [
    s.name,
    getStatusDisplay(s),
    s.model ? `${s.agent}/${s.model}` : s.agent,
    s.repo,
    s.created ? formatRelativeTime(s.created) : 'unknown',
    truncate(s.prompt, 50),
  ]);

  // ANSI escape code pattern for stripping color codes
  // biome-ignore lint/suspicious/noControlCharactersInRegex: needed for ANSI codes
  const ansiPattern = /\x1b\[[0-9;]*m/g;

  // Calculate max widths (accounting for ANSI codes in status)
  const colWidths = headers.map((h, i) => {
    const dataWidths = rows.map((r) => {
      const cell = r[i];
      if (cell === undefined) return 0;
      const stripped = cell.replace(ansiPattern, '');
      return stripped.length;
    });
    const maxDataWidth = Math.max(0, ...dataWidths);
    return Math.max(h.length, maxDataWidth);
  });

  // Print header
  const headerLine = headers
    .map((h, i) => h.padEnd(colWidths[i] ?? 0))
    .join('  ');
  console.log(`\x1b[1m${headerLine}\x1b[0m`);

  // Print rows
  for (const row of rows) {
    const line = row
      .map((cell, i) => {
        const stripped = cell.replace(ansiPattern, '');
        const colWidth = colWidths[i] ?? 0;
        const padding = colWidth - stripped.length;
        return cell + ' '.repeat(Math.max(0, padding));
      })
      .join('  ');
    console.log(line);
  }
}

// ============================================================================
// Command Action
// ============================================================================

export async function sessionsAction(options: SessionsOptions): Promise<void> {
  // TUI mode is default
  if (options.output === 'tui') {
    await runSessionsTui({ initialView: 'list' });
    return;
  }

  // CLI output modes
  const sessions = await listAllSessions();

  // Filter to only running sessions unless --all is specified
  const filteredSessions = options.all
    ? sessions
    : sessions.filter((s) => s.status === 'running');

  if (options.output === 'json') {
    console.log(JSON.stringify(filteredSessions, null, 2));
    process.exit(0);
  }

  if (options.output === 'yaml') {
    if (filteredSessions.length === 0) {
      console.log('[]');
    } else {
      console.log(YAML.stringify(filteredSessions, null, 2));
    }
    process.exit(0);
  }

  // Table output
  if (filteredSessions.length === 0) {
    if (options.all) {
      console.log('No ox sessions found.');
    } else {
      console.log('No running ox sessions. Use --all to see all sessions.');
    }
    process.exit(0);
  }

  console.log('');
  printTable(filteredSessions);
  console.log('');

  if (!options.all) {
    const totalSessions = sessions.length;
    const runningSessions = filteredSessions.length;
    if (totalSessions > runningSessions) {
      console.log(
        `Showing ${runningSessions} running session(s). Use --all to see all ${totalSessions} session(s).`,
      );
      console.log('');
    }
  }
  process.exit(0);
}

// ============================================================================
// Command Definition
// ============================================================================

export const sessionsCommand = new Command('sessions')
  .aliases(['list', 'status', 'ps', 'ls'])
  .description('Show all ox sessions and their status')
  .option(
    '-o, --output <format>',
    'Output format: tui, table, json, yaml',
    'table',
  )
  .option(
    '-a, --all',
    'Show all sessions (including stopped) in table/json/yaml output',
  )
  .action(sessionsAction);

// Subcommand to remove/clean up sessions
export async function cleanAction(options: {
  all: boolean;
  force: boolean;
}): Promise<void> {
  const sessions = await listAllSessions();

  const toRemove = options.all
    ? sessions
    : sessions.filter((s) => s.status !== 'running');

  if (toRemove.length === 0) {
    console.log('No containers to remove.');
    process.exit(0);
  }

  const displayName = (s: OxSession) => s.containerName ?? s.id;

  console.log(`Found ${toRemove.length} container(s) to remove:`);
  for (const session of toRemove) {
    console.log(`  - ${displayName(session)} (${session.status})`);
  }

  if (!options.force) {
    const readline = await import('node:readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const answer = await new Promise<string>((resolve) => {
      rl.question('\nProceed? [y/N] ', resolve);
    });
    rl.close();

    if (answer.toLowerCase() !== 'y') {
      console.log('Cancelled.');
      process.exit(0);
    }
  }

  console.log('');
  for (const session of toRemove) {
    const name = displayName(session);
    try {
      const actionProvider = getProviderForSession(session);
      await actionProvider.remove(session.id);
      console.log(`Removed ${name}`);
    } catch (err) {
      log.error({ err }, `Failed to remove ${name}`);
      console.error(`Failed to remove ${name}: ${err}`);
    }
  }
  process.exit(0);
}
