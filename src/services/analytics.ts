// ============================================================================
// Analytics Service - Anonymous usage analytics via PostHog
// ============================================================================
//
// Follows the same patterns as tiger-cli's analytics module:
// - Fire-and-forget: analytics never blocks or fails user operations
// - Opt-out via config or environment variables
// - No sensitive data: blocklist of property keys, no free-text user input
// - Anonymous identity via persistent random ID
//

import { join } from 'node:path';
import { PostHog } from 'posthog-node';
import packageJson from '../../package.json' with { type: 'json' };
import { readConfig, userConfigDir } from './config';
import { log } from './logger';

// ============================================================================
// Constants
// ============================================================================

// PostHog write-only project API key (safe to embed in client code)
const POSTHOG_API_KEY = 'phc_OsZpGzq2LBW8OMXjdktxavhYkehe8R05zsW0zN6prLF';
const POSTHOG_HOST = 'https://us.i.posthog.com';

const ANALYTICS_ID_FILENAME = 'analytics-id';

/** Property keys that are never sent to analytics */
const IGNORED_PROPERTIES = new Set([
  'password',
  'secret',
  'token',
  'key',
  'api_key',
  'apiKey',
  'auth',
  'credential',
  'cookie',
  'prompt',
  'query',
]);

// ============================================================================
// State
// ============================================================================

let client: PostHog | null = null;
let distinctId: string | null = null;
let analyticsEnabled: boolean | null = null;
let shutdownRegistered = false;

// ============================================================================
// Helpers
// ============================================================================

function envVarIsTrue(envVar: string): boolean {
  const val = process.env[envVar];
  if (!val) return false;
  const normalized = val.toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function envVarIsFalse(envVar: string): boolean {
  const val = process.env[envVar];
  if (!val) return false;
  const normalized = val.toLowerCase();
  return normalized === '0' || normalized === 'false' || normalized === 'no';
}

/**
 * Check if analytics is disabled via environment variables.
 * Matches the standard conventions used by tiger-cli and other CLIs.
 */
function isDisabledByEnv(): boolean {
  return (
    envVarIsTrue('DO_NOT_TRACK') ||
    envVarIsTrue('NO_TELEMETRY') ||
    envVarIsTrue('DISABLE_TELEMETRY') ||
    envVarIsFalse('OX_ANALYTICS')
  );
}

/**
 * Check if we're running in a test environment.
 */
function isTestEnv(): boolean {
  return (
    process.env.NODE_ENV === 'test' ||
    process.env.BUN_ENV === 'test' ||
    (typeof Bun !== 'undefined' && Bun.argv.includes('test'))
  );
}

/**
 * Filter properties to remove any that match the ignore list.
 */
function filterProperties(
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!IGNORED_PROPERTIES.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * Get or create a persistent anonymous distinct ID.
 * Stored in the user config directory so it survives across sessions.
 */
async function getOrCreateDistinctId(): Promise<string> {
  if (distinctId) return distinctId;

  const idPath = join(userConfigDir(), ANALYTICS_ID_FILENAME);
  const file = Bun.file(idPath);

  try {
    if (await file.exists()) {
      const stored = (await file.text()).trim();
      if (stored) {
        distinctId = stored;
        return stored;
      }
    }
  } catch {
    // Fall through to generate new ID
  }

  // Generate a new anonymous ID
  const { nanoid } = await import('nanoid');
  const newId = nanoid();

  try {
    await Bun.write(idPath, newId);
  } catch {
    // Non-fatal: we can still use the ID for this session
    log.debug('Failed to persist analytics ID');
  }

  distinctId = newId;
  return newId;
}

/**
 * Check if analytics is enabled, reading config only once per process.
 */
async function isEnabled(): Promise<boolean> {
  // Fast path: already determined
  if (analyticsEnabled !== null) return analyticsEnabled;

  // Environment variables take precedence
  if (isDisabledByEnv() || isTestEnv()) {
    analyticsEnabled = false;
    return false;
  }

  // Check config (default: true / opt-out model)
  try {
    const config = await readConfig();
    analyticsEnabled = config.analytics !== false;
  } catch {
    // If we can't read config, default to enabled
    analyticsEnabled = true;
  }

  return analyticsEnabled;
}

/**
 * Get or create the PostHog client singleton.
 */
function getClient(): PostHog {
  if (!client) {
    client = new PostHog(POSTHOG_API_KEY, {
      host: POSTHOG_HOST,
      // Flush after each event to ensure delivery before process exits
      flushAt: 1,
      flushInterval: 0,
    });

    // Register shutdown handler to flush pending events
    if (!shutdownRegistered) {
      shutdownRegistered = true;
      process.on('beforeExit', () => {
        client?._shutdown(2000).catch(() => {});
      });
    }
  }
  return client;
}

// ============================================================================
// Common Properties
// ============================================================================

/**
 * Properties included with every event.
 */
function commonProperties(): Record<string, unknown> {
  return {
    source: 'ox',
    ox_version: packageJson.version,
    os: process.platform,
    arch: process.arch,
  };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Track an analytics event. Fire-and-forget: never throws, never blocks.
 *
 * @param event - Event name (e.g., 'command_executed', 'session_started')
 * @param properties - Additional event properties (sensitive keys are filtered)
 */
export function track(
  event: string,
  properties: Record<string, unknown> = {},
): void {
  // Perform async check without blocking the caller
  isEnabled()
    .then(async (enabled) => {
      if (!enabled) return;

      try {
        const id = await getOrCreateDistinctId();
        const ph = getClient();

        const payload = {
          distinctId: id,
          event,
          properties: {
            ...filterProperties(properties),
            ...commonProperties(),
          },
        };
        ph.capture(payload);
        log.trace(payload, 'Analytics event tracked');
      } catch (err) {
        log.debug({ event, err }, 'Failed to send analytics event');
      }
    })
    .catch(() => {
      // Swallow all errors - analytics must never affect user operations
    });
}

/**
 * Identify the current user with properties. Fire-and-forget.
 * Used when we learn more about the user (e.g., Tiger service link).
 *
 * @param properties - User properties to set (sensitive keys are filtered)
 */
export function identify(properties: Record<string, unknown> = {}): void {
  isEnabled()
    .then(async (enabled) => {
      if (!enabled) return;

      try {
        const id = await getOrCreateDistinctId();
        const ph = getClient();

        ph.identify({
          distinctId: id,
          properties: {
            ...filterProperties(properties),
            ...commonProperties(),
          },
        });
      } catch (err) {
        log.debug({ err }, 'Failed to send analytics identify');
      }
    })
    .catch(() => {});
}

/**
 * Flush pending events and shut down the analytics client.
 * Called during process exit to ensure events are delivered.
 */
export async function shutdown(): Promise<void> {
  if (!client) return;
  try {
    await client._shutdown(2000);
  } catch {
    // Non-fatal
  }
  client = null;
}

/**
 * Reset the enabled state cache. Useful after config changes
 * (e.g., user disables analytics via config wizard).
 */
export function resetAnalyticsState(): void {
  analyticsEnabled = null;
}
