// Pass-through to the ghost CLI, running in docker

import { Command } from 'commander';
import { ensureDockerSandbox } from '../services/docker';
import { runGhostInDocker } from '../services/ghost';
import { log } from '../services/logger';
import type { ShellError } from '../utils/shell.ts';

interface Options {
  mount?: string | true;
}

export const ghostCommand = new Command('ghost')
  .description('Pass-through commands to the Ghost CLI')
  .allowUnknownOption(true)
  .option(
    '--mount [dir]',
    'Mount local directory into container (defaults to cwd)',
  )
  .argument('[args...]', 'Arguments to pass to the Ghost CLI')
  .action(async (args: string[], options: Options) => {
    try {
      await ensureDockerSandbox();

      const proc = await runGhostInDocker({
        cmdArgs: args,
        interactive: true,
        mountCwd: options.mount,
        saveCredentials: true,
      });
      const exitCode = await proc.exited;
      // Wait for credential capture to finish before exiting
      await proc.credsCaptured;
      process.exit(exitCode);
    } catch (err) {
      log.error({ err }, 'Error executing ghost command');
      process.exit((err as ShellError).exitCode || 1);
    }
  });
