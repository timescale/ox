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
  propagateUnknownAncestry,
  type SandboxResource,
} from './resources.ts';
import type { OxSession } from './types.ts';

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
    slug: 'oxn-test-abc123',
    region: 'ord',
    allocatedSize: 1024 * 1024 * 100,
    flattenedSize: 1024 * 1024 * 200,
    bootable: true,
    volume: { id: 'vol_ord_xyz', slug: 'oxs-test-xyz' },
    ...overrides,
  };
}

function makeVolume(overrides?: Partial<DenoVolume>): DenoVolume {
  return {
    id: 'vol_ord_abc123',
    slug: 'oxs-test-abc123',
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
    repository: 'ox-sandbox',
    tag: 'md5-abcdef123456',
    size: 1024 * 1024 * 500,
    created: '2025-01-15T10:00:00Z',
    ...overrides,
  };
}

function makeSession(overrides?: Partial<OxSession>): OxSession {
  return {
    id: 'test-session-1',
    provider: 'cloud',
    name: 'test-session',
    branch: 'main',
    agent: 'claude',
    prompt: 'fix the bug',
    repo: 'timescale/ox',
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
  test('current ox-base-* base snapshot matches getBaseSnapshotSlug()', () => {
    const snapshot = makeSnapshot({
      slug: 'ox-base-a1b2c3d4e5f6',
    });

    const result = assertResource(
      classifyCloudSnapshot(snapshot, {
        currentBaseSlug: 'ox-base-a1b2c3d4e5f6',
        currentAgentSlugs: new Set(),
        currentSetupSlug: null,
        sessionsBySnapshotSlug: new Map(),
        deletedSessionsBySnapshotSlug: new Map(),
      }),
    );

    expect(result.status).toBe('current');
    expect(result.category).toBe('Base Snapshot');
    expect(result.provider).toBe('cloud');
    expect(result.kind).toBe('snapshot');
    expect(result.id).toBe('snp_ord_abc123');
    expect(result.name).toBe('ox-base-a1b2c3d4e5f6');
  });

  test('old ox-base-* base snapshot does not match current slug', () => {
    const snapshot = makeSnapshot({
      slug: 'ox-base-oldoldhash999',
    });

    const result = assertResource(
      classifyCloudSnapshot(snapshot, {
        currentBaseSlug: 'ox-base-a1b2c3d4e5f6',
        currentAgentSlugs: new Set(),
        currentSetupSlug: null,
        sessionsBySnapshotSlug: new Map(),
        deletedSessionsBySnapshotSlug: new Map(),
      }),
    );

    expect(result.status).toBe('unknown');
    expect(result.category).toBe('Base Snapshot');
  });

  test('active session snapshot linked to non-deleted session', () => {
    const snapshot = makeSnapshot({
      slug: 'oxn-my-session-abc123',
    });
    const session = makeSession({
      snapshotSlug: 'oxn-my-session-abc123',
      name: 'my-session',
    });

    const result = assertResource(
      classifyCloudSnapshot(snapshot, {
        currentBaseSlug: 'ox-base-a1b2c3d4e5f6',
        currentAgentSlugs: new Set(),
        currentSetupSlug: null,
        sessionsBySnapshotSlug: new Map([['oxn-my-session-abc123', session]]),
        deletedSessionsBySnapshotSlug: new Map(),
      }),
    );

    expect(result.status).toBe('active');
    expect(result.category).toBe('Session Snapshot');
    expect(result.sessionName).toBe('my-session');
  });

  test('old session snapshot linked to deleted session', () => {
    const snapshot = makeSnapshot({
      slug: 'oxn-old-session-abc123',
    });
    const deletedSession = makeSession({
      snapshotSlug: 'oxn-old-session-abc123',
      name: 'old-session',
    });

    const result = assertResource(
      classifyCloudSnapshot(snapshot, {
        currentBaseSlug: 'ox-base-a1b2c3d4e5f6',
        currentAgentSlugs: new Set(),
        currentSetupSlug: null,
        sessionsBySnapshotSlug: new Map(),
        deletedSessionsBySnapshotSlug: new Map([
          ['oxn-old-session-abc123', deletedSession],
        ]),
      }),
    );

    expect(result.status).toBe('old');
    expect(result.category).toBe('Session Snapshot');
    expect(result.sessionName).toBe('old-session');
  });

  test('orphaned session snapshot has no session reference', () => {
    const snapshot = makeSnapshot({
      slug: 'oxn-mystery-abc123',
    });

    const result = assertResource(
      classifyCloudSnapshot(snapshot, {
        currentBaseSlug: 'ox-base-a1b2c3d4e5f6',
        currentAgentSlugs: new Set(),
        currentSetupSlug: null,
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
      slug: 'oxn-sized-abc123',
      allocatedSize: 5000,
      region: 'ams',
    });

    const result = assertResource(
      classifyCloudSnapshot(snapshot, {
        currentBaseSlug: 'ox-base-a1b2c3d4e5f6',
        currentAgentSlugs: new Set(),
        currentSetupSlug: null,
        sessionsBySnapshotSlug: new Map(),
        deletedSessionsBySnapshotSlug: new Map(),
      }),
    );

    expect(result.size).toBe(5000);
    expect(result.region).toBe('ams');
    expect(result.bootable).toBe(true);
  });

  test('current agent snapshot matches currentAgentSlugs', () => {
    const snapshot = makeSnapshot({
      slug: 'ox-a1b2c3-claude-2-1-71',
    });

    const result = assertResource(
      classifyCloudSnapshot(snapshot, {
        currentBaseSlug: 'ox-base-a1b2c3d4e5f6',
        currentAgentSlugs: new Set(['ox-a1b2c3-claude-2-1-71']),
        currentSetupSlug: null,
        sessionsBySnapshotSlug: new Map(),
        deletedSessionsBySnapshotSlug: new Map(),
      }),
    );

    expect(result.status).toBe('current');
    expect(result.category).toBe('Agent Snapshot');
  });

  test('old agent snapshot does not match any current agent slug', () => {
    const snapshot = makeSnapshot({
      slug: 'ox-a1b2c3-claude-2-0-0',
    });

    const result = assertResource(
      classifyCloudSnapshot(snapshot, {
        currentBaseSlug: 'ox-base-a1b2c3d4e5f6',
        currentAgentSlugs: new Set(['ox-a1b2c3-claude-2-1-71']),
        currentSetupSlug: null,
        sessionsBySnapshotSlug: new Map(),
        deletedSessionsBySnapshotSlug: new Map(),
      }),
    );

    expect(result.status).toBe('unknown');
    expect(result.category).toBe('Agent Snapshot');
  });

  test('non-Ox snapshot returns null', () => {
    const snapshot = makeSnapshot({
      slug: 'my-custom-snapshot',
    });

    const result = classifyCloudSnapshot(snapshot, {
      currentBaseSlug: 'ox-base-a1b2c3d4e5f6',
      currentAgentSlugs: new Set(),
      currentSetupSlug: null,
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
      currentBaseSlug: 'ox-base-a1b2c3d4e5f6',
      currentAgentSlugs: new Set(),
      currentSetupSlug: null,
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
  const emptyCtx = {
    currentBaseVolumeSlug: null,
    sessionsByVolumeSlug: new Map(),
    deletedSessionsByVolumeSlug: new Map(),
    snapshotsByVolumeSlug: new Map(),
  };

  test('build volume (oxb-*) is orphaned when not source of current base snapshot and no child snapshots', () => {
    const volume = makeVolume({
      slug: 'oxb-build-abc123',
    });

    const result = assertResource(classifyCloudVolume(volume, { ...emptyCtx }));

    expect(result.status).toBe('orphaned');
    expect(result.category).toBe('Build Volume');
    expect(result.provider).toBe('cloud');
    expect(result.kind).toBe('volume');
  });

  test('build volume (oxb-*) is current when source of current base snapshot', () => {
    const volume = makeVolume({
      slug: 'oxb-build-abc123',
    });

    const result = assertResource(
      classifyCloudVolume(volume, {
        ...emptyCtx,
        currentBaseVolumeSlug: 'oxb-build-abc123',
      }),
    );

    expect(result.status).toBe('current');
    expect(result.category).toBe('Build Volume');
  });

  test('build volume (oxb-*) is orphaned when different from current base volume and no child snapshots', () => {
    const volume = makeVolume({
      slug: 'oxb-old-build-xyz789',
    });

    const result = assertResource(
      classifyCloudVolume(volume, {
        ...emptyCtx,
        currentBaseVolumeSlug: 'oxb-build-abc123',
      }),
    );

    expect(result.status).toBe('orphaned');
    expect(result.category).toBe('Build Volume');
  });

  test('build volume (oxb-*) is old when not current but has old child snapshots', () => {
    const volume = makeVolume({
      slug: 'oxb-old-build-xyz789',
    });

    const result = assertResource(
      classifyCloudVolume(volume, {
        ...emptyCtx,
        currentBaseVolumeSlug: 'oxb-build-abc123',
        snapshotsByVolumeSlug: new Map([
          [
            'oxb-old-build-xyz789',
            [{ slug: 'ox-base-0-11-0-oldold', status: 'unknown' }],
          ],
        ]),
      }),
    );

    expect(result.status).toBe('unknown');
    expect(result.category).toBe('Build Volume');
    expect(result.childSnapshotSlugs).toEqual(['ox-base-0-11-0-oldold']);
  });

  test('agent build volume (oxa-*) is orphaned when no child snapshots', () => {
    const volume = makeVolume({
      slug: 'oxa-build-abc123',
    });

    const result = assertResource(classifyCloudVolume(volume, { ...emptyCtx }));

    expect(result.status).toBe('orphaned');
    expect(result.category).toBe('Agent Build Volume');
  });

  test('agent build volume (oxa-*) is current when it has a current child snapshot', () => {
    const volume = makeVolume({
      slug: 'oxa-build-abc123',
    });

    const result = assertResource(
      classifyCloudVolume(volume, {
        ...emptyCtx,
        snapshotsByVolumeSlug: new Map([
          [
            'oxa-build-abc123',
            [{ slug: 'ox-0-17-0-claude-2-1-70', status: 'current' }],
          ],
        ]),
      }),
    );

    expect(result.status).toBe('current');
    expect(result.category).toBe('Agent Build Volume');
    expect(result.childSnapshotSlugs).toEqual(['ox-0-17-0-claude-2-1-70']);
  });

  test('agent build volume (oxa-*) is old when all child snapshots are old', () => {
    const volume = makeVolume({
      slug: 'oxa-build-abc123',
    });

    const result = assertResource(
      classifyCloudVolume(volume, {
        ...emptyCtx,
        snapshotsByVolumeSlug: new Map([
          [
            'oxa-build-abc123',
            [{ slug: 'ox-0-16-0-claude-2-0-0', status: 'unknown' }],
          ],
        ]),
      }),
    );

    expect(result.status).toBe('unknown');
    expect(result.category).toBe('Agent Build Volume');
    expect(result.childSnapshotSlugs).toEqual(['ox-0-16-0-claude-2-0-0']);
  });

  test('active session volume (oxs-*) linked to non-deleted session', () => {
    const volume = makeVolume({
      slug: 'oxs-my-session-abc123',
    });
    const session = makeSession({
      volumeSlug: 'oxs-my-session-abc123',
      name: 'my-session',
    });

    const result = assertResource(
      classifyCloudVolume(volume, {
        ...emptyCtx,
        sessionsByVolumeSlug: new Map([['oxs-my-session-abc123', session]]),
      }),
    );

    expect(result.status).toBe('active');
    expect(result.category).toBe('Session Volume');
    expect(result.sessionName).toBe('my-session');
  });

  test('active resume volume (oxr-*) linked to non-deleted session', () => {
    const volume = makeVolume({
      slug: 'oxr-resumed-abc123',
    });
    const session = makeSession({
      volumeSlug: 'oxr-resumed-abc123',
      name: 'resumed-session',
    });

    const result = assertResource(
      classifyCloudVolume(volume, {
        ...emptyCtx,
        sessionsByVolumeSlug: new Map([['oxr-resumed-abc123', session]]),
      }),
    );

    expect(result.status).toBe('active');
    expect(result.category).toBe('Session Volume');
    expect(result.sessionName).toBe('resumed-session');
  });

  test('old session volume linked to deleted session', () => {
    const volume = makeVolume({
      slug: 'oxs-deleted-abc123',
    });
    const deletedSession = makeSession({
      volumeSlug: 'oxs-deleted-abc123',
      name: 'deleted-session',
    });

    const result = assertResource(
      classifyCloudVolume(volume, {
        ...emptyCtx,
        deletedSessionsByVolumeSlug: new Map([
          ['oxs-deleted-abc123', deletedSession],
        ]),
      }),
    );

    expect(result.status).toBe('old');
    expect(result.category).toBe('Session Volume');
    expect(result.sessionName).toBe('deleted-session');
  });

  test('orphaned session volume has no session reference', () => {
    const volume = makeVolume({
      slug: 'oxs-mystery-abc123',
    });

    const result = assertResource(classifyCloudVolume(volume, { ...emptyCtx }));

    expect(result.status).toBe('orphaned');
    expect(result.category).toBe('Session Volume');
  });

  test('shell volume (oxe-*) is always orphaned', () => {
    const volume = makeVolume({
      slug: 'oxe-shell-abc123',
    });

    const result = assertResource(classifyCloudVolume(volume, { ...emptyCtx }));

    expect(result.status).toBe('orphaned');
    expect(result.category).toBe('Shell Volume');
  });

  test('volume size and region are included', () => {
    const volume = makeVolume({
      slug: 'oxs-sized-abc123',
      allocatedSize: 9999,
      region: 'ord',
      bootable: false,
    });

    const result = assertResource(classifyCloudVolume(volume, { ...emptyCtx }));

    expect(result.size).toBe(9999);
    expect(result.region).toBe('ord');
    expect(result.bootable).toBe(false);
  });

  test('non-Ox volume returns null', () => {
    const volume = makeVolume({
      slug: 'my-custom-volume',
    });

    const result = classifyCloudVolume(volume, { ...emptyCtx });

    expect(result).toBeNull();
  });

  test('snapshot sourceVolumeSlug is populated', () => {
    const snapshot = makeSnapshot({
      slug: 'ox-a1b2c3-claude-2-1-71',
      volume: { id: 'vol_abc', slug: 'oxa-build-abc123' },
    });

    const result = assertResource(
      classifyCloudSnapshot(snapshot, {
        currentBaseSlug: 'ox-base-a1b2c3d4e5f6',
        currentAgentSlugs: new Set(['ox-a1b2c3-claude-2-1-71']),
        currentSetupSlug: null,
        sessionsBySnapshotSlug: new Map(),
        deletedSessionsBySnapshotSlug: new Map(),
      }),
    );

    expect(result.sourceVolumeSlug).toBe('oxa-build-abc123');
  });

  test('volume baseSnapshotSlug is populated from DenoVolume.baseSnapshot', () => {
    const volume = makeVolume({
      slug: 'oxa-build-abc123',
      baseSnapshot: { id: 'snp_abc', slug: 'ox-base-0-17-0-a1b2c3' },
    });

    const result = assertResource(classifyCloudVolume(volume, { ...emptyCtx }));

    expect(result.baseSnapshotSlug).toBe('ox-base-0-17-0-a1b2c3');
  });

  test('volume baseSnapshotSlug is undefined when no baseSnapshot', () => {
    const volume = makeVolume({
      slug: 'oxb-build-abc123',
      baseSnapshot: null,
    });

    const result = assertResource(classifyCloudVolume(volume, { ...emptyCtx }));

    expect(result.baseSnapshotSlug).toBeUndefined();
  });
});

// ============================================================================
// classifyDockerImage
// ============================================================================

describe('classifyDockerImage', () => {
  test('current local build matches computeDockerfileHash', () => {
    const image = makeImage({
      repository: 'ox-sandbox',
      tag: 'md5-abcdef123456',
    });

    const result = classifyDockerImage(image, {
      currentDockerfileHash: 'abcdef123456',
      currentBaseTag: 'md5-abcdef123456',
      currentGhcrTags: new Set(['ghcr.io/timescale/ox/sandbox:abcdef123456']),
      currentLocalOverlayTags: new Set(),
      currentSetupLayerTags: new Set(),
      currentAncestorPrefixes: new Set(),
      activeContainerIdPrefixes: new Set(),
    });

    expect(result.status).toBe('current');
    expect(result.category).toBe('Local Build');
    expect(result.provider).toBe('docker');
    expect(result.kind).toBe('image');
  });

  test('old local build does not match current hash', () => {
    const image = makeImage({
      repository: 'ox-sandbox',
      tag: 'md5-oldoldhash999',
    });

    const result = classifyDockerImage(image, {
      currentDockerfileHash: 'abcdef123456',
      currentBaseTag: 'md5-abcdef123456',
      currentGhcrTags: new Set(),
      currentLocalOverlayTags: new Set(),
      currentSetupLayerTags: new Set(),
      currentAncestorPrefixes: new Set(),
      activeContainerIdPrefixes: new Set(),
    });

    expect(result.status).toBe('old');
    expect(result.category).toBe('Local Build');
  });

  test('current agent overlay image matches tag in currentLocalOverlayTags', () => {
    const image = makeImage({
      repository: 'ox-sandbox',
      tag: 'a-claude-abcdef-aaa111bbb222',
    });

    const result = classifyDockerImage(image, {
      currentDockerfileHash: 'abcdef123456',
      currentBaseTag: 'md5-abcdef123456',
      currentGhcrTags: new Set(),
      currentLocalOverlayTags: new Set(['a-claude-abcdef-aaa111bbb222']),
      currentSetupLayerTags: new Set(),
      currentAncestorPrefixes: new Set(['abcdef']),
      activeContainerIdPrefixes: new Set(),
    });

    expect(result.status).toBe('current');
    expect(result.category).toBe('Local Build');
  });

  test('agent overlay with current ancestor but different hash is unknown', () => {
    const image = makeImage({
      repository: 'ox-sandbox',
      tag: 'a-claude-abcdef-999888777666',
    });

    const result = classifyDockerImage(image, {
      currentDockerfileHash: 'abcdef123456',
      currentBaseTag: 'md5-abcdef123456',
      currentGhcrTags: new Set(),
      currentLocalOverlayTags: new Set(['a-claude-abcdef-aaa111bbb222']),
      currentSetupLayerTags: new Set(),
      currentAncestorPrefixes: new Set(['abcdef']),
      activeContainerIdPrefixes: new Set(),
    });

    expect(result.status).toBe('unknown');
    expect(result.category).toBe('Local Build');
  });

  test('agent overlay with old ancestor is old', () => {
    const image = makeImage({
      repository: 'ox-sandbox',
      tag: 'a-claude-999999-aaa111bbb222',
    });

    const result = classifyDockerImage(image, {
      currentDockerfileHash: 'abcdef123456',
      currentBaseTag: 'md5-abcdef123456',
      currentGhcrTags: new Set(),
      currentLocalOverlayTags: new Set(['a-claude-abcdef-aaa111bbb222']),
      currentSetupLayerTags: new Set(),
      currentAncestorPrefixes: new Set(['abcdef']),
      activeContainerIdPrefixes: new Set(),
    });

    expect(result.status).toBe('old');
    expect(result.category).toBe('Local Build');
  });

  test('current GHCR image matches content hash tag', () => {
    const image = makeImage({
      repository: 'ghcr.io/timescale/ox/sandbox',
      tag: 'abcdef123456',
    });

    const result = classifyDockerImage(image, {
      currentDockerfileHash: 'abcdef123456',
      currentBaseTag: 'md5-abcdef123456',
      currentGhcrTags: new Set(['ghcr.io/timescale/ox/sandbox:abcdef123456']),
      currentLocalOverlayTags: new Set(),
      currentSetupLayerTags: new Set(),
      currentAncestorPrefixes: new Set(),
      activeContainerIdPrefixes: new Set(),
    });

    expect(result.status).toBe('current');
    expect(result.category).toBe('GHCR Image');
  });

  test('current GHCR agent image matches tag', () => {
    const image = makeImage({
      repository: 'ghcr.io/timescale/ox/sandbox',
      tag: 'abcdef123456-claude-2.1.71',
    });

    const result = classifyDockerImage(image, {
      currentDockerfileHash: 'abcdef123456',
      currentBaseTag: 'md5-abcdef123456',
      currentGhcrTags: new Set([
        'ghcr.io/timescale/ox/sandbox:abcdef123456',
        'ghcr.io/timescale/ox/sandbox:abcdef123456-claude-2.1.71',
      ]),
      currentLocalOverlayTags: new Set(),
      currentSetupLayerTags: new Set(),
      currentAncestorPrefixes: new Set(),
      activeContainerIdPrefixes: new Set(),
    });

    expect(result.status).toBe('current');
    expect(result.category).toBe('GHCR Image');
  });

  test('old GHCR image does not match current tags', () => {
    const image = makeImage({
      repository: 'ghcr.io/timescale/ox/sandbox',
      tag: 'oldoldhash9999',
    });

    const result = classifyDockerImage(image, {
      currentDockerfileHash: 'abcdef123456',
      currentBaseTag: 'md5-abcdef123456',
      currentGhcrTags: new Set(['ghcr.io/timescale/ox/sandbox:abcdef123456']),
      currentLocalOverlayTags: new Set(),
      currentSetupLayerTags: new Set(),
      currentAncestorPrefixes: new Set(),
      activeContainerIdPrefixes: new Set(),
    });

    expect(result.status).toBe('old');
    expect(result.category).toBe('GHCR Image');
  });

  test('legacy GHCR sandbox-slim images are classified as old', () => {
    const image = makeImage({
      repository: 'ghcr.io/timescale/ox/sandbox-slim',
      tag: '0.12.0',
    });

    const result = classifyDockerImage(image, {
      currentDockerfileHash: 'abcdef123456',
      currentBaseTag: 'md5-abcdef123456',
      currentGhcrTags: new Set(['ghcr.io/timescale/ox/sandbox:abcdef123456']),
      currentLocalOverlayTags: new Set(),
      currentSetupLayerTags: new Set(),
      currentAncestorPrefixes: new Set(),
      activeContainerIdPrefixes: new Set(),
    });

    expect(result.status).toBe('old');
    expect(result.category).toBe('GHCR Image');
  });

  test('active resume image has matching container', () => {
    const image = makeImage({
      repository: 'ox-resume',
      tag: 'abc123def456-x9y8z7',
      id: 'sha256:resumeimg001',
    });

    const result = classifyDockerImage(image, {
      currentDockerfileHash: 'abcdef123456',
      currentBaseTag: 'md5-abcdef123456',
      currentGhcrTags: new Set(),
      currentLocalOverlayTags: new Set(),
      currentSetupLayerTags: new Set(),
      currentAncestorPrefixes: new Set(),
      activeContainerIdPrefixes: new Set(['abc123def456']),
    });

    expect(result.status).toBe('active');
    expect(result.category).toBe('Resume Image');
  });

  test('orphaned resume image has no matching container', () => {
    const image = makeImage({
      repository: 'ox-resume',
      tag: 'abc123def456-x9y8z7',
      id: 'sha256:resumeimg001',
    });

    const result = classifyDockerImage(image, {
      currentDockerfileHash: 'abcdef123456',
      currentBaseTag: 'md5-abcdef123456',
      currentGhcrTags: new Set(),
      currentLocalOverlayTags: new Set(),
      currentSetupLayerTags: new Set(),
      currentAncestorPrefixes: new Set(),
      activeContainerIdPrefixes: new Set(),
    });

    expect(result.status).toBe('orphaned');
    expect(result.category).toBe('Resume Image');
  });

  test('image size and created time are included', () => {
    const image = makeImage({
      repository: 'ox-sandbox',
      tag: 'md5-abcdef123456',
      size: 123456789,
      created: '2025-02-01T12:00:00Z',
    });

    const result = classifyDockerImage(image, {
      currentDockerfileHash: 'abcdef123456',
      currentBaseTag: 'md5-abcdef123456',
      currentGhcrTags: new Set(),
      currentLocalOverlayTags: new Set(),
      currentSetupLayerTags: new Set(),
      currentAncestorPrefixes: new Set(),
      activeContainerIdPrefixes: new Set(),
    });

    expect(result.size).toBe(123456789);
    expect(result.createdAt).toBe('2025-02-01T12:00:00Z');
  });

  test('uses repository:tag as id (not Docker image ID) to avoid key collisions', () => {
    // Two different repo:tag combos can share the same Docker image ID
    const image1 = makeImage({
      id: 'sha256:sameid',
      repository: 'ox-sandbox',
      tag: 'md5-abcdef123456',
    });
    const image2 = makeImage({
      id: 'sha256:sameid',
      repository: 'ghcr.io/timescale/ox/sandbox',
      tag: 'abcdef123456',
    });

    const ctx = {
      currentDockerfileHash: 'abcdef123456',
      currentBaseTag: 'md5-abcdef123456',
      currentGhcrTags: new Set(['ghcr.io/timescale/ox/sandbox:abcdef123456']),
      currentLocalOverlayTags: new Set<string>(),
      currentSetupLayerTags: new Set<string>(),
      currentAncestorPrefixes: new Set<string>(),
      activeContainerIdPrefixes: new Set<string>(),
    };

    const r1 = classifyDockerImage(image1, ctx);
    const r2 = classifyDockerImage(image2, ctx);

    // IDs must be unique even when Docker image IDs are the same
    expect(r1.id).not.toBe(r2.id);
    expect(r1.id).toBe('ox-sandbox:md5-abcdef123456');
    expect(r2.id).toBe('ghcr.io/timescale/ox/sandbox:abcdef123456');
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

  test('returns all eligible resources regardless of kind order', () => {
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
    const ids = targets.map((t) => t.id);
    expect(ids).toContain('img');
    expect(ids).toContain('vol');
    expect(ids).toContain('snap');
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
// groupResourcesByKind (topological sort)
// ============================================================================

describe('groupResourcesByKind', () => {
  /** Helper to get the group index a resource name appears in */
  function groupIndexOf(groups: SandboxResource[][], name: string): number {
    return groups.findIndex((g) => g.some((r) => r.name === name));
  }

  test('handles empty input', () => {
    const groups = groupResourcesByKind([]);
    expect(groups).toHaveLength(0);
  });

  test('resources with no dependencies are all in one group', () => {
    const resources: SandboxResource[] = [
      {
        id: 'snap-1',
        provider: 'cloud',
        kind: 'snapshot',
        name: 'snap-1',
        category: 'Test',
        status: 'old',
      },
      {
        id: 'img-1',
        provider: 'docker',
        kind: 'image',
        name: 'img-1',
        category: 'Test',
        status: 'old',
      },
      {
        id: 'vol-1',
        provider: 'cloud',
        kind: 'volume',
        name: 'vol-1',
        category: 'Test',
        status: 'old',
      },
    ];

    const groups = groupResourcesByKind(resources);
    // No dependency links → everything can be deleted in parallel
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
  });

  test('volume with baseSnapshotSlug is deleted before its base snapshot', () => {
    const resources: SandboxResource[] = [
      {
        id: 'snap-base',
        provider: 'cloud',
        kind: 'snapshot',
        name: 'ox-base-0-17-1',
        category: 'Base Snapshot',
        status: 'old',
      },
      {
        id: 'vol-agent',
        provider: 'cloud',
        kind: 'volume',
        name: 'oxa-build-abc',
        category: 'Agent Build Volume',
        status: 'old',
        baseSnapshotSlug: 'ox-base-0-17-1',
      },
    ];

    const groups = groupResourcesByKind(resources);
    expect(groups).toHaveLength(2);
    // Volume must come first (it depends on the snapshot)
    expect(groups[0]?.map((r) => r.name)).toEqual(['oxa-build-abc']);
    expect(groups[1]?.map((r) => r.name)).toEqual(['ox-base-0-17-1']);
  });

  test('snapshot with sourceVolumeSlug is deleted before its source volume', () => {
    const resources: SandboxResource[] = [
      {
        id: 'vol-build',
        provider: 'cloud',
        kind: 'volume',
        name: 'oxb-build-xyz',
        category: 'Build Volume',
        status: 'old',
      },
      {
        id: 'snap-from-vol',
        provider: 'cloud',
        kind: 'snapshot',
        name: 'ox-base-0-17-1',
        category: 'Base Snapshot',
        status: 'old',
        sourceVolumeSlug: 'oxb-build-xyz',
      },
    ];

    const groups = groupResourcesByKind(resources);
    expect(groups).toHaveLength(2);
    // Snapshot must come first (it depends on the volume)
    expect(groups[0]?.map((r) => r.name)).toEqual(['ox-base-0-17-1']);
    expect(groups[1]?.map((r) => r.name)).toEqual(['oxb-build-xyz']);
  });

  test('full chain: build vol → base snap → agent vol → agent snap → session vol', () => {
    const resources: SandboxResource[] = [
      {
        id: 'vol-build',
        provider: 'cloud',
        kind: 'volume',
        name: 'oxb-build-001',
        category: 'Build Volume',
        status: 'old',
      },
      {
        id: 'snap-base',
        provider: 'cloud',
        kind: 'snapshot',
        name: 'ox-base-0-17-1-abc',
        category: 'Base Snapshot',
        status: 'old',
        sourceVolumeSlug: 'oxb-build-001',
      },
      {
        id: 'vol-agent',
        provider: 'cloud',
        kind: 'volume',
        name: 'oxa-agent-002',
        category: 'Agent Build Volume',
        status: 'old',
        baseSnapshotSlug: 'ox-base-0-17-1-abc',
      },
      {
        id: 'snap-agent',
        provider: 'cloud',
        kind: 'snapshot',
        name: 'ox-0-17-1-claude-2-1-71',
        category: 'Agent Snapshot',
        status: 'old',
        sourceVolumeSlug: 'oxa-agent-002',
      },
      {
        id: 'vol-session',
        provider: 'cloud',
        kind: 'volume',
        name: 'oxs-session-003',
        category: 'Session Volume',
        status: 'old',
        baseSnapshotSlug: 'ox-0-17-1-claude-2-1-71',
      },
    ];

    const groups = groupResourcesByKind(resources);

    // The chain is:
    //   oxs-session-003 (vol, depends on ox-0-17-1-claude-2-1-71)
    //   → ox-0-17-1-claude-2-1-71 (snap, depends on oxa-agent-002)
    //   → oxa-agent-002 (vol, depends on ox-base-0-17-1-abc)
    //   → ox-base-0-17-1-abc (snap, depends on oxb-build-001)
    //   → oxb-build-001 (vol, no deps in set)
    //
    // So deletion order should be: session vol → agent snap → agent vol → base snap → build vol

    // Verify ordering: each resource must be in an earlier group than its dependency
    const sessionVolIdx = groupIndexOf(groups, 'oxs-session-003');
    const agentSnapIdx = groupIndexOf(groups, 'ox-0-17-1-claude-2-1-71');
    const agentVolIdx = groupIndexOf(groups, 'oxa-agent-002');
    const baseSnapIdx = groupIndexOf(groups, 'ox-base-0-17-1-abc');
    const buildVolIdx = groupIndexOf(groups, 'oxb-build-001');

    expect(sessionVolIdx).toBeLessThan(agentSnapIdx);
    expect(agentSnapIdx).toBeLessThan(agentVolIdx);
    expect(agentVolIdx).toBeLessThan(baseSnapIdx);
    expect(baseSnapIdx).toBeLessThan(buildVolIdx);
  });

  test('independent resources are grouped together for parallel deletion', () => {
    // Two independent chains + a standalone image
    const resources: SandboxResource[] = [
      // Chain 1: vol-A depends on snap-A
      {
        id: 'snap-A',
        provider: 'cloud',
        kind: 'snapshot',
        name: 'snap-A',
        category: 'Base Snapshot',
        status: 'old',
      },
      {
        id: 'vol-A',
        provider: 'cloud',
        kind: 'volume',
        name: 'vol-A',
        category: 'Agent Build Volume',
        status: 'old',
        baseSnapshotSlug: 'snap-A',
      },
      // Chain 2: vol-B depends on snap-B
      {
        id: 'snap-B',
        provider: 'cloud',
        kind: 'snapshot',
        name: 'snap-B',
        category: 'Base Snapshot',
        status: 'old',
      },
      {
        id: 'vol-B',
        provider: 'cloud',
        kind: 'volume',
        name: 'vol-B',
        category: 'Agent Build Volume',
        status: 'old',
        baseSnapshotSlug: 'snap-B',
      },
      // Standalone image (no cloud dependencies)
      {
        id: 'img-1',
        provider: 'docker',
        kind: 'image',
        name: 'img-1',
        category: 'Local Build',
        status: 'old',
      },
    ];

    const groups = groupResourcesByKind(resources);
    expect(groups).toHaveLength(2);

    // First group: both volumes + the image (all have no blocking deps)
    const firstNames = groups[0]?.map((r) => r.name).sort();
    expect(firstNames).toEqual(['img-1', 'vol-A', 'vol-B']);

    // Second group: both snapshots (now unblocked)
    const secondNames = groups[1]?.map((r) => r.name).sort();
    expect(secondNames).toEqual(['snap-A', 'snap-B']);
  });

  test('dependency on resource NOT in cleanup set is ignored', () => {
    // Volume depends on a snapshot that is NOT being cleaned up (e.g. still current)
    const resources: SandboxResource[] = [
      {
        id: 'vol-1',
        provider: 'cloud',
        kind: 'volume',
        name: 'oxa-build-001',
        category: 'Agent Build Volume',
        status: 'orphaned',
        baseSnapshotSlug: 'ox-base-current', // not in cleanup set
      },
    ];

    const groups = groupResourcesByKind(resources);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(1);
  });

  test('single resource returns single group', () => {
    const resources: SandboxResource[] = [
      {
        id: 'vol-1',
        provider: 'cloud',
        kind: 'volume',
        name: 'vol-1',
        category: 'Test',
        status: 'old',
      },
    ];

    const groups = groupResourcesByKind(resources);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(1);
  });
});

// ============================================================================
// classifyCloudSnapshot — project setup layer
// ============================================================================

describe('classifyCloudSnapshot — project setup layer', () => {
  const baseCtx = {
    currentBaseSlug: 'ox-base-abc123def456',
    currentAgentSlugs: new Set<string>(),
    currentSetupSlug: 'oxl-setup123abc',
    sessionsBySnapshotSlug: new Map(),
    deletedSessionsBySnapshotSlug: new Map(),
  };

  test('classifies current oxl- snapshot as current', () => {
    const result = assertResource(
      classifyCloudSnapshot(
        makeSnapshot({
          slug: 'oxl-setup123abc',
          volume: { id: 'vol-1', slug: 'oxlb-vol1' },
        }),
        baseCtx,
      ),
    );
    expect(result.category).toBe('Project Setup Snapshot');
    expect(result.status).toBe('current');
  });

  test('classifies non-matching oxl- snapshot as unknown', () => {
    const result = assertResource(
      classifyCloudSnapshot(
        makeSnapshot({
          slug: 'oxl-oldsetup456',
          volume: { id: 'vol-2', slug: 'oxlb-vol2' },
        }),
        baseCtx,
      ),
    );
    expect(result.category).toBe('Project Setup Snapshot');
    expect(result.status).toBe('unknown');
  });

  test('classifies oxl- as unknown when no setup configured', () => {
    const result = assertResource(
      classifyCloudSnapshot(
        makeSnapshot({
          slug: 'oxl-anything',
          volume: { id: 'vol-3', slug: 'oxlb-vol3' },
        }),
        { ...baseCtx, currentSetupSlug: null },
      ),
    );
    expect(result.category).toBe('Project Setup Snapshot');
    expect(result.status).toBe('unknown');
  });
});

// ============================================================================
// classifyCloudVolume — project setup build volume
// ============================================================================

describe('classifyCloudVolume — project setup build volume', () => {
  const emptyCtx = {
    currentBaseVolumeSlug: null,
    sessionsByVolumeSlug: new Map(),
    deletedSessionsByVolumeSlug: new Map(),
    snapshotsByVolumeSlug: new Map(),
  };

  test('classifies oxlb- volume with current child as current', () => {
    const result = assertResource(
      classifyCloudVolume(makeVolume({ slug: 'oxlb-build1' }), {
        ...emptyCtx,
        snapshotsByVolumeSlug: new Map([
          [
            'oxlb-build1',
            [{ slug: 'oxl-setup123abc', status: 'current' as const }],
          ],
        ]),
      }),
    );
    expect(result.category).toBe('Project Setup Build Volume');
    expect(result.status).toBe('current');
  });

  test('classifies oxlb- volume with no children as orphaned', () => {
    const result = assertResource(
      classifyCloudVolume(makeVolume({ slug: 'oxlb-orphan' }), emptyCtx),
    );
    expect(result.category).toBe('Project Setup Build Volume');
    expect(result.status).toBe('orphaned');
  });

  test('classifies oxlb- volume with only unknown children as unknown', () => {
    const result = assertResource(
      classifyCloudVolume(makeVolume({ slug: 'oxlb-old' }), {
        ...emptyCtx,
        snapshotsByVolumeSlug: new Map([
          ['oxlb-old', [{ slug: 'oxl-oldsetup', status: 'unknown' as const }]],
        ]),
      }),
    );
    expect(result.category).toBe('Project Setup Build Volume');
    expect(result.status).toBe('unknown');
  });
});

// ============================================================================
// classifyDockerImage — project setup layer
// ============================================================================

describe('classifyDockerImage — project setup layer', () => {
  const baseCtx = {
    currentDockerfileHash: 'abc123def456',
    currentBaseTag: 'md5-abc123def456',
    currentGhcrTags: new Set<string>(),
    currentLocalOverlayTags: new Set<string>(),
    currentSetupLayerTags: new Set(['psl-abc123-setup789012ab']),
    currentAncestorPrefixes: new Set(['abc123']),
    activeContainerIdPrefixes: new Set<string>(),
  };

  test('classifies current setup layer image as current', () => {
    const result = classifyDockerImage(
      makeImage({
        repository: 'ox-sandbox',
        tag: 'psl-abc123-setup789012ab',
      }),
      baseCtx,
    );
    expect(result.category).toBe('Local Build');
    expect(result.status).toBe('current');
  });

  test('classifies setup layer with current ancestor but different hash as unknown', () => {
    const result = classifyDockerImage(
      makeImage({
        repository: 'ox-sandbox',
        tag: 'psl-abc123-differenthash',
      }),
      baseCtx,
    );
    expect(result.category).toBe('Local Build');
    expect(result.status).toBe('unknown');
  });

  test('classifies setup layer with old ancestor as old', () => {
    const result = classifyDockerImage(
      makeImage({
        repository: 'ox-sandbox',
        tag: 'psl-999999-oldsetup12345',
      }),
      baseCtx,
    );
    expect(result.category).toBe('Local Build');
    expect(result.status).toBe('old');
  });

  test('classifies old-format setup layer tags as old', () => {
    const result = classifyDockerImage(
      makeImage({
        repository: 'ox-sandbox',
        tag: 'md5-abc123def456-l-setup789012',
      }),
      baseCtx,
    );
    expect(result.category).toBe('Local Build');
    expect(result.status).toBe('old');
  });
});

// ============================================================================
// propagateUnknownAncestry
// ============================================================================

describe('propagateUnknownAncestry', () => {
  test('promotes descendants of unknown Docker layers to unknown', () => {
    const resources: SandboxResource[] = [
      {
        id: '1',
        provider: 'docker',
        kind: 'image',
        category: 'Local Build',
        status: 'unknown',
        name: 'ox-sandbox:dkr-abc123-dddddddddddd',
        size: 1,
      },
      {
        id: '2',
        provider: 'docker',
        kind: 'image',
        category: 'Local Build',
        status: 'old',
        name: 'ox-sandbox:psl-dddddd-pppppppppppp',
        size: 1,
      },
      {
        id: '3',
        provider: 'docker',
        kind: 'image',
        category: 'Local Build',
        status: 'old',
        name: 'ox-sandbox:a-codex-pppppp-aaaaaaaaaaaa',
        size: 1,
      },
    ];

    propagateUnknownAncestry(resources, new Set(['abc123']));

    expect(resources[1]?.status).toBe('unknown');
    expect(resources[2]?.status).toBe('unknown');
  });
});
