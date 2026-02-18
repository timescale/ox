# Sandbox Abstraction Layer: Docker + Deno Cloud

## Goal

Introduce a `SandboxProvider` interface that abstracts sandbox lifecycle operations,
refactor existing Docker code to implement it, and add a new Deno Cloud implementation
backed by the `@deno/sandbox` SDK. All consumer code (sessions, commands, UI) will
operate against this interface, with the implementation selected per-session based on
user config.

## Architecture

```
                    ┌─────────────────────┐
                    │  sessions.tsx / TUI  │
                    └────────┬────────────┘
                             │
                    ┌────────▼────────────┐
                    │  SandboxProvider     │  (interface)
                    │  interface           │
                    └────────┬────────────┘
                     ┌───────┴────────┐
              ┌──────▼──────┐  ┌──────▼──────┐
              │   Docker    │  │    Deno     │
              │  Provider   │  │   Cloud     │
              │             │  │  Provider   │
              └─────────────┘  └─────────────┘
                                     │
                              ┌──────▼──────┐
                              │ @deno/sandbox│
                              │    SDK      │
                              └─────────────┘
```

---

## Key Design Decisions

1. **Metadata storage**: Use Deno Sandbox labels for critical identifiers
   (`hermes.managed`, `hermes.name`, `hermes.agent`, `hermes.repo`) for API-side
   filtering, and store **all** session metadata in a local SQLite database
   (`~/.config/hermes/sessions.db`) keyed by sandbox ID.

2. **Interactive access**: Use SSH (`sandbox.exposeSsh()`) for attach/shell
   operations on cloud sandboxes -- closest to the Docker attach experience.

3. **Provider config**: Default provider set in user/project `config.yml`
   (`sandboxProvider: 'docker' | 'cloud'`), overridable per-session via a toggle
   on the prompt screen.

4. **Base snapshot**: Pre-install all tools (Claude Code, gh, tiger CLI, opencode)
   into a reusable Deno Sandbox snapshot (`hermes-base-{version}`). This mirrors the
   Docker image build step. A TUI flow creates the snapshot on first cloud use.

5. **Session persistence**: Use Deno volumes for the working directory. On
   stop/complete, snapshot the volume for resume. On resume, create a new volume from
   the snapshot and boot a new sandbox.

6. **Deno Sandbox limits**: 30-minute max lifetime per sandbox, 5 concurrent
   sandboxes per org. Handle concurrency errors clearly. Snapshot volumes before
   timeout for resumability.

---

## Phase 1: Foundation -- Interface & Types

### New file: `src/services/sandbox/types.ts`

Define the provider-agnostic interface and shared types.

```typescript
export type SandboxProviderType = 'docker' | 'cloud';

// Unified session metadata (provider-agnostic)
export interface HermesSession {
  id: string;                      // containerId or Deno sandbox ID
  name: string;                    // human-readable session name
  provider: SandboxProviderType;
  status: 'running' | 'stopped' | 'exited' | 'unknown';
  exitCode?: number;
  agent: AgentType;
  model: string;
  prompt: string;
  branch: string;
  repo: string;
  created: string;                 // ISO timestamp
  mountDir?: string;               // Docker mount mode only
  region?: string;                 // cloud only
  containerName?: string;          // Docker only
  volumeSlug?: string;             // cloud only
  snapshotSlug?: string;           // cloud only (for resume)
}

// Options for creating a new sandbox
export interface CreateSandboxOptions {
  name: string;
  branchName: string;
  prompt: string;
  repoInfo: RepoInfo;
  agent: AgentType;
  model: string;
  interactive: boolean;
  envVars: Record<string, string>;
  mountDir?: string;               // Docker-only: local dir mount
  agentArgs?: string[];
  initScript?: string;
  overlayMounts?: string[];
}

// Options for resuming a stopped session
export interface ResumeSandboxOptions {
  mode: 'interactive' | 'detached' | 'shell';
  prompt?: string;
  model?: string;
  agentArgs?: string[];
}

// Container resource stats
export interface SandboxStats {
  cpuPercent: number;
  memUsage: string;
  memLimit: string;
  memPercent: number;
}

// Async log stream
export interface LogStream {
  [Symbol.asyncIterator](): AsyncIterableIterator<string>;
  stop(): void;
}

// The main provider interface
export interface SandboxProvider {
  readonly type: SandboxProviderType;

  // Setup -- ensure runtime/image/snapshot is ready
  ensureReady(): Promise<void>;

  // Lifecycle
  create(options: CreateSandboxOptions): Promise<HermesSession>;
  resume(sessionId: string, options: ResumeSandboxOptions): Promise<HermesSession>;

  // Session management
  list(): Promise<HermesSession[]>;
  get(sessionId: string): Promise<HermesSession | null>;
  remove(sessionId: string): Promise<void>;
  stop(sessionId: string): Promise<void>;

  // Interactive access
  attach(sessionId: string): Promise<void>;
  shell(sessionId: string): Promise<void>;

  // Logs
  getLogs(sessionId: string, tail?: number): Promise<string>;
  streamLogs(sessionId: string): LogStream;

  // Stats (optional -- cloud does not support CPU/mem stats)
  getStats?(sessionIds: string[]): Promise<Map<string, SandboxStats>>;
}
```

