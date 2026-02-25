// ============================================================================
// Deno Deploy Token Management
// ============================================================================

import { Client } from '@deno/sandbox';

import {
  deleteHermesSecret,
  getHermesSecret,
  setHermesSecret,
} from './keyring';
import { log } from './logger';

const DENO_TOKEN_KEY = 'deno-deploy-token';

/**
 * Read the Deno Deploy token from the OS keyring.
 * Returns null if no token is stored.
 */
export async function getDenoToken(): Promise<string | null> {
  return getHermesSecret(DENO_TOKEN_KEY);
}

/**
 * Store a Deno Deploy token in the OS keyring.
 */
export async function setDenoToken(token: string): Promise<void> {
  await setHermesSecret(DENO_TOKEN_KEY, token);
  log.debug('Stored Deno Deploy token in keyring');
}

/**
 * Remove the Deno Deploy token from the OS keyring.
 */
export async function deleteDenoToken(): Promise<void> {
  await deleteHermesSecret(DENO_TOKEN_KEY);
  log.debug('Deleted Deno Deploy token from keyring');
}

/**
 * Result of a token validation attempt.
 * - 'valid':   API call succeeded — token is good.
 * - 'invalid': API returned 401/403 — token is bad or expired.
 * - 'error':   Transient/server error (5xx, network) — can't tell.
 */
export type TokenValidationResult = 'valid' | 'invalid' | 'error';

/**
 * Validate a Deno Deploy token by attempting an API call.
 * Uses the SDK's Client to list sandboxes since that's what we actually
 * need the token for, and it works with both personal (ddp_) and
 * organization (ddo_) tokens.
 *
 * Distinguishes between auth failures (invalid token) and transient
 * server errors (API down) so callers can decide how to handle each.
 */
export async function validateDenoToken(
  token: string,
): Promise<TokenValidationResult> {
  const masked = token.length > 8 ? `${token.slice(0, 8)}...` : '***';
  try {
    const client = new Client({ token });
    await client.sandboxes.list();
    log.debug({ token: masked }, 'Deno Deploy token is valid');
    return 'valid';
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 401 || status === 403) {
      log.info({ token: masked, status }, 'Deno Deploy token is invalid');
      return 'invalid';
    }
    // Server error, network issue, etc. — token might be fine
    log.info(
      { err, token: masked },
      'Could not validate Deno Deploy token (API error)',
    );
    return 'error';
  }
}

/**
 * Ensure a valid Deno Deploy token is available.
 * Returns the token if found and valid, null otherwise.
 * Does NOT prompt -- callers should handle the missing token case
 * (e.g., by showing the CloudSetup TUI).
 *
 * On transient API errors the token is assumed valid (it exists in the
 * keyring) so the app can proceed.  Actual auth failures will surface
 * later when the token is used.
 */
export async function ensureDenoToken(): Promise<string | null> {
  const token = await getDenoToken();
  if (!token) {
    log.debug('No Deno Deploy token found in keyring');
    return null;
  }

  const result = await validateDenoToken(token);
  if (result === 'invalid') {
    log.warn('Deno Deploy token in keyring is invalid or expired');
    return null;
  }
  if (result === 'error') {
    log.warn(
      'Could not verify Deno Deploy token (API unavailable) — assuming valid',
    );
  }

  return token;
}
