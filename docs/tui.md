# TUI Guide

Ox includes a rich terminal UI for managing sessions, writing prompts, and configuring settings. This page covers all TUI views, keyboard shortcuts, the command palette, slash commands, and themes.

## Launching the TUI

```bash
ox              # open TUI at the prompt screen
ox -i           # open TUI (same as above)
ox -i "prompt"  # open TUI and auto-submit a prompt
```

## Views

The TUI has several views. Navigate between them with keyboard shortcuts or the command palette.

### Prompt Screen

The main input area where you write task descriptions for the agent.

<!-- screenshot: docs/assets/prompt-screen.gif -->

**Elements:**
- **Text area** -- Multi-line input with the placeholder "Ask anything... Type '/' for commands"
- **Agent badge** -- Shows the selected agent with a color indicator
- **Model badge** -- Shows the selected model
- **Mode badge** -- Shows `[async]`, `[plan]`, or nothing (interactive is the default when unlabeled in TUI)
- **Provider badge** -- Shows `[docker]` or `[cloud]`
- **Mount badge** -- Shows `[mount]` when mount mode is enabled
- **Readiness indicators** -- Shows Docker, image, and auth status
- **Action bar** -- Shows available actions: Submit (`Enter`), Sessions (`ctrl+l`), Commands (`ctrl+p`)

**Keyboard shortcuts:**

| Key | Action |
|-----|--------|
| `Enter` | Submit the prompt and start a task |
| `ctrl+Enter` / `shift+Enter` | Insert a newline |
| `Tab` | Cycle through agents |
| `Shift+Tab` | Cycle agent mode (async / interactive / plan) |
| `ctrl+space` | Open model selector |
| `ctrl+d` | Toggle mount mode |
| `ctrl+e` | Toggle sandbox provider (Docker / Cloud) |
| `ctrl+l` | Go to sessions list |
| `ctrl+n` | Reset to a fresh new prompt |
| `ctrl+t` | Open theme picker |
| `ctrl+s` | Launch a shell in a sandbox |
| `ctrl+p` | Open command palette |
| `Up/Down` | Navigate prompt history (when cursor is at start/end) |
| `/` | Open slash command popover (when input is empty) |

### Sessions List

Browse and manage all sessions across providers.

<!-- screenshot: docs/assets/sessions-list.gif -->

**Keyboard shortcuts:**

| Key | Action |
|-----|--------|
| `Up` / `ctrl+k` | Move selection up |
| `Down` / `ctrl+j` | Move selection down |
| `Enter` | Open session detail |
| `Tab` | Cycle filter: All / Running / Completed |
| `Shift+Tab` | Toggle scope: Local repo / Global |
| `ctrl+a` | Attach to running session |
| `ctrl+s` | Shell into running session |
| `ctrl+r` | Resume stopped session |
| `ctrl+x` | Stop running session |
| `ctrl+d` / `Delete` | Delete session |
| `ctrl+g` | Switch local git branch to session's branch |
| `ctrl+o` | Open PR in browser |
| `ctrl+n` | New task (go to prompt) |
| `ctrl+e` | Manage resources |
| `f2` | Refresh sessions and PR cache |
| `Escape` | Back to prompt screen |
| `ctrl+p` | Open command palette |
| Type `a-z`, `0-9`, etc. | Filter sessions by name |
| `Backspace` | Clear filter text |

### Session Detail

Detailed view of a single session with live logs.

**Keyboard shortcuts:**

| Key | Action |
|-----|--------|
| `ctrl+a` | Attach to running session |
| `ctrl+s` | Shell into running session |
| `ctrl+r` | Resume stopped session |
| `ctrl+x` | Stop running session |
| `ctrl+d` / `Delete` | Delete session |
| `ctrl+g` | Switch local git branch |
| `ctrl+o` | Open PR in browser |
| `ctrl+b` | Open app URL in browser |
| `ctrl+l` | Back to sessions list |
| `ctrl+n` | New task |
| `ctrl+e` | Manage resources |
| `Escape` | Back to sessions list |
| `ctrl+p` | Open command palette |

