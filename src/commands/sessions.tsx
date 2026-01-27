// ============================================================================
// Sessions Command - Unified TUI for hermes
// ============================================================================

import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { Command } from 'commander';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfigWizard, type ConfigWizardResult } from '../commands/config.tsx';
import { DockerSetup, type DockerSetupResult } from '../components/DockerSetup';
import { PromptScreen } from '../components/PromptScreen';
import { SessionDetail } from '../components/SessionDetail';
import { SessionsList } from '../components/SessionsList';
import { StartingScreen } from '../components/StartingScreen';
import { Toast, type ToastType } from '../components/Toast';
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
  getSession,
  type HermesSession,
  listHermesSessions,
  removeContainer,
  resumeSession,
  startContainer,
} from '../services/docker';
import { dockerIsRunning } from '../services/dockerSetup';
import { generateBranchName, getRepoInfo } from '../services/git';
import { log } from '../services/logger';
import { ensureGitignore, restoreConsole } from '../utils';

// ============================================================================
// Types
// ============================================================================

type SessionsView =
  | { type: 'init' } // Initial loading state
  | { type: 'docker' }
  | { type: 'config' }
  | { type: 'prompt' }
  | {
      type: 'starting';
      prompt: string;
      agent: AgentType;
      model: string;
      step: string;
    }
  | { type: 'detail'; session: HermesSession }
  | { type: 'list' };

interface SessionsResult {
  type: 'quit' | 'attach' | 'resume';
  containerId?: string;
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
  onComplete: (result: SessionsResult) => void;
}

