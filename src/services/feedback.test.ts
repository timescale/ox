import { afterEach, describe, expect, mock, test } from 'bun:test';
import { sendFeedback } from './feedback';

describe('sendFeedback', () => {
  const ORIGINAL_ENV = process.env.OX_FEEDBACK_WEBHOOK_URL;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.OX_FEEDBACK_WEBHOOK_URL;
    } else {
      process.env.OX_FEEDBACK_WEBHOOK_URL = ORIGINAL_ENV;
    }
    mock.restore();
  });

  test('returns success when webhook responds 200', async () => {
    process.env.OX_FEEDBACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('ok', { status: 200 })),
    ) as unknown as typeof fetch;
    try {
      const result = await sendFeedback('Great tool!');
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('returns failure when no webhook URL is configured', async () => {
    delete process.env.OX_FEEDBACK_WEBHOOK_URL;
    const result = await sendFeedback('test');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not configured');
  });

  test('returns failure on empty message', async () => {
    process.env.OX_FEEDBACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
    const result = await sendFeedback('   ');
    expect(result.success).toBe(false);
    expect(result.error).toContain('empty');
  });

  test('returns failure on non-200 response', async () => {
    process.env.OX_FEEDBACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('error', { status: 403 })),
    ) as unknown as typeof fetch;
    try {
      const result = await sendFeedback('test');
      expect(result.success).toBe(false);
      expect(result.error).not.toContain('hooks.slack.com');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('returns failure on network error without throwing', async () => {
    process.env.OX_FEEDBACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.reject(new Error('network failure')),
    ) as unknown as typeof fetch;
    try {
      const result = await sendFeedback('test');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).not.toContain('hooks.slack.com');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
