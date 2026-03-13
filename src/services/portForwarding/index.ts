// ============================================================================
// Port Forwarding Orchestrator — public API
// ============================================================================

import { readConfig } from '../config.ts';
import { log } from '../logger.ts';
import {
  addRoutes,
  ensureCaddy,
  getCaddyHttpsPort,
  removeRoutes,
  stopCaddyIfUnused,
} from './caddy.ts';
import { ensureCertTrusted } from './certs.ts';
import { normalizeAppPorts, sessionSubdomain } from './config.ts';
import { ensureDns } from './dns.ts';
import {
  connectToNetwork,
  disconnectFromNetwork,
  ensureNetwork,
} from './network.ts';
import { resolveProxyPort } from './portUtils.ts';
import type { RequestSudoFn } from './sudo.ts';
import type { PortUrl, ResolvedPortConfig } from './types.ts';

// Re-exports
export { normalizeAppPorts } from './config.ts';
export type { AppPortEntry, PortUrl, ResolvedPortConfig } from './types.ts';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let resolvedHttpsPort: number | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine the host-side HTTPS port for Caddy.
 *
 * Priority:
 *   1. In-process cache (set during this process's setupPortForwarding)
 *   2. Already-running Caddy container (discovered via `docker port`)
 *   3. Resolve a new candidate port via `resolveProxyPort()`
 *
 * Caches the result in `resolvedHttpsPort` for subsequent calls.
 */
async function resolveHttpsPort(proxyPort?: number): Promise<number> {
  if (resolvedHttpsPort) return resolvedHttpsPort;

  // Check if Caddy is already running (e.g., started by another ox process)
  const existingPort = await getCaddyHttpsPort();
  if (existingPort) {
    resolvedHttpsPort = existingPort;
    return existingPort;
  }

  // No running Caddy — resolve a fresh port
  const port = await resolveProxyPort(proxyPort);
  resolvedHttpsPort = port;
  return port;
}

function buildUrl(
  containerName: string,
  subdomain: string | undefined,
  httpsPort: number,
): string {
  const base = sessionSubdomain(containerName);
  const host = subdomain ? `${subdomain}.${base}.ox.local` : `${base}.ox.local`;
  const portSuffix = httpsPort === 443 ? '' : `:${httpsPort}`;
  return `https://${host}${portSuffix}`;
}

// ---------------------------------------------------------------------------
// URL derivation (no side effects — for reconstructing URLs from config)
// ---------------------------------------------------------------------------

/**
 * Derive port URLs for a container from config alone (no Caddy/DNS setup).
 * Used to reconstruct `portUrls` when fetching existing sessions.
 *
 * Returns null if no appPorts configured.
 */
export async function getPortUrls(
  containerName: string,
): Promise<PortUrl[] | null> {
  try {
    const config = await readConfig();
    const portConfig = normalizeAppPorts(config);
    if (!portConfig) return null;

    // Use cached port if this process set up port forwarding, otherwise
    // discover the HTTPS port from the running Caddy container.
    const httpsPort = resolvedHttpsPort ?? (await getCaddyHttpsPort()) ?? 443;
    return portConfig.ports.map((entry) => ({
      port: entry.port,
      subdomain: entry.subdomain,
      url: buildUrl(containerName, entry.subdomain, httpsPort),
    }));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shared infrastructure setup
// ---------------------------------------------------------------------------

/**
 * Shared setup steps for both Docker and cloud port forwarding:
 * read config, resolve ports, ensure Caddy/DNS/certs.
 *
 * Returns null if no port config is present.
 */
async function ensurePortForwardingInfra(
  requestSudo?: RequestSudoFn,
): Promise<{ portConfig: ResolvedPortConfig; httpsPort: number } | null> {
  const config = await readConfig();
  const portConfig = normalizeAppPorts(config);
  if (!portConfig) return null;

  await ensureNetwork();

  const httpsPort = await resolveHttpsPort(config.proxyPort);
  await ensureCaddy(httpsPort);

  await ensureDns(requestSudo);
  await ensureCertTrusted(requestSudo);

  return { portConfig, httpsPort };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/**
 * Set up port forwarding for a Docker sandbox session.
 *
 * Best-effort: returns null on any failure.
 */
export async function setupPortForwarding(
  sessionId: string,
  containerName: string,
  requestSudo?: RequestSudoFn,
): Promise<PortUrl[] | null> {
  try {
    const infra = await ensurePortForwardingInfra(requestSudo);
    if (!infra) return null;
    const { portConfig, httpsPort } = infra;

    await connectToNetwork(containerName);
    await addRoutes(sessionId, containerName, portConfig.ports);

    return portConfig.ports.map((entry) => ({
      port: entry.port,
      subdomain: entry.subdomain,
      url: buildUrl(containerName, entry.subdomain, httpsPort),
    }));
  } catch (err) {
    log.warn({ err, sessionId, containerName }, 'Port forwarding setup failed');
    return null;
  }
}

/**
 * Set up port forwarding for a cloud sandbox session.
 *
 * Similar to `setupPortForwarding` but does not connect a Docker container
 * to the network (cloud sessions have no local container). Routes are
 * configured to proxy to the external URLs provided by the cloud provider.
 *
 * Best-effort: returns null on any failure.
 */
export async function setupCloudPortForwarding(
  sessionId: string,
  containerName: string,
  externalUrls: Map<number, string>,
  requestSudo?: RequestSudoFn,
): Promise<PortUrl[] | null> {
  try {
    const infra = await ensurePortForwardingInfra(requestSudo);
    if (!infra) return null;
    const { portConfig, httpsPort } = infra;

    // Only register routes for successfully exposed ports
    const exposedPorts = portConfig.ports.filter((entry) =>
      externalUrls.has(entry.port),
    );
    if (exposedPorts.length === 0) {
      log.warn(
        'No ports were successfully exposed — skipping cloud port forwarding',
      );
      return null;
    }
    await addRoutes(sessionId, containerName, exposedPorts, {
      isCloud: true,
      externalUrls: Object.fromEntries(externalUrls),
    });

    return exposedPorts.map((entry) => ({
      port: entry.port,
      subdomain: entry.subdomain,
      url: buildUrl(containerName, entry.subdomain, httpsPort),
      externalUrl: externalUrls.get(entry.port),
    }));
  } catch (err) {
    log.warn(
      { err, sessionId, containerName },
      'Cloud port forwarding setup failed',
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

/**
 * Tear down port forwarding for a session.
 *
 * Best-effort: logs on failure but does not throw.
 */
export async function teardownPortForwarding(
  sessionId: string,
  containerName?: string,
): Promise<void> {
  try {
    // 1. Remove routes from Caddy
    await removeRoutes(sessionId);

    // 2. Disconnect container from network (if provided)
    if (containerName) {
      await disconnectFromNetwork(containerName);
    }

    // 3. Stop Caddy if unused
    await stopCaddyIfUnused();
  } catch (err) {
    log.warn(
      { err, sessionId, containerName },
      'Port forwarding teardown failed',
    );
  }
}
