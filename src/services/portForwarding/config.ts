import type { AppPortEntry, ResolvedPortConfig } from './types.ts';

/** Strip the `ox-` prefix from container names for friendlier URLs. */
export function sessionSubdomain(containerName: string): string {
  return containerName.replace(/^ox-/, '');
}

interface PortConfigInput {
  appPort?: number;
  additionalPorts?: { port: number; subdomain: string }[];
}

/**
 * Normalize and validate port forwarding config from project/user config.
 *
 * - Returns null if no port config is present.
 * - `appPort` is always the default route (no subdomain).
 * - `additionalPorts` entries each require a non-empty subdomain.
 * - `additionalPorts` without `appPort` is an error.
 * - Ports must be integers in 1–65535.
 * - No duplicate port numbers.
 */
export function normalizeAppPorts(
  config: PortConfigInput,
): ResolvedPortConfig | null {
  const { appPort, additionalPorts } = config;

  if (appPort == null && additionalPorts == null) {
    return null;
  }

  if (additionalPorts != null && appPort == null) {
    throw new Error(
      'appPort is required when using additionalPorts. Set appPort for the default route.',
    );
  }

  // Validate appPort
  if (
    appPort != null &&
    (!Number.isInteger(appPort) || appPort < 1 || appPort > 65535)
  ) {
    throw new Error(
      `Invalid port number: ${appPort}. Must be an integer between 1 and 65535.`,
    );
  }

  const defaultEntry: AppPortEntry = { port: appPort as number };
  const entries: AppPortEntry[] = [defaultEntry];

  if (additionalPorts != null) {
    for (const entry of additionalPorts) {
      // Validate port number
      if (
        !Number.isInteger(entry.port) ||
        entry.port < 1 ||
        entry.port > 65535
      ) {
        throw new Error(
          `Invalid port number: ${entry.port}. Must be an integer between 1 and 65535.`,
        );
      }
      // Validate subdomain is present and non-empty
      if (!entry.subdomain || typeof entry.subdomain !== 'string') {
        throw new Error(
          `Each additionalPorts entry must have a non-empty subdomain. Port ${entry.port} is missing one.`,
        );
      }
      entries.push({ port: entry.port, subdomain: entry.subdomain });
    }
  }

  // Check for duplicate ports
  const seen = new Set<number>();
  for (const entry of entries) {
    if (seen.has(entry.port)) {
      throw new Error(`Duplicate port number: ${entry.port}`);
    }
    seen.add(entry.port);
  }

  return {
    ports: entries,
    defaultPort: defaultEntry,
  };
}
