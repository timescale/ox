// Pass-through to the opencode CLI, running in docker

import { Command } from 'commander';
import { ensureDockerSandbox } from '../services/docker';
import { log } from '../services/logger';
import {
  checkOpencodeCredentials,
  runOpencodeInDocker,
} from '../services/opencode';
import type { ShellError } from '../utils';

export const opencodeCommand = new Command('opencode')
  .description('Pass-through commands to the opencode CLI')
  .allowUnknownOption(true)
  .argument('[args...]', 'Arguments to pass to the opencode CLI')
  .action(async (args: string[]) => {
    try {
      await ensureDockerSandbox();
      const proc = await runOpencodeInDocker({
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
