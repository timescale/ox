// Pass-through to the codex CLI, running in docker

import { Command } from 'commander';
import { runCodexInDocker } from '../services/codex';
import { ensureDockerSandbox } from '../services/docker';
import { log } from '../services/logger';
import type { ShellError } from '../utils/shell.ts';

interface CodexOptions {
  mount?: string | true;
}

export const codexCommand = new Command('codex')
  .description('Pass-through commands to the Codex CLI')
  .allowUnknownOption(true)
  .option(
    '--mount [dir]',
    'Mount local directory into container (defaults to cwd)',
  )
  .argument('[args...]', 'Arguments to pass to the codex CLI')
  .action(async (args: string[], options: CodexOptions) => {
    try {
      await ensureDockerSandbox();

      const proc = await runCodexInDocker({
        mountCwd: options.mount,
        cmdArgs: args,
        interactive: true,
      });
      await proc.credsCaptured;
      process.exit(await proc.exited);
    } catch (err) {
      log.error({ err }, 'Error executing codex command');
      process.exit((err as ShellError).exitCode || 1);
    }
  });
