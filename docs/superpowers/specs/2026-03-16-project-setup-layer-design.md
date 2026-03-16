# Project Setup Layer (`projectSetupLayer`) Design

## Goal

Add a project-level config option `projectSetupLayer` that provides a bash script applied on top of the base sandbox image and snapshotted/committed for caching. This creates a new layer in the image stack between base and agent overlay, allowing projects to cache expensive system-level setup (apt packages, language runtimes, etc.) without rebuilding on every session.

## Architecture

The image stack becomes:

```
base → projectSetupLayer → agent overlay → session
```

When `projectSetupLayer` is not configured, the stack remains unchanged:

```
base → agent overlay → session
```

### Hashing

The setup layer hash combines the base image hash and the script content:

```
setupHash = MD5(baseHash + scriptContent).slice(0, 12)
```

This ensures the layer rebuilds when either the base image or the script changes. The agent overlay automatically rebuilds because its base image reference changes.

### Naming Conventions

**Docker:**
- Setup layer image: `ox-sandbox:md5-{baseHash}-l-{setupHash}`
- Agent overlay (with setup): `ox-sandbox:md5-{baseHash}-l-{setupHash}-{agent}-{version}`

**Cloud:**
- Setup snapshot: `oxl-{setupHash}` (32 char max)
- Build volume: `oxlb-{nanoid}`
- Agent overlay slug uses setup hash prefix instead of base hash prefix when setup layer exists

### Config

New field in `OxConfig`:

```typescript
/**
 * Bash script to run on top of the base sandbox image, then snapshot.
 * Runs WITHOUT the project repo — use for system-level dependencies
 * (apt packages, language runtimes, etc).
 * The script content is hashed for caching; image rebuilds when script changes.
 */
projectSetupLayer?: string;
```

Type: `'string'` in `CONFIG_KEYS`.

Example `.ox/config.yml`:
```yaml
projectSetupLayer: |
  sudo apt-get update && sudo apt-get install -y python3 python3-pip
  pip3 install awscli
```

### Script Execution Context

- Runs on the base image WITHOUT project repo files
- Suitable for system-level dependencies only
- Independent of `initScript` (which still runs per-session)

### Docker Build Flow

1. Ensure base image (existing)
2. Compute setup hash from base hash + script content
3. Check if `ox-sandbox:md5-{baseHash}-l-{setupHash}` exists locally
4. If not: `docker run` → write script → `docker exec` → `docker commit`
5. Pass setup layer image as base to `ensureAgentOverlay`

### Cloud Build Flow

1. Ensure base snapshot (existing)
2. Compute setup hash, derive slug `oxl-{setupHash}`
3. Check if snapshot exists and is bootable
4. If not: create volume from base snapshot → boot sandbox → execute script → kill → snapshot
5. Pass setup snapshot slug as base to `ensureAgentCloudSnapshot`

### Resource Cleanup

New resource categories:

**Cloud:**
- `oxl-*` snapshots → "Project Setup Snapshot": `current` if matches current hash, else `old`
- `oxlb-*` volumes → "Project Setup Build Volume": status from child snapshots

**Docker:**
- `ox-sandbox:md5-*-l-*` images (without agent suffix) → classified as "Local Build", current if hash matches

### Relationship to `initScript`

Independent. `projectSetupLayer` is baked into the image/snapshot and cached. `initScript` runs every session start. Users move expensive setup to `projectSetupLayer` and keep lightweight per-session setup in `initScript`.
