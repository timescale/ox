# ox

Run AI coding agents in isolated sandboxes, one task at a time.

Ox automates the entire workflow of starting a coding task: it creates a feature branch, optionally forks your database, and launches an AI agent inside an isolated sandbox -- all from a single command or an interactive terminal UI.

### Features

- **Sandboxed execution** -- Agents run in isolated Docker containers or cloud sandboxes, never on your host machine
- **Branch-per-task** -- Automatically creates a git branch with an LLM-generated name for each task
- **Database forking** -- Optionally fork your Timescale database per branch for full environment isolation
- **Multiple agents** -- Supports Claude Code and OpenCode out of the box
- **Interactive TUI** -- Rich terminal UI for managing sessions, with a command palette, 30+ themes, and keyboard shortcuts
- **Session management** -- Start, stop, resume, attach to, and shell into agent sessions at any time
- **Two sandbox providers** -- Run locally with Docker or remotely with cloud sandboxes
- **Auto-update** -- Keeps itself up to date in the background

## Beta software

Note that ox is currently in rapid development. Expect rough edges and breaking changes.

We'd love to hear feedback from the community. Please create [issues](https://github.com/timescale/ox/issues), send us feedback from the app via `ox feedback`, or submit PRs!

## Quick Start

```bash
# Install
curl -fsSL https://get.ox.build | bash

# Run the interactive TUI
ox

# Start a task (runs in background, prints session ID)
ox "Add input validation to the signup form"

# Start a task and follow the output
ox -f "Fix the broken unit tests"

# Check on your sessions
ox session ps
```

## Installation

### Quick Install (Recommended)

```bash
curl -fsSL https://get.ox.build | bash
```

After installation, restart your shell or run `source ~/.zshrc` (or `source ~/.bashrc`) to update your PATH.

Re-run the command at any time to update to the latest version.

### Homebrew

```bash
brew install timescale/tap/ox
```

### npm

```bash
npm i -g @ox.build/cli
```

### Source (Developers)

```bash
git clone https://github.com/timescale/ox.git
cd ox
./bun i && ./bun link
source ~/.zshrc  # or restart your shell
```

### Recommended Terminal

