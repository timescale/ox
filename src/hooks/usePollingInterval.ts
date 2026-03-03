import { useCallback, useEffect, useRef } from 'react';
import { log } from '../services/logger';

export interface UsePollingIntervalOptions {
  /** Starting interval in ms (e.g. 100). The first poll fires immediately on mount. */
  initialMs: number;
  /** Maximum interval in ms — the backoff ceiling (e.g. 5000). */
  maxMs: number;
  /** Multiplier applied each tick (default 2). */
  backoffFactor?: number;
}

export interface UsePollingIntervalResult {
  /**
   * Reset the interval back to `initialMs` and immediately fire the callback.
   * Use this after actions (e.g. stop) that are expected to change polled state.
   */
  rush: () => void;
}

/**
 * Hook that polls a callback with exponential backoff.
 *
 * - Fires the callback immediately on mount, then schedules subsequent calls
 *   starting at `initialMs` and doubling (by `backoffFactor`) up to `maxMs`.
 * - The returned `rush()` resets the interval to `initialMs` and fires immediately,
 *   useful after user actions that are expected to change the polled state.
 * - Uses chained `setTimeout` (not `setInterval`) since the delay changes each tick.
 *
 * Important: `callback` should be a stable reference (wrap in useCallback) to
 * avoid restarting the polling cycle on every render.
 */
export function usePollingInterval(
  callback: () => void | Promise<void>,
  options: UsePollingIntervalOptions,
): UsePollingIntervalResult {
  const { initialMs, maxMs, backoffFactor = 2 } = options;

  // Mutable ref holding the current delay — survives across renders without
  // restarting the effect.
  const currentDelayRef = useRef(initialMs);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep a ref to the latest callback so the scheduling loop always calls the
  // most recent version without needing it in the effect dependency array.
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  // Core scheduling function — calls the callback then schedules the next tick
  // at the current delay, increasing it afterward.
  const scheduleNext = useCallback(() => {
    const delay = currentDelayRef.current;
    timerRef.current = setTimeout(async () => {
      try {
        await callbackRef.current();
      } catch (err) {
        log.error({ err }, 'usePollingInterval callback error');
      }
      // Increase delay for next tick (capped at maxMs)
      currentDelayRef.current = Math.min(delay * backoffFactor, maxMs);
      scheduleNext();
    }, delay);
  }, [maxMs, backoffFactor]);

  // Main effect — fire immediately on mount, then start the scheduling chain.
  useEffect(() => {
    currentDelayRef.current = initialMs;

    // Fire immediately
    (async () => {
      try {
        await callbackRef.current();
      } catch (err) {
        log.error({ err }, 'usePollingInterval initial callback error');
      }
    })();

    scheduleNext();

    return () => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [initialMs, scheduleNext]);

  // rush() — reset to fast polling and fire immediately
  const rush = useCallback(() => {
    // Clear any pending timer
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // Reset to initial fast interval
    currentDelayRef.current = initialMs;

    // Fire immediately
    (async () => {
      try {
        await callbackRef.current();
      } catch (err) {
        log.error({ err }, 'usePollingInterval rush callback error');
      }
    })();

    // Restart the scheduling chain
    scheduleNext();
  }, [initialMs, scheduleNext]);

  return { rush };
}
