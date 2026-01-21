// ============================================================================
// Sessions Command - Shows all hermes sessions and their status
// ============================================================================

import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { Command } from 'commander';
import { useState } from 'react';
import { SessionDetail } from '../components/SessionDetail';
import { SessionsList } from '../components/SessionsList';
import {
  attachToContainer,
  type HermesSession,
  listHermesSessions,
  removeContainer,
} from '../services/docker';

// ============================================================================
// TUI Components
// ============================================================================

type SessionsView =
  | { type: 'list' }
  | { type: 'detail'; session: HermesSession };

interface SessionsResult {
  type: 'quit' | 'attach';
  containerId?: string;
}

interface SessionsAppProps {
  onComplete: (result: SessionsResult) => void;
}

function SessionsApp({ onComplete }: SessionsAppProps) {
  const [view, setView] = useState<SessionsView>({ type: 'list' });

  if (view.type === 'detail') {
    return (
      <SessionDetail
        session={view.session}
        onBack={() => setView({ type: 'list' })}
        onQuit={() => onComplete({ type: 'quit' })}
        onAttach={(containerId) => onComplete({ type: 'attach', containerId })}
        onSessionDeleted={() => setView({ type: 'list' })}
      />
    );
  }

  return (
    <SessionsList
      onSelect={(session) => setView({ type: 'detail', session })}
      onQuit={() => onComplete({ type: 'quit' })}
    />
  );
}

async function runSessionsTui(): Promise<void> {
  let resolveResult: (result: SessionsResult) => void;
  const resultPromise = new Promise<SessionsResult>((resolve) => {
    resolveResult = resolve;
  });

  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  const root = createRoot(renderer);

  root.render(<SessionsApp onComplete={(result) => resolveResult(result)} />);

  const result = await resultPromise;

  await renderer.idle();
  renderer.destroy();

  // Handle attach action - needs to happen after TUI cleanup
  if (result.type === 'attach' && result.containerId) {
    await attachToContainer(result.containerId);
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

function formatRelativeTime(isoDate: string): string {
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

function getStatusDisplay(session: HermesSession): string {
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

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 3)}...`;
}

function printTable(sessions: HermesSession[]): void {
  const headers = ['BRANCH', 'STATUS', 'AGENT', 'REPO', 'CREATED', 'PROMPT'];
  const rows = sessions.map((s) => [
    s.branch,
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

function toYaml(data: unknown, indent = 0): string {
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
    await runSessionsTui();
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
