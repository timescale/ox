// ============================================================================
// Cloud Snapshot Management - Base image for cloud sandboxes
// ============================================================================

import type { Sandbox } from '@deno/sandbox';

import packageJson from '../../../package.json' with { type: 'json' };
import { log } from '../logger.ts';
import { DenoApiClient } from './denoApi.ts';

/**
 * Await a sandbox command. Uses `.noThrow()` to capture stderr for
 * logging, then throws if the command failed.
 */
async function run(
  cmd: {
    noThrow: () => PromiseLike<{
      status: { success: boolean; code: number };
      stderrText: string | null;
    }>;
  },
  step: string,
): Promise<void> {
  const result = await cmd.noThrow();
  if (!result.status.success) {
    const stderr = result.stderrText ?? '';
    log.error(
      { step, exitCode: result.status.code, stderr },
      'Snapshot build step failed',
    );
    throw new Error(
      `Snapshot build failed at "${step}" (exit ${result.status.code}): ${stderr.slice(0, 500)}`,
    );
  }
}

export type SnapshotBuildProgress =
  | { type: 'checking' }
  | { type: 'exists'; snapshotSlug: string }
  | { type: 'creating-volume'; message: string }
  | { type: 'booting-sandbox'; message: string }
  | { type: 'installing'; message: string; detail?: string }
  | { type: 'snapshotting'; message: string }
  | { type: 'cleaning-up'; message: string }
  | { type: 'done'; snapshotSlug: string }
  | { type: 'error'; message: string };

function getBaseSnapshotSlug(): string {
  return `hermes-base-${packageJson.version}`;
}

/**
 * Ensure the base cloud snapshot exists for the current hermes version.
 * Creates it if it doesn't exist by:
 * 1. Booting a sandbox from builtin:debian-13
 * 2. Installing all required tools
 * 3. Snapshotting the volume
 *
 * Uses the SDK's `sandbox.sh` tagged template for all commands.
 * Root commands use `.sudo()`. User-level commands (tool installs)
 * run as the default sandbox user so tools end up in `$HOME`.
 */
export async function ensureCloudSnapshot(options: {
  token: string;
  region: string;
  onProgress?: (progress: SnapshotBuildProgress) => void;
}): Promise<string> {
  const { token, region, onProgress } = options;
  const client = new DenoApiClient(token);
  const snapshotSlug = getBaseSnapshotSlug();

  // 1. Check if snapshot already exists
  onProgress?.({ type: 'checking' });
  try {
    const existing = await client.getSnapshot(snapshotSlug);
    if (existing) {
      onProgress?.({ type: 'exists', snapshotSlug });
      return snapshotSlug;
    }
  } catch (err) {
    log.debug({ err }, 'Failed to check snapshot');
  }

  // 2. Create a temporary bootable volume
  const buildVolumeSlug = `hermes-base-build-${Date.now()}`;
  onProgress?.({
    type: 'creating-volume',
    message: 'Creating build volume',
  });

  const volume = await client.createVolume({
    slug: buildVolumeSlug,
    region,
    capacity: '10GiB',
    from: 'builtin:debian-13',
  });

  let sandbox: Sandbox | null = null;

  try {
    // 3. Boot sandbox with volume as writable root
    onProgress?.({
      type: 'booting-sandbox',
      message: 'Booting build sandbox',
    });

    sandbox = await client.createSandbox({
      region: region as 'ord' | 'ams',
      root: volume.slug,
      timeout: '30m',
      memory: '2GiB',
    });

    // 4. Install system packages (root)
    onProgress?.({
      type: 'installing',
      message: 'Installing system packages',
      detail: 'git, curl, ca-certificates, zip, unzip, tar, gzip, jq',
    });
    await run(
      sandbox.sh`apt-get update && apt-get install -y git curl ca-certificates zip unzip tar gzip jq openssh-client`.sudo(),
      'Install system packages',
    );

    // 5. Install GitHub CLI (root)
    onProgress?.({
      type: 'installing',
      message: 'Installing GitHub CLI',
    });
    await run(
      sandbox.sh`curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && apt-get update && apt-get install -y gh`.sudo(),
      'Install GitHub CLI',
    );

    // 6. Install Claude Code (default user)
    onProgress?.({
      type: 'installing',
      message: 'Installing Claude Code',
      detail: 'This may take a minute',
    });
    await run(
      sandbox.sh`curl -fsSL https://claude.ai/install.sh | bash`,
      'Install Claude Code',
    );

    // 7. Install Tiger CLI (default user)
    onProgress?.({
      type: 'installing',
      message: 'Installing Tiger CLI',
    });
    await run(
      sandbox.sh`curl -fsSL https://cli.tigerdata.com | sh`,
      'Install Tiger CLI',
    );

    // 8. Install OpenCode (default user, using ~ for home)
    onProgress?.({
      type: 'installing',
      message: 'Installing OpenCode',
    });
    await run(
      sandbox.sh`curl -fsSL https://opencode.ai/install | bash && mkdir -p ~/.opencode/bin && ln -sf ~/.local/bin/opencode ~/.opencode/bin/opencode`,
      'Install OpenCode',
    );

    // 9. Configure git (default user)
    onProgress?.({
      type: 'installing',
      message: 'Configuring git',
    });
    await run(
      sandbox.sh`git config --global user.email "hermes@tigerdata.com" && git config --global user.name "Hermes Agent"`,
      'Configure git',
    );

    // 10. Snapshot the volume
    onProgress?.({
      type: 'snapshotting',
      message: 'Creating snapshot (this may take a moment)',
    });
    await client.snapshotVolume(volume.id, { slug: snapshotSlug });

    onProgress?.({ type: 'done', snapshotSlug });
    return snapshotSlug;
  } finally {
    // 11. Cleanup: kill sandbox and delete build volume
    onProgress?.({
      type: 'cleaning-up',
      message: 'Cleaning up build resources',
    });
    try {
      if (sandbox) await sandbox.kill();
    } catch (err) {
      log.debug({ err }, 'Failed to kill build sandbox');
    }
    try {
      await client.deleteVolume(volume.id);
    } catch (err) {
      log.debug({ err }, 'Failed to delete build volume');
    }
  }
}
