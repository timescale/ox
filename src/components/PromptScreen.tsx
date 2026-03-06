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
import type {
  OxSession,
  SandboxProviderType,
  SubmitMode,
} from '../services/sandbox';
import type { SlashCommand } from '../services/slashCommands.ts';
import { usePromptHistoryStore } from '../stores/promptHistoryStore.ts';
import { useReadinessStore } from '../stores/readinessStore.ts';
import { useTheme } from '../stores/themeStore.ts';
import { BackgroundTaskIndicator } from './BackgroundTaskIndicator';
import { FilterableSelector } from './FilterableSelector';
import { HotkeysBar } from './HotkeysBar';
import { Modal } from './Modal';
import { OxTitle } from './OxTitle';
import { ReadinessStatus } from './ReadinessStatus.tsx';
import { Selector } from './Selector';
import { SlashCommandPopover } from './SlashCommandPopover.tsx';
import { ThemePicker } from './ThemePicker.tsx';
import { Toast, type ToastType } from './Toast';

export interface PromptScreenProps {
  defaultAgent: AgentType;
  defaultModel?: string | null;
  defaultSandboxProvider?: SandboxProviderType;
  /** Default submit mode (preserved from prior session on resume) */
  defaultSubmitMode?: SubmitMode;
  resumeSession?: OxSession; // If set, we're resuming this session
  /** Initial mount directory from CLI flag (enables mount mode if set) */
  initialMountDir?: string | null;
  /** If true, mount mode is forced (no GitHub remote available) */
  forceMountMode?: boolean;
  onSubmit: (result: {
    prompt: string;
    agent: AgentType;
    model: string;
    mode: SubmitMode;
    /** If set, mount this directory instead of git clone */
    mountDir?: string;
    sandboxProvider: SandboxProviderType;
  }) => void;
  onShell: (mountDir?: string, sandboxProvider?: SandboxProviderType) => void; // Launch bash shell
  onCancel: () => void;
  onViewSessions?: () => void;
  /** Reset to a fresh new-prompt screen (clears resume state + all settings) */
  onNewPrompt?: () => void;
}

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

