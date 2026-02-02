// ============================================================================
// Sessions Command - Unified TUI for hermes
// ============================================================================

import { YAML } from 'bun';
import { Command } from 'commander';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfigWizard, type ConfigWizardResult } from '../commands/config.tsx';
import { CopyOnSelect } from '../components/CopyOnSelect';
import { DockerSetup, type DockerSetupResult } from '../components/DockerSetup';
import { ensureGhAuth } from '../components/GhAuth.tsx';
import { PromptScreen, type SubmitMode } from '../components/PromptScreen';
import { SessionDetail } from '../components/SessionDetail';
import { SessionsList } from '../components/SessionsList';
import { StartingScreen } from '../components/StartingScreen';
import { Toast, type ToastType } from '../components/Toast';
import { hasLocalGhAuth } from '../services/auth';
import {
  type AgentType,
  type HermesConfig,
  readConfig,
  writeConfig,
} from '../services/config';
import { type ForkResult, forkDatabase } from '../services/db';
import {
  attachToContainer,
  ensureDockerImage,
  ensureDockerSandbox,
  getSession,
  type HermesSession,
  listHermesSessions,
  removeContainer,
  resumeSession,
  startContainer,
  startShellContainer,
} from '../services/docker';
import {
  generateBranchName,
  getRepoInfo,
  type RepoInfo,
  tryGetRepoInfo,
} from '../services/git';
import { log } from '../services/logger';
import { createTui } from '../services/tui.ts';
import { ensureGitignore } from '../utils';

// ============================================================================
// Types
// ============================================================================

type SessionsView =
  | { type: 'init' } // Initial loading state
  | { type: 'docker' }
  | { type: 'config' }
  | { type: 'prompt'; resumeSession?: HermesSession }
  | {
      type: 'starting';
      prompt: string;
      agent: AgentType;
      model: string;
      step: string;
    }
  | {
      type: 'resuming';
      session: HermesSession;
      model: string;
      step: string;
    }
  | { type: 'detail'; session: HermesSession }
  | { type: 'list' };

interface SessionsResult {
  type: 'quit' | 'attach' | 'resume' | 'start-interactive' | 'shell';
  containerId?: string;
  // For resume: optional model override
  resumeModel?: string;
  // For shell: container ID if resuming, undefined if fresh shell
  resumeContainerId?: string;
  // For start-interactive: info needed to start the container
  startInfo?: {
    prompt: string;
    agent: AgentType;
    model: string;
    branchName: string;
    envVars?: Record<string, string>;
  };
}

interface ToastState {
  message: string;
  type: ToastType;
}

export interface RunSessionsTuiOptions {
  initialView?: 'prompt' | 'list' | 'starting';
  initialPrompt?: string;
  initialAgent?: AgentType;
  initialModel?: string;
  // Options for starting flow
  serviceId?: string;
  dbFork?: boolean;
}

// ============================================================================
// Unified Sessions App
// ============================================================================

interface SessionsAppProps {
  initialView: 'prompt' | 'list' | 'starting';
  initialPrompt?: string;
  initialAgent?: AgentType;
  initialModel?: string;
  serviceId?: string;
  dbFork?: boolean;
  /** Current repo info if in a git repo, null otherwise */
  currentRepoInfo: RepoInfo | null;
  onComplete: (result: SessionsResult) => void;
}

