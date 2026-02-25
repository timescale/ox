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
  sessionsByVolumeSlug: Map<string, HermesSession>;
  deletedSessionsByVolumeSlug: Map<string, HermesSession>;
}

interface ImageClassificationContext {
  currentDockerfileHash: string;
  currentGhcrTags: Set<string>;
  activeContainerImageIds: Set<string>;
}

// ============================================================================
// Classification Functions (pure — no API calls)
// ============================================================================

/**
 * Classify a cloud snapshot as current/active/old/orphaned.
 *
 * Rules:
 * - `hermes-base-*` → "Base Snapshot": `current` if matches getBaseSnapshotSlug(), else `old`
 * - `hsnap-*` → "Session Snapshot": `active` if linked to non-deleted session,
 *   `old` if linked to deleted session, `orphaned` if no session reference
 */
export function classifyCloudSnapshot(
  snapshot: DenoSnapshot,
  ctx: SnapshotClassificationContext,
): SandboxResource {
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
 * Classify a cloud volume as active/old/orphaned.
 *
 * Rules:
 * - `hbb-*` → "Build Volume": always `orphaned` (leftover from build)
 * - `hs-*` / `hr-*` → "Session Volume": `active` if linked to non-deleted session,
 *   `old` if linked to deleted session, `orphaned` if no session reference
 * - `hsh-*` → "Shell Volume": always `orphaned` (ephemeral, shouldn't persist)
 */
export function classifyCloudVolume(
  volume: DenoVolume,
  ctx: VolumeClassificationContext,
): SandboxResource {
  const base: Omit<SandboxResource, 'category' | 'status' | 'sessionName'> = {
    id: volume.id,
    provider: 'cloud',
    kind: 'volume',
    name: volume.slug,
    size: volume.allocatedSize,
    region: volume.region,
    bootable: volume.bootable,
  };

  // Build volumes — always orphaned
  if (volume.slug.startsWith('hbb-')) {
    return {
      ...base,
      category: 'Build Volume',
      status: 'orphaned',
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
  const base: Omit<SandboxResource, 'category' | 'status'> = {
    id: image.id,
    provider: 'docker',
    kind: 'image',
    name: `${image.repository}:${image.tag}`,
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

  // Resume images (hermes-resume:*)
  if (image.repository === 'hermes-resume') {
    return {
      ...base,
      category: 'Resume Image',
      status: ctx.activeContainerImageIds.has(image.id) ? 'active' : 'orphaned',
    };
  }

  // Unknown image — treat as old
  return {
    ...base,
    category: 'Unknown',
    status: 'old',
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

  const client = new DenoApiClient(token);
  const currentBaseSlug = getBaseSnapshotSlug();

  const [volumes, snapshots] = await Promise.all([
    client.listVolumes(),
    client.listSnapshots(),
  ]);

  const resources: SandboxResource[] = [];

  for (const snapshot of snapshots) {
    resources.push(
      classifyCloudSnapshot(snapshot, {
        currentBaseSlug,
        sessionsBySnapshotSlug: lookups.sessionsBySnapshotSlug,
        deletedSessionsBySnapshotSlug: lookups.deletedSessionsBySnapshotSlug,
      }),
    );
  }

  for (const volume of volumes) {
    resources.push(
      classifyCloudVolume(volume, {
        sessionsByVolumeSlug: lookups.sessionsByVolumeSlug,
        deletedSessionsByVolumeSlug: lookups.deletedSessionsByVolumeSlug,
      }),
    );
  }

  return resources;
}

/**
 * Discover Docker resources (images) and classify them.
 */
async function discoverDockerResources(): Promise<SandboxResource[]> {
  const images = await listHermesImages();
  if (images.length === 0) return [];

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

  // Build set of image IDs used by active containers
  const containers = await listDockerContainers();
  const activeContainerImageIds = new Set<string>();
  for (const container of containers) {
    // Docker inspect gives containerId; we need to find the image ID
    // Resume images are tracked via the hermes.resume-image label,
    // but we can match by checking if any container references this image.
    // The simplest approach: check docker image ls IDs against container images.
    // For resume images, the container's image is the resume image itself.
    // We'll gather all container IDs and match against image IDs.
    if (container.containerId) {
      try {
        const result =
          await Bun.$`docker inspect --format={{.Image}} ${container.containerId}`.quiet();
        const imageId = result.stdout.toString().trim();
        if (imageId) {
          activeContainerImageIds.add(imageId);
        }
      } catch {
        // Container may have been removed between list and inspect
      }
    }
  }

  const resources: SandboxResource[] = [];
  for (const image of images) {
    resources.push(
      classifyDockerImage(image, {
        currentDockerfileHash,
        currentGhcrTags,
        activeContainerImageIds,
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
      log.warn(
        { err: result.reason },
        'Failed to discover resources from provider',
      );
    }
  }

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
}
