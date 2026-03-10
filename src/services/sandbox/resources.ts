// ============================================================================
// Resource Discovery & Classification Service
//
// Discovers all sandbox-related resources (cloud volumes, snapshots, Docker
// images) and classifies each as current/active/old/orphaned to support
// the resource cleanup workflow.
// ============================================================================

import BASE_DOCKERFILE from '../../../sandbox/base.Dockerfile' with {
  type: 'text',
};
import type { AgentType } from '../config.ts';
import { getDenoToken } from '../deno.ts';
import {
  computeDockerfileHash,
  type DockerImageInfo,
  getAgentOverlayTag,
  getGhcrAgentTag,
  getGhcrBaseTag,
  listOxSessions as listDockerContainers,
  listOxImages,
} from '../docker.ts';
import { log } from '../logger.ts';
import { getAgentSnapshotSlug, getBaseSnapshotSlug } from './cloudSnapshot.ts';
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
import type { OxSession } from './types.ts';

// ============================================================================
// Types
// ============================================================================

export type ResourceProvider = 'cloud' | 'docker';
export type ResourceKind = 'container' | 'snapshot' | 'volume' | 'image';
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
  /** For snapshots: the slug of the source volume this snapshot was taken from */
  sourceVolumeSlug?: string;
  /** For volumes: the slug of the snapshot this volume was forked from */
  baseSnapshotSlug?: string;
  /** For volumes: slugs of snapshots that depend on this volume */
  childSnapshotSlugs?: string[];
}

// ============================================================================
// Classification Context Types (passed to pure classification functions)
// ============================================================================

interface SnapshotClassificationContext {
  currentBaseSlug: string;
  currentAgentSlugs: Set<string>;
  sessionsBySnapshotSlug: Map<string, OxSession>;
  deletedSessionsBySnapshotSlug: Map<string, OxSession>;
}

interface VolumeClassificationContext {
  /** Slug of the volume that is the source of the current base snapshot (if known) */
  currentBaseVolumeSlug: string | null;
  sessionsByVolumeSlug: Map<string, OxSession>;
  deletedSessionsByVolumeSlug: Map<string, OxSession>;
  /** Map from volume slug to the slugs + statuses of snapshots taken from that volume */
  snapshotsByVolumeSlug: Map<
    string,
    { slug: string; status: ResourceStatus }[]
  >;
}

interface ImageClassificationContext {
  currentDockerfileHash: string;
  currentGhcrTags: Set<string>;
  /** Full local overlay tags that are current (e.g. 'md5-{hash}-claude-2.1.71') */
  currentLocalOverlayTags: Set<string>;
  /** Container ID prefixes (12-char) for active containers */
  activeContainerIdPrefixes: Set<string>;
}

// ============================================================================
// Classification Functions (pure — no API calls)
// ============================================================================

/** Known Ox snapshot slug prefixes. */
const OX_SNAPSHOT_PREFIXES = ['ox-base-', 'ox-', 'oxn-'];

/** Known Ox volume slug prefixes. */
const OX_VOLUME_PREFIXES = ['oxb-', 'oxa-', 'oxe-', 'oxs-', 'oxr-'];

/**
 * Classify a cloud snapshot as current/active/old/orphaned.
 * Returns null for non-Ox snapshots (unrecognized slug prefix).
 *
 * Rules:
 * - `ox-base-*` → "Base Snapshot": `current` if matches getBaseSnapshotSlug(), else `old`
 * - `ox-*` (not `ox-base-*`) → "Agent Snapshot": `current` if in currentAgentSlugs, else `old`
 * - `oxn-*` → "Session Snapshot": `active` if linked to non-deleted session,
 *   `old` if linked to deleted session, `orphaned` if no session reference
 * - Other prefixes → null (not an Ox resource, skip)
 */
