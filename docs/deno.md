# Deno Sandbox Integration

Reference for working with Deno Deploy sandboxes in Hermes. Covers the SDK, platform behavior, workarounds, and lessons learned.

## SDK: `@deno/sandbox` (v0.12.0)

We use the `@deno/sandbox` npm package. It provides:

- `Client` — management API (list/create/delete volumes, snapshots, sandboxes)
- `Sandbox` — individual sandbox lifecycle (create, connect, spawn, fs, exposeSsh, kill)

API endpoint: `https://console.deno.com/api/v2/...`
Sandbox WebSocket endpoint: `https://{region}.sandbox-api.deno.net/`

### Authentication

Two token formats:
- `ddp_*` — personal tokens (tied to a user)
- `ddo_*` — organization tokens (need org context, but API infers from token)

Tokens are stored in the OS keyring via `src/services/deno.ts`.

## Bun Compatibility (Patched Transport)

**The `@deno/sandbox` SDK does not work with Bun out of the box.** We maintain a `bun patch` at `patches/@deno%2Fsandbox@0.12.0.patch` that completely replaces the WebSocket transport layer.

### Problem

Bun's `ws` polyfill (its native WebSocket) has two critical issues:

1. **Does NOT forward custom HTTP headers** on the WebSocket upgrade request — the `Authorization` header never reaches Deno's API.
2. **Does NOT emit data events on `res.socket`** after a 101 HTTP upgrade response — so the two-phase "HTTP probe then WebSocket reconnect" approach also fails.

### Solution

The patch replaces `transport.js` with a raw TLS implementation:

1. Opens a `node:tls` connection directly to `{region}.sandbox-api.deno.net:443`
2. Manually constructs and sends the HTTP upgrade request with all headers (Authorization, Sec-WebSocket-Key, x-deno-sandbox-config)
3. Parses the 101 response, extracting `x-deno-sandbox-id` from headers
4. Speaks the WebSocket wire protocol (RFC 6455) directly over the TLS socket: text frames, binary frames, ping/pong, close frames, masking

### Patching Workflow

```bash
# Make changes to node_modules/@deno/sandbox/esm/transport.js
# Then commit the patch:

# IMPORTANT: Bun has a bug with symlinked .gitattributes
mv ~/.gitattributes ~/.gitattributes.bak
bun patch --commit @deno/sandbox
mv ~/.gitattributes.bak ~/.gitattributes
```

### Sandbox ID Resolution

Because the patched transport extracts `x-deno-sandbox-id` from the raw HTTP headers, `sandbox.id` is populated. However, as a safety fallback, `DenoApiClient.createSandbox()` also injects a unique `hermes.create-id` label and looks up the sandbox via the Console API if `sandbox.id` is null.

### Killing Sandboxes

`sandbox.kill()` is broken under Bun (relies on `sandbox.id` internally). We bypass the SDK with a direct HTTP DELETE:

```
DELETE https://{region}.sandbox-api.deno.net/api/v3/sandbox/{sandboxId}
Authorization: Bearer {token}
```

The region is extracted from the sandbox ID format: `sbx_ord_...` → `ord`.

## Volumes and Snapshots

This is the most important section. The volume/snapshot system has several non-obvious behaviors.

### Core Concepts

- **Volume**: A persistent disk (up to 10GiB). Can be attached to one sandbox at a time. Created empty, from a builtin image, or from a snapshot.
- **Snapshot**: An immutable, read-only capture of a volume's state. Created by snapshotting a detached volume.
- **Builtin images**: Pre-built base images like `builtin:debian-13` that can be used as the `from` parameter when creating volumes.

### Critical: Booting from Snapshots vs Volumes

**Never boot a sandbox directly from a snapshot slug.** When you pass `root: snapshotSlug` to `Sandbox.create()`, the API treats it as a snapshot-boot which uses a **read-only overlay**. Files installed into the snapshot (packages, binaries) are NOT visible to the running sandbox.

The correct approach is always:

1. Create a **volume** from the snapshot: `createVolume({ from: snapshotSlug })`
2. Boot the sandbox from the **volume**: `createSandbox({ root: volumeSlug })`

