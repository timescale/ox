// ============================================================================
// Bash End-to-End Completion Tests
//
// These tests source the generated bash completion script into a real bash
// shell, simulate TAB completion by manually setting COMP_* variables, and
// verify that COMPREPLY contains the expected completions.
// ============================================================================

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  generateCompletionScript,
  initializeTab,
} from '../src/commands/completion.ts';
import { createProgram } from '../src/createProgram.ts';
import type { ShellError } from '../src/utils/shell.ts';

const PROJECT_ROOT = resolve(import.meta.dir, '..');
const BUN = resolve(PROJECT_ROOT, 'bun');
const CLI = resolve(PROJECT_ROOT, 'index.ts');

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

// Initialize tab once for all tests
const program = createProgram();
const tab = initializeTab(program);

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
      // Generate the completion script in-process (no subprocess needed)
      completionScript = generateCompletionScript(tab, 'bash');
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

  test('ox se<TAB> narrows to session/sessions', async () => {
    if (!bashPath) return;
    const completions = await bashComplete('ox se');
    expect(completions).toContain('session');
    expect(completions).toContain('sessions');
    expect(completions).not.toContain('auth');
    expect(completions).not.toContain('shell');
  });

  test('ox co<TAB> narrows to matching commands', async () => {
    if (!bashPath) return;
    const completions = await bashComplete('ox co');
    expect(completions).toContain('colors');
    expect(completions).toContain('completions');
    expect(completions).toContain('config');
    expect(completions).not.toContain('auth');
  });

  test('ox session logs --<TAB> shows logs flags', async () => {
    if (!bashPath) return;
    const completions = await bashComplete('ox session logs --');
    expect(completions).toContain('--follow');
    expect(completions).toContain('--tail');
  });

  afterAll(() => {
    // Nothing to clean up — all bash processes are short-lived
  });
});
