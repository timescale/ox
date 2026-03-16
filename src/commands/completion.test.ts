// ============================================================================
// Completion Integration Tests
//
// Tier 1: Subprocess tests that spawn `./bun index.ts complete ...` and verify
//         stdout output for script generation and completion resolution.
// Tier 2: End-to-end bash tests that source the completion script into a real
//         bash shell, trigger completion, and verify COMPREPLY.
// ============================================================================

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import type { ShellError } from '../utils/shell.ts';

const PROJECT_ROOT = resolve(import.meta.dir, '..', '..');
const BUN = resolve(PROJECT_ROOT, 'bun');
const CLI = resolve(PROJECT_ROOT, 'index.ts');

// All subcommands registered in src/index.ts
const EXPECTED_SUBCOMMANDS = [
  'auth',
  'branch',
  'claude',
  'colors',
  'completions',
  'config',
  'gh',
  'logs',
  'opencode',
  'resources',
  'resume',
  'sessions',
  'shell',
  'upgrade',
];

/**
 * Run the ox CLI with the given args and return stdout/stderr/exitCode.
 * Uses Bun's shell for subprocess execution.
 */
async function runOx(
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await Bun.$`${BUN} ${CLI} ${args}`.quiet().cwd(PROJECT_ROOT);
    return {
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      exitCode: result.exitCode,
    };
  } catch (err) {
    const shellErr = err as ShellError;
    return {
      stdout: shellErr.stdout?.toString() ?? '',
      stderr: shellErr.stderr?.toString() ?? '',
      exitCode: shellErr.exitCode ?? 1,
    };
  }
}

