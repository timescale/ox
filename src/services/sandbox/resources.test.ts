// ============================================================================
// Resource Discovery & Classification Tests
// ============================================================================

import { describe, expect, test } from 'bun:test';
import type { DockerImageInfo } from '../docker.ts';
import type { DenoSnapshot, DenoVolume } from './denoApi.ts';
import {
  classifyCloudSnapshot,
  classifyCloudVolume,
  classifyDockerImage,
  getCleanupTargets,
  groupResourcesByKind,
  type SandboxResource,
} from './resources.ts';
import type { HermesSession } from './types.ts';

// ============================================================================
// Helpers
// ============================================================================

/** Assert non-null and return typed value (for classify functions that may return null) */
function assertResource(result: SandboxResource | null): SandboxResource {
  if (result === null) {
    throw new Error('Expected non-null SandboxResource');
  }
  return result;
}

function makeSnapshot(overrides?: Partial<DenoSnapshot>): DenoSnapshot {
  return {
    id: 'snp_ord_abc123',
    slug: 'hsnap-test-abc123',
    region: 'ord',
    allocatedSize: 1024 * 1024 * 100,
    flattenedSize: 1024 * 1024 * 200,
    bootable: true,
    volume: { id: 'vol_ord_xyz', slug: 'hs-test-xyz' },
    ...overrides,
  };
}

function makeVolume(overrides?: Partial<DenoVolume>): DenoVolume {
  return {
    id: 'vol_ord_abc123',
    slug: 'hs-test-abc123',
    region: 'ord',
    capacity: 10 * 1024 * 1024 * 1024,
    allocatedSize: 1024 * 1024 * 100,
    flattenedSize: 1024 * 1024 * 200,
    bootable: true,
    baseSnapshot: null,
    ...overrides,
  };
}

function makeImage(overrides?: Partial<DockerImageInfo>): DockerImageInfo {
  return {
    id: 'sha256:abc123',
    repository: 'hermes-sandbox',
    tag: 'md5-abcdef123456',
    size: 1024 * 1024 * 500,
    created: '2025-01-15T10:00:00Z',
    ...overrides,
  };
}

function makeSession(overrides?: Partial<HermesSession>): HermesSession {
  return {
    id: 'test-session-1',
    provider: 'cloud',
    name: 'test-session',
    branch: 'main',
    agent: 'claude',
    prompt: 'fix the bug',
    repo: 'timescale/hermes',
    created: '2025-01-15T10:00:00Z',
    status: 'running',
    interactive: true,
    ...overrides,
  };
}

// ============================================================================
// classifyCloudSnapshot
// ============================================================================

