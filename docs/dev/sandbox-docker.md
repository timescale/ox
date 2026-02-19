# Setting Up Docker in the Sandbox Environment

The sandbox environment (used by AI coding agents) runs inside a container that doesn't have Docker pre-installed. Docker requires several workarounds to function because the sandbox lacks cgroups, `/dev/shm`, and uses `iptables-nft` by default (which doesn't work in this kernel).

## Quick Setup

Run these commands in order:

```bash
# 1. Install Docker CE from Docker's official apt repository.
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources <<'EOF'
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: trixie
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt-get update
sudo apt-get install -y \
  docker-ce \
  docker-ce-cli \
  containerd.io \
  docker-buildx-plugin \
  docker-compose-plugin

# The systemd-sysv package will fail to install due to /usr/sbin/init being
# on a different filesystem. This leaves several packages unconfigured.
# Fix the broken state before continuing:
sudo dpkg --purge --force-depends libpam-systemd dbus-user-session docker-ce-rootless-extras
sudo dpkg --configure -a

# 2. Mount /dev/shm (needed for container runtime locking)
sudo mkdir -p /dev/shm
if ! mountpoint -q /dev/shm; then
  sudo mount -t tmpfs tmpfs /dev/shm
fi

# 3. Mount cgroup v1 controllers (needed by runc)
#    The sandbox's /sys/fs/cgroup is on sysfs (read-only), so we first
#    overlay it with a tmpfs to allow creating subdirectories.
if [ "$(findmnt -n -o FSTYPE /sys/fs/cgroup 2>/dev/null)" != "tmpfs" ]; then
  sudo mount -t tmpfs tmpfs /sys/fs/cgroup
fi
for subsys in memory cpu cpuacct cpuset devices freezer blkio pids; do
  sudo mkdir -p /sys/fs/cgroup/$subsys
  if ! mountpoint -q /sys/fs/cgroup/$subsys; then
    sudo mount -t cgroup -o $subsys cgroup /sys/fs/cgroup/$subsys
  fi
done

# 4. Switch to iptables-legacy (nft backend doesn't work in this kernel)
sudo update-alternatives --set iptables /usr/sbin/iptables-legacy
sudo update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy

# 5. Start the Docker daemon
#    DOCKER_INSECURE_NO_IPTABLES_RAW disables Direct Access Filtering, which
#    requires the iptables "raw" table — not available in this kernel.
DOCKER_INSECURE_NO_IPTABLES_RAW=1 sudo -E dockerd &>/tmp/dockerd.log &
sleep 5

# 6. Allow the current user to use Docker without sudo
sudo chmod 666 /var/run/docker.sock

# 7. Verify
docker run --rm alpine:latest echo "Docker is working!"
```

## What Each Step Does

### Direct Access Filtering workaround

Docker CE 28.0 introduced [Direct Access Filtering](https://docs.docker.com/engine/network/packet-filtering-firewalls/) which adds iptables rules to the `raw` table to prevent direct access to container IPs from outside the bridge network. The sandbox kernel does not support the `raw` iptable, so container creation fails with:

```
Unable to enable DIRECT ACCESS FILTERING - DROP rule:
iptables: can't initialize iptables table `raw': Table does not exist
```

Setting `DOCKER_INSECURE_NO_IPTABLES_RAW=1` disables this feature. This is safe in the sandbox since there is no external network access to containers anyway.

We use `docker-ce` from Docker's official repository rather than the Debian-packaged `docker.io`, which is older, lags behind on releases, and is listed by Docker as an [unofficial package to uninstall](https://docs.docker.com/engine/install/debian/#uninstall-old-versions).

### `/dev/shm`

The container runtime (runc) uses POSIX shared memory for lock management. The sandbox doesn't mount `/dev/shm` by default, so container creation fails with:

```
failed to get new shm lock manager: failed to create 2048 locks in /libpod_lock: no such file or directory
```

### cgroup v1 Controllers

The sandbox's `/sys/fs/cgroup` is backed by sysfs with no controllers available. Docker/runc needs cgroup v1 controllers (memory, cpu, pids, etc.) to manage container resources. We mount a tmpfs over `/sys/fs/cgroup` first (since sysfs is read-only and doesn't allow creating subdirectories), then mount individual cgroup v1 controllers. Without them:

```
no cgroup mount found in mountinfo
```

### iptables-legacy

The default `iptables-nft` backend requires kernel nftables support that isn't available in the sandbox. Docker uses iptables for container networking (NAT, bridge). Without switching to legacy:

```
iptables: Failed to initialize nft: Protocol not supported
```

### Fixing broken packages after install

The `systemd-sysv` package fails to install because it tries to overwrite `/usr/sbin/init` which is on a different filesystem in the sandbox. This leaves `libpam-systemd`, `dbus-user-session`, and `docker-ce-rootless-extras` in an unconfigured state, which blocks `apt` and prevents `iptables` alternatives from being registered. Purging these packages and running `dpkg --configure -a` resolves the issue. None of these packages are needed for Docker.

## Troubleshooting

**Docker daemon won't start:** Check `/tmp/dockerd.log` for errors.

**Permission denied on docker.sock:** Run `sudo chmod 666 /var/run/docker.sock` again, or prefix commands with `sudo`.

**Container networking issues:** Verify iptables is using the legacy backend with `iptables --version` (should show `legacy`, not `nf_tables`).

## Podman Alternative

Podman also works in this environment but requires `--cgroups=disabled` and `--network=none`, which limits its usefulness:

```bash
sudo apt-get install -y podman
sudo mkdir -p /dev/shm && sudo mount -t tmpfs tmpfs /dev/shm
sudo podman run --rm --cgroups=disabled --network=none alpine:latest echo "Hello"
```

Docker is the better option here since it supports full networking after the setup above.
