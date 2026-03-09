// ============================================================================
// Codex Service - Manage OpenAI Codex CLI credentials and Docker execution
// ============================================================================

import { homedir } from 'node:os';
import { join } from 'node:path';
import { file } from 'bun';
import type { CodexAuthJson } from '../types/agentConfig';
import { Deferred } from '../types/deferred';
import { readCache, writeCache } from './cache';
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

const homePaths = {
  authJson: join(homedir(), '.codex', 'auth.json'),
};

const containerPaths = {
  authJson: join(CONTAINER_HOME, '.codex', 'auth.json'),
  configToml: join(CONTAINER_HOME, '.codex', 'config.toml'),
};

const codexCredsValid = (creds?: CodexAuthJson | null): boolean => {
  if (!creds) return false;
  // API key auth
  if (creds.auth_mode === 'apikey' && creds.OPENAI_API_KEY) return true;
  // OAuth/device-auth with nested tokens (current codex format)
  if (creds.tokens?.access_token) {
    if (creds.tokens.refresh_token) return true; // can refresh
    return true;
  }
  // Legacy flat OAuth fields (older codex versions)
  if (creds.access_token) {
    if (creds.refresh_token) return true; // can refresh
    if (creds.expires_at && creds.expires_at < Date.now()) return false;
    return true;
  }
  // Fallback: any OPENAI_API_KEY present
  if (creds.OPENAI_API_KEY) return true;
  return false;
};

/**
 * Read codex credentials from the host system's config directory.
 * This is a read-only source — codex itself manages this file.
 */
const readHostCredentials = async (): Promise<CodexAuthJson | null> => {
  try {
    const hostAuth = file(homePaths.authJson);
    if (!(await hostAuth.exists())) {
      log.debug('Codex auth.json not found in host config directory');
      return null;
    }
    const creds = (await hostAuth.json()) as CodexAuthJson;
    if (codexCredsValid(creds)) {
      log.debug('Found valid codex credentials in host config directory');
      return creds;
    }
    log.debug('Codex auth.json present in host config directory, but invalid.');
  } catch (err) {
    log.debug({ err }, 'Failed to read codex auth.json from host.');
  }
  return null;
};

const OX_CODEX_ACCOUNT = 'codex/auth.json';

const readOxCredentialCache = async (): Promise<CodexAuthJson | null> => {
  try {
    const raw = await getOxSecret(OX_CODEX_ACCOUNT);
    const creds = JSON.parse(raw || '{}') as CodexAuthJson;
    if (codexCredsValid(creds)) {
      log.debug('Found valid codex credentials in ox keyring');
      return creds;
    }
    log.debug('Codex credentials present in ox keyring, but invalid.');
  } catch {
    log.debug('No codex/auth.json found in ox keyring');
  }
  return null;
};

const writeOxCredentialCache = async (creds: CodexAuthJson): Promise<void> => {
  await setOxSecret(OX_CODEX_ACCOUNT, JSON.stringify(creds));
};

/**
 * Returns true if codex has valid file-based credentials (host config or
 * ox keyring), independent of the OPENAI_API_KEY / CODEX_API_KEY env vars.
 * Used to decide whether to suppress env var passthrough into containers —
 * the env vars' presence alongside OAuth tokens triggers conflicting auth
 * behaviour in the codex CLI.
 */
export const hasValidCodexFileCredentials = async (): Promise<boolean> => {
  const host = await readHostCredentials();
  if (codexCredsValid(host)) return true;
  const cached = await readOxCredentialCache();
  return !!(cached && codexCredsValid(cached));
};

/**
 * Merge host credentials into the cached credentials.
 * If neither source has valid creds, check for OPENAI_API_KEY env var.
 */
const mergeCredentials = async (): Promise<CodexAuthJson> => {
  const host = await readHostCredentials();
  const cached = await readOxCredentialCache();

  // Prefer host if valid, otherwise cached
  if (host && codexCredsValid(host)) {
    return host;
  }
  if (cached && codexCredsValid(cached)) {
    return cached;
  }

  // Fallback: create API key entry from OPENAI_API_KEY env var
  const envKey = process.env.OPENAI_API_KEY;
  if (envKey) {
    log.debug('Using OPENAI_API_KEY env var for codex credentials');
    return {
      auth_mode: 'apikey',
      OPENAI_API_KEY: envKey,
    };
  }

  return {};
};

export const getCodexAuthJson = async (
  force = false,
): Promise<CodexAuthJson> => {
  if (!force) {
    const cached = readCache('codexAuthJson');
    if (cached) {
      return cached.value ?? {};
    }
  }
  const merged = await mergeCredentials();
  writeCache('codexAuthJson', merged);
  return merged;
};

