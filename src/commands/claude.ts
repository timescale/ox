// Pass-through to the claude CLI, running in docker

import { Command } from 'commander';
import { runClaudeInDocker } from '../services/claude';
import { ensureDockerSandbox } from '../services/docker';
import { log } from '../services/logger';
import type { ShellError } from '../utils/shell.ts';

interface ClaudeOptions {
  mount?: string | true;
}

export const claudeCommand = new Command('claude')
  .description('Pass-through commands to the Claude CLI')
  .allowUnknownOption(true)
  .option(
    '--mount [dir]',
    'Mount local directory into container (defaults to cwd)',
  )
  .argument('[args...]', 'Arguments to pass to the claude CLI')
  .action(async (args: string[], options: ClaudeOptions) => {
    try {
      await ensureDockerSandbox();

      const proc = await runClaudeInDocker({
        mountCwd: options.mount,
        cmdArgs: args,
        interactive: true,
      });
      await proc.removed;
      process.exit(await proc.exited);
    } catch (err) {
      log.error({ err }, 'Error executing claude command');
      process.exit((err as ShellError).exitCode || 1);
    }
  });
