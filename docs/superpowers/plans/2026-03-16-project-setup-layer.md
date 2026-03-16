# Project Setup Layer Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `projectSetupLayer` config option that applies a bash script on top of the base sandbox image, caches it via content-hashing, and integrates with both Docker and Deno Cloud providers.

**Architecture:** New image layer between base and agent overlay. Hash = MD5(baseHash + scriptContent). Docker uses run/exec/commit pattern. Cloud uses volume/sandbox/snapshot pattern. Resource cleanup classifies new `oxl-`/`oxlb-` prefixed resources.

**Tech Stack:** TypeScript, Bun, Docker CLI, Deno Cloud SDK

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/services/config.ts` | Modify | Add `projectSetupLayer` to `OxConfig` and `CONFIG_KEYS` |
| `src/services/docker.ts` | Modify | Add `computeProjectSetupHash()`, `getProjectSetupTag()`, `ensureProjectSetupLayer()`, update `ensureDockerImageForAgent()` |
| `src/services/sandbox/cloudSnapshot.ts` | Modify | Add `getProjectSetupSnapshotSlug()`, `ensureProjectSetupCloudSnapshot()`, update `getAgentSnapshotSlug()` to accept optional setup hash |
| `src/services/sandbox/cloudProvider.ts` | Modify | Update `ensureImage()` to chain through setup layer |
| `src/services/sandbox/resources.ts` | Modify | Add `oxl-`/`oxlb-` prefixes, add classification for setup snapshots/volumes, update Docker image classification |
| `src/commands/sandbox.ts` | Modify | Add `--setup` flag to `sandbox hash` command |

---

## Chunk 1: Config & Hashing Foundation

### Task 1: Add `projectSetupLayer` to OxConfig

**Files:**
- Modify: `src/services/config.ts:19-128`

- [ ] **Step 1: Add config field**

Add `projectSetupLayer` to the `OxConfig` interface after the `initScript` field (around line 64):

```typescript
/**
 * Bash script to run on top of the base sandbox image, then snapshot.
 * Runs WITHOUT the project repo — use for system-level dependencies
 * (apt packages, language runtimes, etc).
 * The script content + base image hash are combined for cache keys;
 * the image rebuilds automatically when either changes.
 */
projectSetupLayer?: string;
```

- [ ] **Step 2: Add to CONFIG_KEYS**

Add entry to `CONFIG_KEYS` (around line 119, after `initScript`):

```typescript
projectSetupLayer: 'string',
```

- [ ] **Step 3: Run typecheck**

Run: `./bun run typecheck`
Expected: PASS (new optional field, no consumers yet)

- [ ] **Step 4: Commit**

```bash
git add src/services/config.ts
git commit -m "feat: add projectSetupLayer config option"
```

### Task 2: Add Docker hashing and tag functions

**Files:**
- Modify: `src/services/docker.ts:251-302`
- Test: `src/services/docker.test.ts` (create if needed)

- [ ] **Step 1: Write test for `computeProjectSetupHash`**

Check if there's an existing test file:

```bash
ls src/services/docker.test.ts 2>/dev/null || echo "needs creation"
```

Create or extend with:

```typescript
import { describe, expect, test } from 'bun:test';
import { computeProjectSetupHash, getProjectSetupTag } from './docker.ts';

describe('computeProjectSetupHash', () => {
  test('produces 12-char hex string', () => {
    const hash = computeProjectSetupHash('basehash1234', 'apt install python3');
    expect(hash).toMatch(/^[a-f0-9]{12}$/);
  });

  test('changes when script changes', () => {
    const h1 = computeProjectSetupHash('base123', 'script-a');
    const h2 = computeProjectSetupHash('base123', 'script-b');
    expect(h1).not.toBe(h2);
  });

  test('changes when base hash changes', () => {
    const h1 = computeProjectSetupHash('base-a', 'same-script');
    const h2 = computeProjectSetupHash('base-b', 'same-script');
    expect(h1).not.toBe(h2);
  });
});

