# Setting Up Docker in the Sandbox Environment

The sandbox environment (used by AI coding agents) runs inside a container that doesn't have Docker pre-installed. Docker requires several workarounds to function because the sandbox lacks cgroups, `/dev/shm`, and uses `iptables-nft` by default (which doesn't work in this kernel).

## Quick Setup

Run these commands in order:

```bash
# 1. Install Docker CE from Docker's official apt repository.
#    We pin to 28.x because 29+ requires the iptables "raw" table for its
#    Direct Access Filtering feature, which is not available in this kernel.
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
DOCKER_VERSION="5:28.5.2-1~debian.13~trixie"
sudo apt-get install -y \
  docker-ce=$DOCKER_VERSION \
  docker-ce-cli=$DOCKER_VERSION \
  containerd.io \
  docker-buildx-plugin \
  docker-compose-plugin

# The systemd-sysv package will fail to install due to /usr/sbin/init being
# on a different filesystem. This is harmless — Docker itself installs fine.

# 2. Mount /dev/shm (needed for container runtime locking)
sudo mkdir -p /dev/shm
sudo mount -t tmpfs tmpfs /dev/shm

# 3. Mount cgroup v1 controllers (needed by runc)
for subsys in memory cpu cpuacct cpuset devices freezer blkio pids; do
  sudo mkdir -p /sys/fs/cgroup/$subsys
  sudo mount -t cgroup -o $subsys cgroup /sys/fs/cgroup/$subsys
done

# 4. Switch to iptables-legacy (nft backend doesn't work in this kernel)
sudo update-alternatives --set iptables /usr/sbin/iptables-legacy
sudo update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy

# 5. Start the Docker daemon
sudo dockerd &>/tmp/dockerd.log &
sleep 5

# 6. Allow the current user to use Docker without sudo
sudo chmod 666 /var/run/docker.sock

# 7. Verify
docker run --rm alpine:latest echo "Docker is working!"
```

## What Each Step Does

### Docker CE 28.x (not 29+)

Docker CE 29.0 introduced [Direct Access Filtering](https://docs.docker.com/engine/network/packet-filtering-firewalls/) which adds iptables rules to the `raw` table to prevent direct access to container IPs from outside the bridge network. The sandbox kernel does not support the `raw` iptable, so Docker 29+ fails when creating containers with bridge networking:

```
Unable to enable DIRECT ACCESS FILTERING - DROP rule:
iptables: can't initialize iptables table `raw': Table does not exist
```

Docker CE 28.x does not use the `raw` table and works without issues.

We also use `docker-ce` from Docker's official repository rather than the Debian-packaged `docker.io`, which is older, lags behind on releases, and is listed by Docker as an [unofficial package to uninstall](https://docs.docker.com/engine/install/debian/#uninstall-old-versions).

### `/dev/shm`

The container runtime (runc) uses POSIX shared memory for lock management. The sandbox doesn't mount `/dev/shm` by default, so container creation fails with:

```
failed to get new shm lock manager: failed to create 2048 locks in /libpod_lock: no such file or directory
```

### cgroup v1 Controllers

The sandbox has a cgroup2 filesystem mounted at `/sys/fs/cgroup` but with very few controllers delegated (only `hugetlb`). Docker/runc needs cgroup v1 controllers (memory, cpu, pids, etc.) to manage container resources. Without them:

```
no cgroup mount found in mountinfo
```

### iptables-legacy

The default `iptables-nft` backend requires kernel nftables support that isn't available in the sandbox. Docker uses iptables for container networking (NAT, bridge). Without switching to legacy:

```
iptables: Failed to initialize nft: Protocol not supported
```

## Troubleshooting

**Docker daemon won't start:** Check `/tmp/dockerd.log` for errors.

**Permission denied on docker.sock:** Run `sudo chmod 666 /var/run/docker.sock` again, or prefix commands with `sudo`.

**Container networking issues:** Verify iptables is using the legacy backend with `iptables --version` (should show `legacy`, not `nf_tables`).

**`systemd-sysv` install error:** This is expected. The package tries to overwrite `/usr/sbin/init` which is on a different filesystem in the sandbox. It doesn't affect Docker functionality.

**`apt` reports broken packages:** The `systemd-sysv` failure can leave `libpam-systemd` and `dbus-user-session` in an unconfigured state. If this blocks further `apt` operations, force-remove them:

```bash
sudo dpkg --purge --force-depends libpam-systemd dbus-user-session
```

These packages are not needed for Docker.

## Podman Alternative

Podman also works in this environment but requires `--cgroups=disabled` and `--network=none`, which limits its usefulness:

```bash
sudo apt-get install -y podman
sudo mkdir -p /dev/shm && sudo mount -t tmpfs tmpfs /dev/shm
sudo podman run --rm --cgroups=disabled --network=none alpine:latest echo "Hello"
```

Docker is the better option here since it supports full networking after the setup above.
