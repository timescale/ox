// ============================================================================
// Cloud Snapshot Management - Base + agent overlay snapshots for cloud sandboxes
// ============================================================================

import packageJson from '../../../package.json' with { type: 'json' };
import type { AgentType } from '../config.ts';
import { getAgentInstallScript, getAgentVersion } from '../docker.ts';
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

export function baseToolsHash(): string {
  const hasher = new Bun.CryptoHasher('md5');
  // Base hash includes only the base environment version marker.
  // Agent versions are encoded in the agent overlay snapshot slug.
  hasher.update(`base-v3-${packageJson.version}`);
  return hasher.digest('hex').slice(0, 6);
}

/** @deprecated Use baseToolsHash + getAgentSnapshotSlug for per-agent snapshots */
export function toolVersionsHash(): string {
  return baseToolsHash();
}

export function getBaseSnapshotSlug(): string {
  // The base snapshot slug is deterministic (no nanoid) so we can find
  // an existing snapshot across runs. Includes ox version + a hash
  // so that updating the base triggers a rebuild.
  const safeVersion = packageJson.version.replace(/[^a-z0-9-]/g, '-');
  const tvHash = baseToolsHash();
  return `ox-base-${safeVersion}-${tvHash}`.slice(0, 32).replace(/-+$/, '');
}

/**
 * Get the deterministic snapshot slug for an agent overlay.
 * Encodes the base version, agent name, and agent version.
 * Constrained to 32 characters (Deno slug limit).
 */
export function getAgentSnapshotSlug(agent: AgentType): string {
  const safeVersion = packageJson.version.replace(/[^a-z0-9-]/g, '-');
  const agentVer = getAgentVersion(agent)
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 6);
  // e.g. "ox-0-17-0-codex-0-111-0" — fit within 32 chars
  // Strip trailing hyphens — Deno API rejects slugs ending with '-'
  return `ox-${safeVersion}-${agent}-${agentVer}`
    .slice(0, 32)
    .replace(/-+$/, '');
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
 * Ensure the base cloud snapshot exists for the current ox version.
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
  const buildVolumeSlug = denoSlug('oxb');
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

    // 7. Configure git and PATH (default user)
    // NOTE: Agent installation (Claude, OpenCode, Codex, Tiger) is now done
    // in the agent overlay snapshot (ensureAgentCloudSnapshot), not the base.
    onProgress?.({
      type: 'installing',
      message: 'Configuring environment',
    });
    await sandboxExec(
      sandbox,
      'git config --global user.email "ox@tigerdata.com" && git config --global user.name "Ox Agent"',
      { label: 'Configure git' },
    );
    // Ensure ~/.local/bin is in PATH for all shell types.
    // SSH login shells source /etc/profile.d/*.sh (alphabetically).  The Deno
    // platform generates app-env.sh which resets PATH to system dirs.  Our
    // ox-path.sh (h > a) runs after and appends user bin dirs.
    // Agent-specific paths (e.g. ~/.opencode/bin) are added in the agent
    // overlay snapshot. DISABLE_AUTOUPDATER prevents Claude Code from
    // self-updating past the pinned version at runtime.
    await sandboxExec(
      sandbox,
      `printf 'export PATH="$HOME/.local/bin:$PATH"\\nexport DISABLE_AUTOUPDATER=1\\n' | sudo tee /etc/profile.d/ox-path.sh > /dev/null && sudo chmod +x /etc/profile.d/ox-path.sh`,
      { label: 'Configure PATH and env in profile.d' },
    );
    // Also add to .bashrc for non-login shells that use BASH_ENV
    await sandboxExec(
      sandbox,
      `printf 'export PATH="$HOME/.local/bin:$PATH"\\nexport DISABLE_AUTOUPDATER=1\\n' >> ~/.bashrc`,
      { label: 'Configure PATH and env in bashrc' },
    );

    // 8. Configure tmux for detach/reattach workflow
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
# Hide status bar — ox manages the session, no need for tmux chrome
set -g status off
# True-color support — xterm-256color + Tc flag enables 24-bit RGB
# passthrough so TUI apps (OpenCode, Claude) render correctly
set -g default-terminal "xterm-256color"
set -ga terminal-overrides ",xterm-256color:Tc"
TMUX_EOF`,
      { label: 'Configure tmux' },
    );

    // 9. Create /work directory for session data, owned by the default user.
    //     Two steps: mkdir as root, then chown as the app user (so $(id -u)
    //     resolves to the correct non-root uid).
    await sandboxExec(sandbox, 'mkdir -p /work', {
      label: 'Create /work directory',
      sudo: true,
    });
    await sandboxExec(sandbox, 'sudo chown $(id -u):$(id -g) /work', {
      label: 'Chown /work to app user',
    });

    // -----------------------------------------------------------------------
    // Docker-in-sandbox setup
    // -----------------------------------------------------------------------
    // The sandbox (Debian 13 / trixie) lacks Docker, cgroups, /dev/shm,
    // and uses iptables-nft which doesn't work in this kernel.
    // See docs/dev/sandbox-docker.md for full details.

    // 10a. Add Docker's official apt repository (Debian trixie).
    onProgress?.({
      type: 'installing',
      message: 'Installing Docker',
      detail: 'docker-ce, containerd.io, docker-compose-plugin',
    });
    await sandboxExec(
      sandbox,
      `install -m 0755 -d /etc/apt/keyrings \
&& curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
&& chmod a+r /etc/apt/keyrings/docker.asc \
&& cat > /etc/apt/sources.list.d/docker.sources <<'DKRREPO'
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: trixie
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
DKRREPO
`,
      { label: 'Add Docker apt repository', sudo: true },
    );

    // 10b. Install Docker CE packages.  The install triggers a known
    //      systemd-sysv failure (exit code 1) because /usr/sbin/init is
    //      on a different filesystem in the sandbox.  We allow the
    //      non-zero exit and fix the broken state in the next step.
    await sandboxExec(
      sandbox,
      `DEBIAN_FRONTEND=noninteractive apt-get update \
&& (DEBIAN_FRONTEND=noninteractive apt-get install -y \
  docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin || true)`,
      { label: 'Install Docker CE packages', sudo: true },
    );

    // 10c. Fix broken package state left by the systemd-sysv failure.
    //      Purge packages that failed to configure (none are needed for
    //      Docker) and finish configuring the rest.
    await sandboxExec(
      sandbox,
      'dpkg --purge --force-depends libpam-systemd dbus-user-session docker-ce-rootless-extras 2>/dev/null; dpkg --configure -a',
      { label: 'Fix broken packages after Docker install', sudo: true },
    );

    // 10d. Switch to iptables-legacy (nft backend requires kernel nftables
    //      support that isn't available in this sandbox).
    await sandboxExec(
      sandbox,
      'update-alternatives --set iptables /usr/sbin/iptables-legacy && update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy',
      { label: 'Switch to iptables-legacy', sudo: true },
    );

    // 10e. Write a startup script that handles ephemeral setup (mounts and
    //      daemon) that doesn't survive snapshot+restore.  This script is
    //      idempotent and can be called multiple times safely.
    await sandboxExec(
      sandbox,
      `cat > /usr/local/bin/start-docker.sh << 'STARTDKR'
#!/usr/bin/env bash
# Idempotent Docker daemon startup for the Deno sandbox environment.
# Handles /dev/shm, cgroup v1 controllers, and dockerd.
# See docs/dev/sandbox-docker.md for rationale.
set -euo pipefail

# Already running? Nothing to do.
if docker info &>/dev/null 2>&1; then
  exit 0
fi

# 1. Mount /dev/shm (needed for container runtime locking)
sudo mkdir -p /dev/shm
if ! mountpoint -q /dev/shm; then
  sudo mount -t tmpfs tmpfs /dev/shm
fi

# 2. Mount cgroup v1 controllers (needed by runc)
if [ "$(findmnt -n -o FSTYPE /sys/fs/cgroup 2>/dev/null)" != "tmpfs" ]; then
  sudo mount -t tmpfs tmpfs /sys/fs/cgroup
fi
for subsys in memory cpu cpuacct cpuset devices freezer blkio pids; do
  sudo mkdir -p /sys/fs/cgroup/$subsys
  if ! mountpoint -q /sys/fs/cgroup/$subsys; then
    sudo mount -t cgroup -o $subsys cgroup /sys/fs/cgroup/$subsys
  fi
done

# 3. Start Docker daemon
#    DOCKER_INSECURE_NO_IPTABLES_RAW disables Direct Access Filtering
#    which requires the iptables "raw" table — not available in this kernel.
DOCKER_INSECURE_NO_IPTABLES_RAW=1 sudo -E dockerd &>/tmp/dockerd.log &

# 4. Wait for the socket to appear, then open it up for non-root usage
#    before checking 'docker info' (which needs socket access).
timeout 30 bash -c 'until [ -S /var/run/docker.sock ]; do sleep 0.5; done'
sudo chmod 666 /var/run/docker.sock

