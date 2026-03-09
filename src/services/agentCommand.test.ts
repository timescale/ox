import { describe, expect, test } from 'bun:test';
import {
  buildAgentCommand,
  buildContinueCommand,
  wrapWithPrompt,
} from './agentCommand.ts';

// ============================================================================
// Claude
// ============================================================================

describe('buildAgentCommand - claude', () => {
  // ---------- Fresh start (no continue) ----------

  test('interactive, no prompt', () => {
    const cmd = buildAgentCommand({
      agent: 'claude',
      mode: 'interactive',
    });
    expect(cmd).toBe('claude --dangerously-skip-permissions');
  });

  test('detached, no prompt', () => {
    const cmd = buildAgentCommand({
      agent: 'claude',
      mode: 'detached',
    });
    expect(cmd).toBe('claude -p --dangerously-skip-permissions');
  });

  test('with model', () => {
    const cmd = buildAgentCommand({
      agent: 'claude',
      mode: 'interactive',
      model: 'claude-sonnet-4-20250514',
    });
    expect(cmd).toBe(
      "claude --model 'claude-sonnet-4-20250514' --dangerously-skip-permissions",
    );
  });

  test('with extra agentArgs', () => {
    const cmd = buildAgentCommand({
      agent: 'claude',
      mode: 'interactive',
      agentArgs: ['--verbose'],
    });
    expect(cmd).toBe("claude '--verbose' --dangerously-skip-permissions");
  });

  test('plan mode (--permission-mode in agentArgs)', () => {
    const cmd = buildAgentCommand({
      agent: 'claude',
      mode: 'interactive',
      agentArgs: ['--permission-mode', 'plan'],
    });
    expect(cmd).toBe(
      "claude '--permission-mode' 'plan' --allow-dangerously-skip-permissions",
    );
  });

  test('with model and agentArgs combined', () => {
    const cmd = buildAgentCommand({
      agent: 'claude',
      mode: 'detached',
      model: 'claude-sonnet-4-20250514',
      agentArgs: ['--verbose'],
    });
    expect(cmd).toBe(
      "claude -p '--verbose' --model 'claude-sonnet-4-20250514' --dangerously-skip-permissions",
    );
  });

  // ---------- Continue (resume) ----------

  test('continue interactive', () => {
    const cmd = buildAgentCommand({
      agent: 'claude',
      mode: 'interactive',
      continue: true,
    });
    expect(cmd).toBe('claude -c --dangerously-skip-permissions');
  });

  test('continue detached', () => {
    const cmd = buildAgentCommand({
      agent: 'claude',
      mode: 'detached',
      continue: true,
    });
    expect(cmd).toBe('claude -c -p --dangerously-skip-permissions');
  });

  test('continue with model', () => {
    const cmd = buildAgentCommand({
      agent: 'claude',
      mode: 'interactive',
      model: 'claude-sonnet-4-20250514',
      continue: true,
    });
    expect(cmd).toBe(
      "claude -c --model 'claude-sonnet-4-20250514' --dangerously-skip-permissions",
    );
  });

  test('continue with plan mode agentArgs', () => {
    const cmd = buildAgentCommand({
      agent: 'claude',
      mode: 'interactive',
      continue: true,
      agentArgs: ['--permission-mode', 'plan'],
    });
    expect(cmd).toBe(
      "claude -c '--permission-mode' 'plan' --allow-dangerously-skip-permissions",
    );
  });
});

// ============================================================================
// OpenCode
// ============================================================================

