import { create } from 'zustand';
import type { PullLayer } from '../services/docker.ts';
import type { DockerProvider, DockerStatus } from '../services/dockerSetup.ts';
import { log } from '../services/logger.ts';

// ============================================================================
// Types
// ============================================================================

type CheckStatus = 'unknown' | 'checking' | 'ready' | 'error';

export interface ReadinessState {
  // Tier 1: Docker installed
  dockerInstalled: 'unknown' | 'checking' | 'installed' | 'not-installed';
  dockerStatus: DockerStatus | null;

  // Tier 2: Docker running
  dockerRunning:
    | 'unknown'
    | 'checking'
    | 'starting'
    | 'running'
    | 'not-running';

  // Tier 3: Sandbox image
  sandboxImage: CheckStatus | 'pulling';
  pullLayers: PullLayer[];

  // Tier 3: Models
  models: CheckStatus;

  // Tier 3: Credentials (per-agent, cached independently)
  claudeAuth: CheckStatus | 'invalid';
  opencodeAuth: CheckStatus | 'invalid';
  ghAuth: CheckStatus | 'invalid';

  // Error details
  error: string | null;

  // Actions
  runChecks: () => Promise<void>;
  checkAgentAuth: (agent: 'claude' | 'opencode', model?: string) => void;
  reset: () => void;
}

// ============================================================================
// Initial state
// ============================================================================

const initialState: Omit<
  ReadinessState,
  'runChecks' | 'checkAgentAuth' | 'reset'
> = {
  dockerInstalled: 'unknown',
  dockerStatus: null,
  dockerRunning: 'unknown',
  sandboxImage: 'unknown',
  pullLayers: [],
  models: 'unknown',
  claudeAuth: 'unknown',
  opencodeAuth: 'unknown',
  ghAuth: 'unknown',
  error: null,
};

// ============================================================================
// Store
// ============================================================================

// Guard against concurrent runChecks calls
let checksRunning = false;

export const useReadinessStore = create<ReadinessState>()((set) => ({
  ...initialState,

  reset: () => {
    checksRunning = false;
    set(initialState);
  },

  runChecks: async () => {
    if (checksRunning) return;
    checksRunning = true;

    try {
      // Lazy imports to avoid circular dependencies and keep the store lightweight
      const { checkDockerStatus, startProvider } = await import(
        '../services/dockerSetup.ts'
      );
      const { dockerImageExists, ensureDockerImage } = await import(
        '../services/docker.ts'
      );

      // ---- Tier 1: Docker installed? ----
      set({ dockerInstalled: 'checking' });

      let status: DockerStatus;
      try {
        status = await checkDockerStatus();
      } catch (err) {
        set({
          dockerInstalled: 'not-installed',
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      set({ dockerStatus: status });

      const anyInstalled =
        status.dockerDesktopInstalled || status.orbstackInstalled;
      if (!anyInstalled) {
        set({ dockerInstalled: 'not-installed' });
        return;
      }

      set({ dockerInstalled: 'installed' });

      // ---- Tier 2: Docker running? ----
      if (status.isRunning) {
        set({ dockerRunning: 'running' });
      } else {
        set({ dockerRunning: 'starting' });

        // Pick which provider to start
        let provider: DockerProvider;
        if (status.orbstackInstalled && !status.dockerDesktopInstalled) {
          provider = 'orbstack';
        } else if (status.dockerDesktopInstalled && !status.orbstackInstalled) {
          provider = 'docker-desktop';
        } else {
          // Both installed — prefer OrbStack
          provider = 'orbstack';
        }

        try {
          await startProvider(provider, 600);
          set({ dockerRunning: 'running' });
        } catch (err) {
          log.error({ err }, 'Failed to start Docker provider');
          set({
            dockerRunning: 'not-running',
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }
      }

      // ---- Tier 3: Sandbox image? ----
      set({ sandboxImage: 'checking' });

      let imageReady: boolean;
      try {
        imageReady = await dockerImageExists();
      } catch {
        imageReady = false;
      }

      if (imageReady) {
        set({ sandboxImage: 'ready' });
      } else {
        set({ sandboxImage: 'pulling', pullLayers: [] });

        try {
          await ensureDockerImage({
            onProgress: (progress) => {
              if (
                progress.type === 'pulling' ||
                progress.type === 'pulling-cache'
              ) {
                set({ pullLayers: progress.layers ?? [] });
              }
            },
          });
          set({ sandboxImage: 'ready', pullLayers: [] });
        } catch (err) {
          log.error({ err }, 'Failed to pull/build sandbox image');
          set({
            sandboxImage: 'error',
            pullLayers: [],
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }
      }

      // ---- Tier 3: Parallel checks (models + credentials) ----
      set({ models: 'ready' });

      // Run credential checks in parallel (fire-and-forget, results cached)
      const { checkGhCredentials } = await import('../services/gh.ts');
      const { checkClaudeCredentials } = await import('../services/claude.ts');
      const { checkOpencodeCredentials } = await import(
        '../services/opencode.ts'
      );

      set({
        ghAuth: 'checking',
        claudeAuth: 'checking',
        opencodeAuth: 'checking',
      });

      const [ghOk, claudeOk, opencodeOk] = await Promise.all([
        checkGhCredentials().catch(() => false),
        checkClaudeCredentials().catch(() => false),
        checkOpencodeCredentials().catch(() => false),
      ]);

      set({
        ghAuth: ghOk ? 'ready' : 'invalid',
        claudeAuth: claudeOk ? 'ready' : 'invalid',
        opencodeAuth: opencodeOk ? 'ready' : 'invalid',
      });
    } finally {
      checksRunning = false;
    }
  },

  checkAgentAuth: (agent: 'claude' | 'opencode', model?: string) => {
    const key = agent === 'claude' ? 'claudeAuth' : 'opencodeAuth';
    const current = useReadinessStore.getState()[key];

    // Only re-check if we haven't checked yet or if image isn't ready
    if (current !== 'unknown') return;
    if (useReadinessStore.getState().sandboxImage !== 'ready') return;

    set({ [key]: 'checking' });

    // Fire-and-forget
    (async () => {
      try {
        const ok =
          agent === 'claude'
            ? await (
                await import('../services/claude.ts')
              ).checkClaudeCredentials(model)
            : await (
                await import('../services/opencode.ts')
              ).checkOpencodeCredentials(model);
        set({ [key]: ok ? 'ready' : 'invalid' });
      } catch {
        set({ [key]: 'error' });
      }
    })();
  },
}));
