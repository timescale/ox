// ============================================================================
// Resource Discovery & Classification Service
//
// Discovers all sandbox-related resources (cloud volumes, snapshots, Docker
// images) and classifies each as current/active/old/orphaned to support
// the resource cleanup workflow.
// ============================================================================

import SLIM_DOCKERFILE from '../../../sandbox/slim.Dockerfile' with {
  type: 'text',
};
import { getDenoToken } from '../deno.ts';
import {
  computeDockerfileHash,
  type DockerImageInfo,
  getGhcrImageTags,
  listHermesSessions as listDockerContainers,
  listHermesImages,
} from '../docker.ts';
import { log } from '../logger.ts';
import { getBaseSnapshotSlug } from './cloudSnapshot.ts';
import {
  DenoApiClient,
  type DenoSnapshot,
  type DenoVolume,
} from './denoApi.ts';
import {
  listAllSessionsIncludingDeleted,
  listSessions,
  openSessionDb,
} from './sessionDb.ts';
import type { HermesSession } from './types.ts';

// ============================================================================
// Types
// ============================================================================

export type ResourceProvider = 'cloud' | 'docker';
export type ResourceKind = 'snapshot' | 'volume' | 'image';
export type ResourceStatus = 'current' | 'active' | 'old' | 'orphaned';

export interface SandboxResource {
  id: string;
  provider: ResourceProvider;
  kind: ResourceKind;
  name: string;
  category: string;
  status: ResourceStatus;
  size?: number;
  region?: string;
  bootable?: boolean;
  sessionName?: string;
  createdAt?: string;
}

// ============================================================================
// Classification Context Types (passed to pure classification functions)
// ============================================================================

interface SnapshotClassificationContext {
  currentBaseSlug: string;
  sessionsBySnapshotSlug: Map<string, HermesSession>;
  deletedSessionsBySnapshotSlug: Map<string, HermesSession>;
}

interface VolumeClassificationContext {
  /** Slug of the volume that is the source of the current base snapshot (if known) */
  currentBaseVolumeSlug: string | null;
  sessionsByVolumeSlug: Map<string, HermesSession>;
  deletedSessionsByVolumeSlug: Map<string, HermesSession>;
}

interface ImageClassificationContext {
  currentDockerfileHash: string;
  currentGhcrTags: Set<string>;
  /** Container ID prefixes (12-char) for active containers */
  activeContainerIdPrefixes: Set<string>;
}

// ============================================================================
// Classification Functions (pure — no API calls)
// ============================================================================

/** Known Hermes snapshot slug prefixes. */
const HERMES_SNAPSHOT_PREFIXES = ['hermes-base-', 'hsnap-'];

/** Known Hermes volume slug prefixes. */
const HERMES_VOLUME_PREFIXES = ['hbb-', 'hsh-', 'hs-', 'hr-'];

/**
 * Classify a cloud snapshot as current/active/old/orphaned.
 * Returns null for non-Hermes snapshots (unrecognized slug prefix).
 *
 * Rules:
 * - `hermes-base-*` → "Base Snapshot": `current` if matches getBaseSnapshotSlug(), else `old`
 * - `hsnap-*` → "Session Snapshot": `active` if linked to non-deleted session,
 *   `old` if linked to deleted session, `orphaned` if no session reference
 * - Other prefixes → null (not a Hermes resource, skip)
 */
export function classifyCloudSnapshot(
  snapshot: DenoSnapshot,
  ctx: SnapshotClassificationContext,
): SandboxResource | null {
  // Skip non-Hermes snapshots entirely to avoid accidental cleanup
  if (!HERMES_SNAPSHOT_PREFIXES.some((p) => snapshot.slug.startsWith(p))) {
    return null;
  }

  const base: Omit<SandboxResource, 'category' | 'status' | 'sessionName'> = {
    id: snapshot.id,
    provider: 'cloud',
    kind: 'snapshot',
    name: snapshot.slug,
    size: snapshot.allocatedSize,
    region: snapshot.region,
    bootable: snapshot.bootable,
  };

  // Base snapshots
  if (snapshot.slug.startsWith('hermes-base-')) {
    return {
      ...base,
      category: 'Base Snapshot',
      status: snapshot.slug === ctx.currentBaseSlug ? 'current' : 'old',
    };
  }

  // Session snapshots (hsnap-*)
  const activeSession = ctx.sessionsBySnapshotSlug.get(snapshot.slug);
  if (activeSession) {
    return {
      ...base,
      category: 'Session Snapshot',
      status: 'active',
      sessionName: activeSession.name,
    };
  }

  const deletedSession = ctx.deletedSessionsBySnapshotSlug.get(snapshot.slug);
  if (deletedSession) {
    return {
      ...base,
      category: 'Session Snapshot',
      status: 'old',
      sessionName: deletedSession.name,
    };
  }

  return {
    ...base,
    category: 'Session Snapshot',
    status: 'orphaned',
  };
}

