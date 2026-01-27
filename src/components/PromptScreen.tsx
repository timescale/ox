import { homedir } from 'node:os';
import type { MouseEvent, TextareaRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { useRef, useState } from 'react';
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
import { log } from '../services/logger';
import { FilterableSelector } from './FilterableSelector';
import { HermesTitle } from './HermesTitle';
import { HotkeysBar } from './HotkeysBar';
import { Modal } from './Modal';
import { Selector } from './Selector';
import { Toast, type ToastType } from './Toast';

export type SubmitMode = 'async' | 'interactive';

export interface PromptScreenProps {
  defaultAgent: AgentType;
  defaultModel?: string | null;
  onSubmit: (result: {
    prompt: string;
    agent: AgentType;
    model: string;
    mode: SubmitMode;
  }) => void;
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
  onSubmit,
  onViewSessions,
}: PromptScreenProps) {
  const textareaRef = useRef<TextareaRenderable>(null);
  const [agent, setAgent] = useState<AgentType>(defaultAgent);
  const [modelId, setModelId] = useState<string | null>(defaultModel);
  const modelMem = useRef({
    [defaultAgent]: defaultModel,
  });
  modelMem.current[agent] = modelId;
  const [showModelSelector, setShowModelSelector] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [submitMode, setSubmitMode] = useState<SubmitMode>('async');
  const modelsMap = useAgentModels();
  const currentModels = modelsMap[agent];
  const agentInfo: AgentInfo = AGENT_INFO_MAP[agent];
  const model =
    currentModels?.find((m) => m.id === modelId) ??
    (modelId && agent === 'opencode' ? openCodeIdToModel(modelId) : null);

  // Handle agent switch with model matching
  const switchAgent = () => {
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
  };

  // Handle model selection from modal
  const handleModelSelect = (selectedModel: string | null) => {
    log.debug({ selectedModel, currentModelId: modelId }, 'Model selected');
    if (selectedModel) {
      setModelId(selectedModel);
    }
    setShowModelSelector(false);
  };

  // Handle submit
  const handleSubmitImpl = () => {
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
    log.debug({ agent, model: modelId, mode: submitMode }, 'Submitting prompt');
    onSubmit({ prompt: promptText, agent, model: modelId, mode: submitMode });
  };

  // Use a ref to avoid stale closure issues with @opentui/react's textarea.
  // The textarea component caches the onSubmit handler, so we store the current
  // implementation in a ref and use a stable wrapper that calls through the ref.
  const handleSubmitRef = useRef(handleSubmitImpl);
  handleSubmitRef.current = handleSubmitImpl;
  const handleSubmit = () => handleSubmitRef.current();

  // Keyboard handling (when modal not shown)
  useKeyboard((key) => {
    log.trace({ key }, 'Key pressed in PromptScreen');
    if (showModelSelector) return;

    if (key.name === 'tab') {
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
      backgroundColor="#0A0A0A"
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
          {/* Main input box */}
          <box
            border={['left']}
            borderColor={agentInfo?.color}
            customBorderChars={{
              ...EmptyBorder,
              vertical: '┃',
              bottomLeft: '╹',
            }}
          >
            <box
              flexDirection="column"
              paddingTop={1}
              paddingLeft={2}
              paddingRight={2}
              flexShrink={0}
              flexGrow={1}
              backgroundColor="#1E1E1E"
            >
              {/* Prompt textarea */}
              <textarea
                ref={textareaRef}
                focused={!showModelSelector}
                placeholder='Ask anything... "Fix a TODO in the codebase"'
                onSubmit={handleSubmit}
                onMouseDown={(r: MouseEvent) => r.target?.focus()}
                keyBindings={[
                  { name: 'return', ctrl: true, action: 'newline' },
                  { name: 'return', meta: true, action: 'newline' },
                  { name: 'return', shift: true, action: 'newline' },
                  { name: 'return', action: 'submit' },
                ]}
                backgroundColor="#1E1E1E"
                focusedBackgroundColor="#1E1E1E"
                textColor="#fff"
                focusedTextColor="#fff"
                minHeight={1}
                maxHeight={5}
              />

              {/* Agent and model display row */}
              <box flexDirection="row" marginTop={1} height={1} gap={1}>
                <text fg={agentInfo?.color}>{agentInfo?.name || agent}</text>
                {submitMode === 'interactive' ? (
                  <text fg="#22c55e">[interactive]</text>
                ) : null}
                <text fg="#aaaaaa">
                  {model?.name || modelId || 'Loading...'}
                </text>
                {model?.description ? (
                  <text fg="#666666">{model.description}</text>
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
              vertical: '╹',
            }}
          >
            <box
              height={1}
              border={['bottom']}
              borderColor="#1E1E1E"
              customBorderChars={{
                ...EmptyBorder,
                horizontal: '▀',
              }}
            />
          </box>
          <HotkeysBar
            keyList={[
              ['tab', 'agents'],
              ['ctrl+l', 'models'],
              ['ctrl+a', 'mode'],
              ['ctrl+s', 'sessions'],
            ]}
          />
        </box>
      </box>
      <box height={1} flexDirection="row" width="100%">
        <box flexGrow={1}>
          <text fg="#808080">{process.cwd().replace(homedir(), '~')}</text>
        </box>
        <box alignItems="flex-end">
          <text fg="#808080">{packageJson.version}</text>
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
      {/* Toast notifications */}
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onDismiss={() => setToast(null)}
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
