import { describe, expect, test } from 'bun:test';
import {
  AbortError,
  isAbortError,
  onAbort,
  raceAbort,
  throwIfAborted,
} from './abort.ts';

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

describe('onAbort', () => {
  test('returns no-op cleanup when signal is undefined', () => {
    const fn = () => {};
    const cleanup = onAbort(undefined, fn);
    expect(cleanup).toBeInstanceOf(Function);
    // Should not throw when called
    cleanup();
  });

  test('calls fn immediately and returns no-op when signal is already aborted', () => {
    const controller = new AbortController();
    controller.abort();

    let called = false;
    const cleanup = onAbort(controller.signal, () => {
      called = true;
    });

    expect(called).toBe(true);
    expect(cleanup).toBeInstanceOf(Function);
  });

  test('calls fn when signal aborts', () => {
    const controller = new AbortController();
    let called = false;

    onAbort(controller.signal, () => {
      called = true;
    });

    expect(called).toBe(false);
    controller.abort();
    expect(called).toBe(true);
  });

  test('cleanup removes the abort listener', () => {
    const controller = new AbortController();
    let called = false;

    const cleanup = onAbort(controller.signal, () => {
      called = true;
    });

    cleanup();
    controller.abort();
    expect(called).toBe(false);
  });
});

describe('isAbortError', () => {
  test('returns true for AbortError instance', () => {
    const err = new AbortError();
    expect(isAbortError(err)).toBe(true);
  });

  test('returns true for Error with name "AbortError"', () => {
    const err = new Error('some message');
    err.name = 'AbortError';
    expect(isAbortError(err)).toBe(true);
  });

  test('returns false for regular Error', () => {
    const err = new Error('some message');
    expect(isAbortError(err)).toBe(false);
  });

  test('returns false for non-Error values', () => {
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError('AbortError')).toBe(false);
    expect(isAbortError({ name: 'AbortError' })).toBe(false);
  });
});
