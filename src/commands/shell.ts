import { Command, Option } from 'commander';
import { tryGetRepoInfo } from '../services/git';
import { log } from '../services/logger';
import type { SandboxProviderType } from '../services/sandbox';
import { getDefaultProvider, getSandboxProvider } from '../services/sandbox';
import { ensureSaneTerminal } from '../utils';

interface ShellOptions {
  mount?: string | true;
  provider?: SandboxProviderType;
}

function logProgress(step: string): void {
  process.stderr.write(`  ${step}...\r\n`);
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
      // Recover terminal line discipline in case a previous hermes
      // session left it in raw mode (e.g. onlcr disabled).
      ensureSaneTerminal();

      const provider = options.provider
        ? getSandboxProvider(options.provider)
        : await getDefaultProvider();

      logProgress('Checking sandbox runtime');
      await provider.ensureReady();

      logProgress('Ensuring sandbox image');
      await provider.ensureImage();

      logProgress('Getting repository info');
      const repoInfo = await tryGetRepoInfo();
      const mountDir =
        options.mount === true
          ? process.cwd()
          : typeof options.mount === 'string'
            ? options.mount
            : undefined;

      const shell = await provider.createShell({
        repoInfo,
        mountDir,
        isGitRepo: repoInfo !== null,
        onProgress: logProgress,
      });

      try {
        await shell.connect();
      } finally {
        logProgress('Cleaning up');
        await shell.cleanup();
      }
    } catch (err) {
      log.error({ err }, 'Error starting shell');
      console.error(`Error starting shell: ${err}`);
      process.exit(1);
    }
  });
