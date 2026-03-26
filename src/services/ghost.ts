import { homedir } from 'node:os';
import { join } from 'node:path';
import { Deferred } from '../types/deferred';
import { AbortError } from '../utils/abort.ts';
import { getExistingEnvFilePaths, toEnvFileArgs } from '../utils/envFiles.ts';
import {
  ensureDbProviderLayer,
  ensureDockerImage,
  resolveSandboxImage,
} from './docker';
import { CONTAINER_HOME, readFileFromContainer } from './dockerFiles';
import { getOxSecret, getSecret, setOxSecret } from './keyring';
import { log } from './logger';
import {
  type RunInDockerOptionsBase,
  type RunInDockerResult,
  runInDocker,
  type VirtualFile,
} from './runInDocker';

const containerPaths = {
  credentials: join(CONTAINER_HOME, '.config', 'ghost', 'credentials'),
};

export interface GhostDatabase {
  id: string;
  name: string;
  status: string;
  region?: string;
  created?: string;
  paused?: boolean;
}

// ============================================================================
// Credential Management
// ============================================================================

const OX_GHOST_ACCOUNT = 'ghost/credentials';

/** In-memory cache for Ghost credentials. */
const GHOST_CREDS_CACHE_TTL_MS = 3_600_000; // 1 hour
let ghostCredsCache: { creds: string | null; ts: number } | null = null;

/** Invalidate the in-memory Ghost credentials cache.
 *  Call after interactive auth flows (e.g. `ox ghost login`). */
export function invalidateGhostCredsCache(): void {
  ghostCredsCache = null;
}

/** Write Ghost credentials to the Ox keyring cache. */
export const writeGhostCredentialCache = async (
  creds: string,
): Promise<void> => {
  await setOxSecret(OX_GHOST_ACCOUNT, creds);
};

/**
 * Capture Ghost credentials from an exited container and cache them in the keyring.
 */
export const captureGhostCredentialsFromContainer = async (
  containerId: string,
): Promise<boolean> => {
  try {
    const content = await readFileFromContainer(
      containerId,
      containerPaths.credentials,
    );
    if (content.trim()) {
      log.debug('Valid Ghost credentials found in container');
      await writeGhostCredentialCache(content);
      return true;
    }
    log.debug('Empty Ghost credentials found in container');
  } catch {
    log.debug('No Ghost credentials found in container');
  }
  return false;
};

/**
 * Read Ghost credentials from the Ox keyring cache.
 */
const readOxCredentialCache = async (): Promise<string | null> => {
  try {
    const raw = await getOxSecret(OX_GHOST_ACCOUNT);
    if (raw?.trim()) {
      log.debug('Found Ghost credentials in ox keyring');
      return raw;
    }
    log.debug('No ghost/credentials found in ox keyring');
  } catch {
    log.debug('No ghost/credentials found in ox keyring');
  }
  return null;
};

/**
 * Read Ghost credentials from Ghost's native OS keyring.
 * Ghost CLI stores credentials as `go-keyring-base64:<base64 encoded json>`.
 */
const readGhostNativeKeyring = async (): Promise<string | null> => {
  try {
    const raw = await getSecret('ghost-cli', 'credentials');
    if (!raw) {
      log.debug('No Ghost credentials found in native keyring');
      return null;
    }
    const prefix = 'go-keyring-base64:';
    if (raw.startsWith(prefix)) {
      const decoded = Buffer.from(raw.slice(prefix.length), 'base64').toString(
        'utf-8',
      );
      if (decoded.trim()) {
        log.debug('Found Ghost credentials in native OS keyring');
        return decoded;
      }
    }
    // If the value doesn't have the prefix, try using it directly
    if (raw.trim()) {
      log.debug('Found Ghost credentials in native OS keyring (raw format)');
      return raw;
    }
    log.debug('Ghost credentials in native keyring are empty');
  } catch {
    log.debug('Failed to read Ghost credentials from native keyring');
  }
  return null;
};

/**
 * Read Ghost credentials from the host filesystem fallback.
 * Ghost CLI stores credentials at ~/.config/ghost/credentials.
 */
