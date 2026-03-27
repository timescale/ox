import { create } from 'zustand';
import { BuildError } from '../services/buildError.ts';
import type { AgentType } from '../services/config.ts';
import type { PullLayer } from '../services/docker.ts';
import type { DockerProvider, DockerStatus } from '../services/dockerSetup.ts';
import { log } from '../services/logger.ts';
import type { SandboxProviderType } from '../services/sandbox/types.ts';
import { abortShutdown, getShutdownSignal } from '../services/shutdown.ts';
import { isAbortError } from '../utils/abort.ts';

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

  // Tier 3: Sandbox base image
  sandboxBaseImage: CheckStatus | 'pulling';
  basePullLayers: PullLayer[];

  // Tier 3b: Agent-specific sandbox image (depends on base image + selected agent)
  sandboxAgentImage: CheckStatus | 'building';
  agentImageAgent: AgentType | null;
  agentImageProvider: SandboxProviderType | null;
  agentBuildLayers: PullLayer[];
  /** Current build step message (e.g. 'Running project setup layer') */
  agentBuildMessage: string | null;
  /** Latest output line from the build (e.g. apt-get progress) */
  agentBuildDetail: string | null;

  // Tier 3: Models
  models: CheckStatus;

  // Tier 3: Credentials (per-agent, cached independently)
  claudeAuth: CheckStatus | 'invalid';
  opencodeAuth: CheckStatus | 'invalid';
  codexAuth: CheckStatus | 'invalid';
  ghAuth: CheckStatus | 'invalid';
  ghostAuth: CheckStatus | 'invalid';

  // Track which model was used for each agent credential check
  claudeAuthModel: string | undefined;
  opencodeAuthModel: string | undefined;
  codexAuthModel: string | undefined;

  // Error details
  error: string | null;
  /** Build output lines captured from a failed image build (for the error view) */
  errorOutputLines: string[];

  // Actions
  runChecks: () => Promise<void>;
  abort: () => void;
  checkAgentAuth: (
    agent: 'claude' | 'opencode' | 'codex',
    model?: string,
  ) => void;
  prebuildAgentImage: (
    agent: AgentType,
    providerType: SandboxProviderType,
  ) => void;
  reset: () => void;
  /** Reset a single agent's auth state so the next check runs fresh. */
  resetAgentAuth: (agent: 'claude' | 'opencode' | 'codex') => void;
  /** Reset GitHub auth state so the next check runs fresh. */
  resetGhAuth: () => void;
  /** Reset Ghost auth state so the next check runs fresh. */
  resetGhostAuth: () => void;
  /** Check Ghost credentials (only when dbServiceProvider is 'ghost'). */
  checkGhostAuth: () => void;
}

// ============================================================================
// Initial state
// ============================================================================

const initialState: Omit<
  ReadinessState,
  | 'runChecks'
  | 'abort'
  | 'checkAgentAuth'
  | 'prebuildAgentImage'
  | 'reset'
  | 'resetAgentAuth'
  | 'resetGhAuth'
  | 'resetGhostAuth'
  | 'checkGhostAuth'
> = {
  dockerInstalled: 'unknown',
  dockerStatus: null,
  dockerRunning: 'unknown',
  sandboxBaseImage: 'unknown',
  basePullLayers: [],
  sandboxAgentImage: 'unknown',
  agentImageAgent: null,
  agentImageProvider: null,
  agentBuildLayers: [],
  agentBuildMessage: null,
  agentBuildDetail: null,
  models: 'unknown',
  claudeAuth: 'unknown',
  opencodeAuth: 'unknown',
  codexAuth: 'unknown',
  ghAuth: 'unknown',
  ghostAuth: 'unknown',
  claudeAuthModel: undefined,
  opencodeAuthModel: undefined,
  codexAuthModel: undefined,
  error: null,
  errorOutputLines: [],
};

// ============================================================================
// Store
// ============================================================================

// Guard against concurrent runChecks calls
let checksRunning = false;

// In-flight agent auth check promises so callers can await a pending check
// instead of launching a duplicate (which would race on token refresh).
const pendingAgentAuthChecks = new Map<string, Promise<boolean>>();

/**
 * Wait for an in-flight agent auth check to finish.
 * Returns the cached result (true/false) or null if no check is pending.
 */
export const waitForAgentAuthCheck = (
  agent: 'claude' | 'opencode' | 'codex',
): Promise<boolean> | null => {
  return pendingAgentAuthChecks.get(agent) ?? null;
};