const captureCodexCredentialsFromContainer = async (
  containerId: string,
): Promise<boolean> => {
  try {
    const content = await readFileFromContainer(
      containerId,
      containerPaths.authJson,
    );
    const creds = JSON.parse(content) as CodexAuthJson;
    if (codexCredsValid(creds)) {
      log.debug('Valid codex credentials found in container');
      await writeOxCredentialCache(creds);
      writeCache('codexAuthJson', creds);
      return true;
    }
    log.debug('Invalid codex credentials found in container');
  } catch {
    log.debug('No codex/auth.json found in container');
  }
  return false;
};

/**
 * Codex config.toml that pre-trusts the /work/app directory so that
 * interactive sessions are not blocked by the "Do you trust this directory?"
 * prompt.
 */
const CODEX_CONFIG_TOML = `[projects."/work/app"]
trust_level = "trusted"
`;

/**
 * Get the codex auth config as VirtualFile(s) to write into containers.
 */
export const getCodexConfigFiles = async (): Promise<VirtualFile[]> => {
  const creds = await getCodexAuthJson();
  return [
    {
      path: containerPaths.authJson,
      value: JSON.stringify(creds),
    },
    {
      path: containerPaths.configToml,
      value: CODEX_CONFIG_TOML,
    },
  ];
};

export const runCodexInDocker = async ({
  dockerArgs = [],
  cmdArgs = [],
  dockerImage,
  interactive = false,
  shouldThrow = true,
  files = [],
  labels,
  mountCwd,
}: RunInDockerOptionsBase): Promise<
  RunInDockerResult & { credsCaptured: Promise<boolean> }
> => {
  const configFiles = await getCodexConfigFiles();

  // Ensure the codex agent overlay image is available when no explicit image is provided
  const resolvedImage =
    dockerImage ?? (await ensureDockerImageForAgent('codex'));

  const effectiveDockerArgs = [
    ...dockerArgs,
    ...(process.env.TERM ? ['-e', `TERM=${process.env.TERM}`] : []),
    ...(process.env.COLORTERM
      ? ['-e', `COLORTERM=${process.env.COLORTERM}`]
      : []),
  ];

  const result = await runInDocker({
    dockerArgs: effectiveDockerArgs,
    cmdArgs,
    cmdName: 'codex',
    dockerImage: resolvedImage,
    interactive,
    shouldThrow,
    files: [...configFiles, ...files],
    labels,
    mountCwd,
  });

  const deferredCredsCaptured = new Deferred<boolean>();
  const { containerId } = result;
  if (containerId) {
    result.exited
      .then(async (code) => {
        if (code) {
          log.debug(`Codex exited with code ${code}, not saving credentials`);
          deferredCredsCaptured.resolve(false);
          return;
        }
        deferredCredsCaptured.wrap(
          captureCodexCredentialsFromContainer(containerId),
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

export const checkCodexCredentials = async (): Promise<boolean> => {
  const proc = await runCodexInDocker({
    cmdArgs: ['login', 'status'],
    shouldThrow: false,
  });
  const exitCode = await proc.exited;
  const output = proc.text().trim();
  log.debug({ exitCode, output }, 'checkCodexCredentials login status');

  // Wait for any refreshed credentials to be captured back from the
  // container and written into the in-memory cache.  Without this, a
  // subsequent getCodexAuthJson() call (e.g. from startContainer →
  // getCredentialFiles) could return the stale pre-refresh tokens, causing
  // "refresh_token_reused" errors in async sessions.
  await proc.credsCaptured;

  // `codex login status` prints "Logged in using ..." when valid,
  // "Not logged in" when invalid
  return exitCode === 0 && !output.includes('Not logged in');
};

/**
 * Ensure Codex credentials are valid, running interactive login if needed.
 * Returns true if credentials are valid after the check/login, false if login failed or was cancelled.
 */
export const ensureCodexAuth = async (_model?: string): Promise<boolean> => {
  const isValid = await checkCodexCredentials();
  if (isValid) {
    return true;
  }

  console.log('\nCodex credentials are missing or expired.');
  console.log('Starting Codex login...\n');

  // Use device-auth flow (works in headless/Docker environments)
  const proc = await runCodexInDocker({
    cmdArgs: ['login', '--device-auth'],
    interactive: true,
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error('\nError: Codex login failed');
    return false;
  }
  await proc.credsCaptured;

  // Verify credentials after login
  return await checkCodexCredentials();
};
