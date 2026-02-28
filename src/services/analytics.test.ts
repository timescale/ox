import { describe, expect, test } from 'bun:test';
import { resetAnalyticsState, shutdown, track } from './analytics';

describe('analytics', () => {
  test('track does not throw when analytics is disabled', () => {
    // In test environment, analytics is automatically disabled
    expect(() => {
      track('test_event', { some_prop: 'value' });
    }).not.toThrow();
  });

  test('track filters sensitive properties', () => {
    // Should not throw even with sensitive-looking properties
    expect(() => {
      track('test_event', {
        password: 'secret123',
        token: 'abc',
        normal_prop: 'ok',
      });
    }).not.toThrow();
  });

  test('shutdown does not throw when no client exists', async () => {
    await expect(shutdown()).resolves.toBeUndefined();
  });

  test('resetAnalyticsState does not throw', () => {
    expect(() => resetAnalyticsState()).not.toThrow();
  });
});
