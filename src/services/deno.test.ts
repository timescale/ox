import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Mock the keyring module so deno tests never touch the real OS keyring.
//
// IMPORTANT: The mock must provide a *working* simulation of the full keyring
// API (not just stubs returning null).  Bun's mock.module() replaces the
// module for the entire test process, which means other test files that import
// './keyring' (e.g. keyring.test.ts) will see this mock too.  A functional
// mock ensures those tests still pass — setSecret/getSecret round-trips work,
// deleteSecret removes entries, the Ox wrappers delegate correctly, and the
// file-based helpers behave as expected.
// ---------------------------------------------------------------------------

const store = new Map<string, string>();

function storeKey(service: string, account: string): string {
  return `${service}\0${account}`;
}

function accountToFilename(account: string): string {
  return account.replace(/[/\\:*?"<>|]/g, '_');
}

mock.module('./keyring', () => {
  const getSecret = async (service: string, account: string) =>
    store.get(storeKey(service, account)) ?? null;

  const setSecret = async (service: string, account: string, value: string) => {
    store.set(storeKey(service, account), value);
  };

  const deleteSecret = async (service: string, account: string) => {
    store.delete(storeKey(service, account));
  };

  const OX_SERVICE = 'ox';
  const getOxSecret = async (account: string) => getSecret(OX_SERVICE, account);
  const setOxSecret = async (account: string, value: string) =>
    setSecret(OX_SERVICE, account, value);
  const deleteOxSecret = async (account: string) =>
    deleteSecret(OX_SERVICE, account);

  // File-based fallback — reuse the same in-memory store with a 'file:' prefix
  const getSecretFile = async (service: string, account: string) =>
    store.get(`file:${storeKey(service, account)}`) ?? null;

  const setSecretFile = async (
    service: string,
    account: string,
    value: string,
  ) => {
    store.set(`file:${storeKey(service, account)}`, value);
  };

  const deleteSecretFile = async (service: string, account: string) => {
    store.delete(`file:${storeKey(service, account)}`);
  };

  const keyringFallbackPath = (service: string, account: string) =>
    join('mock-config', 'keyring', service, accountToFilename(account));

  return {
    getSecret,
    setSecret,
    deleteSecret,
    getOxSecret,
    setOxSecret,
    deleteOxSecret,
    getSecretFile,
    setSecretFile,
    deleteSecretFile,
    accountToFilename,
    keyringFallbackPath,
  };
});

// Import *after* the mock is installed so deno.ts picks up the mock.
const { deleteDenoToken, getDenoToken, setDenoToken } = await import('./deno');

describe('deno token management', () => {
  beforeAll(() => {
    store.clear();
  });

  afterAll(() => {
    store.clear();
  });

  test('getDenoToken returns null when no token is stored', async () => {
    store.clear();
    const token = await getDenoToken();
    expect(token).toBeNull();
  });

  test('setDenoToken and getDenoToken round-trip', async () => {
    const testToken = 'test-deno-token-12345';
    await setDenoToken(testToken);
    const retrieved = await getDenoToken();
    expect(retrieved).toBe(testToken);
    // Clean up
    await deleteDenoToken();
  });

  test('deleteDenoToken removes the token', async () => {
    await setDenoToken('to-be-deleted');
    await deleteDenoToken();
    const token = await getDenoToken();
    expect(token).toBeNull();
  });

  test('deleteDenoToken is safe to call when no token exists', async () => {
    await deleteDenoToken();
    // Should not throw
    await deleteDenoToken();
  });
});
