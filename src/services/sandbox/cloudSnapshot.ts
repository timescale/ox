// ============================================================================
// Cloud Snapshot Management - Base image for cloud sandboxes
// ============================================================================

import packageJson from '../../../package.json' with { type: 'json' };
import { log } from '../logger.ts';
import { DenoApiClient } from './denoApi.ts';

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
    const snapshots = await client.listSnapshots();
    const existing = snapshots.find((s) => s.slug === snapshotSlug);
    if (existing) {
      onProgress?.({ type: 'exists', snapshotSlug });
      return snapshotSlug;
    }
  } catch (err) {
    log.debug({ err }, 'Failed to list snapshots');
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

  let sandboxId: string | null = null;

  try {
    // 3. Boot sandbox with volume as writable root
    onProgress?.({
      type: 'booting-sandbox',
      message: 'Booting build sandbox',
    });

    const sandbox = await client.createSandbox({
      region,
      root: volume.slug,
      timeout: '30m',
      memory: '2GiB',
    });
    sandboxId = sandbox.id;

    // 4. Install system packages
    onProgress?.({
      type: 'installing',
      message: 'Installing system packages',
      detail: 'git, curl, ca-certificates, zip, unzip, tar, gzip, jq',
    });
    await client.execInSandbox(sandboxId, region, [
      'bash',
      '-c',
      'apt-get update && apt-get install -y git curl ca-certificates zip unzip tar gzip jq openssh-client',
    ]);

    // 5. Install GitHub CLI
    onProgress?.({
      type: 'installing',
      message: 'Installing GitHub CLI',
    });
    await client.execInSandbox(sandboxId, region, [
      'bash',
      '-c',
      [
        'curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg',
        'chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg',
        'echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null',
        'apt-get update && apt-get install -y gh',
      ].join(' && '),
    ]);

    // 6. Create hermes user
    onProgress?.({
      type: 'installing',
      message: 'Creating hermes user',
    });
    await client.execInSandbox(sandboxId, region, [
      'bash',
      '-c',
      [
        'groupadd -g 10000 hermes',
        'useradd -u 10000 -g hermes -m -s /bin/bash hermes',
        'mkdir -p /home/hermes/.local/bin /home/hermes/.local/share/opencode /home/hermes/.cache /home/hermes/.config/gh /home/hermes/.claude',
        'chown -R hermes:hermes /home/hermes',
        'mkdir -p /work && chown hermes:hermes /work',
      ].join(' && '),
    ]);

    // 7. Install Claude Code
    onProgress?.({
      type: 'installing',
      message: 'Installing Claude Code',
      detail: 'This may take a minute',
    });
    await client.execInSandbox(
      sandboxId,
      region,
      ['bash', '-c', 'curl -fsSL https://claude.ai/install.sh | bash'],
      { user: 'hermes' },
    );

    // 8. Install Tiger CLI
    onProgress?.({
      type: 'installing',
      message: 'Installing Tiger CLI',
    });
    await client.execInSandbox(
      sandboxId,
      region,
      ['bash', '-c', 'curl -fsSL https://cli.tigerdata.com | sh'],
      { user: 'hermes' },
    );

    // 9. Install OpenCode
    onProgress?.({
      type: 'installing',
      message: 'Installing OpenCode',
    });
    await client.execInSandbox(
      sandboxId,
      region,
      [
        'bash',
        '-c',
        'curl -fsSL https://opencode.ai/install | bash && mkdir -p /home/hermes/.opencode/bin && ln -sf /home/hermes/.local/bin/opencode /home/hermes/.opencode/bin/opencode',
      ],
      { user: 'hermes' },
    );

    // 10. Configure git
    onProgress?.({
      type: 'installing',
      message: 'Configuring git',
    });
    await client.execInSandbox(
      sandboxId,
      region,
      [
        'bash',
        '-c',
        'git config --global user.email "hermes@tigerdata.com" && git config --global user.name "Hermes Agent"',
      ],
      { user: 'hermes' },
    );

    // 11. Snapshot the volume
    onProgress?.({
      type: 'snapshotting',
      message: 'Creating snapshot (this may take a moment)',
    });
    await client.snapshotVolume(volume.id, snapshotSlug);

    onProgress?.({ type: 'done', snapshotSlug });
    return snapshotSlug;
  } finally {
    // 12. Cleanup: kill sandbox and delete build volume
    onProgress?.({
      type: 'cleaning-up',
      message: 'Cleaning up build resources',
    });
    try {
      if (sandboxId) await client.killSandbox(sandboxId);
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
