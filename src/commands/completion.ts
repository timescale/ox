// ============================================================================
// Completion Command - Generate shell completions using @bomb.sh/tab
// ============================================================================

import t from '@bomb.sh/tab';
import createTabFromCommander from '@bomb.sh/tab/commander';
import { Command, type Command as CommandType } from 'commander';

type Shell = 'zsh' | 'bash' | 'fish' | 'powershell';
const SHELLS: Shell[] = ['zsh', 'bash', 'fish', 'powershell'];

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

  const shell = process.argv[3];
  if (shell === '--') {
    // Parse completion request (called by shell during tab completion)
    const args = process.argv.slice(4);
    t.parse(args);
  } else if (shell && SHELLS.includes(shell as Shell)) {
    // Generate shell completion script
    t.setup('hermes', 'hermes', shell);
  } else {
    console.error(`Usage: hermes complete <${SHELLS.join('|')}>`);
    console.error('       hermes complete -- <args...>');
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
      console.log('    source <(hermes complete zsh)\n');
      console.log('  Bash (~/.bashrc):');
      console.log('    source <(hermes complete bash)\n');
      console.log('  Fish (~/.config/fish/config.fish):');
      console.log('    hermes complete fish | source\n');
      console.log('  PowerShell:');
      console.log(
        '    hermes complete powershell | Out-String | Invoke-Expression',
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
      console.log('hermes complete fish | source');
    } else if (shell === 'powershell') {
      console.log(
        'hermes complete powershell | Out-String | Invoke-Expression',
      );
    } else {
      console.log(`source <(hermes complete ${shell})`);
    }
  });
