import { homedir } from 'node:os';
import type {
  BoxRenderable,
  MouseEvent,
  TextareaRenderable,
} from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import packageJson from '../../package.json' with { type: 'json' };
import {
  AGENT_INFO_MAP,
  AGENTS,
  type AgentInfo,
  DEFAULT_AGENT,
  type Model,
  openCodeIdToModel,
  useAgentModels,
} from '../services/agents';
import { useCommandStore, useRegisterCommands } from '../services/commands.tsx';
import type { AgentType } from '../services/config';
import { log } from '../services/logger';
import type { AgentMode, SandboxProviderType } from '../services/sandbox';
import type { SlashCommand } from '../services/slashCommands.ts';
import { usePromptHistoryStore } from '../stores/promptHistoryStore.ts';
import { usePromptSettingsStore } from '../stores/promptSettingsStore.ts';
import { useReadinessStore } from '../stores/readinessStore.ts';
import { useRepoStore } from '../stores/repoStore.ts';
import { useRouterStore } from '../stores/routerStore.ts';
import { useSessionWorkflowStore } from '../stores/sessionWorkflowStore.ts';
import { useTheme } from '../stores/themeStore.ts';
import { ActionButton } from './ActionButton.tsx';
import { BackgroundTaskIndicator } from './BackgroundTaskIndicator';
import { FeedbackModal } from './FeedbackModal';
import { FilterableSelector } from './FilterableSelector';
import { Modal } from './Modal';
import { OxTitle } from './OxTitle';
import { ReadinessStatus } from './ReadinessStatus.tsx';
import { Selector } from './Selector';
import { SlashCommandPopover } from './SlashCommandPopover.tsx';
import { ThemePicker } from './ThemePicker.tsx';
import { Toast, type ToastType } from './Toast';

interface ToastState {
  message: string;
  type: ToastType;
}

/**
 * Find an equivalent model when switching agents.
 * Tries to match by model family name (opus, sonnet, haiku, gpt).
 * Returns null if no family match is found (does NOT fall back to first).
 */
function findEquivalentModel(
  currentModel: string | null,
  targetModels: null | readonly Model[],
): string | null {
  if (!currentModel || !targetModels?.length) {
    return null;
  }

  const lower = currentModel.toLowerCase();

  // Try to match by model family name
  const families = ['opus', 'sonnet', 'haiku', 'gpt'];
  for (const family of families) {
    if (lower.includes(family)) {
      const match = targetModels.findLast((m) =>
        m.id.toLowerCase().includes(family),
      );
      if (match) return match.id;
    }
  }

  return null;
}

/**
 * Check if a model ID exists in the target list (exact match).
 */
function findExactModel(
  modelId: string | null,
  targetModels: null | readonly Model[],
): string | null {
  if (!modelId || !targetModels?.length) return null;
  const match = targetModels.find((m) => m.id === modelId);
  return match?.id ?? null;
}

/** Well-known fallback model ID fragments, in priority order. */
const PREFERRED_FALLBACKS = ['opus', 'gpt'];

/**
 * Find the first model matching any preferred fallback family.
 * Avoids landing on niche/unknown models when no equivalent is found.
 */
function findPreferredFallback(targetModels: readonly Model[]): string | null {
  for (const family of PREFERRED_FALLBACKS) {
    const match = targetModels.findLast((m) =>
      m.id.toLowerCase().includes(family),
    );
    if (match) return match.id;
  }
  return null;
}

