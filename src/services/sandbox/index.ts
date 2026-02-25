// ============================================================================
// Sandbox Provider - Factory and re-exports
// ============================================================================

export { CloudSandboxProvider } from './cloudProvider.ts';
export { DockerSandboxProvider } from './dockerProvider.ts';
export type {
  CreateSandboxOptions,
  CreateShellSandboxOptions,
  ExecType,
  HermesSession,
  LogStream,
  ResumeSandboxOptions,
  SandboxBuildProgress,
  SandboxProvider,
  SandboxProviderType,
  SandboxStats,
  ShellSession,
} from './types.ts';

import { readConfig } from '../config.ts';
import { log } from '../logger.ts';
import { CloudSandboxProvider } from './cloudProvider.ts';
import { DockerSandboxProvider } from './dockerProvider.ts';
import type {
  HermesSession,
  SandboxProvider,
  SandboxProviderType,
} from './types.ts';

/**
 * Get a sandbox provider instance by type.
 */
export function getSandboxProvider(type: SandboxProviderType): SandboxProvider {
  switch (type) {
    case 'docker':
      return new DockerSandboxProvider();
    case 'cloud':
      return new CloudSandboxProvider();
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
export function getProviderForSession(session: HermesSession): SandboxProvider {
  return getSandboxProvider(session.provider);
}

/**
 * List sessions across all providers.
 * Returns a single merged list, sorted by creation time descending.
 */
export async function listAllSessions(): Promise<HermesSession[]> {
  const providerTypes: SandboxProviderType[] = ['docker', 'cloud'];

  const providers = providerTypes.map((type) => ({
    type,
    provider: getSandboxProvider(type),
  }));

  const results = await Promise.allSettled(
    providers.map((p) => p.provider.list()),
  );
  const sessions: HermesSession[] = [];

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
