import { create } from 'zustand';
import { useToastStore } from './toastStore';

export interface BackgroundTask {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  error?: string;
  startedAt: number;
  completedAt?: number;
}

export interface BackgroundTaskState {
  tasks: BackgroundTask[];
  pendingCount: number;
  shuttingDown: boolean;

  enqueue: (label: string, fn: () => Promise<void>) => string;
  waitForAll: () => Promise<void>;
  setShuttingDown: (value: boolean) => void;
  clear: () => void;
}

export const useBackgroundTaskStore = create<BackgroundTaskState>()(
  (set, get) => ({
    tasks: [],
    pendingCount: 0,
    shuttingDown: false,

    enqueue: (label: string, fn: () => Promise<void>): string => {
      const id = crypto.randomUUID();
      const task: BackgroundTask = {
        id,
        label,
        status: 'running',
        startedAt: Date.now(),
      };

      set((state) => ({
        tasks: [...state.tasks, task],
        pendingCount: state.pendingCount + 1,
      }));

      fn()
        .then(() => {
          set((state) => ({
            tasks: state.tasks.map((t) =>
              t.id === id
                ? {
                    ...t,
                    status: 'completed' as const,
                    completedAt: Date.now(),
                  }
                : t,
            ),
            pendingCount: state.pendingCount - 1,
          }));
        })
        .catch((err) => {
          const errorMessage = err instanceof Error ? err.message : String(err);
          set((state) => ({
            tasks: state.tasks.map((t) =>
              t.id === id
                ? {
                    ...t,
                    status: 'failed' as const,
                    error: errorMessage,
                    completedAt: Date.now(),
                  }
                : t,
            ),
            pendingCount: state.pendingCount - 1,
          }));
          useToastStore
            .getState()
            .show(`Background task failed: ${errorMessage}`, 'error');
        });

      return id;
    },

    waitForAll: (): Promise<void> => {
      return new Promise<void>((resolve) => {
        if (get().pendingCount === 0) {
          resolve();
          return;
        }
        const unsub = useBackgroundTaskStore.subscribe((state) => {
          if (state.pendingCount === 0) {
            unsub();
            resolve();
          }
        });
        // Re-check after subscribing to close the race window where
        // a task completes between the initial check and the subscription
        if (get().pendingCount === 0) {
          unsub();
          resolve();
        }
      });
    },

    setShuttingDown: (value: boolean) => {
      set({ shuttingDown: value });
    },

    clear: () => {
      set((state) => {
        const remaining = state.tasks.filter(
          (t) => t.status === 'running' || t.status === 'pending',
        );
        return {
          tasks: remaining,
          pendingCount: remaining.length,
        };
      });
    },
  }),
);
