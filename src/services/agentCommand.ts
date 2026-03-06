// ============================================================================
// Agent Command Builder - Shared logic for building agent shell commands
// ============================================================================

import { shellEscape } from '../utils/shell.ts';
import type { AgentType } from './config.ts';

export interface AgentCommandOptions {
  agent: AgentType;
  mode: 'interactive' | 'detached';
  model?: string;
  agentArgs?: string[];
  /** Continue the last conversation (-c flag) */
  continue?: boolean;
}

/**
 * Build the shell command string that starts an AI agent inside a sandbox.
 *
 * This is the single source of truth for agent invocation across both the
 * Docker and Cloud providers — covering fresh starts, resumes, and
 * re-attachments.
 *
 * **Important:** This function does NOT handle prompt injection.  Callers
 * must use {@link wrapWithPrompt} to inject a prompt into the returned
 * command string.  This keeps stdin free for the agent's interactive TUI
 * and ensures a single, consistent mechanism across all providers.
 */
export function buildAgentCommand(options: AgentCommandOptions): string {
  const { agent, mode, model, agentArgs } = options;
  const cont = options.continue ?? false;
  const modelArg = model ? ` --model ${shellEscape(model)}` : '';
  const extraArgs = agentArgs?.length
    ? ` ${agentArgs.map((a) => shellEscape(a)).join(' ')}`
    : '';

  if (agent === 'claude') {
    const hasPlanArgs = agentArgs?.includes('--permission-mode') ?? false;
    const skipPermsFlag = hasPlanArgs
      ? '--allow-dangerously-skip-permissions'
      : '--dangerously-skip-permissions';
    const asyncFlag = mode === 'detached' ? ' -p' : '';
    const continueFlag = cont ? ' -c' : '';

    return `claude${continueFlag}${asyncFlag}${extraArgs}${modelArg} ${skipPermsFlag}`;
  }

  if (agent === 'codex') {
    const dangerFlag = '--dangerously-bypass-approvals-and-sandbox';
    // --skip-git-repo-check is only supported on `codex exec`, not the interactive TUI
    const skipGitFlag = '--skip-git-repo-check';

    if (mode === 'detached') {
      return `codex exec${modelArg}${extraArgs} ${dangerFlag} ${skipGitFlag}`;
    }
    // Interactive
    if (cont) {
      // Resume last session: codex resume --last [--model X]
      return `codex resume --last${modelArg}${extraArgs}`;
    }
    return `codex${modelArg}${extraArgs} ${dangerFlag}`;
  }

  // OpenCode
  if (mode === 'detached') {
    const continueFlag = cont ? ' -c' : '';
    return `opencode${modelArg}${extraArgs} run${continueFlag}`;
  }

  // Interactive OpenCode
  const continueFlag = cont ? ' -c' : '';
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

// ============================================================================
// Prompt injection
// ============================================================================

/**
 * Base64-encode a string for safe shell transport.
 * Decoded at runtime via `echo '<b64>' | base64 -d`.
 */
function base64Encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/**
 * Wrap an agent command string with prompt injection.
 *
 * The prompt is base64-encoded into a shell variable (`$OX_PROMPT`) and
 * appended as a positional argument (or `--prompt` for interactive
 * opencode).  This keeps stdin connected to the terminal so the agent's
 * interactive TUI works correctly.
 *
 * Returns the original command unchanged when there is no prompt.
 *
 * @example
 * ```ts
 * const cmd = buildAgentCommand({ agent: 'claude', mode: 'interactive' });
 * const wrapped = wrapWithPrompt(cmd, 'claude', 'Fix the bug');
 * // => 'OX_PROMPT="$(echo \'<b64>\' | base64 -d)"; claude --dangerously-skip-permissions "$OX_PROMPT"'
 * ```
 */
export function wrapWithPrompt(
  cmd: string,
  agent: AgentType,
  prompt?: string | null,
): string {
  if (!prompt || prompt.trim().length === 0) {
    return cmd;
  }

  const b64 = base64Encode(prompt);
  const decode = `OX_PROMPT="$(echo '${b64}' | base64 -d)"`;

  // Interactive opencode uses --prompt flag instead of positional arg
  if (agent === 'opencode' && !cmd.includes(' run')) {
    return `${decode}; ${cmd} --prompt "$OX_PROMPT"`;
  }

  return `${decode}; ${cmd} "$OX_PROMPT"`;
}