export const useReadinessStore = create<ReadinessState>()((set) => ({
  ...initialState,

  abort: () => {
    abortShutdown();
  },

  reset: () => {
    checksRunning = false;
    set(initialState);
  },

  resetAgentAuth: (agent: 'claude' | 'opencode' | 'codex') => {
    const authKey =
      agent === 'claude'
        ? 'claudeAuth'
        : agent === 'codex'
          ? 'codexAuth'
          : 'opencodeAuth';
    const modelKey =
      agent === 'claude'
        ? 'claudeAuthModel'
        : agent === 'codex'
          ? 'codexAuthModel'
          : 'opencodeAuthModel';
    set({ [authKey]: 'unknown', [modelKey]: undefined });
  },

  resetGhAuth: () => {
    set({ ghAuth: 'unknown' });
  },

  resetGhostAuth: () => {
    set({ ghostAuth: 'unknown' });
  },

  checkGhostAuth: () => {
    const state = useReadinessStore.getState();
    // Don't re-check if already checking or resolved
    if (state.ghostAuth === 'checking') return;
    if (state.ghostAuth === 'ready' || state.ghostAuth === 'invalid') return;
    // Don't check if sandbox base image isn't ready yet (need Docker)
    if (state.sandboxBaseImage !== 'ready') return;

    set({ ghostAuth: 'checking' });

    (async () => {
      try {
        const signal = getShutdownSignal();
        const { checkGhostCredentials } = await import('../services/ghost.ts');
        const ok = await checkGhostCredentials(signal);
        set({ ghostAuth: ok ? 'ready' : 'invalid' });
      } catch (err) {
        if (isAbortError(err)) {
          set({ ghostAuth: 'unknown' });
          return;
        }
        set({ ghostAuth: 'error' });
      }
    })();
  },

  runChecks: async () => {
    if (checksRunning) return;
    checksRunning = true;

    try {
      const signal = getShutdownSignal();
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
          await startProvider(provider, 600, undefined, signal);
          set({ dockerRunning: 'running' });
        } catch (err) {
          if (isAbortError(err)) {
            return;
          }
          log.error({ err }, 'Failed to start Docker provider');
          set({
            dockerRunning: 'not-running',
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }
      }

      // ---- Background: prune stale Caddy routes / stop Caddy if unused ----
      // Fire-and-forget — never blocks startup or readiness checks.
      import('../services/portForwarding/caddy.ts')
        .then(({ stopCaddyIfUnused }) => stopCaddyIfUnused())
        .catch((err) => log.debug({ err }, 'Caddy cleanup on startup failed'));

      // ---- Tier 3: Sandbox image? ----
      set({ sandboxBaseImage: 'checking' });

      let imageReady: boolean;
      try {
        imageReady = await dockerImageExists();
      } catch {
        imageReady = false;
      }

      if (imageReady) {
        set({ sandboxBaseImage: 'ready' });
      } else {
        set({ sandboxBaseImage: 'pulling', basePullLayers: [] });

        try {
          await ensureDockerImage({
            signal,
            onProgress: (progress) => {
              if (
                progress.type === 'pulling' ||
                progress.type === 'pulling-cache'
              ) {
                set({ basePullLayers: progress.layers ?? [] });
              }
              if (progress.type === 'building') {
                // Clear stale pull layers when transitioning to build phase
                set({ basePullLayers: [] });
              }
            },
          });
          set({ sandboxBaseImage: 'ready', basePullLayers: [] });
        } catch (err) {
          if (isAbortError(err)) {
            return;
          }
          log.error({ err }, 'Failed to pull/build sandbox image');
          set({
            sandboxBaseImage: 'error',
            basePullLayers: [],
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }
      }

      // ---- Tier 3: Parallel checks (models + GH credentials) ----
      set({ models: 'ready' });

      // Only check GH credentials eagerly — agent-specific credential checks
      // are deferred until the agent is actually selected (via checkAgentAuth),
      // because they need a valid model to test against.
      const { checkGhCredentials } = await import('../services/gh.ts');

      set({ ghAuth: 'checking' });

      let ghOk: boolean;
      try {
        ghOk = await checkGhCredentials(signal);
      } catch (err) {
        if (isAbortError(err)) {
          set({ ghAuth: 'unknown' });
          return;
        }
        ghOk = false;
      }

      set({ ghAuth: ghOk ? 'ready' : 'invalid' });

      // Check Ghost credentials eagerly when the project uses Ghost as DB provider.
      // This runs in the background so the result is cached by the time the
      // user submits their prompt — avoiding a blocking auth check at session start.
      const { readConfig: readMergedConfig } = await import(
        '../services/config.ts'
      );
      const config = await readMergedConfig();
      if (config.dbServiceProvider === 'ghost' && config.dbServiceId) {
        useReadinessStore.getState().checkGhostAuth();
      }
    } finally {
      checksRunning = false;
    }
  },

  checkAgentAuth: (agent: 'claude' | 'opencode' | 'codex', model?: string) => {
    const state = useReadinessStore.getState();
    const authKey =
      agent === 'claude'
        ? 'claudeAuth'
        : agent === 'codex'
          ? 'codexAuth'
          : 'opencodeAuth';
    const modelKey =
      agent === 'claude'
        ? 'claudeAuthModel'
        : agent === 'codex'
          ? 'codexAuthModel'
          : 'opencodeAuthModel';
    const current = state[authKey];
    const prevModel = state[modelKey];

    // Don't re-check if already checking
    if (current === 'checking') return;
    // Don't check if sandbox image isn't ready yet
    if (state.sandboxBaseImage !== 'ready') return;
    // Re-check if: never checked ('unknown'), or model changed since last check
    if (current !== 'unknown' && model === prevModel) return;

    set({ [authKey]: 'checking', [modelKey]: model });

    // Track the in-flight promise so callers (e.g. startSession) can await
    // a pending check instead of launching a duplicate that would race on
    // OAuth token refresh.
    const checkPromise = (async () => {
      try {
        const signal = getShutdownSignal();
        let ok: boolean;
        switch (agent) {
          case 'claude':
            ok = await (
              await import('../services/claude.ts')
            ).checkClaudeCredentials(model, signal);
            break;
          case 'codex':
            ok = await (
              await import('../services/codex.ts')
            ).checkCodexCredentials(undefined, signal);
            break;
          default:
            ok = await (
              await import('../services/opencode.ts')
            ).checkOpencodeCredentials(model, signal);
            break;
        }
        set({ [authKey]: ok ? 'ready' : 'invalid' });
        return ok;
      } catch (err) {
        if (isAbortError(err)) {
          set({ [authKey]: 'unknown' });
          return false;
        }
        set({ [authKey]: 'error' });
        return false;
      } finally {
        pendingAgentAuthChecks.delete(agent);
      }
    })();
    pendingAgentAuthChecks.set(agent, checkPromise);
  },

  prebuildAgentImage: (agent: AgentType, providerType: SandboxProviderType) => {
    const state = useReadinessStore.getState();

    // Don't start if base image isn't ready yet
    if (state.sandboxBaseImage !== 'ready') return;

    // If already building for the same agent+provider, skip
    if (
      (state.sandboxAgentImage === 'checking' ||
        state.sandboxAgentImage === 'building') &&
      state.agentImageAgent === agent &&
      state.agentImageProvider === providerType
    ) {
      return;
    }

    // If already ready for the same agent+provider, skip
    if (
      state.sandboxAgentImage === 'ready' &&
      state.agentImageAgent === agent &&
      state.agentImageProvider === providerType
    ) {
      return;
    }

    // Start building — update tracking state (don't cancel any in-flight build;
    // it will finish and cache its result for potential future use).
    set({
      sandboxAgentImage: 'checking',
      agentImageAgent: agent,
      agentImageProvider: providerType,
      agentBuildLayers: [],
      agentBuildMessage: null,
      agentBuildDetail: null,
    });

    // Fire-and-forget async build
    (async () => {
      try {
        const signal = getShutdownSignal();
        const { getSandboxProvider } = await import(
          '../services/sandbox/index.ts'
        );
        const provider = getSandboxProvider(providerType);

        set({
          sandboxAgentImage: 'building',
          agentBuildMessage: null,
          agentBuildDetail: null,
        });

        await provider.ensureImage({
          agent,
          signal,
          onProgress: (progress) => {
            // Only update if this is still the active build
            const current = useReadinessStore.getState();
            if (
              current.agentImageAgent !== agent ||
              current.agentImageProvider !== providerType
            ) {
              return;
            }

            if (
              progress.type === 'pulling' ||
              progress.type === 'pulling-cache'
            ) {
              set({ agentBuildLayers: progress.layers ?? [] });
            }
            if (progress.type === 'building') {
              set({
                agentBuildLayers: [],
                agentBuildMessage: progress.message,
                ...(progress.detail != null
                  ? { agentBuildDetail: progress.detail }
                  : {}),
              });
            }
          },
        });

        // Only mark ready if this is still the active build
        const current = useReadinessStore.getState();
        if (
          current.agentImageAgent === agent &&
          current.agentImageProvider === providerType
        ) {
          set({
            sandboxAgentImage: 'ready',
            agentBuildLayers: [],
            agentBuildMessage: null,
            agentBuildDetail: null,
          });
        }
      } catch (err) {
        if (isAbortError(err)) {
          const current = useReadinessStore.getState();
          if (
            current.agentImageAgent === agent &&
            current.agentImageProvider === providerType
          ) {
            set({
              sandboxAgentImage: 'unknown',
              agentBuildLayers: [],
              agentBuildMessage: null,
              agentBuildDetail: null,
            });
          }
          return;
        }
        // Only set error if this is still the active build
        const current = useReadinessStore.getState();
        if (
          current.agentImageAgent === agent &&
          current.agentImageProvider === providerType
        ) {
          log.error(
            { err, agent, providerType },
            'Failed to prebuild agent image',
          );
          set({
            sandboxAgentImage: 'error',
            agentBuildLayers: [],
            agentBuildMessage: null,
            agentBuildDetail: null,
            error: err instanceof Error ? err.message : String(err),
            errorOutputLines: err instanceof BuildError ? err.outputLines : [],
          });
        }
      }
    })();
  },
}));
