import { afterEach, describe, expect, test } from 'bun:test';
import { useSessionStore } from './sessionStore';

describe('sessionStore - pendingDeletes', () => {
  afterEach(() => {
    // Reset pendingDeletes
    const state = useSessionStore.getState();
    for (const id of state.pendingDeletes) {
      state.removePendingDelete(id);
    }
  });

  test('addPendingDelete adds an ID to the set', () => {
    useSessionStore.getState().addPendingDelete('abc');
    expect(useSessionStore.getState().pendingDeletes.has('abc')).toBe(true);
  });

  test('removePendingDelete removes an ID from the set', () => {
    const store = useSessionStore.getState();
    store.addPendingDelete('abc');
    store.removePendingDelete('abc');
    expect(useSessionStore.getState().pendingDeletes.has('abc')).toBe(false);
  });

  test('isPendingDelete returns true for pending IDs', () => {
    useSessionStore.getState().addPendingDelete('abc');
    expect(useSessionStore.getState().isPendingDelete('abc')).toBe(true);
    expect(useSessionStore.getState().isPendingDelete('xyz')).toBe(false);
  });

  test('multiple deletes tracked independently', () => {
    const store = useSessionStore.getState();
    store.addPendingDelete('a');
    store.addPendingDelete('b');
    store.addPendingDelete('c');
    expect(useSessionStore.getState().pendingDeletes.size).toBe(3);

    store.removePendingDelete('b');
    expect(useSessionStore.getState().pendingDeletes.size).toBe(2);
    expect(useSessionStore.getState().isPendingDelete('a')).toBe(true);
    expect(useSessionStore.getState().isPendingDelete('b')).toBe(false);
    expect(useSessionStore.getState().isPendingDelete('c')).toBe(true);
  });
});