export function PromptScreen() {
  const { theme } = useTheme();
  const textareaRef = useRef<TextareaRenderable>(null);
  const inputAnchorRef = useRef<BoxRenderable | null>(null);

  // ---- Derive props from stores ----
  const view = useRouterStore((s) => s.view);
  const resumeSession = view.type === 'prompt' ? view.resumeSession : undefined;
  const goToList = useRouterStore((s) => s.goToList);

  const config = useSessionWorkflowStore((s) => s.config);
  const isGitRepo = useRepoStore((s) => s.isGitRepo);
  const forceMountMode = !isGitRepo;
  const storeInitialMountDir = useSessionWorkflowStore(
    (s) => s.initialMountDir,
  );
  const initialMountDir = resumeSession?.mountDir ?? storeInitialMountDir;
  const defaultModel = resumeSession?.model ?? config?.model ?? null;
  const startSession = useSessionWorkflowStore((s) => s.startSession);
  const resumeSessionFlow = useSessionWorkflowStore((s) => s.resumeSessionFlow);
  const startShellSession = useSessionWorkflowStore((s) => s.startShellSession);

  // ---- Persisted settings from Zustand store ----
  // When resuming a session, the session's values override the store.
  // Setters are no-ops during resume so the store isn't mutated.
  const storedAgent = usePromptSettingsStore((s) => s.agent);
  const storedModelId = usePromptSettingsStore((s) => s.modelId);
  const storedSandboxProvider = usePromptSettingsStore(
    (s) => s.sandboxProvider,
  );
  const storedAgentMode = usePromptSettingsStore((s) => s.agentMode);

  const agent = resumeSession?.agent ?? storedAgent;
  const modelId = resumeSession?.model ?? storedModelId;
  const sandboxProvider = resumeSession?.provider ?? storedSandboxProvider;
  const agentMode = resumeSession?.agentMode ?? storedAgentMode;

  const storeSetAgent = usePromptSettingsStore((s) => s.setAgent);
  const storeSetModelId = usePromptSettingsStore((s) => s.setModelId);
  const storeSetSandboxProvider = usePromptSettingsStore(
    (s) => s.setSandboxProvider,
  );
  const storeSetAgentMode = usePromptSettingsStore((s) => s.setAgentMode);

  const setAgent = useCallback(
    (a: AgentType) => {
      if (!resumeSession) storeSetAgent(a);
    },
    [resumeSession, storeSetAgent],
  );
  const setModelId = useCallback(
    (m: string | null) => {
      if (!resumeSession) storeSetModelId(m);
    },
    [resumeSession, storeSetModelId],
  );
  const setSandboxProvider = useCallback(
    (p: SandboxProviderType) => {
      if (!resumeSession) storeSetSandboxProvider(p);
    },
    [resumeSession, storeSetSandboxProvider],
  );
  const setAgentMode = useCallback(
    (m: AgentMode) => {
      if (!resumeSession) storeSetAgentMode(m);
    },
    [resumeSession, storeSetAgentMode],
  );

  const [showModelSelector, setShowModelSelector] = useState(false);
  const [showThemePicker, setShowThemePicker] = useState(false);
  const [showFeedbackModal, setShowFeedbackModal] = useState(false);
  const [showSlashCommands, setShowSlashCommands] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const [toast, setToast] = useState<ToastState | null>(null);
  // Mount mode state - enabled when initialMountDir is set, forced, or toggled via Ctrl+D
  // When forceMountMode is true, mount mode cannot be toggled off
  const [mountMode, setMountMode] = useState<boolean>(
    !!initialMountDir || forceMountMode,
  );
  const [mountDir, setMountDir] = useState<string | null>(
    initialMountDir ?? (forceMountMode ? process.cwd() : null),
  );
  const imageReady = useReadinessStore((s) => s.sandboxBaseImage === 'ready');
  const modelsMap = useAgentModels(null, imageReady, agent);
  // Ref so callbacks can read the latest modelsMap without depending on the
  // object reference (which changes when models finish loading).
  const modelsMapRef = useRef(modelsMap);
  modelsMapRef.current = modelsMap;
  const currentModels = modelsMap[agent];
  const agentInfo: AgentInfo = AGENT_INFO_MAP[agent];
  const model =
    currentModels?.find((m) => m.id === modelId) ??
    (modelId && agent === 'opencode' ? openCodeIdToModel(modelId) : null);

  // Prompt history — initialize store on mount
  useEffect(() => {
    usePromptHistoryStore.getState().initialize();
  }, []);

  // Auto-select a model when models load for the current agent and the current
  // modelId is null or doesn't match any loaded model.  This handles the
  // quick-switch case: user presses Tab before OpenCode models have loaded,
  // so modelId is null.  Once models arrive we pick the best match.
  //
  // If the user has an explicit model selection for this agent (persisted in
  // agentModels), we try that first and only fall through to the heuristic
  // chain if it no longer exists in the model list.
  //
  // Fallback priority chain (only when no explicit selection):
  //  1. Equivalent of the configured default model
  //  2. Well-known fallbacks (opus, gpt) — avoids landing on niche models
  //  3. First model in the list (last resort)
  useEffect(() => {
    if (!currentModels?.length) return;
    const activeModelId = modelId;
    if (activeModelId && currentModels.some((m) => m.id === activeModelId))
      return;

    const { hasExplicitModel, getAgentModel } =
      usePromptSettingsStore.getState();

    // If the user previously picked a model for this agent, try exact match
    const explicit = getAgentModel(agent);
    if (explicit) {
      const exactMatch = findExactModel(explicit, currentModels);
      if (exactMatch) {
        setModelId(exactMatch);
        return;
      }
    }

    // No explicit selection or it no longer exists — run heuristic chain
    // (only if user never explicitly chose for this agent)
    if (!hasExplicitModel(agent)) {
      const best =
        // 1. Equivalent of the configured default model
        findEquivalentModel(defaultModel, currentModels) ??
        // 2. Well-known fallbacks
        findPreferredFallback(currentModels) ??
        // 3. First available
        currentModels[0]?.id ??
        null;
      if (best && best !== activeModelId) {
        setModelId(best);
      }
    }
  }, [agent, modelId, defaultModel, currentModels, setModelId]);

  // Trigger credential check for the active agent when image becomes ready,
  // or when the selected model changes (different models may need different credentials).
  // Skip if modelId is null — the auto-select effect above will set it, which
  // will re-trigger this effect with the correct model.
  useEffect(() => {
    if (!imageReady || !modelId) return;
    useReadinessStore.getState().checkAgentAuth(agent, modelId);
  }, [imageReady, agent, modelId]);

  // Prebuild agent-specific sandbox image as soon as the base image is ready
  // and the agent + provider are known. This runs in the background so the
  // overlay is likely cached by the time the user submits their prompt.
  useEffect(() => {
    if (!imageReady) return;
    useReadinessStore.getState().prebuildAgentImage(agent, sandboxProvider);
  }, [imageReady, agent, sandboxProvider]);

  // Handle agent switch with model matching (disabled when resuming).
  // The store's setAgent already saves the current model and restores
  // the new agent's persisted model.  We only need the equivalent-model
  // fallback when the store has nothing for the new agent.
  const switchAgent = useCallback(() => {
    if (resumeSession) return;

    const currentAgent = agent;
    const newAgent =
      AGENTS[(AGENTS.indexOf(currentAgent) + 1) % AGENTS.length] ||
      DEFAULT_AGENT;
    // Store handles saving old model + restoring new agent's model
    setAgent(newAgent);

    // If the store didn't restore a model (i.e. null), try equivalent match
    const restoredModel = usePromptSettingsStore.getState().modelId;
    if (!restoredModel) {
      const models = modelsMapRef.current;
      const fallback =
        findEquivalentModel(modelId, models[newAgent]) ||
        models[newAgent]?.[0]?.id ||
        null;
      if (fallback) {
        setModelId(fallback);
      }
    }
  }, [resumeSession, agent, modelId, setAgent, setModelId]);

  // Toggle sandbox provider (extracted so click handler can reuse it)
  const toggleProvider = useCallback(() => {
    if (resumeSession) {
      setToast({
        message: 'Provider cannot be changed when resuming a session.',
        type: 'warning',
      });
      return;
    }
    if (forceMountMode && sandboxProvider === 'docker') {
      setToast({
        message:
          'Cloud sandboxes require a git remote. Add a remote or use Docker.',
        type: 'warning',
      });
      return;
    }
    if (sandboxProvider === 'docker') {
      if (mountMode && !forceMountMode) {
        setMountMode(false);
      }
      setSandboxProvider('cloud');
    } else {
      setSandboxProvider('docker');
    }
  }, [
    resumeSession,
    forceMountMode,
    sandboxProvider,
    mountMode,
    setSandboxProvider,
  ]);

  // Suspend command keybind dispatch when sub-modals are open
  const suspend = useCommandStore((s) => s.suspend);
  const showCommands = useCommandStore((s) => s.show);
  const isCmdPaletteOpen = useCommandStore((s) => s.isOpen);
  const isSuspended = useCommandStore((s) => s.suspendCount > 0);
  useEffect(() => {
    if (showModelSelector || showThemePicker || showFeedbackModal) {
      return suspend();
    }
  }, [showModelSelector, showThemePicker, showFeedbackModal, suspend]);

  // Register commands for the command palette
  useRegisterCommands(
    () => [
      {
        id: 'mode.cycle',
        title: 'Switch interaction mode',
        description: 'Cycle between interactive, plan, and async modes',
        category: 'Prompt',
        keybind: { key: 'tab', shift: true, display: 'shift+tab' },
        onSelect: () => {
          const m = agentMode;
          if (m === 'async') setAgentMode('interactive');
          else if (m === 'interactive') setAgentMode('plan');
          else setAgentMode('async');
        },
      },
      {
        id: 'agent.switch',
        title: 'Switch agent',
        description: 'Cycle through available AI agents',
        category: 'Agent',
        keybind: { key: 'tab', display: 'tab' },
        hidden: !!resumeSession,
        onSelect: switchAgent,
      },
      {
        id: 'model.select',
        title: 'Select model',
        description: 'Choose the AI model to use',
        category: 'Agent',
        keybind: { key: 'space', ctrl: true, display: 'ctrl+space' },
        enabled: !!currentModels?.length,
        onSelect: () => setShowModelSelector(true),
      },
      {
        id: 'shell.launch',
        title: 'Launch shell',
        description: 'Open a bash shell in a sandbox container',
        category: 'System',
        keybind: { key: 's', ctrl: true },
        hidden: true,
        onSelect: () => {
          const shellMountDir = mountMode ? (mountDir ?? undefined) : undefined;
          if (resumeSession) {
            useRouterStore
              .getState()
              .exitShell(resumeSession.id, resumeSession.provider);
          } else {
            startShellSession(shellMountDir, isGitRepo, sandboxProvider);
          }
        },
      },
      {
        id: 'sessions.view',
        title: 'View sessions list',
        description: 'Browse and manage existing sessions',
        category: 'Navigation',
        keybind: { key: 'l', ctrl: true },
        onSelect: goToList,
      },
      {
        id: 'mount.toggle',
        title: `${mountMode ? 'Disable' : 'Enable'} local mount mode`,
        description: forceMountMode
          ? 'Mount mode is required (no git remote)'
          : sandboxProvider === 'cloud'
            ? 'Mount mode is not available with cloud sandboxes'
            : 'Toggle between git clone and local directory mount',
        category: 'Prompt',
        keybind: { key: 'd', ctrl: true },
        enabled: !forceMountMode && sandboxProvider !== 'cloud',
        onSelect: () => {
          if (sandboxProvider === 'cloud') {
            setToast({
              message: 'Mount mode is not available with cloud sandboxes',
              type: 'warning',
            });
            return;
          }
          setMountMode((m) => {
            if (!m) setMountDir(process.cwd());
            return !m;
          });
        },
      },
      {
        id: 'provider.toggle',
        title: `Switch to ${sandboxProvider === 'docker' ? 'cloud' : 'Docker'} provider`,
        description: resumeSession
          ? 'Provider is locked when resuming a session'
          : forceMountMode && sandboxProvider === 'docker'
            ? 'Cloud sandboxes require a git remote'
            : 'Toggle between Docker and Cloud sandbox providers',
        category: 'Prompt',
        keybind: { key: 'e', ctrl: true },
        hidden: !!resumeSession,
        enabled:
          !resumeSession && !(forceMountMode && sandboxProvider === 'docker'),
        onSelect: toggleProvider,
      },
      {
        id: 'navigate-resources',
        title: 'Manage Resources',
        description: 'View and manage sandbox images, volumes, and snapshots',
        category: 'Navigation',
        onSelect: () => useRouterStore.getState().goToResources(),
      },
      {
        id: 'task.new',
        title: 'New task',
        description: 'Reset to a fresh new prompt',
        category: 'Navigation',
        keybind: { key: 'n', ctrl: true },
        onSelect: () => useRouterStore.getState().goToNewPrompt(),
      },
      {
        id: 'theme.select',
        title: 'Select theme',
        description: 'Change the color theme',
        category: 'System',
        keybind: { key: 't', ctrl: true },
        onSelect: () => setShowThemePicker(true),
      },
    ],
    [
      resumeSession,
      currentModels,
      switchAgent,
      toggleProvider,
      mountMode,
      forceMountMode,
      mountDir,
      sandboxProvider,
      agentMode,
      setSandboxProvider,
      setAgentMode,
      isGitRepo,
      startShellSession,
    ],
  );

  // Define available slash commands
  const slashCommands: SlashCommand[] = useMemo(
    () => [
      {
        name: 'agent',
        description: 'Switch agent',
        onSelect: () => {
          setShowSlashCommands(false);
          setSlashQuery('');
          if (textareaRef.current) {
            textareaRef.current.clear();
          }
          if (!resumeSession) {
            switchAgent();
          }
        },
      },
      {
        name: 'model',
        description: 'Switch model',
        onSelect: () => {
          setShowSlashCommands(false);
          setSlashQuery('');
          if (textareaRef.current) {
            textareaRef.current.clear();
          }
          if (currentModels?.length) {
            setShowModelSelector(true);
          }
        },
      },
      {
        name: 'config',
        description: 'Run the configuration wizard',
        onSelect: () => {
          setShowSlashCommands(false);
          setSlashQuery('');
          if (textareaRef.current) {
            textareaRef.current.clear();
          }
          useRouterStore.getState().goToConfig({ resumeSession });
        },
      },
      {
        name: 'setup-db',
        description: 'Configure the Tiger database service for this project',
        onSelect: () => {
          setShowSlashCommands(false);
          setSlashQuery('');
          if (textareaRef.current) {
            textareaRef.current.clear();
          }
          useRouterStore.getState().goToSetupDb({ resumeSession });
        },
      },
      {
        name: 'theme',
        description: 'Change UI theme',
        onSelect: () => {
          setShowSlashCommands(false);
          setSlashQuery('');
          if (textareaRef.current) {
            textareaRef.current.clear();
          }
          setShowThemePicker(true);
        },
      },
      {
        name: 'sessions',
        description: 'View sessions list',
        onSelect: () => {
          setShowSlashCommands(false);
          setSlashQuery('');
          if (textareaRef.current) {
            textareaRef.current.clear();
          }
          goToList();
        },
      },
      {
        name: 'resources',
        description: 'Manage sandbox resources',
        onSelect: () => {
          setShowSlashCommands(false);
          setSlashQuery('');
          if (textareaRef.current) {
            textareaRef.current.clear();
          }
          useRouterStore.getState().goToResources();
        },
      },
      {
        name: 'mount',
        description: forceMountMode
          ? 'Local mount mode required'
          : sandboxProvider === 'cloud'
            ? 'Mount mode is not available with cloud sandboxes'
            : mountMode
              ? 'Disable local mount mode (use git clone)'
              : 'Enable local mount mode (use local directory)',
        onSelect: () => {
          setShowSlashCommands(false);
          setSlashQuery('');
          if (textareaRef.current) {
            textareaRef.current.clear();
          }
          // Don't allow toggling mount mode off when forced
          if (forceMountMode) {
            return;
          }
          // Don't allow mount mode with cloud sandboxes
          if (sandboxProvider === 'cloud') {
            setToast({
              message: 'Mount mode is not available with cloud sandboxes',
              type: 'warning',
            });
            return;
          }
          setMountMode((m) => {
            if (!m) {
              // Enabling mount mode - set default mount dir to cwd
              setMountDir(process.cwd());
            }
            return !m;
          });
        },
      },
      {
        name: 'cloud',
        description: resumeSession
          ? 'Provider is locked when resuming a session'
          : forceMountMode
            ? 'Cloud sandboxes require a git remote'
            : 'Use cloud sandbox provider',
        onSelect: () => {
          setShowSlashCommands(false);
          setSlashQuery('');
          if (textareaRef.current) {
            textareaRef.current.clear();
          }
          if (resumeSession) {
            setToast({
              message: 'Provider cannot be changed when resuming a session.',
              type: 'warning',
            });
            return;
          }
          if (forceMountMode) {
            setToast({
              message:
                'Cloud sandboxes require a git remote. Add a remote or use Docker.',
              type: 'warning',
            });
            return;
          }
          // Disable mount mode when switching to cloud
          if (mountMode) {
            setMountMode(false);
          }
          setSandboxProvider('cloud');
        },
      },
      {
        name: 'docker',
        description: resumeSession
          ? 'Provider is locked when resuming a session'
          : 'Use Docker sandbox provider',
        onSelect: () => {
          setShowSlashCommands(false);
          setSlashQuery('');
          if (textareaRef.current) {
            textareaRef.current.clear();
          }
          if (resumeSession) {
            setToast({
              message: 'Provider cannot be changed when resuming a session.',
              type: 'warning',
            });
            return;
          }
          setSandboxProvider('docker');
        },
      },
      {
        name: 'provider',
        description: resumeSession
          ? 'Provider is locked when resuming a session'
          : 'Toggle sandbox provider',
        onSelect: () => {
          setShowSlashCommands(false);
          setSlashQuery('');
          if (textareaRef.current) {
            textareaRef.current.clear();
          }
          if (resumeSession) {
            setToast({
              message: 'Provider cannot be changed when resuming a session.',
              type: 'warning',
            });
            return;
          }
          if (forceMountMode && sandboxProvider === 'docker') {
            setToast({
              message:
                'Cloud sandboxes require a git remote. Add a remote or use Docker.',
              type: 'warning',
            });
            return;
          }
          if (sandboxProvider === 'docker') {
            // Switching to cloud — disable mount mode
            if (mountMode && !forceMountMode) {
              setMountMode(false);
            }
            setSandboxProvider('cloud');
          } else {
            setSandboxProvider('docker');
          }
        },
      },
      {
        name: 'async',
        description: 'Switch to async mode (detached)',
        onSelect: () => {
          setShowSlashCommands(false);
          setSlashQuery('');
          if (textareaRef.current) {
            textareaRef.current.clear();
          }
          setAgentMode('async');
        },
      },
      {
        name: 'interactive',
        description: 'Switch to interactive mode (attached)',
        onSelect: () => {
          setShowSlashCommands(false);
          setSlashQuery('');
          if (textareaRef.current) {
            textareaRef.current.clear();
          }
          setAgentMode('interactive');
        },
      },
      {
        name: 'plan',
        description: 'Switch to plan mode (interactive, read-only agent)',
        onSelect: () => {
          setShowSlashCommands(false);
          setSlashQuery('');
          if (textareaRef.current) {
            textareaRef.current.clear();
          }
          setAgentMode('plan');
        },
      },
      {
        name: 'feedback',
        description: 'Send feedback to the ox team',
        onSelect: () => {
          setShowSlashCommands(false);
          setSlashQuery('');
          if (textareaRef.current) {
            textareaRef.current.clear();
          }
          setShowFeedbackModal(true);
        },
      },
    ],
    [
      resumeSession,
      currentModels,
      switchAgent,
      mountMode,
      forceMountMode,
      sandboxProvider,
      setSandboxProvider,
      setAgentMode,
      goToList,
    ],
  );

  // Handle model selection from modal
  const handleModelSelect = (selectedModel: string | null) => {
    log.debug({ selectedModel, currentModelId: modelId }, 'Model selected');
    if (selectedModel) {
      setModelId(selectedModel);
    }
    setShowModelSelector(false);
  };

  // Track if slash commands are showing (for preventing submit)
  const showSlashCommandsRef = useRef(false);
  showSlashCommandsRef.current = showSlashCommands;

  // Handle submit
  const handleSubmitImpl = () => {
    // Don't submit if slash commands popover is showing
    if (showSlashCommandsRef.current) {
      return;
    }

    const promptText = textareaRef.current?.plainText.trim() || '';

    // Prompt validation only applies in async mode
    if (agentMode === 'async') {
      if (!promptText) {
        setToast({ message: 'Please enter a prompt', type: 'error' });
        return;
      }
      if (!promptText.includes(' ')) {
        setToast({
          message: 'Prompt must be more than one word',
          type: 'error',
        });
        return;
      }
    }
    if (!modelId) {
      setToast({ message: 'Please select a model', type: 'error' });
      return;
    }
    log.debug(
      {
        agent: agent,
        model: modelId,
        mode: agentMode,
        mountMode,
        mountDir,
      },
      'Submitting prompt',
    );

    // Record prompt in history (skips empty and consecutive duplicates)
    usePromptHistoryStore.getState().addEntry(promptText);

    const effectiveMountDir = mountMode
      ? (mountDir ?? process.cwd())
      : undefined;
    if (resumeSession) {
      resumeSessionFlow(
        resumeSession,
        promptText,
        modelId,
        agentMode,
        effectiveMountDir,
        sandboxProvider,
      );
    } else {
      startSession(
        promptText,
        agent,
        modelId,
        agentMode,
        effectiveMountDir,
        sandboxProvider,
      );
    }
  };

  // Use a ref to avoid stale closure issues with @opentui/react's textarea.
  // The textarea component caches the onSubmit handler, so we store the current
  // implementation in a ref and use a stable wrapper that calls through the ref.
  const handleSubmitRef = useRef(handleSubmitImpl);
  handleSubmitRef.current = handleSubmitImpl;
  const handleSubmit = () => handleSubmitRef.current();

  // Handle slash command selection
  const handleSlashCommandSelect = (command: SlashCommand) => {
    command.onSelect();
  };

  const handleSlashCommandCancel = () => {
    setShowSlashCommands(false);
    setSlashQuery('');
    // Clear the slash text from textarea
    if (textareaRef.current) {
      textareaRef.current.clear();
    }
  };

  // Check if current textarea content is a slash command
  const checkForSlashCommand = () => {
    const text = textareaRef.current?.plainText || '';
    if (text.startsWith('/')) {
      const query = text.slice(1); // Remove the "/"
      setSlashQuery(query);
      if (!showSlashCommands) {
        setShowSlashCommands(true);
      }
      return true;
    }
    if (showSlashCommands) {
      setShowSlashCommands(false);
      setSlashQuery('');
    }
    return false;
  };

  // Keyboard handling — slash command detection and prompt history navigation.
  // Action keybinds are handled by the centralized CommandPaletteHost.
  useKeyboard((key) => {
    if (showModelSelector || showThemePicker || isCmdPaletteOpen) return;

    // If slash commands are showing, let the popover handle navigation
    if (showSlashCommands) {
      // Still check for text changes on printable keys
      if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        // Defer check to after the character is typed
        setTimeout(checkForSlashCommand, 0);
      }
      if (key.name === 'backspace') {
        setTimeout(() => {
          checkForSlashCommand();
        }, 0);
      }
      return;
    }

    // Prompt history navigation with up/down arrows.
    // Mirrors opencode: up when cursor is at offset 0, down when at end.
    // When cursor is not yet at the boundary, snap it there so the next
    // press triggers history navigation.
    if (key.name === 'up' && !key.ctrl && !key.meta) {
      const textarea = textareaRef.current;
      if (!textarea) return;
      if (textarea.cursorOffset === 0) {
        const text = usePromptHistoryStore
          .getState()
          .move(-1, textarea.plainText);
        if (text !== undefined) {
          textarea.setText(text);
          textarea.cursorOffset = 0;
        }
        return;
      }
      // Cursor not at start — if on the first visual row, snap to start
      if (textarea.visualCursor.visualRow === 0) {
        textarea.cursorOffset = 0;
      }
    }

    if (key.name === 'down' && !key.ctrl && !key.meta) {
      const textarea = textareaRef.current;
      if (!textarea) return;
      if (textarea.cursorOffset === textarea.plainText.length) {
        const text = usePromptHistoryStore
          .getState()
          .move(1, textarea.plainText);
        if (text !== undefined) {
          textarea.setText(text);
          textarea.cursorOffset = textarea.plainText.length;
        }
        return;
      }
      // Cursor not at end — if on the last visual row, snap to end
      if (textarea.visualCursor.visualRow === textarea.virtualLineCount - 1) {
        textarea.cursorOffset = textarea.plainText.length;
      }
    }

    // Check for "/" key to start slash command
    if (key.sequence === '/') {
      const text = textareaRef.current?.plainText || '';
      // Only trigger slash commands if textarea is empty or we're at the start
      if (text === '' || text === '/') {
        setTimeout(checkForSlashCommand, 0);
      }
    }

    // Check after any key if we have slash text
    if (key.name === 'backspace') {
      setTimeout(checkForSlashCommand, 0);
    }
  });

  // Build model selector options
  const modelOptions =
    currentModels?.map((m) => ({
      name: m.name,
      description: m.description || '',
      value: m.id,
    })) ?? [];

  const modelIndex = modelOptions.findIndex((opt) => opt.value === modelId);

  return (
    <box
      backgroundColor={theme.background}
      flexDirection="column"
      flexGrow={1}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
    >
      <box
        flexDirection="column"
        flexGrow={1}
        alignItems="center"
        justifyContent="center"
      >
        <box width="100%" maxWidth={76} flexDirection="column">
          {/* ASCII Art Title */}
          <OxTitle />
          {/* Resume indicator */}
          {resumeSession && (
            <box marginBottom={1}>
              <text fg={theme.textMuted}>{'Resuming: '}</text>
              <text fg={theme.warning}>{resumeSession.name}</text>
            </box>
          )}

          {/* Main input box */}
          <box
            ref={inputAnchorRef}
            border={['left']}
            borderColor={agentInfo?.color}
            customBorderChars={{
              ...EmptyBorder,
              vertical: '\u2503',
              bottomLeft: '\u2579',
            }}
          >
            <box
              flexDirection="column"
              paddingTop={1}
              paddingLeft={2}
              paddingRight={2}
              flexShrink={0}
              flexGrow={1}
              backgroundColor={theme.backgroundElement}
            >
              {/* Prompt textarea */}
              <textarea
                ref={textareaRef}
                focused={
                  !showModelSelector &&
                  !showThemePicker &&
                  !showFeedbackModal &&
                  !isCmdPaletteOpen &&
                  !isSuspended
                }
                placeholder='Ask anything... Type "/" for commands'
                onSubmit={handleSubmit}
                onMouseDown={(r: MouseEvent) => r.target?.focus()}
                keyBindings={[
                  { name: 'return', ctrl: true, action: 'newline' },
                  { name: 'return', meta: true, action: 'newline' },
                  { name: 'return', shift: true, action: 'newline' },
                  { name: 'return', action: 'submit' },
                ]}
                backgroundColor={theme.backgroundElement}
                focusedBackgroundColor={theme.backgroundElement}
                textColor={theme.text}
                focusedTextColor={theme.text}
                minHeight={1}
                maxHeight={5}
              />

              {/* Agent and model display row */}
              <box flexDirection="row" marginTop={1} height={1} gap={1}>
                <text fg={agentInfo?.color} onMouseDown={() => switchAgent()}>
                  {agentInfo?.name || agent}
                </text>
                {agentMode === 'async' ? (
                  <text fg={theme.success}>[async]</text>
                ) : agentMode === 'plan' ? (
                  <text fg={theme.info}>[plan]</text>
                ) : null}
                <text
                  fg={model?.name ? theme.text : theme.textMuted}
                  onMouseDown={() => {
                    if (currentModels?.length) setShowModelSelector(true);
                  }}
                >
                  {model?.name || modelId || 'Loading...'}
                </text>
                <box flexGrow={1} />
                {sandboxProvider === 'cloud' ? (
                  <text fg={theme.accent} onMouseDown={() => toggleProvider()}>
                    cloud
                  </text>
                ) : (
                  <text fg={theme.primary} onMouseDown={() => toggleProvider()}>
                    docker
                  </text>
                )}
                {mountMode ? <text fg={theme.warning}>[mount]</text> : null}
              </box>
            </box>
          </box>
          {/* Half-height padding bottom */}
          <box
            height={1}
            border={['left']}
            borderColor={agentInfo?.color}
            customBorderChars={{
              ...EmptyBorder,
              vertical: '\u2579',
            }}
          >
            <box
              height={1}
              border={['bottom']}
              borderColor={theme.backgroundElement}
              customBorderChars={{
                ...EmptyBorder,
                horizontal: '\u2580',
              }}
            />
          </box>
          <box flexDirection="row-reverse" flexWrap="wrap" columnGap={1}>
            <ActionButton
              disabled={showSlashCommands}
              label="start"
              color={theme.primary}
              onPress={handleSubmit}
            />
            <box flexGrow={1} height={0} />
            <ActionButton
              label="sessions"
              keybind="^l"
              color={theme.textMuted}
              onPress={goToList}
            />
            <ActionButton
              label="commands"
              keybind="^p"
              color={theme.text}
              onPress={showCommands}
            />
          </box>
          <ReadinessStatus agent={agent} />
        </box>
      </box>
      <box height={1} flexDirection="row" width="100%">
        <box flexGrow={1}>
          <text fg={theme.textMuted}>
            {process.cwd().replace(homedir(), '~')}
          </text>
        </box>
        <box alignItems="flex-end">
          <text fg={theme.textMuted}>{packageJson.version}</text>
        </box>
      </box>
      {/* Model selector modal */}
      {showModelSelector && currentModels && (
        <Modal
          title={`Select Model (${agent})`}
          minWidth={60}
          maxWidth={80}
          onClose={() => setShowModelSelector(false)}
        >
          {agent === 'opencode' ? (
            <FilterableSelector
              title=""
              description="Select a model for OpenCode"
              options={modelOptions}
              initialIndex={modelIndex >= 0 ? modelIndex : 0}
              onSelect={handleModelSelect}
              onCancel={() => setShowModelSelector(false)}
            />
          ) : (
            <Selector
              title=""
              description="Select a model for Claude Code"
              options={modelOptions}
              initialIndex={modelIndex >= 0 ? modelIndex : 0}
              onSelect={handleModelSelect}
              onCancel={() => setShowModelSelector(false)}
            />
          )}
        </Modal>
      )}
      {/* Theme picker modal */}
      {showThemePicker && (
        <Modal
          title="Select Theme"
          minWidth={50}
          maxWidth={70}
          onClose={() => setShowThemePicker(false)}
        >
          <ThemePicker onClose={() => setShowThemePicker(false)} />
        </Modal>
      )}
      {/* Feedback modal */}
      {showFeedbackModal && (
        <FeedbackModal
          onClose={() => setShowFeedbackModal(false)}
          onSuccess={() =>
            setToast({ message: 'Feedback sent. Thanks!', type: 'success' })
          }
          onError={(msg) => setToast({ message: msg, type: 'error' })}
        />
      )}

      {/* Toast notifications */}
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onDismiss={() => setToast(null)}
        />
      )}

      {/* Slash command popover - absolute positioned relative to input */}
      {showSlashCommands && (
        <SlashCommandPopover
          query={slashQuery}
          commands={slashCommands}
          onSelect={handleSlashCommandSelect}
          onCancel={handleSlashCommandCancel}
          anchor={inputAnchorRef.current}
        />
      )}

      <BackgroundTaskIndicator />
    </box>
  );
}
export const EmptyBorder = {
  topLeft: '',
  bottomLeft: '',
  vertical: '',
  topRight: '',
  bottomRight: '',
  horizontal: ' ',
  bottomT: '',
  topT: '',
  cross: '',
  leftT: '',
  rightT: '',
};
