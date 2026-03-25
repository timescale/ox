// ============================================================================
// Completion Tests (in-process, fast)
//
// Bash end-to-end tests live in e2e-tests/completion.test.ts.
// ============================================================================

import { describe, expect, test } from 'bun:test';
import { createProgram } from '../createProgram.ts';
import { captureLog } from '../utils/captureLog.ts';
import {
  generateCompletionScript,
  initializeTab,
  resolveCompletions,
} from './completion.ts';

// All subcommands registered via createProgram()
const EXPECTED_SUBCOMMANDS = [
  'auth',
  'claude',
  'colors',
  'completions',
  'config',
  'gh',
  'logs',
  'opencode',
  'resources',
  'resume',
  'session',
  'sessions',
  'shell',
  'upgrade',
];

// Initialize tab once for all in-process tests
const program = createProgram();
const tab = initializeTab(program);

/**
 * Parse the tab-completion output format.
 *
 * Format: each line is `value\tdescription`, last line is `:<directive>`.
 * Returns the completion values (without descriptions) and the directive.
 */
function parseCompletionOutput(stdout: string): {
  completions: string[];
  directive: number;
} {
  const lines = stdout.trim().split('\n');
  if (lines.length === 0) return { completions: [], directive: 0 };

  // Last line is the directive (e.g. ":4")
  const lastLine = lines.at(-1) ?? '';
  const directive = lastLine.startsWith(':')
    ? Number.parseInt(lastLine.slice(1), 10)
    : 0;

  // All other lines are completions in "value\tdescription" format
  const completions = lines
    .slice(0, -1)
    .map((line) => line.split('\t')[0] ?? '')
    .filter(Boolean);

  return { completions, directive };
}

// ============================================================================
// Tier 1: Completion Script Generation (in-process)
// ============================================================================

describe('completion script generation', () => {
  test('ox complete zsh outputs a valid zsh completion script', () => {
    const stdout = generateCompletionScript(tab, 'zsh');
    expect(stdout.length).toBeGreaterThan(0);
    // zsh completion scripts start with #compdef
    expect(stdout).toContain('#compdef ox');
    // Should define the main completion function
    expect(stdout).toContain('_ox');
    // Should reference the callback mechanism
    expect(stdout).toContain('ox complete --');
  });

  test('ox complete bash outputs a valid bash completion script', () => {
    const stdout = generateCompletionScript(tab, 'bash');
    expect(stdout.length).toBeGreaterThan(0);
    // bash completion script registers via complete -F
    expect(stdout).toContain('complete -F');
    expect(stdout).toContain('__ox_complete');
    // Should reference the callback mechanism
    expect(stdout).toContain('ox complete --');
  });

  test('ox complete fish outputs a valid fish completion script', () => {
    const stdout = generateCompletionScript(tab, 'fish');
    expect(stdout.length).toBeGreaterThan(0);
    // fish completions register via complete -c
    expect(stdout).toContain('complete -c ox');
    // Should define fish completion functions
    expect(stdout).toContain('__ox_perform_completion');
    // Should reference the callback mechanism
    expect(stdout).toContain('ox complete --');
  });

  test('ox complete powershell outputs a valid PowerShell completion script', () => {
    const stdout = generateCompletionScript(tab, 'powershell');
    expect(stdout.length).toBeGreaterThan(0);
    // PowerShell registers completions via Register-ArgumentCompleter
    expect(stdout).toContain('Register-ArgumentCompleter');
    // Should reference the callback mechanism
    expect(stdout).toContain('ox complete');
  });
});

// ============================================================================
// Tier 1: Completion Resolution (in-process)
// ============================================================================

