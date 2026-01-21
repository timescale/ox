// ============================================================================
// Conductor CLI - Main Entry Point
// ============================================================================

import { program } from 'commander';
import {
  branchAction,
  branchCommand,
  withBranchOptions,
} from './commands/branch';
import { initCommand } from './commands/init';
import { sessionsCommand } from './commands/sessions';

program
  .name('conductor')
  .description('Automates branch + database fork + agent sandbox creation')
  .version('1.0.0')
  .enablePositionalOptions();

// Make 'branch' the default command by adding same options to root
// This must be done BEFORE adding subcommands so that subcommands take precedence
withBranchOptions(program)
  .argument('[prompt]', 'Natural language description of the task')
  .action(async (prompt, options) => {
    // Only run if prompt is provided (otherwise show help)
    if (prompt) {
      await branchAction(prompt, options);
    } else {
      program.help();
    }
  });

// Add subcommands (after root options so they take precedence)
program.addCommand(branchCommand);
program.addCommand(initCommand);
program.addCommand(sessionsCommand);

program.parse();
