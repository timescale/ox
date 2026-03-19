import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { log } from '../logger.ts';
import {
  countCaddyRoutes,
  getSession as dbGetSession,
  deleteAllCaddyRoutes,
  deleteCaddyRoute,
  listCaddyRoutes,
  openSessionDb,
  upsertCaddyRoute,
} from '../sandbox/sessionDb.ts';
import { sessionSubdomain } from './config.ts';
import { ensureNetwork, OX_NETWORK } from './network.ts';
import type { AppPortEntry } from './types.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CADDY_CONTAINER = 'ox-caddy';
export const CADDY_IMAGE = 'caddy:2-alpine';

/** Host-side path for the Caddy JSON config file */
const CADDY_CONFIG_PATH = join(tmpdir(), 'ox-caddy-config.json');

// ---------------------------------------------------------------------------
// Config generation
// ---------------------------------------------------------------------------

interface CaddyConfig {
  apps: {
    http: {
      servers: Record<string, unknown>;
    };
    tls?: unknown;
  };
}

/**
 * Generate a Caddy JSON config from the current set of active routes.
 *
 * Reads routes from the SQLite database so all ox processes share state.
 */
export function generateCaddyConfig(): CaddyConfig {
  const routes: unknown[] = [];
  const db = openSessionDb();
  const allRoutes = listCaddyRoutes(db);

  for (const route of allRoutes) {
    const base = sessionSubdomain(route.containerName);
    for (const portEntry of route.ports) {
      const host = portEntry.subdomain
        ? `${portEntry.subdomain}.${base}.ox.local`
        : `${base}.ox.local`;

      if (route.isCloud && route.externalUrls?.[portEntry.port]) {
        const externalUrl = route.externalUrls[portEntry.port] as string;
        // Parse the external URL to get host for TLS upstream
        const parsed = new URL(externalUrl);
        routes.push({
          match: [{ host: [host] }],
          handle: [
            {
              handler: 'reverse_proxy',
              upstreams: [
                { dial: `${parsed.hostname}:${parsed.port || '443'}` },
              ],
              transport: {
                protocol: 'http',
                tls: {
                  server_name: parsed.hostname,
                },
              },
              headers: {
                request: {
                  set: {
                    Host: [parsed.hostname],
                  },
                },
              },
            },
          ],
        });
      } else {
        routes.push({
          match: [{ host: [host] }],
          handle: [
            {
              handler: 'reverse_proxy',
              upstreams: [{ dial: `${route.containerName}:${portEntry.port}` }],
            },
          ],
        });
      }
    }
  }

  return {
    apps: {
      tls: {
        automation: {
          on_demand: {},
          policies: [
            {
              issuers: [{ module: 'internal' }],
            },
          ],
        },
      },
      http: {
        servers: {
          proxy: {
            listen: [':443'],
            routes,
            tls_connection_policies: [{}],
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Config file I/O
// ---------------------------------------------------------------------------

/**
 * Write the generated Caddy JSON config to disk with fsync.
 * macOS VirtioFS can see a partial file when Docker mounts a bind volume,
 * so we must guarantee the data reaches disk before Docker reads it.
 */
function writeCaddyConfigToDisk(): void {
  const config = generateCaddyConfig();
  const configJson = JSON.stringify(config, null, 2);
  const fd = openSync(CADDY_CONFIG_PATH, 'w');
  writeSync(fd, configJson);
  fsyncSync(fd);
  closeSync(fd);
}

// ---------------------------------------------------------------------------
// Container lifecycle
// ---------------------------------------------------------------------------

/**
 * Check whether the Caddy container is currently running.
 */
export async function isCaddyRunning(): Promise<boolean> {
  try {
    const result =
      await $`docker inspect -f {{.State.Running}} ${CADDY_CONTAINER}`.quiet();
    return result.stdout.toString().trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Check whether the Caddy admin API is ready to accept commands.
 *
 * Caddy exposes an admin API on localhost:2019 inside the container.
 * We probe it via `docker exec` + `wget` (available in alpine) to confirm
 * caddy has fully initialized — a running container doesn't guarantee the
 * admin API is up yet.
 */
async function isCaddyAdminReady(): Promise<boolean> {
  try {
    const result =
      await $`docker exec ${CADDY_CONTAINER} wget -qO /dev/null http://localhost:2019/config/`
        .quiet()
        .nothrow();
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Get the host-side HTTPS port that the running Caddy container is bound to.
 * Returns null if Caddy isn't running or the port can't be determined.
 *
 * `docker port` output format: "443/tcp -> 127.0.0.1:8443"
 * We need the host port (8443), not the container port (443).
 */
export async function getCaddyHttpsPort(): Promise<number | null> {
  try {
    const result = await $`docker port ${CADDY_CONTAINER}`.quiet();
    const match = result.stdout.toString().match(/->\s*[\d.]+:(\d+)/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Ensure the Caddy container is running and its admin API is ready.
 *
 * Starts the container if it isn't already running, then waits for the
 * admin API to accept commands. The admin readiness check runs in both
 * paths — a container started by another ox process moments earlier may
 * not have its admin API up yet.
 */
export async function ensureCaddy(httpsPort: number): Promise<void> {
  if (await isCaddyRunning()) {
    log.debug('Caddy container already running');
  } else {
    // Remove any stopped container
    try {
      await $`docker rm -f ${CADDY_CONTAINER}`.quiet().nothrow();
    } catch {
      // ignore
    }

    await ensureNetwork();

    // Generate initial config and write to host.
    writeCaddyConfigToDisk();

    log.info(
      { httpsPort, configPath: CADDY_CONFIG_PATH },
      'Starting Caddy container',
    );

    await $`docker run -d \
      --name ${CADDY_CONTAINER} \
      --network ${OX_NETWORK} \
      -p 127.0.0.1:${httpsPort}:443 \
      -v ${CADDY_CONFIG_PATH}:/etc/caddy/config.json:ro \
      -v ox-caddy-data:/data \
      ${CADDY_IMAGE} \
      caddy run --config /etc/caddy/config.json`.quiet();

    // Wait for container to be running (poll with timeout)
    const maxAttempts = 14;
    const pollMs = 500;
    let containerRunning = false;
    for (let i = 0; i < maxAttempts; i++) {
      if (await isCaddyRunning()) {
        containerRunning = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    if (!containerRunning) {
      throw new Error(
        'Caddy container failed to start within the expected timeframe',
      );
    }
  }

  // Wait for caddy's admin API to be ready. This runs regardless of whether
  // we just started the container or it was already running — another ox
  // process may have started it moments earlier with the admin API still
  // initializing. Without this, a subsequent `caddy reload` will fail with
  // "connection refused".
  const readyAttempts = 14;
  const readyPollMs = 500;
  for (let i = 0; i < readyAttempts; i++) {
    if (await isCaddyAdminReady()) {
      log.info('Caddy admin API is ready');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, readyPollMs));
  }

  throw new Error(
    'Caddy container is running but admin API did not become ready in time',
  );
}

// ---------------------------------------------------------------------------
// Config reload
// ---------------------------------------------------------------------------

/**
 * Write the current config to disk and reload Caddy.
 */
async function writeCaddyConfigAndReload(): Promise<void> {
  writeCaddyConfigToDisk();
  log.debug('Reloading Caddy config');
  await $`docker exec ${CADDY_CONTAINER} caddy reload --config /etc/caddy/config.json`.quiet();
}

// ---------------------------------------------------------------------------
// Route management
// ---------------------------------------------------------------------------

export interface AddRoutesOptions {
  isCloud?: boolean;
  externalUrls?: Record<number, string>;
}

/**
 * Register routes for a session and reload Caddy.
 */
export async function addRoutes(
  sessionId: string,
  containerName: string,
  ports: AppPortEntry[],
  options?: AddRoutesOptions,
): Promise<void> {
  const db = openSessionDb();
  upsertCaddyRoute(db, {
    sessionId,
    containerName,
    ports,
    isCloud: options?.isCloud ?? false,
    externalUrls: options?.externalUrls,
  });

  await writeCaddyConfigAndReload();
  log.info(
    { sessionId, containerName, portCount: ports.length },
    'Added Caddy routes',
  );
}

/**
 * Remove routes for a session and reload Caddy.
 */
export async function removeRoutes(sessionId: string): Promise<void> {
  const db = openSessionDb();
  deleteCaddyRoute(db, sessionId);

  if (await isCaddyRunning()) {
    await writeCaddyConfigAndReload();
  }

  log.info({ sessionId }, 'Removed Caddy routes');
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Force-stop and remove the Caddy container.
 */
export async function stopCaddy(): Promise<void> {
  log.info('Stopping Caddy container');
  await $`docker rm -f ${CADDY_CONTAINER}`.quiet().nothrow();
  const db = openSessionDb();
  deleteAllCaddyRoutes(db);
}

/**
 * Remove caddy_routes entries whose sessions no longer exist.
 *
 * Docker routes are validated by checking if the container is running.
 * Cloud routes are validated by checking the sessions DB.
 * This prevents stale rows (e.g., from a previous bug or crash) from
 * keeping Caddy alive indefinitely.
 */
export async function pruneStaleRoutes(): Promise<number> {
  const db = openSessionDb();
  const routes = listCaddyRoutes(db);
  for (const route of routes) {
    let exists = false;
    if (route.isCloud) {
      // Cloud session — check the sessions DB
      const session = dbGetSession(db, route.sessionId);
      exists = session != null && session.status === 'running';
    } else {
      // Docker session — check if the container is running
      try {
        const result =
          await $`docker inspect -f {{.State.Running}} ${route.containerName}`.quiet();
        exists = result.stdout.toString().trim() === 'true';
      } catch {
        exists = false;
      }
    }

    if (!exists) {
      log.debug(
        { sessionId: route.sessionId, containerName: route.containerName },
        'Pruning stale Caddy route',
      );
      deleteCaddyRoute(db, route.sessionId);
    }
  }

  return countCaddyRoutes(db);
}

/**
 * Stop Caddy if no active routes remain.
 * Prunes stale routes first to avoid keeping Caddy alive for orphaned entries.
 * No-ops silently if Caddy isn't running.
 */
export async function stopCaddyIfUnused(): Promise<void> {
  const remaining = await pruneStaleRoutes();
  if (remaining === 0 && (await isCaddyRunning())) {
    await stopCaddy();
  }
}

/**
 * Return the number of active sessions with registered routes.
 */
export function getActiveSessionCount(): number {
  const db = openSessionDb();
  return countCaddyRoutes(db);
}
