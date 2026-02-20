// ============================================================================
// Upgrade Command - Check for and install hermes updates
// ============================================================================

import { Command } from 'commander';
import packageJson from '../../package.json' with { type: 'json' };
import { log } from '../services/logger';
import {
  checkForUpdate,
  isCompiledBinary,
  performUpdate,
} from '../services/updater';
import { printErr } from '../utils';

async function upgradeAction(): Promise<void> {
  if (!isCompiledBinary()) {
    printErr('Skipping upgrade: running from source (not a compiled binary).');
    process.stdout.write(`${packageJson.version}\n`);
    process.exit(0);
  }

  printErr(`Current version: ${packageJson.version}`);
  printErr('Checking for updates...');

  const update = await checkForUpdate();

  if (!update) {
    printErr('Already up to date.');
    process.stdout.write(`${packageJson.version}\n`);
    process.exit(0);
  }

  printErr(`New version available: v${update.latestVersion}`);

  try {
    await performUpdate(update, (progress) => {
      printErr(progress.message);
    });
  } catch (err) {
    log.error({ err }, 'Upgrade failed');
    printErr(
      `Upgrade failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  // Print only the new version to stdout (for scripting)
  process.stdout.write(`${update.latestVersion}\n`);
  process.exit(0);
}

export const upgradeCommand = new Command('upgrade')
  .aliases(['update', 'u'])
  .description('Check for and install hermes updates')
  .action(upgradeAction);
