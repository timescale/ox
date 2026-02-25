import { join } from 'node:path';
import { YAML } from 'bun';
import { Deferred } from '../types/deferred';
import { CONTAINER_HOME, readFileFromContainer } from './dockerFiles';
import { readCredentialsUnchecked } from './githubApp';
import { getHermesSecret, setHermesSecret } from './keyring';
import { log } from './logger';
import {
  type RunInDockerOptionsBase,
  type RunInDockerResult,
  runInDocker,
  type VirtualFile,
} from './runInDocker';

const containerPaths = {
  hostsYml: join(CONTAINER_HOME, '.config', 'gh', 'hosts.yml'),
};

export interface GhHostsYml {
  [host: string]:
    | {
        oauth_token?: string;
        user?: string;
        git_protocol?: string;
      }
    | undefined;
}

const ghCredsValid = (creds?: GhHostsYml | null): boolean => {
  if (!creds) return false;
  const hosts = Object.keys(creds);
  if (hosts.length === 0) return false;
  // At least one host with an oauth_token
  return hosts.some((host) => !!creds[host]?.oauth_token);
};

/**
 * Read gh credentials from the host system's gh CLI.
 * Uses `gh auth token` and `gh api user` to get the token and username.
 */
const readHostCredentials = async (): Promise<GhHostsYml | null> => {
  try {
    const tokenResult = await Bun.$`gh auth token -h github.com`.quiet();
    const token = tokenResult.stdout.toString().trim() || null;
    if (!token) {
      log.debug('No gh auth token found on host');
      return null;
    }
    const userResult =
      await Bun.$`gh api user --jq '.login' 2>/dev/null`.quiet();
    const user = userResult.stdout.toString().trim() || null;
    if (!user) {
      log.debug('gh auth token found but could not determine user');
      return null;
    }
    log.debug('Found valid gh credentials on host');
    return {
      'github.com': {
        oauth_token: token,
        user,
        git_protocol: 'https',
      },
    };
  } catch {
    log.debug('No host gh credentials found');
    return null;
  }
};

const HERMES_GH_ACCOUNT = 'gh/hosts.yml';

const readHermesCredentialCache = async (): Promise<GhHostsYml | null> => {
  try {
    const raw = await getHermesSecret(HERMES_GH_ACCOUNT);
    if (!raw) {
      log.debug('No gh/hosts.yml found in hermes keyring');
      return null;
    }
    const creds = YAML.parse(raw) as GhHostsYml;
    if (ghCredsValid(creds)) {
      log.debug('Found valid gh credentials in hermes keyring');
      return creds;
    }
    log.debug('gh credentials present in hermes keyring, but invalid.');
  } catch {
    log.debug('No gh/hosts.yml found in hermes keyring');
  }
  return null;
};

export const writeGhCredentialCache = async (
  creds: GhHostsYml,
): Promise<void> => {
  await setHermesSecret(HERMES_GH_ACCOUNT, YAML.stringify(creds));
};

/**
 * Capture gh credentials from an exited container and cache them in the keyring.
 */
export const captureGhCredentialsFromContainer = async (
  containerId: string,
): Promise<boolean> => {
  try {
    const content = await readFileFromContainer(
      containerId,
      containerPaths.hostsYml,
    );
    const creds = YAML.parse(content) as GhHostsYml;
    if (ghCredsValid(creds)) {
      log.debug('Valid gh credentials found in container');
      await writeGhCredentialCache(creds);
      return true;
    }
    log.debug('Invalid gh credentials found in container');
  } catch {
    log.debug('No gh/hosts.yml found in container');
  }
  return false;
};

/**
 * Get the best available gh credentials.
 * Priority: GitHub App token > host gh auth > keyring cache.
 * This is a read-only operation — it never writes to the keyring.
 */
const resolveCredentials = async (): Promise<GhHostsYml> => {
  // Priority 1: GitHub App user access token
  const appCreds = await readCredentialsUnchecked();
  if (appCreds) {
    log.debug('Using GitHub App credentials for gh');
    return {
      'github.com': {
        oauth_token: appCreds.token,
        user: appCreds.username,
        git_protocol: 'https',
      },
    };
  }

  // Priority 2: Host gh auth token
  const hostCreds = await readHostCredentials();
  if (hostCreds && ghCredsValid(hostCreds)) {
    return hostCreds;
  }

  // Priority 3: Hermes keyring cache (from previous `gh auth login` in Docker)
  const cachedCreds = await readHermesCredentialCache();
  if (cachedCreds && ghCredsValid(cachedCreds)) {
    return cachedCreds;
  }

  return {};
};

