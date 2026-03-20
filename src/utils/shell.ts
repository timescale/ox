// ============================================================================
// Shared CLI Utilities
// ============================================================================

import { toEnvArgs } from './docker';

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
 * Tracks whether this process has changed terminal state (alternate screen,
 * mouse tracking, raw mode, etc.) and therefore needs to reset it on exit.
 *
 * Set to `true` by {@link markTerminalDirty} (called from
 * {@link enterSubprocessScreen} and TUI startup).  Checked by
 * {@link resetTerminal} so that simple non-TUI commands (e.g.
 * `ox complete zsh`, `ox logs`) don't emit spurious escape sequences.
 */
let _terminalDirty = false;

/**
 * Mark the terminal as having been modified (alternate screen, mouse
 * tracking, raw mode, etc.) so that {@link resetTerminal} knows it
 * actually needs to emit cleanup sequences on exit.
 */
export function markTerminalDirty(): void {
  _terminalDirty = true;
}

/**
 * Ensure the local terminal's line discipline is in cooked mode with
 * standard output processing (in particular `onlcr` — translate `\n` to
 * `\r\n`).
 *
 * TUI libraries put the terminal into raw mode which disables `onlcr`.
 * If a previous ox session crashed or didn't fully clean up, the
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
  /** Enter the alternate screen buffer to isolate subprocess output. */
  alternateScreen?: boolean;
  /**
   * Enable mouse tracking so the subprocess's TUI can receive mouse
   * events.  Required when reattaching to a container running a TUI
   * (e.g. opencode) that only configures mouse tracking at startup.
   */
  mouse?: boolean;
}

/** Default options used when entering a subprocess from the TUI. */
export const TUI_SUBPROCESS_OPTS: SubprocessScreenOptions = {
  alternateScreen: true,
  mouse: true,
};

export const CLI_SUBPROCESS_OPTS: SubprocessScreenOptions = {
  alternateScreen: true,
  mouse: false,
};

/**
 * Prepare the terminal before handing it to a subprocess (docker attach,
 * docker exec, SSH, etc.).
 *
 * By default this is a no-op. Pass options to opt-in to alternate screen
 * and/or mouse tracking:
 *
 * - **From TUI:** use `TUI_SUBPROCESS_OPTS` so subprocess output doesn't
 *   pollute the TUI's scrollback and mouse events reach the subprocess.
 * - **From standalone CLI:** omit options (or pass `{}`) so progress
 *   messages remain visible in the user's terminal.
 *
 * Pair with {@link resetTerminal} after the subprocess exits.
 */
export function enterSubprocessScreen(
  options: SubprocessScreenOptions = {},
): void {
  const sequences: string[] = [];
  if (options.alternateScreen) {
    sequences.push('\x1b[?1049h'); // Enter alternate screen buffer
  }
  if (options.mouse) {
    sequences.push(
      '\x1b[?1000h', // Enable X11 mouse button tracking
      '\x1b[?1002h', // Enable button-event tracking (drag)
      '\x1b[?1003h', // Enable any-event tracking (all motion)
      '\x1b[?1006h', // Enable SGR extended mouse mode
    );
  }
  if (sequences.length > 0) {
    markTerminalDirty();
    process.stdout.write(sequences.join(''));
  }
}

/**
 * Reset terminal to a clean state.
 *
 * Disables mouse tracking, exits the alternate screen buffer, restores
 * cursor visibility, and resets text attributes.
 *
 * Only emits escape sequences when something in this process actually
 * modified terminal state (see {@link markTerminalDirty}).  This prevents
 * simple non-TUI commands like `ox complete zsh` and `ox logs` from
 * writing spurious sequences that confuse the shell or hide output.
 *
 * Sequences are written to **stderr** so they never pollute stdout.
 * This is important when stdout is captured (e.g. `source <(ox complete
 * zsh)`) — the terminal still interprets stderr escape sequences for
 * visual effect, but they don't end up in the captured output.
 *
 * Called after subprocess exits and as a last-chance cleanup on
 * process exit / crash to ensure the user's terminal isn't left in a
 * broken state.
 */
export function resetTerminal(): void {
  if (_terminalDirty) {
    _terminalDirty = false;
    process.stderr.write(
      [
        '\x1b[?1003l', // Disable any-event mouse tracking
        '\x1b[?1002l', // Disable button-event mouse tracking
        '\x1b[?1000l', // Disable X11 mouse button tracking
        '\x1b[?1006l', // Disable SGR extended mouse mode
        '\x1b[?1049l', // Exit alternate screen buffer → restores main screen
        '\x1b[?25h', // Show cursor (if subprocess hid it)
        '\x1b[0m', // Reset text attributes (colors, bold, etc.)
      ].join(''),
    );
  }

  // Force a fresh ioctl(TIOCGWINSZ) to update cached terminal dimensions.
  // While attached to a Docker subprocess, SIGWINCH signals go to Docker
  // (not our process), so process.stdout.columns/rows may be stale.
  // This also emits a 'resize' event if the dimensions changed, which
  // propagates to opentui and the useWindowSize hook.
  try {
    process.stdout._refreshSize();
  } catch {
    // Best-effort: may fail if stdout is already closing (e.g. in exit handler)
  }
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

const getSafeTerm: () => string = () => {
  const term = process.env.TERM ?? 'xterm-256color';
  const safeTerms = new Set([
    'xterm-256color',
    'xterm-color',
    'xterm',
    'screen-256color',
    'tmux-256color',
  ]);
  return safeTerms.has(term) ? term : 'xterm-256color';
};

export const colorEnv = (): string[] => {
  const items = [`TERM=${getSafeTerm()}`];
  if (process.env.COLORTERM) {
    items.push(`COLORTERM=${process.env.COLORTERM}`);
  }
  return items;
};

export const colorEnvArgs = toEnvArgs(colorEnv());
