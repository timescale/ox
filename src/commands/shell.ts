import { resolve } from 'node:path';
import { Command } from 'commander';
import { ensureDockerSandbox, getCredentialVolumes, toVolumeArgs } from '../services/docker';
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

      const volumes = await getCredentialVolumes();
      // Build docker args with optional mount
      const dockerArgs: string[] = ['--rm'];
      if (options.mount) {
        const mountDir = options.mount === true ? process.cwd() : options.mount;
        const absoluteMountDir = resolve(mountDir);
        volumes.push(`${absoluteMountDir}:/work/app`);
        dockerArgs.push(
          '-w',
          '/work/app',
        );
      }

      dockerArgs.push(...toVolumeArgs(volumes));

      const proc = await runInDocker({
        cmdName: 'bash',
        dockerArgs,
        interactive: true,
      });
      process.exit(await proc.exited);
    } catch (err) {
      log.error({ err }, 'Error starting shell');
      process.exit((err as ShellError).exitCode || 1);
    }
  });
