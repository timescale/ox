// ============================================================================
// Shared CLI Utilities
// ============================================================================

import { log } from './services/logger';

// ============================================================================
// Console Output Utilities
// ============================================================================

// Store original console methods before any TUI library can capture them
const originalConsole = global.console;

/**
 * Restore console.log/error/warn to their original implementations.
 * This works around a bug in @opentui where console methods are captured
 * by the TUI renderer and not properly restored after the renderer is destroyed.
 */
export function restoreConsole(): void {
  global.console = originalConsole;
}

/**
 * Print to stdout, bypassing any console capture.
 * Use this when you need guaranteed output after a TUI has been rendered.
 */
export function print(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

/**
 * Print to stderr, bypassing any console capture.
 * Use this when you need guaranteed error output after a TUI has been rendered.
 */
export function printErr(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

// ============================================================================
// Terminal State Utilities
// ============================================================================

/**
 * Enter the alternate screen buffer before handing the terminal to a
 * subprocess (docker attach, docker exec, etc.).
 *
 * This isolates all subprocess output from the main screen buffer, so
 * nothing leaks into the user's terminal scrollback. Pair with
 * {@link resetTerminal} after the subprocess exits.
 */
export function enterSubprocessScreen(): void {
  const sequences = [
    '\x1b[?1049h', // Enter alternate screen buffer
    '\x1b[?1000h', // Enable X11 mouse button tracking
    '\x1b[?1002h', // Enable button-event tracking (drag)
    '\x1b[?1003h', // Enable any-event tracking (all motion)
    '\x1b[?1006h', // Enable SGR extended mouse mode
  ].join('');
  process.stdout.write(sequences);
}

/**
 * Reset terminal to a clean state after a subprocess exits.
 *
 * Exits the alternate screen buffer (entered by {@link enterSubprocessScreen}),
 * restoring the main screen to its pre-subprocess state. Also resets cursor
 * visibility and text attributes defensively, and refreshes the cached
 * terminal dimensions which may be stale after the subprocess.
 */
export function resetTerminal(): void {
  const sequences = [
    '\x1b[?1003l', // Disable any-event mouse tracking
    '\x1b[?1002l', // Disable button-event mouse tracking
    '\x1b[?1000l', // Disable X11 mouse button tracking
    '\x1b[?1006l', // Disable SGR extended mouse mode
    '\x1b[?1049l', // Exit alternate screen buffer → restores main screen
    '\x1b[?25h', // Show cursor (if subprocess hid it)
    '\x1b[0m', // Reset text attributes (colors, bold, etc.)
  ].join('');
  process.stdout.write(sequences);

  // Force a fresh ioctl(TIOCGWINSZ) to update cached terminal dimensions.
  // While attached to a Docker subprocess, SIGWINCH signals go to Docker
  // (not our process), so process.stdout.columns/rows may be stale.
  // This also emits a 'resize' event if the dimensions changed, which
  // propagates to opentui and the useWindowSize hook.
  process.stdout._refreshSize();
}

// ============================================================================
// Shell Utilities
// ============================================================================

export interface ShellError extends Error {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

export function formatShellError(error: ShellError): Error {
  const stdout = error.stdout?.toString().trim();
  const stderr = error.stderr?.toString().trim();
  const details = [stderr && `stderr: ${stderr}`, stdout && `stdout: ${stdout}`]
    .filter(Boolean)
    .join('\n');

  return new Error(
    `Command failed (exit code ${error.exitCode})${details ? `\n${details}` : ''}`,
  );
}

export async function ensureGitignore(): Promise<void> {
  const gitignorePath = '.gitignore';
  const entry = '.hermes/';

  const file = Bun.file(gitignorePath);
  let content = '';

  if (await file.exists()) {
    content = await file.text();
  }

  // Check if .hermes/ is already in gitignore
  const lines = content.split('\n');
  const hasEntry = lines.some(
    (line) => line.trim() === '.hermes/' || line.trim() === '.hermes',
  );

  if (!hasEntry) {
    // Append entry, ensuring there's a newline before it if file doesn't end with one
    const newContent =
      content.endsWith('\n') || content === ''
        ? `${content}${entry}\n`
        : `${content}\n${entry}\n`;

    await Bun.write(gitignorePath, newContent);
    log.info('Added .hermes/ to .gitignore');
  }
}
