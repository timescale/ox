// ============================================================================
// Session Store - Zustand store for session selection state management
// ============================================================================

import { create } from 'zustand';
import type { PrInfo } from '../services/github';

// ============================================================================
// Types
// ============================================================================

export type FilterMode = 'all' | 'running' | 'completed';
export type ScopeMode = 'local' | 'global';

export interface PrCacheEntry {
  prInfo: PrInfo | null;
  lastChecked: number; // Date.now() timestamp
}

// ============================================================================
// Store
// ============================================================================

export interface SessionState {
  /** Currently selected session ID (containerId) */
  selectedSessionId: string | null;

  /** Set the selected session ID */
  setSelectedSessionId: (id: string | null) => void;

  /** Free-text filter applied to the sessions list */
  filterText: string;

  /** Set the free-text filter */
  setFilterText: (text: string) => void;

  /** Status filter applied to the sessions list */
  filterMode: FilterMode;

  /** Set the status filter */
  setFilterMode: (mode: FilterMode) => void;

  /** Repo scope applied to the sessions list */
  scopeMode: ScopeMode;

  /** Set the repo scope */
  setScopeMode: (mode: ScopeMode) => void;

  /** Initialize scope based on whether a repo is currently active */
  syncScopeModeWithRepo: (hasCurrentRepo: boolean) => void;

  /** PR info cache keyed by session ID (containerId) */
  prCache: Record<string, PrCacheEntry>;

  /** Set PR info for a session */
  setPrInfo: (sessionId: string, prInfo: PrInfo | null) => void;

  /** Get PR cache entry for a session */
  getPrInfo: (sessionId: string) => PrCacheEntry | undefined;

  /** Clear all PR cache entries */
  clearPrCache: () => void;

  /** Session IDs with in-flight background deletions */
  pendingDeletes: Set<string>;

  /** Mark a session as pending deletion */
  addPendingDelete: (id: string) => void;

  /** Remove a session from pending deletion */
  removePendingDelete: (id: string) => void;

  /** Check if a session is pending deletion */
  isPendingDelete: (id: string) => boolean;
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  selectedSessionId: null,
  filterText: '',
  filterMode: 'all',
  scopeMode: 'global',
  prCache: {},

  setSelectedSessionId: (id: string | null) => {
    set({ selectedSessionId: id });
  },

  setFilterText: (text: string) => {
    set({ filterText: text });
  },

  setFilterMode: (mode: FilterMode) => {
    set({ filterMode: mode });
  },

  setScopeMode: (mode: ScopeMode) => {
    set({ scopeMode: mode });
  },

  syncScopeModeWithRepo: (hasCurrentRepo: boolean) => {
    const { scopeMode } = get();
    if (hasCurrentRepo && scopeMode === 'global') {
      set({ scopeMode: 'local' });
    } else if (!hasCurrentRepo && scopeMode === 'local') {
      set({ scopeMode: 'global' });
    }
  },

  setPrInfo: (sessionId: string, prInfo: PrInfo | null) => {
    set((state) => ({
      prCache: {
        ...state.prCache,
        [sessionId]: {
          prInfo,
          lastChecked: Date.now(),
        },
      },
    }));
  },

  getPrInfo: (sessionId: string) => {
    return get().prCache[sessionId];
  },

  clearPrCache: () => {
    set({ prCache: {} });
  },

  pendingDeletes: new Set(),

  addPendingDelete: (id: string) => {
    set((state) => ({
      pendingDeletes: new Set([...state.pendingDeletes, id]),
    }));
  },

  removePendingDelete: (id: string) => {
    set((state) => {
      const next = new Set(state.pendingDeletes);
      next.delete(id);
      return { pendingDeletes: next };
    });
  },

  isPendingDelete: (id: string) => {
    return get().pendingDeletes.has(id);
  },
}));
