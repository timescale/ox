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
import type { AgentType } from '../services/config';
import type { HermesSession } from '../services/docker';
import { log } from '../services/logger';
import type { SlashCommand } from '../services/slashCommands.ts';
import { useTheme } from '../stores/themeStore.ts';
import { FilterableSelector } from './FilterableSelector';
import { HermesTitle } from './HermesTitle';
import { HotkeysBar } from './HotkeysBar';
import { Modal } from './Modal';
import { Selector } from './Selector';
import { SlashCommandPopover } from './SlashCommandPopover.tsx';
import { ThemePicker } from './ThemePicker.tsx';
import { Toast, type ToastType } from './Toast';

export type SubmitMode = 'async' | 'interactive';

export interface PromptScreenProps {
  defaultAgent: AgentType;
  defaultModel?: string | null;
  resumeSession?: HermesSession; // If set, we're resuming this session
  /** Initial mount directory from CLI flag (enables mount mode if set) */
  initialMountDir?: string | null;
  /** If true, mount mode is forced (no GitHub remote available) */
  forceMountMode?: boolean;
  /** Optional initial text to pre-fill in the textarea */
  initialPromptPrefix?: string;
  onSubmit: (result: {
    prompt: string;
    agent: AgentType;
    model: string;
    mode: SubmitMode;
    /** If set, mount this directory instead of git clone */
    mountDir?: string;
  }) => void;
  onShell: (mountDir?: string) => void; // Launch bash shell
  onCancel: () => void;
  onViewSessions?: () => void;
}

interface ToastState {
  message: string;
  type: ToastType;
}

