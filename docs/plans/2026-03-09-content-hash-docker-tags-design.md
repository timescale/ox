# Content-Hash Docker Image Tagging - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace version-based Docker image tags with content-hash-based tags so users don't re-download images when the Dockerfile hasn't changed. Remove the "full" image variant, remove `:latest`, and publish per-agent images to GHCR.

**Architecture:** Single GHCR repo `ghcr.io/timescale/ox/sandbox` with immutable content-hash tags. Base images tagged as `<12-char-md5>`, agent overlays tagged as `<hash>-<agent>-<version>`. CI computes hashes by running `./bun index.ts sandbox hash`. Client uses same `computeDockerfileHash()` function. Agent overlay images built via a parameterized `agent.Dockerfile`.

**Tech Stack:** TypeScript (Bun), Docker/Buildx, GitHub Actions, Commander CLI

---

### Task 1: Add `ox sandbox hash` CLI command

**Files:**
- Create: `src/commands/sandbox.ts`
- Modify: `src/index.ts:80-95` (add sandbox command)

**Step 1: Create `src/commands/sandbox.ts`**

New commander command `sandbox` with subcommand `hash`. Accepts `--agent <name>` and `--image` flags. Prints the hash (or full image tag with `--image`) to stdout.

**Step 2: Register in `src/index.ts`**

Import and add `sandboxCommand` to the program.

**Step 3: Verify**

Run: `./bun index.ts sandbox hash` and verify it prints a 12-char hex hash.
Run: `./bun index.ts sandbox hash --agent claude` and verify it prints `<hash>-claude-<version>`.
Run: `./bun index.ts sandbox hash --image --agent claude` and verify it prints `ghcr.io/timescale/ox/sandbox:<hash>-claude-<version>`.

---

### Task 2: Refactor docker.ts - Remove full image, latest, Pull TTL, and ensuredImageOverride

**Files:**
- Modify: `src/services/docker.ts`

Changes:
1. Remove `FULL_DOCKERFILE` import
2. Change `DockerfileVariant` from `'slim' | 'full'` to just `'slim'` (or remove the type alias)
3. Remove Pull TTL system: `PULL_TTL_MS`, `getPullStatusPath`, `PullStatus`, `readPullStatus`, `recordPullTime`, `shouldPull`
4. Remove `ensuredImageOverride` and `resetEnsuredImageOverride`
5. Replace `getGhcrImageTags()` with a new `getGhcrBaseTag()` that returns the content-hash-based tag
6. Add `getGhcrAgentTag()` for agent overlay tags on GHCR
7. Update `getDockerfileContent()` to remove `'full'` case
8. Update `resolveSandboxImage()` to use hash-based GHCR tag, remove latest fallback logic
9. Update `ensureDockerImage()` to simplified 3-step fallback (local → pull → build)
10. Update `ensureAgentOverlay()` to try GHCR pull before local build
11. Update `listOxImages()` to remove `sandbox-full` pattern, add `sandbox` pattern
12. Remove `recordPullTime` call from `tryPullImage`
13. Remove `pullGhcrImageForCache` or simplify it (no more version/latest logic)

---

### Task 3: Update `SandboxImageConfig` and related types

**Files:**
- Modify: `src/services/docker.ts`

Changes:
1. Remove `cacheVariant` from `SandboxImageConfig` (no longer needed - cache is always the hash-tagged GHCR image)
2. Update all references to `cacheVariant`

---

### Task 4: Create `sandbox/agent.Dockerfile`

**Files:**
- Create: `sandbox/agent.Dockerfile`

Parameterized Dockerfile for building agent overlay images in CI:
```dockerfile
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG AGENT_NAME
ARG AGENT_VERSION

COPY agents/install-${AGENT_NAME}.sh /tmp/install-agent.sh
COPY agents/install-tiger.sh /tmp/install-tiger.sh

USER root
RUN chmod +x /tmp/install-agent.sh /tmp/install-tiger.sh
USER ox

RUN bash /tmp/install-agent.sh ${AGENT_VERSION} \
  && bash /tmp/install-tiger.sh \
  && rm -f /tmp/install-agent.sh /tmp/install-tiger.sh
```

---

### Task 5: Replace CI workflows

**Files:**
- Remove: `.github/workflows/publish-docker.yml`
- Remove: `.github/workflows/publish-docker-latest.yml`
- Create: `.github/workflows/publish-sandbox.yml`

Single workflow triggered on:
- Push to `main` with changes in `sandbox/` or `package.json`
- `workflow_dispatch`

Steps:
1. Checkout
2. Install bun (`oven-sh/setup-bun@v2`)
3. Install dependencies (`./bun install`)
4. Compute hash: `HASH=$(./bun index.ts sandbox hash)`
5. Setup QEMU + Buildx + GHCR login
6. Build + push base: `ghcr.io/timescale/ox/sandbox:$HASH`
7. For each agent (claude, opencode, codex): build + push using `agent.Dockerfile`

---

### Task 6: Update resource classification

**Files:**
- Modify: `src/services/sandbox/resources.ts`

Changes:
1. Remove `getGhcrImageTags` import, replace with new hash-based tag function
2. Update `discoverDockerResources()` to build `currentGhcrTags` from hash-based tags
3. Update `classifyDockerImage()` GHCR matching from `sandbox-slim`/`sandbox-full` to `sandbox`
4. Remove `SLIM_DOCKERFILE` import (get hash from docker.ts export instead)

---

### Task 7: Update config.ts

**Files:**
- Modify: `src/services/config.ts`

Changes:
1. Remove `'full'` from `buildSandboxFromDockerfile` type
2. Update JSDoc comment

---

### Task 8: Remove `sandbox/full.Dockerfile`

**Files:**
- Delete: `sandbox/full.Dockerfile`

---

### Task 9: Update tests

**Files:**
- Modify: `src/services/docker.test.ts`
- Modify: `src/services/sandbox/resources.test.ts`

Changes to `docker.test.ts`:
1. Remove `resetEnsuredImageOverride` import and `beforeEach` call
2. Update `resolveSandboxImage` tests to expect hash-based tags instead of version-based
3. Update regex assertions from `sandbox-slim:\d+\.\d+\.\d+` to `sandbox:[a-f0-9]{12}`

Changes to `resources.test.ts`:
1. Update all `sandbox-slim` and `sandbox-full` references in test data to `sandbox`
2. Update `currentGhcrTags` sets to use hash-based tags
3. Remove the `sandbox-full` test case
4. Remove `:latest` from tag sets

---

### Task 10: Run checks and verify

Run: `./bun run check` (typecheck + lint + tests)
Fix any issues found.
