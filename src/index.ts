// ============================================================================
// Conductor CLI - Main Entry Point
// ============================================================================

import { program } from 'commander';
import { branchCommand } from './commands/branch';

program
  .name('conductor')
  .description('Automates branch + database fork + agent sandbox creation')
  .version('1.0.0');

program.addCommand(branchCommand);

program.parse();
