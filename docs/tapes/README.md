# VHS Tape Files

This directory contains [VHS](https://github.com/charmbracelet/vhs) tape files for generating GIF screenshots of the ox TUI. The generated GIFs are saved to `docs/images/`.

## Prerequisites

Install VHS and its dependencies:

- [Go](https://go.dev/dl/) (1.21+)
- [ffmpeg](https://ffmpeg.org/)
- [ttyd](https://github.com/tsl0922/ttyd)
- [Chromium](https://www.chromium.org/) (or Chrome -- vhs uses a headless browser for rendering)

```bash
# macOS
brew install vhs

# Or install via Go
go install github.com/charmbracelet/vhs@latest

# Ensure ffmpeg and ttyd are on your PATH
brew install ffmpeg ttyd
```

## Generating GIFs

Run all tape files:

```bash
./docs/tapes/generate.sh
```

Or run a single tape:

```bash
vhs docs/tapes/prompt-screen.tape
```

Generated GIFs are written to `docs/images/`.

## Tape Files

| File | Output | Description |
|------|--------|-------------|
| `prompt-screen.tape` | `prompt-screen.gif` | The main prompt screen with agent/model badges |
| `sessions-list.tape` | `sessions-list.gif` | The sessions list view with running sessions |
| `slash-commands.tape` | `slash-commands.gif` | The slash command popover on the prompt screen |
| `start-task.tape` | `start-task.gif` | Starting a task from the CLI in follow mode |
| `theme-picker.tape` | `theme-picker.gif` | The theme picker with live preview |
| `multi-agent-sessions.tape` | `multi-agent-sessions.gif` | Three interactive sessions, one per agent, with detach and reattach flow |

## Notes

- Tape files assume `ox` is available on your PATH or in the current directory
- Some tapes require Docker to be running (for sessions list to show real data)
- The `generate.sh` script runs all tapes sequentially
- Edit tape timing (`Sleep` values) if animations are too fast or slow
