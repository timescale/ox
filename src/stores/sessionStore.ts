// ============================================================================
// Session Store - Zustand store for session selection state management
// ============================================================================

import { create } from 'zustand';
import type { PrInfo } from '../services/github';

// ============================================================================
// Types
// ============================================================================

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

  /** PR info cache keyed by session ID (containerId) */
  prCache: Record<string, PrCacheEntry>;

  /** Set PR info for a session */
  setPrInfo: (sessionId: string, prInfo: PrInfo | null) => void;

  /** Get PR cache entry for a session */
  getPrInfo: (sessionId: string) => PrCacheEntry | undefined;

  /** Clear all PR cache entries */
  clearPrCache: () => void;
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  selectedSessionId: null,
  prCache: {},

  setSelectedSessionId: (id: string | null) => {
    set({ selectedSessionId: id });
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
}));