/**
 * Classify a cloud volume as current/active/old/orphaned.
 * Returns null for non-Hermes volumes (unrecognized slug prefix).
 *
 * Rules:
 * - `hbb-*` → "Build Volume": `current` if it is the source volume of the
 *   current base snapshot, else `orphaned`
 * - `hs-*` / `hr-*` → "Session Volume": `active` if linked to non-deleted session,
 *   `old` if linked to deleted session, `orphaned` if no session reference
 * - `hsh-*` → "Shell Volume": always `orphaned` (ephemeral, shouldn't persist)
 * - Other prefixes → null (not a Hermes resource, skip)
 */
export function classifyCloudVolume(
  volume: DenoVolume,
  ctx: VolumeClassificationContext,
): SandboxResource | null {
  // Skip non-Hermes volumes entirely to avoid accidental cleanup
  if (!HERMES_VOLUME_PREFIXES.some((p) => volume.slug.startsWith(p))) {
    return null;
  }

  const base: Omit<SandboxResource, 'category' | 'status' | 'sessionName'> = {
    id: volume.id,
    provider: 'cloud',
    kind: 'volume',
    name: volume.slug,
    size: volume.allocatedSize,
    region: volume.region,
    bootable: volume.bootable,
  };

  // Build volumes — current if source of the current base snapshot, else orphaned
  if (volume.slug.startsWith('hbb-')) {
    return {
      ...base,
      category: 'Build Volume',
      status:
        ctx.currentBaseVolumeSlug && volume.slug === ctx.currentBaseVolumeSlug
          ? 'current'
          : 'orphaned',
    };
  }

  // Shell volumes — always orphaned
  if (volume.slug.startsWith('hsh-')) {
    return {
      ...base,
      category: 'Shell Volume',
      status: 'orphaned',
    };
  }

  // Session volumes (hs-* or hr-*)
  const activeSession = ctx.sessionsByVolumeSlug.get(volume.slug);
  if (activeSession) {
    return {
      ...base,
      category: 'Session Volume',
      status: 'active',
      sessionName: activeSession.name,
    };
  }

  const deletedSession = ctx.deletedSessionsByVolumeSlug.get(volume.slug);
  if (deletedSession) {
    return {
      ...base,
      category: 'Session Volume',
      status: 'old',
      sessionName: deletedSession.name,
    };
  }

  return {
    ...base,
    category: 'Session Volume',
    status: 'orphaned',
  };
}

/**
 * Classify a Docker image as current/active/old/orphaned.
 *
 * Rules:
 * - `hermes-sandbox:md5-*` → "Local Build": `current` if hash matches, else `old`
 * - `ghcr.io/timescale/hermes/sandbox-*` → "GHCR Image": `current` if tag is current, else `old`
 * - `hermes-resume:*` → "Resume Image": `active` if container exists with matching image, else `orphaned`
 */
export function classifyDockerImage(
  image: DockerImageInfo,
  ctx: ImageClassificationContext,
): SandboxResource {
  // Use repository:tag as ID (not Docker image ID) because multiple
  // tags can share the same Docker image ID, causing key collisions.
  const fullName = `${image.repository}:${image.tag}`;
  const base: Omit<SandboxResource, 'category' | 'status'> = {
    id: fullName,
    provider: 'docker',
    kind: 'image',
    name: fullName,
    size: image.size,
    createdAt: image.created,
  };

  // Local builds (hermes-sandbox:md5-*)
  if (image.repository === 'hermes-sandbox' && image.tag.startsWith('md5-')) {
    const hash = image.tag.slice(4); // strip 'md5-' prefix
    return {
      ...base,
      category: 'Local Build',
      status: hash === ctx.currentDockerfileHash ? 'current' : 'old',
    };
  }

  // GHCR images (ghcr.io/timescale/hermes/sandbox-*)
  if (image.repository.startsWith('ghcr.io/timescale/hermes/sandbox-')) {
    const fullTag = `${image.repository}:${image.tag}`;
    return {
      ...base,
      category: 'GHCR Image',
      status: ctx.currentGhcrTags.has(fullTag) ? 'current' : 'old',
    };
  }

  // Resume images (hermes-resume:<containerId-12>-<nanoid-6>)
  if (image.repository === 'hermes-resume') {
    // The tag format is: <12-char-container-id>-<6-char-nanoid>
    // Check if any active container has a matching ID prefix
    const containerIdPrefix = image.tag.slice(0, 12);
    const isActive = ctx.activeContainerIdPrefixes.has(containerIdPrefix);
    return {
      ...base,
      category: 'Resume Image',
      status: isActive ? 'active' : 'orphaned',
    };
  }

  // Unknown image — should be unreachable since listHermesImages queries
  // specific patterns. Classify as current to avoid accidental cleanup.
  return {
    ...base,
    category: 'Unknown',
    status: 'current',
  };
}

