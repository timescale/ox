import { create } from 'zustand';
import type { AgentType } from '../services/config.ts';
import type { PullLayer } from '../services/docker.ts';
import type { DockerProvider, DockerStatus } from '../services/dockerSetup.ts';
import { log } from '../services/logger.ts';
import type { SandboxProviderType } from '../services/sandbox/types.ts';

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

  // Tier 3: Models
  models: CheckStatus;

  // Tier 3: Credentials (per-agent, cached independently)
  claudeAuth: CheckStatus | 'invalid';
  opencodeAuth: CheckStatus | 'invalid';
  codexAuth: CheckStatus | 'invalid';
  ghAuth: CheckStatus | 'invalid';

  // Track which model was used for each agent credential check
  claudeAuthModel: string | undefined;
  opencodeAuthModel: string | undefined;
  codexAuthModel: string | undefined;

  // Error details
  error: string | null;

  // Actions
  runChecks: () => Promise<void>;
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
}

// ============================================================================
// Initial state
// ============================================================================

const initialState: Omit<
  ReadinessState,
  | 'runChecks'
  | 'checkAgentAuth'
  | 'prebuildAgentImage'
  | 'reset'
  | 'resetAgentAuth'
  | 'resetGhAuth'
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
  models: 'unknown',
  claudeAuth: 'unknown',
  opencodeAuth: 'unknown',
  codexAuth: 'unknown',
  ghAuth: 'unknown',
  claudeAuthModel: undefined,
  opencodeAuthModel: undefined,
  codexAuthModel: undefined,
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
            onProgress: (progress) => {
              if (
                progress.type === 'pulling' ||
                progress.type === 'pulling-cache'
              ) {
                set({ basePullLayers: progress.layers ?? [] });
              }
            },
          });
          set({ sandboxBaseImage: 'ready', basePullLayers: [] });
        } catch (err) {
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

      const ghOk = await checkGhCredentials().catch(() => false);

      set({ ghAuth: ghOk ? 'ready' : 'invalid' });
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

    // Fire-and-forget
    (async () => {
      try {
        let ok: boolean;
        switch (agent) {
          case 'claude':
            ok = await (
              await import('../services/claude.ts')
            ).checkClaudeCredentials(model);
            break;
          case 'codex':
            ok = await (
              await import('../services/codex.ts')
            ).checkCodexCredentials();
            break;
          default:
            ok = await (
              await import('../services/opencode.ts')
            ).checkOpencodeCredentials(model);
            break;
        }
        set({ [authKey]: ok ? 'ready' : 'invalid' });
      } catch {
        set({ [authKey]: 'error' });
      }
    })();
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
    });

    // Fire-and-forget async build
    (async () => {
      try {
        const { getSandboxProvider } = await import(
          '../services/sandbox/index.ts'
        );
        const provider = getSandboxProvider(providerType);

        set({ sandboxAgentImage: 'building' });

        await provider.ensureImage({
          agent,
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
          },
        });

        // Only mark ready if this is still the active build
        const current = useReadinessStore.getState();
        if (
          current.agentImageAgent === agent &&
          current.agentImageProvider === providerType
        ) {
          set({ sandboxAgentImage: 'ready', agentBuildLayers: [] });
        }
      } catch (err) {
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
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();
  },
}));
