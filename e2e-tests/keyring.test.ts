// ============================================================================
// Keyring tests that require the OS credential store (macOS Keychain / libsecret).
// Fast unit tests for accountToFilename and file-based fallback remain in
// src/services/keyring.test.ts.
// ============================================================================

import { afterAll, describe, expect, test } from 'bun:test';
import {
  deleteSecret,
  getOxSecret,
  getSecret,
  setOxSecret,
  setSecret,
} from '../src/services/keyring';

const TEST_SERVICE = 'ox-test';
const TEST_ACCOUNT = 'keyring-test-account';
const TEST_VALUE = `test-secret-${Date.now()}`;

const testAccounts = [
  TEST_ACCOUNT,
  `${TEST_ACCOUNT}-special`,
  `${TEST_ACCOUNT}-json`,
  `${TEST_ACCOUNT}-delete`,
  `${TEST_ACCOUNT}-ox`,
];

// Clean up all test entries after tests complete
afterAll(async () => {
  await Promise.allSettled([
    ...testAccounts.map((a) => deleteSecret(TEST_SERVICE, a)),
    ...testAccounts.map((a) => deleteSecret('ox', a)),
  ]);
});

// Skip in CI where the OS credential store is not available.
// (macOS keychain requires a GUI session; Linux requires D-Bus/libsecret)
describe.skipIf(!!process.env.CI)('keyring', () => {
  test('setSecret and getSecret round-trip', async () => {
    await setSecret(TEST_SERVICE, TEST_ACCOUNT, TEST_VALUE);
    const result = await getSecret(TEST_SERVICE, TEST_ACCOUNT);
    expect(result).toBe(TEST_VALUE);
  });

  test('setSecret overwrites existing value', async () => {
    const newValue = `updated-${Date.now()}`;
    await setSecret(TEST_SERVICE, TEST_ACCOUNT, newValue);
    const result = await getSecret(TEST_SERVICE, TEST_ACCOUNT);
    expect(result).toBe(newValue);
  });

  test('getSecret returns null for non-existent entry', async () => {
    const result = await getSecret(TEST_SERVICE, 'no-such-account');
    expect(result).toBeNull();
  });

  test('deleteSecret removes an entry', async () => {
    const account = `${TEST_ACCOUNT}-delete`;
    await setSecret(TEST_SERVICE, account, 'to-be-deleted');
    const before = await getSecret(TEST_SERVICE, account);
    expect(before).toBe('to-be-deleted');

    await deleteSecret(TEST_SERVICE, account);
    const after = await getSecret(TEST_SERVICE, account);
    expect(after).toBeNull();
  });

  test('deleteSecret is silent for non-existent entry', async () => {
    // Should not throw
    await deleteSecret(TEST_SERVICE, 'no-such-account-to-delete');
  });

  test('handles special characters in values', async () => {
    const specialValue = 'p@$$w0rd!with"quotes\'and\\backslashes&more<>{}';
    const account = `${TEST_ACCOUNT}-special`;
    await setSecret(TEST_SERVICE, account, specialValue);
    const result = await getSecret(TEST_SERVICE, account);
    expect(result).toBe(specialValue);
  });

  test('handles JSON string values', async () => {
    const jsonValue = JSON.stringify({
      token: 'abc123',
      expiresAt: Date.now() + 3600000,
    });
    const account = `${TEST_ACCOUNT}-json`;
    await setSecret(TEST_SERVICE, account, jsonValue);
    const result = await getSecret(TEST_SERVICE, account);
    expect(result).toBe(jsonValue);

    // verify it round-trips through JSON.parse
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result as string);
    expect(parsed.token).toBe('abc123');
  });
});

describe.skipIf(!!process.env.CI)('ox convenience wrappers', () => {
  const account = `${TEST_ACCOUNT}-ox`;

  test('setOxSecret and getOxSecret round-trip', async () => {
    await setOxSecret(account, 'ox-value');
    const result = await getOxSecret(account);
    expect(result).toBe('ox-value');
  });

  test('ox wrappers use the ox service', async () => {
    await setOxSecret(account, 'via-wrapper');
    // Reading with the raw function using 'ox' service should return the same value
    const result = await getSecret('ox', account);
    expect(result).toBe('via-wrapper');
  });
});