// ============================================================================
// Discovery Functions
// ============================================================================

/**
 * Build session lookup maps for resource classification.
 * Separates active (non-deleted) sessions from deleted sessions.
 */
function buildSessionLookups(
  allSessions: HermesSession[],
  activeSessions: HermesSession[],
) {
  const activeIds = new Set(activeSessions.map((s) => s.id));

  const sessionsByVolumeSlug = new Map<string, HermesSession>();
  const sessionsBySnapshotSlug = new Map<string, HermesSession>();
  const deletedSessionsByVolumeSlug = new Map<string, HermesSession>();
  const deletedSessionsBySnapshotSlug = new Map<string, HermesSession>();

  for (const session of allSessions) {
    const isActive = activeIds.has(session.id);
    if (isActive) {
      if (session.volumeSlug) {
        sessionsByVolumeSlug.set(session.volumeSlug, session);
      }
      if (session.snapshotSlug) {
        sessionsBySnapshotSlug.set(session.snapshotSlug, session);
      }
    } else {
      if (session.volumeSlug) {
        deletedSessionsByVolumeSlug.set(session.volumeSlug, session);
      }
      if (session.snapshotSlug) {
        deletedSessionsBySnapshotSlug.set(session.snapshotSlug, session);
      }
    }
  }

  return {
    sessionsByVolumeSlug,
    sessionsBySnapshotSlug,
    deletedSessionsByVolumeSlug,
    deletedSessionsBySnapshotSlug,
  };
}

/**
 * Discover cloud resources (volumes + snapshots) and classify them.
 */
async function discoverCloudResources(
  lookups: ReturnType<typeof buildSessionLookups>,
): Promise<SandboxResource[]> {
  const token = await getDenoToken();
  if (!token) {
    log.debug('No Deno token configured — skipping cloud resource discovery');
    return [];
  }

  log.debug('Discovering cloud resources...');
  const client = new DenoApiClient(token);
  const currentBaseSlug = getBaseSnapshotSlug();

  const [volumes, snapshots] = await Promise.all([
    client.listVolumes(),
    client.listSnapshots(),
  ]);

  log.debug(
    { volumeCount: volumes.length, snapshotCount: snapshots.length },
    'Cloud resources fetched',
  );

  // Find the source volume of the current base snapshot so we can
  // classify the corresponding build volume as "current" rather than "orphaned".
  const currentBaseSnapshot = snapshots.find((s) => s.slug === currentBaseSlug);
  const currentBaseVolumeSlug = currentBaseSnapshot?.volume.slug ?? null;

  const resources: SandboxResource[] = [];

  for (const snapshot of snapshots) {
    const classified = classifyCloudSnapshot(snapshot, {
      currentBaseSlug,
      sessionsBySnapshotSlug: lookups.sessionsBySnapshotSlug,
      deletedSessionsBySnapshotSlug: lookups.deletedSessionsBySnapshotSlug,
    });
    if (classified) {
      resources.push(classified);
    }
  }

  for (const volume of volumes) {
    const classified = classifyCloudVolume(volume, {
      currentBaseVolumeSlug,
      sessionsByVolumeSlug: lookups.sessionsByVolumeSlug,
      deletedSessionsByVolumeSlug: lookups.deletedSessionsByVolumeSlug,
    });
    if (classified) {
      resources.push(classified);
    }
  }

  return resources;
}

/**
 * Discover Docker resources (images) and classify them.
 */
