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
