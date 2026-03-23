# Configuration

Ox uses a two-level YAML configuration system. This page covers all config keys, the CLI commands for managing config, and environment variable support.

## Config Files

| Level | Location | Purpose |
|-------|----------|---------|
| **Project** | `.ox/config.yml` | Project-specific settings (gitignored by default) |
| **User** | `~/.config/ox/config.yml` | Personal defaults across all projects |

Project config takes precedence over user config. Both files are optional -- ox works with sensible defaults.

## Interactive Setup

Run `ox config` to launch the interactive configuration wizard:

```bash
ox config
```

The wizard walks through sandbox provider, agent, model, and authentication setup. It writes to the project config file (`.ox/config.yml`).

<!-- screenshot: docs/assets/config-wizard.gif -->

## Config Keys

### Agent Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `agent` | `string` | -- | Default agent: `claude`, `opencode`, or `codex` |
| `model` | `string` | -- | Default model for the selected agent |
| `agentModels` | `object` | -- | Per-agent model preferences. Maps agent name to model ID (e.g., `{ claude: "opus", opencode: "sonnet" }`) |
| `agentMode` | `string` | -- | Default agent mode: `async`, `interactive`, or `plan` |

### Sandbox Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `sandboxProvider` | `string` | `docker` | Sandbox provider: `docker` or `cloud` |
| `cloudRegion` | `string` | `ord` | Cloud sandbox region: `ord` (Chicago) or `ams` (Amsterdam) |
| `sandboxBaseImage` | `string` | -- | Override Docker image for sandbox containers |
| `buildSandboxFromDockerfile` | `boolean\|string` | `false` | Build sandbox image from Dockerfile. `true` uses the built-in Dockerfile; a string value specifies a path to a custom Dockerfile. Takes precedence over `sandboxBaseImage`. |
| `dockerInSandbox` | `boolean` | `false` | Enable Ox's built-in Docker-in-Docker setup. On Docker sandboxes, this installs Docker, starts `dockerd`, and auto-enables `--privileged` unless you explicitly set `privileged: false`. On Cloud sandboxes, it opts into the Docker-enabled base snapshot. |
| `projectSetupLayer` | `string` | -- | Bash script to run on top of the base sandbox image and cache as a reusable layer. Use for system-level dependencies like apt packages, language runtimes, Docker, or browser tooling. Runs before the agent overlay and without your project repo mounted. |
| `overlayMounts` | `string[]` | -- | Paths to isolate with Docker volume mounts in [mount mode](sandbox-providers.md#mount-mode). E.g., `["node_modules"]` |
| `privileged` | `boolean` | `false` | Run Docker sandbox containers in privileged mode (`--privileged`). Required for Docker-in-Docker. Only applies to the Docker sandbox provider. |
| `rootInitScript` | `string` | -- | Shell command to run as **root** inside the sandbox before `initScript`. Useful for installing system packages. E.g., `"apt-get update && apt-get install -y build-essential"` |
| `initScript` | `string` | -- | Shell command to run inside the sandbox before starting the agent. Runs in all modes. E.g., `"npm install"` |

### Port Forwarding

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `appPort` | `number` | -- | Default app port in the sandbox. Mapped to `https://<session>.ox.local`. |
| `additionalPorts` | `object[]` | -- | Extra port mappings. Each entry: `{ port: number, subdomain: string }`. Mapped to `https://<subdomain>.<session>.ox.local`. |
| `proxyPort` | `number` | -- | Override the HTTPS proxy port (Caddy). Falls back to 443, then 8443, 9443, then a random port. |

See [Port Forwarding](sandbox-providers.md#port-forwarding) for details.

### Database

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `tigerServiceId` | `string\|null` | -- | Timescale Tiger service ID for database forking. Set to `null` to explicitly disable DB forking. |

### Appearance

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `themeName` | `string` | `opencode` or `aura` | TUI color theme. Defaults to `opencode` when your terminal supports truecolor, otherwise `aura`. See [Themes](tui.md#themes) for the full list. |

### Telemetry

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `analytics` | `boolean` | `true` | Enable anonymous usage analytics. Set to `false` to disable. Also controlled by environment variables: `DO_NOT_TRACK=1`, `NO_TELEMETRY=1`, or `OX_ANALYTICS=false`. |

## CLI Config Commands

### `ox config`

Run the interactive configuration wizard.

### `ox config show`

Print the current effective config (merged project + user):

```bash
ox config show
ox config show --global  # show only user config
```

### `ox config set <key> <value>`

Set a config value:

```bash
ox config set agent claude
ox config set model opus
ox config set sandboxProvider cloud
ox config set overlayMounts '["node_modules", ".next"]'
ox config set --global themeName catppuccin-macchiato
```

Use `--global` to write to user config instead of project config.

### `ox config unset <key>`

Remove a config value:

```bash
ox config unset tigerServiceId
ox config unset --global model
```

### `ox config enable <key>` / `ox config disable <key>`

Toggle boolean config values:

```bash
ox config enable analytics
ox config disable analytics
ox config enable buildSandboxFromDockerfile
```

### `ox config reset`

Delete the config file entirely:

```bash
ox config reset          # delete project config
ox config reset --global # delete user config
```

## Environment Variables

Ox supports hierarchical `.env` files that are automatically loaded into your sandbox containers. These files are organized by scope (user vs project), provider (docker vs cloud), and agent type. More specific files override less specific ones.

### File Locations

User-level files apply to all projects and are located in `~/.config/ox/`:

- `.env` - all containers
- `.env.agents` - all agent containers
- `.env.docker` - all Docker containers
- `.env.cloud` - all Cloud containers
- `.env.docker.agents` - Docker agent containers
- `.env.cloud.agents` - Cloud agent containers
- `.env.claude` - Claude agent containers
- `.env.opencode` - OpenCode agent containers
- `.env.codex` - Codex agent containers
- `.env.docker.claude` - Docker Claude containers
- `.env.docker.opencode` - Docker OpenCode containers
- `.env.docker.codex` - Docker Codex containers
- `.env.cloud.claude` - Cloud Claude containers
- `.env.cloud.opencode` - Cloud OpenCode containers
- `.env.cloud.codex` - Cloud Codex containers

Project-level files are located in the `.ox/` directory of your project and apply only to that project. They follow the same naming pattern as user-level files (e.g., `.ox/.env`, `.ox/.env.docker`).

### Precedence

Files are loaded in order of increasing specificity. If the same variable is defined in multiple files, the one with the highest precedence wins:

1. **User-level files** (lowest)
2. **Project-level files** (highest)

Within each level, the precedence is:
`generic` → `provider-specific` → `agent-specific` → `provider+agent-specific`

### File Format

Ox uses the standard `.env` format:

```env
# Comments start with #
KEY=value
QUOTED="value with spaces"
SINGLE_QUOTED='also works'
EMPTY_KEY=
# No variable expansion - $VAR stays literal
```

### Example Use Cases

- **Global API keys**: Set keys for all projects in `~/.config/ox/.env`.
- **Docker-specific settings**: Use `.ox/.env.docker` for settings that only apply when running locally.
- **Agent-specific variables**: Use `.ox/.env.claude` to pass environment variables only to Claude agent sessions.

## Build-Time vs Run-Time Setup

Ox supports three different setup hooks for sandbox customization:

- `projectSetupLayer` -- build-time, cached image layer; best for system packages and heavyweight tooling that should be reused across sessions
- `rootInitScript` -- run-time, runs as root on every session start, resume, and shell creation
- `initScript` -- run-time, runs as the sandbox user on every session start, resume, and shell creation

If you only need Docker itself inside the sandbox, prefer `dockerInSandbox: true` over custom `projectSetupLayer` and `rootInitScript` snippets.

Use `projectSetupLayer` for things like `apt-get install`, browser dependencies, Docker tooling, or language runtimes that do not depend on your repository contents. Because it runs before your repo is mounted and is cached as an image/snapshot layer, it avoids repeating expensive setup work on every session.

Use `rootInitScript` or `initScript` for per-session setup that depends on the working directory, environment variables, checked-out code, or other state that is only available at container startup.

## Example Config

```yaml
# .ox/config.yml
agent: claude
model: sonnet
agentMode: async
sandboxProvider: docker
tigerServiceId: null
themeName: tokyonight
overlayMounts:
  - node_modules
dockerInSandbox: true
projectSetupLayer: |
  apt-get update
  apt-get install -y ffmpeg chromium
rootInitScript: "apt-get update && apt-get install -y build-essential"
initScript: "npm install"
appPort: 3000
additionalPorts:
  - port: 5555
    subdomain: api
```

## Next Steps

- [Agents](agents.md) -- Agent and model selection in detail
- [Sandbox Providers](sandbox-providers.md) -- Docker, Cloud, mount mode, and port forwarding
- [TUI Guide](tui.md) -- Themes and the config wizard in the TUI
