// ============================================================================
// Session Command - Manage individual ox sessions
// ============================================================================

import { YAML } from 'bun';
import { Command, Option } from 'commander';
import { log } from '../services/logger.ts';
import type { OxSession } from '../services/sandbox';
import { resolveSession } from '../services/sandbox';
import { formatRelativeTime } from '../services/sessionDisplay.ts';
import { cleanAction, getStatusDisplay, sessionsAction } from './sessions.tsx';

// ============================================================================
// Helpers
// ============================================================================

function printSessionInfo(session: OxSession): void {
  const fields: [string, string | undefined][] = [
    ['Name', session.name],
    ['ID', session.id],
    ['Status', getStatusDisplay(session)],
    ['Agent', session.agent],
    ['Model', session.model],
    ['Provider', session.provider],
    ['Agent Mode', session.agentMode],
    ['Branch', session.branch],
    ['Repo', session.repo],
    [
      'Created',
      session.created
        ? `${session.created} (${formatRelativeTime(session.created)})`
        : undefined,
    ],
    ['Started', session.startedAt],
    ['Finished', session.finishedAt],
    ['Exit Code', session.exitCode?.toString()],
    ['Interactive', session.interactive ? 'yes' : 'no'],
    ['Exec Type', session.execType],
    ['Resumed From', session.resumedFrom],
    ['Mount Dir', session.mountDir],
    ['Region', session.region],
    ['Container', session.containerName],
    ['Volume', session.volumeSlug],
    ['Snapshot', session.snapshotSlug],
    ['Prompt', session.prompt],
  ];

  const maxLabel = Math.max(
    ...fields.filter(([, v]) => v != null).map(([k]) => k.length),
  );
  for (const [label, value] of fields) {
    if (value == null || value === '') continue;
    console.log(`${label.padEnd(maxLabel + 1)} ${value}`);
  }
}

// ============================================================================
// Subcommands
// ============================================================================

const rmCommand = new Command('rm')
  .aliases(['remove', 'delete'])
  .description('Remove a session')
  .argument('<id>', 'Session name or ID')
  .action(async (id: string) => {
    const resolved = await resolveSession(id);
    if (!resolved) {
      console.error(`Error: session not found: ${id}`);
      process.exit(1);
    }
    const { session, provider } = resolved;
    try {
      await provider.remove(session.id);
      console.error(`Removed session: ${session.name}`);
    } catch (err) {
      log.error({ err }, `Failed to remove session: ${session.name}`);
      console.error(
        `Error: failed to remove session: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  });

const stopCommand = new Command('stop')
  .description('Stop a running session')
  .argument('<id>', 'Session name or ID')
  .action(async (id: string) => {
    const resolved = await resolveSession(id);
    if (!resolved) {
      console.error(`Error: session not found: ${id}`);
      process.exit(1);
    }
    const { session, provider } = resolved;
    if (session.status !== 'running') {
      console.error(`Session ${session.name} is already ${session.status}.`);
      return;
    }
    try {
      await provider.stop(session.id);
      console.error(`Stopped session: ${session.name}`);
    } catch (err) {
      log.error({ err }, `Failed to stop session: ${session.name}`);
      console.error(
        `Error: failed to stop session: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  });

const attachCommand = new Command('attach')
  .description('Attach to a running session')
  .argument('<id>', 'Session name or ID')
  .action(async (id: string) => {
    const resolved = await resolveSession(id);
    if (!resolved) {
      console.error(`Error: session not found: ${id}`);
      process.exit(1);
    }
    const { session, provider } = resolved;
    if (session.status !== 'running') {
      console.error(
        `Error: cannot attach to session ${session.name} (status: ${session.status})`,
      );
      process.exit(1);
    }
    await provider.attach(session.id, { agent: session.agent });
  });

const psCommand = new Command('ps')
  .aliases(['list', 'ls'])
  .description('List all sessions')
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

const logsCommand = new Command('logs')
  .description('Print session logs')
  .argument('<id>', 'Session name or ID')
  .option('-f, --follow', 'Follow log output until session exits')
  .option('--tail <n>', 'Number of lines to show from the end')
  .action(async (id: string, options: { follow?: boolean; tail?: string }) => {
    const resolved = await resolveSession(id);
    if (!resolved) {
      console.error(`Error: session not found: ${id}`);
      process.exit(1);
    }
    const { session, provider } = resolved;

    if (options.follow) {
      const stream = provider.streamLogs(session.id);

      // Handle Ctrl+C gracefully
      process.on('SIGINT', () => {
        stream.stop();
        process.exit(0);
      });

      for await (const line of stream.lines) {
        console.log(line);
      }
    } else {
      const tail = options.tail ? Number.parseInt(options.tail, 10) : undefined;
      const logs = await provider.getLogs(session.id, tail);
      if (logs) {
        process.stdout.write(logs);
      }
    }
  });

const infoCommand = new Command('info')
  .description('Show detailed information about a session')
  .argument('<id>', 'Session name or ID')
  .addOption(
    new Option('-o, --output <format>', 'Output format: table, json, yaml')
      .choices(['table', 'json', 'yaml'])
      .default('table'),
  )
  .action(async (id: string, options: { output: string }) => {
    const resolved = await resolveSession(id);
    if (!resolved) {
      console.error(`Error: session not found: ${id}`);
      process.exit(1);
    }
    const { session } = resolved;

    switch (options.output) {
      case 'json':
        console.log(JSON.stringify(session, null, 2));
        break;
      case 'yaml':
        console.log(YAML.stringify(session, null, 2));
        break;
      default:
        printSessionInfo(session);
        break;
    }
  });

const sessionCleanCommand = new Command('clean')
  .description('Remove stopped ox containers')
  .option('-a, --all', 'Remove all containers (including running)')
  .option('-f, --force', 'Skip confirmation')
  .action(cleanAction);

// ============================================================================
// Parent Command
// ============================================================================

export const sessionCommand = new Command('session')
  .alias('container')
  .description('Manage ox sessions')
  .addCommand(rmCommand)
  .addCommand(stopCommand)
  .addCommand(attachCommand)
  .addCommand(psCommand)
  .addCommand(logsCommand)
  .addCommand(infoCommand)
  .addCommand(sessionCleanCommand);
