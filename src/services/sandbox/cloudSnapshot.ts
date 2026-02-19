// ============================================================================
// Cloud Snapshot Management - Base image for cloud sandboxes
// ============================================================================

import packageJson from '../../../package.json' with { type: 'json' };
import { log } from '../logger.ts';
import { DenoApiClient, denoSlug, type ResolvedSandbox } from './denoApi.ts';
import { sandboxExec } from './sandboxExec.ts';

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
  // The base snapshot slug is deterministic (no nanoid) so we can find
  // an existing snapshot across runs. Sanitize version for slug rules.
  const safeVersion = packageJson.version.replace(/[^a-z0-9-]/g, '-');
  return `hermes-base-${safeVersion}`.slice(0, 32);
}

/**
 * Check if a snapshot is bootable via the Console API.
 * Returns true only if the snapshot exists AND is bootable.
 */
async function isSnapshotBootable(
  token: string,
  snapshotSlug: string,
): Promise<boolean> {
  try {
    const resp = await fetch(
      `https://console.deno.com/api/v2/snapshots?search=${encodeURIComponent(snapshotSlug)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!resp.ok) return false;
    const items = (await resp.json()) as Array<{
      slug: string;
      is_bootable: boolean;
    }>;
    const match = items.find((s) => s.slug === snapshotSlug);
    return match?.is_bootable === true;
  } catch {
    return false;
  }
}

/**
 * Ensure the base cloud snapshot exists for the current hermes version.
 * Creates it if it doesn't exist by:
 * 1. Creating a bootable volume from `builtin:debian-13`
 * 2. Booting a sandbox directly from that volume
 * 3. Installing all required tools
 * 4. Killing the sandbox to detach the volume
 * 5. Snapshotting the volume
 *
 * The volume MUST be created from a bootable base image. An empty
 * volume (even with files rsync'd into it) is NOT bootable.
 */
export async function ensureCloudSnapshot(options: {
  token: string;
  region: string;
  onProgress?: (progress: SnapshotBuildProgress) => void;
}): Promise<string> {
  const { token, region, onProgress } = options;
  const client = new DenoApiClient(token);
  const snapshotSlug = getBaseSnapshotSlug();

  // 1. Check if snapshot already exists AND is bootable
  onProgress?.({ type: 'checking' });
  try {
    const existing = await client.getSnapshot(snapshotSlug);
    if (existing) {
      // Verify it's actually bootable
      const bootable = await isSnapshotBootable(token, snapshotSlug);
      if (bootable) {
        onProgress?.({ type: 'exists', snapshotSlug });
        return snapshotSlug;
      }
      // Snapshot exists but is not bootable — delete and rebuild
      log.warn(
        { snapshotSlug },
        'Snapshot exists but is not bootable — deleting and rebuilding',
      );
      try {
        await client.deleteSnapshot(existing.id);
      } catch (err) {
        log.debug({ err }, 'Failed to delete non-bootable snapshot');
      }
    }
  } catch (err) {
    log.debug({ err }, 'Failed to check snapshot');
  }

  // 2. Create a bootable volume from the Debian base image
  const buildVolumeSlug = denoSlug('hbb');
  onProgress?.({
    type: 'creating-volume',
    message: 'Creating bootable build volume',
  });

  const volume = await client.createVolume({
    slug: buildVolumeSlug,
    region,
    capacity: '10GiB',
    from: 'builtin:debian-13',
  });

  let sandbox: ResolvedSandbox | null = null;
  let snapshotCreated = false;
  let buildSandboxId: string | undefined;

  try {
    // 3. Boot sandbox directly from the volume (it's bootable!)
    onProgress?.({
      type: 'booting-sandbox',
      message: 'Booting build sandbox from volume',
    });

    try {
      sandbox = await client.createSandbox({
        region: region as 'ord' | 'ams',
        root: volume.slug,
        timeout: '30m',
        memory: '2GiB',
      });
    } catch (err) {
      log.error({ err, region }, 'Failed to create build sandbox');
      throw err;
    }
    buildSandboxId = sandbox.resolvedId || sandbox.id;
    log.debug({ sandboxId: buildSandboxId }, 'Build sandbox created');

    // 4. Verify environment
    onProgress?.({
      type: 'installing',
      message: 'Verifying sandbox environment',
    });
    await sandboxExec(
      sandbox,
      'echo "user=$(whoami) home=$HOME sudo=$(which sudo 2>/dev/null || echo not-found)" && sudo whoami',
      { label: 'Verify environment' },
    );

    // 5. Install system packages (root)
    onProgress?.({
      type: 'installing',
      message: 'Installing system packages',
      detail: 'git, curl, ca-certificates, zip, unzip, tar, gzip, jq, tmux',
    });
    await sandboxExec(
      sandbox,
      'DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y git curl ca-certificates zip unzip tar gzip jq openssh-client tmux',
      { label: 'Install system packages', sudo: true },
    );

    // 6. Install GitHub CLI (root)
    onProgress?.({
      type: 'installing',
      message: 'Installing GitHub CLI',
    });
    await sandboxExec(
      sandbox,
      'curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y gh',
      { label: 'Install GitHub CLI', sudo: true },
    );

    // 7. Install Claude Code (default user)
    onProgress?.({
      type: 'installing',
      message: 'Installing Claude Code',
      detail: 'This may take a minute',
    });
    await sandboxExec(
      sandbox,
      'curl -fsSL https://claude.ai/install.sh | bash',
      { label: 'Install Claude Code' },
    );

    // 8. Install Tiger CLI (default user)
    onProgress?.({
      type: 'installing',
      message: 'Installing Tiger CLI',
    });
    await sandboxExec(sandbox, 'curl -fsSL https://cli.tigerdata.com | sh', {
      label: 'Install Tiger CLI',
    });

    // 9. Install OpenCode (default user, using ~ for home)
    onProgress?.({
      type: 'installing',
      message: 'Installing OpenCode',
    });
    await sandboxExec(
      sandbox,
      'curl -fsSL https://opencode.ai/install | bash',
      { label: 'Install OpenCode' },
    );

    // 10. Configure git and PATH (default user)
    onProgress?.({
      type: 'installing',
      message: 'Configuring environment',
    });
    await sandboxExec(
      sandbox,
      'git config --global user.email "hermes@tigerdata.com" && git config --global user.name "Hermes Agent"',
      { label: 'Configure git' },
    );
    // Ensure ~/.local/bin and ~/.opencode/bin are in PATH for all shell types.
    // SSH login shells source /etc/profile.d/*.sh (alphabetically).  The Deno
    // platform generates app-env.sh which resets PATH to system dirs.  Our
    // hermes-path.sh (h > a) runs after and appends user bin dirs.
    await sandboxExec(
      sandbox,
      'echo \'export PATH="$HOME/.local/bin:$HOME/.opencode/bin:$PATH"\' | sudo tee /etc/profile.d/hermes-path.sh > /dev/null && sudo chmod +x /etc/profile.d/hermes-path.sh',
      { label: 'Configure PATH in profile.d' },
    );
    // Also add to .bashrc for non-login shells that use BASH_ENV
    await sandboxExec(
      sandbox,
      'echo \'export PATH="$HOME/.local/bin:$HOME/.opencode/bin:$PATH"\' >> ~/.bashrc',
      { label: 'Configure PATH in bashrc' },
    );

    // 11. Configure tmux for detach/reattach workflow
    // ctrl+\ immediately detaches (matches Docker's --detach-keys=ctrl-\\)
    await sandboxExec(
      sandbox,
      `cat > ~/.tmux.conf << 'TMUX_EOF'
# Detach with ctrl+\\ (no prefix needed) — matches Docker detach keys.
# -E avoids printing "[detached (from session ...)]" to the host terminal
# when disconnecting from tmux over SSH.
bind -n C-\\\\ detach-client -E true
# Keep default prefix (ctrl+b) for other tmux commands
set -g mouse on
# Hide status bar — hermes manages the session, no need for tmux chrome
set -g status off
# True-color support — xterm-256color + Tc flag enables 24-bit RGB
# passthrough so TUI apps (OpenCode, Claude) render correctly
set -g default-terminal "xterm-256color"
set -ga terminal-overrides ",xterm-256color:Tc"
TMUX_EOF`,
      { label: 'Configure tmux' },
    );

    // 12. Create /work directory for session data, owned by the default user.
    //     Two steps: mkdir as root, then chown as the app user (so $(id -u)
    //     resolves to the correct non-root uid).
    await sandboxExec(sandbox, 'mkdir -p /work', {
      label: 'Create /work directory',
      sudo: true,
    });
    await sandboxExec(sandbox, 'sudo chown $(id -u):$(id -g) /work', {
      label: 'Chown /work to app user',
    });

    // 13. Kill sandbox to detach the volume (required before snapshotting)
    onProgress?.({
      type: 'snapshotting',
      message: 'Detaching volume',
    });
    log.debug({ sandboxId: buildSandboxId }, 'Stopping build sandbox');
    try {
      await sandbox.close();
    } catch {
      // ignore close errors
    }
    if (buildSandboxId) {
      try {
        await client.killSandbox(buildSandboxId);
      } catch (err) {
        log.warn(
          { err, sandboxId: buildSandboxId },
          'Failed to kill build sandbox — it may need manual cleanup',
        );
      }
    } else {
      log.warn(
        'No sandbox ID available — cannot kill build sandbox. It may need manual cleanup.',
      );
    }
    sandbox = null; // Prevent double-kill in finally

    // Wait for the platform to fully detach the volume from the dead sandbox.
    // Without this delay, snapshotVolume can hit a 500 error.
    await new Promise((resolve) => setTimeout(resolve, 5_000));

    // 13. Snapshot the volume
    onProgress?.({
      type: 'snapshotting',
      message: 'Creating snapshot (this may take a moment)',
    });
    try {
      await client.snapshotVolume(volume.id, { slug: snapshotSlug });
    } catch (err) {
      log.error(
        { err, volumeId: volume.id, snapshotSlug },
        'Failed to snapshot build volume',
      );
      throw err;
    }
    snapshotCreated = true;

    onProgress?.({ type: 'done', snapshotSlug });
    return snapshotSlug;
  } finally {
    // Only emit cleaning-up progress if we actually need to clean up
    // (i.e., the snapshot wasn't successfully created). On the success path,
    // 'done' has already been emitted — showing 'cleaning-up' after would
    // cause the UI to briefly flash "Cleaning up" after completion.
    const needsCleanup = !snapshotCreated || sandbox !== null;
    if (needsCleanup) {
      onProgress?.({
        type: 'cleaning-up',
        message: 'Cleaning up build resources',
      });
    }
    if (sandbox) {
      try {
        await sandbox.close();
      } catch {
        // ignore close errors
      }
      if (buildSandboxId) {
        try {
          await client.killSandbox(buildSandboxId);
        } catch (err) {
          log.debug({ err }, 'Failed to kill build sandbox in cleanup');
        }
      }
    }
    // Only delete the build volume if the snapshot was NOT created.
    // Deleting the volume while the platform is still processing the
    // snapshot kills the snapshot job (observed as JOB_IS_DEAD / 500).
    // On success, leave the volume — it can be cleaned up manually or
    // via `hermes sessions clean`.
    if (!snapshotCreated) {
      try {
        await client.deleteVolume(volume.id);
      } catch (err) {
        log.debug({ err }, 'Failed to delete build volume');
      }
    } else {
      log.debug(
        { volumeId: volume.id, slug: volume.slug },
        'Leaving build volume intact to avoid disrupting snapshot finalization',
      );
    }
  }
}
