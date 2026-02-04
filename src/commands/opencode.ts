// Pass-through to the opencode CLI, running in docker

import { resolve } from 'node:path';
import { Command } from 'commander';
import { ensureDockerSandbox } from '../services/docker';
import { log } from '../services/logger';
import {
  checkOpencodeCredentials,
  runOpencodeInDocker,
} from '../services/opencode';
import type { ShellError } from '../utils';

interface OpencodeOptions {
  mount?: string | true;
}

export const opencodeCommand = new Command('opencode')
  .description('Pass-through commands to the opencode CLI')
  .allowUnknownOption(true)
  .option(
    '--mount [dir]',
    'Mount local directory into container (defaults to cwd)',
  )
  .argument('[args...]', 'Arguments to pass to the opencode CLI')
  .action(async (args: string[], options: OpencodeOptions) => {
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

      const proc = await runOpencodeInDocker({
        dockerArgs,
        cmdArgs: args,
        interactive: true,
      });
      process.exit(await proc.exited);
    } catch (err) {
      log.error({ err }, 'Error executing opencode command');
      process.exit((err as ShellError).exitCode || 1);
    }
  });

opencodeCommand
  .command('check')
  .description('Check opencode CLI credentials')
  .action(async () => {
    try {
      await ensureDockerSandbox();
      const valid = await checkOpencodeCredentials();
      if (valid) {
        console.log('opencode CLI credentials are valid.');
        process.exit(0);
      } else {
        console.error('opencode CLI credentials are invalid.');
        process.exit(1);
      }
    } catch (err) {
      log.error({ err }, 'Error checking opencode credentials');
      process.exit((err as ShellError).exitCode || 1);
    }
  });