describe('classifyCloudSnapshot', () => {
  test('current base snapshot matches getBaseSnapshotSlug()', () => {
    const snapshot = makeSnapshot({
      slug: 'hermes-base-0-12-0-a1b2c3',
    });

    const result = assertResource(
      classifyCloudSnapshot(snapshot, {
        currentBaseSlug: 'hermes-base-0-12-0-a1b2c3',
        sessionsBySnapshotSlug: new Map(),
        deletedSessionsBySnapshotSlug: new Map(),
      }),
    );

    expect(result.status).toBe('current');
    expect(result.category).toBe('Base Snapshot');
    expect(result.provider).toBe('cloud');
    expect(result.kind).toBe('snapshot');
    expect(result.id).toBe('snp_ord_abc123');
    expect(result.name).toBe('hermes-base-0-12-0-a1b2c3');
  });

  test('old base snapshot does not match current slug', () => {
    const snapshot = makeSnapshot({
      slug: 'hermes-base-0-11-0-oldold',
    });

    const result = assertResource(
      classifyCloudSnapshot(snapshot, {
        currentBaseSlug: 'hermes-base-0-12-0-a1b2c3',
        sessionsBySnapshotSlug: new Map(),
        deletedSessionsBySnapshotSlug: new Map(),
      }),
    );

    expect(result.status).toBe('old');
    expect(result.category).toBe('Base Snapshot');
  });

  test('active session snapshot linked to non-deleted session', () => {
    const snapshot = makeSnapshot({
      slug: 'hsnap-my-session-abc123',
    });
    const session = makeSession({
      snapshotSlug: 'hsnap-my-session-abc123',
      name: 'my-session',
    });

    const result = assertResource(
      classifyCloudSnapshot(snapshot, {
        currentBaseSlug: 'hermes-base-0-12-0-a1b2c3',
        sessionsBySnapshotSlug: new Map([['hsnap-my-session-abc123', session]]),
        deletedSessionsBySnapshotSlug: new Map(),
      }),
    );

    expect(result.status).toBe('active');
    expect(result.category).toBe('Session Snapshot');
    expect(result.sessionName).toBe('my-session');
  });

  test('old session snapshot linked to deleted session', () => {
    const snapshot = makeSnapshot({
      slug: 'hsnap-old-session-abc123',
    });
    const deletedSession = makeSession({
      snapshotSlug: 'hsnap-old-session-abc123',
      name: 'old-session',
    });

    const result = assertResource(
      classifyCloudSnapshot(snapshot, {
        currentBaseSlug: 'hermes-base-0-12-0-a1b2c3',
        sessionsBySnapshotSlug: new Map(),
        deletedSessionsBySnapshotSlug: new Map([
          ['hsnap-old-session-abc123', deletedSession],
        ]),
      }),
    );

    expect(result.status).toBe('old');
    expect(result.category).toBe('Session Snapshot');
    expect(result.sessionName).toBe('old-session');
  });

  test('orphaned session snapshot has no session reference', () => {
    const snapshot = makeSnapshot({
      slug: 'hsnap-mystery-abc123',
    });

    const result = assertResource(
      classifyCloudSnapshot(snapshot, {
        currentBaseSlug: 'hermes-base-0-12-0-a1b2c3',
        sessionsBySnapshotSlug: new Map(),
        deletedSessionsBySnapshotSlug: new Map(),
      }),
    );

    expect(result.status).toBe('orphaned');
    expect(result.category).toBe('Session Snapshot');
    expect(result.sessionName).toBeUndefined();
  });

  test('snapshot size and region are included', () => {
    const snapshot = makeSnapshot({
      slug: 'hsnap-sized-abc123',
      allocatedSize: 5000,
      region: 'ams',
    });

    const result = assertResource(
      classifyCloudSnapshot(snapshot, {
        currentBaseSlug: 'hermes-base-0-12-0-a1b2c3',
        sessionsBySnapshotSlug: new Map(),
        deletedSessionsBySnapshotSlug: new Map(),
      }),
    );

    expect(result.size).toBe(5000);
    expect(result.region).toBe('ams');
    expect(result.bootable).toBe(true);
  });

  test('non-Hermes snapshot returns null', () => {
    const snapshot = makeSnapshot({
      slug: 'my-custom-snapshot',
    });

    const result = classifyCloudSnapshot(snapshot, {
      currentBaseSlug: 'hermes-base-0-12-0-a1b2c3',
      sessionsBySnapshotSlug: new Map(),
      deletedSessionsBySnapshotSlug: new Map(),
    });

    expect(result).toBeNull();
  });

  test('builtin snapshot returns null', () => {
    const snapshot = makeSnapshot({
      slug: 'builtin:debian-13',
    });

    const result = classifyCloudSnapshot(snapshot, {
      currentBaseSlug: 'hermes-base-0-12-0-a1b2c3',
      sessionsBySnapshotSlug: new Map(),
      deletedSessionsBySnapshotSlug: new Map(),
    });

    expect(result).toBeNull();
  });
});

// ============================================================================
// classifyCloudVolume
// ============================================================================