### Modified: `src/services/config.ts`

Add new fields to `HermesConfig`:

```typescript
interface HermesConfig {
  // ... existing fields ...
  sandboxProvider?: 'docker' | 'cloud';  // default: 'docker'
  cloudRegion?: 'ams' | 'ord';          // default region for cloud sandboxes
}
```

---

## Phase 2: Deno Deploy Token Management

### New file: `src/services/deno.ts`

Manage the Deno Deploy organization token via the existing keyring infrastructure.

- `getDenoToken(): Promise<string | null>` -- read from keyring (`deno/deploy-token`)
- `setDenoToken(token: string): Promise<void>` -- store in keyring
- `deleteDenoToken(): Promise<void>` -- remove from keyring
- `ensureDenoAuth(): Promise<string>` -- check for token, prompt if missing, validate
  by calling `client.sandboxes.list()`, store on success

---

## Phase 3: SQLite Session Metadata Database

### New file: `src/services/sandbox/sessionDb.ts`

Uses Bun's built-in `bun:sqlite` -- no extra dependencies.

Location: `~/.config/hermes/sessions.db`

Schema:

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,              -- sandbox ID (container ID or Deno sandbox ID)
  provider TEXT NOT NULL,           -- 'docker' | 'cloud'
  name TEXT NOT NULL,
  branch TEXT,
  agent TEXT,
  model TEXT,
  prompt TEXT,
  repo TEXT,
  created TEXT NOT NULL,            -- ISO timestamp
  status TEXT NOT NULL,
  exit_code INTEGER,
  region TEXT,                      -- cloud only
  mount_dir TEXT,                   -- docker only
  container_name TEXT,              -- docker only
  volume_slug TEXT,                 -- cloud only: associated Deno volume
  snapshot_slug TEXT,               -- cloud only: resume snapshot
  extra TEXT                        -- JSON blob for future extensibility
);

CREATE INDEX IF NOT EXISTS idx_sessions_provider ON sessions(provider);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_name ON sessions(name);
```

Key exports:

- `openSessionDb(): Database` -- open/create the SQLite database, run migrations
- `upsertSession(session: HermesSession): void`
- `getSession(id: string): SessionRow | null`
- `listSessions(filter?: { provider?: string; status?: string }): SessionRow[]`
- `deleteSession(id: string): void`
- `updateSessionStatus(id: string, status: string, exitCode?: number): void`
- `updateSessionSnapshot(id: string, snapshotSlug: string): void`

Both providers use this database. For Docker, it serves as a cache (Docker labels
remain the source of truth). For Cloud, it is the primary metadata store (since Deno
labels are limited to 5 key/value pairs).

---

## Phase 4: Docker Provider (Refactor)

### New file: `src/services/sandbox/dockerProvider.ts`

Thin adapter wrapping existing functions from `docker.ts`:

```typescript
import {
  startContainer, resumeSession, listHermesSessions, getSession,
  removeContainer, stopContainer, attachToContainer, shellInContainer,
  getContainerLogs, streamContainerLogs, getContainerStats,
  ensureDockerSandbox,
} from '../docker';

export class DockerProvider implements SandboxProvider {
  readonly type = 'docker' as const;

  async ensureReady(): Promise<void> {
    await ensureDockerSandbox();
  }

  async create(options: CreateSandboxOptions): Promise<HermesSession> {
    // Delegate to startContainer(), map result to HermesSession
  }