function SessionsApp({
  initialView,
  initialPrompt,
  initialAgent,
  initialModel,
  serviceId,
  dbFork = true,
  currentRepoInfo,
  onComplete,
}: SessionsAppProps) {
  const [view, setView] = useState<SessionsView>({ type: 'init' });
  const [config, setConfig] = useState<HermesConfig | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);

  // Use refs to store props/config that we need in async functions
  // This avoids dependency issues with useCallback/useEffect
  const configRef = useRef<HermesConfig | null>(null);
  const propsRef = useRef({
    initialView,
    initialPrompt,
    initialAgent,
    initialModel,
    serviceId,
    dbFork,
  });

  // Keep refs up to date
  configRef.current = config;
  propsRef.current = {
    initialView,
    initialPrompt,
    initialAgent,
    initialModel,
    serviceId,
    dbFork,
  };

  const showToast = useCallback((message: string, type: ToastType) => {
    setToast({ message, type });
  }, []);

  // Start session function - handles the full flow of starting an agent
  const startSession = useCallback(
    async (
      prompt: string,
      agent: AgentType,
      model: string,
      mode: SubmitMode = 'async',
    ) => {
      try {
        log.debug({ agent, model, prompt, mode }, 'startSession received');

        setView({
          type: 'starting',
          prompt,
          agent,
          model,
          step: 'Preparing sandbox environment',
        });
        await ensureDockerImage({
          onProgress: (progress) => {
            if (progress.type === 'pulling-cache') {
              setView((v) =>
                v.type === 'starting' ? { ...v, step: progress.message } : v,
              );
            } else if (progress.type === 'building') {
              setView((v) =>
                v.type === 'starting' ? { ...v, step: progress.message } : v,
              );
            }
          },
        });

        setView((v) =>
          v.type === 'starting' ? { ...v, step: 'Getting repository info' } : v,
        );
        const repoInfo = await getRepoInfo();

        setView((v) =>
          v.type === 'starting' ? { ...v, step: 'Generating branch name' } : v,
        );
        const branchName = await generateBranchName({
          prompt,
          agent,
          model,
        });

        await ensureGitignore();

        const { serviceId: svcId, dbFork: doFork } = propsRef.current;
        const effectiveServiceId = svcId ?? configRef.current?.tigerServiceId;
        let forkResult: ForkResult | null = null;
        if (doFork && effectiveServiceId) {
          setView((v) =>
            v.type === 'starting' ? { ...v, step: 'Forking database' } : v,
          );
          forkResult = await forkDatabase(branchName, effectiveServiceId);
        }

        if (!(await hasLocalGhAuth())) {
          throw new Error(
            'GitHub authentication not configured. Run `hermes config` to set up.',
          );
        }

        // For interactive mode, exit TUI and let the caller start the container
        if (mode === 'interactive') {
          onComplete({
            type: 'start-interactive',
            startInfo: {
              prompt,
              agent,
              model,
              branchName,
              envVars: forkResult?.envVars,
            },
          });
          return;
        }

        setView((v) =>
          v.type === 'starting'
            ? { ...v, step: 'Starting agent container' }
            : v,
        );
        await startContainer({
          branchName,
          prompt,
          repoInfo,
          agent,
          model,
          detach: true,
          interactive: false,
          envVars: forkResult?.envVars,
        });

        setView((v) =>
          v.type === 'starting' ? { ...v, step: 'Loading session' } : v,
        );
        const session = await getSession(`hermes-${branchName}`);

        if (session) {
          setView({ type: 'detail', session });
        } else {
          throw new Error('Failed to find created session');
        }
      } catch (err) {
        log.error({ err }, 'Failed to start session');
        showToast(
          `Failed to start: ${err instanceof Error ? err.message : String(err)}`,
          'error',
        );
        setView({ type: 'prompt' });
      }
    },
    [showToast, onComplete],
  );

  // Resume session function - handles the full flow of resuming an agent
  const resumeSessionFlow = useCallback(
    async (
      session: HermesSession,
      prompt: string,
      model: string,
      mode: SubmitMode = 'async',
    ) => {
      try {
        log.debug(
          { session: session.name, model, prompt, mode },
          'resumeSessionFlow received',
        );

        setView({
          type: 'resuming',
          session,
          model,
          step: 'Preparing to resume session',
        });

        // For interactive mode, exit TUI and let the caller resume the container
        if (mode === 'interactive') {
          setView((v) =>
            v.type === 'resuming'
              ? { ...v, step: 'Starting interactive session' }
              : v,
          );
          onComplete({
            type: 'resume',
            containerId: session.containerId,
            resumeModel: model,
          });
          return;
        }

        // Detached resume - create commit image and start new container
        setView((v) =>
          v.type === 'resuming'
            ? { ...v, step: 'Creating session snapshot' }
            : v,
        );

        // Small delay to ensure UI updates before the potentially slow operation
        await new Promise((resolve) => setTimeout(resolve, 50));

        setView((v) =>
          v.type === 'resuming'
            ? { ...v, step: 'Starting resumed container' }
            : v,
        );

        const newContainerId = await resumeSession(session.containerId, {
          mode: 'detached',
          prompt,
          model,
        });

        setView((v) =>
          v.type === 'resuming' ? { ...v, step: 'Loading session' } : v,
        );

        // Fetch the newly created session and show its detail
        const newSession = await getSession(newContainerId);
        if (newSession) {
          setView({ type: 'detail', session: newSession });
        } else {
          setView({ type: 'list' });
        }
      } catch (err) {
        log.error({ err }, 'Failed to resume session');
        showToast(
          `Failed to resume: ${err instanceof Error ? err.message : String(err)}`,
          'error',
        );
        setView({ type: 'prompt', resumeSession: session });
      }
    },
    [showToast, onComplete],
  );

  // Handle docker setup completion
  const handleDockerComplete = useCallback(
    async (result: DockerSetupResult) => {
      if (result.type === 'cancelled') {
        onComplete({ type: 'quit' });
        return;
      }
      if (result.type === 'error') {
        showToast(result.error ?? 'Docker setup failed', 'error');
        onComplete({ type: 'quit' });
        return;
      }

      // Docker is ready, now check config
      const existingConfig = await readConfig();
      if (!existingConfig) {
        setView({ type: 'config' });
        return;
      }

      setConfig(existingConfig);

      // Go to target view
      const {
        initialView: targetView,
        initialPrompt: prompt,
        initialAgent,
        initialModel,
      } = propsRef.current;

      if (targetView === 'starting' && prompt) {
        const agent = initialAgent ?? existingConfig.agent ?? 'opencode';
        const model = initialModel ?? existingConfig.model ?? '';
        startSession(prompt, agent, model);
      } else if (targetView === 'prompt') {
        setView({ type: 'prompt' });
      } else {
        setView({ type: 'list' });
      }
    },
    [onComplete, showToast, startSession],
  );

  useEffect(() => {
    if (view.type === 'init') {
      handleDockerComplete({ type: 'ready' });
    }
  }, [view.type, handleDockerComplete]);

  // Handle config wizard completion
  const handleConfigComplete = useCallback(
    async (result: ConfigWizardResult) => {
      if (result.type === 'cancelled') {
        onComplete({ type: 'quit' });
        return;
      }
      if (result.type === 'error') {
        showToast(result.message, 'error');
        onComplete({ type: 'quit' });
        return;
      }

      // Save config
      await ensureGitignore();
      await writeConfig(result.config);
      setConfig(result.config);

      // Go to target view
      const {
        initialView: targetView,
        initialPrompt: prompt,
        initialAgent,
        initialModel,
      } = propsRef.current;

      if (targetView === 'starting' && prompt) {
        const agent = initialAgent ?? result.config.agent ?? 'opencode';
        const model = initialModel ?? result.config.model ?? '';
        startSession(prompt, agent, model);
      } else if (targetView === 'prompt') {
        setView({ type: 'prompt' });
      } else {
        setView({ type: 'list' });
      }
    },
    [onComplete, showToast, startSession],
  );

  // Handle resume from session detail - navigate to PromptScreen with resume context
  const handleResume = useCallback((session: HermesSession) => {
    setView({ type: 'prompt', resumeSession: session });
  }, []);

  // ---- Initial Loading View ----
  if (view.type === 'init') {
    return (
      <>
        <StartingScreen step="Initializing" />
        {toast && (
          <Toast
            message={toast.message}
            type={toast.type}
            onDismiss={() => setToast(null)}
          />
        )}
      </>
    );
  }

  // ---- Docker Setup View ----
  if (view.type === 'docker') {
    return (
      <>
        <DockerSetup
          title="Docker Setup"
          onComplete={handleDockerComplete}
          showBack={false}
        />
        {toast && (
          <Toast
            message={toast.message}
            type={toast.type}
            onDismiss={() => setToast(null)}
          />
        )}
      </>
    );
  }

  // ---- Config Wizard View ----
  if (view.type === 'config') {
    return (
      <>
        <ConfigWizard onComplete={handleConfigComplete} />
        {toast && (
          <Toast
            message={toast.message}
            type={toast.type}
            onDismiss={() => setToast(null)}
          />
        )}
      </>
    );
  }

  // ---- Prompt Screen View ----
  if (view.type === 'prompt') {
    const { resumeSession: resumeSess } = view;
    return (
      <>
        <PromptScreen
          defaultAgent={
            resumeSess?.agent ?? initialAgent ?? config?.agent ?? 'opencode'
          }
          defaultModel={resumeSess?.model ?? initialModel ?? config?.model}
          resumeSession={resumeSess}
          onSubmit={({ prompt, agent, model, mode }) => {
            if (resumeSess) {
              // Resume flow - use resumeSessionFlow for loading screen
              resumeSessionFlow(resumeSess, prompt, model, mode);
            } else {
              // Fresh session
              startSession(prompt, agent, model, mode);
            }
          }}
          onShell={() => {
            if (resumeSess) {
              // Shell on resumed container
              onComplete({
                type: 'shell',
                resumeContainerId: resumeSess.containerId,
              });
            } else {
              // Fresh shell container
              onComplete({ type: 'shell' });
            }
          }}
          onCancel={() => onComplete({ type: 'quit' })}
          onViewSessions={() => setView({ type: 'list' })}
        />
        {toast && (
          <Toast
            message={toast.message}
            type={toast.type}
            onDismiss={() => setToast(null)}
          />
        )}
      </>
    );
  }

  // ---- Starting Screen View ----
  if (view.type === 'starting' || view.type === 'resuming') {
    return (
      <>
        <StartingScreen step={view.step} />
        {toast && (
          <Toast
            message={toast.message}
            type={toast.type}
            onDismiss={() => setToast(null)}
          />
        )}
      </>
    );
  }

  // ---- Session Detail View ----
  if (view.type === 'detail') {
    return (
      <>
        <SessionDetail
          session={view.session}
          onBack={() => setView({ type: 'list' })}
          onAttach={(containerId) =>
            onComplete({ type: 'attach', containerId })
          }
          onResume={handleResume}
          onSessionDeleted={() => setView({ type: 'list' })}
          onNewPrompt={() => setView({ type: 'prompt' })}
        />
        {toast && (
          <Toast
            message={toast.message}
            type={toast.type}
            onDismiss={() => setToast(null)}
          />
        )}
      </>
    );
  }

  // ---- Session List View ----
  return (
    <>
      <SessionsList
        onSelect={(session) => setView({ type: 'detail', session })}
        onQuit={() => onComplete({ type: 'quit' })}
        onNewTask={() => setView({ type: 'prompt' })}
        currentRepo={currentRepoInfo?.fullName}
      />
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onDismiss={() => setToast(null)}
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
}: RunSessionsTuiOptions = {}): Promise<void> {
  await ensureDockerSandbox();
  await ensureGhAuth();

  // Try to detect current repo (returns null if not in a git repo)
  const currentRepoInfo = await tryGetRepoInfo();

  let resolveResult: (result: SessionsResult) => void;
  const resultPromise = new Promise<SessionsResult>((resolve) => {
    resolveResult = resolve;
  });

  const { render, destroy } = await createTui();

  render(
    <CopyOnSelect>
      <SessionsApp
        initialView={initialView}
        initialPrompt={initialPrompt}
        initialAgent={initialAgent}
        initialModel={initialModel}
        serviceId={serviceId}
        dbFork={dbFork}
        currentRepoInfo={currentRepoInfo}
        onComplete={(result) => resolveResult(result)}
      />
    </CopyOnSelect>,
  );

  const result = await resultPromise;

  await destroy();

  // Handle attach action - needs to happen after TUI cleanup
  if (result.type === 'attach' && result.containerId) {
    await attachToContainer(result.containerId);
  }

  if (result.type === 'resume' && result.containerId) {
    try {
      await resumeSession(result.containerId, {
        mode: 'interactive',
        model: result.resumeModel,
      });
    } catch (err) {
      log.error({ err }, 'Failed to resume session');
      console.error(`Failed to resume: ${err}`);
    }
  }

  // Handle shell action - start bash shell in container
  if (result.type === 'shell') {
    try {
      if (result.resumeContainerId) {
        // Shell on resumed container
        await resumeSession(result.resumeContainerId, { mode: 'shell' });
      } else {
        // Fresh shell container
        const repoInfo = await getRepoInfo();
        await startShellContainer({ repoInfo });
      }
    } catch (err) {
      log.error({ err }, 'Failed to start shell');
      console.error(`Failed to start shell: ${err}`);
    }
  }

  // Handle start-interactive action - start container attached to terminal
  if (result.type === 'start-interactive' && result.startInfo) {
    const { prompt, agent, model, branchName, envVars } = result.startInfo;
    try {
      const repoInfo = await getRepoInfo();
      await startContainer({
        branchName,
        prompt,
        repoInfo,
        agent,
        model,
        detach: false,
        interactive: true,
        envVars,
      });
    } catch (err) {
      log.error({ err }, 'Failed to start session interactively');
      console.error(`Failed to start: ${err}`);
    }
  }
}

