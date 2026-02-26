# ox

A CLI tool to run AI coding agents in isolated sandboxes per task.

## Installation

### Quick Install (Recommended)

```bash
curl -fsSL https://get.ox.build | sh
```

After installation, restart your shell or run `source ~/.zshrc` (or `source ~/.bashrc`) to update your PATH.

Re-run the above command at any time to update to the latest version.

### Recommended Terminal

While any terminal should be usable, we recommend [Ghostty](https://ghostty.org/) for the best TUI experience:

```bash
brew install --cask ghostty
```

### Source Installation (Developers)

If you prefer to clone the repo and run from source:

```bash
git clone https://github.com/timescale/ox.git
cd ox
./bun i && ./bun link
source ~/.zshrc # or restart your shell
```

## Usage

```bash
cd myproject
# Full TUI experience
ox

# Or just run a single task:
ox "Build a new feature that ..."
```
