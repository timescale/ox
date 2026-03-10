// ============================================================================
// Agent Service - Manage agent configurations and models
// ============================================================================

import type { SelectOption } from '@opentui/core';
import { useEffect, useState } from 'react';

import { CODEX_MODELS } from './codexModels.generated.ts';
export { CODEX_MODELS };

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
 * Get available models for codex.
 * Returns the list generated from the official codex repository's models.json.
 * Run `./bun scripts/codex/update-models.ts` to refresh.
 */
async function getCodexModels(): Promise<readonly Model[]> {
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
  /** When set, only fetch dynamic models (opencode) when this agent is selected.
   *  Pass null to eagerly fetch all agents (config wizard behavior). */
  activeAgent: AgentType | null = null,
): Record<AgentType, null | readonly Model[]> => {
  const [map, setMap] = useState<Record<AgentType, null | readonly Model[]>>({
    claude: CLAUDE_MODELS,
    opencode: null,
    codex: CODEX_MODELS,
  });

  useEffect(() => {
    if (!enabled) return;
    // Only fetch opencode models when opencode is selected (or when no
    // activeAgent filter is set, e.g. in the config wizard).
    if (activeAgent != null && activeAgent !== 'opencode') return;
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
  }, [refreshKey, enabled, activeAgent]);

  return map;
};
