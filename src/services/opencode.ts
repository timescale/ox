import { join } from 'node:path';
import { file } from 'bun';
import type { AuthEntry, OpencodeAuthJson } from '../types/agentConfig';
import { Deferred } from '../types/deferred';
import { getXdgData, getXdgState } from '../utils/xdg.ts';
import { readCache, writeCache } from './cache';
import { getClaudeApiKey, getClaudeCredentialsJson } from './claude';
import { readConfigValue } from './config';
import { ensureDockerImageForAgent } from './docker';
import { CONTAINER_HOME, readFileFromContainer } from './dockerFiles';
import { getOxSecret, setOxSecret } from './keyring';
import { log } from './logger';
import {
  type RunInDockerOptionsBase,
  type RunInDockerResult,
  runInDocker,
  type VirtualFile,
} from './runInDocker';
import { getThemeNames } from './theme.ts';
import { colorEnvArgs } from '../utils/shell.ts';

const homePaths = {
  authJson: join(getXdgData(), 'opencode', 'auth.json'),
  kvJson: join(getXdgState(), 'opencode', 'kv.json'),
};

const containerPaths = {
  authJson: join(CONTAINER_HOME, '.local', 'share', 'opencode', 'auth.json'),
  kvJson: join(CONTAINER_HOME, '.local', 'state', 'opencode', 'kv.json'),
};

export const opencodeAuthEntryValid = (
  entry?: AuthEntry | null,
): entry is AuthEntry => {
  if (!entry) return false;
  if (entry.type === 'api') return !!entry.key;
  if (entry.type === 'oauth') {
    if (entry.refresh) return true; // if we have a refresh token, we can get a new access token
    if (entry.expires && entry.expires < Date.now()) return false;
    return !!entry.access;
  }
  return false;
};

export const opencodeCredsValid = (
  creds?: OpencodeAuthJson | null,
): boolean => {
  if (!creds) return false;
  return Object.values(creds).some(opencodeAuthEntryValid);
};

export const opencodeAuthEntryExpiresAt = (
  entry?: AuthEntry | null,
): number => {
  if (!opencodeAuthEntryValid(entry)) return 0;
  if (entry.type === 'oauth' && entry.expires) {
    return entry.expires;
  }
  return Infinity;
};

/**
 * Read opencode credentials from the host system's config directory.
 * This is a read-only source — opencode itself manages this file.
 */
