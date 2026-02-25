// ============================================================================
// Deno Deploy API - Thin wrapper around the @deno/sandbox SDK
// ============================================================================

import type {
  SandboxMetadata,
  SandboxOptions,
  SnapshotInit,
  VolumeInit,
} from '@deno/sandbox';
import { Client, Sandbox } from '@deno/sandbox';
import { customAlphabet } from 'nanoid';

import { log } from '../logger.ts';

// Re-export SDK types that our code consumes
export type { SandboxMetadata, SandboxOptions };
export { Sandbox };

/** Sandbox instance with a reliably resolved ID (works around Bun compat issue). */
export type ResolvedSandbox = Sandbox & { resolvedId: string };

// ============================================================================
// Slug Generation
// ============================================================================

/** Deno slugs: lowercase alphanumeric + hyphens, max 32 chars. */
const SLUG_MAX = 32;

/** nanoid generator using only slug-safe characters (lowercase + digits). */
const slugId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 10);

/**
 * Generate a Deno-safe slug: `{prefix}-{name?}-{nanoid}`, max 32 chars.
 * The name portion is sanitized and truncated to fit.
 */
export function denoSlug(prefix: string, name?: string): string {
  const id = slugId();
  if (!name) {
    return `${prefix}-${id}`.slice(0, SLUG_MAX);
  }
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  // Budget: prefix + '-' + name + '-' + id ≤ 32
  const budget = SLUG_MAX - prefix.length - 1 - id.length - 1;
  const trimmed = sanitized.slice(0, Math.max(0, budget)).replace(/-$/, '');
  if (!trimmed) {
    return `${prefix}-${id}`.slice(0, SLUG_MAX);
  }
  return `${prefix}-${trimmed}-${id}`.slice(0, SLUG_MAX);
}

export interface DenoVolume {
  id: string;
  slug: string;
  region: string;
  capacity: number;
  allocatedSize: number;
  flattenedSize: number;
  bootable: boolean;
  baseSnapshot: { id: string; slug: string } | null;
}

export interface DenoSnapshot {
  id: string;
  slug: string;
  region: string;
  allocatedSize: number;
  flattenedSize: number;
  bootable: boolean;
  volume: { id: string; slug: string };
}

/**
 * High-level Deno Deploy API client wrapping the @deno/sandbox SDK.
 *
 * Uses `Client` for management operations (volumes, snapshots, listing)
 * and `Sandbox` for individual sandbox lifecycle (create, connect, exec).
 */
export class DenoApiClient {
  private client: Client;
  private token: string;

  constructor(token: string) {
    this.token = token;
    this.client = new Client({ token });
  }

  // --------------------------------------------------------------------------
  // Sandbox Management (via Client)
  // --------------------------------------------------------------------------

  async listSandboxes(
    labels?: Record<string, string>,
  ): Promise<SandboxMetadata[]> {
    return this.client.sandboxes.list({ labels });
  }

  /**
   * Create a new sandbox. Returns the SDK Sandbox instance plus its resolved ID.
   *
   * Under Bun, `sandbox.id` is null because Bun's WebSocket doesn't emit the
   * Node.js "upgrade" event that carries the `x-deno-sandbox-id` header.
   * We work around this by injecting a unique label, then looking up the
   * sandbox via the Console API to resolve its ID.
   */
  async createSandbox(
    options: Omit<SandboxOptions, 'token'>,
  ): Promise<Sandbox & { resolvedId: string }> {
    const idLabel = slugId();
    const labels = {
      ...options.labels,
      'hermes.create-id': idLabel,
    };

    log.debug(
      { region: options.region, root: options.root },
      'Creating sandbox',
    );

    // Retry transient WebSocket failures (Deno platform sometimes rejects
    // the upgrade with a non-101 status code).
    let sandbox: Sandbox | undefined;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        sandbox = await Sandbox.create({
          ...options,
          labels,
          token: this.token,
        });
        break;
      } catch (err) {
        // The error may be an ErrorEvent (Bun WebSocket) or a regular Error
        const msg = (err as { message?: string })?.message ?? String(err);
        const isTransient =
          msg.includes('Expected 101') || msg.includes('WebSocket');
        if (isTransient && attempt < maxAttempts) {
          const delay = attempt * 2_000;
          log.warn(
            { attempt, maxAttempts, delay },
            'Sandbox creation failed (transient) — retrying',
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw err;
      }
    }
    if (!sandbox) throw new Error('Sandbox creation failed after retries');

    // Resolve the real sandbox ID
    let resolvedId = sandbox.id;
    if (!resolvedId) {
      // Bun workaround: look up via Console API using our unique label
      const found = await this.client.sandboxes.list({
        labels: { 'hermes.create-id': idLabel },
      });
      if (found.length > 0 && found[0]) {
        resolvedId = found[0].id;
        log.debug({ resolvedId }, 'Resolved sandbox ID via Console API');
      }
    }

    if (!resolvedId) {
      throw new Error(
        'Could not resolve sandbox ID after creation — the sandbox was created but its ID is unavailable. ' +
          'Kill/cleanup and session tracking will not work. ' +
          `Label used for lookup: hermes.create-id=${idLabel}`,
      );
    }

    // Attach resolvedId as an extra property
    const result = sandbox as Sandbox & { resolvedId: string };
    result.resolvedId = resolvedId;
    return result;
  }

  /**
   * Connect to an existing sandbox by ID.
   */
  async connectSandbox(id: string): Promise<Sandbox> {
    log.debug({ id }, 'Connecting to sandbox');
    return Sandbox.connect(id, { token: this.token });
  }