describe('buildAgentCommand - opencode', () => {
  // ---------- Fresh start (no continue) ----------

  test('interactive, no prompt', () => {
    const cmd = buildAgentCommand({
      agent: 'opencode',
      mode: 'interactive',
    });
    expect(cmd).toBe('opencode');
  });

  test('detached, no prompt', () => {
    const cmd = buildAgentCommand({
      agent: 'opencode',
      mode: 'detached',
    });
    expect(cmd).toBe('opencode run');
  });

  test('with model', () => {
    const cmd = buildAgentCommand({
      agent: 'opencode',
      mode: 'interactive',
      model: 'gpt-4o',
    });
    expect(cmd).toBe("opencode --model 'gpt-4o'");
  });

  test('with extra agentArgs', () => {
    const cmd = buildAgentCommand({
      agent: 'opencode',
      mode: 'interactive',
      agentArgs: ['--agent', 'plan'],
    });
    expect(cmd).toBe("opencode '--agent' 'plan'");
  });

  test('detached with model and agentArgs', () => {
    const cmd = buildAgentCommand({
      agent: 'opencode',
      mode: 'detached',
      model: 'gpt-4o',
      agentArgs: ['--verbose'],
    });
    expect(cmd).toBe("opencode --model 'gpt-4o' '--verbose' run");
  });

  // ---------- Continue (resume) ----------

  test('continue interactive', () => {
    const cmd = buildAgentCommand({
      agent: 'opencode',
      mode: 'interactive',
      continue: true,
    });
    expect(cmd).toBe('opencode -c');
  });

  test('continue detached', () => {
    const cmd = buildAgentCommand({
      agent: 'opencode',
      mode: 'detached',
      continue: true,
    });
    expect(cmd).toBe('opencode run -c');
  });

  test('continue with model', () => {
    const cmd = buildAgentCommand({
      agent: 'opencode',
      mode: 'interactive',
      model: 'gpt-4o',
      continue: true,
    });
    expect(cmd).toBe("opencode --model 'gpt-4o' -c");
  });
});

// ============================================================================
// Edge cases
// ============================================================================

describe('buildAgentCommand - edge cases', () => {
  test('continue defaults to false when not specified', () => {
    const cmd = buildAgentCommand({
      agent: 'claude',
      mode: 'interactive',
    });
    // No -c flag
    expect(cmd).not.toContain(' -c');
  });
});

// ============================================================================
// buildContinueCommand
// ============================================================================

describe('buildContinueCommand', () => {
  test('claude with no model', () => {
    const cmd = buildContinueCommand('claude');
    expect(cmd).toBe('claude -c --dangerously-skip-permissions');
  });

  test('claude with model', () => {
    const cmd = buildContinueCommand('claude', 'claude-sonnet-4-20250514');
    expect(cmd).toBe(
      "claude -c --model 'claude-sonnet-4-20250514' --dangerously-skip-permissions",
    );
  });

  test('opencode with no model', () => {
    const cmd = buildContinueCommand('opencode');
    expect(cmd).toBe('opencode -c');
  });

  test('opencode with model', () => {
    const cmd = buildContinueCommand('opencode', 'gpt-4o');
    expect(cmd).toBe("opencode --model 'gpt-4o' -c");
  });
});

// ============================================================================
// wrapWithPrompt
// ============================================================================

