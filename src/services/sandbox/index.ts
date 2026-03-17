// ============================================================================
// Sandbox Provider - Factory and re-exports
// ============================================================================

export { CloudSandboxProvider } from './cloudProvider.ts';
export { DockerSandboxProvider } from './dockerProvider.ts';
export type {
  AgentMode,
  CreateSandboxOptions,
  CreateShellSandboxOptions,
  ExecType,
  LogStream,
  OxSession,
  ResumeSandboxOptions,
  SandboxBuildProgress,
  SandboxProvider,
  SandboxProviderType,
  SandboxStats,
  ShellSession,
} from './types.ts';

import { track } from '../analytics.ts';
import { readConfig } from '../config.ts';
import { credentialWatcher } from '../credentialWatcher.ts';
import { log } from '../logger.ts';
import { CloudSandboxProvider } from './cloudProvider.ts';
import { DockerSandboxProvider } from './dockerProvider.ts';
import type {
  CreateSandboxOptions,
  OxSession,
  ResumeSandboxOptions,
  SandboxProvider,
  SandboxProviderType,
} from './types.ts';

/**
 * Wrap a SandboxProvider to add analytics tracking for lifecycle events.
 * The wrapper delegates all calls to the inner provider and tracks
 * session creation, resume, stop, and removal.
 */
function withAnalytics(inner: SandboxProvider): SandboxProvider {
  const originalCreate = inner.create.bind(inner);
  inner.create = async (options: CreateSandboxOptions) => {
    const start = Date.now();
    const properties = {
      provider: inner.type,
      agent: options.agent,
      model: options.model,
      has_db_fork: !!options.envVars,
      has_root_init_script: !!options.rootInitScript,
      has_init_script: !!options.initScript,
      is_mount_mode: !!options.mountDir,
      interactive: options.interactive,
    };
    let session: OxSession;
    try {
      session = await originalCreate(options);
    } catch (err) {
      track('session_created', {
        ...properties,
        elapsed_seconds: (Date.now() - start) / 1000,
        success: false,
        error_type: err instanceof Error ? err.constructor.name : 'Unknown',
      });
      throw err;
    }
    // Register with credential watcher
    try {
      credentialWatcher.register(session, inner);
    } catch (err) {
      log.debug({ err }, 'Failed to register session with credential watcher');
    }
    track('session_created', {
      ...properties,
      elapsed_seconds: (Date.now() - start) / 1000,
      success: true,
    });
    return session;
  };

  const originalResume = inner.resume.bind(inner);
  inner.resume = async (sessionId: string, options: ResumeSandboxOptions) => {
    const start = Date.now();
    let session: OxSession;
    try {
      session = await originalResume(sessionId, options);
    } catch (err) {
      track('session_resumed', {
        provider: inner.type,
        mode: options.mode,
        elapsed_seconds: (Date.now() - start) / 1000,
        success: false,
        error_type: err instanceof Error ? err.constructor.name : 'Unknown',
      });
      throw err;
    }
    // Register with credential watcher
    try {
      credentialWatcher.register(session, inner);
    } catch (err) {
      log.debug({ err }, 'Failed to register session with credential watcher');
    }
    track('session_resumed', {
      provider: inner.type,
      agent: session.agent,
      mode: options.mode,
      elapsed_seconds: (Date.now() - start) / 1000,
      success: true,
    });
    return session;
  };

  const originalStop = inner.stop.bind(inner);
  inner.stop = async (sessionId: string) => {
    credentialWatcher.unregister(sessionId);
    try {
      await originalStop(sessionId);
      track('session_stopped', { provider: inner.type, success: true });
    } catch (err) {
      track('session_stopped', {
        provider: inner.type,
        success: false,
        error_type: err instanceof Error ? err.constructor.name : 'Unknown',
      });
      throw err;
    }
  };

  const originalRemove = inner.remove.bind(inner);
  inner.remove = async (sessionId: string) => {
    credentialWatcher.unregister(sessionId);
    try {
      await originalRemove(sessionId);
      track('session_removed', { provider: inner.type, success: true });
    } catch (err) {
      track('session_removed', {
        provider: inner.type,
        success: false,
        error_type: err instanceof Error ? err.constructor.name : 'Unknown',
      });
      throw err;
    }
  };

  return inner;
}

/**
 * Get a sandbox provider instance by type.
 */
export function getSandboxProvider(type: SandboxProviderType): SandboxProvider {
  switch (type) {
    case 'docker':
      return withAnalytics(new DockerSandboxProvider());
    case 'cloud':
      return withAnalytics(new CloudSandboxProvider());
    default:
      throw new Error(`Unknown sandbox provider type: ${type}`);
  }
}

/**
 * Get the default sandbox provider based on user/project config.
 * Falls back to 'docker' if not configured.
 */
export async function getDefaultProvider(): Promise<SandboxProvider> {
  const config = await readConfig();
  return getSandboxProvider(config.sandboxProvider ?? 'docker');
}

/**
 * Get the appropriate provider for an existing session.
 * Uses the session's `provider` field to select the correct implementation.
 */
export function getProviderForSession(session: OxSession): SandboxProvider {
  return getSandboxProvider(session.provider);
}

/**
 * List sessions across all providers.
 * Returns a single merged list, sorted by creation time descending.
 */
export async function listAllSessions(): Promise<OxSession[]> {
  const providerTypes: SandboxProviderType[] = ['docker', 'cloud'];

  const providers = providerTypes.map((type) => ({
    type,
    provider: getSandboxProvider(type),
  }));

  const results = await Promise.allSettled(
    providers.map((p) => p.provider.list()),
  );
  const sessions: OxSession[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const providerType = providers[i]?.type;
    if (!result) continue;
    if (result.status === 'fulfilled') {
      sessions.push(...result.value);
    } else {
      log.debug(
        { err: result.reason, provider: providerType },
        'Failed to list sessions for provider',
      );
    }
  }

  sessions.sort((a, b) => {
    const aTime = Date.parse(a.created);
    const bTime = Date.parse(b.created);
    if (Number.isNaN(aTime) || Number.isNaN(bTime)) return 0;
    return bTime - aTime;
  });

  return sessions;
}

/**
 * Resolve a session by name, container name, or ID.
 * Returns the session and its provider, or null if not found.
 */
export async function resolveSession(
  idOrName: string,
): Promise<{ session: OxSession; provider: SandboxProvider } | null> {
  const sessions = await listAllSessions();

  // 1. Try matching by name
  const nameMatches = sessions.filter((s) => s.name === idOrName);
  let session: OxSession | undefined;

  if (nameMatches.length > 1) {
    // Ambiguous — require full ID to disambiguate
    const ids = nameMatches.map((s) => `  ${s.id} (${s.provider})`).join('\n');
    throw new Error(
      `Ambiguous session name "${idOrName}" matches ${nameMatches.length} sessions. Use the full ID:\n${ids}`,
    );
  }
  session = nameMatches[0];

  // 2. Fallback: match by containerName or ID
  if (!session) {
    session = sessions.find(
      (s) => s.containerName === idOrName || s.id === idOrName,
    );
  }

  // 3. Fallback: query each provider directly
  if (!session) {
    for (const providerType of ['docker', 'cloud'] as const) {
      const p = getSandboxProvider(providerType);
      const found = await p.get(idOrName);
      if (found) {
        session = found;
        break;
      }
    }
  }

  if (!session) return null;

  return { session, provider: getProviderForSession(session) };
}
