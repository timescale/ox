import { createServer } from 'node:net';
import { $ } from 'bun';

/**
 * Check whether a TCP port is available on 127.0.0.1.
 *
 * For privileged ports (< 1024), a userspace bind always fails with EACCES
 * regardless of whether the port is free, so we use `lsof` to check.
 * For unprivileged ports, we try to bind a server directly.
 */
export async function isPortAvailable(port: number): Promise<boolean> {
  if (port < 1024) {
    return isPrivilegedPortAvailable(port);
  }
  return isUnprivilegedPortAvailable(port);
}

/**
 * Check a privileged port via lsof (bind would always fail with EACCES).
 * Returns true if nothing is listening on the port.
 */
async function isPrivilegedPortAvailable(port: number): Promise<boolean> {
  try {
    // lsof exits 0 if it finds matches, 1 if none
    const result = await $`lsof -iTCP:${port} -sTCP:LISTEN -P -n`
      .quiet()
      .nothrow();
    // If lsof found listeners, the port is taken
    return result.exitCode !== 0;
  } catch {
    // lsof not available — assume port is available and let Docker fail
    // gracefully if it's actually taken
    return true;
  }
}

/**
 * Check an unprivileged port by attempting to bind.
 */
function isUnprivilegedPortAvailable(port: number): Promise<boolean> {
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
