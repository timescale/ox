import type { AppPortEntry, ResolvedPortConfig } from './types.ts';

interface PortConfigInput {
  appPort?: number;
  appPorts?: { port: number; subdomain?: string }[];
}

/**
 * Normalize and validate port forwarding config from project/user config.
 *
 * - Returns null if no port config is present.
 * - Errors if both `appPort` and `appPorts` are specified.
 * - `appPort` normalizes to a single-entry array.
 * - Ports must be integers in 1–65535.
 * - No duplicate port numbers.
 * - Exactly one entry must lack a `subdomain` (the default port).
 */
export function normalizeAppPorts(
  config: PortConfigInput,
): ResolvedPortConfig | null {
  const { appPort, appPorts } = config;

  if (appPort == null && appPorts == null) {
    return null;
  }

  if (appPort != null && appPorts != null) {
    throw new Error(
      'Cannot specify both appPort and appPorts. Use appPorts for multiple port mappings.',
    );
  }

  const entries: AppPortEntry[] =
    appPort != null ? [{ port: appPort }] : (appPorts as AppPortEntry[]);

  // Validate each port
  for (const entry of entries) {
    if (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) {
      throw new Error(
        `Invalid port number: ${entry.port}. Must be an integer between 1 and 65535.`,
      );
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

  // Exactly one entry must lack a subdomain (the default port)
  const defaultEntries = entries.filter((e) => e.subdomain == null);
  if (defaultEntries.length === 0) {
    throw new Error(
      'At least one port entry must lack a subdomain (the default port).',
    );
  }
  if (defaultEntries.length > 1) {
    throw new Error(
      'Only one port entry may lack a subdomain (the default port).',
    );
  }

  return {
    ports: entries,
    defaultPort: defaultEntries[0] as AppPortEntry,
  };
}
