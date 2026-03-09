// ============================================================================
// Prompt Settings Store - Persisted prompt screen selections
// ============================================================================

import { create } from 'zustand';
import type { AgentType, OxConfig } from '../services/config.ts';
import { userConfig } from '../services/config.ts';
import { log } from '../services/logger.ts';
import type { SandboxProviderType, SubmitMode } from '../services/sandbox';

// ============================================================================
// Serialized persistence — coalesces writes to avoid R-M-W races
// ============================================================================

/** Pending key-value pairs to write in the next flush. */
const pendingWrites: Partial<OxConfig> = {};

/** The current write operation (if any). */
let writeInFlight: Promise<void> | null = null;

/** Whether a new flush is scheduled after the current write completes. */
let flushScheduled = false;

/**
 * Schedule a coalesced write of all pending keys to user config.
 * Multiple calls between flushes are batched into a single read-modify-write.
 */
function schedulePersist(): void {
  if (writeInFlight) {
    // A write is already in progress — schedule a follow-up flush
    flushScheduled = true;
    return;
  }
  runFlush();
}

function runFlush(): void {
  // Snapshot and clear pending writes
  const toWrite = { ...pendingWrites };
  for (const key of Object.keys(pendingWrites)) {
    delete pendingWrites[key as keyof OxConfig];
  }
  if (Object.keys(toWrite).length === 0) {
    writeInFlight = null;
    return;
  }

  writeInFlight = (async () => {
    try {
      const current = (await userConfig.read()) ?? ({} as OxConfig);
      await userConfig.write({ ...current, ...toWrite } as OxConfig);
    } catch (error) {
      log.error({ error }, 'Failed to persist prompt settings');
    } finally {
      writeInFlight = null;
      // If more writes arrived while we were flushing, do another pass
      if (flushScheduled || Object.keys(pendingWrites).length > 0) {
        flushScheduled = false;
        runFlush();
      }
    }
  })();
}

/**
 * Wait for all pending config writes to complete.
 * Call this before app exit to ensure nothing is lost.
 */
export async function flushPromptSettings(): Promise<void> {
  // Kick off any pending writes that haven't started yet
  if (Object.keys(pendingWrites).length > 0 && !writeInFlight) {
    runFlush();
  }
  // Wait for the current (and any chained) write to finish
  while (writeInFlight) {
    await writeInFlight;
  }
}

function queueWrite(partial: Partial<OxConfig>): void {
  Object.assign(pendingWrites, partial);
  schedulePersist();
}

// ============================================================================
// Store
// ============================================================================

export interface PromptSettingsState {
  /** Currently selected agent */
  agent: AgentType;

  /** Currently selected model ID (may be null while models load) */
  modelId: string | null;

  /** Sandbox provider */
  sandboxProvider: SandboxProviderType;

  /** Interaction mode */
  submitMode: SubmitMode;

  /** Per-agent last-used model map */
  agentModels: Partial<Record<AgentType, string>>;

  /** Whether the store has been initialized from config */
  initialized: boolean;

  /**
   * Initialize the store from config + CLI overrides.
   * Reads user config directly to get the user's persisted prompt preferences,
   * then falls back to merged config for project-level defaults.
   * CLI overrides take highest priority.
   * Idempotent — only runs once.
   */
  initialize: (
    config: OxConfig,
    overrides?: {
      agent?: AgentType;
      model?: string | null;
      sandboxProvider?: SandboxProviderType;
      submitMode?: SubmitMode;
    },
  ) => Promise<void>;

  /** Update the selected agent. Saves current model into agentModels and restores the new agent's model. */
  setAgent: (agent: AgentType) => void;

  /** Update the selected model. Persists to agentModels for the current agent. */
  setModelId: (modelId: string | null) => void;

  /** Update the sandbox provider. */
  setSandboxProvider: (provider: SandboxProviderType) => void;

  /** Update the interaction mode. */
  setSubmitMode: (mode: SubmitMode) => void;

  /**
   * Get the persisted model for a given agent, if any.
   * Returns undefined if the user never selected a model for that agent.
   */
  getAgentModel: (agent: AgentType) => string | undefined;

  /**
   * Check whether the user has an explicit model selection for the given agent.
   */
  hasExplicitModel: (agent: AgentType) => boolean;
}

export const usePromptSettingsStore = create<PromptSettingsState>()(
  (set, get) => ({
    agent: 'opencode',
    modelId: null,
    sandboxProvider: 'docker',
    submitMode: 'interactive',
    agentModels: {},
    initialized: false,

    initialize: async (config, overrides) => {
      if (get().initialized) return;

      // Read user config directly to get the user's persisted prompt
      // preferences. These take priority over the merged config (which
      // lets project config override user config for initial defaults).
      let userCfg: OxConfig | undefined;
      try {
        userCfg = await userConfig.read();
      } catch {
        // Ignore read errors, fall through to merged config
      }

      // Priority: CLI overrides > user config > merged config > hardcoded defaults
      const agent =
        overrides?.agent ??
        userCfg?.agent ??
        config.agent ??
        get().agent ??
        'opencode';
      const agentModels = userCfg?.agentModels ?? config.agentModels ?? {};
      const sandboxProvider =
        overrides?.sandboxProvider ??
        userCfg?.sandboxProvider ??
        config.sandboxProvider ??
        get().sandboxProvider ??
        'docker';
      const submitMode =
        overrides?.submitMode ??
        userCfg?.submitMode ??
        config.submitMode ??
        get().submitMode ??
        'interactive';

      // For the model: override > agentModels[agent] > config.model > null
      const modelId =
        overrides?.model ?? agentModels[agent] ?? config.model ?? null;

      set({
        agent,
        modelId,
        sandboxProvider,
        submitMode,
        agentModels,
        initialized: true,
      });
    },

    setAgent: (newAgent) => {
      const { agent: prevAgent, modelId, agentModels } = get();
      if (newAgent === prevAgent) return;

      // Save current model for the old agent
      const updatedAgentModels = { ...agentModels };
      if (modelId) {
        updatedAgentModels[prevAgent] = modelId;
      }

      // Restore model for the new agent (or null if none persisted)
      const restoredModel = updatedAgentModels[newAgent] ?? null;

      set({
        agent: newAgent,
        modelId: restoredModel,
        agentModels: updatedAgentModels,
      });

      // Persist — single coalesced write for agent + agentModels
      queueWrite({
        agent: newAgent,
        ...(modelId ? { agentModels: updatedAgentModels } : {}),
      });
    },

    setModelId: (modelId) => {
      const { agent, agentModels } = get();
      set({ modelId });

      // Persist non-null selections to agentModels
      if (modelId) {
        const updated = { ...agentModels, [agent]: modelId };
        set({ agentModels: updated });
        queueWrite({ agentModels: updated });
      }
    },

    setSandboxProvider: (provider) => {
      set({ sandboxProvider: provider });
      queueWrite({ sandboxProvider: provider });
    },

    setSubmitMode: (mode) => {
      set({ submitMode: mode });
      queueWrite({ submitMode: mode });
    },

    getAgentModel: (agent) => {
      return get().agentModels[agent];
    },

    hasExplicitModel: (agent) => {
      return get().agentModels[agent] !== undefined;
    },
  }),
);
