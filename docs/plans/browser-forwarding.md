# Browser Forwarding from Sandboxed Agents

## Problem

Agents running inside Ox sandboxes (Docker containers or Deno Deploy) sometimes
need to open URLs in the user's host browser. The two primary use cases are:

1. **`xdg-open` forwarding** -- Agent code calls `xdg-open <url>` (or
   equivalent) and the URL opens on the host machine's default browser.
2. **OAuth callback flows** -- An OAuth flow starts in the host browser, and the
   callback to `localhost:PORT` needs to route back into the sandbox where the
   agent's local server is listening.

Today, Ox has no mechanism for either. The sandbox has outbound internet access
but no inbound connectivity from the host, and no way to trigger host-side
actions like opening a browser.

## Research: How agent-creds Does It

[dtkav/agent-creds](https://github.com/dtkav/agent-creds) implements a
"Browser Forwarding" feature with the following architecture:

### Container Side

- A shell script (`open-browser`) is installed at `/usr/local/bin/open-browser`
  and the `BROWSER` env var is set to point to it.
- When code calls `xdg-open`, the `$BROWSER` variable is respected, so
  `open-browser` is invoked instead.
- `open-browser` sends the URL over a Unix domain socket
  (`/tmp/browser-forward.sock`) via curl:
  ```sh
  curl -sf -G --data-urlencode "url=$1" \
      --unix-socket /tmp/browser-forward.sock \
      "http://localhost/open"
  ```
- A Go binary (`tcp-bridge`) runs inside the container as an s6-supervised
  service. It creates the Unix socket and bridges it to a TCP port on the Docker
  network gateway IP. This extra hop is necessary because agent-creds uses gVisor
  (which can't share Unix sockets across namespaces).

### Host Side

- `adev` (the host orchestrator) runs an HTTP server
  (`startBrowserForwardTCP`) bound to the Docker network gateway IP on a
  deterministic port (hashed from the instance slug).
- On receiving a request, it:
  1. Validates the URL against a glob-based allow-list (`[[browser_target]]`
     config entries).
  2. Calls `xdg-open <url>` on the host to open the real browser.
  3. Parses the URL for `localhost:PORT` references (both the main URL and any
     `redirect_uri` query parameter). For each, it starts a temporary reverse
     TCP proxy (`proxyLocalPort`).

### OAuth Callback Reverse Proxy

- `proxyLocalPort` binds `127.0.0.1:PORT` on the host.
- It looks up the sandbox container's IP via `docker inspect` and forwards
  incoming connections to `container_ip:PORT`.
- The proxy auto-closes after 5 minutes.
- This completes the OAuth round-trip: sandbox initiates auth URL -> host
  browser opens -> user authenticates -> provider redirects to
  `localhost:PORT` -> host proxy catches it -> forwards to sandbox.

### Network Architecture

agent-creds creates a **dedicated Docker network per sandbox** (for its envoy
proxy / iptables sidecar setup). The browser-forward server binds to the
**gateway IP of that network**, which is the host's address on the bridge
interface. This provides natural isolation -- only containers on that network
can reach the server.

### Key Takeaway

The overall pattern is straightforward: intercept `xdg-open` inside the
container, send the URL to the host over a known channel, and handle OAuth
callbacks with a temporary reverse proxy. The complexity in agent-creds comes
from gVisor compatibility (requiring the tcp-bridge hop) and the multi-container
networking (envoy, sandbox-net, vault) that we don't need.

## Design for Ox

### Communication Channel: Unix Sockets via Directory Mount

Instead of TCP ports on the Docker network gateway (which would require us to
create per-sandbox Docker networks), we use **Unix domain sockets** with a
**directory bind-mount**.

For each session, the host creates a directory:
```
~/.ox/sessions/{session-id}/
```

This directory is bind-mounted into the container:
```
-v ~/.ox/sessions/{id}/:/tmp/ox/:rw
```

The `ox` process creates a Unix socket server at:
```
~/.ox/sessions/{session-id}/browser-forward.sock
```

Inside the container, the `open-browser` shim connects to:
```
/tmp/ox/browser-forward.sock
```

#### Why directory mount, not socket mount?

Mounting the socket file directly (`-v foo.sock:/tmp/ox/browser-forward.sock`)
bakes in the inode at container creation time. If the socket is recreated (e.g.,
after the owning `ox` process exits and a new one adopts the session), the
container still points at the old inode.

Mounting the **directory** means the container always sees whatever socket file
currently exists at that path. The socket can be destroyed and recreated by any
`ox` process, and the container picks it up immediately.

#### Why not `host.docker.internal` with TCP?

Using `host.docker.internal` with TCP ports would also work, but introduces a
port allocation problem: multiple `ox` instances and multiple sessions all
competing for host ports, requiring coordination via PID files or lock files.
Unix sockets avoid this entirely -- each session gets its own socket path, no
collisions possible.

### Multi-Instance Coordination

Multiple `ox` processes can run simultaneously (e.g., user has two terminals
open). The ownership model:

1. **On session creation**: The `ox` process that creates a session starts the
   socket server for it. It owns that socket.

2. **On `ox` startup** (seeing existing running sessions): For each running
   session, check if `browser-forward.sock` has an active listener (attempt a
   connection). If orphaned (stale socket file with no listener, or no socket
   file), adopt it by creating a new socket server.

3. **On `ox` shutdown**: Socket servers close naturally when the process exits.
   The socket file becomes stale.

4. **Race condition**: Two `ox` processes may race to adopt the same orphaned
   session. Both detect a stale socket, both try to `unlink` + `listen`. The
   first to bind wins; the second gets an error and skips. This is safe.

5. **Piggyback on credential watcher**: The existing `credentialWatcher`
   service already polls all registered sessions every 15 seconds to sync
   credential files. The socket health check can run in the same loop.

### Container-Side Components

#### `open-browser` script

Installed at `/usr/local/bin/open-browser` inside the container:

```sh
#!/bin/sh
url="$1"
if [ -z "$url" ]; then
    echo "Usage: open-browser <url>" >&2
    exit 1
fi
sock=/tmp/ox/browser-forward.sock
if [ ! -S "$sock" ]; then
    echo "No browser-forward socket found" >&2
    exit 1
fi
curl -sf -G --data-urlencode "url=$url" \
    --unix-socket "$sock" "http://localhost/open" >/dev/null 2>&1 &
```

#### Environment variable

Set `BROWSER=/usr/local/bin/open-browser` in the container environment. Most
tools that open URLs respect this variable (including `xdg-open`, `python
-m webbrowser`, Node.js `open` package, etc.).

#### No `tcp-bridge` needed

Since our containers use standard runc (not gVisor), Unix sockets work natively
across the bind-mount. No bridge binary is required.

### Host-Side Components

#### Browser Forward Server

A Bun/Node HTTP server listening on a Unix socket. Handles:

- `GET /open?url=<encoded-url>` -- Validate URL, call `open(url)` on host,
  detect and proxy localhost callback ports.
- `GET /health` -- Returns 200, used for liveness checks.

#### OAuth Callback Reverse Proxy

When a URL contains `localhost:PORT` (either as the main URL or in a
`redirect_uri` query parameter):

1. Look up the container's IP via `docker inspect`.
2. Bind a temporary TCP proxy on `127.0.0.1:PORT` on the host.
3. Forward connections to `container_ip:PORT`.
4. Auto-close after 5 minutes.

If the port is already in use on the host (another service, or another
session's proxy), log a warning and skip. The OAuth flow will fail, but this
is an edge case -- two sandboxes running OAuth flows on the same callback port
simultaneously.

### Cloud Provider (Deno Deploy)

For cloud sandboxes, the approach differs because there's no shared filesystem:

- **Phase 1**: Not supported. Log a message suggesting the user use a Docker
  sandbox for OAuth-dependent workflows.
- **Phase 2** (future): Use the existing WebSocket channel. Poll a request file
  inside the sandbox (similar to the log-streaming pattern) or use
  `sandbox.spawn()` to run a small relay process. OAuth callbacks would require
  a tunnel service, which is a larger project.

## Implementation Plan

### Phase 1: xdg-open Forwarding (Docker Only)

**Goal**: Agent code calls `xdg-open <url>` inside a Docker sandbox, and the
URL opens in the host's default browser.

#### 1.1 Add `open-browser` shim to the sandbox image

**File**: `sandbox/base.Dockerfile`

Add the `open-browser` script to the image. It's small enough to inline via a
`RUN` command or `COPY` from a file in `sandbox/`.

#### 1.2 Create browser forward service

**New file**: `src/services/browserForward.ts`

Singleton service (similar pattern to `credentialWatcher.ts`):

- `start(session)` -- Create directory, start Unix socket server, return
  cleanup function.
- `stop(session)` -- Close server, remove socket file.
- `adoptOrphans()` -- Check all running sessions, adopt any with stale/missing
  sockets.
- Internal HTTP handler for `/open` and `/health` endpoints.
- Uses the `open` npm package (already a dependency) to open URLs on the host.

#### 1.3 Integrate with Docker provider

**File**: `src/services/docker.ts` (or `src/services/runInDocker.ts`)

- On container creation, add the directory bind-mount
  (`-v ~/.ox/sessions/{id}/:/tmp/ox/:rw`) and set
  `BROWSER=/usr/local/bin/open-browser`.
- On container stop/remove, call `browserForward.stop(session)`.
- On `ox` startup (session list load), call `browserForward.adoptOrphans()`.

#### 1.4 URL allow-list (optional, recommended)

**File**: Project config or `~/.ox/config`

Add a `browser_targets` config field with glob patterns. Default to allowing
all URLs (or a sensible default list). The browser forward server checks
incoming URLs against this list before opening them.

### Phase 2: OAuth Callback Routing (Docker Only)

**Goal**: OAuth flows initiated from inside the sandbox complete successfully,
with the callback reaching the sandbox's local server.

#### 2.1 URL parsing for localhost ports

**File**: `src/services/browserForward.ts`

When handling an `/open` request, parse the URL and its `redirect_uri` query
parameter for `localhost:PORT` or `127.0.0.1:PORT` references.

#### 2.2 Temporary reverse proxy

**File**: `src/services/browserForward.ts`

For each detected localhost port:

1. Look up the container's IP via `docker inspect`.
2. Create a TCP server on `127.0.0.1:PORT`.
3. Pipe connections bidirectionally to `container_ip:PORT`.
4. Set a 5-minute timeout, then close.

#### 2.3 Container IP resolution

**File**: `src/services/docker.ts`

Add a helper function to get a container's IP address given its name/ID. This
already exists implicitly in docker inspect calls but needs to be exposed as a
utility.

### Phase 3: Cloud Provider Support (Future)

Out of scope for initial implementation. Requires WebSocket-based relay and
potentially a tunnel service for OAuth callbacks.

## File Change Summary

| File | Change |
|------|--------|
| `sandbox/base.Dockerfile` | Add `open-browser` script |
| `src/services/browserForward.ts` | New -- socket server, URL handler, OAuth proxy |
| `src/services/docker.ts` | Mount session directory, set BROWSER env var |
| `src/services/runInDocker.ts` | Pass mount and env var through to docker run |
| `src/services/credentialWatcher.ts` | Possibly integrate orphan adoption into poll loop |
| Project config types | Add `browser_targets` allow-list field |

## Open Questions

1. **Default allow-list policy**: Should we allow all URLs by default (easier
   onboarding) or block all without explicit config (safer)? agent-creds
   requires explicit `[[browser_target]]` entries -- empty list means all
   blocked.

2. **macOS socket reliability**: Unix socket bind-mounts on Docker Desktop for
   Mac need testing. Recent versions should be fine, but this is the primary
   platform risk.

3. **`BROWSER` vs `xdg-open` override**: Setting `BROWSER` covers most tools,
   but some may call `xdg-open` directly. We could also install `open-browser`
   as `xdg-open` in the PATH (before the system one), or create a symlink.
   Need to check what the agents (Claude, OpenCode, Codex) actually call.

4. **Logging/UX**: Should we show a notification in the TUI when a URL is
   forwarded to the host browser? This would give the user visibility that
   something happened.
