// Pass-through to the gh CLI, running in docker

import { Command } from 'commander';
import { ensureDockerSandbox } from '../services/docker';
import { runGhInDocker } from '../services/gh';
import { log } from '../services/logger';
import type { ShellError } from '../utils/shell.ts';

interface Options {
  mount?: string | true;
}

export const ghCommand = new Command('gh')
  .description('Pass-through commands to the gh CLI')
  .allowUnknownOption(true)
  .option(
    '--mount [dir]',
    'Mount local directory into container (defaults to cwd)',
  )
  .argument('[args...]', 'Arguments to pass to the gh CLI')
  .action(async (args: string[], options: Options) => {
    try {
      await ensureDockerSandbox();

      const proc = await runGhInDocker({
        cmdArgs: args,
        interactive: true,
        mountCwd: options.mount,
        saveCredentials: true,
      });
      process.exit(await proc.exited);
    } catch (err) {
      log.error({ err }, 'Error executing gh command');
      process.exit((err as ShellError).exitCode || 1);
    }
  });