  async resume(sessionId: string, options: ResumeSandboxOptions): Promise<HermesSession> {
    // Delegate to resumeSession(), map result
  }

  async list(): Promise<HermesSession[]> {
    // Delegate to listHermesSessions(), map each to HermesSession
  }

  async get(sessionId: string): Promise<HermesSession | null> {
    // Delegate to getSession()
  }

  async remove(sessionId: string): Promise<void> {
    await removeContainer(sessionId);
  }

  async stop(sessionId: string): Promise<void> {
    await stopContainer(sessionId);
  }

  async attach(sessionId: string): Promise<void> {
    await attachToContainer(sessionId);
  }

  async shell(sessionId: string): Promise<void> {
    await shellInContainer(sessionId);
  }

  async getLogs(sessionId: string, tail?: number): Promise<string> {
    return getContainerLogs(sessionId, tail);
  }

  streamLogs(sessionId: string): LogStream {
    return streamContainerLogs(sessionId);
  }

  async getStats(sessionIds: string[]): Promise<Map<string, SandboxStats>> {
    return getContainerStats(sessionIds);
  }
}
```

### Changes to `src/services/docker.ts`

- No behavioral changes to existing code
- Extract `HermesSession` type to `sandbox/types.ts`, keep a `DockerSession`
  type alias for internal use if needed
- Ensure all functions remain individually importable (they already are)

---

## Phase 5: Deno Cloud Provider

### Phase 5.0: Base Snapshot Management

#### New file: `src/services/sandbox/cloudSnapshot.ts`

The base snapshot is the cloud equivalent of the Docker image. It pre-installs all
tools so cloud sessions boot instantly. Named `hermes-base-{version}` where version
comes from `package.json`.

Progress reporting type (mirrors `ImageBuildProgress` from docker.ts):

```typescript
export type SnapshotBuildProgress =
  | { type: 'checking' }
  | { type: 'exists'; snapshotSlug: string }
  | { type: 'creating-volume'; message: string }
  | { type: 'booting-sandbox'; message: string }
  | { type: 'installing'; message: string; detail?: string }
  | { type: 'snapshotting'; message: string }
  | { type: 'cleaning-up'; message: string }
  | { type: 'done'; snapshotSlug: string }
  | { type: 'error'; message: string };
```

Main function:

```typescript
export async function ensureCloudSnapshot(options: {
  token: string;
  region: string;
  onProgress?: (progress: SnapshotBuildProgress) => void;
}): Promise<string>  // returns snapshot slug
```

Steps:

1. **Check**: List snapshots, look for `hermes-base-{version}` in target region.
   If found, return early.

2. **Create bootable volume** from `builtin:debian-13`:
   ```typescript
   const volume = await client.volumes.create({
     slug: `hermes-base-build-${version}`,
     region,
     capacity: '10GiB',
     from: 'builtin:debian-13',
   });
   ```

3. **Boot sandbox** with volume as writable root:
   ```typescript
   const sandbox = await client.sandboxes.create({
     region,
     root: volume.slug,
     timeout: '30m',
     memory: '2GiB',
   });
   ```

4. **Install tools** (mirrors `sandbox/slim.Dockerfile`):
   - System packages: `git curl ca-certificates zip unzip tar gzip jq`
   - GitHub CLI via official apt repo
   - Create `hermes` user (UID 10000, GID 10000) with home directory structure:
     ```
     /home/hermes/.local/bin
     /home/hermes/.local/share/opencode
     /home/hermes/.cache
     /home/hermes/.config/gh
     /home/hermes/.claude
     ```
   - Claude Code: `curl -fsSL https://claude.ai/install.sh | bash` (as hermes user)
   - Tiger CLI: `curl -fsSL https://cli.tigerdata.com | sh` (as hermes user)
   - OpenCode: `curl -fsSL https://opencode.ai/install | bash` (as hermes user)
   - Symlink: `/home/hermes/.opencode/bin/opencode` -> `/home/hermes/.local/bin/opencode`
   - Git config: `hermes@tigerdata.com` / `Hermes Agent`
   - Create `/work` directory owned by hermes

   Each step reports progress via the `onProgress` callback.

5. **Snapshot** the volume:
   ```typescript
   await client.volumes.snapshot(volume.id, {
     slug: `hermes-base-${version}`,
   });
   ```

6. **Cleanup**: Kill sandbox, delete temporary build volume.