# 5. Wait for daemon to be fully ready (up to 30s)
timeout 30 bash -c 'until docker info &>/dev/null 2>&1; do sleep 1; done'
STARTDKR
chmod +x /usr/local/bin/start-docker.sh`,
      { label: 'Write Docker startup script', sudo: true },
    );

    // 10f. Add a profile.d hook so Docker starts automatically on login.
    //      Uses a lockfile to avoid parallel startups from multiple shells.
    await sandboxExec(
      sandbox,
      `cat > /etc/profile.d/docker-start.sh << 'PROFILED'
# Auto-start Docker daemon on first login shell.
# The startup script is idempotent but we use a lockfile to avoid
# multiple concurrent shells all trying to start dockerd at once.
if ! docker info &>/dev/null 2>&1; then
  (
    flock -n 9 || exit 0
    /usr/local/bin/start-docker.sh &>/dev/null
  ) 9>/tmp/.docker-start.lock
fi
PROFILED
chmod +x /etc/profile.d/docker-start.sh`,
      { label: 'Add Docker auto-start hook', sudo: true },
    );

    // 10g. Run the startup script now to verify Docker works and cache
    //      the alpine image in the snapshot.  Best-effort: if the pull
    //      times out (sandbox networking can be slow), we still proceed
    //      with the snapshot — Docker will pull on first use at runtime.
    onProgress?.({
      type: 'installing',
      message: 'Starting Docker and caching base image',
    });
    await sandboxExec(sandbox, '/usr/local/bin/start-docker.sh', {
      label: 'Start Docker in build sandbox',
    });
    try {
      await sandboxExec(sandbox, 'docker pull alpine:latest', {
        label: 'Cache alpine image',
      });
    } catch (err) {
      log.warn(
        { err },
        'Failed to cache alpine image — Docker will pull at runtime',
      );
    }

    // 11. Kill sandbox and wait for volume detachment (required before snapshotting)
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
      await client.killAndWaitForDetach(buildSandboxId);
    } else {
      log.warn(
        'No sandbox ID available — cannot kill build sandbox. It may need manual cleanup.',
      );
    }
    sandbox = null; // Prevent double-kill in finally

    // 12. Snapshot the volume (retries on VOLUME_IS_MOUNTED — the platform
    //     may take time to fully release the volume after sandbox death)
    onProgress?.({
      type: 'snapshotting',
      message: 'Creating snapshot (this may take a moment)',
    });
    try {
      await client.snapshotVolumeWithRetry(volume.id, { slug: snapshotSlug });
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
    // via `ox sessions clean`.
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

/**
 * Ensure an agent-specific overlay cloud snapshot exists.
 *
 * Boots a sandbox from the base snapshot, installs the agent + tiger CLI,
 * kills the sandbox, and snapshots the resulting volume.
 *
 * Returns the agent overlay snapshot slug.
 */
export async function ensureAgentCloudSnapshot(options: {
  token: string;
  region: string;
  agent: AgentType;
  baseSnapshotSlug: string;
  onProgress?: (progress: SnapshotBuildProgress) => void;
}): Promise<string> {
  const { token, region, agent, baseSnapshotSlug, onProgress } = options;
  const client = new DenoApiClient(token);
  const snapshotSlug = getAgentSnapshotSlug(agent);

  // 1. Check if agent overlay snapshot already exists AND is bootable
  onProgress?.({ type: 'checking' });
  try {
    const existing = await client.getSnapshot(snapshotSlug);
    if (existing) {
      const bootable = await isSnapshotBootable(token, snapshotSlug);
      if (bootable) {
        onProgress?.({ type: 'exists', snapshotSlug });
        return snapshotSlug;
      }
      log.warn(
        { snapshotSlug },
        'Agent snapshot exists but is not bootable — deleting and rebuilding',
      );
      try {
        await client.deleteSnapshot(existing.id);
      } catch (err) {
        log.debug({ err }, 'Failed to delete non-bootable agent snapshot');
      }
    }
  } catch (err) {
    log.debug({ err }, 'Failed to check agent snapshot');
  }

  // 2. Create a bootable volume from the base snapshot
  const buildVolumeSlug = denoSlug('oxa');
  onProgress?.({
    type: 'creating-volume',
    message: `Creating volume for ${agent} agent`,
  });

  const volume = await client.createVolume({
    slug: buildVolumeSlug,
    region,
    capacity: '10GiB',
    from: baseSnapshotSlug,
  });

  let sandbox: ResolvedSandbox | null = null;
  let snapshotCreated = false;
  let buildSandboxId: string | undefined;

  try {
    // 3. Boot sandbox from the base volume
    onProgress?.({
      type: 'booting-sandbox',
      message: `Booting sandbox to install ${agent}`,
    });

    sandbox = await client.createSandbox({
      region: region as 'ord' | 'ams',
      root: volume.slug,
      timeout: '30m',
      memory: '2GiB',
    });
    buildSandboxId = sandbox.resolvedId || sandbox.id;
    log.debug(
      { sandboxId: buildSandboxId, agent },
      'Agent overlay build sandbox created',
    );

    // 4. Install the agent
    const agentVersion = getAgentVersion(agent);
    onProgress?.({
      type: 'installing',
      message: `Installing ${agent} v${agentVersion}`,
      detail: 'This may take a minute',
    });

    // Write the install script into a temp file and execute it
    const agentScript = getAgentInstallScript(agent);
    await sandboxExec(
      sandbox,
      `cat > /tmp/install-agent.sh << 'INSTALL_EOF'\n${agentScript}\nINSTALL_EOF\nbash /tmp/install-agent.sh ${agentVersion}`,
      { label: `Install ${agent}` },
    );

    // 5. Install Tiger CLI
    onProgress?.({
      type: 'installing',
      message: 'Installing Tiger CLI',
    });
    const tigerScript = getAgentInstallScript('tiger');
    await sandboxExec(
      sandbox,
      `cat > /tmp/install-tiger.sh << 'INSTALL_EOF'\n${tigerScript}\nINSTALL_EOF\nbash /tmp/install-tiger.sh`,
      { label: 'Install Tiger CLI' },
    );

    // 6. Add agent-specific bin dirs to PATH
    // The base already has ~/.local/bin. Agents like opencode install to
    // ~/.opencode/bin, codex installs to ~/.local/bin (already covered).
    if (agent === 'opencode') {
      await sandboxExec(
        sandbox,
        `printf 'export PATH="$HOME/.opencode/bin:$PATH"\\n' | sudo tee -a /etc/profile.d/ox-path.sh > /dev/null`,
        { label: 'Add opencode bin to PATH' },
      );
      await sandboxExec(
        sandbox,
        `printf 'export PATH="$HOME/.opencode/bin:$PATH"\\n' >> ~/.bashrc`,
        { label: 'Add opencode bin to bashrc' },
      );
    }

    // Clean up temp files
    await sandboxExec(
      sandbox,
      'rm -f /tmp/install-agent.sh /tmp/install-tiger.sh',
      {
        label: 'Clean up temp install scripts',
      },
    );

    // 7. Kill sandbox and wait for volume detachment
    onProgress?.({
      type: 'snapshotting',
      message: 'Detaching volume',
    });
    log.debug({ sandboxId: buildSandboxId }, 'Stopping agent build sandbox');
    try {
      await sandbox.close();
    } catch {
      // ignore close errors
    }
    if (buildSandboxId) {
      await client.killAndWaitForDetach(buildSandboxId);
    }
    sandbox = null;

    // 8. Snapshot the volume (retries on VOLUME_IS_MOUNTED)
    onProgress?.({
      type: 'snapshotting',
      message: `Creating ${agent} agent snapshot`,
    });
    try {
      await client.snapshotVolumeWithRetry(volume.id, { slug: snapshotSlug });
    } catch (err) {
      log.error(
        { err, volumeId: volume.id, snapshotSlug },
        'Failed to snapshot agent build volume',
      );
      throw err;
    }
    snapshotCreated = true;

    onProgress?.({ type: 'done', snapshotSlug });
    return snapshotSlug;
  } finally {
    const needsCleanup = !snapshotCreated || sandbox !== null;
    if (needsCleanup) {
      onProgress?.({
        type: 'cleaning-up',
        message: 'Cleaning up agent build resources',
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
          log.debug({ err }, 'Failed to kill agent build sandbox in cleanup');
        }
      }
    }
    if (!snapshotCreated) {
      try {
        await client.deleteVolume(volume.id);
      } catch (err) {
        log.debug({ err }, 'Failed to delete agent build volume');
      }
    } else {
      log.debug(
        { volumeId: volume.id, slug: volume.slug },
        'Leaving agent build volume intact to avoid disrupting snapshot finalization',
      );
    }
  }
}
