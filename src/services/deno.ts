// ============================================================================
// Deno Deploy Token Management
// ============================================================================

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
 * Validate a Deno Deploy token by attempting an API call.
 * Uses the sandbox list endpoint since that's what we actually need
 * the token for, and it works with both personal (ddp_) and
 * organization (ddo_) tokens.
 * Returns true if the token is valid.
 */
export async function validateDenoToken(token: string): Promise<boolean> {
  const masked = token.length > 8 ? `${token.slice(0, 8)}...` : '***';
  try {
    const response = await fetch('https://console.deno.com/api/v2/sandboxes', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      log.info(
        { status: response.status, body, token: masked },
        'Deno Deploy token validation failed',
      );
      return false;
    }
    log.debug({ token: masked }, 'Deno Deploy token is valid');
    return true;
  } catch (err) {
    log.info({ err, token: masked }, 'Failed to validate Deno Deploy token');
    return false;
  }
}

/**
 * Ensure a valid Deno Deploy token is available.
 * Returns the token if found and valid, null otherwise.
 * Does NOT prompt -- callers should handle the missing token case
 * (e.g., by showing the CloudSetup TUI).
 */
export async function ensureDenoToken(): Promise<string | null> {
  const token = await getDenoToken();
  if (!token) {
    log.debug('No Deno Deploy token found in keyring');
    return null;
  }

  const valid = await validateDenoToken(token);
  if (!valid) {
    log.warn('Deno Deploy token in keyring is invalid or expired');
    return null;
  }

  return token;
}