7. Return snapshot slug.

#### Version management

- `ensureReady()` checks snapshot existence on each call
- Snapshot is version-specific (`hermes-base-0.8.0`), so new hermes versions
  trigger new snapshot creation automatically
- Old snapshots can be cleaned up manually or via a future `hermes clean` command

### Phase 5.0b: Cloud Setup TUI Component

#### New file: `src/components/CloudSetup.tsx`

Mirrors `DockerSetup.tsx` pattern -- a React TUI component with state machine:

```typescript
export type CloudSetupResultType = 'ready' | 'cancelled' | 'error';

export interface CloudSetupResult {
  type: CloudSetupResultType;
  error?: string;
}

export interface CloudSetupProps {
  title?: string;
  onComplete: (result: CloudSetupResult) => void;
  showBack?: boolean;
  onBack?: () => void;
}

type CloudSetupState =
  | { type: 'checking-token' }
  | { type: 'need-token' }                                    // text input
  | { type: 'validating-token'; message: string }
  | { type: 'invalid-token'; message: string }                // retry
  | { type: 'checking-snapshot' }
  | { type: 'building-snapshot'; message: string; detail?: string }
  | { type: 'ready' }
  | { type: 'error'; message: string };
```

UI renders per state:

- **checking-token**: Loading spinner + "Checking Deno Deploy credentials"
- **need-token**: Text input + instructions link to console.deno.com
- **validating-token**: Loading spinner + "Validating token"
- **invalid-token**: Error message + retry prompt
- **checking-snapshot**: Loading spinner + "Checking cloud sandbox image"
- **building-snapshot**: Loading spinner + step message + detail
  ("Installing Claude Code", etc.) + "This may take a few minutes on first run"
- **ready**: "Cloud sandbox ready!" success message
- **error**: Error + instructions + Esc to exit

Standalone runner (mirrors `runDockerSetupScreen()`):

```typescript
export async function runCloudSetupScreen(): Promise<CloudSetupResult> {
  const { render, destroy } = await createTui();
  // render CloudSetup, await result, destroy TUI
}
```

### Phase 5.1: Cloud Provider Implementation

#### New file: `src/services/sandbox/cloudProvider.ts`

```typescript
import { Sandbox, Client } from '@deno/sandbox';

export class CloudProvider implements SandboxProvider {
  readonly type = 'cloud' as const;
  private client: Client;
  private db: SessionDb;
  private region: string;

  constructor(region?: string) {
    this.region = region ?? 'ord';
    this.db = openSessionDb();
  }
```

#### `ensureReady()`

Check token + base snapshot:

```typescript
async ensureReady(): Promise<void> {
  const token = await getDenoToken();
  if (!token) {
    const result = await runCloudSetupScreen();
    if (result.type !== 'ready') throw new Error('Cloud setup cancelled');
  } else {
    this.client = new Client({ token });
    await ensureCloudSnapshot({ token, region: this.region });
  }
}
```

#### `create()`

```typescript
async create(options: CreateSandboxOptions): Promise<HermesSession> {
  const baseSnapshot = `hermes-base-${version}`;

  // 1. Create session-specific volume for /work
  const workVolume = await this.client.volumes.create({
    slug: `hermes-session-${options.name}`,
    region: this.region,
    capacity: '5GB',
  });

  // 2. Boot sandbox from base snapshot with work volume
  const sandbox = await Sandbox.create({
    region: this.region,
    root: baseSnapshot,
    timeout: '30m',
    memory: '2GiB',
    volumes: { '/work': workVolume.slug },
    labels: {
      'hermes.managed': 'true',
      'hermes.name': options.name,
      'hermes.agent': options.agent,
      'hermes.repo': options.repoInfo.fullName,
    },
    env: options.envVars,
  });

  // 3. Inject credential files via sandbox.fs.writeTextFile()
  await injectCredentials(sandbox);

  // 4. Clone repo, create branch
  await sandbox.sh`su - hermes -c "git clone ... /work/app"`;
  await sandbox.sh`su - hermes -c "cd /work/app && git checkout -b ${options.branchName}"`;

  // 5. Run init script if configured
  if (options.initScript) {
    await sandbox.sh`su - hermes -c "cd /work/app && ${options.initScript}"`;
  }

  // 6. Start agent process

  // 7. If interactive: expose SSH and spawn local ssh process
  if (options.interactive) {
    const { hostname, username } = await sandbox.exposeSsh();
    const proc = Bun.spawn(['ssh', `${username}@${hostname}`], {
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    await proc.exited;
  }

  // 8. Record in SQLite
  const session: HermesSession = { /* ... */ };
  this.db.upsertSession(session);
  return session;
}
```

