import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { log } from '../logger.ts';
import { ensureNetwork, OX_NETWORK } from './network.ts';
import type { AppPortEntry, CaddyRoute } from './types.ts';

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

/** In-memory map of registered routes keyed by sessionId */
const activeRoutes = new Map<string, CaddyRoute>();

/** Cached ports so addRoutes/removeRoutes don't need them re-passed */
let currentPorts: { httpsPort: number; httpPort: number } | null = null;

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
 */
export function generateCaddyConfig(
  httpsPort: number,
  httpPort: number,
): CaddyConfig {
  const routes: unknown[] = [];

  for (const route of activeRoutes.values()) {
    for (const portEntry of route.ports) {
      const host = portEntry.subdomain
        ? `${portEntry.subdomain}.${route.containerName}.ox.local`
        : `${route.containerName}.ox.local`;

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

  // Build the HTTPS redirect handler for HTTP server
  const redirectHandler: Record<string, unknown> = {
    handler: 'static_response',
    status_code: '301',
    headers: {
      Location: [
        httpsPort === 443
          ? 'https://{http.request.host}{http.request.uri}'
          : `https://{{http.request.hostport.host}}:${httpsPort}{{http.request.uri}}`,
      ],
    },
  };

  return {
    apps: {
      tls: {
        automation: {
          on_demand: true,
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
          redirect: {
            listen: [`:${httpPort}`],
            routes: [
              {
                handle: [redirectHandler],
              },
            ],
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
 * Start the Caddy container if it isn't already running.
 */
export async function ensureCaddy(
  httpsPort: number,
  httpPort: number,
): Promise<void> {
  currentPorts = { httpsPort, httpPort };

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

  // Generate initial config and write to host
  const config = generateCaddyConfig(httpsPort, httpPort);
  await Bun.write(CADDY_CONFIG_PATH, JSON.stringify(config, null, 2));

  log.info(
    { httpsPort, httpPort, configPath: CADDY_CONFIG_PATH },
    'Starting Caddy container',
  );

  await $`docker run -d \
    --name ${CADDY_CONTAINER} \
    --network ${OX_NETWORK} \
    -p 127.0.0.1:${httpsPort}:${httpsPort} \
    -p 127.0.0.1:${httpPort}:${httpPort} \
    -v ${CADDY_CONFIG_PATH}:/etc/caddy/config.json:ro \
    -v ox-caddy-data:/data \
    ${CADDY_IMAGE} \
    caddy run --config /etc/caddy/config.json --adapter json`.quiet();

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
async function writeCaddyConfigAndReload(
  httpsPort: number,
  httpPort: number,
): Promise<void> {
  const config = generateCaddyConfig(httpsPort, httpPort);
  await Bun.write(CADDY_CONFIG_PATH, JSON.stringify(config, null, 2));

  log.debug('Reloading Caddy config');
  await $`docker exec ${CADDY_CONTAINER} caddy reload --config /etc/caddy/config.json --adapter json`.quiet();
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
  activeRoutes.set(sessionId, {
    sessionId,
    containerName,
    ports,
    isCloud: options?.isCloud ?? false,
    externalUrls: options?.externalUrls,
  });

  if (!currentPorts) {
    throw new Error('Caddy ports not initialized — call ensureCaddy first');
  }

  await writeCaddyConfigAndReload(
    currentPorts.httpsPort,
    currentPorts.httpPort,
  );
  log.info(
    { sessionId, containerName, portCount: ports.length },
    'Added Caddy routes',
  );
}

/**
 * Remove routes for a session and reload Caddy.
 */
export async function removeRoutes(sessionId: string): Promise<void> {
  if (!activeRoutes.has(sessionId)) {
    return;
  }

  activeRoutes.delete(sessionId);

  if (currentPorts && (await isCaddyRunning())) {
    await writeCaddyConfigAndReload(
      currentPorts.httpsPort,
      currentPorts.httpPort,
    );
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
  activeRoutes.clear();
  currentPorts = null;
}

/**
 * Stop Caddy if no active routes remain.
 */
export async function stopCaddyIfUnused(): Promise<void> {
  if (activeRoutes.size === 0) {
    await stopCaddy();
  }
}

/**
 * Return the number of active sessions with registered routes.
 */
export function getActiveSessionCount(): number {
  return activeRoutes.size;
}
