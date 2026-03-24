// ============================================================================
// Program Factory - Build the commander program without side effects
// ============================================================================

import { Command } from 'commander';
import packageJson from '../package.json' with { type: 'json' };
import { authCommand } from './commands/auth';
import { claudeCommand } from './commands/claude';
import { codexCommand } from './commands/codex';
import { colorsCommand } from './commands/colors';
import { completionCommand } from './commands/completion';
import { configCommand } from './commands/config';
import { feedbackCommand } from './commands/feedback';
import { ghCommand } from './commands/gh';
import { logsCommand } from './commands/logs';
import { opencodeCommand } from './commands/opencode';
import { resourcesCommand } from './commands/resources.tsx';
import { resumeCommand } from './commands/resume';
import { rootAction, withBranchOptions } from './commands/root';
import { sandboxCommand } from './commands/sandbox';
import { sessionCommand } from './commands/session';
import { sessionsCommand } from './commands/sessions';
import { shellCommand } from './commands/shell';
import { upgradeCommand } from './commands/upgrade';

/**
 * Build the commander program with all commands registered.
 * No side effects — no analytics, no process handlers, no parsing.
 *
 * Returns a new root Command instance. Subcommands are shared singleton
 * instances, so this should only be called once per process.
 */
export function createProgram(): Command {
  const prog = new Command();

  prog
    .name('ox')
    .description('Automates branch + database fork + agent sandbox creation')
    .version(packageJson.version, '-v, --version')
    .enablePositionalOptions();

  // Root branch options and action (default command)
  withBranchOptions(prog)
    .argument('[prompt]', 'Natural language description of the task')
    .action((prompt, options) => rootAction(prog, prompt, options));

  // Subcommands
  prog.addCommand(authCommand);
  prog.addCommand(claudeCommand);
  prog.addCommand(codexCommand);
  prog.addCommand(colorsCommand);
  prog.addCommand(completionCommand);
  prog.addCommand(configCommand);
  prog.addCommand(feedbackCommand);
  prog.addCommand(ghCommand);
  prog.addCommand(logsCommand);
  prog.addCommand(opencodeCommand);
  prog.addCommand(resourcesCommand);
  prog.addCommand(resumeCommand);
  prog.addCommand(sandboxCommand);
  prog.addCommand(sessionCommand);
  prog.addCommand(sessionsCommand);
  prog.addCommand(shellCommand);
  prog.addCommand(upgradeCommand);

  return prog;
}
