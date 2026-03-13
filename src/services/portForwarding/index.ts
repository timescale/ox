// ============================================================================
// Port Forwarding Orchestrator — public API
// ============================================================================

import { readConfig } from '../config.ts';
import { log } from '../logger.ts';
import {
  addRoutes,
  ensureCaddy,
  removeRoutes,
  stopCaddyIfUnused,
} from './caddy.ts';
import { ensureCertTrusted } from './certs.ts';
import { normalizeAppPorts } from './config.ts';
import { ensureDns } from './dns.ts';
import {
  connectToNetwork,
  disconnectFromNetwork,
  ensureNetwork,
} from './network.ts';
import { resolveProxyPorts } from './portUtils.ts';
import type { RequestSudoFn } from './sudo.ts';
import type { PortUrl } from './types.ts';

// Re-exports
export { normalizeAppPorts } from './config.ts';
export type { AppPortEntry, PortUrl, ResolvedPortConfig } from './types.ts';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let resolvedPorts: { httpsPort: number; httpPort: number } | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildUrl(
  containerName: string,
  subdomain: string | undefined,
  httpsPort: number,
): string {
  const host = subdomain
    ? `${subdomain}.${containerName}.ox.local`
    : `${containerName}.ox.local`;
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

    // Use cached resolved ports if available, otherwise assume 443
    const httpsPort = resolvedPorts?.httpsPort ?? 443;
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
    // 1. Read config, normalize app ports
    const config = await readConfig();
    const portConfig = normalizeAppPorts(config);
    if (!portConfig) {
      return null;
    }

    // 2. Ensure network, connect container
    await ensureNetwork();
    await connectToNetwork(containerName);

    // 3. Resolve proxy ports (cached), ensure Caddy running
    if (!resolvedPorts) {
      resolvedPorts = await resolveProxyPorts(config.proxyPort);
    }
    const { httpsPort, httpPort } = resolvedPorts;
    await ensureCaddy(httpsPort, httpPort);

    // 4. Ensure DNS, ensure cert trusted
    await ensureDns(requestSudo);
    await ensureCertTrusted(requestSudo);

    // 5. Add routes to Caddy
    await addRoutes(sessionId, containerName, portConfig.ports);

    // 6. Build and return PortUrl array
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
    // 1. Read config, normalize app ports
    const config = await readConfig();
    const portConfig = normalizeAppPorts(config);
    if (!portConfig) {
      return null;
    }

    // 2. Ensure network (no container to connect for cloud)
    await ensureNetwork();

    // 3. Resolve proxy ports (cached), ensure Caddy running
    if (!resolvedPorts) {
      resolvedPorts = await resolveProxyPorts(config.proxyPort);
    }
    const { httpsPort, httpPort } = resolvedPorts;
    await ensureCaddy(httpsPort, httpPort);

    // 4. Ensure DNS, ensure cert trusted
    await ensureDns(requestSudo);
    await ensureCertTrusted(requestSudo);

    // 5. Add routes to Caddy (with cloud options)
    await addRoutes(sessionId, containerName, portConfig.ports, {
      isCloud: true,
      externalUrls: Object.fromEntries(externalUrls),
    });

    // 6. Build and return PortUrl array (including external URLs)
    return portConfig.ports.map((entry) => ({
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
