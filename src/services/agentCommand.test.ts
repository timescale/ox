import { describe, expect, test } from 'bun:test';
import { buildAgentCommand, buildContinueCommand } from './agentCommand.ts';

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

  test('interactive, with prompt (base64 piped)', () => {
    const cmd = buildAgentCommand({
      agent: 'claude',
      mode: 'interactive',
      prompt: 'Fix the bug',
    });
    const b64 = Buffer.from('Fix the bug').toString('base64');
    expect(cmd).toBe(
      `echo '${b64}' | base64 -d | claude --dangerously-skip-permissions`,
    );
  });

  test('detached, no prompt', () => {
    const cmd = buildAgentCommand({
      agent: 'claude',
      mode: 'detached',
    });
    expect(cmd).toBe('claude -p --dangerously-skip-permissions');
  });

  test('detached, with prompt', () => {
    const cmd = buildAgentCommand({
      agent: 'claude',
      mode: 'detached',
      prompt: 'Add tests',
    });
    const b64 = Buffer.from('Add tests').toString('base64');
    expect(cmd).toBe(
      `echo '${b64}' | base64 -d | claude -p --dangerously-skip-permissions`,
    );
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

  test('continue detached with prompt', () => {
    const cmd = buildAgentCommand({
      agent: 'claude',
      mode: 'detached',
      continue: true,
      prompt: 'Now fix the tests',
    });
    const b64 = Buffer.from('Now fix the tests').toString('base64');
    expect(cmd).toBe(
      `echo '${b64}' | base64 -d | claude -c -p --dangerously-skip-permissions`,
    );
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

  test('interactive, with prompt (--prompt flag)', () => {
    const cmd = buildAgentCommand({
      agent: 'opencode',
      mode: 'interactive',
      prompt: 'Fix the bug',
    });
    expect(cmd).toBe("opencode --prompt 'Fix the bug'");
  });

  test('interactive, with prompt containing single quotes', () => {
    const cmd = buildAgentCommand({
      agent: 'opencode',
      mode: 'interactive',
      prompt: "Don't break it",
    });
    expect(cmd).toBe("opencode --prompt 'Don'\\''t break it'");
  });

  test('detached, no prompt', () => {
    const cmd = buildAgentCommand({
      agent: 'opencode',
      mode: 'detached',
    });
    expect(cmd).toBe('opencode run');
  });

  test('detached, with prompt (base64 piped)', () => {
    const cmd = buildAgentCommand({
      agent: 'opencode',
      mode: 'detached',
      prompt: 'Add tests',
    });
    const b64 = Buffer.from('Add tests').toString('base64');
    expect(cmd).toBe(`echo '${b64}' | base64 -d | opencode run`);
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

  test('continue detached with prompt', () => {
    const cmd = buildAgentCommand({
      agent: 'opencode',
      mode: 'detached',
      continue: true,
      prompt: 'Now fix the tests',
    });
    const b64 = Buffer.from('Now fix the tests').toString('base64');
    expect(cmd).toBe(`echo '${b64}' | base64 -d | opencode run -c`);
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

  test('continue interactive ignores prompt (prompt is only for fresh starts)', () => {
    const cmd = buildAgentCommand({
      agent: 'opencode',
      mode: 'interactive',
      continue: true,
      prompt: 'This should be ignored',
    });
    // In continue mode, interactive opencode just gets -c (no --prompt)
    expect(cmd).toBe('opencode -c');
  });
});

// ============================================================================
// Edge cases
// ============================================================================

describe('buildAgentCommand - edge cases', () => {
  test('empty prompt is treated as no prompt', () => {
    const cmd = buildAgentCommand({
      agent: 'claude',
      mode: 'interactive',
      prompt: '',
    });
    expect(cmd).toBe('claude --dangerously-skip-permissions');
  });

  test('whitespace-only prompt is treated as no prompt', () => {
    const cmd = buildAgentCommand({
      agent: 'claude',
      mode: 'interactive',
      prompt: '   ',
    });
    expect(cmd).toBe('claude --dangerously-skip-permissions');
  });

  test('continue defaults to false when not specified', () => {
    const cmd = buildAgentCommand({
      agent: 'claude',
      mode: 'interactive',
    });
    // No -c flag
    expect(cmd).not.toContain(' -c');
  });

  test('prompt with special shell characters is base64 encoded for claude', () => {
    const prompt = 'Fix the "bug" && rm -rf / | echo $HOME';
    const cmd = buildAgentCommand({
      agent: 'claude',
      mode: 'detached',
      prompt,
    });
    const b64 = Buffer.from(prompt).toString('base64');
    // The prompt is safely base64-encoded, not inlined raw
    expect(cmd).toContain(`echo '${b64}'`);
    expect(cmd).not.toContain('rm -rf');
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