export function PromptScreen({
  defaultAgent,
  defaultModel = null,
  defaultSandboxProvider,
  defaultSubmitMode,
  resumeSession,
  initialMountDir,
  forceMountMode = false,
  onSubmit,
  onShell,
  onViewSessions,
  onNewPrompt,
}: PromptScreenProps) {
  const { theme } = useTheme();
  const textareaRef = useRef<TextareaRenderable>(null);
  const inputAnchorRef = useRef<BoxRenderable | null>(null);
  const [agent, setAgent] = useState<AgentType>(defaultAgent);
  const [sandboxProvider, setSandboxProvider] = useState<SandboxProviderType>(
    defaultSandboxProvider ?? 'docker',
  );
  const [modelId, setModelId] = useState<string | null>(defaultModel);
  const modelMem = useRef<Partial<Record<AgentType, string | null>>>({
    [defaultAgent]: defaultModel,
  });
  // Track the last non-null model across any agent, used for cross-agent
  // equivalent matching when models load asynchronously.
  const lastModelRef = useRef<string | null>(defaultModel);
  // Only remember non-null selections so the memo always holds the
  // last *good* model per agent (null means "nothing chosen yet").
  if (modelId) {
    modelMem.current[agent] = modelId;
    lastModelRef.current = modelId;
  }
  const [showModelSelector, setShowModelSelector] = useState(false);
  const [showThemePicker, setShowThemePicker] = useState(false);
  const [showSlashCommands, setShowSlashCommands] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const [toast, setToast] = useState<ToastState | null>(null);
  const [submitMode, setSubmitMode] = useState<SubmitMode>(
    defaultSubmitMode ?? 'interactive',
  );
  // Mount mode state - enabled when initialMountDir is set, forced, or toggled via Ctrl+D
  // When forceMountMode is true, mount mode cannot be toggled off
  const [mountMode, setMountMode] = useState<boolean>(
    !!initialMountDir || forceMountMode,
  );
  const [mountDir, setMountDir] = useState<string | null>(
    initialMountDir ?? (forceMountMode ? process.cwd() : null),
  );
  const imageReady = useReadinessStore((s) => s.sandboxImage === 'ready');
  const modelsMap = useAgentModels(null, imageReady);
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
  // Priority chain:
  //  1. Remembered model for this agent (modelMem)
  //  2. Equivalent of the last model from any agent (cross-agent matching)
  //  3. Equivalent of the configured default model
  //  4. Well-known fallbacks (opus, gpt) — avoids landing on niche models
  //  5. First model in the list (last resort)
  useEffect(() => {
    if (!currentModels?.length) return;
    if (modelId && currentModels.some((m) => m.id === modelId)) return;
    const best =
      // 1. Exact match for a previously-remembered model on this agent
      findExactModel(modelMem.current[agent] ?? null, currentModels) ??
      // 2. Equivalent of the last model the user had selected (any agent)
      findEquivalentModel(lastModelRef.current, currentModels) ??
      // 3. Equivalent of the configured default model
      findEquivalentModel(defaultModel, currentModels) ??
      // 4. Well-known fallbacks
      findPreferredFallback(currentModels) ??
      // 5. First available
      currentModels[0]?.id ??
      null;
    if (best && best !== modelId) {
      setModelId(best);
    }
  }, [agent, modelId, defaultModel, currentModels]);

  // Trigger credential check for the active agent when image becomes ready,
  // or when the selected model changes (different models may need different credentials).
  // Skip if modelId is null — the auto-select effect above will set it, which
  // will re-trigger this effect with the correct model.
  useEffect(() => {
    if (!imageReady || !modelId) return;
    useReadinessStore.getState().checkAgentAuth(agent, modelId);
  }, [imageReady, agent, modelId]);

  // Handle agent switch with model matching (disabled when resuming)
  const switchAgent = useCallback(() => {
    // Don't allow switching agents when resuming a session
    if (resumeSession) return;

    const newAgent =
      AGENTS[(AGENTS.indexOf(agent) + 1) % AGENTS.length] ||
      defaultAgent ||
      DEFAULT_AGENT;
    setAgent(newAgent);
    const models = modelsMapRef.current;
    const newModelId =
      modelMem.current[newAgent] ||
      findEquivalentModel(modelId, models[newAgent]) ||
      models[newAgent]?.[0]?.id ||
      null;
    setModelId(newModelId);
    // Credential re-check is handled by the useEffect on [imageReady, agent, modelId]
  }, [resumeSession, agent, defaultAgent, modelId]);

  // Suspend command keybind dispatch when sub-modals are open
  const suspend = useCommandStore((s) => s.suspend);
  const isCmdPaletteOpen = useCommandStore((s) => s.isOpen);
  useEffect(() => {
    if (showModelSelector || showThemePicker) {
      return suspend();
    }
  }, [showModelSelector, showThemePicker, suspend]);

  // Register commands for the command palette
  useRegisterCommands(
    () => [
      {
        id: 'mode.cycle',
        title: 'Switch interaction mode',
        description: 'Cycle between interactive, plan, and async modes',
        category: 'Prompt',
        keybind: { key: 'tab', shift: true, display: 'shift+tab' },
        onSelect: () =>
          setSubmitMode((m) => {
            if (m === 'async') return 'interactive';
            if (m === 'interactive') return 'plan';
            return 'async';
          }),
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
        onSelect: () =>
          onShell(
            mountMode ? (mountDir ?? undefined) : undefined,
            sandboxProvider,
          ),
      },
      {
        id: 'sessions.view',
        title: 'View sessions list',
        description: 'Browse and manage existing sessions',
        category: 'Session',
        keybind: { key: 'l', ctrl: true },
        onSelect: () => onViewSessions?.(),
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
        onSelect: () => {
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
          setSandboxProvider((p) => {
            if (p === 'docker') {
              // Switching to cloud — disable mount mode (not supported)
              if (mountMode && !forceMountMode) {
                setMountMode(false);
              }
              return 'cloud';
            }
            return 'docker';
          });
        },
      },
      {
        id: 'task.new',
        title: 'New task',
        description: 'Reset to a fresh new prompt',
        category: 'Navigation',
        keybind: { key: 'n', ctrl: true },
        enabled: !!onNewPrompt,
        onSelect: () => onNewPrompt?.(),
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
      mountMode,
      forceMountMode,
      mountDir,
      sandboxProvider,
      onShell,
      onViewSessions,
      onNewPrompt,
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
          onViewSessions?.();
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
          setSandboxProvider((p) => {
            if (p === 'docker') {
              // Switching to cloud — disable mount mode
              if (mountMode && !forceMountMode) {
                setMountMode(false);
              }
              return 'cloud';
            }
            return 'docker';
          });
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
          setSubmitMode('async');
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
          setSubmitMode('interactive');
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
          setSubmitMode('plan');
        },
      },
    ],
    [
      resumeSession,
      currentModels,
      onViewSessions,
      switchAgent,
      mountMode,
      forceMountMode,
      sandboxProvider,
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
    if (submitMode === 'async') {
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
      { agent, model: modelId, mode: submitMode, mountMode, mountDir },
      'Submitting prompt',
    );

    // Record prompt in history (skips empty and consecutive duplicates)
    usePromptHistoryStore.getState().addEntry(promptText);

    onSubmit({
      prompt: promptText,
      agent,
      model: modelId,
      mode: submitMode,
      mountDir: mountMode ? (mountDir ?? process.cwd()) : undefined,
      sandboxProvider,
    });
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
                  !showModelSelector && !showThemePicker && !isCmdPaletteOpen
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
                <text fg={agentInfo?.color}>{agentInfo?.name || agent}</text>
                {submitMode === 'async' ? (
                  <text fg={theme.success}>[async]</text>
                ) : submitMode === 'plan' ? (
                  <text fg={theme.info}>[plan]</text>
                ) : null}
                {sandboxProvider === 'cloud' ? (
                  <text fg={theme.accent}>[cloud]</text>
                ) : mountMode ? (
                  <text fg={theme.warning}>[mount]</text>
                ) : null}
                <text fg={model?.name ? theme.text : theme.textMuted}>
                  {model?.name || modelId || 'Loading...'}
                </text>
                {model?.description ? (
                  <text fg={theme.textMuted}>{model.description}</text>
                ) : null}
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
          <ReadinessStatus agent={agent} />
          <HotkeysBar
            keyList={[
              ['tab', 'agent'],
              ...(resumeSession
                ? []
                : [['shift+tab', 'mode'] as [string, string]]),
              ['ctrl+space', 'model'],
              ...(resumeSession
                ? []
                : [['ctrl+e', 'provider'] as [string, string]]),
              ['ctrl+l', 'sessions'],
              ['ctrl+p', 'commands'],
            ]}
          />
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