/**
 * Resolve credentials and cache them in the keyring.
 * Use this only from explicit interactive flows where credentials may have changed.
 */
const resolveAndCacheCredentials = async (): Promise<GhHostsYml> => {
  // Priority 1: GitHub App user access token (already stored in its own keyring entry)
  const appCreds = await readCredentialsUnchecked();
  if (appCreds) {
    log.debug('Using GitHub App credentials for gh (saveCredentials path)');
    return {
      'github.com': {
        oauth_token: appCreds.token,
        user: appCreds.username,
        git_protocol: 'https',
      },
    };
  }

  // Priority 2: Host gh auth token
  const hostCreds = await readHostCredentials();
  if (hostCreds && ghCredsValid(hostCreds)) {
    // Cache host creds in keyring for when host gh isn't available
    await writeGhCredentialCache(hostCreds);
    return hostCreds;
  }

  // Priority 3: Hermes keyring cache
  const cachedCreds = await readHermesCredentialCache();
  if (cachedCreds && ghCredsValid(cachedCreds)) {
    return cachedCreds;
  }

  return {};
};

/**
 * Get the gh config as VirtualFile(s) to write into containers.
 *
 * @param saveCredentials - When true, caches host credentials to the keyring.
 *   Defaults to false (read-only). Only pass true from interactive flows where
 *   credentials may have been modified.
 */
export const getGhConfigFiles = async ({
  saveCredentials = false,
}: {
  saveCredentials?: boolean;
} = {}): Promise<VirtualFile[]> => {
  const creds = saveCredentials
    ? await resolveAndCacheCredentials()
    : await resolveCredentials();
  return [
    {
      path: containerPaths.hostsYml,
      value: YAML.stringify(creds),
    },
  ];
};

interface RunGhInDockerOptions extends RunInDockerOptionsBase {
  /**
   * When true, credentials are written to the OS keyring on resolution and
   * captured back from the container after it exits. Defaults to false.
   * Only enable for interactive flows where the user may have modified
   * credentials (e.g. `hermes gh auth login`).
   */
  saveCredentials?: boolean;
}

export const runGhInDocker = async ({
  dockerArgs = [],
  cmdArgs = [],
  dockerImage,
  interactive = false,
  shouldThrow = true,
  files = [],
  mountCwd,
  saveCredentials = false,
}: RunGhInDockerOptions): Promise<
  RunInDockerResult & { credsCaptured: Promise<boolean> }
> => {
  const configFiles = await getGhConfigFiles({ saveCredentials });

  const result = await runInDocker({
    dockerArgs,
    cmdArgs,
    cmdName: 'gh',
    dockerImage,
    interactive,
    shouldThrow,
    files: [...configFiles, ...files],
    mountCwd,
  });

  const deferredCredsCaptured = new Deferred<boolean>();
  const { containerId } = result;
  if (containerId) {
    result.exited
      .then(async (code) => {
        if (code) {
          log.debug(`gh exited with code ${code}, not saving credentials`);
          deferredCredsCaptured.resolve(false);
          return;
        }
        if (!saveCredentials) {
          deferredCredsCaptured.resolve(false);
          return;
        }
        deferredCredsCaptured.wrap(
          captureGhCredentialsFromContainer(containerId),
        );
      })
      .catch((err) => {
        log.error({ err }, 'Failed to read gh credentials file from container');
        deferredCredsCaptured.resolve(false);
      })
      .finally(async () => {
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

export const checkGhCredentials = async (): Promise<boolean> => {
  const proc = await runGhInDocker({
    cmdArgs: ['auth', 'status'],
    shouldThrow: false,
  });
  const exitCode = await proc.exited;
  const output = proc.text().trim();
  log.debug({ exitCode, output }, 'checkGhCredentials');
  return exitCode === 0;
};

/**
 * Try to apply host gh credentials to the hermes keyring cache.
 * Returns true if valid credentials were found and cached.
 */
export async function applyHostGhCreds(): Promise<boolean> {
  const hostCreds = await readHostCredentials();
  if (!hostCreds || !ghCredsValid(hostCreds)) {
    log.debug('No valid host credentials found for gh');
    return false;
  }
  await writeGhCredentialCache(hostCreds);
  if (await checkGhCredentials()) {
    log.debug('Successfully imported host credentials for gh');
    return true;
  }
  log.debug('Failed to validate imported host credentials for gh');
  return false;
}