### Resources List

Manage sandbox images, volumes, and snapshots.

**Keyboard shortcuts:**

| Key | Action |
|-----|--------|
| `Up` / `ctrl+k` | Move selection up |
| `Down` / `ctrl+j` | Move selection down |
| `Tab` | Cycle filter: All / Containers / Snapshots / Volumes / Images |
| `ctrl+d` / `Delete` | Delete selected resource |
| `ctrl+x` | Clean up old and orphaned resources |
| `f2` | Refresh resource list |
| `ctrl+n` | New task |
| `ctrl+l` | Go to sessions list |
| `Escape` | Back to previous screen |
| `ctrl+p` | Open command palette |

### Other Views

- **Config Wizard** -- Stepped configuration flow (launched by `ox config` or `/config`)
- **Docker Setup** -- Docker installation guidance (shown when Docker is missing)
- **Cloud Setup** -- Deno Deploy cloud provider setup flow
- **Starting Screen** -- Progress display while a session is being created (includes Docker image pull progress)

## Command Palette

Press `ctrl+p` from any view to open the command palette -- a fuzzy-searchable list of all available actions.

<!-- screenshot: docs/assets/command-palette.gif -->

The palette shows each command's name, description, keyboard shortcut, and category. Type to filter, use arrow keys to navigate, and press `Enter` to execute.

Available commands vary by view. For example, session-specific actions (attach, stop, delete) only appear when viewing sessions.

## Slash Commands

Type `/` in an empty prompt to open the slash command popover. Slash commands are quick shortcuts for common actions:

| Command | Action |
|---------|--------|
| `/agent` | Switch to the next agent |
| `/model` | Open the model selector |
| `/config` | Open the configuration wizard |
| `/setup-db` | Configure the Tiger database service |
| `/theme` | Open the theme picker |
| `/sessions` | Go to sessions list |
| `/resources` | Manage sandbox resources |
| `/mount` | Toggle mount mode |
| `/docker` | Switch to Docker provider |
| `/cloud` | Switch to Cloud provider |
| `/provider` | Toggle between providers |
| `/async` | Switch to async mode |
| `/interactive` | Switch to interactive mode |
| `/plan` | Switch to plan mode |
| `/feedback` | Send feedback to the ox team |

<!-- screenshot: docs/assets/slash-commands.gif -->

Type a partial name to fuzzy-filter the list. Press `Enter` to execute or `Escape` to dismiss.

## Themes

Ox ships with 33 built-in color themes. Change the theme with `/theme` or `ctrl+t` from the prompt screen.

<!-- screenshot: docs/assets/theme-picker.gif -->

Available themes:

| | | | |
|---|---|---|---|
| aura | ayu | carbonfox | catppuccin |
| catppuccin-frappe | catppuccin-macchiato | cobalt2 | cursor |
| dracula | everforest | flexoki | github |
| gruvbox | kanagawa | lucent-orng | material |
| matrix | mercury | monokai | nightowl |
| nord | one-dark | opencode | orng |
| osaka-jade | palenight | rosepine | solarized |
| synthwave84 | tokyonight | vercel | vesper |
| zenburn | | | |

Set a default theme in config:

```bash
ox config set themeName tokyonight
```

View all theme colors as swatches:

```bash
ox colors
```

## Desktop Notifications

When an async session completes, ox sends a desktop notification (on supported systems). This lets you fire off tasks and return to them when ready.

## Feedback

Send feedback directly from the TUI with the `/feedback` slash command or from the command palette. You can also use the CLI:

```bash
ox feedback "Love the TUI, but the theme picker could show previews"
```

## Next Steps

- [Usage](usage.md) -- Starting tasks in TUI mode vs CLI
- [Session Management](sessions.md) -- Session operations from the TUI
- [Configuration](configuration.md) -- Config wizard and theme settings