describe('getProjectSetupTag', () => {
  test('returns tag with -l- infix', () => {
    const tag = getProjectSetupTag('ox-sandbox:md5-abc123def456', 'my-script');
    expect(tag).toMatch(/^ox-sandbox:md5-abc123def456-l-[a-f0-9]{12}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./bun test src/services/docker.test.ts`
Expected: FAIL (functions don't exist yet)

- [ ] **Step 3: Implement `computeProjectSetupHash` and `getProjectSetupTag`**

Add after `computeDockerfileHash` (around line 257) in `docker.ts`:

```typescript
/**
 * Compute a content hash for the project setup layer.
 * Combines the base image hash and the setup script content so the
 * layer rebuilds when either the base or the script changes.
 */
export function computeProjectSetupHash(
  baseHash: string,
  script: string,
): string {
  const hasher = new Bun.CryptoHasher('md5');
  hasher.update(baseHash);
  hasher.update(script);
  return hasher.digest('hex').slice(0, 12);
}

/**
 * Compute the project setup layer image tag.
 * Format: <baseImage>-l-<setupHash>
 */
export function getProjectSetupTag(
  baseImage: string,
  script: string,
): string {
  // Extract the base hash from the image tag (e.g. 'ox-sandbox:md5-abc123' -> 'abc123')
  const baseHash = baseImage.split(':')[1]?.replace('md5-', '') ?? baseImage;
  const setupHash = computeProjectSetupHash(baseHash, script);
  return `${baseImage}-l-${setupHash}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./bun test src/services/docker.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/docker.ts src/services/docker.test.ts
git commit -m "feat: add project setup layer hash and tag computation"
```

### Task 3: Add Cloud hashing and slug functions

**Files:**
- Modify: `src/services/sandbox/cloudSnapshot.ts:1-42`

- [ ] **Step 1: Write test for cloud setup slug functions**

Create `src/services/sandbox/cloudSnapshot.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { getProjectSetupSnapshotSlug } from './cloudSnapshot.ts';

describe('getProjectSetupSnapshotSlug', () => {
  test('starts with oxl- prefix', () => {
    const slug = getProjectSetupSnapshotSlug('basehash1234', 'my script');
    expect(slug.startsWith('oxl-')).toBe(true);
  });

  test('is at most 32 chars', () => {
    const slug = getProjectSetupSnapshotSlug('basehash1234', 'a very long script content');
    expect(slug.length).toBeLessThanOrEqual(32);
  });

  test('changes when script changes', () => {
    const s1 = getProjectSetupSnapshotSlug('base123', 'script-a');
    const s2 = getProjectSetupSnapshotSlug('base123', 'script-b');
    expect(s1).not.toBe(s2);
  });

  test('does not end with hyphen', () => {
    const slug = getProjectSetupSnapshotSlug('base123', 'test');
    expect(slug.endsWith('-')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./bun test src/services/sandbox/cloudSnapshot.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `getProjectSetupSnapshotSlug`**

Add to `cloudSnapshot.ts` after `getAgentSnapshotSlug` (around line 42). Need to import `computeProjectSetupHash` from docker.ts:

```typescript
/**
 * Get the deterministic snapshot slug for a project setup layer.
 * Encodes the base hash and setup script content.
 * Constrained to 32 characters (Deno slug limit).
 */
export function getProjectSetupSnapshotSlug(
  baseHash: string,
  script: string,
): string {
  const setupHash = computeProjectSetupHash(baseHash, script);
  return `oxl-${setupHash}`.slice(0, 32).replace(/-+$/, '');
}
```

Add import at top of file:
```typescript
import { computeProjectSetupHash } from '../docker.ts';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./bun test src/services/sandbox/cloudSnapshot.test.ts`
Expected: PASS

- [ ] **Step 5: Update `getAgentSnapshotSlug` to accept optional setup hash**

The agent snapshot slug needs to incorporate the setup hash when a setup layer exists, so the agent overlay rebuilds when the setup changes. Modify `getAgentSnapshotSlug`:

```typescript
/**
 * Get the deterministic snapshot slug for an agent overlay.
 * Encodes the effective base version (setup layer or base), agent name, and agent version.
 * Constrained to 32 characters (Deno slug limit).
 *
 * @param agent - The agent type
 * @param setupHash - If a project setup layer is active, the setup hash to use
 *   instead of the base hash. This ensures the agent overlay rebuilds when
 *   the setup layer changes.
 */
export function getAgentSnapshotSlug(
  agent: AgentType,
  setupHash?: string,
): string {
  const hash = (setupHash ?? computeCloudBaseHash()).slice(0, 6);
  const agentVer = getAgentVersion(agent)
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 6);
  return `ox-${hash}-${agent}-${agentVer}`.slice(0, 32).replace(/-+$/, '');
}
```

- [ ] **Step 6: Run tests**

Run: `./bun test src/services/sandbox/cloudSnapshot.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/services/sandbox/cloudSnapshot.ts src/services/sandbox/cloudSnapshot.test.ts
git commit -m "feat: add cloud project setup snapshot slug computation"
```

---

## Chunk 2: Docker Project Setup Layer Build

### Task 4: Implement `ensureProjectSetupLayer` in Docker

**Files:**
- Modify: `src/services/docker.ts:315-396` (after `ensureAgentOverlay`)

- [ ] **Step 1: Implement `ensureProjectSetupLayer`**

Add after `getAgentOverlayTag` function (around line 302), before `ensureAgentOverlay`:

```typescript
/**
 * Ensure a project-specific setup layer image exists on top of the base image.
 *
 * Resolution:
 * 1. Check if setup layer image exists locally → return if yes
 * 2. Build locally via docker run + exec + commit
 *
 * The setup layer tag encodes the base hash and script content hash
 * so that any change to either triggers a rebuild.
 *
 * @returns The setup layer image tag (to be used as base for agent overlay)
 */
export async function ensureProjectSetupLayer(
  baseImage: string,
  script: string,
  options?: { onProgress?: (progress: ImageBuildProgress) => void },
): Promise<string> {
  const setupTag = getProjectSetupTag(baseImage, script);

  // Check if setup layer already exists locally
  if (await imageExists(setupTag)) {
    log.debug('Project setup layer image already exists');
    return setupTag;
  }

  // Build locally
  log.info({ setupTag, baseImage }, 'Building project setup layer image');
  options?.onProgress?.({
    type: 'building',
    message: 'Running project setup layer',
  });

  const containerName = `ox-setup-${nanoid(6).toLowerCase()}`;

  try {
    // 1. Start a temporary container from the base image
    await $`docker run -d --name ${containerName} ${baseImage} sleep infinity`.quiet();

    // 2. Write setup script into the container
    await writeFileToContainer(
      containerName,
      '/tmp/project-setup.sh',
      script,
    );

    // 3. Execute setup script
    await $`docker exec ${containerName} bash /tmp/project-setup.sh`.quiet();

    // 4. Clean up temp files and commit
    await $`docker exec ${containerName} rm -f /tmp/project-setup.sh`.quiet();
    await $`docker commit ${containerName} ${setupTag}`.quiet();
    invalidateImageExistsCache(setupTag);

    log.info({ setupTag }, 'Project setup layer image built successfully');
    return setupTag;
  } catch (err) {
    log.error({ err, setupTag }, 'Failed to build project setup layer');
    throw new Error(
      `Failed to build project setup layer: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await $`docker rm -f ${containerName}`.quiet().nothrow();
  }
}
```

- [ ] **Step 2: Update `ensureDockerImageForAgent` to chain through setup layer**

Modify `ensureDockerImageForAgent` (around line 946):

```typescript
export async function ensureDockerImageForAgent(
  agent: AgentType,
  options: EnsureDockerImageOptions = {},
): Promise<string> {
  const existing = agentImageInFlight.get(agent);
  if (existing) return existing;

  const promise = (async () => {
    const baseImage = await ensureDockerImage(options);

    // If projectSetupLayer is configured, apply it on top of the base
    const config = await readConfig();
    let effectiveBase = baseImage;
    if (config.projectSetupLayer) {
      effectiveBase = await ensureProjectSetupLayer(
        baseImage,
        config.projectSetupLayer,
        options,
      );
    }

    return ensureAgentOverlay(effectiveBase, agent, options);
  })();

  agentImageInFlight.set(agent, promise);
  try {
    return await promise;
  } finally {
    agentImageInFlight.delete(agent);
  }
}
```

- [ ] **Step 3: Run typecheck and tests**

Run: `./bun run typecheck && ./bun test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/docker.ts
git commit -m "feat: add Docker project setup layer build and chain it into agent overlay"
```

---

## Chunk 3: Cloud Project Setup Layer Build

### Task 5: Implement `ensureProjectSetupCloudSnapshot`

**Files:**
- Modify: `src/services/sandbox/cloudSnapshot.ts`

- [ ] **Step 1: Implement `ensureProjectSetupCloudSnapshot`**

Add after `ensureCloudSnapshot` and before `ensureAgentCloudSnapshot`:

```typescript
/**
 * Ensure a project-specific setup layer cloud snapshot exists.
 *
 * Boots a sandbox from the base snapshot, executes the project setup script,
 * kills the sandbox, and snapshots the resulting volume.
 *
 * @returns The project setup snapshot slug (to be used as base for agent overlay)
 */
export async function ensureProjectSetupCloudSnapshot(options: {
  token: string;
  region: string;
  baseSnapshotSlug: string;
  script: string;
  onProgress?: (progress: SnapshotBuildProgress) => void;
}): Promise<string> {
  const { token, region, baseSnapshotSlug, script, onProgress } = options;
  const client = new DenoApiClient(token);

  // Derive the base hash from the base snapshot slug (ox-base-{hash} -> {hash})
  const baseHash = baseSnapshotSlug.replace('ox-base-', '');
  const snapshotSlug = getProjectSetupSnapshotSlug(baseHash, script);

  // 1. Check if setup snapshot already exists AND is bootable
  onProgress?.({ type: 'checking' });
  try {
    const existing = await client.getSnapshot(snapshotSlug);
    if (existing) {
      const bootable = await isSnapshotBootable(token, snapshotSlug);
      if (bootable) {
        onProgress?.({ type: 'exists', snapshotSlug });
        return snapshotSlug;
      }
      log.warn(
        { snapshotSlug },
        'Project setup snapshot exists but is not bootable — deleting and rebuilding',
      );
      try {
        await client.deleteSnapshot(existing.id);
      } catch (err) {
        log.debug({ err }, 'Failed to delete non-bootable project setup snapshot');
      }
    }
  } catch (err) {
    log.debug({ err }, 'Failed to check project setup snapshot');
  }

  // 2. Create a bootable volume from the base snapshot
  const buildVolumeSlug = denoSlug('oxlb');
  onProgress?.({
    type: 'creating-volume',
    message: 'Creating volume for project setup layer',
  });

  const volume = await client.createVolume({
    slug: buildVolumeSlug,
    region,
    capacity: '10GiB',
    from: baseSnapshotSlug,
  });

  let sandbox: ResolvedSandbox | null = null;
  let snapshotCreated = false;
  let buildSandboxId: string | undefined;

  try {
    // 3. Boot sandbox from the base volume
    onProgress?.({
      type: 'booting-sandbox',
      message: 'Booting sandbox for project setup',
    });

    sandbox = await client.createSandbox({
      region: region as 'ord' | 'ams',
      root: volume.slug,
      timeout: '30m',
      memory: '2GiB',
    });
    buildSandboxId = sandbox.resolvedId || sandbox.id;
    log.debug(
      { sandboxId: buildSandboxId },
      'Project setup build sandbox created',
    );

    // 4. Execute the project setup script
    onProgress?.({
      type: 'installing',
      message: 'Running project setup script',
    });
    await sandboxExec(
      sandbox,
      `cat > /tmp/project-setup.sh << 'SETUP_EOF'\n${script}\nSETUP_EOF\nbash /tmp/project-setup.sh`,
      { label: 'Project setup' },
    );

    // Clean up temp files
    await sandboxExec(sandbox, 'rm -f /tmp/project-setup.sh', {
      label: 'Clean up project setup script',
    });

    // 5. Kill sandbox and wait for volume detachment
    onProgress?.({
      type: 'snapshotting',
      message: 'Detaching volume',
    });
    log.debug({ sandboxId: buildSandboxId }, 'Stopping project setup sandbox');
    try {
      await sandbox.close();
    } catch {
      // ignore close errors
    }
    if (buildSandboxId) {
      await client.killAndWaitForDetach(buildSandboxId);
    }
    sandbox = null;

    // 6. Snapshot the volume
    onProgress?.({
      type: 'snapshotting',
      message: 'Creating project setup snapshot',
    });
    try {
      await client.snapshotVolumeWithRetry(volume.id, { slug: snapshotSlug });
    } catch (err) {
      log.error(
        { err, volumeId: volume.id, snapshotSlug },
        'Failed to snapshot project setup volume',
      );
      throw err;
    }
    snapshotCreated = true;

    onProgress?.({ type: 'done', snapshotSlug });
    return snapshotSlug;
  } finally {
    const needsCleanup = !snapshotCreated || sandbox !== null;
    if (needsCleanup) {
      onProgress?.({
        type: 'cleaning-up',
        message: 'Cleaning up project setup build resources',
      });
    }
    if (sandbox) {
      try {
        await sandbox.close();
      } catch {
        // ignore close errors
      }
      if (buildSandboxId) {
        try {
          await client.killSandbox(buildSandboxId);
        } catch (err) {
          log.debug({ err }, 'Failed to kill project setup sandbox in cleanup');
        }
      }
    }
    if (!snapshotCreated) {
      try {
        await client.deleteVolume(volume.id);
      } catch (err) {
        log.debug({ err }, 'Failed to delete project setup build volume');
      }
    } else {
      log.debug(
        { volumeId: volume.id, slug: volume.slug },
        'Leaving project setup build volume intact to avoid disrupting snapshot finalization',
      );
    }
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `./bun run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/services/sandbox/cloudSnapshot.ts
git commit -m "feat: add cloud project setup snapshot build"
```

### Task 6: Update Cloud Provider `ensureImage` to chain through setup layer

**Files:**
- Modify: `src/services/sandbox/cloudProvider.ts:533-597`

- [ ] **Step 1: Update `ensureImage` method**

In the `CloudSandboxProvider.ensureImage()` method, between the base snapshot ensure and the agent snapshot ensure, add the setup layer:

```typescript
async ensureImage(options?: {
  agent?: AgentType;
  onProgress?: (progress: SandboxBuildProgress) => void;
}): Promise<string> {
  const token = await getDenoToken();
  if (!token) {
    throw new Error(
      'No Deno Deploy token configured. Run cloud setup first.',
    );
  }

  const region = await this.resolveRegion();
  const config = await readConfig();

  const mapProgress = (p: {
    type: string;
    message?: string;
    snapshotSlug?: string;
  }) => {
    switch (p.type) {
      case 'checking':
        options?.onProgress?.({ type: 'checking' });
        break;
      case 'exists':
        options?.onProgress?.({ type: 'exists' });
        break;
      case 'creating-volume':
      case 'booting-sandbox':
      case 'installing':
      case 'snapshotting':
      case 'cleaning-up':
        options?.onProgress?.({
          type: 'building',
          message: p.message ?? '',
        });
        break;
      case 'done':
        options?.onProgress?.({ type: 'done' });
        break;
      case 'error':
        log.error({ error: p.message }, 'Snapshot build error');
        break;
    }
  };

  // 1. Ensure base snapshot exists
  const baseSlug = await ensureCloudSnapshot({
    token,
    region,
    onProgress: mapProgress,
  });

  // 2. If projectSetupLayer is configured, ensure setup layer snapshot
  let effectiveBaseSlug = baseSlug;
  let setupHash: string | undefined;
  if (config.projectSetupLayer) {
    effectiveBaseSlug = await ensureProjectSetupCloudSnapshot({
      token,
      region,
      baseSnapshotSlug: baseSlug,
      script: config.projectSetupLayer,
      onProgress: mapProgress,
    });
    // Extract the setup hash for use in agent slug computation
    setupHash = effectiveBaseSlug.replace('oxl-', '');
  }

  // 3. If agent specified, ensure agent overlay snapshot exists
  if (options?.agent) {
    const agentSlug = await ensureAgentCloudSnapshot({
      token,
      region,
      agent: options.agent,
      baseSnapshotSlug: effectiveBaseSlug,
      onProgress: mapProgress,
    });
    return agentSlug;
  }

  return effectiveBaseSlug;
}
```

Also add import for `ensureProjectSetupCloudSnapshot` at the top of the file.

- [ ] **Step 2: Run typecheck**

Run: `./bun run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/services/sandbox/cloudProvider.ts
git commit -m "feat: chain cloud project setup layer into ensureImage"
```

---

## Chunk 3: Resource Cleanup

### Task 7: Update resource classification for project setup layer

**Files:**
- Modify: `src/services/sandbox/resources.ts`

- [ ] **Step 1: Write tests for setup layer classification**

Create or extend `src/services/sandbox/resources.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { classifyCloudSnapshot, classifyCloudVolume, classifyDockerImage } from './resources.ts';

describe('classifyCloudSnapshot — project setup layer', () => {
  test('classifies current oxl- snapshot as current', () => {
    const result = classifyCloudSnapshot(
      {
        id: 'snap-1',
        slug: 'oxl-abc123def456',
        region: 'ord',
        allocatedSize: 1000,
        bootable: true,
        volume: { slug: 'oxlb-vol1' },
      } as any,
      {
        currentBaseSlug: 'ox-base-xyz',
        currentAgentSlugs: new Set(),
        currentSetupSlug: 'oxl-abc123def456',
        sessionsBySnapshotSlug: new Map(),
        deletedSessionsBySnapshotSlug: new Map(),
      },
    );
    expect(result).not.toBeNull();
    expect(result!.category).toBe('Project Setup Snapshot');
    expect(result!.status).toBe('current');
  });

  test('classifies old oxl- snapshot as old', () => {
    const result = classifyCloudSnapshot(
      {
        id: 'snap-2',
        slug: 'oxl-old123old456',
        region: 'ord',
        allocatedSize: 1000,
        bootable: true,
        volume: { slug: 'oxlb-vol2' },
      } as any,
      {
        currentBaseSlug: 'ox-base-xyz',
        currentAgentSlugs: new Set(),
        currentSetupSlug: 'oxl-abc123def456',
        sessionsBySnapshotSlug: new Map(),
        deletedSessionsBySnapshotSlug: new Map(),
      },
    );
    expect(result).not.toBeNull();
    expect(result!.category).toBe('Project Setup Snapshot');
    expect(result!.status).toBe('old');
  });
});

describe('classifyCloudVolume — project setup build volume', () => {
  test('classifies oxlb- volume with current child as current', () => {
    const result = classifyCloudVolume(
      {
        id: 'vol-1',
        slug: 'oxlb-build1',
        region: 'ord',
        allocatedSize: 5000,
        bootable: true,
      } as any,
      {
        currentBaseVolumeSlug: null,
        sessionsByVolumeSlug: new Map(),
        deletedSessionsByVolumeSlug: new Map(),
        snapshotsByVolumeSlug: new Map([
          ['oxlb-build1', [{ slug: 'oxl-abc123def456', status: 'current' }]],
        ]),
      },
    );
    expect(result).not.toBeNull();
    expect(result!.category).toBe('Project Setup Build Volume');
    expect(result!.status).toBe('current');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./bun test src/services/sandbox/resources.test.ts`
Expected: FAIL (no `currentSetupSlug` field yet)

- [ ] **Step 3: Update prefix lists**

In `resources.ts`, update the prefix lists (around line 102-105):

```typescript
/** Known Ox snapshot slug prefixes. */
const OX_SNAPSHOT_PREFIXES = ['ox-base-', 'oxl-', 'ox-', 'oxn-'];

/** Known Ox volume slug prefixes. */
const OX_VOLUME_PREFIXES = ['oxb-', 'oxlb-', 'oxa-', 'oxe-', 'oxs-', 'oxr-'];
```

Note: `oxl-` must come before `ox-` to match first (since `ox-` is a prefix of `oxl-`). Actually `oxl-` starts with `ox-` but also matches `oxl-`. The `some()` check uses `startsWith` so order doesn't matter for correctness, but placing `oxl-` first is clearer.

Wait — actually `oxl-` does start with `ox-`, but the classification function checks prefixes in order. We need to ensure `oxl-` is checked before `ox-` in `classifyCloudSnapshot`. Let me review the classification logic...

The classification in `classifyCloudSnapshot` uses explicit `if/else` chains, not the prefix list. The prefix list is only used to filter non-Ox resources. So the fix is:

1. Add `oxl-` to the prefix list so `oxl-` snapshots aren't filtered out.
2. Add an `if (snapshot.slug.startsWith('oxl-'))` branch in the classification function BEFORE the `ox-` branch.

- [ ] **Step 4: Add `currentSetupSlug` to `SnapshotClassificationContext`**

```typescript
interface SnapshotClassificationContext {
  currentBaseSlug: string;
  currentAgentSlugs: Set<string>;
  /** Slug of the current project setup snapshot, if any */
  currentSetupSlug: string | null;
  sessionsBySnapshotSlug: Map<string, OxSession>;
  deletedSessionsBySnapshotSlug: Map<string, OxSession>;
}
```

- [ ] **Step 5: Add `oxl-` classification branch in `classifyCloudSnapshot`**

Add after the `ox-base-*` branch and before the `ox-*` agent branch:

```typescript
// Project setup layer snapshots (oxl-*)
if (snapshot.slug.startsWith('oxl-')) {
  return {
    ...base,
    category: 'Project Setup Snapshot',
    status: snapshot.slug === ctx.currentSetupSlug ? 'current' : 'old',
  };
}
```

- [ ] **Step 6: Add `oxlb-` classification branch in `classifyCloudVolume`**

Add after the `oxa-*` branch:

```typescript
// Project setup build volumes — status derived from child snapshots.
if (volume.slug.startsWith('oxlb-')) {
  return {
    ...base,
    category: 'Project Setup Build Volume',
    status: volumeStatusFromChildSnapshots(childSnapshots),
  };
}
```

- [ ] **Step 7: Update `discoverCloudResources` to pass `currentSetupSlug`**

In `discoverCloudResources`, compute the current setup slug from config and pass it:

```typescript
// Compute current setup slug (if projectSetupLayer is configured)
const config = await readConfig();
let currentSetupSlug: string | null = null;
if (config.projectSetupLayer) {
  const baseHash = currentBaseSlug.replace('ox-base-', '');
  currentSetupSlug = getProjectSetupSnapshotSlug(baseHash, config.projectSetupLayer);
}
```

Pass `currentSetupSlug` in the classification context.

- [ ] **Step 8: Update Docker image classification**

In `classifyDockerImage`, the existing logic for `ox-sandbox:md5-*` already handles overlays via `currentLocalOverlayTags`. We need to also add the current setup layer tag.

In `ImageClassificationContext`, add:
```typescript
/** Full local setup layer tags that are current (e.g. 'md5-{hash}-l-{setupHash}') */
currentSetupLayerTags: Set<string>;
```

In `classifyDockerImage`, update the `ox-sandbox:md5-*` branch:
```typescript
const isCurrentBase = image.tag === `md5-${ctx.currentDockerfileHash}`;
const isCurrentOverlay = ctx.currentLocalOverlayTags.has(image.tag);
const isCurrentSetup = ctx.currentSetupLayerTags.has(image.tag);
return {
  ...base,
  category: 'Local Build',
  status: isCurrentBase || isCurrentOverlay || isCurrentSetup ? 'current' : 'old',
};
```

In `discoverDockerResources`, compute the current setup layer tag:
```typescript
const config = await readConfig();
const currentSetupLayerTags = new Set<string>();
if (config.projectSetupLayer) {
  const setupTag = getProjectSetupTag(localBaseImage, config.projectSetupLayer);
  const tagPart = setupTag.split(':')[1] ?? setupTag;
  currentSetupLayerTags.add(tagPart);

  // Also add agent overlay tags that include the setup layer
  for (const agent of agents) {
    const fullTag = getAgentOverlayTag(setupTag, agent);
    const overlayTagPart = fullTag.split(':')[1] ?? fullTag;
    currentLocalOverlayTags.add(overlayTagPart);
  }
}
```

- [ ] **Step 9: Run tests**

Run: `./bun test src/services/sandbox/resources.test.ts`
Expected: PASS

- [ ] **Step 10: Run full check**

Run: `./bun run check`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add src/services/sandbox/resources.ts src/services/sandbox/resources.test.ts
git commit -m "feat: add project setup layer to resource classification and cleanup"
```

---

## Chunk 4: CLI & Integration

### Task 8: Update `sandbox hash` CLI command

**Files:**
- Modify: `src/commands/sandbox.ts`

- [ ] **Step 1: Add `--setup` flag**

Update the `sandbox hash` command to support showing the project setup layer hash when configured:

```typescript
.option('-s, --setup', 'include project setup layer hash')
```

In the action handler, when `--setup` is passed, read config and compute the setup hash:

```typescript
if (options.setup) {
  const { readConfig } = await import('../services/config.ts');
  const config = await readConfig();
  if (!config.projectSetupLayer) {
    console.error('No projectSetupLayer configured');
    process.exit(1);
  }
  if (options.cloud) {
    const baseHash = computeCloudBaseHash();
    const { getProjectSetupSnapshotSlug } = await import('../services/sandbox/cloudSnapshot.ts');
    console.log(getProjectSetupSnapshotSlug(baseHash, config.projectSetupLayer));
  } else {
    const baseHash = computeDockerfileHash(BASE_DOCKERFILE);
    const { computeProjectSetupHash } = await import('../services/docker.ts');
    const setupHash = computeProjectSetupHash(baseHash, config.projectSetupLayer);
    if (options.image) {
      console.log(`ox-sandbox:md5-${baseHash}-l-${setupHash}`);
    } else {
      console.log(setupHash);
    }
  }
  return;
}
```

- [ ] **Step 2: Run typecheck**

Run: `./bun run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/commands/sandbox.ts
git commit -m "feat: add --setup flag to sandbox hash command"
```

### Task 9: Final integration test and cleanup

- [ ] **Step 1: Run full check**

Run: `./bun run check`
Expected: PASS (typecheck + lint + all tests)

- [ ] **Step 2: Manual verification**

Test the config flow manually:

```bash
# Set a project setup layer
./bun index.ts config set projectSetupLayer "echo hello"

# Verify the hash command works
./bun index.ts sandbox hash --setup
./bun index.ts sandbox hash --setup --cloud

# Clean up
./bun index.ts config delete projectSetupLayer
```

- [ ] **Step 3: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "fix: address integration issues from project setup layer"
```
