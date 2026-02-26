import { homedir } from 'node:os';
import { join } from 'node:path';
import { file } from 'bun';
import type { AuthEntry, OpencodeAuthJson } from '../types/agentConfig';
import { Deferred } from '../types/deferred';
import { readCache, writeCache } from './cache';
import { getClaudeApiKey, getClaudeCredentialsJson } from './claude';
import { readConfig } from './config';
import { CONTAINER_HOME, readFileFromContainer } from './dockerFiles';
import { getOxSecret, setOxSecret } from './keyring';
import { log } from './logger';
import {
  type RunInDockerOptionsBase,
  type RunInDockerResult,
  runInDocker,
  type VirtualFile,
} from './runInDocker';

const homePaths = {
  authJson: join(homedir(), '.local', 'share', 'opencode', 'auth.json'),
};

const containerPaths = {
  authJson: join(CONTAINER_HOME, '.local', 'share', 'opencode', 'auth.json'),
};

const authEntryValid = (entry?: AuthEntry | null): boolean => {
  if (!entry) return false;
  if (entry.type === 'api') return !!entry.key;
  if (entry.type === 'oauth') {
    if (entry.refresh) return true; // if we have a refresh token, we can get a new access token
    if (entry.expires && entry.expires < Date.now()) return false;
    return !!entry.access;
  }
  return false;
};

const authCredsValid = (creds?: OpencodeAuthJson | null): boolean => {
  if (!creds) return false;
  return Object.values(creds).some(authEntryValid);
};

/**
 * Read opencode credentials from the host system's config directory.
 * This is a read-only source — opencode itself manages this file.
 */
const readHostCredentials = async (): Promise<OpencodeAuthJson | null> => {
  try {
    const hostAuth = file(homePaths.authJson);
    if (!(await hostAuth.exists())) {
      log.debug('Opencode auth.json not found in host config directory');
      return null;
    }
    const creds = (await hostAuth.json()) as OpencodeAuthJson;
    if (authCredsValid(creds)) {
      log.debug('Found valid opencode credentials in host config directory');
      return creds;
    }
    log.debug(
      'Opencode auth.json present in host config directory, but invalid.',
    );
  } catch (err) {
    log.debug({ err }, 'Failed to read opencode auth.json from host.');
  }
  return null;
};

const OX_OPENCODE_ACCOUNT = 'opencode/auth.json';

const readOxCredentialCache = async (): Promise<OpencodeAuthJson | null> => {
  try {
    const raw = await getOxSecret(OX_OPENCODE_ACCOUNT);
    const creds = JSON.parse(raw || '{}') as OpencodeAuthJson;
    if (authCredsValid(creds)) {
      log.debug('Found valid opencode credentials in ox keyring');
      return creds;
    }
    log.debug('Opencode credentials present in ox keyring, but invalid.');
  } catch {
    log.debug('No opencode/auth.json found in ox keyring');
  }
  return null;
};

const writeOxCredentialCache = async (
  creds: OpencodeAuthJson,
): Promise<void> => {
  await setOxSecret(OX_OPENCODE_ACCOUNT, JSON.stringify(creds));
};

/**
 * Merge host credentials into the cached credentials.
 * Copies keys from host that are missing or expired locally.
 * Returns the merged result (or the best available).
 */
const mergeCredentials = async (): Promise<OpencodeAuthJson> => {
  const host = (await readHostCredentials()) || {};
  const cached = (await readOxCredentialCache()) || {};

  const keys = new Set([...Object.keys(cached), ...Object.keys(host)]);
  let changed = false;
  for (const key of keys) {
    if (authEntryValid(host[key]) && !authEntryValid(cached[key])) {
      log.debug(
        `Adding missing or outdated key "${key}" to opencode credential cache from host`,
      );
      cached[key] = host[key];
      changed = true;
    }
  }
  if (!authEntryValid(cached.anthropic)) {
    const credsJson = await getClaudeCredentialsJson();
    if (credsJson?.claudeAiOauth?.accessToken) {
      cached.anthropic = {
        type: 'oauth',
        refresh: credsJson.claudeAiOauth.refreshToken,
        access: credsJson.claudeAiOauth.accessToken,
        expires: credsJson.claudeAiOauth.expiresAt,
      };
      changed = true;
    } else {
      const apiKey = await getClaudeApiKey();
      if (apiKey) {
        cached.anthropic = {
          type: 'api',
          key: apiKey,
        };
        changed = true;
      }
    }
  }
  if (changed) {
    await writeOxCredentialCache(cached);
  }
  return cached;
};

