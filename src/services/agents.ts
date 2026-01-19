// ============================================================================
// Agent Service - Manage agent configurations and models
// ============================================================================

import type { AgentType } from './config';

// Claude Code models (hardcoded as there's no CLI to list them)
export const CLAUDE_MODELS = [
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
] as const;

export type ClaudeModel = (typeof CLAUDE_MODELS)[number]['id'];

export interface AgentInfo {
  id: AgentType;
  name: string;
  description: string;
}

export const AGENTS: AgentInfo[] = [
  {
    id: 'opencode',
    name: 'OpenCode',
    description: 'Open-source coding agent CLI',
  },
  {
    id: 'claude',
    name: 'Claude Code',
    description: 'Anthropic Claude Code CLI',
  },
];

/**
 * Check if opencode is installed and available in PATH
 */
export async function isOpencodeInstalled(): Promise<boolean> {
  try {
    await Bun.$`which opencode`.quiet();
    return true;
  } catch {
    return false;
  }
}

/**
 * Install opencode using the recommended method
 */
export async function installOpencode(): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    // Use bun to install opencode globally
    await Bun.$`curl -fsSL https://opencode.ai/install | bash`.quiet();
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Get available models for opencode from the CLI
 */
export async function getOpencodeModels(): Promise<string[]> {
  try {
    const result = await Bun.$`opencode models`.quiet();
    const output = result.stdout.toString().trim();
    return output.split('\n').filter((line) => line.length > 0);
  } catch {
    // Return empty array if opencode is not installed or fails
    return [];
  }
}

/**
 * Get models for a specific agent
 */
export async function getModelsForAgent(
  agent: AgentType,
): Promise<readonly { id: string; name: string; description: string }[]> {
  if (agent === 'claude') {
    return CLAUDE_MODELS;
  }

  // For opencode, fetch from CLI
  const models = await getOpencodeModels();
  return models.map((model) => {
    const [provider, name] = model.split('/');
    return {
      id: model,
      name: name || model,
      description: provider || '',
    };
  });
}