export const readHostOpencodeCredentials =
  async (): Promise<OpencodeAuthJson | null> => {
    try {
      const hostAuth = file(homePaths.authJson);
      if (!(await hostAuth.exists())) {
        log.debug('Opencode auth.json not found in host config directory');
        return null;
      }
      const creds = (await hostAuth.json()) as OpencodeAuthJson;
      if (opencodeCredsValid(creds)) {
        log.trace('Found valid opencode credentials in host config directory');
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

export const readOxOpencodeCredentialCache =
  async (): Promise<OpencodeAuthJson | null> => {
    try {
      const raw = await getOxSecret(OX_OPENCODE_ACCOUNT);
      const creds = JSON.parse(raw || '{}') as OpencodeAuthJson;
      if (opencodeCredsValid(creds)) {
        log.trace('Found valid opencode credentials in ox keyring');
        return creds;
      }
      log.debug('Opencode credentials present in ox keyring, but invalid.');
    } catch {
      log.debug('No opencode/auth.json found in ox keyring');
    }
    return null;
  };

/**
 * Write OpenCode credentials to the ox keyring cache and in-memory cache.
 */
export const writeOxOpencodeCredentials = async (
  creds: OpencodeAuthJson,
): Promise<void> => {
  await setOxSecret(OX_OPENCODE_ACCOUNT, JSON.stringify(creds));
  writeCache('opencodeAuthJson', creds);
};

/**
 * Write OpenCode credentials back to the host config file.
 * Best-effort — logs errors but does not throw.
 */
export const writeHostOpencodeCredentials = async (
  creds: OpencodeAuthJson,
): Promise<void> => {
  try {
    await Bun.write(homePaths.authJson, JSON.stringify(creds, null, 2));
    log.debug('Wrote opencode credentials to host file');
  } catch (err) {
    log.warn({ err }, 'Failed to write opencode credentials to host file');
  }
};

/**
 * Merge host credentials into the cached credentials.
 * Copies keys from host that are missing or expired locally.
 * Returns the merged result (or the best available).
 */
const mergeCredentials = async (): Promise<OpencodeAuthJson> => {
  const host = (await readHostOpencodeCredentials()) || {};
  const cached = (await readOxOpencodeCredentialCache()) || {};
  const merged: OpencodeAuthJson = {};

  const keys = new Set([...Object.keys(cached), ...Object.keys(host)]);
  for (const key of keys) {
    if (
      opencodeAuthEntryValid(cached[key]) &&
      (!opencodeAuthEntryValid(host[key]) ||
        opencodeAuthEntryExpiresAt(cached[key]) >
          opencodeAuthEntryExpiresAt(host[key]))
    ) {
      log.debug(`opencode cached "${key}" creds newer than host`);
      merged[key] = cached[key];
    } else {
      merged[key] = host[key];
    }
  }
  if (!opencodeAuthEntryValid(merged.anthropic)) {
    const credsJson = await getClaudeCredentialsJson();
    if (credsJson?.claudeAiOauth?.accessToken) {
      merged.anthropic = {
        type: 'oauth',
        refresh: credsJson.claudeAiOauth.refreshToken,
        access: credsJson.claudeAiOauth.accessToken,
        expires: credsJson.claudeAiOauth.expiresAt,
      };
    } else {
      const apiKey = await getClaudeApiKey();
      if (apiKey) {
        merged.anthropic = {
          type: 'api',
          key: apiKey,
        };
      }
    }
  }
  return merged;
};

/**
 * Returns true if opencode has valid file-based credentials (host config or
 * ox keyring), independent of any env vars like ANTHROPIC_API_KEY.
 */
export const hasValidOpencodeFileCredentials = async (): Promise<boolean> => {
  const host = await readHostOpencodeCredentials();
  if (opencodeCredsValid(host)) return true;
  const cached = await readOxOpencodeCredentialCache();
  return !!(cached && opencodeCredsValid(cached));
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
    if (opencodeCredsValid(creds)) {
      log.debug('Valid opencode credentials found in container');
      await writeOxOpencodeCredentials(creds);
      return true;
    }
    log.debug('Invalid opencode credentials found in container');
  } catch {
    log.debug('No opencode/auth.json found in container');
  }
  return false;
};

/**
 * Get the opencode config as VirtualFile(s) to write into containers.
 * Includes auth credentials and the KV state (theme, UI preferences).
 */
export const getOpencodeConfigFiles = async (): Promise<VirtualFile[]> => {
  const creds = await getOpencodeAuthJson();
  const files: VirtualFile[] = [
    {
      path: containerPaths.authJson,
      value: JSON.stringify(creds),
    },
  ];

  // Include opencode KV state (theme, UI preferences) if present on host
  try {
    const kvFile = file(homePaths.kvJson);
    if (await kvFile.exists()) {
      files.push({
        path: containerPaths.kvJson,
        value: await kvFile.text(),
      });
    }
  } catch {
    log.debug('Failed to read opencode kv.json for sandbox injection');
  }

  return files;
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

  // Ensure the opencode agent overlay image is available when no explicit image is provided
  const resolvedImage =
    dockerImage ?? (await ensureDockerImageForAgent('opencode'));

  const effectiveDockerArgs = [...dockerArgs, ...colorEnvArgs];

  const result = await runInDocker({
    dockerArgs: effectiveDockerArgs,
    cmdArgs,
    cmdName: 'opencode',
    dockerImage: resolvedImage,
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
  const listProc = await runOpencodeInDocker({
    cmdArgs: ['auth', 'list'],
    shouldThrow: false,
  });
  const exitCode = await listProc.exited;
  const output = listProc.text().trim();
  const match = output.match(/(\d+)\s+credentials/);
  const numCreds = match?.[1] ? parseInt(match[1], 10) : 0;
  log.trace({ exitCode, output, numCreds }, 'opencode auth list');
  if (exitCode || !numCreds) {
    log.debug('opencode auth list failed or no credentials found');
    return false;
  }
  const effectiveModel =
    model ?? (await readConfigValue('agentModels'))?.opencode;
  const testProc = await runOpencodeInDocker({
    cmdArgs: [
      'run',
      ...(effectiveModel ? ['--model', effectiveModel] : []),
      'just output `true`, and nothing else',
    ],
    shouldThrow: false,
  });
  const testExitCode = await testProc.exited;
  const errText = testProc.errorText().trim();
  const valid = testExitCode === 0 && !errText.includes('Error');
  if (valid) {
    log.debug('checkOpencodeCredentials (valid)');
    await testProc.credsCaptured;
    return true;
  }
  log.debug(
    {
      exitCode: testExitCode,
      output: testProc.text().trim(),
      errText,
      model: effectiveModel,
    },
    'checkOpencodeCredentials (invalid)',
  );
  return false;
};

/**
 * Read the theme preference from OpenCode's host state directory.
 * OpenCode stores its KV state at `$XDG_STATE_HOME/opencode/kv.json`.
 * Returns the theme name if it exists and is a valid ox theme, otherwise null.
 */
export async function readOpencodeTheme(): Promise<string | null> {
  try {
    const kvFile = file(join(getXdgState(), 'opencode', 'kv.json'));
    if (!(await kvFile.exists())) return null;
    const kv = (await kvFile.json()) as Record<string, unknown>;
    const theme = kv.theme;
    if (typeof theme !== 'string' || !theme) return null;
    if (!getThemeNames().includes(theme)) {
      log.debug({ theme }, 'OpenCode theme not recognized by ox, ignoring');
      return null;
    }
    log.debug({ theme }, 'Using theme from OpenCode host config');
    return theme;
  } catch {
    log.debug('Failed to read OpenCode theme from kv.json');
    return null;
  }
}

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