describe('classifyCloudVolume', () => {
  test('build volume (hbb-*) is orphaned when not source of current base snapshot', () => {
    const volume = makeVolume({
      slug: 'hbb-build-abc123',
    });

    const result = assertResource(
      classifyCloudVolume(volume, {
        currentBaseVolumeSlug: null,
        sessionsByVolumeSlug: new Map(),
        deletedSessionsByVolumeSlug: new Map(),
      }),
    );

    expect(result.status).toBe('orphaned');
    expect(result.category).toBe('Build Volume');
    expect(result.provider).toBe('cloud');
    expect(result.kind).toBe('volume');
  });

  test('build volume (hbb-*) is current when source of current base snapshot', () => {
    const volume = makeVolume({
      slug: 'hbb-build-abc123',
    });

    const result = assertResource(
      classifyCloudVolume(volume, {
        currentBaseVolumeSlug: 'hbb-build-abc123',
        sessionsByVolumeSlug: new Map(),
        deletedSessionsByVolumeSlug: new Map(),
      }),
    );

    expect(result.status).toBe('current');
    expect(result.category).toBe('Build Volume');
  });

  test('build volume (hbb-*) is orphaned when different from current base volume', () => {
    const volume = makeVolume({
      slug: 'hbb-old-build-xyz789',
    });

    const result = assertResource(
      classifyCloudVolume(volume, {
        currentBaseVolumeSlug: 'hbb-build-abc123',
        sessionsByVolumeSlug: new Map(),
        deletedSessionsByVolumeSlug: new Map(),
      }),
    );

    expect(result.status).toBe('orphaned');
    expect(result.category).toBe('Build Volume');
  });

  test('active session volume (hs-*) linked to non-deleted session', () => {
    const volume = makeVolume({
      slug: 'hs-my-session-abc123',
    });
    const session = makeSession({
      volumeSlug: 'hs-my-session-abc123',
      name: 'my-session',
    });

    const result = assertResource(
      classifyCloudVolume(volume, {
        currentBaseVolumeSlug: null,
        sessionsByVolumeSlug: new Map([['hs-my-session-abc123', session]]),
        deletedSessionsByVolumeSlug: new Map(),
      }),
    );

    expect(result.status).toBe('active');
    expect(result.category).toBe('Session Volume');
    expect(result.sessionName).toBe('my-session');
  });

  test('active resume volume (hr-*) linked to non-deleted session', () => {
    const volume = makeVolume({
      slug: 'hr-resumed-abc123',
    });
    const session = makeSession({
      volumeSlug: 'hr-resumed-abc123',
      name: 'resumed-session',
    });

    const result = assertResource(
      classifyCloudVolume(volume, {
        currentBaseVolumeSlug: null,
        sessionsByVolumeSlug: new Map([['hr-resumed-abc123', session]]),
        deletedSessionsByVolumeSlug: new Map(),
      }),
    );

    expect(result.status).toBe('active');
    expect(result.category).toBe('Session Volume');
    expect(result.sessionName).toBe('resumed-session');
  });

  test('old session volume linked to deleted session', () => {
    const volume = makeVolume({
      slug: 'hs-deleted-abc123',
    });
    const deletedSession = makeSession({
      volumeSlug: 'hs-deleted-abc123',
      name: 'deleted-session',
    });

    const result = assertResource(
      classifyCloudVolume(volume, {
        currentBaseVolumeSlug: null,
        sessionsByVolumeSlug: new Map(),
        deletedSessionsByVolumeSlug: new Map([
          ['hs-deleted-abc123', deletedSession],
        ]),
      }),
    );

    expect(result.status).toBe('old');
    expect(result.category).toBe('Session Volume');
    expect(result.sessionName).toBe('deleted-session');
  });

  test('orphaned session volume has no session reference', () => {
    const volume = makeVolume({
      slug: 'hs-mystery-abc123',
    });

    const result = assertResource(
      classifyCloudVolume(volume, {
        currentBaseVolumeSlug: null,
        sessionsByVolumeSlug: new Map(),
        deletedSessionsByVolumeSlug: new Map(),
      }),
    );

    expect(result.status).toBe('orphaned');
    expect(result.category).toBe('Session Volume');
  });

  test('shell volume (hsh-*) is always orphaned', () => {
    const volume = makeVolume({
      slug: 'hsh-shell-abc123',
    });

    const result = assertResource(
      classifyCloudVolume(volume, {
        currentBaseVolumeSlug: null,
        sessionsByVolumeSlug: new Map(),
        deletedSessionsByVolumeSlug: new Map(),
      }),
    );

    expect(result.status).toBe('orphaned');
    expect(result.category).toBe('Shell Volume');
  });

  test('volume size and region are included', () => {
    const volume = makeVolume({
      slug: 'hs-sized-abc123',
      allocatedSize: 9999,
      region: 'ord',
      bootable: false,
    });

    const result = assertResource(
      classifyCloudVolume(volume, {
        currentBaseVolumeSlug: null,
        sessionsByVolumeSlug: new Map(),
        deletedSessionsByVolumeSlug: new Map(),
      }),
    );

    expect(result.size).toBe(9999);
    expect(result.region).toBe('ord');
    expect(result.bootable).toBe(false);
  });

  test('non-Hermes volume returns null', () => {
    const volume = makeVolume({
      slug: 'my-custom-volume',
    });

    const result = classifyCloudVolume(volume, {
      currentBaseVolumeSlug: null,
      sessionsByVolumeSlug: new Map(),
      deletedSessionsByVolumeSlug: new Map(),
    });

    expect(result).toBeNull();
  });
});

