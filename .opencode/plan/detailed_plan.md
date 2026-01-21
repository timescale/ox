# Hermes CLI - Detailed Implementation Plan

## Command: `hermes branch "<prompt>"`

### Overview

Creates a new feature branch with an isolated database fork for development work, then launches a sandboxed Claude Code agent to work on the task.

### Prerequisites

- `claude` CLI installed locally
- `tiger` CLI installed and authenticated
- `hermes-sandbox` Docker image built and available locally
- `.env` exists in project root (will be copied to worktree)
- `.hermes/.env` exists (user-provided env vars for Docker container, e.g., API keys)

---

## Implementation Steps

### 1. CLI Argument Parsing

**Input:** `hermes branch "<prompt>" [--service-id <id>]`

- Parse `process.argv` for:
  - `branch` subcommand (required)
  - `<prompt>` - natural language description (required)
  - `--service-id <id>` - optional database service ID to fork (defaults to tiger's current default)
- On invalid input, print usage and exit with code 1:
  ```
  Usage: hermes branch "<prompt>" [--service-id <id>]
  ```

---

### 2. Generate Branch Name via Claude Code

**Command:**
```bash
claude --model haiku --print "Generate a git branch name for the following task: <prompt>

Requirements:
- Output ONLY the branch name, nothing else
- Lowercase letters and hyphens only
- No special characters, spaces, or underscores
- Keep it concise (2-4 words max)
- Example format: add-user-auth, fix-login-bug"
```

**Validation:**
- Regex: `/^[a-z][a-z0-9-]*[a-z0-9]$/` (starts with letter, ends with alphanumeric)
- Max length: 50 characters
- Check branch doesn't exist: `git branch --list <name>` returns empty

**Retry Logic:**
- If invalid or exists, retry up to 3 times total
- On retry, append to prompt: "The name '<previous>' is invalid or already exists. Suggest a different name."
- If all retries fail, exit with error:
  ```
  Error: Failed to generate valid branch name after 3 attempts
  ```

**Output:** `Generating branch name...` → `Branch name: <name>`

---

### 3. Create Git Worktree

**Command:**
```bash
git worktree add .hermes/worktrees/<branch-name> -b <branch-name> main
```

**Details:**
- Creates new branch `<branch-name>` from `main`
- Checks out the branch into `.hermes/worktrees/<branch-name>`

**Output:** `Creating worktree at .hermes/worktrees/<branch-name>...`

**Errors:**
- If worktree path already exists, fail with clear message
- If `main` branch doesn't exist, fail with clear message

---

### 4. Ensure `.gitignore` Entry

**Logic:**
1. Read `.gitignore` from project root
2. Check if `.hermes/` or `.hermes` line exists
3. If not present, append `.hermes/` on a new line

**Output:** (silent unless adding) `Added .hermes/ to .gitignore`

---

### 5. Fork Database

**Command:**
```bash
# If --service-id provided:
tiger svc fork <service-id> --now --name <branch-name> --with-password -o json

# Otherwise (use default service):
tiger svc fork --now --name <branch-name> --with-password -o json
```

**Wait:** The command waits by default (up to 30 minutes) for the fork to complete.

**Parse JSON Output:**
```typescript
interface ForkResult {
  service_id: string;
  name: string;
  connection_string: string;  // This is what we need
  host: string;
  port: number;
  database: string;
  role: string;
  password: string;
}
```

**Output:**
```
Forking database (this may take a few minutes)...
Database fork created: <fork-name> (service ID: <service-id>)
```

**Errors:**
- Fork name conflict: "Error: A service named '<name>' already exists"
- Authentication: "Error: tiger CLI not authenticated. Run 'tiger auth login'"

---

### 6. Copy and Update `.env`

**Steps:**
1. Read `<project-root>/.env`
2. If `DATABASE_URL=` line exists, replace the entire line
3. If not, append `DATABASE_URL=<connection_string>`
4. Write to `.hermes/worktrees/<branch-name>/.env`

**Connection String Format:**
```
postgresql://tsdbadmin:<password>@<host>:<port>/tsdb?sslmode=require
```

**Output:** `Configured .env with database connection`

**Errors:**
- If `.env` doesn't exist in project root: "Error: No .env file found in project root"

---

### 7. Start Docker Container

**Command:**
```bash
docker run -d \
  --name hermes-<branch-name> \
  --env-file .hermes/.env \
  -v <absolute-path>/.hermes/worktrees/<branch-name>:/app \
  -w /app \
  hermes-sandbox \
  claude "<prompt>"
```

**Details:**
- `-d` runs detached
- `--name` allows easy management (`docker logs`, `docker stop`, etc.)
- `--env-file` loads user's API keys and config from `.hermes/.env`
- Volume mount gives container access to the worktree
- Working directory set to `/app`

**Output:**
```
Starting agent container...
Container started: hermes-<branch-name>
```

**Errors:**
- Image not found: "Error: hermes-sandbox image not found. Build it first."
- Container name conflict: "Error: Container hermes-<branch-name> already exists"
- `.hermes/.env` missing: "Error: .hermes/.env not found. Create it with required environment variables."

---

## Final Output Summary

On success, print:
```
Branch: <branch-name>
Worktree: .hermes/worktrees/<branch-name>
Database: <fork-name> (forked from <source-name>)
Container: hermes-<branch-name>

To view agent logs:
  docker logs -f hermes-<branch-name>

To stop the agent:
  docker stop hermes-<branch-name>
```

---

## Error Handling Strategy

- **Approach:** Fail fast, no automatic cleanup
- **Each step:** Print what's happening before executing
- **On failure:** Print clear error message with context, exit code 1
- **Partial state:** Left for manual debugging (worktree, fork may exist)

---

## Code Structure

```typescript
// index.ts

async function main() {
  const args = parseArgs(process.argv.slice(2));
  
  if (args.command !== 'branch' || !args.prompt) {
    printUsage();
    process.exit(1);
  }

  console.log('Generating branch name...');
  const branchName = await generateBranchName(args.prompt);
  console.log(`Branch name: ${branchName}`);

  console.log(`Creating worktree at .hermes/worktrees/${branchName}...`);
  await createWorktree(branchName);

  await ensureGitignore();

  console.log('Forking database (this may take a few minutes)...');
  const forkResult = await forkDatabase(branchName, args.serviceId);
  console.log(`Database fork created: ${forkResult.name}`);

  console.log('Configuring environment...');
  await setupEnvFile(branchName, forkResult.connection_string);

  console.log('Starting agent container...');
  await startContainer(branchName, args.prompt);

  printSummary(branchName, forkResult);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
```

---

## Helper Functions

### `parseArgs(argv: string[])`
Parse command, prompt, and optional flags.

### `generateBranchName(prompt: string): Promise<string>`
Shell out to `claude`, validate, retry logic.

### `createWorktree(branchName: string): Promise<void>`
Run `git worktree add` command.

### `ensureGitignore(): Promise<void>`
Read/update `.gitignore` if needed.

### `forkDatabase(branchName: string, serviceId?: string): Promise<ForkResult>`
Run `tiger svc fork`, parse JSON output.

### `setupEnvFile(branchName: string, connectionString: string): Promise<void>`
Copy and modify `.env` file.

### `startContainer(branchName: string, prompt: string): Promise<string>`
Run `docker run`, return container ID.

### `printSummary(branchName: string, forkResult: ForkResult): void`
Print final success message with helpful commands.
