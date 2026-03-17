# ox

Run AI coding agents in isolated sandboxes, one task at a time.

Ox automates the entire workflow of starting a coding task: it creates a feature branch, optionally forks your database, and launches an AI agent inside an isolated sandbox -- all from a single command or an interactive terminal UI.

![Three interactive ox sessions, one each for Claude Code, OpenCode, and Codex, switching between them with detach and attach](docs/images/multi-agent-sessions.gif)

### Features

- **Sandboxed execution** -- Agents run in isolated Docker containers or cloud sandboxes, never on your host machine
- **Branch-per-task** -- Automatically creates a git branch with an LLM-generated name for each task
- **Database forking** -- Optionally fork your Timescale database per branch for full environment isolation
- **Multiple agents** -- Supports Claude Code, OpenCode, and Codex out of the box
- **Interactive TUI** -- Rich terminal UI for managing sessions, with a command palette, 30+ themes, and keyboard shortcuts
- **Session management** -- Start, stop, resume, attach to, and shell into agent sessions at any time
- **Two sandbox providers** -- Run locally with Docker or remotely with cloud sandboxes
- **Auto-update** -- Keeps itself up to date in the background

## Beta Software

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
ox sessions
```

## Installation

### Quick Install (Recommended)

```bash
curl -fsSL https://get.ox.build | bash
```

After installation, restart your shell or run `source ~/.zshrc` (or `source ~/.bashrc`) to update your PATH. Re-run the command at any time to update to the latest version.

### Homebrew

```bash
brew install timescale/tap/ox
```

### npm

```bash
npm i -g @ox.build/cli
```

### From Source

```bash
git clone https://github.com/timescale/ox.git
cd ox
./bun i && ./bun link
source ~/.zshrc  # or restart your shell
```

## Recommended Terminal

While any terminal should work, we recommend [Ghostty](https://ghostty.org/) for the best TUI experience -- it has proper truecolor support, fast rendering, and correct Unicode handling:

```bash
brew install --cask ghostty
```

## Agent Support

| Agent | Description |
|-------|-------------|
| **Claude Code** | Anthropic's Claude Code CLI |
| **OpenCode** | Open-source coding agent CLI with support for multiple model providers |
| **Codex** | OpenAI's coding agent CLI |

We'd love to support more agents. Let us know your favorite to help us prioritize. Vote on or add to the tickets [here](https://github.com/timescale/ox/milestone/1), send us feedback via `ox feedback`, or submit a PR!

## Documentation

| Page | Description |
|------|-------------|
| [Getting Started](docs/getting-started.md) | Installation, first run, config wizard, shell completions |
| [Usage](docs/usage.md) | Starting tasks, follow mode, interactive mode, agent modes |
| [Recommended Workflow](docs/workflow.md) | The async PR workflow for maximum productivity |
| [Session Management](docs/sessions.md) | Session lifecycle, attaching, resuming, logs, cleanup |
| [Configuration](docs/configuration.md) | Config files, all options, environment variables |
| [Sandbox Providers](docs/sandbox-providers.md) | Docker, Cloud, mount mode, port forwarding |
| [Agents](docs/agents.md) | Agent selection, models, authentication |
| [TUI Guide](docs/tui.md) | Views, keyboard shortcuts, command palette, slash commands, themes |
| [CLI Reference](docs/cli-reference.md) | Complete command and flag reference |

## License

Apache 2.0 -- see [LICENSE](LICENSE) for details.