// ============================================================================
// classifyDockerImage
// ============================================================================

describe('classifyDockerImage', () => {
  test('current local build matches computeDockerfileHash', () => {
    const image = makeImage({
      repository: 'hermes-sandbox',
      tag: 'md5-abcdef123456',
    });

    const result = classifyDockerImage(image, {
      currentDockerfileHash: 'abcdef123456',
      currentGhcrTags: new Set([
        'ghcr.io/timescale/hermes/sandbox-slim:0.12.0',
        'ghcr.io/timescale/hermes/sandbox-slim:latest',
      ]),
      activeContainerIdPrefixes: new Set(),
    });

    expect(result.status).toBe('current');
    expect(result.category).toBe('Local Build');
    expect(result.provider).toBe('docker');
    expect(result.kind).toBe('image');
  });

  test('old local build does not match current hash', () => {
    const image = makeImage({
      repository: 'hermes-sandbox',
      tag: 'md5-oldoldhash999',
    });

    const result = classifyDockerImage(image, {
      currentDockerfileHash: 'abcdef123456',
      currentGhcrTags: new Set(),
      activeContainerIdPrefixes: new Set(),
    });

    expect(result.status).toBe('old');
    expect(result.category).toBe('Local Build');
  });

  test('current GHCR image matches version tag', () => {
    const image = makeImage({
      repository: 'ghcr.io/timescale/hermes/sandbox-slim',
      tag: '0.12.0',
    });

    const result = classifyDockerImage(image, {
      currentDockerfileHash: 'abcdef123456',
      currentGhcrTags: new Set([
        'ghcr.io/timescale/hermes/sandbox-slim:0.12.0',
        'ghcr.io/timescale/hermes/sandbox-slim:latest',
      ]),
      activeContainerIdPrefixes: new Set(),
    });

    expect(result.status).toBe('current');
    expect(result.category).toBe('GHCR Image');
  });

  test('current GHCR image matches latest tag', () => {
    const image = makeImage({
      repository: 'ghcr.io/timescale/hermes/sandbox-slim',
      tag: 'latest',
    });

    const result = classifyDockerImage(image, {
      currentDockerfileHash: 'abcdef123456',
      currentGhcrTags: new Set([
        'ghcr.io/timescale/hermes/sandbox-slim:0.12.0',
        'ghcr.io/timescale/hermes/sandbox-slim:latest',
      ]),
      activeContainerIdPrefixes: new Set(),
    });

    expect(result.status).toBe('current');
    expect(result.category).toBe('GHCR Image');
  });

  test('old GHCR image does not match current tags', () => {
    const image = makeImage({
      repository: 'ghcr.io/timescale/hermes/sandbox-slim',
      tag: '0.10.0',
    });

    const result = classifyDockerImage(image, {
      currentDockerfileHash: 'abcdef123456',
      currentGhcrTags: new Set([
        'ghcr.io/timescale/hermes/sandbox-slim:0.12.0',
        'ghcr.io/timescale/hermes/sandbox-slim:latest',
      ]),
      activeContainerIdPrefixes: new Set(),
    });

    expect(result.status).toBe('old');
    expect(result.category).toBe('GHCR Image');
  });

  test('GHCR full variant is also classified', () => {
    const image = makeImage({
      repository: 'ghcr.io/timescale/hermes/sandbox-full',
      tag: '0.12.0',
    });

    const result = classifyDockerImage(image, {
      currentDockerfileHash: 'abcdef123456',
      currentGhcrTags: new Set([
        'ghcr.io/timescale/hermes/sandbox-full:0.12.0',
        'ghcr.io/timescale/hermes/sandbox-full:latest',
      ]),
      activeContainerIdPrefixes: new Set(),
    });

    expect(result.status).toBe('current');
    expect(result.category).toBe('GHCR Image');
  });

  test('active resume image has matching container', () => {
    const image = makeImage({
      repository: 'hermes-resume',
      tag: 'abc123def456-x9y8z7',
      id: 'sha256:resumeimg001',
    });

    const result = classifyDockerImage(image, {
      currentDockerfileHash: 'abcdef123456',
      currentGhcrTags: new Set(),
      activeContainerIdPrefixes: new Set(['abc123def456']),
    });

    expect(result.status).toBe('active');
    expect(result.category).toBe('Resume Image');
  });

  test('orphaned resume image has no matching container', () => {
    const image = makeImage({
      repository: 'hermes-resume',
      tag: 'abc123def456-x9y8z7',
      id: 'sha256:resumeimg001',
    });

    const result = classifyDockerImage(image, {
      currentDockerfileHash: 'abcdef123456',
      currentGhcrTags: new Set(),
      activeContainerIdPrefixes: new Set(),
    });

    expect(result.status).toBe('orphaned');
    expect(result.category).toBe('Resume Image');
  });

  test('image size and created time are included', () => {
    const image = makeImage({
      repository: 'hermes-sandbox',
      tag: 'md5-abcdef123456',
      size: 123456789,
      created: '2025-02-01T12:00:00Z',
    });

    const result = classifyDockerImage(image, {
      currentDockerfileHash: 'abcdef123456',
      currentGhcrTags: new Set(),
      activeContainerIdPrefixes: new Set(),
    });

    expect(result.size).toBe(123456789);
    expect(result.createdAt).toBe('2025-02-01T12:00:00Z');
  });

  test('uses repository:tag as id (not Docker image ID) to avoid key collisions', () => {
    // Two different repo:tag combos can share the same Docker image ID
    const image1 = makeImage({
      id: 'sha256:sameid',
      repository: 'hermes-sandbox',
      tag: 'md5-abcdef123456',
    });
    const image2 = makeImage({
      id: 'sha256:sameid',
      repository: 'ghcr.io/timescale/hermes/sandbox-slim',
      tag: '0.12.0',
    });

    const ctx = {
      currentDockerfileHash: 'abcdef123456',
      currentGhcrTags: new Set([
        'ghcr.io/timescale/hermes/sandbox-slim:0.12.0',
      ]),
      activeContainerIdPrefixes: new Set<string>(),
    };

    const r1 = classifyDockerImage(image1, ctx);
    const r2 = classifyDockerImage(image2, ctx);

    // IDs must be unique even when Docker image IDs are the same
    expect(r1.id).not.toBe(r2.id);
    expect(r1.id).toBe('hermes-sandbox:md5-abcdef123456');
    expect(r2.id).toBe('ghcr.io/timescale/hermes/sandbox-slim:0.12.0');
  });
});

