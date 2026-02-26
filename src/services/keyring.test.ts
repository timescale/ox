import { afterAll, describe, expect, test } from 'bun:test';
import {
  accountToFilename,
  deleteSecret,
  deleteSecretFile,
  getOxSecret,
  getSecret,
  getSecretFile,
  keyringFallbackPath,
  setOxSecret,
  setSecret,
  setSecretFile,
} from './keyring';

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

const fileTestAccounts = [
  'file-test-basic',
  'file-test-overwrite',
  'file-test-delete',
  'file-test-special',
  'file-test-json',
  'opencode/auth.json',
];

// Clean up all test entries after tests complete
afterAll(async () => {
  await Promise.allSettled([
    ...testAccounts.map((a) => deleteSecret(TEST_SERVICE, a)),
    ...testAccounts.map((a) => deleteSecret('ox', a)),
    ...fileTestAccounts.map((a) => deleteSecretFile(TEST_SERVICE, a)),
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

// ============================================================================
// File-based fallback tests — these run everywhere (including CI)
// ============================================================================

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
