import { afterEach, describe, expect, test } from 'bun:test';
import { abortShutdown, getShutdownSignal, resetShutdown } from './shutdown.ts';

describe('shutdown signal', () => {
  afterEach(() => {
    resetShutdown();
  });

  test('returns the same signal until reset', () => {
    const first = getShutdownSignal();
    const second = getShutdownSignal();
    expect(first).toBe(second);
  });

  test('abortShutdown aborts the shared signal', () => {
    const signal = getShutdownSignal();
    abortShutdown();
    expect(signal.aborted).toBe(true);
  });

  test('resetShutdown replaces an aborted signal', () => {
    const first = getShutdownSignal();
    abortShutdown();
    resetShutdown();
    const second = getShutdownSignal();
    expect(second).not.toBe(first);
    expect(second.aborted).toBe(false);
  });
});