Volumes created from snapshots are copy-on-write: they inherit the snapshot's contents and only allocate storage for new writes.

### Slug Rules

- Lowercase alphanumeric characters and hyphens only
- Maximum 32 characters
- Volume and snapshot slugs share a namespace — a volume and snapshot cannot have the same slug

We use `nanoid` with a custom alphabet (`a-z0-9`) for random suffixes, with prefixes to identify resource type:

| Prefix | Resource |
|--------|----------|
| `hbb-` | Build volume (base image build) |
| `hs-` | Session root volume |
| `hr-` | Resume volume (created from snapshot) |
| `hsh-` | Ephemeral shell volume |
| `hsnap-` | Session resume snapshot |
| `hermes-base-{version}` | Base snapshot (deterministic, no nanoid) |

### Volume Lifecycle

1. **Create**: `client.volumes.create({ slug, region, capacity, from? })`
2. **Attach**: Happens implicitly when a sandbox boots with `root: volumeSlug`
3. **Detach**: Volume detaches when the sandbox is killed
4. **Snapshot**: `client.volumes.snapshot(volumeId, { slug })` — volume must be detached first
5. **Delete**: `client.volumes.delete(id)` — fails if snapshots reference this volume

### Snapshot Lifecycle

1. **Create**: By snapshotting a detached volume (see above)
2. **Use**: As `from` parameter when creating new volumes
3. **Delete**: `client.snapshots.delete(id)` — must delete all volumes that reference it first

### Dependency Order for Deletion

```
snapshots → volumes
(delete snapshots first, then volumes)
```

A volume cannot be deleted while snapshots reference it. A snapshot cannot be created while the source volume is attached to a running sandbox.

### Snapshotting Timing

After killing a sandbox, wait ~5 seconds before snapshotting its volume. The platform needs time to fully detach. Without the delay, `snapshotVolume` can return a 500 error.

### Build Volume Timing

Do NOT delete the build volume immediately after snapshotting. The snapshot job runs asynchronously — deleting the source volume kills the job (observed as `JOB_IS_DEAD` / 500). Leave the build volume intact; it can be cleaned up later.

## Running Commands in Sandboxes

### Use `sandbox.spawn()`, not `sandbox.sh`

The SDK's `sandbox.sh` tagged template literal has a **chaining bug**: each builder method (`sudo()`, `stdout()`, `stderr()`, `noThrow()`) calls `withNewState()` which creates a fresh clone that **only retains the single property being set**, losing all previous chain state.

```typescript
// BROKEN — loses sudo flag when stdout is set:
await sandbox.sh`apt-get install -y git`.sudo().stdout('piped');

// CORRECT — use spawn() directly:
await sandbox.spawn('bash', {
  args: ['-c', command],
  stdout: 'piped',
  stderr: 'piped',
});
```

### sudo Caveats

When running commands with `sudo`, wrap the ENTIRE command in `sudo bash -c '...'`. A bare `sudo cmd1 && cmd2` only elevates `cmd1`.

Be aware that `$(id -u)` inside a `sudo bash -c '...'` block resolves to root's uid (0), not the calling user's. If you need the non-root user's uid, run the `sudo` command from a non-sudo context:

```typescript
// WRONG — chown to root:root (no-op):
await run(sandbox, 'mkdir -p /work && chown $(id -u):$(id -g) /work', 'setup', { sudo: true });

// CORRECT — mkdir as root, chown as app user:
await run(sandbox, 'mkdir -p /work', 'mkdir', { sudo: true });
await run(sandbox, 'sudo chown $(id -u):$(id -g) /work', 'chown');
```

### Environment Variables

- `DEBIAN_FRONTEND=noninteractive` — required for `apt-get` in non-TTY sandbox environments
- `BASH_ENV=$HOME/.bashrc` — ensures PATH is set for non-login shell commands via `spawn()`

### Piping stdout/stderr

Always pipe stdout and stderr when running commands from the TUI. Otherwise, sandbox command output leaks into the hermes terminal UI:

```typescript
await sandbox.spawn('bash', {
  args: ['-c', command],
  stdout: 'piped',  // Don't inherit!
  stderr: 'piped',
});
```