// ============================================================================
// getCleanupTargets
// ============================================================================

describe('getCleanupTargets', () => {
  test('returns only old and orphaned resources', () => {
    const resources: SandboxResource[] = [
      {
        id: '1',
        provider: 'cloud',
        kind: 'snapshot',
        name: 'current-snap',
        category: 'Base Snapshot',
        status: 'current',
      },
      {
        id: '2',
        provider: 'cloud',
        kind: 'snapshot',
        name: 'active-snap',
        category: 'Session Snapshot',
        status: 'active',
      },
      {
        id: '3',
        provider: 'cloud',
        kind: 'snapshot',
        name: 'old-snap',
        category: 'Session Snapshot',
        status: 'old',
      },
      {
        id: '4',
        provider: 'cloud',
        kind: 'volume',
        name: 'orphaned-vol',
        category: 'Build Volume',
        status: 'orphaned',
      },
      {
        id: '5',
        provider: 'docker',
        kind: 'image',
        name: 'current-img',
        category: 'Local Build',
        status: 'current',
      },
      {
        id: '6',
        provider: 'docker',
        kind: 'image',
        name: 'old-img',
        category: 'Local Build',
        status: 'old',
      },
    ];

    const targets = getCleanupTargets(resources);

    expect(targets).toHaveLength(3);
    const ids = targets.map((t) => t.id);
    expect(ids).toContain('3');
    expect(ids).toContain('4');
    expect(ids).toContain('6');
    // current and active should NOT be included
    expect(ids).not.toContain('1');
    expect(ids).not.toContain('2');
    expect(ids).not.toContain('5');
  });

  test('orders snapshots before volumes before images', () => {
    const resources: SandboxResource[] = [
      {
        id: 'img',
        provider: 'docker',
        kind: 'image',
        name: 'old-img',
        category: 'Local Build',
        status: 'old',
      },
      {
        id: 'vol',
        provider: 'cloud',
        kind: 'volume',
        name: 'old-vol',
        category: 'Session Volume',
        status: 'old',
      },
      {
        id: 'snap',
        provider: 'cloud',
        kind: 'snapshot',
        name: 'old-snap',
        category: 'Session Snapshot',
        status: 'old',
      },
    ];

    const targets = getCleanupTargets(resources);

    expect(targets).toHaveLength(3);
    expect(targets[0]?.kind).toBe('snapshot');
    expect(targets[1]?.kind).toBe('volume');
    expect(targets[2]?.kind).toBe('image');
  });

  test('returns empty array when no cleanup targets exist', () => {
    const resources: SandboxResource[] = [
      {
        id: '1',
        provider: 'cloud',
        kind: 'snapshot',
        name: 'current-snap',
        category: 'Base Snapshot',
        status: 'current',
      },
      {
        id: '2',
        provider: 'cloud',
        kind: 'volume',
        name: 'active-vol',
        category: 'Session Volume',
        status: 'active',
      },
    ];

    const targets = getCleanupTargets(resources);
    expect(targets).toHaveLength(0);
  });

  test('handles empty input', () => {
    const targets = getCleanupTargets([]);
    expect(targets).toHaveLength(0);
  });
});