  /**
   * Kill a sandbox by ID using a direct HTTP DELETE call.
   *
   * The SDK's `sandbox.kill()` is broken under Bun because it relies on
   * `sandbox.id` which is null (see Bun WebSocket compat issue). Even
   * `Sandbox.connect(id).kill()` fails because the connected sandbox also
   * gets a null `sandbox.id` from the missing "upgrade" event.
   *
   * We bypass the SDK entirely and make the HTTP DELETE directly.
   */
  async killSandbox(id: string): Promise<void> {
    if (!id) {
      log.warn('killSandbox called with empty ID — skipping');
      return;
    }
    log.debug({ id }, 'Killing sandbox via direct HTTP DELETE');

    // Extract region from sandbox ID (e.g. "sbx_ord_..." → "ord")
    const match = /^sbx_([a-z]+)_/.exec(id);
    const region = match?.[1] ?? 'ord';
    const baseDomain =
      process.env.DENO_SANDBOX_BASE_DOMAIN ?? 'sandbox-api.deno.net';
    const url = `https://${region}.${baseDomain}/api/v3/sandbox/${id}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };
    // Organization tokens need the org header
    if (this.token.startsWith('ddo_')) {
      // The org ID is encoded in org tokens; the API infers it from the token
    }

    const resp = await fetch(url, {
      method: 'DELETE',
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      const body = await resp.text();
      if (resp.status === 404) {
        log.debug({ id, body }, 'Sandbox already stopped or missing');
        return;
      }
      throw new Error(`Failed to kill sandbox ${id}: ${resp.status} ${body}`);
    }
    log.debug({ id }, 'Sandbox killed successfully');
  }

  // --------------------------------------------------------------------------
  // Volume Management (via Client)
  // --------------------------------------------------------------------------

  async createVolume(init: VolumeInit): Promise<DenoVolume> {
    log.debug({ slug: init.slug, region: init.region }, 'Creating volume');
    const vol = await this.client.volumes.create(init);
    return {
      id: vol.id,
      slug: vol.slug,
      region: vol.region,
      capacity: vol.capacity,
      allocatedSize: vol.estimatedAllocatedSize,
      flattenedSize: vol.estimatedFlattenedSize,
      bootable: vol.isBootable,
      baseSnapshot: vol.baseSnapshot
        ? { id: vol.baseSnapshot.id, slug: vol.baseSnapshot.slug }
        : null,
    };
  }

  async listVolumes(): Promise<DenoVolume[]> {
    const result = await this.client.volumes.list();
    const volumes: DenoVolume[] = [];
    for await (const v of result) {
      volumes.push({
        id: v.id,
        slug: v.slug,
        region: v.region,
        capacity: v.capacity,
        allocatedSize: v.estimatedAllocatedSize,
        flattenedSize: v.estimatedFlattenedSize,
        bootable: v.isBootable,
        baseSnapshot: v.baseSnapshot
          ? { id: v.baseSnapshot.id, slug: v.baseSnapshot.slug }
          : null,
      });
    }
    return volumes;
  }

  async deleteVolume(idOrSlug: string): Promise<void> {
    log.debug({ idOrSlug }, 'Deleting volume');
    await this.client.volumes.delete(idOrSlug);
  }

  async snapshotVolume(
    volumeIdOrSlug: string,
    init: SnapshotInit,
  ): Promise<DenoSnapshot> {
    log.debug({ volumeIdOrSlug, slug: init.slug }, 'Snapshotting volume');
    const snap = await this.client.volumes.snapshot(volumeIdOrSlug, init);
    return {
      id: snap.id,
      slug: snap.slug,
      region: snap.region,
      allocatedSize: snap.allocatedSize,
      flattenedSize: snap.flattenedSize,
      bootable: snap.isBootable,
      volume: { id: snap.volume.id, slug: snap.volume.slug },
    };
  }

  // --------------------------------------------------------------------------
  // Snapshot Management (via Client)
  // --------------------------------------------------------------------------

  async listSnapshots(): Promise<DenoSnapshot[]> {
    const result = await this.client.snapshots.list();
    const snapshots: DenoSnapshot[] = [];
    for await (const s of result) {
      snapshots.push({
        id: s.id,
        slug: s.slug,
        region: s.region,
        allocatedSize: s.allocatedSize,
        flattenedSize: s.flattenedSize,
        bootable: s.isBootable,
        volume: { id: s.volume.id, slug: s.volume.slug },
      });
    }
    return snapshots;
  }

  async getSnapshot(idOrSlug: string): Promise<DenoSnapshot | null> {
    // Try direct lookup first (works for proper IDs like snp_ord_...)
    try {
      const snap = await this.client.snapshots.get(idOrSlug);
      if (snap)
        return {
          id: snap.id,
          slug: snap.slug,
          region: snap.region,
          allocatedSize: snap.allocatedSize,
          flattenedSize: snap.flattenedSize,
          bootable: snap.isBootable,
          volume: { id: snap.volume.id, slug: snap.volume.slug },
        };
    } catch {
      // Fall through to search by slug
    }
    // Search by slug for human-readable names
    const result = await this.client.snapshots.list({ search: idOrSlug });
    const match = result.items.find((s) => s.slug === idOrSlug);
    if (!match) return null;
    return {
      id: match.id,
      slug: match.slug,
      region: match.region,
      allocatedSize: match.allocatedSize,
      flattenedSize: match.flattenedSize,
      bootable: match.isBootable,
      volume: { id: match.volume.id, slug: match.volume.slug },
    };
  }

  async deleteSnapshot(idOrSlug: string): Promise<void> {
    log.debug({ idOrSlug }, 'Deleting snapshot');
    await this.client.snapshots.delete(idOrSlug);
  }
}
