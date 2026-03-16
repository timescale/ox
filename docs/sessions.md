# Session Management

A session represents a single agent task running in an isolated sandbox. This page covers the full session lifecycle and all management operations.

## Session Lifecycle

```
created  -->  running  -->  completed / failed
                 |
                 v
              stopped  -->  resumed (running)
```

- **Running** -- The agent is actively working in the sandbox
- **Completed** -- The agent finished successfully
- **Failed** -- The agent exited with an error
- **Stopped** -- Manually stopped by the user; can be resumed

## Listing Sessions

### CLI

```bash
# Table of running sessions
ox sessions

# Include stopped sessions
ox sessions --all

# JSON output (for scripting)
ox sessions -o json

# YAML output
ox sessions -o yaml

# Open the TUI session list
ox sessions -o tui
```

`ox session ps`, `ox session list`, and `ox session ls` are all aliases for `ox sessions`.

### TUI

Press `ctrl+l` from the prompt screen to open the sessions list. The list shows:

| Column | Description |
|--------|-------------|
| Status | Color-coded icon (running, completed, failed, stopped) |
| Provider | `D` for Docker, `C` for Cloud |
| Name | Session name (derived from the generated branch) |
| Status | Human-readable status text |
| CPU | Current CPU usage (Docker sessions only) |
| Memory | Current memory usage (Docker sessions only) |
| PR | Pull request link, if available |
| Agent | Which agent is running |
| Repo | Repository name |
| Created | Relative timestamp |

Use the filter bar to search by name, filter by status (All / Running / Completed), or toggle scope (Local repo / Global). See [TUI Guide](tui.md) for keyboard shortcuts.

## Session Details

### CLI

```bash
ox session info <session>
ox session info -o json <session>
```

### TUI

Select a session in the list and press `Enter` to view its detail panel. On wide terminals, the detail panel appears as a split view alongside the list.

The detail view shows the session's full metadata: name, status, agent, model, prompt, branch, repository, timestamps, and proxied URLs (if configured).

## Session Logs

```bash
# Print logs
ox session logs <session>

# Follow logs in real time
ox session logs -f <session>

# Show last N lines
ox session logs --tail 50 <session>
```

In the TUI, the session detail view includes a live-scrolling log viewer.

## Attaching to Sessions

Attach to a running interactive session's terminal:

```bash
ox session attach <session>
```

In the TUI, select a running session and press `ctrl+a`.

When attached, you're in a tmux session inside the sandbox alongside the agent. Press `ctrl+\` to detach and return to the TUI.

Attaching is only available for sessions running in **interactive** or **plan** mode.

## Resuming Sessions

Resume a stopped or completed session to continue the work:

```bash
# Resume with a new prompt
ox resume <session> "Continue by adding error handling"

# Resume without a new prompt (agent continues from where it left off)
ox resume <session>

# Resume in detached mode
ox resume --detach <session>
```

In the TUI, select a stopped session and press `ctrl+r`. This takes you to the prompt screen where you can type additional instructions before resuming.

When resuming, ox:
1. Takes a snapshot of the stopped container's filesystem
2. Creates a new container from that snapshot
3. Launches the agent with `--continue` and your new prompt (if provided)

## Stopping Sessions

```bash
ox session stop <session>
```

In the TUI, press `ctrl+x` on a running session.

Stopping preserves the container state so the session can be resumed later.

## Removing Sessions

```bash
# Remove a single session
ox session rm <session>

# Aliases: remove, delete
ox session remove <session>
ox session delete <session>
```

In the TUI, press `ctrl+d` or `Delete` on the selected session. You'll be asked to confirm.

Removing a session deletes the container and its data. This cannot be undone.

## Bulk Cleanup

```bash
# Remove all stopped containers
ox session clean

# Remove everything, including running containers
ox session clean --all
```

For sandbox resources (images, volumes, snapshots) -- see [CLI Reference](cli-reference.md) for full details:

```bash
ox resources clean
ox resources list
```

## Session URLs

If you've configured `appPort` in your [config](configuration.md), ox sets up HTTPS reverse proxying to your sandbox:

```bash
ox session urls <session>
```

This prints the proxied URLs (e.g., `https://<session>.ox.local`). In the TUI detail view, press `ctrl+b` to open the app URL in your browser.

See [Sandbox Providers](sandbox-providers.md#port-forwarding) for details on port forwarding configuration.

## Shelling into Sessions

Open a bash shell inside a running session's sandbox:

```bash
ox session shell <session>
```

In the TUI, press `ctrl+s` on a running session.

This is useful for inspecting the sandbox environment, running tests, or checking file state while the agent is working.

## Git Branch Switching

From the TUI sessions list or detail view, press `ctrl+g` to switch your local git branch to match the selected session's branch. This is useful for reviewing changes locally.

## Identifying Sessions

In all CLI commands, `<session>` accepts either:
- The session **name** (e.g., `feat-add-rate-limiting`)
- The session **ID** (container ID or cloud sandbox ID)

Tab completion is supported when [shell completions](getting-started.md#shell-completions) are configured.

## Next Steps

- [Recommended Workflow](workflow.md) -- How sessions fit into the async PR workflow
- [TUI Guide](tui.md) -- Keyboard shortcuts for managing sessions in the TUI
- [CLI Reference](cli-reference.md) -- Complete command reference