const readHostFileCredentials = async (): Promise<string | null> => {
  try {
    const credPath = join(homedir(), '.config', 'ghost', 'credentials');
    const file = Bun.file(credPath);
    if (await file.exists()) {
      const content = await file.text();
      if (content.trim()) {
        log.debug('Found Ghost credentials in host filesystem');
        return content;
      }
    }
    log.debug('No Ghost credentials file found on host');
  } catch {
    log.debug('Failed to read Ghost credentials from host filesystem');
  }
  return null;
};

/**
 * Resolve Ghost credentials from all available sources (with caching).
 * Priority: 1. Ox keyring  2. Ghost native keyring  3. Host file
 */
const resolveCredentials = async (): Promise<string | null> => {
  if (
    ghostCredsCache &&
    Date.now() - ghostCredsCache.ts < GHOST_CREDS_CACHE_TTL_MS
  ) {
    log.trace('resolveGhostCredentials (cached)');
    return ghostCredsCache.creds;
  }

  // 1. Ox keyring
  const oxCreds = await readOxCredentialCache();
  if (oxCreds) {
    ghostCredsCache = { creds: oxCreds, ts: Date.now() };
    return oxCreds;
  }

  // 2. Ghost native OS keyring
  const nativeCreds = await readGhostNativeKeyring();
  if (nativeCreds) {
    ghostCredsCache = { creds: nativeCreds, ts: Date.now() };
    return nativeCreds;
  }

  // 3. Host filesystem fallback
  const fileCreds = await readHostFileCredentials();
  if (fileCreds) {
    ghostCredsCache = { creds: fileCreds, ts: Date.now() };
    return fileCreds;
  }

  ghostCredsCache = { creds: null, ts: Date.now() };
  return null;
};

/**
 * Resolve credentials and cache them in the keyring.
 * Use this only from explicit interactive flows where credentials may have changed.
 */
const resolveAndCacheCredentials = async (): Promise<string | null> => {
  invalidateGhostCredsCache();

  // 1. Ox keyring
  const oxCreds = await readOxCredentialCache();
  if (oxCreds) {
    ghostCredsCache = { creds: oxCreds, ts: Date.now() };
    return oxCreds;
  }

  // 2. Ghost native OS keyring — cache if found
  const nativeCreds = await readGhostNativeKeyring();
  if (nativeCreds) {
    await writeGhostCredentialCache(nativeCreds);
    ghostCredsCache = { creds: nativeCreds, ts: Date.now() };
    return nativeCreds;
  }

  // 3. Host filesystem fallback — cache if found
  const fileCreds = await readHostFileCredentials();
  if (fileCreds) {
    await writeGhostCredentialCache(fileCreds);
    ghostCredsCache = { creds: fileCreds, ts: Date.now() };
    return fileCreds;
  }

  ghostCredsCache = { creds: null, ts: Date.now() };
  return null;
};

/**
 * Get the Ghost config as VirtualFile(s) to write into containers.
 *
 * @param saveCredentials - When true, caches host credentials to the keyring.
 *   Defaults to false (read-only). Only pass true from interactive flows where
 *   credentials may have been modified.
 */
export const getGhostConfigFiles = async ({
  saveCredentials = false,
}: {
  saveCredentials?: boolean;
} = {}): Promise<VirtualFile[]> => {
  const creds = saveCredentials
    ? await resolveAndCacheCredentials()
    : await resolveCredentials();
  if (!creds) return [];
  return [
    {
      path: containerPaths.credentials,
      value: creds,
    },
  ];
};

// ============================================================================
// Docker Execution
// ============================================================================

interface RunGhostInDockerOptions extends RunInDockerOptionsBase {
  /**
   * When true, credentials are written to the OS keyring on resolution and
   * captured back from the container after it exits. Defaults to false.
   * Only enable for interactive flows where the user may have modified
   * credentials (e.g. `ox ghost login`).
   */
  saveCredentials?: boolean;
  removeContainerOnExit?: boolean;
}