#### `resume()` -- snapshot-based

```typescript
async resume(sessionId: string, options: ResumeSandboxOptions): Promise<HermesSession> {
  const existing = this.db.getSession(sessionId);
  if (!existing?.snapshotSlug) throw new Error('No resume snapshot');

  // 1. Create new volume from resume snapshot
  const resumeVolume = await this.client.volumes.create({
    from: existing.snapshotSlug,
    slug: `hermes-session-${existing.name}-r${Date.now()}`,
    region: this.region,
    capacity: '5GB',
  });

  // 2. Boot new sandbox from base snapshot + mount resume volume
  const sandbox = await Sandbox.create({
    region: this.region,
    root: `hermes-base-${version}`,
    timeout: '30m',
    memory: '2GiB',
    volumes: { '/work': resumeVolume.slug },
    labels: { /* ... */ },
  });

  // 3. Inject fresh credentials
  // 4. Run agent with continue (-c) flag
  // 5. If interactive: SSH attach
  // 6. Update SQLite with new sandbox ID
}
```

#### `list()` -- merge Deno API + SQLite

```typescript
async list(): Promise<HermesSession[]> {
  // 1. Fetch from Deno API with labels filter
  const running = await this.client.sandboxes.list({
    labels: { 'hermes.managed': 'true' },
  });

  // 2. Get all cloud sessions from SQLite
  const dbSessions = this.db.listSessions({ provider: 'cloud' });

  // 3. Merge: update SQLite status for any changes
  // 4. Return unified list
}
```

#### `stop()` -- snapshot volume, kill sandbox

```typescript
async stop(sessionId: string): Promise<void> {
  const session = this.db.getSession(sessionId);

  // Snapshot work volume for resume
  const snapshotSlug = `hermes-resume-${session.name}`;
  await this.client.volumes.snapshot(session.volumeSlug, { slug: snapshotSlug });
  this.db.updateSessionSnapshot(sessionId, snapshotSlug);

  // Kill sandbox
  const sandbox = await Sandbox.connect({ id: sessionId });
  await sandbox.kill();

  this.db.updateSessionStatus(sessionId, 'stopped');
}
```

#### `remove()` -- cleanup all resources

```typescript
async remove(sessionId: string): Promise<void> {
  const session = this.db.getSession(sessionId);

  // Kill sandbox if running
  try { (await Sandbox.connect({ id: sessionId })).kill(); } catch {}

  // Delete volume and snapshot
  if (session?.volumeSlug) await this.client.volumes.delete(session.volumeSlug);
  if (session?.snapshotSlug) await this.client.snapshots.delete(session.snapshotSlug);

  this.db.deleteSession(sessionId);
}
```

#### `attach()` / `shell()` -- SSH

```typescript
async attach(sessionId: string): Promise<void> {
  const sandbox = await Sandbox.connect({ id: sessionId });
  const { hostname, username } = await sandbox.exposeSsh();
  const proc = Bun.spawn(['ssh', `${username}@${hostname}`], {
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  await proc.exited;
}
```

#### `getLogs()` -- read from sandbox filesystem

```typescript
async getLogs(sessionId: string, tail?: number): Promise<string> {
  const sandbox = await Sandbox.connect({ id: sessionId });
  const content = await sandbox.fs.readTextFile('/work/agent.log');
  if (tail) return content.split('\n').slice(-tail).join('\n');
  return content;
}
```

Note: `getStats` is NOT implemented for cloud (field is optional on the interface).

### Phase 5.2: Install SDK

```bash
./bun add @deno/sandbox
```

The SDK is published on npm and works with Node.js 24+. Bun compatibility is
listed as "unknown" -- test early. If there are issues, fall back to the REST API
at `https://console.deno.com/api/v2/docs`.

---

## Phase 6: Provider Factory & Selection

### New file: `src/services/sandbox/index.ts`

