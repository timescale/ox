// ============================================================================
// Keyring unit tests (fast, no OS credential store required).
// OS keychain integration tests live in e2e-tests/keyring.test.ts.
// ============================================================================

import { afterAll, describe, expect, test } from 'bun:test';
import {
  accountToFilename,
  deleteSecretFile,
  getSecretFile,
  keyringFallbackPath,
  setSecretFile,
} from './keyring';

const TEST_SERVICE = 'ox-test';

const fileTestAccounts = [
  'file-test-basic',
  'file-test-overwrite',
  'file-test-delete',
  'file-test-special',
  'file-test-json',
  'opencode/auth.json',
];

// Clean up file-based test entries after tests complete
afterAll(async () => {
  await Promise.allSettled(
    fileTestAccounts.map((a) => deleteSecretFile(TEST_SERVICE, a)),
  );
});

describe('accountToFilename', () => {
  test('replaces forward slashes', () => {
    expect(accountToFilename('opencode/auth.json')).toBe('opencode_auth.json');
  });

  test('replaces backslashes', () => {
    expect(accountToFilename('foo\\bar')).toBe('foo_bar');
  });

  test('replaces multiple special characters', () => {
    expect(accountToFilename('a/b:c*d?"e<f>g|h')).toBe('a_b_c_d__e_f_g_h');
  });

  test('leaves safe names unchanged', () => {
    expect(accountToFilename('simple-account_name.txt')).toBe(
      'simple-account_name.txt',
    );
  });
});

describe('file-based secret fallback', () => {
  test('setSecretFile and getSecretFile round-trip', async () => {
    await setSecretFile(TEST_SERVICE, 'file-test-basic', 'file-value');
    const result = await getSecretFile(TEST_SERVICE, 'file-test-basic');
    expect(result).toBe('file-value');
  });

  test('setSecretFile overwrites existing value', async () => {
    await setSecretFile(TEST_SERVICE, 'file-test-overwrite', 'original');
    await setSecretFile(TEST_SERVICE, 'file-test-overwrite', 'updated');
    const result = await getSecretFile(TEST_SERVICE, 'file-test-overwrite');
    expect(result).toBe('updated');
  });

  test('getSecretFile returns null for non-existent entry', async () => {
    const result = await getSecretFile(TEST_SERVICE, 'no-such-file-account');
    expect(result).toBeNull();
  });

  test('deleteSecretFile removes a file entry', async () => {
    await setSecretFile(TEST_SERVICE, 'file-test-delete', 'to-delete');
    const before = await getSecretFile(TEST_SERVICE, 'file-test-delete');
    expect(before).toBe('to-delete');

    await deleteSecretFile(TEST_SERVICE, 'file-test-delete');
    const after = await getSecretFile(TEST_SERVICE, 'file-test-delete');
    expect(after).toBeNull();
  });

  test('deleteSecretFile is silent for non-existent entry', async () => {
    // Should not throw
    await deleteSecretFile(TEST_SERVICE, 'no-such-file-to-delete');
  });

  test('handles special characters in account names', async () => {
    await setSecretFile(TEST_SERVICE, 'opencode/auth.json', '{"key":"value"}');
    const result = await getSecretFile(TEST_SERVICE, 'opencode/auth.json');
    expect(result).toBe('{"key":"value"}');
  });

  test('handles JSON string values', async () => {
    const jsonValue = JSON.stringify({
      token: 'abc123',
      expiresAt: Date.now() + 3600000,
    });
    await setSecretFile(TEST_SERVICE, 'file-test-json', jsonValue);
    const result = await getSecretFile(TEST_SERVICE, 'file-test-json');
    expect(result).toBe(jsonValue);

    expect(result).not.toBeNull();
    const parsed = JSON.parse(result as string);
    expect(parsed.token).toBe('abc123');
  });

  test('keyringFallbackPath encodes account name', () => {
    const path = keyringFallbackPath('ox', 'opencode/auth.json');
    expect(path).toContain('keyring');
    expect(path).toContain('ox');
    expect(path).toContain('opencode_auth.json');
    // Should not contain a raw slash in the account portion
    expect(path.endsWith('opencode_auth.json')).toBe(true);
  });
});
