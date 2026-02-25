// ============================================================================
// Agent Command Builder - Shared logic for building agent shell commands
// ============================================================================

import { shellEscape } from '../utils.ts';
import type { AgentType } from './config.ts';

export interface AgentCommandOptions {
  agent: AgentType;
  mode: 'interactive' | 'detached';
  model?: string;
  agentArgs?: string[];
  /** Continue the last conversation (-c flag) */
  continue?: boolean;
  /**
   * Prompt text.  For Claude and detached OpenCode the prompt is piped
   * via base64 encoding for shell safety.  For interactive OpenCode the
   * prompt is passed with the `--prompt` flag.
   *
   * Omit this when the caller handles prompt injection separately
   * (e.g. Docker's `escapePrompt()` wrapper).
   */
  prompt?: string;
}

/**
 * Build the shell command string that starts an AI agent inside a sandbox.
 *
 * This is the single source of truth for agent invocation across both the
 * Docker and Cloud providers — covering fresh starts, resumes, and
 * re-attachments.
 */
export function buildAgentCommand(options: AgentCommandOptions): string {
  const { agent, mode, model, agentArgs, prompt } = options;
  const cont = options.continue ?? false;
  const modelArg = model ? ` --model ${shellEscape(model)}` : '';
  const extraArgs = agentArgs?.length
    ? ` ${agentArgs.map((a) => shellEscape(a)).join(' ')}`
    : '';
  const hasPrompt = prompt != null && prompt.trim().length > 0;

  if (agent === 'claude') {
    const hasPlanArgs = agentArgs?.includes('--permission-mode') ?? false;
    const skipPermsFlag = hasPlanArgs
      ? '--allow-dangerously-skip-permissions'
      : '--dangerously-skip-permissions';
    const asyncFlag = mode === 'detached' ? ' -p' : '';
    const continueFlag = cont ? ' -c' : '';

    const cmd = `claude${continueFlag}${asyncFlag}${extraArgs}${modelArg} ${skipPermsFlag}`;
    if (hasPrompt) {
      const b64 = Buffer.from(prompt).toString('base64');
      return `echo '${b64}' | base64 -d | ${cmd}`;
    }
    return cmd;
  }

  // OpenCode
  if (mode === 'detached') {
    const continueFlag = cont ? ' -c' : '';
    const cmd = `opencode${modelArg}${extraArgs} run${continueFlag}`;
    if (hasPrompt) {
      const b64 = Buffer.from(prompt).toString('base64');
      return `echo '${b64}' | base64 -d | ${cmd}`;
    }
    return cmd;
  }

  // Interactive OpenCode
  const continueFlag = cont ? ' -c' : '';
  if (hasPrompt && !cont) {
    // --prompt is only used for fresh interactive sessions (not continue)
    return `opencode${modelArg}${extraArgs} --prompt ${shellEscape(prompt)}`;
  }
  return `opencode${modelArg}${extraArgs}${continueFlag}`;
}

/**
 * Build an interactive continue command for re-attaching to an agent session.
 * Used when the tmux session has died and needs to be recreated.
 */
export function buildContinueCommand(agent: AgentType, model?: string): string {
  return buildAgentCommand({
    agent,
    mode: 'interactive',
    model,
    continue: true,
  });
}
