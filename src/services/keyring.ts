// ============================================================================
// Platform-aware keyring abstraction
//
// On macOS, uses the `security` CLI to store secrets with unrestricted access
// (no per-application confirmation prompts). On other platforms, falls back to
// @napi-rs/keyring which uses the OS credential store (e.g. libsecret on Linux,
// Windows Credential Manager).
//
// When the OS keyring is unavailable (e.g. no D-Bus session on headless Linux),
// secrets are stored in plain-text files under the user config directory as a
// last-resort fallback. This ensures the application never fails to start
// because of keyring errors.
// ============================================================================

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isMac } from 'build-strap';
import { userConfigDir } from './config';
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
    // Delete any existing entry first — the `-U` flag on `add-generic-password`
    // is unreliable when the existing item has different access settings or was
    // created with different options (common macOS keychain quirk).
    await deleteSecretMac(service, account);
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
// File-based fallback for when the OS keyring is unavailable
//
// Stores secrets as plain-text files under <userConfigDir>/keyring/<service>/
// with the account name encoded as the filename. This is a last-resort
// fallback — the OS keyring is always preferred when available.
// ============================================================================

/**
 * Sanitize an account name into a safe filename.
 * Replaces path separators and other problematic characters with underscores.
 */
export function accountToFilename(account: string): string {
  return account.replace(/[/\\:*?"<>|]/g, '_');
}

function keyringFallbackDir(service: string): string {
  return join(userConfigDir(), 'keyring', service);
}

export function keyringFallbackPath(service: string, account: string): string {
  return join(keyringFallbackDir(service), accountToFilename(account));
}

export async function getSecretFile(
  service: string,
  account: string,
): Promise<string | null> {
  try {
    const f = Bun.file(keyringFallbackPath(service, account));
    if (!(await f.exists())) return null;
    const value = await f.text();
    return value || null;
  } catch (err) {
    log.debug(
      { err, service, account },
      'Failed to read secret from file fallback',
    );
    return null;
  }
}

export async function setSecretFile(
  service: string,
  account: string,
  value: string,
): Promise<void> {
  const dir = keyringFallbackDir(service);
  await mkdir(dir, { recursive: true });
  await Bun.write(keyringFallbackPath(service, account), value);
}

export async function deleteSecretFile(
  service: string,
  account: string,
): Promise<void> {
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(keyringFallbackPath(service, account));
  } catch {
    // File may not exist — treat as success
  }
}

// ============================================================================
// Non-macOS implementation: OS keyring via @napi-rs/keyring with file fallback
// ============================================================================

async function getSecretKeyring(
  service: string,
  account: string,
): Promise<string | null> {
  try {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    const entry = new AsyncEntry(service, account);
    const value = await entry.getPassword();
    if (value) return value;
  } catch (err) {
    log.debug(
      { err, service, account },
      'Failed to read secret from OS keyring',
    );
  }
  // Fall back to file-based storage
  return getSecretFile(service, account);
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
    return;
  } catch (err) {
    log.debug(
      { err, service, account },
      'Failed to write secret to OS keyring, falling back to file',
    );
  }
  // Fall back to file-based storage instead of throwing
  await setSecretFile(service, account, value);
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
  // Also clean up any file fallback entry
  await deleteSecretFile(service, account);
}