export function classifyCloudSnapshot(
  snapshot: DenoSnapshot,
  ctx: SnapshotClassificationContext,
): SandboxResource | null {
  // Skip non-Ox snapshots entirely to avoid accidental cleanup
  if (!OX_SNAPSHOT_PREFIXES.some((p) => snapshot.slug.startsWith(p))) {
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
    sourceVolumeSlug: snapshot.volume.slug,
  };

  // Base snapshots
  if (snapshot.slug.startsWith('ox-base-')) {
    return {
      ...base,
      category: 'Base Snapshot',
      status: snapshot.slug === ctx.currentBaseSlug ? 'current' : 'old',
    };
  }

  // Agent overlay snapshots (ox-{version}-{agent}-{agentVer}, but NOT ox-base-*)
  if (
    snapshot.slug.startsWith('ox-') &&
    !snapshot.slug.startsWith('ox-base-')
  ) {
    return {
      ...base,
      category: 'Agent Snapshot',
      status: ctx.currentAgentSlugs.has(snapshot.slug) ? 'current' : 'old',
    };
  }

  // Session snapshots (oxn-*)
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
 * Derive a volume's status from its child snapshots.
 * - If any child is `current` or `active` → `current`
 * - If children exist but all are `old` → `old`
 * - If no children → `orphaned`
 */
function volumeStatusFromChildSnapshots(
  children: { slug: string; status: ResourceStatus }[] | undefined,
): ResourceStatus {
  if (!children || children.length === 0) return 'orphaned';
  if (children.some((s) => s.status === 'current' || s.status === 'active')) {
    return 'current';
  }
  return 'old';
}

/**
 * Classify a cloud volume as current/active/old/orphaned.
 * Returns null for non-Ox volumes (unrecognized slug prefix).
 *
 * Rules:
 * - `oxb-*` → "Build Volume": `current` if it is the source volume of the
 *   current base snapshot or has current child snapshots, `old` if only old
 *   snapshots remain, `orphaned` if no snapshots depend on it
 * - `oxa-*` → "Agent Build Volume": status derived from child snapshots
 *   (`current` if any child snapshot is current, `old` if all are old,
 *   `orphaned` if no child snapshots exist)
 * - `oxs-*` / `oxr-*` → "Session Volume": `active` if linked to non-deleted session,
 *   `old` if linked to deleted session, `orphaned` if no session reference
 * - `oxe-*` → "Shell Volume": always `orphaned` (ephemeral, shouldn't persist)
 * - Other prefixes → null (not an Ox resource, skip)
 */
export function classifyCloudVolume(
  volume: DenoVolume,
  ctx: VolumeClassificationContext,
): SandboxResource | null {
  // Skip non-Ox volumes entirely to avoid accidental cleanup
  if (!OX_VOLUME_PREFIXES.some((p) => volume.slug.startsWith(p))) {
    return null;
  }

  const childSnapshots = ctx.snapshotsByVolumeSlug.get(volume.slug);
  const childSnapshotSlugs = childSnapshots?.map((s) => s.slug);

  const base: Omit<SandboxResource, 'category' | 'status' | 'sessionName'> = {
    id: volume.id,
    provider: 'cloud',
    kind: 'volume',
    name: volume.slug,
    size: volume.allocatedSize,
    region: volume.region,
    bootable: volume.bootable,
    baseSnapshotSlug: volume.baseSnapshot?.slug ?? undefined,
    childSnapshotSlugs,
  };

  // Build volumes — current if source of the current base snapshot.
  // If no longer current but still has dependent snapshots, derive status from those snapshots.
  if (volume.slug.startsWith('oxb-')) {
    const isCurrent =
      ctx.currentBaseVolumeSlug != null &&
      volume.slug === ctx.currentBaseVolumeSlug;
    return {
      ...base,
      category: 'Build Volume',
      status: isCurrent
        ? 'current'
        : volumeStatusFromChildSnapshots(childSnapshots),
    };
  }

  // Agent build volumes — status derived from child snapshots.
  // A volume with current snapshots is current; with only old snapshots is old;
  // with no snapshots at all it is orphaned.
  if (volume.slug.startsWith('oxa-')) {
    return {
      ...base,
      category: 'Agent Build Volume',
      status: volumeStatusFromChildSnapshots(childSnapshots),
    };
  }

  // Shell volumes — always orphaned
  if (volume.slug.startsWith('oxe-')) {
    return {
      ...base,
      category: 'Shell Volume',
      status: 'orphaned',
    };
  }

  // Session volumes (oxs-* or oxr-*)
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
 * - `ox-sandbox:md5-*` → "Local Build": `current` if hash matches, else `old`
 * - `ghcr.io/timescale/ox/sandbox-*` → "GHCR Image": `current` if tag is current, else `old`
 * - `ox-resume:*` → "Resume Image": `active` if container exists with matching image, else `orphaned`
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

  // Local builds (ox-sandbox:md5-*)
  if (image.repository === 'ox-sandbox' && image.tag.startsWith('md5-')) {
    // Base images have tags like 'md5-{hash}' — current if hash matches.
    // Agent overlays have tags like 'md5-{hash}-{agent}-{version}' — current
    // only if both the base hash AND agent version match.
    const isCurrentBase = image.tag === `md5-${ctx.currentDockerfileHash}`;
    const isCurrentOverlay = ctx.currentLocalOverlayTags.has(image.tag);
    return {
      ...base,
      category: 'Local Build',
      status: isCurrentBase || isCurrentOverlay ? 'current' : 'old',
    };
  }

  // GHCR images (ghcr.io/timescale/ox/sandbox or legacy sandbox-slim/sandbox-full)
  if (image.repository.startsWith('ghcr.io/timescale/ox/sandbox')) {
    const fullTag = `${image.repository}:${image.tag}`;
    return {
      ...base,
      category: 'GHCR Image',
      status: ctx.currentGhcrTags.has(fullTag) ? 'current' : 'old',
    };
  }

  // Resume images (ox-resume:<containerId-12>-<nanoid-6>)
  if (image.repository === 'ox-resume') {
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

  // Unknown image — should be unreachable since listOxImages queries
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
  allSessions: OxSession[],
  activeSessions: OxSession[],
) {
  const activeIds = new Set(activeSessions.map((s) => s.id));

  const sessionsByVolumeSlug = new Map<string, OxSession>();
  const sessionsBySnapshotSlug = new Map<string, OxSession>();
  const deletedSessionsByVolumeSlug = new Map<string, OxSession>();
  const deletedSessionsBySnapshotSlug = new Map<string, OxSession>();

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
  const AGENTS: AgentType[] = ['claude', 'opencode', 'codex'];
  const currentAgentSlugs = new Set(AGENTS.map(getAgentSnapshotSlug));

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

  // Classify snapshots first so we can build a reverse map for volumes
  for (const snapshot of snapshots) {
    const classified = classifyCloudSnapshot(snapshot, {
      currentBaseSlug,
      currentAgentSlugs,
      sessionsBySnapshotSlug: lookups.sessionsBySnapshotSlug,
      deletedSessionsBySnapshotSlug: lookups.deletedSessionsBySnapshotSlug,
    });
    if (classified) {
      resources.push(classified);
    }
  }

  // Build reverse map: volume slug → snapshot slugs + statuses.
  // This lets volume classification know which snapshots depend on it.
  const snapshotsByVolumeSlug = new Map<
    string,
    { slug: string; status: ResourceStatus }[]
  >();
  for (const snapshot of snapshots) {
    const volumeSlug = snapshot.volume.slug;
    const classified = resources.find(
      (r) => r.kind === 'snapshot' && r.id === snapshot.id,
    );
    if (classified) {
      const existing = snapshotsByVolumeSlug.get(volumeSlug);
      const entry = { slug: snapshot.slug, status: classified.status };
      if (existing) {
        existing.push(entry);
      } else {
        snapshotsByVolumeSlug.set(volumeSlug, [entry]);
      }
    }
  }

  for (const volume of volumes) {
    const classified = classifyCloudVolume(volume, {
      currentBaseVolumeSlug,
      sessionsByVolumeSlug: lookups.sessionsByVolumeSlug,
      deletedSessionsByVolumeSlug: lookups.deletedSessionsByVolumeSlug,
      snapshotsByVolumeSlug,
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
  const images = await listOxImages();
  if (images.length === 0) {
    log.debug('No Docker images found');
    return [];
  }
  log.debug({ imageCount: images.length }, 'Docker images fetched');

  const currentDockerfileHash = computeDockerfileHash(BASE_DOCKERFILE);
  const localBaseImage = `ox-sandbox:md5-${currentDockerfileHash}`;

  // Build the set of current GHCR tags (base + all agent variants)
  const agents = ['claude', 'opencode', 'codex'] as const;
  const currentGhcrTags = new Set([
    getGhcrBaseTag(),
    ...agents.map((agent) => getGhcrAgentTag(agent)),
  ]);

  // Build the set of current local overlay tags (md5-{hash}-{agent}-{version})
  // so that overlays with old agent versions are classified as 'old'.
  const currentLocalOverlayTags = new Set(
    agents.map((agent) => {
      const fullTag = getAgentOverlayTag(localBaseImage, agent);
      // getAgentOverlayTag returns 'ox-sandbox:md5-{hash}-{agent}-{ver}',
      // but the tag portion (after ':') is what we match against image.tag.
      return fullTag.split(':')[1] ?? fullTag;
    }),
  );

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
        currentLocalOverlayTags,
        activeContainerIdPrefixes,
      }),
    );
  }

  return resources;
}

/** Docker ps JSON output shape (subset of fields we use). */
interface DockerPsJson {
  ID: string;
  Names: string;
  Status: string;
  CreatedAt: string;
  Size: string;
  Labels: string;
}

/**
 * Categorize an orphaned container by its name prefix.
 */
function containerCategory(name: string): string {
  if (name.startsWith('ox-anon-')) return 'Anonymous Container';
  if (name.startsWith('ox-gh-auth-')) return 'Auth Container';
  if (name.startsWith('ox-claude-auth-')) return 'Auth Container';
  if (name.startsWith('ox-shell-')) return 'Shell Container';
  return 'Stopped Container';
}

/**
 * Discover stopped Docker containers with an `ox-` name prefix that are
 * NOT managed sessions (i.e. missing the `ox.managed=true` label).
 * These are typically ephemeral containers (gh commands, auth flows, etc.)
 * that leaked due to unclean exits.
 */
async function discoverOrphanedDockerContainers(): Promise<SandboxResource[]> {
  log.debug('Discovering orphaned Docker containers...');
  try {
    // Find all stopped ox-* containers that are NOT ox.managed.
    // Note: the format string is interpolated so Bun's shell treats it as a
    // single token — bare `{{json .}}` would be split on the space.
    const jsonFmt = '{{json .}}';
    const result =
      await Bun.$`docker ps -a --filter name=ox- --filter status=exited --filter status=dead --filter status=created --format ${jsonFmt}`.quiet();
    const output = result.stdout.toString().trim();
    if (!output) {
      log.debug('No stopped ox-* containers found');
      return [];
    }

    // Each line is a separate JSON object
    const entries: DockerPsJson[] = output
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as DockerPsJson);

    const resources: SandboxResource[] = [];
    for (const entry of entries) {
      // Skip managed containers — those are tracked via the Sessions list
      if (entry.Labels.includes('ox.managed=true')) continue;

      resources.push({
        id: entry.ID,
        provider: 'docker',
        kind: 'container',
        name: entry.Names,
        category: containerCategory(entry.Names),
        status: 'orphaned',
        createdAt: entry.CreatedAt,
      });
    }

    log.debug(
      { containerCount: resources.length },
      'Orphaned Docker containers discovered',
    );
    return resources;
  } catch (err) {
    log.error({ err }, 'Failed to discover orphaned Docker containers');
    return [];
  }
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
    discoverOrphanedDockerContainers(),
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

/**
 * Filter resources to only those eligible for cleanup (old + orphaned).
 */
export function getCleanupTargets(
  resources: SandboxResource[],
): SandboxResource[] {
  return resources.filter((r) => r.status === 'old' || r.status === 'orphaned');
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
      if (resource.kind === 'container') {
        await Bun.$`docker rm -f ${resource.id}`.quiet();
      } else if (resource.kind === 'image') {
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
 * Topologically sort resources into sequential deletion groups.
 *
 * Dependency rules (must delete dependent before dependency):
 * - A volume's `baseSnapshot` must outlive the volume → delete volume first
 * - A snapshot's source `volume` must outlive the snapshot → delete snapshot first
 * - Docker containers depend on their image → delete container first
 *
 * Resources in the same group have no inter-dependencies and can be deleted
 * in parallel. Groups must be processed sequentially.
 */
export function groupResourcesByKind(
  resources: SandboxResource[],
): SandboxResource[][] {
  if (resources.length === 0) return [];

  // Build a lookup from resource name (slug) to resource, since dependency
  // links use slugs. We key on `name` which is the slug for cloud resources
  // and `repository:tag` for docker images.
  const byName = new Map<string, SandboxResource>();
  for (const r of resources) {
    byName.set(r.name, r);
  }

  // Build adjacency: blockedBy[name] = set of names that must be deleted
  // BEFORE `name` can be deleted (i.e. `name` is blocked until those are gone).
  const blockedBy = new Map<string, Set<string>>();
  for (const r of resources) {
    blockedBy.set(r.name, new Set<string>());
  }
  for (const r of resources) {
    if (r.kind === 'volume' && r.baseSnapshotSlug) {
      // Volume must be deleted before its base snapshot.
      // → the snapshot is blocked by the volume.
      const snapshotDeps = blockedBy.get(r.baseSnapshotSlug);
      if (snapshotDeps) {
        snapshotDeps.add(r.name);
      }
    }

    if (r.kind === 'snapshot' && r.sourceVolumeSlug) {
      // Snapshot must be deleted before its source volume.
      // → the volume is blocked by the snapshot.
      const volumeDeps = blockedBy.get(r.sourceVolumeSlug);
      if (volumeDeps) {
        volumeDeps.add(r.name);
      }
    }
  }

  // Kahn's algorithm: iteratively collect resources whose blockers have
  // all been processed into groups (layers).
  const remaining = new Set(resources.map((r) => r.name));
  const groups: SandboxResource[][] = [];

  while (remaining.size > 0) {
    // Find all resources whose blockers have all been placed in
    // earlier groups (i.e. already removed from `remaining`).
    const ready: string[] = [];
    for (const name of remaining) {
      const b = blockedBy.get(name);
      if (!b || [...b].every((blocker) => !remaining.has(blocker))) {
        ready.push(name);
      }
    }

    // Safety: if nothing is ready we have a cycle. Break it by picking
    // all remaining resources (shouldn't happen with well-formed data).
    if (ready.length === 0) {
      const fallback = [...remaining]
        .map((n) => byName.get(n))
        .filter((r): r is SandboxResource => r != null);
      if (fallback.length > 0) groups.push(fallback);
      break;
    }

    const group = ready
      .map((n) => byName.get(n))
      .filter((r): r is SandboxResource => r != null);
    groups.push(group);

    for (const name of ready) {
      remaining.delete(name);
    }
  }

  return groups;
}