export async function resolveGhostDockerImage(): Promise<string> {
  const sandbox = await resolveSandboxImage();
  const baseImage = sandbox.needsBuild
    ? await ensureDockerImage()
    : sandbox.image;
  return ensureDbProviderLayer(baseImage, 'ghost');
}

export const runGhostInDocker = async ({
  dockerArgs = [],
  cmdArgs = [],
  dockerImage,
  interactive = false,
  shouldThrow = true,
  files = [],
  mountCwd,
  saveCredentials = false,
  removeContainerOnExit = true,
  signal,
  quiet,
}: RunGhostInDockerOptions): Promise<
  RunInDockerResult & { credsCaptured: Promise<boolean> }
> => {
  const configFiles = await getGhostConfigFiles({ saveCredentials });
  const resolvedDockerImage = dockerImage ?? (await resolveGhostDockerImage());

  const envFilePaths = await getExistingEnvFilePaths({
    provider: 'docker',
    agent: undefined,
  });
  const envFileArgs = toEnvFileArgs(envFilePaths);
  log.trace({ envFilePaths }, 'ghost container env files');

  const result = await runInDocker({
    dockerArgs: [...envFileArgs, ...dockerArgs],
    cmdArgs,
    cmdName: 'ghost',
    dockerImage: resolvedDockerImage,
    interactive,
    shouldThrow,
    files: [...configFiles, ...files],
    mountCwd,
    signal,
    quiet,
  });

  const deferredCredsCaptured = new Deferred<boolean>();
  const { containerId } = result;
  if (containerId) {
    result.exited
      .then(async (code) => {
        if (code) {
          log.debug(`ghost exited with code ${code}, not saving credentials`);
          deferredCredsCaptured.resolve(false);
          return;
        }
        if (!saveCredentials) {
          deferredCredsCaptured.resolve(false);
          return;
        }
        deferredCredsCaptured.wrap(
          captureGhostCredentialsFromContainer(containerId),
        );
      })
      .catch((err) => {
        log.error(
          { err },
          'Failed to read Ghost credentials file from container',
        );
        deferredCredsCaptured.resolve(false);
      })
      .finally(async () => {
        // Skip explicit removal if aborted — the abort handler already
        // force-removed the container via `docker rm -f`.
        if (signal?.aborted || !removeContainerOnExit) return;
        await result.rm().catch((err) => {
          log.error({ err }, 'Failed to remove container');
        });
      });
  }

  return {
    ...result,
    credsCaptured: deferredCredsCaptured.promise,
  };
};

// ============================================================================
// Credential Checks
// ============================================================================

export const checkGhostCredentials = async (
  signal?: AbortSignal,
): Promise<boolean> => {
  const proc = await runGhostInDocker({
    cmdArgs: ['list', '--json'],
    shouldThrow: false,
    quiet: true,
    signal,
  });
  const exitCode = await proc.exited;
  if (signal?.aborted) {
    throw new AbortError();
  }
  const output = proc.text().trim();
  log.trace({ exitCode, output }, 'checkGhostCredentials');
  log.debug(`checkGhostCredentials (${exitCode === 0 ? 'valid' : 'invalid'})`);
  return exitCode === 0;
};

export const listGhostDatabases = async (
  signal?: AbortSignal,
): Promise<GhostDatabase[]> => {
  const proc = await runGhostInDocker({
    cmdArgs: ['list', '--json'],
    shouldThrow: false,
    quiet: true,
    signal,
  });
  const exitCode = await proc.exited;
  if (signal?.aborted) {
    throw new AbortError();
  }
  if (exitCode !== 0) {
    const output = proc.errorText().trim();
    log.debug({ exitCode, output }, 'listGhostDatabases failed');
    return [];
  }
  try {
    const data = proc.json();
    if (Array.isArray(data)) {
      return data as GhostDatabase[];
    }
    log.debug({ data }, 'listGhostDatabases: unexpected response shape');
    return [];
  } catch (err) {
    log.debug({ err }, 'listGhostDatabases: failed to parse JSON');
    return [];
  }
};
