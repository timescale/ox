// ============================================================================
// Completion Command - Generate shell completions using @bomb.sh/tab
// ============================================================================

import t, { type Complete } from '@bomb.sh/tab';
import createTabFromCommander from '@bomb.sh/tab/commander';
import { Command, type Command as CommandType } from 'commander';
import type { OxSession } from '../services/sandbox/types.ts';

type Shell = 'zsh' | 'bash' | 'fish' | 'powershell';
const SHELLS: Shell[] = ['zsh', 'bash', 'fish', 'powershell'];

// ============================================================================
// Session name completion
// ============================================================================

/**
 * Get session names synchronously for tab completion.
 * Combines Docker containers (via docker ps) and cloud sessions (via SQLite).
 * Must be synchronous — @bomb.sh/tab handlers don't support async.
 */
function getSessionCompletions(): { name: string; description: string }[] {
  const sessions: { name: string; description: string }[] = [];

  // Docker sessions: synchronous subprocess
  try {
    const result = Bun.spawnSync(
      [
        'docker',
        'ps',
        '-a',
        '--filter',
        'label=ox.managed=true',
        '--format',
        '{{.Label "ox.name"}}\t{{.Status}}\t{{.ID}}',
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    if (result.exitCode === 0) {
      const lines = result.stdout.toString().trim().split('\n');
      for (const line of lines) {
        if (!line) continue;
        const [name, status, id] = line.split('\t');
        if (name) {
          sessions.push({
            name,
            description: `${status ?? ''} (${id ?? ''})`.trim(),
          });
        }
      }
    }
  } catch {
    // Docker not available — skip
  }

  // Cloud sessions: synchronous SQLite read
  try {
    const { openSessionDb, listSessions } =
      require('../services/sandbox/sessionDb.ts') as {
        openSessionDb: () => import('bun:sqlite').Database;
        listSessions: (
          db: import('bun:sqlite').Database,
          filter?: { provider?: string },
        ) => OxSession[];
      };
    const db = openSessionDb();
    const cloudSessions = listSessions(db, { provider: 'cloud' });
    for (const s of cloudSessions) {
      // Avoid duplicates if name already added from Docker
      if (!sessions.some((existing) => existing.name === s.name)) {
        sessions.push({ name: s.name, description: `${s.status} (cloud)` });
      }
    }
  } catch {
    // Session DB not available — skip
  }

  return sessions;
}

/**
 * Argument handler that provides session name completions.
 */
function completeSessionId(complete: Complete): void {
  for (const s of getSessionCompletions()) {
    complete(s.name, s.description);
  }
}

/**
 * Register argument completions for commands that take a session ID.
 */
function registerSessionCompletions(): void {
  // Commands under "session" that take a session <id> argument
  const sessionSubcommands = [
    'session rm',
    'session stop',
    'session attach',
    'session logs',
    'session info',
    'session urls',
  ];

  for (const path of sessionSubcommands) {
    const cmd = t.commands.get(path);
    if (cmd) {
      cmd.argument('id', completeSessionId);
    }
  }

  // Also handle the standalone "resume" command
  const resumeCmd = t.commands.get('resume');
  if (resumeCmd) {
    resumeCmd.argument('session', completeSessionId);
  }
}

// ============================================================================
// Alias registration
// ============================================================================

/**
 * Copy a tab command's options and arguments to a new alias command.
 */
function mirrorTabCommand(
  sourcePath: string,
  aliasPath: string,
  description: string,
): void {
  if (t.commands.get(aliasPath)) return; // Already registered
  const source = t.commands.get(sourcePath);
  if (!source) return;

  const alias = t.command(aliasPath, description);
  for (const [, opt] of source.options) {
    alias.option(opt.value, opt.description, opt.alias);
  }
  for (const [argName, arg] of source.arguments) {
    alias.argument(argName, arg.handler, arg.variadic);
  }
}

/**
 * Walk the commander tree and register aliases with the tab library.
 * The @bomb.sh/tab commander adapter only registers primary command names,
 * so aliases like "container" for "session" are missing. This function
 * registers each alias as a mirror of its primary command, and recursively
 * handles subcommands so that e.g. "container rm" mirrors "session rm".
 */
function registerCommandAliases(
  cmd: CommandType,
  primaryPrefix: string,
  aliasPrefix: string,
): void {
  for (const sub of cmd.commands) {
    const name = sub.name();
    const primaryPath = primaryPrefix ? `${primaryPrefix} ${name}` : name;
    const aliasPath = aliasPrefix ? `${aliasPrefix} ${name}` : name;

    // Mirror this subcommand under the alias prefix
    if (aliasPath !== primaryPath) {
      mirrorTabCommand(primaryPath, aliasPath, sub.description() || '');
    }

    // Also mirror any aliases of this subcommand under the alias prefix
    for (const subAlias of sub.aliases()) {
      const subAliasPath = aliasPrefix
        ? `${aliasPrefix} ${subAlias}`
        : subAlias;
      mirrorTabCommand(primaryPath, subAliasPath, sub.description() || '');
    }

    // Also mirror subcommand aliases under the primary prefix
    for (const subAlias of sub.aliases()) {
      const subAliasPath = primaryPrefix
        ? `${primaryPrefix} ${subAlias}`
        : subAlias;
      mirrorTabCommand(primaryPath, subAliasPath, sub.description() || '');
    }

    // Recurse: register aliases of deeper subcommands under this alias prefix
    registerCommandAliases(sub, primaryPath, aliasPath);
  }
}

/**
 * Register all command aliases from the commander program tree.
 */
function registerAllAliases(program: CommandType): void {
  for (const cmd of program.commands) {
    const name = cmd.name();
    const aliases = cmd.aliases();

    // Register each top-level alias
    for (const alias of aliases) {
      mirrorTabCommand(name, alias, cmd.description() || '');
      // Recurse: register subcommands under the alias
      registerCommandAliases(cmd, name, alias);
    }

    // Also register subcommand aliases under the primary name
    registerCommandAliases(cmd, name, name);
  }
}

// ============================================================================
// Completion handler
// ============================================================================

/**
 * Handle completion requests before commander parses args.
 * Must be called early in the CLI bootstrap, before program.parse().
 *
 * @param program - The root commander program
 * @returns true if this was a completion request (handled), false otherwise
 */
export function handleCompletionRequest(program: CommandType): boolean {
  if (process.argv[2] !== 'complete') {
    return false;
  }

  // Initialize tab with commander program structure
  createTabFromCommander(program);

  // Register dynamic argument completions (before aliases, so aliases copy them)
  registerSessionCompletions();

  // Register command aliases (must be after argument handlers are set up)
  registerAllAliases(program);

  const shell = process.argv[3];
  if (shell === '--') {
    // Parse completion request (called by shell during tab completion)
    const args = process.argv.slice(4);
    t.parse(args);
  } else if (shell && SHELLS.includes(shell as Shell)) {
    // Generate shell completion script
    t.setup('ox', 'ox', shell);
  } else {
    console.error(`Usage: ox complete <${SHELLS.join('|')}>`);
    console.error('       ox complete -- <args...>');
    process.exit(1);
  }
  process.exit(0);
}

/**
 * Completions command for discoverability - shows setup instructions
 */
export const completionCommand = new Command('completions')
  .description('Set up shell completions')
  .argument('[shell]', `Shell type (${SHELLS.join(', ')})`)
  .action((shell?: string) => {
    if (!shell) {
      console.log(`Available shells: ${SHELLS.join(', ')}`);
      console.log(
        '\nTo enable tab completion, add one of these to your shell config:\n',
      );
      console.log('  Zsh (~/.zshrc):');
      console.log('    source <(ox complete zsh)\n');
      console.log('  Bash (~/.bashrc):');
      console.log('    source <(ox complete bash)\n');
      console.log('  Fish (~/.config/fish/config.fish):');
      console.log('    ox complete fish | source\n');
      console.log('  PowerShell:');
      console.log(
        '    ox complete powershell | Out-String | Invoke-Expression',
      );
      return;
    }
    if (!SHELLS.includes(shell as Shell)) {
      console.error(`Unknown shell: ${shell}`);
      console.error(`Available: ${SHELLS.join(', ')}`);
      process.exit(1);
    }
    console.log('# Add to your shell config:');
    if (shell === 'fish') {
      console.log('ox complete fish | source');
    } else if (shell === 'powershell') {
      console.log('ox complete powershell | Out-String | Invoke-Expression');
    } else {
      console.log(`source <(ox complete ${shell})`);
    }
  });
