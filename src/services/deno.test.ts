import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { deleteDenoToken, getDenoToken, setDenoToken } from './deno';

// Mock the keyring module so tests never touch the real OS keyring.
// This prevents `./bun test` from wiping out the user's actual Deno token.
const mockStore = new Map<string, string>();
mock.module('./keyring', () => ({
  getHermesSecret: async (key: string) => mockStore.get(key) ?? null,
  setHermesSecret: async (key: string, value: string) => {
    mockStore.set(key, value);
  },
  deleteHermesSecret: async (key: string) => {
    mockStore.delete(key);
  },
  // Keep other exports available in case they're needed
  getSecret: async () => null,
  setSecret: async () => {},
  deleteSecret: async () => {},
}));

describe('deno token management', () => {
  beforeAll(() => {
    mockStore.clear();
  });

  afterAll(() => {
    mockStore.clear();
  });

  test('getDenoToken returns null when no token is stored', async () => {
    mockStore.clear();
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
