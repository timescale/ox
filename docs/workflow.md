# Recommended Workflow

This guide describes the recommended async workflow for using ox with GitHub pull requests. The core idea: **submit tasks, let agents work in the background, review PRs, and iterate.**

## The Async PR Workflow

### 1. Submit a Task

Start a task in async mode (the default). Ox creates a sandbox, generates a branch, and launches the agent:

```bash
ox "Add rate limiting to the API endpoints"
```

You can submit multiple tasks in parallel -- each gets its own isolated sandbox and branch:

```bash
ox "Add rate limiting to the API endpoints"
ox "Write unit tests for the user service"
ox "Fix the memory leak in the WebSocket handler"
```

### 2. Monitor Progress

Check on your running sessions at any time:

```bash
# Quick status check
ox sessions

# Open the TUI session manager
ox -i
```

In the TUI sessions list, you can see:
- Session status (running, completed, failed)
- CPU and memory usage (Docker sessions)
- PR links (once the agent creates one)
- Which agent and model are being used

Ox sends a **desktop notification** when an async session completes, so you don't need to keep checking.

### 3. Review the PR

When the agent finishes, it typically creates a pull request on GitHub. You can find the PR link in:

- The TUI sessions list (PR column)
- The session detail view (`ctrl+o` to open in browser)
- The CLI: `ox session info <session>`

Review the PR on GitHub as you would any other code review. You can find the full list of TUI shortcuts in the [TUI Guide](tui.md). You can also use ox to get a second opinion:

```bash
ox -M plan "Review the changes in PR #42 for security issues"
```

### 4. Request Changes (Resume)

If the PR needs changes, resume the session with feedback:

```bash
ox resume <session> "The rate limiter should use a sliding window instead of fixed buckets"
```

Or from the TUI: select the session, press `ctrl+r`, and type your feedback in the prompt screen.

The agent picks up where it left off -- same branch, same sandbox state -- and addresses your feedback. It will update the existing PR with new commits.

### 5. Merge and Clean Up

Once the PR is approved:

1. **Merge** the PR on GitHub
2. **Delete** the session to free resources:

```bash
ox session rm <session>
```

Or from the TUI: select the session and press `ctrl+d`.

To bulk clean up old sessions:

```bash
ox session clean       # remove stopped containers
ox session clean --all # remove everything including running
```

## Tips

### Work in Parallel

The biggest productivity gain comes from running multiple agents simultaneously. While one agent works on feature A, start another on feature B. Each gets a fully isolated environment.

### Use Plan Mode for Reviews

Before merging a PR, you can ask an agent to review it in plan mode. The agent can read and analyze the code but won't make changes:

```bash
ox -M plan "Review the changes on branch feat/rate-limiting for correctness and edge cases"
```

### Follow Mode for Quick Tasks

For small, fast tasks where you want to see the result immediately:

```bash
ox -f "Fix the typo in the README"
```

The output streams to your terminal and the process exits when done.

### Interactive Mode for Collaboration

When you want to work alongside the agent in real time -- for example, during a complex refactor where you want to guide the agent step by step:

```bash
ox -i "Refactor the payment processing module"
```

You'll be dropped into a live terminal session with the agent. Use `ctrl+\` to detach and `ctrl+a` to reattach from the session detail view.

### Check Agent Logs

If a session fails or produces unexpected results, check the logs:

```bash
ox session logs <session>
ox session logs -f <session>  # follow in real time
```

### Shell into a Running Session

Need to inspect the sandbox environment, run tests, or check file state?

```bash
ox session shell <session>
```

This opens a bash shell inside the running container alongside the agent.

## Workflow Diagram

```
  ox "task"          ox "task"         ox "task"
      |                  |                 |
      v                  v                 v
  [sandbox 1]       [sandbox 2]       [sandbox 3]
      |                  |                 |
      v                  v                 v
  [PR #1]            [PR #2]           [PR #3]
      |                  |                 |
   review             review            review
      |                  |                 |
  ox resume?         merge + rm        ox resume?
      |                                    |
  [updated PR]                         [updated PR]
      |                                    |
   merge + rm                           merge + rm
```

## Next Steps

- [Session Management](sessions.md) -- Detailed guide to session lifecycle and commands
- [Agents](agents.md) -- Choosing and configuring agents and models
- [TUI Guide](tui.md) -- Navigate the TUI efficiently
