// ============================================================================
// Cloud Base Snapshot Build Steps
// ============================================================================
//
// This module extracts the imperative shell commands used to build the base
// cloud snapshot into a declarative, hashable array.  The content hash of
// these commands determines the base snapshot slug — so the snapshot is only
// rebuilt when the actual setup commands change, not on every ox release.
//
// See ensureCloudSnapshot() in cloudSnapshot.ts for execution logic.
// ============================================================================

/**
 * A single step in the cloud base snapshot build process.
 *
 * @property label  - Short identifier used in logs and exec wrappers.
 * @property message - Human-readable progress message shown in the UI.
 * @property detail  - Optional secondary detail shown in the UI.
 * @property command - The shell command string to execute.
 * @property sudo    - If true, the command is executed as root via sudo.
 */
export interface CloudBuildStep {
  label: string;
  message: string;
  detail?: string;
  command: string;
  sudo?: boolean;
}

/**
 * All base cloud snapshot build steps, in execution order.
 *
 * These are extracted verbatim from `ensureCloudSnapshot()` so they can be
 * hashed deterministically.  The hash is used in the snapshot slug to avoid
 * unnecessary rebuilds.
 *
 * NOTE: The best-effort `docker pull alpine:latest` step is intentionally
 * excluded — it's a cache optimization that should not affect the hash.
 */
export const CLOUD_BASE_STEPS: readonly CloudBuildStep[] = [
  {
    label: 'Verify environment',
    message: 'Verifying sandbox environment',
    command:
      'echo "user=$(whoami) home=$HOME sudo=$(which sudo 2>/dev/null || echo not-found)" && sudo whoami',
  },
  {
    label: 'Install system packages',
    message: 'Installing system packages',
    detail: 'git, curl, ca-certificates, zip, unzip, tar, gzip, jq, tmux',
    command:
      'DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y git curl ca-certificates zip unzip tar gzip jq openssh-client tmux',
    sudo: true,
  },
  {
    label: 'Install GitHub CLI',
    message: 'Installing GitHub CLI',
    command:
      'curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y gh',
    sudo: true,
  },
  {
    label: 'Configure git',
    message: 'Configuring environment',
    command:
      'git config --global user.email "ox@tigerdata.com" && git config --global user.name "Ox Agent"',
  },
  {
    label: 'Configure PATH and env in profile.d',
    message: 'Configuring environment',
    command: `printf 'export PATH="$HOME/.local/bin:$PATH"\\nexport DISABLE_AUTOUPDATER=1\\n' | sudo tee /etc/profile.d/ox-path.sh > /dev/null && sudo chmod +x /etc/profile.d/ox-path.sh`,
  },
  {
    label: 'Configure PATH and env in bashrc',
    message: 'Configuring environment',
    command: `printf 'export PATH="$HOME/.local/bin:$PATH"\\nexport DISABLE_AUTOUPDATER=1\\n' >> ~/.bashrc`,
  },
  {
    label: 'Configure tmux',
    message: 'Configuring environment',
    command: `cat > ~/.tmux.conf << 'TMUX_EOF'
# Detach with ctrl+\\\\ (no prefix needed) — matches Docker detach keys.
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
  },
  {
    label: 'Create /work directory',
    message: 'Configuring environment',
    command: 'mkdir -p /work',
    sudo: true,
  },
  {
    label: 'Chown /work to app user',
    message: 'Configuring environment',
    command: 'sudo chown $(id -u):$(id -g) /work',
  },
  {
    label: 'Add Docker apt repository',
    message: 'Installing Docker',
    detail: 'docker-ce, containerd.io, docker-compose-plugin',
    command: `install -m 0755 -d /etc/apt/keyrings \
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
    sudo: true,
  },
  {
    label: 'Install Docker CE packages',
    message: 'Installing Docker',
    detail: 'docker-ce, containerd.io, docker-compose-plugin',
    command: `DEBIAN_FRONTEND=noninteractive apt-get update \
&& (DEBIAN_FRONTEND=noninteractive apt-get install -y \
  docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin || true)`,
    sudo: true,
  },
  {
    label: 'Fix broken packages after Docker install',
    message: 'Installing Docker',
    command:
      'dpkg --purge --force-depends libpam-systemd dbus-user-session docker-ce-rootless-extras 2>/dev/null; dpkg --configure -a',
    sudo: true,
  },
  {
    label: 'Switch to iptables-legacy',
    message: 'Installing Docker',
    command:
      'update-alternatives --set iptables /usr/sbin/iptables-legacy && update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy',
    sudo: true,
  },
  {
    label: 'Write Docker startup script',
    message: 'Installing Docker',
    command: `cat > /usr/local/bin/start-docker.sh << 'STARTDKR'
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
    sudo: true,
  },
  {
    label: 'Add Docker auto-start hook',
    message: 'Installing Docker',
    command: `cat > /etc/profile.d/docker-start.sh << 'PROFILED'
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
    sudo: true,
  },
  {
    label: 'Start Docker in build sandbox',
    message: 'Starting Docker and caching base image',
    command: '/usr/local/bin/start-docker.sh',
  },
] as const;

/**
 * Compute a content hash of the base cloud snapshot build steps.
 *
 * The hash is derived from:
 * - **command**: The shell command string for each step.
 * - **sudo flag**: Whether the step runs as root (true vs false/undefined).
 *
 * The hash deliberately does NOT include:
 * - **label**: UI-only identifier for logging; changing it shouldn't trigger a rebuild.
 * - **message**: UI-only progress text; purely cosmetic.
 * - **detail**: UI-only secondary description; purely cosmetic.
 *
 * Note: `sudo: undefined` and `sudo: false` are treated identically — neither
 * appends the "sudo" marker to the hash.  This means adding an explicit
 * `sudo: false` to a step that previously omitted the field will NOT change
 * the hash.
 *
 * @returns A 12-character hex string (MD5 prefix).
 */
export function computeCloudBaseHash(): string {
  const hasher = new Bun.CryptoHasher('md5');
  for (const step of CLOUD_BASE_STEPS) {
    hasher.update(step.command);
    if (step.sudo) hasher.update('sudo');
  }
  return hasher.digest('hex').slice(0, 12);
}
