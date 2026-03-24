// ============================================================================
// Ox CLI - Main Entry Point
// ============================================================================

import type { Command as CommandType } from 'commander';
import {
  completionCommand,
  handleCompletionRequest,
} from './commands/completion';
import { upgradeCommand } from './commands/upgrade';
import { createProgram } from './createProgram.ts';
import {
  shutdown as shutdownAnalytics,
  track,
  trackImmediate,
} from './services/analytics';
import { log } from './services/logger';
import { checkForUpdate, isCompiledBinary } from './services/updater';
import { printErr, resetTerminal } from './utils/shell.ts';

const program = createProgram();

// Background update check for non-TUI commands.
// The TUI handles its own auto-update; the upgrade command handles its own check.
// This uses commander's hook system so it works regardless of how the command was
// invoked (full name, alias, or abbreviation).
if (isCompiledBinary()) {
  const skipCommands = new Set([upgradeCommand, completionCommand]);

  for (const cmd of program.commands) {
    if (skipCommands.has(cmd)) continue;

    cmd.hook('preAction', () => {
      const updateCheck = checkForUpdate().catch(() => null);
      process.on('beforeExit', () => {
        updateCheck.then((update) => {
          if (update) {
            printErr(
              `\nA new version of ox is available: v${update.latestVersion} (current: v${update.currentVersion})`,
            );
            printErr("Run 'ox upgrade' to update.");
          }
        });
      });
    });
  }
}

// ============================================================================
// Analytics - wrap all commands with usage tracking
// ============================================================================

// Tracks the currently-executing command path for use in crash handlers.
// Set in the preAction hook below, read by uncaughtException/unhandledRejection handlers.
let currentCommandPath: string | undefined;

/**
 * Recursively wrap all commands with analytics tracking.
 *
 * Uses preAction instead of postAction because many commands call process.exit()
 * directly, which prevents postAction hooks from firing.
 *
 * The hook checks thisCommand === actionCommand to ensure only the leaf command
 * is tracked (commander fires preAction on every ancestor in the chain).
 */
function wrapCommandsWithAnalytics(cmd: CommandType): void {
  cmd.hook('preAction', (thisCommand, actionCommand) => {
    // Only track the leaf command that's actually executing, not ancestors
    if (thisCommand !== actionCommand) return;

    // Build the full command path from the chain of parents
    const parts: string[] = [];
    let current: CommandType | null = thisCommand;
    while (current) {
      parts.unshift(current.name());
      current = current.parent as CommandType | null;
    }

    const commandPath = parts.join(' ');
    currentCommandPath = commandPath;

    track('command_executed', {
      command_name: thisCommand.name(),
      command_path: commandPath,
    });
  });

  for (const child of cmd.commands) {
    wrapCommandsWithAnalytics(child as CommandType);
  }
}

wrapCommandsWithAnalytics(program);

// Last-chance terminal cleanup.  'exit' fires even on process.exit(),
// unlike 'beforeExit' (where @opentui registers its cleanup).  If the
// renderer's own cleanup didn't run — e.g. due to an unhandled exception
// triggering handleCrash → process.exit(1) — this ensures mouse tracking,
// alternate screen, and raw mode don't leak into the user's shell.
// All sequences are idempotent, so this is harmless on a clean exit.
process.on('exit', () => {
  resetTerminal();
  shutdownAnalytics().catch(() => {});
});

// ============================================================================
// Unhandled error tracking
// ============================================================================

// Guard against re-entrance (e.g., if trackImmediate itself throws)
let crashHandlerFired = false;

/**
 * Track an unhandled error and exit. Sends the error type, message, and stack
 * trace to analytics so we can diagnose crashes in our own code.
 */
async function handleCrash(source: string, err: unknown): Promise<void> {
  if (crashHandlerFired) return;
  crashHandlerFired = true;

  // Reset terminal state before printing — the TUI may have left the
  // terminal in raw mode / mouse-tracking / alternate screen, and the
  // @opentui `beforeExit` handler won't fire on an explicit process.exit().
  resetTerminal();

  // Print the error to stderr so the user sees what happened.
  // Registering an uncaughtException handler suppresses the default output,
  // so we need to restore it explicitly.
  const label =
    source === 'uncaughtException'
      ? 'Uncaught exception'
      : 'Unhandled promise rejection';
  console.error(`${label}:`, err);
  log.fatal({ err, source }, label);

  const isError = err instanceof Error;
  const errorType = isError ? err.name || err.constructor.name : typeof err;
  const errorMessage = isError ? err.message : String(err);
  const errorStack = isError ? err.stack : undefined;

  try {
    await Promise.race([
      trackImmediate('error_occurred', {
        error_type: errorType,
        error_message: errorMessage,
        error_stack: errorStack,
        error_source: source,
        command_path: currentCommandPath,
      }),
      // Timeout fallback: don't hang forever if flush stalls
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ]);
  } catch {
    // Swallow — must not prevent exit
  }

  process.exit(1);
}

process.on('uncaughtException', (err) => {
  handleCrash('uncaughtException', err);
});

process.on('unhandledRejection', (err) => {
  handleCrash('unhandledRejection', err);
});

// Handle `ox complete <shell>` before parseAsync for tab library
// This must happen after all commands are added so tab can introspect them
if (!handleCompletionRequest(program)) {
  program.parse();
}
