import { describe, expect, test } from 'bun:test';
import { AbortError, raceAbort, throwIfAborted } from './abort.ts';

describe('AbortError', () => {
  test('uses the AbortError name', () => {
    const err = new AbortError();
    expect(err.name).toBe('AbortError');
    expect(err.message).toBe('Aborted');
  });
});

describe('throwIfAborted', () => {
  test('does nothing when signal is not aborted', () => {
    const controller = new AbortController();
    expect(() => throwIfAborted(controller.signal)).not.toThrow();
  });

  test('throws AbortError when signal is aborted', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow(AbortError);
  });
});

describe('raceAbort', () => {
  test('resolves with the wrapped promise result when not aborted', async () => {
    const controller = new AbortController();
    await expect(
      raceAbort(controller.signal, Promise.resolve('ok')),
    ).resolves.toBe('ok');
  });

  test('rejects with AbortError when aborted before completion', async () => {
    const controller = new AbortController();
    const pending = new Promise<string>(() => {});

    const result = raceAbort(controller.signal, pending);
    controller.abort();

    await expect(result).rejects.toBeInstanceOf(AbortError);
  });
});
