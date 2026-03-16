import { afterEach, describe, expect, test } from 'bun:test';
import { useSessionStore } from './sessionStore';

afterEach(() => {
  useSessionStore.setState({
    selectedSessionId: null,
    filterText: '',
    filterMode: 'all',
    scopeMode: 'global',
    prCache: {},
    pendingDeletes: new Set(),
  });
});

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

describe('sessionStore - filters', () => {
  test('stores filter text', () => {
    useSessionStore.getState().setFilterText('bugfix');
    expect(useSessionStore.getState().filterText).toBe('bugfix');
  });

  test('composes consecutive filter text updates from the latest state', () => {
    const { setFilterText } = useSessionStore.getState();

    setFilterText((prev) => `${prev}a`);
    setFilterText((prev) => `${prev}b`);

    expect(useSessionStore.getState().filterText).toBe('ab');
  });

  test('stores filter mode', () => {
    useSessionStore.getState().setFilterMode('running');
    expect(useSessionStore.getState().filterMode).toBe('running');
  });

  test('syncScopeModeWithRepo defaults to local when entering a repo', () => {
    useSessionStore.getState().syncScopeModeWithRepo(true);
    expect(useSessionStore.getState().scopeMode).toBe('local');
  });

  test('syncScopeModeWithRepo resets to global when leaving a repo', () => {
    const store = useSessionStore.getState();
    store.setScopeMode('local');
    store.syncScopeModeWithRepo(false);
    expect(useSessionStore.getState().scopeMode).toBe('global');
  });

  test('syncScopeModeWithRepo preserves explicit local scope in a repo', () => {
    const store = useSessionStore.getState();
    store.setScopeMode('local');
    store.syncScopeModeWithRepo(true);
    expect(useSessionStore.getState().scopeMode).toBe('local');
  });
});
