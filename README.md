# hermes

A CLI tool to run AI coding agents in isolated sandboxes per task.

## Installation

### Quick Install (Recommended)

Requires the [GitHub CLI](https://cli.github.com/) (`gh`) to be installed and authenticated:

```bash
# Install gh if you don't have it
brew install gh

# Authenticate with GitHub (if not already)
gh auth login

# Install hermes
gh api repos/timescale/hermes/contents/install.sh -H "Accept: application/vnd.github.raw" | bash
```

The installer will prompt you to choose between:
1. **Download pre-compiled binary** - Fast, no dependencies
2. **Clone and link with bun** - For developers who want to modify the source

### Manual Installation (Developers)

If you prefer to clone the repo directly:

```bash
git clone git@github.com:timescale/hermes.git
cd hermes
./bun i && ./bun link
source ~/.zshrc # or restart your shell
```

### Recommended Terminal

While any terminal should be usable, we recommend [Ghostty](https://ghostty.org/) for the best TUI experience:

```bash
brew install --cask ghostty
```

## Usage

```bash
cd myproject
# Full TUI experience
hermes

# Or just run a single task:
hermes "Build a new feature that ..."
```

## Updates

### Binary Installation

Re-run the installer to get the latest version:

```bash
gh api repos/timescale/hermes/contents/install.sh -H "Accept: application/vnd.github.raw" | bash
```

### Source Installation

Pull the latest code:

```bash
cd hermes # wherever you cloned it
git pull
./bun i # in case deps changed
```

---

## Demo Workflow

Run `hermes "<prompt>"` and hermes will:

1. come up with a branch name (Ask claude based on prompt)
2. create a git worktree with the branch name
3. fork your tiger service and name it with the branch name
4. run a docker container with git worktree mounted + credentials/config
5. run claude code in the container with the prompt instructed to create a PR when finished

## Other CLI commands

- list running agents
- attach/detach from agent to check on progress
- ssh into sandbox
- kill agent (cleans up worktree, fork, and sandbox)

- need a way to check on agent progress and/or get notifications for input needed or success

## Platform Asks

- **FAST**, reliable forking
- more forks allowed
- cheap forks (no backups/PITR)

eventually:

- VMs of some sort = hosted agent sandboxes
- Forkable volumes = set up your agents' dev environment and fork

## Ideas

- We _eventually_ want the agent sandboxes running in the cloud so you can close your laptop and go to the coffee shop with it still working
- The agent sandbox should have MPC servers configured (e.g. pg-aiguide); some by default, others customized?
- Using forkable volumes (eventually) would be ideal for setting up the agents' dev environment
- In addition to passing the prompt to the cli command, you could pass it a github issue or linear ticket, etc.
- Queue up N tasks and have M (M < N) agent sandboxes working the queue?
- When agent sandbox is in the cloud, we don't really need git worktrees anymore, just normal branches.