// ============================================================================
// groupResourcesByKind
// ============================================================================

describe('groupResourcesByKind', () => {
  function makeResource(
    kind: 'snapshot' | 'volume' | 'image',
    name: string,
  ): SandboxResource {
    return {
      id: name,
      provider: kind === 'image' ? 'docker' : 'cloud',
      kind,
      name,
      category: 'Test',
      status: 'old',
    };
  }

  test('groups resources by kind in dependency order', () => {
    const resources = [
      makeResource('volume', 'vol-1'),
      makeResource('snapshot', 'snap-1'),
      makeResource('image', 'img-1'),
      makeResource('snapshot', 'snap-2'),
      makeResource('volume', 'vol-2'),
    ];

    const groups = groupResourcesByKind(resources);
    expect(groups).toHaveLength(3);

    // First group: snapshots
    expect(groups[0]?.map((r) => r.name)).toEqual(['snap-1', 'snap-2']);
    // Second group: volumes
    expect(groups[1]?.map((r) => r.name)).toEqual(['vol-1', 'vol-2']);
    // Third group: images
    expect(groups[2]?.map((r) => r.name)).toEqual(['img-1']);
  });

  test('returns single group when all same kind', () => {
    const resources = [
      makeResource('volume', 'vol-1'),
      makeResource('volume', 'vol-2'),
    ];

    const groups = groupResourcesByKind(resources);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
  });

  test('omits kinds with no resources', () => {
    const resources = [
      makeResource('snapshot', 'snap-1'),
      makeResource('image', 'img-1'),
    ];

    const groups = groupResourcesByKind(resources);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.[0]?.kind).toBe('snapshot');
    expect(groups[1]?.[0]?.kind).toBe('image');
  });

  test('handles empty input', () => {
    const groups = groupResourcesByKind([]);
    expect(groups).toHaveLength(0);
  });
});