// ============================================================================
// CLI Output Functions
// ============================================================================

type OutputFormat = 'tui' | 'table' | 'json' | 'yaml';

interface SessionsOptions {
  output: OutputFormat;
  all: boolean;
}

export function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) {
    return `${diffDays}d ago`;
  }
  if (diffHours > 0) {
    return `${diffHours}h ago`;
  }
  if (diffMins > 0) {
    return `${diffMins}m ago`;
  }
  return 'just now';
}

export function getStatusDisplay(session: HermesSession): string {
  switch (session.status) {
    case 'running':
      return '\x1b[32mrunning\x1b[0m'; // green
    case 'exited':
      if (session.exitCode === 0) {
        return '\x1b[34mcomplete\x1b[0m'; // blue
      }
      return `\x1b[31mfailed (${session.exitCode})\x1b[0m`; // red
    case 'paused':
      return '\x1b[33mpaused\x1b[0m'; // yellow
    case 'restarting':
      return '\x1b[33mrestarting\x1b[0m'; // yellow
    case 'dead':
      return '\x1b[31mdead\x1b[0m'; // red
    case 'created':
      return '\x1b[36mcreated\x1b[0m'; // cyan
    default:
      return session.status;
  }
}

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 3)}...`;
}

function printTable(sessions: HermesSession[]): void {
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

async function sessionsAction(options: SessionsOptions): Promise<void> {
  // TUI mode is default
  if (options.output === 'tui') {
    await runSessionsTui({ initialView: 'list' });
    return;
  }

  // CLI output modes
  const sessions = await listHermesSessions();

  // Filter to only running sessions unless --all is specified
  const filteredSessions = options.all
    ? sessions
    : sessions.filter((s) => s.status === 'running');

  if (options.output === 'json') {
    console.log(JSON.stringify(filteredSessions, null, 2));
    return;
  }

  if (options.output === 'yaml') {
    if (filteredSessions.length === 0) {
      console.log('[]');
    } else {
      console.log(YAML.stringify(filteredSessions, null, 2));
    }
    return;
  }

  // Table output
  if (filteredSessions.length === 0) {
    if (options.all) {
      console.log('No hermes sessions found.');
    } else {
      console.log('No running hermes sessions. Use --all to see all sessions.');
    }
    return;
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
}

// ============================================================================
// Command Definition
// ============================================================================

export const sessionsCommand = new Command('sessions')
  .aliases(['list', 'session', 'status', 's'])
  .description('Show all hermes sessions and their status')
  .option(
    '-o, --output <format>',
    'Output format: tui, table, json, yaml',
    'tui',
  )
  .option(
    '-a, --all',
    'Show all sessions (including stopped) in table/json/yaml output',
  )
  .action(sessionsAction);

// Subcommand to remove/clean up sessions
const cleanCommand = new Command('clean')
  .description('Remove stopped hermes containers')
  .option('-a, --all', 'Remove all containers (including running)')
  .option('-f, --force', 'Skip confirmation')
  .action(async (options: { all: boolean; force: boolean }) => {
    const sessions = await listHermesSessions();

    const toRemove = options.all
      ? sessions
      : sessions.filter((s) => s.status !== 'running');

    if (toRemove.length === 0) {
      console.log('No containers to remove.');
      return;
    }

    console.log(`Found ${toRemove.length} container(s) to remove:`);
    for (const session of toRemove) {
      console.log(`  - ${session.containerName} (${session.status})`);
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
        return;
      }
    }

    console.log('');
    for (const session of toRemove) {
      try {
        await removeContainer(session.containerName);
        console.log(`Removed ${session.containerName}`);
      } catch (err) {
        log.error({ err }, `Failed to remove ${session.containerName}`);
        console.error(`Failed to remove ${session.containerName}: ${err}`);
      }
    }
  });

sessionsCommand.addCommand(cleanCommand);
