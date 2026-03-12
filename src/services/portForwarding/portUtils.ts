import { createServer } from 'node:net';

/**
 * Check whether a TCP port is available on 127.0.0.1.
 * Tries to bind a server; resolves true if successful, false if in use.
 */
export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Resolve the HTTPS and HTTP ports for the local reverse proxy (Caddy).
 *
 * Preference order for HTTPS:
 *   1. Configured `proxyPort` (if provided)
 *   2. 443
 *   3. 8443
 *   4. 9443
 *   5. Random available port
 *
 * The HTTP port is always HTTPS port + 1000 (or random if unavailable).
 */
export async function resolveProxyPorts(
  proxyPort?: number,
): Promise<{ httpsPort: number; httpPort: number }> {
  const candidates = proxyPort != null ? [proxyPort] : [443, 8443, 9443];

  for (const port of candidates) {
    if (await isPortAvailable(port)) {
      const httpPort = port + 1000;
      const httpAvailable = await isPortAvailable(httpPort);
      return {
        httpsPort: port,
        httpPort: httpAvailable ? httpPort : await findRandomPort(),
      };
    }
  }

  // All candidates taken — use a random port
  const httpsPort = await findRandomPort();
  const httpPort = await findRandomPort();
  return { httpsPort, httpPort };
}

/** Bind to port 0 and return the OS-assigned port. */
function findRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}
