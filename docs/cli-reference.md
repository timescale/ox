# CLI Reference

Complete reference for all ox commands, flags, and options. Use `ox <command> --help` for built-in help on any command.

## `ox [prompt]`

Start a new task or open the TUI.

```bash
ox                                    # open TUI
ox "Add input validation"             # detached async
ox -f "Fix the tests"                 # follow mode
ox -i "Implement dashboard"           # interactive TUI
```

**Options:**

| Flag | Description |
|------|-------------|
| `-a, --agent <type>` | Agent: `claude`, `opencode`, or `codex` |
| `-m, --model <model>` | Model override |
| `-M, --agent-mode <mode>` | Agent mode: `async`, `interactive`, or `plan` |
| `-f, --follow` | Stream agent output and exit when done |
| `-i, --interactive` | Launch the full TUI |
| `-s, --service-id <id>` | Tiger database service ID |
| `--no-db-fork` | Skip database fork |
| `--mount [dir]` | Mount local directory instead of git clone |
| `-r, --provider <type>` | Sandbox provider: `docker` or `cloud` |
| `-o, --output <format>` | Output format: `id` (default), `json`, `yaml` |

See [Usage](usage.md) for detailed explanations and the flag compatibility matrix.

---

## Session Commands

### `ox sessions`

List sessions. Top-level aliases: `ox ps`, `ox ls`, `ox list`, `ox status`. The same listing is also available as `ox session ps` (with sub-aliases `ox session list`, `ox session ls`).

```bash
ox sessions                   # table of running sessions
ox sessions --all             # include stopped sessions
ox sessions -o json           # JSON output
ox sessions -o yaml           # YAML output
ox sessions -o tui            # open TUI session list
```

**Options:**

| Flag | Description |
|------|-------------|
| `-a, --all` | Include stopped/completed sessions |
| `-o, --output <format>` | Output format: `table` (default), `json`, `yaml`, `tui` |

### `ox session info <session>`

Show detailed information about a session.

```bash
ox session info my-feature-branch
ox session info -o json my-feature-branch
```

**Options:**

| Flag | Description |
|------|-------------|
| `-o, --output <format>` | Output format: `table` (default), `json`, `yaml` |

### `ox session logs <session>`

Print session logs.

```bash
ox session logs my-feature-branch
ox session logs -f my-feature-branch       # follow in real time
ox session logs --tail 50 my-feature-branch # last N lines
```

**Options:**

| Flag | Description |
|------|-------------|
| `-f, --follow` | Follow logs in real time |
| `--tail <n>` | Number of lines to show from the end |

### `ox session stop <session>`

Stop a running session.

```bash
ox session stop my-feature-branch
```

### `ox session rm <session>`

Remove a session. Aliases: `remove`, `delete`.

```bash
ox session rm my-feature-branch
```

### `ox session attach <session>`

Attach to a running session's terminal (interactive/plan mode only).

```bash
ox session attach my-feature-branch
```

### `ox session urls <session>`

Print proxied URLs for a session.

```bash
ox session urls my-feature-branch
```

Requires `appPort` to be configured. See [Port Forwarding](sandbox-providers.md#port-forwarding).

### `ox session shell <session>`

Open a bash shell inside a running session's sandbox.

```bash
ox session shell my-feature-branch
```

### `ox session clean`

Remove stopped session containers.

```bash
ox session clean          # stopped only
ox session clean --all    # all containers
```

**Options:**

| Flag | Description |
|------|-------------|
| `-a, --all` | Remove all containers, including running |
| `-f, --force` | Skip the confirmation prompt |

---

## `ox resume <session> [prompt]`

Resume a stopped or completed session, optionally with a new prompt.

```bash
ox resume my-feature-branch
ox resume my-feature-branch "Add error handling to the API routes"
ox resume --detach my-feature-branch
```

**Options:**

| Flag | Description |
|------|-------------|
| `-d, --detach` | Resume in the background |
| `--shell` | Open a shell instead of resuming the agent |
| `-a, --agent <type>` | Override agent |
| `-m, --model <model>` | Override model |
| `-M, --agent-mode <mode>` | Override agent mode |
| `-f, --follow` | Follow output |
| `-i, --interactive` | Resume in TUI |
| `-o, --output <format>` | Output format |

---

## `ox shell`

Open a bash shell inside a new sandbox without starting an agent.

```bash
ox shell
```

**Options:**

| Flag | Description |
|------|-------------|
| `--mount [dir]` | Mount local directory |
| `-r, --provider <type>` | Sandbox provider |

---

## Config Commands

### `ox config`

Launch the interactive configuration wizard.

### `ox config show`

Print current effective configuration.

```bash
ox config show
ox config show --global    # user config only
```

### `ox config set <key> <value>`

Set a configuration value.

```bash
ox config set agent claude
ox config set --global themeName dracula
```

**Options:**

| Flag | Description |
|------|-------------|
| `-g, --global` | Write to user config instead of project config |

### `ox config unset <key>`

Remove a configuration value.

```bash
ox config unset dbServiceId
ox config unset --global model
```

**Options:**

| Flag | Description |
|------|-------------|
| `-g, --global` | Modify user config |

### `ox config enable <key>`

Enable a boolean config value.

```bash
ox config enable analytics
```

### `ox config disable <key>`

Disable a boolean config value.

```bash
ox config disable analytics
```

### `ox config reset`

Delete the config file.

```bash
ox config reset            # project config
ox config reset --global   # user config
```

See [Configuration](configuration.md) for all config keys and their descriptions.

---

## Auth Commands

### `ox auth check <provider>`

Check authentication status for a provider.

```bash
ox auth check claude
ox auth check opencode
ox auth check codex
ox auth check gh
```

### `ox auth login <provider>`

Ensure a provider is authenticated, prompting if needed.

```bash
ox auth login claude
ox auth login gh
```

---

## Resource Commands

### `ox resources`

Manage sandbox resources (TUI).

### `ox resources list`

List all sandbox resources (images, volumes, snapshots).

```bash
ox resources list
ox resources list -o json
```

### `ox resources clean`

Remove old and orphaned sandbox resources.

```bash
ox resources clean
```

---

## Agent Pass-Through Commands

Run agent CLIs directly inside a sandbox:

### `ox claude [args...]`

```bash
ox claude --help
ox claude "Quick question about the codebase"
```

### `ox opencode [args...]`

```bash
ox opencode --version
```

### `ox codex [args...]`

```bash
ox codex "Explain this function"
```

### `ox gh [args...]`

Run the GitHub CLI inside a sandbox:

```bash
ox gh pr list
ox gh issue create --title "Bug report"
```

---

## Utility Commands

### `ox upgrade`

Check for and install updates. Aliases: `update`, `u`.

```bash
ox upgrade
```

### `ox completions [shell]`

Set up shell tab completions.

```bash
ox completions            # auto-detect
ox completions zsh
ox completions bash
ox completions fish
ox completions powershell
```

### `ox feedback <message>`

Send feedback to the ox team.

```bash
ox feedback "Feature request: support for Cursor agent"
```

### `ox logs`

Display ox application logs.

```bash
ox logs
ox logs --level error     # filter by level
ox logs --follow          # follow in real time
```

### `ox colors`

Display theme color swatches for the current theme.

```bash
ox colors
```

### `ox sandbox hash`

Print the content hash for sandbox image tags. Used internally for image versioning.

```bash
ox sandbox hash
```