async function discoverDockerResources(): Promise<SandboxResource[]> {
  log.debug('Discovering Docker resources...');
  const images = await listHermesImages();
  if (images.length === 0) {
    log.debug('No Docker images found');
    return [];
  }
  log.debug({ imageCount: images.length }, 'Docker images fetched');

  const currentDockerfileHash = computeDockerfileHash(SLIM_DOCKERFILE);

  // Build the set of current GHCR tags for both variants
  const slimTags = getGhcrImageTags('slim');
  const fullTags = getGhcrImageTags('full');
  const currentGhcrTags = new Set([
    slimTags.version,
    slimTags.latest,
    fullTags.version,
    fullTags.latest,
  ]);

  // Build set of container ID prefixes for matching resume images.
  // Resume image tags use the format: <containerId-12>-<nanoid-6>,
  // so we match by checking the container ID prefix in the tag.
  const containers = await listDockerContainers();
  const activeContainerIdPrefixes = new Set(
    containers.map((c) => c.containerId),
  );

  const resources: SandboxResource[] = [];
  for (const image of images) {
    resources.push(
      classifyDockerImage(image, {
        currentDockerfileHash,
        currentGhcrTags,
        activeContainerIdPrefixes,
      }),
    );
  }

  return resources;
}

/**
 * Discover and classify ALL sandbox-related resources across providers.
 * Uses Promise.allSettled so one provider's failure doesn't break the other.
 */
export async function listAllResources(): Promise<SandboxResource[]> {
  log.info('Discovering all sandbox resources...');

  // Build session lookups first (shared by cloud classification)
  const db = openSessionDb();
  const allSessions = listAllSessionsIncludingDeleted(db);
  const activeSessions = listSessions(db);
  const lookups = buildSessionLookups(allSessions, activeSessions);

  const results = await Promise.allSettled([
    discoverCloudResources(lookups),
    discoverDockerResources(),
  ]);

  const resources: SandboxResource[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      resources.push(...result.value);
    } else {
      log.error(
        { err: result.reason },
        'Failed to discover resources from provider',
      );
    }
  }

  log.info({ totalCount: resources.length }, 'Resource discovery complete');
  return resources;
}

// ============================================================================
// Cleanup Helpers
// ============================================================================

/** Sort order for resource kinds during cleanup: snapshots first, then volumes, then images */
const KIND_ORDER: Record<ResourceKind, number> = {
  snapshot: 0,
  volume: 1,
  image: 2,
};

/**
 * Filter resources to only those eligible for cleanup (old + orphaned),
 * ordered with snapshots before volumes before images.
 */
export function getCleanupTargets(
  resources: SandboxResource[],
): SandboxResource[] {
  return resources
    .filter((r) => r.status === 'old' || r.status === 'orphaned')
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

/**
 * Delete a single resource.
 */
export async function deleteResource(resource: SandboxResource): Promise<void> {
  log.info(
    {
      id: resource.id,
      provider: resource.provider,
      kind: resource.kind,
      name: resource.name,
    },
    'Deleting resource',
  );

  try {
    if (resource.provider === 'cloud') {
      const token = await getDenoToken();
      if (!token) {
        throw new Error(
          'No Deno token configured — cannot delete cloud resource',
        );
      }
      const client = new DenoApiClient(token);

      if (resource.kind === 'snapshot') {
        await client.deleteSnapshot(resource.id);
      } else if (resource.kind === 'volume') {
        await client.deleteVolume(resource.id);
      }
    } else if (resource.provider === 'docker') {
      if (resource.kind === 'image') {
        await Bun.$`docker rmi ${resource.name}`.quiet();
      }
    }

    log.info(
      { id: resource.id, name: resource.name },
      'Resource deleted successfully',
    );
  } catch (err) {
    log.error(
      {
        err,
        id: resource.id,
        provider: resource.provider,
        kind: resource.kind,
        name: resource.name,
      },
      'Failed to delete resource',
    );
    throw err;
  }
}

/**
 * Group resources by kind, maintaining the dependency order
 * (snapshots → volumes → images). Each group is a batch that
 * can be deleted in parallel, but the groups themselves must
 * be executed sequentially.
 */
export function groupResourcesByKind(
  resources: SandboxResource[],
): SandboxResource[][] {
  const sorted = [...resources].sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind],
  );

  const groups: SandboxResource[][] = [];
  let currentKind: ResourceKind | null = null;
  let currentGroup: SandboxResource[] = [];

  for (const resource of sorted) {
    if (resource.kind !== currentKind) {
      if (currentGroup.length > 0) {
        groups.push(currentGroup);
      }
      currentGroup = [resource];
      currentKind = resource.kind;
    } else {
      currentGroup.push(resource);
    }
  }
  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  return groups;
}
