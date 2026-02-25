import { Command } from 'commander';
import { log } from '../services/logger.ts';
import {
  deleteResource,
  getCleanupTargets,
  listAllResources,
  type SandboxResource,
} from '../services/sandbox/resources.ts';
import { formatSize } from '../services/sessionDisplay.ts';

function printResourceTable(resources: SandboxResource[]): void {
  if (resources.length === 0) {
    console.log('No resources found.');
    return;
  }

  console.log(
    `${'STATUS'.padEnd(8)} ${'PROVIDER'.padEnd(8)} ${'CATEGORY'.padEnd(16)} ${'NAME'.padEnd(34)} ${'SIZE'.padEnd(7)}`,
  );
  console.log('-'.repeat(80));

  for (const r of resources) {
    const icon =
      r.status === 'current' || r.status === 'active'
        ? '\u25CF'
        : r.status === 'old'
          ? '\u25CB'
          : '\u25CC';
    console.log(
      `${`${icon} ${r.status}`.padEnd(8)} ${r.provider.padEnd(8)} ${r.category.padEnd(16)} ${r.name.padEnd(34)} ${formatSize(r.size).padEnd(7)}`,
    );
  }
}

export const resourcesCommand = new Command('resources')
  .description('Manage sandbox images, volumes, and snapshots')
  .action(async () => {
    // Default action: open the TUI resources view
    const { runSessionsTui } = await import('./sessions.tsx');
    await runSessionsTui({ initialView: 'resources' });
  });

// Subcommand: list
const listCommand = new Command('list')
  .description('List all sandbox resources')
  .action(async () => {
    const resources = await listAllResources();
    printResourceTable(resources);

    const targets = getCleanupTargets(resources);
    if (targets.length > 0) {
      console.log(
        `\n${targets.length} resource(s) can be cleaned up. Run 'hermes resources clean' to remove them.`,
      );
    }
  });

// Subcommand: clean
const cleanCommand = new Command('clean')
  .description('Remove old and orphaned sandbox resources')
  .option('-f, --force', 'Skip confirmation prompt')
  .action(async (options: { force?: boolean }) => {
    const resources = await listAllResources();
    const targets = getCleanupTargets(resources);

    if (targets.length === 0) {
      console.log('No resources to clean up.');
      return;
    }

    console.log(`Found ${targets.length} resource(s) to remove:`);
    for (const t of targets) {
      console.log(
        `  ${t.status === 'old' ? '\u25CB' : '\u25CC'} [${t.provider}] ${t.name} (${t.category})`,
      );
    }

    if (!options.force) {
      const readline = await import('node:readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const answer = await new Promise<string>((resolve) => {
        rl.question('\nProceed? [y/N] ', resolve);
      });
      rl.close();

      if (answer.toLowerCase() !== 'y') {
        console.log('Cancelled.');
        return;
      }
    }

    console.log('');
    let removed = 0;
    let failed = 0;
    for (const target of targets) {
      try {
        await deleteResource(target);
        console.log(`Removed ${target.name}`);
        removed++;
      } catch (err) {
        log.error({ err }, `Failed to remove ${target.name}`);
        console.error(`Failed to remove ${target.name}: ${err}`);
        failed++;
      }
    }

    console.log(`\nDone: ${removed} removed, ${failed} failed.`);
  });

resourcesCommand.addCommand(listCommand);
resourcesCommand.addCommand(cleanCommand);