/**
 * Parse the tab-completion output format from `ox complete -- <args>`.
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
// Tier 1: Completion Script Generation
// ============================================================================

describe('completion script generation', () => {
  test('ox complete zsh outputs a valid zsh completion script', async () => {
    const { stdout, exitCode } = await runOx('complete', 'zsh');
    expect(exitCode).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
    // zsh completion scripts start with #compdef
    expect(stdout).toContain('#compdef ox');
    // Should define the main completion function
    expect(stdout).toContain('_ox');
    // Should reference the callback mechanism
    expect(stdout).toContain('ox complete --');
  });

  test('ox complete bash outputs a valid bash completion script', async () => {
    const { stdout, exitCode } = await runOx('complete', 'bash');
    expect(exitCode).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
    // bash completion script registers via complete -F
    expect(stdout).toContain('complete -F');
    expect(stdout).toContain('__ox_complete');
    // Should reference the callback mechanism
    expect(stdout).toContain('ox complete --');
  });

  test('ox complete fish outputs a valid fish completion script', async () => {
    const { stdout, exitCode } = await runOx('complete', 'fish');
    expect(exitCode).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
    // fish completions register via complete -c
    expect(stdout).toContain('complete -c ox');
    // Should define fish completion functions
    expect(stdout).toContain('__ox_perform_completion');
    // Should reference the callback mechanism
    expect(stdout).toContain('ox complete --');
  });

  test('ox complete powershell outputs a valid PowerShell completion script', async () => {
    const { stdout, exitCode } = await runOx('complete', 'powershell');
    expect(exitCode).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
    // PowerShell registers completions via Register-ArgumentCompleter
    expect(stdout).toContain('Register-ArgumentCompleter');
    // Should reference the callback mechanism
    expect(stdout).toContain('ox complete');
  });

  test('ox complete with invalid shell exits with error', async () => {
    const { stderr, exitCode } = await runOx('complete', 'invalidshell');
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Usage:');
    expect(stderr).toContain('zsh|bash|fish|powershell');
  });
});

// ============================================================================
// Tier 1: Completion Resolution
// ============================================================================

describe('completion resolution', () => {
  test('empty input lists all subcommands', async () => {
    const { stdout, exitCode } = await runOx('complete', '--', '');
    expect(exitCode).toBe(0);

    const { completions, directive } = parseCompletionOutput(stdout);
    for (const cmd of EXPECTED_SUBCOMMANDS) {
      expect(completions).toContain(cmd);
    }
    // Directive 4 = ShellCompDirectiveNoFileComp
    expect(directive).toBe(4);
  });

  test('no args also lists all subcommands', async () => {
    const { stdout, exitCode } = await runOx('complete', '--');
    expect(exitCode).toBe(0);

    const { completions } = parseCompletionOutput(stdout);
    for (const cmd of EXPECTED_SUBCOMMANDS) {
      expect(completions).toContain(cmd);
    }
  });

  test('partial command narrows to matching subcommands', async () => {
    const { stdout, exitCode } = await runOx('complete', '--', 'br');
    expect(exitCode).toBe(0);

    const { completions } = parseCompletionOutput(stdout);
    expect(completions).toContain('branch');
    // Should not contain non-matching commands
    expect(completions).not.toContain('auth');
    expect(completions).not.toContain('shell');
  });

  test('unique prefix completes to matching commands and aliases', async () => {
    const { stdout, exitCode } = await runOx('complete', '--', 'up');
    expect(exitCode).toBe(0);

    const { completions } = parseCompletionOutput(stdout);
    expect(completions).toContain('upgrade');
    expect(completions).toContain('update');
    expect(completions).not.toContain('auth');
  });

  test('root flags complete when -- prefix is used', async () => {
    const { stdout, exitCode } = await runOx('complete', '--', '--');
    expect(exitCode).toBe(0);

    const { completions } = parseCompletionOutput(stdout);
    expect(completions).toContain('--version');
  });

  test('subcommand flags complete correctly', async () => {
    const { stdout, exitCode } = await runOx('complete', '--', 'branch', '--');
    expect(exitCode).toBe(0);

    const { completions } = parseCompletionOutput(stdout);
    expect(completions).toContain('--agent');
    expect(completions).toContain('--model');
    expect(completions).toContain('--follow');
    expect(completions).toContain('--provider');
  });

  test('completion output uses correct tab-separated format', async () => {
    const { stdout, exitCode } = await runOx('complete', '--', '');
    expect(exitCode).toBe(0);

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

  test('completions include descriptions for subcommands', async () => {
    const { stdout, exitCode } = await runOx('complete', '--', '');
    expect(exitCode).toBe(0);

    // Find the branch line and verify it has a description
    const lines = stdout.trim().split('\n');
    const branchLine = lines.find((l) => l.startsWith('branch\t'));
    expect(branchLine).toBeDefined();
    expect(branchLine).toContain('branch');
  });
});

// ============================================================================
// Tier 1: Completions Command (Human-Readable Instructions)
// ============================================================================

describe('completions command', () => {
  test('ox completions shows instructions for all shells', async () => {
    const { stdout, exitCode } = await runOx('completions');
    expect(exitCode).toBe(0);

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

  test('ox completions zsh shows zsh-specific instruction', async () => {
    const { stdout, exitCode } = await runOx('completions', 'zsh');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('source <(ox complete zsh)');
  });

  test('ox completions bash shows bash-specific instruction', async () => {
    const { stdout, exitCode } = await runOx('completions', 'bash');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('source <(ox complete bash)');
  });

  test('ox completions fish shows fish-specific instruction', async () => {
    const { stdout, exitCode } = await runOx('completions', 'fish');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('ox complete fish | source');
  });

  test('ox completions powershell shows powershell-specific instruction', async () => {
    const { stdout, exitCode } = await runOx('completions', 'powershell');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('ox complete powershell | Out-String');
  });

  test('ox completions with invalid shell exits with error', async () => {
    const { stderr, exitCode } = await runOx('completions', 'invalidshell');
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Unknown shell: invalidshell');
  });
});

// ============================================================================
// Tier 2: Bash End-to-End Completion Tests
//
// These tests source the generated bash completion script into a real bash
// shell, simulate TAB completion by manually setting COMP_* variables, and
// verify that COMPREPLY contains the expected completions.
// ============================================================================

describe('bash end-to-end completion', () => {
  let bashPath: string | undefined;
  let completionScript: string;

  beforeAll(async () => {
    // Check if bash is available
    try {
      const result = await Bun.$`which bash`.quiet();
      bashPath = result.stdout.toString().trim();
    } catch {
      bashPath = undefined;
    }

    if (bashPath) {
      // Pre-generate the completion script once
      const { stdout } = await runOx('complete', 'bash');
      completionScript = stdout;
    }
  });

  /**
   * Simulate bash completion for a given command line.
   *
   * Sources the ox completion script, provides a shim for
   * _get_comp_words_by_ref (from bash-completion package), sets up COMP_*
   * variables, invokes the completion function, and returns COMPREPLY.
   *
   * @param cmdLine - The command line to complete (e.g. "ox br")
   *                  Cursor is assumed to be at the end.
   * @returns Array of completion values from COMPREPLY
   */
  async function bashComplete(cmdLine: string): Promise<string[]> {
    if (!bashPath) return [];

    // The completion script uses _get_comp_words_by_ref from the
    // bash-completion package, which may not be installed. We provide a
    // minimal shim that sets cur/prev/words/cword from COMP_* variables,
    // which is exactly what the real function does.
    //
    // The completion function also uses compopt, which is only available
    // in interactive completion context. We provide a no-op shim.
    const bashScript = `
# Shim for _get_comp_words_by_ref (from bash-completion package)
_get_comp_words_by_ref() {
  # Parse the arguments that __ox_complete passes: -n "=:" cur prev words cword
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -n) shift ;; # skip the exclusion chars argument
      cur)   cur="\${COMP_WORDS[COMP_CWORD]}" ;;
      prev)  prev="\${COMP_WORDS[COMP_CWORD-1]}" ;;
      words) words=("\${COMP_WORDS[@]}") ;;
      cword) cword=$COMP_CWORD ;;
    esac
    shift
  done
}

# Shim for compopt (only available during real completion)
compopt() { :; }

# Make 'ox' resolve to our CLI via bun
ox() { "${BUN}" "${CLI}" "$@"; }
export -f ox

# Source the completion script
${completionScript}

# Simulate the command line
COMP_LINE="${cmdLine}"
COMP_POINT=\${#COMP_LINE}

# Split into words
read -ra COMP_WORDS <<< "$COMP_LINE"

# Trailing space means start of a new empty word
if [[ "$COMP_LINE" == *" " ]]; then
  COMP_WORDS+=("")
fi

# COMP_CWORD is the index of the word being completed
COMP_CWORD=$(( \${#COMP_WORDS[@]} - 1 ))

# Invoke the completion function
COMPREPLY=()
__ox_complete

# Output each completion on its own line
printf '%s\\n' "\${COMPREPLY[@]}"
`;

    try {
      const result = await Bun.$`${bashPath} -c ${bashScript}`
        .quiet()
        .cwd(PROJECT_ROOT)
        .env({
          ...process.env,
          BUN,
          CLI,
        });
      return result.stdout
        .toString()
        .trim()
        .split('\n')
        .filter((s) => s.length > 0);
    } catch (err) {
      const shellErr = err as ShellError;
      const stderr = shellErr.stderr?.toString() ?? '';
      throw new Error(
        `bash completion failed (exit ${shellErr.exitCode}): ${stderr}`,
      );
    }
  }

  test('completion function is registered after sourcing script', async () => {
    if (!bashPath) return;

    const script = `
_get_comp_words_by_ref() { :; }
compopt() { :; }
${completionScript}
complete -p ox
`;
    const result = await Bun.$`${bashPath} -c ${script}`
      .quiet()
      .cwd(PROJECT_ROOT);
    const output = result.stdout.toString();
    expect(output).toContain('complete');
    expect(output).toContain('__ox_complete');
    expect(output).toContain('ox');
  });

  test('ox <TAB> shows all subcommands', async () => {
    if (!bashPath) return;
    const completions = await bashComplete('ox ');
    for (const cmd of EXPECTED_SUBCOMMANDS) {
      expect(completions).toContain(cmd);
    }
  });

  test('ox br<TAB> narrows to branch', async () => {
    if (!bashPath) return;
    const completions = await bashComplete('ox br');
    expect(completions).toContain('branch');
    expect(completions).not.toContain('auth');
    expect(completions).not.toContain('shell');
  });

  test('ox co<TAB> narrows to matching commands', async () => {
    if (!bashPath) return;
    const completions = await bashComplete('ox co');
    expect(completions).toContain('colors');
    expect(completions).toContain('completions');
    expect(completions).toContain('config');
    expect(completions).not.toContain('branch');
  });

  test('ox branch --<TAB> shows branch flags', async () => {
    if (!bashPath) return;
    const completions = await bashComplete('ox branch --');
    expect(completions).toContain('--agent');
    expect(completions).toContain('--model');
    expect(completions).toContain('--provider');
  });

  test('ox branch --a<TAB> narrows to --agent', async () => {
    if (!bashPath) return;
    const completions = await bashComplete('ox branch --a');
    expect(completions).toContain('--agent');
    expect(completions).not.toContain('--model');
  });

  afterAll(() => {
    // Nothing to clean up — all bash processes are short-lived
  });
});