```typescript
export { type SandboxProvider, type HermesSession, ... } from './types';
export { DockerProvider } from './dockerProvider';
export { CloudProvider } from './cloudProvider';

export function getSandboxProvider(type: SandboxProviderType): SandboxProvider {
  switch (type) {
    case 'docker': return new DockerProvider();
    case 'cloud':  return new CloudProvider();
  }
}

export async function getDefaultProvider(): Promise<SandboxProvider> {
  const config = await readConfig();
  return getSandboxProvider(config.sandboxProvider ?? 'docker');
}

export function getProviderForSession(session: HermesSession): SandboxProvider {
  return getSandboxProvider(session.provider);
}
```

---

## Phase 7: UI Changes

### 7.1: Prompt Screen -- Provider Toggle

**Modified: `src/components/PromptScreen.tsx`**

- Add new state for `sandboxProvider: 'docker' | 'cloud'`
- Initialize from config default
- Toggle keybinding (e.g., ctrl+e or similar unused binding)
- Show current provider in the hotkeys bar: `[ctrl+e] Cloud` / `[ctrl+e] Docker`
- When cloud is selected and no Deno token is configured, show a warning hint

### 7.2: Slash Commands

**Modified: `src/services/slashCommands.ts`**

Add new commands:

- `/cloud` -- switch provider to cloud for this session
- `/docker` -- switch provider to Docker for this session
- `/provider` -- toggle between providers

### 7.3: Session List -- Provider Indicator

**Modified: `src/components/SessionsList.tsx`**

- Provider badge ("D" or "C") next to each session
- Cloud sessions: show region instead of container stats
- Handle missing CPU/memory stats gracefully
- Filter: add "Docker" / "Cloud" alongside existing scope filters

### 7.4: Session Detail -- Cloud Info

**Modified: `src/components/SessionDetail.tsx`**

- Show region for cloud sessions
- Show sandbox ID
- SSH connection info when available
- Hide CPU/memory stats for cloud sessions gracefully
- Show volume/snapshot info

### 7.5: Config Wizard -- Cloud Setup Step

**Modified: `src/commands/config.tsx`**

Add step when user selects cloud provider:

1. Prompt for Deno Deploy organization token (masked input)
2. Validate token via API call
3. Store in keyring
4. Ask for default region (ams / ord)
5. Trigger base snapshot creation if needed

---

## Phase 8: Refactor Consumer Code

### 8.1: Sessions Command

**Modified: `src/commands/sessions.tsx`**

Key changes to `startSession()`:

```typescript
// Before (Docker-only):
await ensureDockerSandbox();
// ... Docker-specific container creation ...

// After (provider-agnostic):
const provider = getSandboxProvider(selectedProvider);
await provider.ensureReady();
const session = await provider.create(options);
```

Key changes to `resumeSessionFlow()`:

```typescript
const provider = getProviderForSession(session);
await provider.resume(session.id, resumeOptions);
```

Interactive operations (attach, shell, stop, remove) all route through
the provider interface.

The view state machine (`SessionsView`) remains unchanged.

### 8.2: Clean Command

**Modified: `src/commands/sessions.tsx` (clean subcommand)**

- `hermes sessions clean` -- removes stopped sessions from all providers
- Uses both providers' `list()` + `remove()` methods

### 8.3: Resume Command

**Modified: `src/commands/resume.ts`**

- Look up session by name/ID: check SQLite first (covers both providers),
  fall back to Docker labels for Docker-only sessions
- Route to the correct provider's `resume()` method

---

## Phase 9: Credential Injection for Cloud

### 9.1: File-based injection

Reuse existing `getCredentialFiles()` from `docker.ts`:

```typescript
async function injectCredentials(sandbox: Sandbox): Promise<void> {
  const files = await getCredentialFiles();
  for (const file of files) {
    const dir = file.path.substring(0, file.path.lastIndexOf('/'));
    await sandbox.sh`mkdir -p ${dir}`.noThrow();
    await sandbox.fs.writeTextFile(file.path, file.value);
  }
}
```

No changes needed to `claude.ts`, `opencode.ts`, or `gh.ts`.

### 9.2: Credential capture on exit

For cloud, capture credentials while sandbox is still alive:

- Monitor agent process via `ChildProcess.status`
- After agent exits but before sandbox teardown:
  - Read updated credential files from sandbox filesystem
  - Update keyring cache
- Then proceed with volume snapshot and sandbox kill

---

## Phase 10: Error Handling & Edge Cases

### 10.1: Concurrency limit

