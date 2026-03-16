# Getting Started

This guide walks you through installing ox, running it for the first time, and configuring your environment.

## Prerequisites

- **Docker** -- Required for the default sandbox provider. Install from [docker.com](https://www.docker.com/products/docker-desktop/) or via your package manager.
- **Git** -- Your project should be a git repository with a GitHub remote.
- **An AI agent account** -- You need credentials for at least one supported agent (Claude Code, OpenCode, or Codex). Ox will walk you through authentication on first run.

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

## First Run

Navigate to a git repository and run:

```bash
ox
```

If this is your first time, ox launches the **configuration wizard** -- an interactive TUI that walks you through:

1. **Docker check** -- Verifies Docker is installed and running
2. **Sandbox provider** -- Choose between Docker (local) or Cloud (remote)
3. **Agent selection** -- Pick your default AI agent (Claude Code, OpenCode, or Codex)
4. **Model selection** -- Choose a default model for the selected agent
5. **Agent authentication** -- Log in to your chosen agent
6. **GitHub authentication** -- Authenticate with GitHub via device flow

Your choices are saved to `.ox/config.yml` in the current project. You can re-run the wizard at any time with `ox config`, or edit the file directly. See [Configuration](configuration.md) for all available options.

## Your First Task

Once configured, start a coding task:

```bash
# Start a task in the background
ox "Add input validation to the signup form"

# Or follow the agent's output
ox -f "Fix the broken unit tests"

# Or use the full interactive TUI
ox -i "Implement the new dashboard component"
```

Ox will:
1. Generate a git branch name from your prompt (using the configured AI model)
2. Spin up an isolated sandbox with your code
3. Launch the AI agent with your prompt

See [Usage](usage.md) for a deeper explanation of the different invocation modes.

## Shell Completions

Set up tab completions for your shell:

```bash
ox completions        # auto-detect shell
ox completions zsh    # or specify explicitly
ox completions bash
ox completions fish
```

This enables tab completion for commands, flags, and session names.

## Recommended Terminal

While any terminal should work, [Ghostty](https://ghostty.org/) provides the best experience with ox's TUI -- true-color support, fast rendering, and correct Unicode handling.

```bash
brew install --cask ghostty
```

## Auto-Updates

Ox checks for updates in the background while the TUI is running. When an update is available, you'll see a notification. You can also check manually:

```bash
ox upgrade
```

## Next Steps

- [Usage](usage.md) -- Learn the different ways to start and monitor tasks
- [Recommended Workflow](workflow.md) -- The async PR workflow for maximum productivity
- [TUI Guide](tui.md) -- Master the terminal UI, keyboard shortcuts, and themes
- [Configuration](configuration.md) -- Customize ox for your project
