import { Command } from 'commander';
import { ensureDockerSandbox, getCredentialFiles } from '../services/docker';
import { log } from '../services/logger';
import { runInDocker } from '../services/runInDocker';
import type { ShellError } from '../utils';

interface ShellOptions {
  mount?: string | true;
}

export const shellCommand = new Command('shell')
  .description('start an interactive shell in a new sandbox')
  .option(
    '--mount [dir]',
    'Mount local directory into container (defaults to cwd)',
  )
  .action(async (options: ShellOptions) => {
    try {
      await ensureDockerSandbox();

      const files = await getCredentialFiles();

      const proc = await runInDocker({
        cmdName: 'bash',
        interactive: true,
        files,
        mountCwd: options.mount,
      });
      process.exit(await proc.exited);
    } catch (err) {
      log.error({ err }, 'Error starting shell');
      process.exit((err as ShellError).exitCode || 1);
    }
  });