## SSH and Interactive Sessions

### Exposing SSH

`sandbox.exposeSsh()` returns `{ hostname, username }`. The username is typically `app`.

### SSH Options

Always use these SSH flags to avoid host key prompts and noise:

```
-o StrictHostKeyChecking=no
-o UserKnownHostsFile=/dev/null
-o LogLevel=ERROR
-o SetEnv=TERM=xterm-256color
```

The `SetEnv=TERM=xterm-256color` ensures consistent terminal capabilities regardless of the local machine's TERM.

### tmux for Persistent Sessions

Interactive agent sessions run inside tmux so they survive SSH disconnects. Key configuration:

```bash
# Force UTF-8 mode (required for Unicode rendering in Deno sandboxes)
tmux -u new-session -A -s hermes '<command>'

# Reattach
tmux -u attach -t hermes
```

The `-u` flag is critical — without it, block/box-drawing characters render incorrectly because the sandbox environment doesn't have locale data configured.

tmux configuration (`~/.tmux.conf`):

```
bind -n C-\\ detach-client       # ctrl+\ detaches (matches Docker)
set -g status off                # hide tmux status bar
set -g default-terminal "xterm-256color"
set -ga terminal-overrides ",xterm-256color:Tc"   # true-color passthrough
```

## PATH Configuration

The Deno platform auto-generates `/etc/profile.d/app-env.sh` on each sandbox boot, which **resets PATH to system directories only**. User-installed binaries (claude, opencode, etc.) in `~/.local/bin` and `~/.opencode/bin` won't be found.

Fix: Create `/etc/profile.d/hermes-path.sh` which sorts alphabetically after `app-env.sh` (`h` > `a`):

```bash
export PATH="$HOME/.local/bin:$HOME/.opencode/bin:$PATH"
```

Also add the same line to `~/.bashrc` for non-login shells that use `BASH_ENV`.

## Default User

Deno sandboxes run as the `app` user with `$HOME=/home/app`. Do NOT create a separate `hermes` user. All credential files, tool installations, and config should target the `app` user's home directory.

`sudo` is available without a password.

## API Reliability

The Deno Deploy API has transient 500 errors. Design for resilience:

- **Token validation**: Distinguish 401/403 (bad token) from 500 (API down). On server errors, assume the stored token is valid and proceed.
- **Stop/remove**: Best-effort cleanup. Kill the sandbox, mark session as stopped, then attempt snapshot. Don't let snapshot failures prevent the stop from succeeding.
- **Remove**: Always delete from local session DB even if cloud cleanup fails. Cloud resources have TTLs.
- **Volume/snapshot deletion**: These API calls can be very slow (20+ seconds) and may time out. Fire-and-forget is sometimes the only practical approach.

## Resource Limits

Deno accounts have concurrency limits on running sandboxes. When `Sandbox.create()` fails with limit/concurrent/quota errors, check how many sessions are running and surface a helpful message.

## Console API

Some operations need the Console API directly (not the SDK):

- Checking if a snapshot is bootable: `GET /api/v2/snapshots?search={slug}` → check `is_bootable` field
- The SDK doesn't expose all snapshot metadata

Base URL: `https://console.deno.com`

## Regions

Available regions: `ord` (Chicago), `ams` (Amsterdam). Volumes, snapshots, and sandboxes are regional — they must all be in the same region. Default: `ord`.

## Key Files

| File | Purpose |
|------|---------|
| `src/services/sandbox/cloudProvider.ts` | Main cloud provider (create, stop, resume, remove, attach, shell) |
| `src/services/sandbox/cloudSnapshot.ts` | Base snapshot builder (installs tools, creates snapshot) |
| `src/services/sandbox/denoApi.ts` | SDK wrapper with workarounds (ID resolution, direct HTTP kill) |
| `src/services/deno.ts` | Token management (keyring, validation) |
| `src/services/sandbox/sessionDb.ts` | SQLite session metadata store |
| `patches/@deno%2Fsandbox@0.12.0.patch` | Raw TLS transport patch for Bun compatibility |
| `src/components/CloudSetup.tsx` | Cloud setup TUI component |
