// Pass-through to the opencode CLI, running in docker

import { Command } from 'commander';
import { ensureDockerSandbox } from '../services/docker';
import { log } from '../services/logger';
import { runOpencodeInDocker } from '../services/opencode';
import type { ShellError } from '../utils/shell.ts';

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

      const proc = await runOpencodeInDocker({
        cmdArgs: args,
        interactive: true,
        mountCwd: options.mount,
      });
      process.exit(await proc.exited);
    } catch (err) {
      log.error({ err }, 'Error executing opencode command');
      process.exit((err as ShellError).exitCode || 1);
    }
  });