function SessionsApp({
  initialView,
  initialPrompt,
  initialAgent,
  initialModel,
  serviceId,
  dbFork = true,
  onComplete,
}: SessionsAppProps) {
  const [view, setViewRaw] = useState<SessionsView>({ type: 'init' });
  const [config, setConfig] = useState<HermesConfig | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);

  // Wrapper to debug view changes
  const setView = useCallback(
    (newView: SessionsView | ((prev: SessionsView) => SessionsView)) => {
      setViewRaw((prev) => {
        const next = typeof newView === 'function' ? newView(prev) : newView;
        // Uncomment for debugging:
        // console.log(`View: ${prev.type} -> ${next.type}`);
        return next;
      });
    },
    [],
  );

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
    async (prompt: string, agent: AgentType, model: string) => {
      log.debug({ agent, model, prompt }, 'startSession received');
      setView({
        type: 'starting',
        prompt,
        agent,
        model,
        step: 'Getting repository info',
      });

      try {
        // Step 1: Get repo info
        const repoInfo = await getRepoInfo();

        // Step 2: Generate branch name
        setView((v) =>
          v.type === 'starting' ? { ...v, step: 'Generating branch name' } : v,
        );
        const branchName = await generateBranchName(prompt);

        // Step 3: Ensure .gitignore has .hermes/ entry
        await ensureGitignore();

        // Step 4: Fork database if configured
        const { serviceId: svcId, dbFork: doFork } = propsRef.current;
        const effectiveServiceId = svcId ?? configRef.current?.tigerServiceId;
        let forkResult: ForkResult | null = null;

        if (doFork && effectiveServiceId) {
          setView((v) =>
            v.type === 'starting' ? { ...v, step: 'Forking database' } : v,
          );
          forkResult = await forkDatabase(branchName, effectiveServiceId);
        }

        // Step 5: Ensure Docker image exists
        setView((v) =>
          v.type === 'starting' ? { ...v, step: 'Preparing Docker image' } : v,
        );
        await ensureDockerImage();

        // Step 6: Start container (always detached in TUI mode)
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

        // Step 7: Fetch the created session
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
        showToast(
          `Failed to start: ${err instanceof Error ? err.message : String(err)}`,
          'error',
        );
        setView({ type: 'prompt' });
      }
    },
    [showToast, setView],
  );

  // Initialize: check docker, then config, then go to target view
  // Only runs once on mount - we use refs to access current values without triggering re-runs
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally only runs on mount
  useEffect(() => {
    let cancelled = false;

    async function init() {
      // Step 1: Check if Docker is running
      const isDockerReady = await dockerIsRunning();
      if (cancelled) return;

      if (!isDockerReady) {
        setView({ type: 'docker' });
        return;
      }

      // Step 2: Check if config exists
      const existingConfig = await readConfig();
      if (cancelled) return;

      if (!existingConfig) {
        setView({ type: 'config' });
        return;
      }

      setConfig(existingConfig);

      // Step 3: Go to target view based on props at mount time
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
    }

    init();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    [onComplete, showToast, startSession, setView],
  );

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
    [onComplete, showToast, startSession, setView],
  );

  // Handle resume from session detail
  const handleResume = useCallback(
    async (
      containerId: string,
      mode: 'interactive' | 'detached',
      prompt?: string,
    ) => {
      if (mode === 'interactive') {
        onComplete({ type: 'resume', containerId });
        return;
      }

      if (!prompt) {
        throw new Error('Prompt is required for detached resume');
      }

      await resumeSession(containerId, { mode: 'detached', prompt });
      setView({ type: 'list' });
    },
    [onComplete, setView],
  );

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
    return (
      <>
        <PromptScreen
          defaultAgent={config?.agent ?? 'opencode'}
          defaultModel={config?.model}
          onSubmit={({ prompt, agent, model }) => {
            startSession(prompt, agent, model);
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
  if (view.type === 'starting') {
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
          onQuit={() => onComplete({ type: 'quit' })}
          onAttach={(containerId) =>
            onComplete({ type: 'attach', containerId })
          }
          onResume={handleResume}
          onSessionDeleted={() => setView({ type: 'list' })}
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

export async function runSessionsTui(
  options: RunSessionsTuiOptions = {},
): Promise<void> {
  const {
    initialView = 'list',
    initialPrompt,
    initialAgent,
    initialModel,
    serviceId,
    dbFork,
  } = options;

  let resolveResult: (result: SessionsResult) => void;
  const resultPromise = new Promise<SessionsResult>((resolve) => {
    resolveResult = resolve;
  });

  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  const root = createRoot(renderer);

  root.render(
    <SessionsApp
      initialView={initialView}
      initialPrompt={initialPrompt}
      initialAgent={initialAgent}
      initialModel={initialModel}
      serviceId={serviceId}
      dbFork={dbFork}
      onComplete={(result) => resolveResult(result)}
    />,
  );

  const result = await resultPromise;

  await renderer.idle();
  renderer.destroy();
  restoreConsole();

  // Handle attach action - needs to happen after TUI cleanup
  if (result.type === 'attach' && result.containerId) {
    await attachToContainer(result.containerId);
  }

  if (result.type === 'resume' && result.containerId) {
    try {
      await resumeSession(result.containerId, {
        mode: 'interactive',
      });
    } catch (err) {
      console.error(`Failed to resume: ${err}`);
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

export function toYaml(data: unknown, indent = 0): string {
  const prefix = '  '.repeat(indent);

  if (data === null || data === undefined) {
    return 'null';
  }

  if (typeof data === 'string') {
    if (data.includes('\n') || data.includes(':') || data.includes('#')) {
      const lines = data.split('\n');
      return `|-\n${lines.map((l) => `${prefix}  ${l}`).join('\n')}`;
    }
    return data;
  }

  if (typeof data === 'number' || typeof data === 'boolean') {
    return String(data);
  }

  if (Array.isArray(data)) {
    if (data.length === 0) return '[]';
    return data
      .map((item) => `${prefix}- ${toYaml(item, indent + 1).trimStart()}`)
      .join('\n');
  }

  if (typeof data === 'object') {
    const entries = Object.entries(data);
    if (entries.length === 0) return '{}';
    return entries
      .map(([key, value]) => {
        const yamlValue = toYaml(value, indent + 1);
        if (typeof value === 'object' && value !== null) {
          return `${prefix}${key}:\n${yamlValue}`;
        }
        return `${prefix}${key}: ${yamlValue}`;
      })
      .join('\n');
  }

  return String(data);
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
      console.log(toYaml(filteredSessions));
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
  .aliases(['session', 'status', 's'])
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
        console.error(`Failed to remove ${session.containerName}: ${err}`);
      }
    }
  });

sessionsCommand.addCommand(cleanCommand);
