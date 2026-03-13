import { createServer } from 'node:net';

/**
 * Check whether a TCP port is available on 127.0.0.1.
 * Tries to bind a server; resolves true if successful, false if in use.
 *
 * EACCES (permission denied for privileged ports < 1024) is treated as
 * "available" because Docker can still map the port via its own mechanisms.
 */
export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      // EACCES means the port is free but requires root to bind directly —
      // Docker handles privileged port mapping itself, so treat as available.
      resolve(err.code === 'EACCES');
    });
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Resolve the HTTPS port for the local reverse proxy (Caddy).
 *
 * Preference order:
 *   1. Configured `proxyPort` (if provided)
 *   2. 443
 *   3. 8443
 *   4. 9443
 *   5. Random available port
 */
export async function resolveProxyPort(proxyPort?: number): Promise<number> {
  const candidates = proxyPort != null ? [proxyPort] : [443, 8443, 9443];

  for (const port of candidates) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  // All candidates taken — use a random port
  return findRandomPort();
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
