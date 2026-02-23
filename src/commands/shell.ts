import { Command, Option } from 'commander';
import { tryGetRepoInfo } from '../services/git';
import { log } from '../services/logger';
import type { SandboxProviderType } from '../services/sandbox';
import { getDefaultProvider, getSandboxProvider } from '../services/sandbox';

interface ShellOptions {
  mount?: string | true;
  provider?: SandboxProviderType;
}

export const shellCommand = new Command('shell')
  .description('start an interactive shell in a new sandbox')
  .option(
    '--mount [dir]',
    'Mount local directory into container (defaults to cwd)',
  )
  .addOption(
    new Option(
      '-r, --provider <type>',
      'Sandbox provider: docker or cloud (overrides config)',
    ).choices(['docker', 'cloud']),
  )
  .action(async (options: ShellOptions) => {
    try {
      const provider = options.provider
        ? getSandboxProvider(options.provider)
        : await getDefaultProvider();

      await provider.ensureReady();
      await provider.ensureImage();

      const repoInfo = await tryGetRepoInfo();
      const mountDir =
        options.mount === true
          ? process.cwd()
          : typeof options.mount === 'string'
            ? options.mount
            : undefined;

      await provider.createShell({
        repoInfo,
        mountDir,
        isGitRepo: repoInfo !== null,
      });
    } catch (err) {
      log.error({ err }, 'Error starting shell');
      process.exit(1);
    }
  });
