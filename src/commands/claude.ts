// Pass-through to the Tiger CLI, running in docker

import { resolve } from 'node:path';
import { Command } from 'commander';
import { checkClaudeCredentials, runClaudeInDocker } from '../services/claude';
import { ensureDockerSandbox } from '../services/docker';
import { log } from '../services/logger';
import type { ShellError } from '../utils';

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

      const proc = await runClaudeInDocker({
        dockerArgs,
        cmdArgs: args,
        interactive: true,
      });
      process.exit(await proc.exited);
    } catch (err) {
      log.error({ err }, 'Error executing claude command');
      process.exit((err as ShellError).exitCode || 1);
    }
  });

claudeCommand
  .command('check')
  .description('Check Claude CLI credentials')
  .action(async () => {
    try {
      await ensureDockerSandbox();
      const valid = await checkClaudeCredentials();
      if (valid) {
        console.log('Claude CLI credentials are valid.');
        process.exit(0);
      } else {
        console.error('Claude CLI credentials are invalid.');
        process.exit(1);
      }
    } catch (err) {
      log.error({ err }, 'Error checking Claude credentials');
      process.exit((err as ShellError).exitCode || 1);
    }
  });
