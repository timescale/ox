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
 * Ensure the local terminal's line discipline is in cooked mode with
 * standard output processing (in particular `onlcr` — translate `\n` to
 * `\r\n`).
 *
 * TUI libraries put the terminal into raw mode which disables `onlcr`.
 * If a previous hermes session crashed or didn't fully clean up, the
 * terminal can be left in this state.  Call this before spawning any
 * interactive subprocess whose output assumes normal newline handling.
 */
export function ensureSaneTerminal(): void {
  try {
    Bun.spawnSync(['stty', 'sane'], {
      stdin: 'inherit',
      stdout: 'ignore',
      stderr: 'ignore',
    });
  } catch {
    // Best-effort: if stty isn't available, continue anyway
  }
}

export interface SubprocessScreenOptions {
  /**
   * Use the alternate screen buffer to isolate subprocess output from the
   * user's main scrollback. Set to true when launching a subprocess from
   * within a TUI that will be restored afterward.
   */
  alternateScreen?: boolean;
  /**
   * Enable mouse tracking escape sequences. Only needed when the subprocess
   * is a TUI that consumes mouse events (e.g. tmux with mouse support).
   * Plain shells and most CLI tools do NOT need this — enabling it causes
   * garbage escape codes to appear when the user moves the mouse.
   */
  mouse?: boolean;
}

/** Default options used when entering a subprocess from the TUI. */
export const TUI_SUBPROCESS_OPTS: SubprocessScreenOptions = {
  alternateScreen: true,
};

/**
 * Prepare the terminal before handing it to a subprocess (docker attach,
 * docker exec, SSH, etc.).
 *
 * By default this is a no-op. Pass options to opt-in to alternate screen
 * and/or mouse tracking:
 *
 * - **From TUI:** use `{ alternateScreen: true }` so subprocess output
 *   doesn't pollute the TUI's scrollback.
 * - **From standalone CLI:** omit options (or pass `{}`) so progress
 *   messages remain visible in the user's terminal.
 * - **Mouse tracking:** only enable for subprocesses that actually
 *   consume mouse events (very rare for shell sessions).
 *
 * Pair with {@link resetTerminal} using the same options after the
 * subprocess exits.
 */
export function enterSubprocessScreen(
  options: SubprocessScreenOptions = {},
): void {
  const { alternateScreen = false, mouse = false } = options;
  const sequences: string[] = [];
  if (alternateScreen) {
    sequences.push('\x1b[?1049h'); // Enter alternate screen buffer
  }
  if (mouse) {
    sequences.push(
      '\x1b[?1000h', // Enable X11 mouse button tracking
      '\x1b[?1002h', // Enable button-event tracking (drag)
      '\x1b[?1003h', // Enable any-event tracking (all motion)
      '\x1b[?1006h', // Enable SGR extended mouse mode
    );
  }
  if (sequences.length > 0) {
    process.stdout.write(sequences.join(''));
  }
}

/**
 * Reset terminal to a clean state after a subprocess exits.
 *
 * Pass the same options used for {@link enterSubprocessScreen} so only the
 * features that were enabled get disabled. Also resets cursor visibility
 * and text attributes defensively, and refreshes the cached terminal
 * dimensions which may be stale after the subprocess.
 */
export function resetTerminal(options: SubprocessScreenOptions = {}): void {
  const { alternateScreen = false, mouse = false } = options;
  const sequences: string[] = [
    '\x1b[?25h', // Show cursor (if subprocess hid it)
    '\x1b[0m', // Reset text attributes (colors, bold, etc.)
  ];
  if (mouse) {
    sequences.push(
      '\x1b[?1003l', // Disable any-event mouse tracking
      '\x1b[?1002l', // Disable button-event mouse tracking
      '\x1b[?1000l', // Disable X11 mouse button tracking
      '\x1b[?1006l', // Disable SGR extended mouse mode
    );
  }
  if (alternateScreen) {
    sequences.push('\x1b[?1049l'); // Exit alternate screen buffer → restores main screen
  }
  process.stdout.write(sequences.join(''));

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

/** Escape a value for safe interpolation in a shell command string. */
export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
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
