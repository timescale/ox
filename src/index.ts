// ============================================================================
// Hermes CLI - Main Entry Point
// ============================================================================

import { program } from 'commander';
import packageJson from '../package.json' with { type: 'json' };
import { authCommand } from './commands/auth';
import {
  branchAction,
  branchCommand,
  withBranchOptions,
} from './commands/branch';
import { claudeCommand } from './commands/claude';
import { colorsCommand } from './commands/colors';
import {
  completionCommand,
  handleCompletionRequest,
} from './commands/completion';
import { configCommand } from './commands/config';
import { ghCommand } from './commands/gh';
import { logsCommand } from './commands/logs';
import { opencodeCommand } from './commands/opencode';
import { resumeCommand } from './commands/resume';
import { runSessionsTui, sessionsCommand } from './commands/sessions';
import { shellCommand } from './commands/shell';
import { upgradeCommand } from './commands/upgrade';
import { log } from './services/logger';
import { checkForUpdate, isCompiledBinary } from './services/updater';
import { printErr } from './utils';

program
  .name('hermes')
  .description('Automates branch + database fork + agent sandbox creation')
  .version(packageJson.version, '-v, --version')
  .enablePositionalOptions();

// Make 'branch' the default command by adding same options to root
// This must be done BEFORE adding subcommands so that subcommands take precedence
withBranchOptions(program)
  .argument('[prompt]', 'Natural language description of the task')
  .action(async (prompt, options) => {
    log.debug({ options, prompt }, 'Root hermes command invoked');
    if (prompt) {
      // Guard against accidentally running with an invalid command as prompt
      // Prompt must contain at least one space (more than one word)
      if (!prompt.includes(' ')) {
        console.error(
          `Error: Prompt must be more than one word. Did you mean to run a command?\n`,
        );
        program.help();
        return;
      }

      // -p (print) or -i (interactive) flags: use non-TUI flow
      if (options.print || options.interactive) {
        await branchAction(prompt, options);
        return;
      }
    }

    // Default: use unified TUI starting at 'starting' view
    await runSessionsTui({
      initialView: prompt ? 'starting' : 'prompt',
      initialPrompt: prompt,
      initialAgent: options.agent,
      initialModel: options.model,
      serviceId: options.serviceId,
      dbFork: options.dbFork,
    });
  });

// Add subcommands (after root options so they take precedence)
program.addCommand(authCommand);
program.addCommand(branchCommand);
program.addCommand(claudeCommand);
program.addCommand(colorsCommand);
program.addCommand(completionCommand);
program.addCommand(configCommand);
program.addCommand(ghCommand);
program.addCommand(logsCommand);
program.addCommand(opencodeCommand);
program.addCommand(resumeCommand);
program.addCommand(sessionsCommand);
program.addCommand(shellCommand);
program.addCommand(upgradeCommand);

// Background update check for non-TUI commands.
// The TUI handles its own auto-update; the upgrade command handles its own check.
// This uses commander's hook system so it works regardless of how the command was
// invoked (full name, alias, or abbreviation).
if (isCompiledBinary()) {
  const skipCommands = new Set([
    upgradeCommand,
    completionCommand,
  ]);

  for (const cmd of program.commands) {
    if (skipCommands.has(cmd)) continue;

    cmd.hook('preAction', () => {
      const updateCheck = checkForUpdate().catch(() => null);
      process.on('beforeExit', () => {
        updateCheck.then((update) => {
          if (update) {
            printErr(
              `\nA new version of hermes is available: v${update.latestVersion} (current: v${update.currentVersion})`,
            );
            printErr("Run 'hermes upgrade' to update.");
          }
        });
      });
    });
  }
}

// Handle `hermes complete <shell>` before parseAsync for tab library
// This must happen after all commands are added so tab can introspect them
if (!handleCompletionRequest(program)) {
  program.parse();
}