describe('completion resolution', () => {
  test('empty input lists all subcommands', () => {
    const stdout = resolveCompletions(tab, ['']);
    const { completions, directive } = parseCompletionOutput(stdout);
    for (const cmd of EXPECTED_SUBCOMMANDS) {
      expect(completions).toContain(cmd);
    }
    // Directive 4 = ShellCompDirectiveNoFileComp
    expect(directive).toBe(4);
  });

  test('no args also lists all subcommands', () => {
    const stdout = resolveCompletions(tab, []);
    const { completions } = parseCompletionOutput(stdout);
    for (const cmd of EXPECTED_SUBCOMMANDS) {
      expect(completions).toContain(cmd);
    }
  });

  test('partial command narrows to matching subcommands', () => {
    const stdout = resolveCompletions(tab, ['se']);
    const { completions } = parseCompletionOutput(stdout);
    expect(completions).toContain('session');
    expect(completions).toContain('sessions');
    // Should not contain non-matching commands
    expect(completions).not.toContain('auth');
    expect(completions).not.toContain('shell');
  });

  test('unique prefix completes to matching commands and aliases', () => {
    const stdout = resolveCompletions(tab, ['up']);
    const { completions } = parseCompletionOutput(stdout);
    expect(completions).toContain('upgrade');
    expect(completions).toContain('update');
    expect(completions).not.toContain('auth');
  });

  test('root flags complete when -- prefix is used', () => {
    const stdout = resolveCompletions(tab, ['--']);
    const { completions } = parseCompletionOutput(stdout);
    expect(completions).toContain('--version');
  });

  test('subcommand flags complete correctly', () => {
    const stdout = resolveCompletions(tab, ['session', 'logs', '--']);
    const { completions } = parseCompletionOutput(stdout);
    expect(completions).toContain('--follow');
    expect(completions).toContain('--tail');
  });

  test('completion output uses correct tab-separated format', () => {
    const stdout = resolveCompletions(tab, ['']);
    const lines = stdout.trim().split('\n');
    // Last line should be the directive
    const lastLine = lines.at(-1) ?? '';
    expect(lastLine).toMatch(/^:\d+$/);

    // All other lines should be tab-separated value\tdescription
    const completionLines = lines.slice(0, -1);
    expect(completionLines.length).toBeGreaterThan(0);
    for (const line of completionLines) {
      expect(line).toContain('\t');
      const parts = line.split('\t');
      // Should have a value and a description
      expect(parts.length).toBeGreaterThanOrEqual(2);
      expect((parts[0] ?? '').length).toBeGreaterThan(0);
    }
  });

  test('completions include descriptions for subcommands', () => {
    const stdout = resolveCompletions(tab, ['']);
    // Find the session line and verify it has a description
    const lines = stdout.trim().split('\n');
    const sessionLine = lines.find((l) => l.startsWith('session\t'));
    expect(sessionLine).toBeDefined();
    expect(sessionLine).toContain('session');
  });
});

// ============================================================================
// Tier 1: Completions Command (Human-Readable Instructions, in-process)
// ============================================================================

describe('completions command', () => {
  test('ox completions shows instructions for all shells', () => {
    const stdout = captureLog(() => {
      program.parse(['completions'], { from: 'user' });
    });

    // Should mention all supported shells
    expect(stdout).toContain('zsh');
    expect(stdout).toContain('bash');
    expect(stdout).toContain('fish');
    expect(stdout).toContain('powershell');

    // Should include the source command pattern
    expect(stdout).toContain('source <(ox complete zsh)');
    expect(stdout).toContain('source <(ox complete bash)');
    expect(stdout).toContain('ox complete fish | source');
    expect(stdout).toContain('ox complete powershell | Out-String');
  });

  test('ox completions zsh shows zsh-specific instruction', () => {
    const stdout = captureLog(() => {
      program.parse(['completions', 'zsh'], { from: 'user' });
    });
    expect(stdout).toContain('source <(ox complete zsh)');
  });

  test('ox completions bash shows bash-specific instruction', () => {
    const stdout = captureLog(() => {
      program.parse(['completions', 'bash'], { from: 'user' });
    });
    expect(stdout).toContain('source <(ox complete bash)');
  });

  test('ox completions fish shows fish-specific instruction', () => {
    const stdout = captureLog(() => {
      program.parse(['completions', 'fish'], { from: 'user' });
    });
    expect(stdout).toContain('ox complete fish | source');
  });

  test('ox completions powershell shows powershell-specific instruction', () => {
    const stdout = captureLog(() => {
      program.parse(['completions', 'powershell'], { from: 'user' });
    });
    expect(stdout).toContain('ox complete powershell | Out-String');
  });
});
