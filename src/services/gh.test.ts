import { describe, expect, test } from 'bun:test';
import { checkGhCredentialsLocal } from './gh';

describe('checkGhCredentialsLocal', () => {
  test('returns true when resolver returns valid credentials', async () => {
    const result = await checkGhCredentialsLocal(async () => ({
      'github.com': {
        oauth_token: 'gho_test',
      },
    }));

    expect(result).toBe(true);
  });

  test('returns false when resolver returns empty credentials', async () => {
    const result = await checkGhCredentialsLocal(async () => ({}));

    expect(result).toBe(false);
  });

  test('returns false when resolver throws', async () => {
    const result = await checkGhCredentialsLocal(async () => {
      throw new Error('boom');
    });

    expect(result).toBe(false);
  });
});
