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
| `overlayMounts` | `string[]` | -- | Paths to isolate with Docker volume mounts in [mount mode](sandbox-providers.md#mount-mode). E.g., `["node_modules"]` |
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

Place a `.ox/.env` file in your project root to pass environment variables into the sandbox:

```env
DATABASE_URL=postgres://localhost:5432/mydb
API_KEY=your-key-here
```

These variables are injected into the sandbox container at startup and are available to both the init script and the agent.

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
