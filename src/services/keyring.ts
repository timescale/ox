// ============================================================================
// Platform-aware keyring abstraction
//
// On macOS, uses the `security` CLI to store secrets with unrestricted access
// (no per-application confirmation prompts). On other platforms, falls back to
// @napi-rs/keyring which uses the OS credential store (e.g. libsecret on Linux,
// Windows Credential Manager).
// ============================================================================

import { isMac } from 'build-strap';
import { log } from './logger';

/**
 * Read a secret from the OS credential store.
 * Returns `null` if the entry does not exist or cannot be read.
 */
export async function getSecret(
  service: string,
  account: string,
): Promise<string | null> {
  if (isMac()) {
    return getSecretMac(service, account);
  }
  return getSecretKeyring(service, account);
}

/**
 * Write a secret to the OS credential store.
 * On macOS, creates entries with unrestricted access (no per-app confirmation).
 * Overwrites any existing entry with the same service/account pair.
 */
export async function setSecret(
  service: string,
  account: string,
  value: string,
): Promise<void> {
  if (isMac()) {
    return setSecretMac(service, account, value);
  }
  return setSecretKeyring(service, account, value);
}

/**
 * Delete a secret from the OS credential store.
 * Silently succeeds if the entry does not exist.
 */
export async function deleteSecret(
  service: string,
  account: string,
): Promise<void> {
  if (isMac()) {
    return deleteSecretMac(service, account);
  }
  return deleteSecretKeyring(service, account);
}

// ============================================================================
// Hermes-specific convenience wrappers (service is always 'hermes')
// ============================================================================

const HERMES_SERVICE = 'hermes';

/** Read a hermes-owned secret by account name. */
export async function getHermesSecret(account: string): Promise<string | null> {
  return getSecret(HERMES_SERVICE, account);
}

/** Write a hermes-owned secret by account name. */
export async function setHermesSecret(
  account: string,
  value: string,
): Promise<void> {
  return setSecret(HERMES_SERVICE, account, value);
}

/** Delete a hermes-owned secret by account name. */
export async function deleteHermesSecret(account: string): Promise<void> {
  return deleteSecret(HERMES_SERVICE, account);
}

// ============================================================================
// macOS implementation via `security` CLI
// ============================================================================

async function getSecretMac(
  service: string,
  account: string,
): Promise<string | null> {
  try {
    const result =
      await Bun.$`security find-generic-password -s ${service} -a ${account} -w`.quiet();
    const value = result.text().trim();
    return value || null;
  } catch (err) {
    log.debug(
      { err, service, account },
      'Failed to read secret from macOS keychain',
    );
    return null;
  }
}

async function setSecretMac(
  service: string,
  account: string,
  value: string,
): Promise<void> {
  try {
    // -U: update if exists (upsert)
    // -X: pass password as hex data (avoids exposing plaintext in process args)
    const hex = Buffer.from(value).toString('hex');
    await Bun.$`security add-generic-password -s ${service} -a ${account} -U -X ${hex}`.quiet();
  } catch (err) {
    log.debug(
      { err, service, account },
      'Failed to write secret to macOS keychain',
    );
    throw err;
  }
}

async function deleteSecretMac(
  service: string,
  account: string,
): Promise<void> {
  try {
    await Bun.$`security delete-generic-password -s ${service} -a ${account}`.quiet();
  } catch (err) {
    // `security` exits non-zero if the entry doesn't exist; treat as success
    log.debug(
      { err, service, account },
      'Failed to delete secret from macOS keychain (may not exist)',
    );
  }
}

// ============================================================================
// Fallback implementation via @napi-rs/keyring
// ============================================================================

async function getSecretKeyring(
  service: string,
  account: string,
): Promise<string | null> {
  try {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    const entry = new AsyncEntry(service, account);
    const value = await entry.getPassword();
    return value || null;
  } catch (err) {
    log.debug(
      { err, service, account },
      'Failed to read secret from OS keyring',
    );
    return null;
  }
}

async function setSecretKeyring(
  service: string,
  account: string,
  value: string,
): Promise<void> {
  try {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    const entry = new AsyncEntry(service, account);
    await entry.setPassword(value);
  } catch (err) {
    log.debug(
      { err, service, account },
      'Failed to write secret to OS keyring',
    );
    throw err;
  }
}

async function deleteSecretKeyring(
  service: string,
  account: string,
): Promise<void> {
  try {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    const entry = new AsyncEntry(service, account);
    await entry.deletePassword();
  } catch (err) {
    // Treat "not found" as success
    log.debug(
      { err, service, account },
      'Failed to delete secret from OS keyring (may not exist)',
    );
  }
}