/**
 * Find an equivalent model when switching agents.
 * Tries to match by model family name (opus, sonnet, haiku).
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
  const families = ['opus', 'sonnet', 'haiku'];
  for (const family of families) {
    if (lower.includes(family)) {
      const match = targetModels.findLast((m) =>
        m.id.toLowerCase().includes(family),
      );
      if (match) return match.id;
    }
  }

  // No match found, use first available
  return targetModels[0]?.id || null;
}

export function PromptScreen({
  defaultAgent,
  defaultModel = null,
  resumeSession,
  initialMountDir,
  forceMountMode = false,
  initialPromptPrefix,
  onSubmit,
  onShell,
  onViewSessions,
}: PromptScreenProps) {
  const { theme } = useTheme();
  const textareaRef = useRef<TextareaRenderable>(null);
  const inputAnchorRef = useRef<BoxRenderable | null>(null);
  const [agent, setAgent] = useState<AgentType>(defaultAgent);
  const [modelId, setModelId] = useState<string | null>(defaultModel);
  const modelMem = useRef({
    [defaultAgent]: defaultModel,
  });
  modelMem.current[agent] = modelId;
  const [showModelSelector, setShowModelSelector] = useState(false);
  const [showThemePicker, setShowThemePicker] = useState(false);
  const [showSlashCommands, setShowSlashCommands] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const [toast, setToast] = useState<ToastState | null>(null);
  const [submitMode, setSubmitMode] = useState<SubmitMode>('async');
  // Mount mode state - enabled when initialMountDir is set, forced, or toggled via Ctrl+D
  // When forceMountMode is true, mount mode cannot be toggled off
  const [mountMode, setMountMode] = useState<boolean>(
    !!initialMountDir || forceMountMode,
  );
  const [mountDir, setMountDir] = useState<string | null>(
    initialMountDir ?? (forceMountMode ? process.cwd() : null),
  );
  const modelsMap = useAgentModels();
  const currentModels = modelsMap[agent];
  const agentInfo: AgentInfo = AGENT_INFO_MAP[agent];
  const model =
    currentModels?.find((m) => m.id === modelId) ??
    (modelId && agent === 'opencode' ? openCodeIdToModel(modelId) : null);

  // Pre-fill textarea with initial prompt prefix (e.g., from targeted follow-up)
  useEffect(() => {
    if (initialPromptPrefix && textareaRef.current) {
      textareaRef.current.insertText(initialPromptPrefix);
    }
  }, [initialPromptPrefix]);

  // Handle agent switch with model matching (disabled when resuming)
  const switchAgent = useCallback(() => {
    // Don't allow switching agents when resuming a session
    if (resumeSession) return;

    const newAgent =
      AGENTS[(AGENTS.indexOf(agent) + 1) % AGENTS.length] ||
      defaultAgent ||
      DEFAULT_AGENT;
    setAgent(newAgent);
    setModelId(
      modelMem.current[newAgent] ||
        findEquivalentModel(modelId, modelsMap[newAgent]) ||
        modelsMap[newAgent]?.[0]?.id ||
        null,
    );
  }, [resumeSession, agent, defaultAgent, modelId, modelsMap]);

  // Define available slash commands
  const slashCommands: SlashCommand[] = useMemo(
    () => [
      {
        name: 'agents',
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
        name: 'models',
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
        description: 'View sessions',
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
          ? 'Mount mode required'
          : mountMode
            ? 'Disable mount mode (use git clone)'
            : 'Enable mount mode (use local directory)',
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
          setMountMode((m) => {
            if (!m) {
              // Enabling mount mode - set default mount dir to cwd
              setMountDir(process.cwd());
            }
            return !m;
          });
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

    if (!promptText) {
      setToast({ message: 'Please enter a prompt', type: 'error' });
      return;
    }
    if (!promptText.includes(' ')) {
      setToast({ message: 'Prompt must be more than one word', type: 'error' });
      return;
    }
    if (!modelId) {
      setToast({ message: 'Please select a model', type: 'error' });
      return;
    }
    log.debug(
      { agent, model: modelId, mode: submitMode, mountMode, mountDir },
      'Submitting prompt',
    );
    onSubmit({
      prompt: promptText,
      agent,
      model: modelId,
      mode: submitMode,
      mountDir: mountMode ? (mountDir ?? process.cwd()) : undefined,
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

  // Keyboard handling (when modal not shown)
  useKeyboard((key) => {
    log.trace({ key }, 'Key pressed in PromptScreen');
    if (showModelSelector || showThemePicker) return;

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

    if (key.name === 'tab' && !resumeSession) {
      switchAgent();
      return;
    }

    if (key.name === 'l' && key.ctrl) {
      if (currentModels?.length) {
        setShowModelSelector(true);
      }
      return;
    }

    if (key.name === 's' && key.ctrl) {
      onViewSessions?.();
      return;
    }

    if (key.name === 'a' && key.ctrl) {
      setSubmitMode((m) => (m === 'async' ? 'interactive' : 'async'));
      return;
    }

    if (key.name === 'b' && key.ctrl) {
      onShell(mountMode ? (mountDir ?? undefined) : undefined);
      return;
    }

    if (key.name === 't' && key.ctrl) {
      setShowThemePicker(true);
      return;
    }

    if (key.name === 'd' && key.ctrl) {
      // Don't allow toggling mount mode off when forced
      if (forceMountMode) {
        return;
      }
      setMountMode((m) => {
        if (!m) {
          // Enabling mount mode - set default mount dir to cwd
          setMountDir(process.cwd());
        }
        return !m;
      });
      return;
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
          <HermesTitle />
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
                focused={!showModelSelector && !showThemePicker}
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
                {submitMode === 'interactive' ? (
                  <text fg={theme.success}>[interactive]</text>
                ) : null}
                {mountMode ? <text fg={theme.warning}>[mount]</text> : null}
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
          <HotkeysBar
            keyList={[
              ...(resumeSession ? [] : [['tab', 'agents'] as [string, string]]),
              ['ctrl+l', 'models'],
              ['ctrl+a', 'mode'],
              ['ctrl+d', 'mount'],
              ['ctrl+b', 'shell'],
              ['ctrl+s', 'sessions'],
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
