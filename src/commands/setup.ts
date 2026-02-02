// ============================================================================
// Setup Command - Pre-download optional tools for offline use
// ============================================================================

import { Command } from 'commander';
import {
  ensureDockerImage,
  HASHED_SANDBOX_DOCKER_IMAGE,
} from '../services/docker';
import { log } from '../services/logger';
import {
  ALL_LAZY_TOOLS,
  ensureToolsDirectory,
  getMissingTools,
  getTotalSizeEstimate,
  LAZY_TOOLS,
  TOOLS_VOLUME_MOUNT,
} from '../services/tools';

async function setupAction(options: { full?: boolean }): Promise<void> {
  const { full } = options;

  if (!full) {
    console.log('Usage: hermes setup --full');
    console.log('');
    console.log('Pre-download all optional tools for faster first-time use.');
    console.log('');
    console.log('Available tools:');
    for (const tool of ALL_LAZY_TOOLS) {
      const meta = LAZY_TOOLS[tool];
      console.log(`  - ${meta.displayName} (${meta.sizeEstimate})`);
    }
    console.log('');
    console.log('Run with --full to download all tools now.');
    return;
  }

  // Ensure Docker image exists
  console.log('Checking Docker sandbox image...');
  await ensureDockerImage({
    onProgress: (progress) => {
      if (progress.type === 'pulling-cache' || progress.type === 'building') {
        console.log(`  ${progress.message}`);
      }
    },
  });

  // Check which tools need to be installed
  const missingTools = await getMissingTools();

  if (missingTools.length === 0) {
    console.log('\nAll tools are already installed!');
    return;
  }

  const totalSize = getTotalSizeEstimate(missingTools);
  console.log(
    `\nPre-downloading ${missingTools.length} tool(s) (${totalSize})...`,
  );

  // Ensure tools directory exists
  await ensureToolsDirectory();

  // Run the installer in a container
  try {
    const proc = Bun.spawn(
      [
        'docker',
        'run',
        '--rm',
        '-v',
        TOOLS_VOLUME_MOUNT,
        HASHED_SANDBOX_DOCKER_IMAGE,
        '/usr/local/bin/hermes-tool-install',
        'all',
      ],
      {
        stdio: ['inherit', 'inherit', 'inherit'],
      },
    );

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error('\nError: Tool installation failed');
      process.exit(1);
    }

    console.log('\nAll tools installed! Your environment is fully configured.');
  } catch (error) {
    log.error({ error }, 'Failed to install tools');
    console.error('\nError: Failed to install tools');
    process.exit(1);
  }
}

export const setupCommand = new Command('setup')
  .description('Pre-download optional tools for offline use')
  .option('--full', 'Download all optional tools')
  .action(setupAction);
