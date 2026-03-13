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
// State
// ---------------------------------------------------------------------------

/** Cached HTTPS port so addRoutes/removeRoutes don't need it re-passed */
let currentHttpsPort: number | null = null;

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
export function generateCaddyConfig(httpsPort: number): CaddyConfig {
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
            listen: [`:${httpsPort}`],
            routes,
            tls_connection_policies: [{}],
          },
        },
      },
    },
  };
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
 * Get the HTTPS port that the running Caddy container is bound to.
 * Returns null if Caddy isn't running or the port can't be determined.
 */
export async function getCaddyHttpsPort(): Promise<number | null> {
  try {
    // docker port returns lines like "8443/tcp -> 127.0.0.1:8443"
    const result = await $`docker port ${CADDY_CONTAINER}`.quiet();
    const match = result.stdout.toString().match(/^(\d+)\/tcp/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Start the Caddy container if it isn't already running.
 */
export async function ensureCaddy(httpsPort: number): Promise<void> {
  currentHttpsPort = httpsPort;

  if (await isCaddyRunning()) {
    log.debug('Caddy container already running');
    return;
  }

  // Remove any stopped container
  try {
    await $`docker rm -f ${CADDY_CONTAINER}`.quiet().nothrow();
  } catch {
    // ignore
  }

  await ensureNetwork();

  // Generate initial config and write to host.
  // Use writeFileSync + fsyncSync to guarantee data reaches disk before
  // Docker mounts the file — macOS VirtioFS can see a partial file otherwise.
  const config = generateCaddyConfig(httpsPort);
  const configJson = JSON.stringify(config, null, 2);
  const fd = openSync(CADDY_CONFIG_PATH, 'w');
  writeSync(fd, configJson);
  fsyncSync(fd);
  closeSync(fd);

  log.info(
    { httpsPort, configPath: CADDY_CONFIG_PATH },
    'Starting Caddy container',
  );

  await $`docker run -d \
    --name ${CADDY_CONTAINER} \
    --network ${OX_NETWORK} \
    -p 127.0.0.1:${httpsPort}:${httpsPort} \
    -v ${CADDY_CONFIG_PATH}:/etc/caddy/config.json:ro \
    -v ox-caddy-data:/data \
    ${CADDY_IMAGE} \
    caddy run --config /etc/caddy/config.json`.quiet();

  // Wait for container to be running (poll with timeout)
  const maxAttempts = 14;
  const pollMs = 500;
  for (let i = 0; i < maxAttempts; i++) {
    if (await isCaddyRunning()) {
      log.info('Caddy container is running');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error(
    'Caddy container failed to start within the expected timeframe',
  );
}

// ---------------------------------------------------------------------------
// Config reload
// ---------------------------------------------------------------------------

/**
 * Write the current config to disk and reload Caddy.
 */
async function writeCaddyConfigAndReload(httpsPort: number): Promise<void> {
  const config = generateCaddyConfig(httpsPort);
  const configJson = JSON.stringify(config, null, 2);
  const fd = openSync(CADDY_CONFIG_PATH, 'w');
  writeSync(fd, configJson);
  fsyncSync(fd);
  closeSync(fd);

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

  if (!currentHttpsPort) {
    throw new Error('Caddy port not initialized — call ensureCaddy first');
  }

  await writeCaddyConfigAndReload(currentHttpsPort);
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

  if (currentHttpsPort && (await isCaddyRunning())) {
    await writeCaddyConfigAndReload(currentHttpsPort);
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
  currentHttpsPort = null;
}

/**
 * Remove caddy_routes entries whose sessions no longer exist.
 *
 * Docker routes are validated by checking if the container is running.
 * Cloud routes are validated by checking the sessions DB.
 * This prevents stale rows (e.g., from a previous bug or crash) from
 * keeping Caddy alive indefinitely.
 */
export async function pruneStaleRoutes(): Promise<void> {
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
}

/**
 * Stop Caddy if no active routes remain.
 * Prunes stale routes first to avoid keeping Caddy alive for orphaned entries.
 * No-ops silently if Caddy isn't running.
 */
export async function stopCaddyIfUnused(): Promise<void> {
  await pruneStaleRoutes();
  const db = openSessionDb();
  if (countCaddyRoutes(db) === 0 && (await isCaddyRunning())) {
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