describe('wrapWithPrompt', () => {
  test('returns command unchanged when no prompt', () => {
    const cmd = 'claude --dangerously-skip-permissions';
    expect(wrapWithPrompt(cmd, 'claude')).toBe(cmd);
  });

  test('returns command unchanged when prompt is null', () => {
    const cmd = 'claude --dangerously-skip-permissions';
    expect(wrapWithPrompt(cmd, 'claude', null)).toBe(cmd);
  });

  test('returns command unchanged when prompt is empty', () => {
    const cmd = 'claude --dangerously-skip-permissions';
    expect(wrapWithPrompt(cmd, 'claude', '')).toBe(cmd);
  });

  test('returns command unchanged when prompt is whitespace-only', () => {
    const cmd = 'claude --dangerously-skip-permissions';
    expect(wrapWithPrompt(cmd, 'claude', '   ')).toBe(cmd);
  });

  test('wraps claude command with OX_PROMPT variable', () => {
    const cmd = 'claude --dangerously-skip-permissions';
    const result = wrapWithPrompt(cmd, 'claude', 'Fix the bug');
    const b64 = Buffer.from('Fix the bug').toString('base64');
    expect(result).toBe(
      `OX_PROMPT="$(echo '${b64}' | base64 -d)"; claude --dangerously-skip-permissions "$OX_PROMPT"`,
    );
  });

  test('wraps detached claude command with OX_PROMPT variable', () => {
    const cmd = 'claude -p --dangerously-skip-permissions';
    const result = wrapWithPrompt(cmd, 'claude', 'Add tests');
    const b64 = Buffer.from('Add tests').toString('base64');
    expect(result).toBe(
      `OX_PROMPT="$(echo '${b64}' | base64 -d)"; claude -p --dangerously-skip-permissions "$OX_PROMPT"`,
    );
  });

  test('wraps codex interactive command with OX_PROMPT variable', () => {
    const cmd = 'codex --dangerously-bypass-approvals-and-sandbox';
    const result = wrapWithPrompt(cmd, 'codex', 'Fix the bug');
    const b64 = Buffer.from('Fix the bug').toString('base64');
    expect(result).toBe(
      `OX_PROMPT="$(echo '${b64}' | base64 -d)"; codex --dangerously-bypass-approvals-and-sandbox "$OX_PROMPT"`,
    );
  });

  test('wraps codex detached command with OX_PROMPT variable', () => {
    const cmd =
      'codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check';
    const result = wrapWithPrompt(cmd, 'codex', 'Add tests');
    const b64 = Buffer.from('Add tests').toString('base64');
    expect(result).toBe(
      `OX_PROMPT="$(echo '${b64}' | base64 -d)"; codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check "$OX_PROMPT"`,
    );
  });

  test('wraps interactive opencode with --prompt flag', () => {
    const cmd = 'opencode';
    const result = wrapWithPrompt(cmd, 'opencode', 'Fix the bug');
    const b64 = Buffer.from('Fix the bug').toString('base64');
    expect(result).toBe(
      `OX_PROMPT="$(echo '${b64}' | base64 -d)"; opencode --prompt "$OX_PROMPT"`,
    );
  });

  test('wraps detached opencode with positional arg (not --prompt)', () => {
    const cmd = 'opencode run';
    const result = wrapWithPrompt(cmd, 'opencode', 'Add tests');
    const b64 = Buffer.from('Add tests').toString('base64');
    expect(result).toBe(
      `OX_PROMPT="$(echo '${b64}' | base64 -d)"; opencode run "$OX_PROMPT"`,
    );
  });

  test('prompt with special shell characters is base64 encoded', () => {
    const prompt = 'Fix the "bug" && rm -rf / | echo $HOME';
    const cmd = 'claude -p --dangerously-skip-permissions';
    const result = wrapWithPrompt(cmd, 'claude', prompt);
    const b64 = Buffer.from(prompt).toString('base64');
    // The prompt is safely base64-encoded, not inlined raw
    expect(result).toContain(`echo '${b64}'`);
    expect(result).not.toContain('rm -rf');
  });

  test('wraps continue-detached claude with OX_PROMPT variable', () => {
    const cmd = 'claude -c -p --dangerously-skip-permissions';
    const result = wrapWithPrompt(cmd, 'claude', 'Now fix the tests');
    const b64 = Buffer.from('Now fix the tests').toString('base64');
    expect(result).toBe(
      `OX_PROMPT="$(echo '${b64}' | base64 -d)"; claude -c -p --dangerously-skip-permissions "$OX_PROMPT"`,
    );
  });

  test('wraps continue-detached opencode with OX_PROMPT variable', () => {
    const cmd = 'opencode run -c';
    const result = wrapWithPrompt(cmd, 'opencode', 'Now fix the tests');
    const b64 = Buffer.from('Now fix the tests').toString('base64');
    expect(result).toBe(
      `OX_PROMPT="$(echo '${b64}' | base64 -d)"; opencode run -c "$OX_PROMPT"`,
    );
  });
});
