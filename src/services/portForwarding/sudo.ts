// ============================================================================
// Sudo Utilities — handle privilege escalation without corrupting the TUI
// ============================================================================

import { $ } from 'bun';
import { log } from '../logger.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Callback that the TUI provides to handle interactive sudo prompts.
 *
 * When called, the implementation should:
 * 1. Suspend the TUI (leave alternate screen, exit raw mode)
 * 2. Print `reason` so the user understands why sudo is needed
 * 3. Spawn `sudo -v` with `stdio: 'inherit'` so sudo gets the real terminal
 * 4. Resume the TUI after `sudo -v` completes
 *
 * Returns true if sudo credentials were successfully obtained.
 */
export type RequestSudoFn = (reason: string) => Promise<boolean>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether the current sudo credential cache is warm (no password needed).
 */
export async function hasSudoCredentials(): Promise<boolean> {
  const result = await $`sudo -n true`.quiet().nothrow();
  return result.exitCode === 0;
}

/**
 * Ensure sudo credentials are available, prompting the user if needed.
 *
 * If the credential cache is already warm, returns immediately.
 * Otherwise, calls `requestSudo` to let the TUI handle the interactive prompt.
 *
 * If `requestSudo` is not provided (e.g. running outside the TUI), returns
 * false when credentials are needed — the caller should skip the sudo step.
 */
export async function ensureSudo(
  reason: string,
  requestSudo?: RequestSudoFn,
): Promise<boolean> {
  if (await hasSudoCredentials()) {
    log.debug('sudo credentials cached — no prompt needed');
    return true;
  }

  if (!requestSudo) {
    log.warn(
      'sudo credentials required but no interactive prompt available — skipping',
    );
    return false;
  }

  log.info({ reason }, 'Requesting sudo credentials from user');
  return requestSudo(reason);
}