While any terminal should work, we recommend [Ghostty](https://ghostty.org/) for the best TUI experience:

```bash
brew install --cask ghostty
```

## Usage

### Interactive TUI

Run `ox` with no arguments to open the full terminal UI. From here you can write a prompt to start a new task, browse active sessions, resume previous work, and manage configuration.

```bash
ox
```

### Start a Task

Pass a natural-language description to start a task. By default, Ox creates the session in the background and prints the session ID:

```bash
ox "Refactor the auth middleware to use JWT tokens"
# Prints session ID to stdout, progress to stderr, exits immediately
```

This is designed for scripting -- you can capture the session ID:

```bash
SESSION=$(ox "Add input validation to the signup form")
ox session logs -f "$SESSION"
```

### Follow Mode

Stream the agent's output to your terminal:

```bash
ox -f "Fix the failing integration tests"
```

The process exits with the agent's exit code when the session finishes.

### Interactive Mode

Launch the full TUI and work alongside the agent in a live terminal session:

```bash
ox -i "Implement the new dashboard component"
```

The `-i` flag implies `--agent-mode=interactive` unless you specify otherwise.

### Agent Modes

Control how the agent runs inside the sandbox with `--agent-mode` / `-M`:

| Mode | Description |
|------|-------------|
| `async` (default) | Agent runs in the background. Best for fire-and-forget tasks. |
| `interactive` | Agent runs with a TTY for live interaction. Use with `-i`. |
| `plan` | Agent runs in read-only/plan mode. Can review but not modify code. |

```bash
# Start a plan-mode agent (detached)
ox -M plan "Review the authentication flow for security issues"

# Start an async agent but view it in the TUI
ox -i -M async "Add comprehensive test coverage"
```

### Flag Compatibility

| Flags | Behavior |
|-------|----------|
| `ox "task"` | Detached async -- print session ID, exit |
| `ox -f "task"` | Follow async -- stream output, exit with agent code |
| `ox -i "task"` | Interactive TUI -- launch TUI, auto-submit |
| `ox -M plan "task"` | Detached plan -- print session ID, exit |
| `ox -i -M async "task"` | TUI + async -- launch TUI, show session detail |
| `ox -f -i "task"` | **Error** -- mutually exclusive |
| `ox -f -M interactive "task"` | **Error** -- follow requires async mode |

### Shell Access

Open a bash shell inside a new sandbox without starting an agent:

```bash
ox shell
```

Or shell into a running session:

```bash
ox resume --shell <session>
```

## Sandbox Providers

Ox supports two sandbox providers for running agents:

### Docker (Default)

Agents run in local Docker containers built from purpose-built images that include common development tools, language runtimes, and the AI agent CLIs. Your code is either cloned from GitHub or bind-mounted from your local filesystem.

```bash
# Mount your local working directory into the sandbox
ox --mount "Add tests for the new API endpoints"
```

### Cloud

Agents run in remote cloud sandboxes powered by Deno Deploy. This is useful for offloading work from your machine or running tasks in parallel without local resource constraints.

```bash
# Use the cloud provider
ox --provider cloud "Migrate the database schema"
```

Configure the default provider in your config:

```yaml
# .ox/config.yml
sandboxProvider: cloud
cloudRegion: ord  # ord (Chicago) or ams (Amsterdam)
```

Support for additional providers is planned.

## Agent Support

Ox is designed to support multiple AI coding agents:

| Agent | Description |
|-------|-------------|
| **OpenCode** | Open-source coding agent CLI with support for multiple model providers |
| **Claude Code** | Anthropic's Claude Code CLI |
| **Codex** | OpenAI's coding agent CLI |

We'd love to support more agents. Let us know your favorite to help us prioritize. Vote on or add to the tickets [here](https://github.com/timescale/ox/milestone/1), send us feedback via `ox feedback`, or submit a PR!

Select an agent per-task or set a default:

```bash
# Use a specific agent for this task
ox --agent claude "Implement the new dashboard component"

# Set a default in config
ox config
```

You can also choose a specific model:

```bash
ox --model opus "Design the database schema for the new feature"
```

## Database Forking

When working with a [Timescale](https://www.timescale.com/) database, Ox can automatically create an isolated database fork for each task branch. This gives each agent session its own copy of the database to work with, so schema changes and test data never collide between tasks.

Database forking is optional. If no Timescale service is configured, Ox skips this step and creates the sandbox without a database fork.

```yaml
# .ox/config.yml
tigerServiceId: your-service-id  # or null to disable
```

## Configuration

Ox uses a two-level YAML configuration system:

| Level | Location | Purpose |
|-------|----------|---------|
| **User** | `~/.config/ox/config.yml` | Personal defaults across all projects |
| **Project** | `.ox/config.yml` | Project-specific overrides (gitignored) |

Project config takes precedence over user config.

### Interactive Setup

Run `ox config` to walk through an interactive setup wizard that configures your sandbox provider, agent, model, and authentication.

### Key Options

```yaml
# .ox/config.yml
agent: opencode             # Default agent: opencode or claude
model: sonnet               # Default model for the selected agent
sandboxProvider: docker      # Sandbox provider: docker or cloud
cloudRegion: ord             # Cloud region: ord (Chicago) or ams (Amsterdam)
tigerServiceId: null         # Timescale service ID for DB forking (null to disable)
overlayMounts:               # Paths to isolate in mount mode (e.g., node_modules)
  - node_modules
initScript: 'npm install'   # Shell command to run before starting the agent
themeName: opencode          # TUI theme (30+ built-in themes)
```

### Environment Variables

Place a `.ox/.env` file in your project root to pass environment variables into the sandbox:

```env
DATABASE_URL=postgres://localhost:5432/mydb
API_KEY=your-key-here
```

## Session Management

Ox provides two ways to manage sessions: the `ox session` command (alias: `ox container`) for individual session operations, and `ox sessions` for listing.

In all commands below, `<session>` can be the session name or ID. Tab completion is supported.

### Listing Sessions

```bash
# Table of running sessions
ox session ps

# Include stopped sessions
ox session ps --all

# JSON output for scripting
ox session ps -o json

# YAML output
ox session ps -o yaml

# Open the TUI session list
ox session ps -o tui
```

`ox sessions` is an alias for `ox session ps` and supports the same flags.

### Session Details

```bash
# Show detailed info for a session
ox session info <session>

# JSON output
ox session info -o json <session>
```

### Session Logs

```bash
# Print logs for a session
ox session logs <session>

# Follow logs in real time (like tail -f)
ox session logs -f <session>

# Show last N lines
ox session logs --tail 50 <session>
```

### Stopping and Removing Sessions

```bash
# Stop a running session
ox session stop <session>

# Remove a session (aliases: rm, remove, delete)
ox session rm <session>

# Remove all stopped containers
ox session clean

# Remove all containers including running
ox session clean --all
```

### Attaching to Sessions

```bash
# Attach to a running session's terminal
ox session attach <session>
```

### Resuming Sessions

```bash
# Resume a stopped session
ox resume <session>

# Resume with a new prompt
ox resume <session> "Continue by adding error handling"

# Resume in the background
ox resume --detach <session>
```

### Resource Cleanup

```bash
# Clean up old images, volumes, and snapshots
ox resources clean
```

## CLI Reference

### Root Command

| Command | Description |
|---------|-------------|
| `ox [prompt]` | Start a new task (detached) or open the TUI (no prompt) |
| `ox -f [prompt]` | Start a task and follow the agent output |
| `ox -i [prompt]` | Start a task in the interactive TUI |
| `ox -M <mode> [prompt]` | Start a task with a specific agent mode (async/interactive/plan) |

### Session Management

| Command | Description |
|---------|-------------|
| `ox session ps` | List sessions (aliases: `list`, `ls`) |
| `ox session info <id>` | Show detailed session information |
| `ox session logs <id>` | Print session logs (`-f` to follow) |
| `ox session stop <id>` | Stop a running session |
| `ox session rm <id>` | Remove a session (aliases: `remove`, `delete`) |
| `ox session attach <id>` | Attach to a running session |
| `ox session clean` | Remove stopped containers (`-a` for all) |
| `ox sessions` | Alias for `ox session ps` |
| `ox resume <session>` | Resume a stopped session |

### Other Commands

| Command | Description |
|---------|-------------|
| `ox shell` | Open a shell in a new sandbox |
| `ox config` | Interactive configuration wizard |
| `ox auth check <provider>` | Check authentication status |
| `ox auth login <provider>` | Log in to a provider |
| `ox resources` | Manage sandbox images, volumes, and snapshots |
| `ox logs` | View ox logs |
| `ox upgrade` | Check for and install updates |
| `ox completions [shell]` | Set up shell tab completions |
| `ox claude [args...]` | Run Claude Code inside a sandbox |
| `ox opencode [args...]` | Run OpenCode inside a sandbox |
| `ox gh [args...]` | Run the GitHub CLI inside a sandbox |
| `ox colors` | Display theme color swatches |

Use `ox <command> --help` for detailed options on any command.

## License

Apache 2.0 -- see [LICENSE](LICENSE) for details.
