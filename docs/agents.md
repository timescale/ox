# Agents

Ox supports multiple AI coding agents. Each agent runs inside the sandbox and works on your code autonomously. This page covers the supported agents, how to select and configure them, and model options.

## Supported Agents

| Agent | Description |
|-------|-------------|
| **Claude Code** | Anthropic's coding agent CLI. Supports Anthropic models (Opus, Sonnet, Haiku). |
| **OpenCode** | Open-source coding agent CLI with support for multiple model providers (Anthropic, OpenAI, Google, and more). |
| **Codex** | OpenAI's coding agent CLI. Supports OpenAI models and ChatGPT. |

We're looking to support more agents. [Vote on or suggest agents here](https://github.com/timescale/ox/milestone/1), or submit a PR.

## Selecting an Agent

### Per-Task (CLI)

```bash
ox --agent claude "Implement the new dashboard"
ox --agent opencode "Add test coverage"
ox --agent codex "Refactor the auth module"
```

### Default (Config)

```bash
ox config set agent claude
```

Or in `.ox/config.yml`:

```yaml
agent: opencode
```

### TUI

On the prompt screen, press `Tab` to cycle through available agents, or type `/agent`.

## Authentication

Each agent requires its own authentication. Ox checks credentials at startup and prompts you to log in if needed.

### Claude Code

Claude Code uses Anthropic's OAuth flow. When prompted, ox opens a browser for you to authorize. Credentials are stored locally and synced to sandboxes automatically.

You can check auth status:

```bash
ox auth check claude
ox auth login claude
```

### OpenCode

OpenCode supports multiple authentication methods depending on the model provider:
- **API keys** for direct provider access (Anthropic, OpenAI, etc.)
- **OAuth** for certain providers

Configure via the agent's own settings or through `ox auth`.

### Codex

Codex uses OpenAI authentication (API key or ChatGPT OAuth). When prompted, ox guides you through the setup.
ox's sandbox image installs system `bubblewrap`, so Codex can use `/usr/bin/bwrap`
without printing its vendored-bubblewrap fallback warning at session startup.

```bash
ox auth check codex
ox auth login codex
```

### GitHub

Regardless of agent, ox needs GitHub authentication for cloning repos and creating PRs. Ox uses the GitHub device flow:

```bash
ox auth check gh
ox auth login gh
```

The config wizard (`ox config`) handles all authentication setup in one flow.

## Model Selection

### Per-Task

```bash
ox --model opus "Design the database schema"
ox --model sonnet "Fix the login bug"
```

### Default Model

```bash
ox config set model sonnet
```

### Per-Agent Defaults

Set different default models for each agent:

```yaml
# .ox/config.yml
agentModels:
  claude: claude-sonnet-4-6
  opencode: anthropic/claude-sonnet-4-6
  codex: gpt-5.4
```

### TUI

On the prompt screen, press `ctrl+space` to open the model selector, or type `/model`.

## Agent Modes

Agent modes control how the agent runs inside the sandbox. See [Usage](usage.md#agent-modes) for the full explanation.

| Mode | Description | Best For |
|------|-------------|----------|
| `async` | Background execution, no TTY | Fire-and-forget tasks, parallel work |
| `interactive` | Live tmux session with TTY | Pair programming, guided tasks |
| `plan` | Read-only interactive session | Code review, analysis |

Set the default mode:

```bash
ox config set agentMode async
```

Or per-task:

```bash
ox -M interactive "Complex refactoring task"
ox -M plan "Review the security of the auth flow"
```

In the TUI, press `Shift+Tab` to cycle modes, or use `/async`, `/interactive`, `/plan`. See [TUI Guide](tui.md) for all keyboard shortcuts.

## Agent CLI Pass-Through

Run any agent CLI directly inside a sandbox without ox's session management (see also [CLI Reference](cli-reference.md)):

```bash
ox claude --help
ox opencode --version
ox codex "Quick question about the codebase"
```

These commands launch a one-off sandbox, run the agent CLI with your arguments, and clean up when done. Useful for quick interactions or agent-specific features not exposed by ox.

Similarly, you can run the GitHub CLI inside a sandbox:

```bash
ox gh pr list
ox gh issue create --title "Bug report"
```

## Next Steps

- [Usage](usage.md) -- How agents run in different invocation modes
- [Configuration](configuration.md) -- All agent-related config keys
- [Recommended Workflow](workflow.md) -- Using agents in the async PR workflow