export const getOpencodeAuthJson = async (
  force = false,
): Promise<OpencodeAuthJson> => {
  if (!force) {
    const cached = readCache('opencodeAuthJson');
    if (cached) {
      return cached.value;
    }
  }
  const merged = await mergeCredentials();
  writeCache('opencodeAuthJson', merged);
  return merged;
};

const captureOpencodeCredentialsFromContainer = async (
  containerId: string,
): Promise<boolean> => {
  try {
    const content = await readFileFromContainer(
      containerId,
      containerPaths.authJson,
    );
    const creds = JSON.parse(content) as OpencodeAuthJson;
    if (authCredsValid(creds)) {
      log.debug('Valid opencode credentials found in container');
      await writeOxCredentialCache(creds);
      writeCache('opencodeAuthJson', creds);
      return true;
    }
    log.debug('Invalid opencode credentials found in container');
  } catch {
    log.debug('No opencode/auth.json found in container');
  }
  return false;
};

/**
 * Get the opencode auth config as VirtualFile(s) to write into containers.
 */
export const getOpencodeConfigFiles = async (): Promise<VirtualFile[]> => {
  const creds = await getOpencodeAuthJson();
  return [
    {
      path: containerPaths.authJson,
      value: JSON.stringify(creds),
    },
  ];
};

export const runOpencodeInDocker = async ({
  dockerArgs = [],
  cmdArgs = [],
  dockerImage,
  interactive = false,
  shouldThrow = true,
  files = [],
  labels,
}: RunInDockerOptionsBase): Promise<
  RunInDockerResult & { credsCaptured: Promise<boolean> }
> => {
  const configFiles = await getOpencodeConfigFiles();

  const effectiveDockerArgs = [
    ...dockerArgs,
    ...(process.env.COLORTERM
      ? ['-e', `COLORTERM=${process.env.COLORTERM}`]
      : []),
  ];

  const result = await runInDocker({
    dockerArgs: effectiveDockerArgs,
    cmdArgs,
    cmdName: 'opencode',
    dockerImage,
    interactive,
    shouldThrow,
    files: [...configFiles, ...files],
    labels,
  });

  const deferredCredsCaptured = new Deferred<boolean>();
  const { containerId } = result;
  if (containerId) {
    result.exited
      .then(async (code) => {
        if (code) {
          log.debug(
            `Opencode exited with code ${code}, not saving credentials`,
          );
          deferredCredsCaptured.resolve(false);
          return;
        }
        deferredCredsCaptured.wrap(
          captureOpencodeCredentialsFromContainer(containerId),
        );
      })
      .catch((err) => {
        log.error({ err }, 'Failed to read credentials file from container');
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

export const checkOpencodeCredentials = async (
  model?: string,
): Promise<boolean> => {
  const proc = await runOpencodeInDocker({
    cmdArgs: ['auth', 'list'],
    shouldThrow: false,
  });
  const exitCode = await proc.exited;
  const output = proc.text().trim();
  const match = output.match(/(\d+)\s+credentials/);
  const numCreds = match?.[1] ? parseInt(match[1], 10) : 0;
  log.debug(
    { exitCode, output, numCreds },
    'checkOpencodeCredentials auth list',
  );
  if (exitCode || !numCreds) {
    return false;
  }
  const effectiveModel = model ?? (await readConfig())?.model;
  const proc2 = await runOpencodeInDocker({
    cmdArgs: [
      'run',
      ...(effectiveModel ? ['--model', effectiveModel] : []),
      'just output `true`, and nothing else',
    ],
    shouldThrow: false,
  });
  const exitCode2 = await proc2.exited;
  const output2 = proc2.text().trim();
  const errText = proc2.errorText().trim();
  log.debug(
    { exitCode: exitCode2, output: output2, errText, model: effectiveModel },
    'checkOpencodeCredentials test run',
  );
  return exitCode2 === 0 && !errText.includes('Error');
};

/**
 * Ensure Opencode credentials are valid, running interactive login if needed.
 * Returns true if credentials are valid after the check/login, false if login failed or was cancelled.
 */
export const ensureOpencodeAuth = async (model?: string): Promise<boolean> => {
  const isValid = await checkOpencodeCredentials(model);
  if (isValid) {
    return true;
  }

  console.log('\nOpencode credentials are missing or expired.');
  console.log('Starting Opencode login...\n');

  const proc = await runOpencodeInDocker({
    cmdArgs: ['auth', 'login'],
    interactive: true,
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error('\nError: Opencode login failed');
    return false;
  }
  await proc.credsCaptured;

  // Verify credentials after login
  return await checkOpencodeCredentials(model);
};
