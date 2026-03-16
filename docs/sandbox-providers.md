# Sandbox Providers

Ox runs AI agents inside isolated sandbox environments. Two providers are available: Docker (local containers) and Cloud (remote sandboxes via Deno Deploy).

## Docker (Default)

Agents run in local Docker containers built from purpose-built images that include common development tools, language runtimes, and the AI agent CLIs.

### How It Works

1. **Base image** -- Ox uses a pre-built image from GHCR (`ghcr.io/timescale/ox`) based on Ubuntu 24.04 with git, ripgrep, curl, tmux, GitHub CLI, and other essentials
2. **Agent overlay** -- On top of the base, ox builds an agent-specific overlay that installs the chosen agent CLI (Claude Code, OpenCode, or Codex)
3. **Container creation** -- A container is created with your code (cloned from GitHub or mounted from your filesystem), credentials injected, and the agent launched

Images are cached locally. The first run pulls and builds the images, which takes a few minutes. Subsequent runs start in seconds.

### Custom Base Image

Override the base image via config:

```yaml
# .ox/config.yml
sandboxBaseImage: myregistry/my-sandbox:latest
```

Or build from a Dockerfile:

```yaml
buildSandboxFromDockerfile: true          # use built-in Dockerfile
buildSandboxFromDockerfile: ./Dockerfile  # path to custom Dockerfile
```

### Mount Mode

By default, ox clones your repository from GitHub inside the sandbox. Mount mode instead bind-mounts your local working directory:

```bash
ox --mount "Add tests for the new API endpoints"
ox --mount /path/to/project "Fix the build"
```

In the TUI, toggle mount mode with `ctrl+d` or the `/mount` slash command.

#### Overlay Mounts

In mount mode, some directories (like `node_modules`) can cause conflicts between the host and container. Use `overlayMounts` to isolate them with Docker volumes:

```yaml
# .ox/config.yml
overlayMounts:
  - node_modules
  - .next
  - dist
```

Each listed path gets its own isolated Docker volume inside the container, so the agent can install dependencies without affecting your host filesystem.

### Init Script

Run a shell command inside the container before the agent starts (see [Configuration](configuration.md) for all config keys):

```yaml
# .ox/config.yml
initScript: "npm install"
```

The init script runs after the working directory is set up, in all modes (async, interactive, plan). Useful for installing dependencies, setting up databases, or any other preparation.

## Cloud

Agents run in remote sandboxes powered by Deno Deploy. Useful for offloading work from your machine or running many tasks in parallel without local resource constraints.

### Setup

1. Run `ox config` and select Cloud as the sandbox provider, or:

```bash
ox config set sandboxProvider cloud
```

2. Ox will prompt you for a Deno Deploy token during setup. Tokens are stored securely in the OS keyring.

### Usage

```bash
# Use cloud provider for a single task
ox --provider cloud "Migrate the database schema"

# Or set it as the default
ox config set sandboxProvider cloud
ox config set cloudRegion ord  # ord (Chicago) or ams (Amsterdam)
```

In the TUI, toggle between providers with `ctrl+e` or the `/cloud`, `/docker`, `/provider` slash commands.

### Regions

| Region | Location |
|--------|----------|
| `ord` | Chicago, USA |
| `ams` | Amsterdam, Netherlands |

Volumes, snapshots, and sandboxes are regional -- they must all be in the same region.

### Cloud Sessions

Cloud sessions use SSH to connect to the remote sandbox. Interactive and plan mode sessions run inside tmux for persistence across SSH disconnects.

Session metadata is stored locally in a SQLite database so ox can track cloud sessions across restarts.

## Switching Providers

You can switch providers at any time:

- **CLI flag**: `--provider docker` or `--provider cloud`
- **Config**: `ox config set sandboxProvider cloud`
- **TUI**: `ctrl+e` on the prompt screen, or `/provider` slash command

Different sessions can use different providers. Provider choice is per-session, stored in the session metadata.

## Port Forwarding

When you configure `appPort`, ox sets up a local HTTPS reverse proxy so you can access services running in your sandbox from your browser.

### How It Works

1. **Caddy** -- Ox runs a local Caddy reverse proxy
2. **TLS certificates** -- Self-signed certificates are generated and trusted on your system
3. **DNS** -- `*.ox.local` domains resolve to localhost
4. **Routing** -- Requests to `https://<session-name>.ox.local` are proxied to the container's app port

### Configuration

```yaml
# .ox/config.yml
appPort: 3000                    # main app port
additionalPorts:                 # extra ports
  - port: 5555
    subdomain: api               # accessible at https://api.<session>.ox.local
proxyPort: 443                   # HTTPS port (optional override)
```

### Viewing URLs

```bash
ox session urls <session>
```

In the TUI session detail view, press `ctrl+b` to open the app URL in your browser.

### Requirements

Port forwarding requires:
- **sudo access** -- For trusting TLS certificates and binding to port 443 (ox will prompt)
- **Docker network** -- Ox creates a Docker network for proxy-container communication

If sudo is unavailable, ox falls back to a higher port (8443, 9443, or random) and TLS certificate trust may need to be configured manually.

## Credential Sync

Ox automatically syncs agent credentials between your host and running sandbox containers. If a credential refreshes (e.g., OAuth token rotation), ox propagates the update to all running sessions within 15 seconds. This happens in the background -- no manual intervention needed.

## Next Steps

- [Configuration](configuration.md) -- All config keys for sandbox settings
- [Agents](agents.md) -- Agent-specific setup and authentication
- [Session Management](sessions.md) -- Managing sessions across providers
