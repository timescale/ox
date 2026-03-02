// ============================================================================
// Agent Service - Manage agent configurations and models
// ============================================================================

import type { SelectOption } from '@opentui/core';
import { useEffect, useState } from 'react';
import type { AgentType } from './config';
import { log } from './logger';
import { runOpencodeInDocker } from './opencode';

export interface Model {
  id: string;
  name: string;
  description?: string;
}

// Claude Code models (hardcoded as there's no CLI to list them)
export const CLAUDE_MODELS: Model[] = [
  { id: 'haiku', name: 'Haiku', description: 'Fastest, best for simple tasks' },
  {
    id: 'sonnet',
    name: 'Sonnet',
    description: 'Best balance of speed and capability',
  },
  {
    id: 'opus',
    name: 'Opus',
    description: 'Most capable, best for complex tasks',
  },
];

// Codex models (hardcoded — available via OpenAI Responses API)
export const CODEX_MODELS: Model[] = [
  {
    id: 'o4-mini',
    name: 'o4-mini',
    description: 'Default, fastest',
  },
  {
    id: 'gpt-4.1',
    name: 'GPT-4.1',
    description: 'Best general-purpose',
  },
  {
    id: 'o3',
    name: 'o3',
    description: 'Advanced reasoning',
  },
];

export interface AgentInfo {
  id: AgentType;
  name: string;
  color: string;
  description: string;
}

export const AGENT_INFO = [
  {
    id: 'opencode',
    name: 'OpenCode',
    color: '#5C9CF5',
    description: 'Open-source coding agent CLI',
  } satisfies AgentInfo,
  {
    id: 'claude',
    name: 'Claude Code',
    color: '#D77757',
    description: 'Anthropic Claude Code CLI',
  } satisfies AgentInfo,
  {
    id: 'codex',
    name: 'Codex',
    color: '#10A37F',
    description: 'OpenAI Codex CLI',
  } satisfies AgentInfo,
] as const;

export const AGENTS = AGENT_INFO.map((agent) => agent.id);
export const DEFAULT_AGENT = AGENTS[0] || 'opencode';

export const AGENT_SELECT_OPTIONS: SelectOption[] = AGENT_INFO.map((agent) => ({
  name: agent.name,
  value: agent.id,
  description: agent.description || '',
}));

export const AGENT_INFO_MAP: Record<AgentType, AgentInfo> = AGENT_INFO.reduce(
  (map, agent) => {
    map[agent.id] = agent;
    return map;
  },
  {} as Record<AgentType, AgentInfo>,
);

export const openCodeIdToModel = (id: string): Model => {
  const [description, name = id] = id.split('/');
  return {
    id,
    name,
    description,
  };
};

/**
 * Get available models for opencode by running the CLI inside the Docker container
 */
async function getOpencodeModels(): Promise<readonly Model[]> {
  try {
    const proc = await runOpencodeInDocker({
      cmdArgs: ['models'],
    });
    return proc
      .text()
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map(openCodeIdToModel);
  } catch (error) {
    log.error({ error }, 'Failed to get opencode models');
    // Return empty array if docker or opencode fails
    return [];
  }
}

/**
 * Get available models for codex by running the CLI inside the Docker container.
 * Falls back to hardcoded models if the CLI is unavailable.
 */
async function getCodexModels(): Promise<readonly Model[]> {
  // Codex doesn't have a `models` subcommand, so return hardcoded list
  return CODEX_MODELS;
}

/**
 * Get models for a specific agent
 */
export async function getModelsForAgent(
  agent: AgentType,
): Promise<readonly Model[]> {
  if (agent === 'claude') {
    return CLAUDE_MODELS;
  }
  if (agent === 'codex') {
    return getCodexModels();
  }

  // For opencode, fetch from CLI
  return getOpencodeModels();
}

// hook for models
export const useAgentModels = (
  refreshKey: number | string | null = null,
  enabled = true,
): Record<AgentType, null | readonly Model[]> => {
  const [map, setMap] = useState<Record<AgentType, null | readonly Model[]>>({
    claude: CLAUDE_MODELS,
    opencode: null,
    codex: CODEX_MODELS,
  });

  useEffect(() => {
    if (!enabled) return;
    // Reset opencode models to null to show loading state during refresh
    // refreshKey is used to trigger re-fetching models after adding a provider
    if (refreshKey) {
      setMap((prev) => ({
        ...prev,
        opencode: null,
      }));
    }
    getOpencodeModels().then((models) => {
      setMap((prev) => ({
        ...prev,
        opencode: models,
      }));
    });
  }, [refreshKey, enabled]);

  return map;
};
