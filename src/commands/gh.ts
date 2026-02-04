// Pass-through to the gh CLI, running in docker

import { resolve } from 'node:path';
import { Command } from 'commander';
import { ensureDockerSandbox } from '../services/docker';
import { runGhInDocker } from '../services/gh';
import { log } from '../services/logger';
import type { ShellError } from '../utils';

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

      // Build docker args with optional mount
      const dockerArgs: string[] = ['--rm'];
      if (options.mount) {
        const mountDir = options.mount === true ? process.cwd() : options.mount;
        const absoluteMountDir = resolve(mountDir);
        dockerArgs.push(
          '-v',
          `${absoluteMountDir}:/work/app`,
          '-w',
          '/work/app',
        );
      }

      const proc = await runGhInDocker({
        dockerArgs,
        cmdArgs: args,
        interactive: true,
      });
      process.exit(await proc.exited);
    } catch (err) {
      log.error({ err }, 'Error executing gh command');
      process.exit((err as ShellError).exitCode || 1);
    }
  });