- Catch errors from `Sandbox.create()` when 5-sandbox limit is hit
- Display: "Cloud sandbox limit reached (5 concurrent). Stop a running
  session or wait for one to finish."
- Show count of running cloud sessions in the message

### 10.2: Timeout handling

- 30-minute max lifetime per sandbox
- Before timeout: snapshot volume for resumability
- If user is actively attached (SSH), extend via `sandbox.extendTimeout()`
- Display remaining time in session detail view

### 10.3: Network failures

- Handle disconnection gracefully
- Use `Sandbox.connect({ id })` for reconnection
- SQLite ensures session tracking survives hermes crashes

### 10.4: Region consistency

- Volumes, snapshots, and sandboxes must be in the same region
- Enforce at creation time, store region in SQLite
- Warn if user changes region with existing sessions

### 10.5: SDK compatibility with Bun

- `@deno/sandbox` lists Bun as "unknown" compatibility
- Test early in Phase 5.2
- Fallback: implement thin REST API client using the documented API

---

## File Change Summary

### New files

| File | Purpose |
|------|---------|
| `src/services/sandbox/types.ts` | `SandboxProvider` interface, unified types |
| `src/services/sandbox/index.ts` | Provider factory, re-exports |
| `src/services/sandbox/dockerProvider.ts` | Docker adapter |
| `src/services/sandbox/cloudProvider.ts` | Deno Cloud adapter |
| `src/services/sandbox/cloudSnapshot.ts` | Base snapshot creation/management |
| `src/services/sandbox/sessionDb.ts` | SQLite metadata store |
| `src/services/deno.ts` | Deno Deploy token keyring management |
| `src/components/CloudSetup.tsx` | TUI for cloud setup (token + snapshot) |

### Modified files

| File | Changes |
|------|---------|
| `src/services/config.ts` | Add `sandboxProvider`, `cloudRegion` to config |
| `src/services/docker.ts` | Extract shared types, keep all functions |
| `src/components/PromptScreen.tsx` | Provider toggle, new slash commands |
| `src/components/SessionsList.tsx` | Provider indicator, handle missing stats |
| `src/components/SessionDetail.tsx` | Region, SSH info, graceful missing stats |
| `src/commands/sessions.tsx` | Use `SandboxProvider` interface |
| `src/commands/config.tsx` | Cloud setup step |
| `src/commands/resume.ts` | Route to correct provider |
| `src/services/slashCommands.ts` | `/cloud`, `/docker` commands |
| `package.json` | Add `@deno/sandbox` dependency |

### Unchanged (but reused)

| File | How reused |
|------|------------|
| `src/services/runInDocker.ts` | Used by Docker provider internally |
| `src/services/dockerFiles.ts` | Used by Docker provider internally |
| `src/services/keyring.ts` | Used for Deno token storage |
| `src/services/claude.ts` | `getClaudeConfigFiles()` reused |
| `src/services/opencode.ts` | `getOpencodeConfigFiles()` reused |
| `src/services/gh.ts` | `getGhConfigFiles()` reused |
| `src/services/dockerSetup.ts` | Used by Docker provider's `ensureReady()` |

---

## Implementation Order

| Step | Phase | Description | Risk | Testable? |
|------|-------|-------------|------|-----------|
| 1 | Phase 1 | Interface & types | None | Types only |
| 2 | Phase 3 | SQLite session DB | Low | Unit tests |
| 3 | Phase 4 | Docker provider adapter | Low | Full regression |
| 4 | Phase 6 | Provider factory | Low | Existing tests |
| 5 | Phase 8 | Refactor consumer code | Medium | Full regression |
| 6 | Phase 2 | Deno token management | Low | Unit tests |
| 7 | Phase 5.0+5.0b | Base snapshot + Cloud setup TUI | Medium | Manual + API |
| 8 | Phase 5.1+5.2 | Cloud provider + SDK install | High | Manual cloud |
| 9 | Phase 9 | Credential injection for cloud | Medium | Manual cloud |
| 10 | Phase 7 | UI changes (toggle, list, detail) | Low | Pilotty + manual |
| 11 | Phase 10 | Error handling polish | Low | Edge case tests |

**Steps 1-5** produce no user-visible behavior change -- they restructure code for
the abstraction while keeping all Docker workflows identical. Run `./bun run check`
after each step.

**Steps 6-11** add cloud capability incrementally.
