// ============================================================================
// Sandbox Shell Execution - Unified utility for running commands in a sandbox
// ============================================================================

import type { Sandbox } from '@deno/sandbox';

import { shellEscape } from '../../utils.ts';
import { log } from '../logger.ts';

export interface SandboxExecOptions {
  sudo?: boolean;
  capture?: boolean;
  label?: string;
  cwd?: string;
}

/**
 * Run a shell command inside a Deno sandbox.
 *
 * - Non-zero exit code throws an Error with the command and exit code.
 * - When `capture` is true, stdout is collected and returned.
 * - When `capture` is false, stdout/stderr are piped (not inherited) and
 *   logged at debug level to prevent output from leaking onto the TUI.
 * - When `sudo` is true, the command is wrapped in `sudo bash -c '...'`
 *   so the entire command chain runs as root.
 * - The optional `label` is included in log messages for traceability.
 *
 * Uses `sandbox.spawn()` directly instead of `sandbox.sh` because the SDK
 * has a chaining bug: each builder method (sudo, stdout, stderr, noThrow)
 * creates a fresh clone that only retains the single property being set,
 * losing all previous chain state.
 */
export async function sandboxExec(
  sandbox: Sandbox,
  command: string,
  options?: SandboxExecOptions,
): Promise<string> {
  const { sudo, capture, label, cwd } = options ?? {};

  // Optionally prefix with cd
  let effectiveCommand = cwd ? `cd ${shellEscape(cwd)} && ${command}` : command;

  // Wrap in sudo if requested — uses `sudo bash -c '...'` so the
  // ENTIRE command chain runs as root.
  if (sudo) {
    effectiveCommand = `sudo bash -c ${shellEscape(effectiveCommand)}`;
  }

  if (label) {
    log.debug(
      { step: label, command: effectiveCommand.slice(0, 200) },
      'Running build step',
    );
  }

  const proc = await sandbox.spawn('bash', {
    args: ['-c', effectiveCommand],
    stdout: 'piped',
    stderr: 'piped',
    env: { BASH_ENV: '$HOME/.bashrc' },
  });
  const result = await proc.output();

  if (!result.status.success) {
    const stderr = result.stderrText ?? '';
    const stdout = result.stdoutText ?? '';
    const logFields: Record<string, unknown> = {
      command: effectiveCommand.slice(0, 200),
      exitCode: result.status.code,
      stderr,
    };
    if (label) {
      logFields.step = label;
      logFields.stdout = stdout;
      log.error(logFields, 'Snapshot build step failed');
      throw new Error(
        `Sandbox command failed at "${label}" (exit ${result.status.code}): ${stderr.slice(0, 500)}`,
      );
    }
    log.warn(logFields, 'Sandbox command failed');
    throw new Error(
      `Sandbox command failed (exit ${result.status.code}): ${stderr || effectiveCommand}`,
    );
  }

  if (capture) {
    return result.stdoutText ?? '';
  }

  // Log output at debug level when not capturing
  if (label) {
    const stdout = result.stdoutText ?? '';
    const stderr = result.stderrText ?? '';
    if (stdout || stderr) {
      log.debug(
        {
          step: label,
          stdout: stdout.slice(0, 500),
          stderr: stderr.slice(0, 500),
        },
        'Snapshot build step output',
      );
    }
  }

  return '';
}
