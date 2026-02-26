import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { file } from 'bun';
import { runClaudeAuthScreen } from '../components/ClaudeAuth';
import type { ClaudeCredentialsJson } from '../types/agentConfig';
import { Deferred } from '../types/deferred';
import { readCache, writeCache } from './cache';
import { CONTAINER_HOME, readFileFromContainer } from './dockerFiles';
import { getHermesSecret, getSecret, setHermesSecret } from './keyring';
import { log } from './logger';
import {
  type RunInDockerOptionsBase,
  type RunInDockerResult,
  runInDocker,
  type VirtualFile,
} from './runInDocker';

const homePaths = {
  credentialsJson: join(homedir(), '.claude', '.credentials.json'),
  configJson: join(homedir(), '.claude.json'),
};

const containerPaths = {
  credentialsJson: join(CONTAINER_HOME, '.claude', '.credentials.json'),
  configJson: join(CONTAINER_HOME, '.claude.json'),
};

const claudeCredsValid = (creds?: ClaudeCredentialsJson | null): boolean => {
  if (!creds?.claudeAiOauth?.accessToken) return false;
  if (creds.claudeAiOauth.refreshToken) return true; // if we have a refresh token, we can get a new access token
  const expiresAt = creds.claudeAiOauth.expiresAt || 0;
  return expiresAt > Date.now();
};

const readHostCredentials = async (): Promise<ClaudeCredentialsJson | null> => {
  const { username } = userInfo();
  try {
    const raw = await getSecret('Claude Code-credentials', username);
    if (raw) {
      const creds = JSON.parse(raw) as ClaudeCredentialsJson;
      if (claudeCredsValid(creds)) {
        log.debug('Found valid claude credentials in OS keyring');
        return creds;
      }
      log.debug('Claude credentials present in OS keyring, but invalid.');
    }
  } catch (err) {
    log.debug({ err }, 'Failed to read claude credentials from OS keyring.');
  }

  // Look for a file in the home directory
  try {
    const hostCredsFile = file(homePaths.credentialsJson);
    if (!(await hostCredsFile.exists())) return null;
    const creds = await hostCredsFile.json();
    if (claudeCredsValid(creds)) {
      log.debug('Found valid claude credentials in home directory');
      return creds;
    }
    log.debug('Claude credentials present in home directory, but invalid.');
  } catch (err) {
    log.debug({ err }, 'Failed to read claude credentials from file.');
  }
  return null;
};

const HERMES_CREDS_ACCOUNT = 'claude/.credentials.json';

const readHermesCredentialCache =
  async (): Promise<ClaudeCredentialsJson | null> => {
    try {
      const raw = await getHermesSecret(HERMES_CREDS_ACCOUNT);
      const creds = JSON.parse(raw || '{}') as ClaudeCredentialsJson;
      if (claudeCredsValid(creds)) {
        log.debug('Found valid claude credentials in hermes keyring');
        return creds;
      }
      log.debug('Claude credentials present in hermes keyring, but invalid.');
    } catch {
      log.debug('No claude/.credentials.json found in hermes keyring');
    }
    return null;
  };

const captureClaudeCredentialsJsonFromContainer = async (
  containerId: string,
): Promise<boolean> => {
  try {
    const content = await readFileFromContainer(
      containerId,
      containerPaths.credentialsJson,
    );
    const creds = JSON.parse(content) as ClaudeCredentialsJson;
    if (claudeCredsValid(creds)) {
      log.debug('Valid claude credentials found in container');
      await setHermesSecret(HERMES_CREDS_ACCOUNT, JSON.stringify(creds));
      writeCache('claudeCredentialsJson', creds);
      return true;
    }
    log.debug('Invalid claude credentials found in container');
  } catch {
    log.debug('No claude/.credentials.json found in container');
  }
  return false;
};

interface ClaudeConfigJson {
  primaryApiKey?: string;
}

const projectConfig = {
  allowedTools: [],
  mcpContextUris: [],
  mcpServers: {},
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
  hasTrustDialogAccepted: true,
  hasClaudeMdExternalIncludesApproved: true,
  hasCompletedProjectOnboarding: true,
};

export const baseConfig = {
  numStartups: 1,
  installMethod: 'native',
  autoUpdates: false,
  hasCompletedOnboarding: true,
  effortCalloutDismissed: true,
  bypassPermissionsModeAccepted: true,
  projects: {
    '/work': projectConfig,
    '/work/app': projectConfig,
  },
};

const readHostConfigApiKey = async (): Promise<string | null> => {
  const { username } = userInfo();
  try {
    const key = await getSecret('Claude Code', username);
    if (key) {
      log.debug('Found claude API key in OS keyring');
      return key;
    }
  } catch (err) {
    log.debug({ err }, 'Failed to read claude API key from OS keyring.');
  }

  // Look for a file in the home directory
  try {
    const hostConfigFile = file(homePaths.configJson);
    if (!(await hostConfigFile.exists())) return null;
    const config: ClaudeConfigJson = await hostConfigFile.json();
    if (config.primaryApiKey) {
      log.debug('Found claude API key in home directory');
      return config.primaryApiKey;
    }
    log.debug('Claude config present in home directory, but no API key.');
  } catch (err) {
    log.debug({ err }, 'Failed to read claude config from file.');
  }
  return null;
};

const HERMES_APIKEY_ACCOUNT = '.claude.json/primaryApiKey';

const readHermesApiKeyCache = async (): Promise<string | null> => {
  try {
    const key = await getHermesSecret(HERMES_APIKEY_ACCOUNT);
    if (key) {
      log.debug('Found claude API key in hermes keyring');
      return key;
    }
    log.debug('Claude credentials present in hermes keyring, but invalid.');
  } catch {
    log.debug('No .claude.json/primaryApiKey found in hermes keyring');
  }
  return null;
};

export const captureClaudeApiKeyFromContainer = async (
  containerId: string,
): Promise<boolean> => {
  try {
    const content = await readFileFromContainer(
      containerId,
      containerPaths.configJson,
    );
    const config = JSON.parse(content) as ClaudeConfigJson;
    if (config.primaryApiKey) {
      log.debug('Claude API key found in container');
      await setHermesSecret(HERMES_APIKEY_ACCOUNT, config.primaryApiKey);
      writeCache('claudeApiKey', config.primaryApiKey);
      return true;
    }
  } catch {
    log.debug('No claude API key found in container');
  }
  return false;
};

export const captureClaudeCredentialsFromContainer = async (
  containerId: string,
): Promise<boolean> => {
  return (
    (await captureClaudeCredentialsJsonFromContainer(containerId)) ||
    (await captureClaudeApiKeyFromContainer(containerId))
  );
};

export const getClaudeCredentialsJson = async (
  force = false,
): Promise<ClaudeCredentialsJson | null> => {
  if (!force) {
    const cached = readCache('claudeCredentialsJson');
    if (cached) {
      log.trace('Using cached claude credentials');
      return cached.value;
    }
  }
  const hostCreds = await readHostCredentials();
  const hermesCreds = await readHermesCredentialCache();
  const creds =
    hostCreds?.claudeAiOauth?.expiresAt &&
    hermesCreds?.claudeAiOauth?.expiresAt &&
    hermesCreds.claudeAiOauth?.expiresAt > hostCreds.claudeAiOauth?.expiresAt
      ? hermesCreds
      : hostCreds || hermesCreds;
  writeCache('claudeCredentialsJson', creds);
  return creds;
};

export const getClaudeApiKey = async (
  force = false,
): Promise<string | null> => {
  if (!force) {
    const cached = readCache('claudeApiKey');
    if (cached) {
      log.trace('Using cached claude API key');
      return cached.value;
    }
  }
  const key = (await readHostConfigApiKey()) || (await readHermesApiKeyCache());
  writeCache('claudeApiKey', key);
  return key;
};

export const getClaudeConfigFiles = async (): Promise<VirtualFile[]> => {
  const creds = (await getClaudeCredentialsJson()) || {};
  const apiKey = await getClaudeApiKey();
  const config = {
    ...baseConfig,
    ...(apiKey ? { primaryApiKey: apiKey } : null),
  };
  return [
    {
      path: containerPaths.credentialsJson,
      value: JSON.stringify(creds),
    },
    {
      path: containerPaths.configJson,
      value: JSON.stringify(config),
    },
  ];
};

export const runClaudeInDocker = async ({
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
  const configFiles = await getClaudeConfigFiles();

  const effectiveDockerArgs = [
    ...dockerArgs,
    ...(process.env.COLORTERM
      ? ['-e', `COLORTERM=${process.env.COLORTERM}`]
      : []),
  ];

  const result = await runInDocker({
    dockerArgs: effectiveDockerArgs,
    cmdArgs,
    cmdName: 'claude',
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
          log.debug(`Claude exited with code ${code}, not saving credentials`);
          deferredCredsCaptured.resolve(false);
          return;
        }
        deferredCredsCaptured.wrap(
          captureClaudeCredentialsFromContainer(containerId),
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

export const checkClaudeCredentials = async (
  model = 'haiku',
): Promise<boolean> => {
  const proc = await runClaudeInDocker({
    cmdArgs: ['--model', model, '-p', 'just output `true`, and nothing else'],
    shouldThrow: false,
  });
  const exitCode = await proc.exited;
  const output = proc.text().trim();
  log.debug({ exitCode, output, model }, 'checkClaudeCredentials');
  return exitCode === 0;
};

/**
 * Ensure Claude credentials are valid, running interactive login if needed.
 * Returns true if credentials are valid after the check/login, false if login failed or was cancelled.
 */
export const ensureClaudeAuth = async (model?: string): Promise<boolean> => {
  if (await checkClaudeCredentials(model)) {
    return true;
  }

  log.warn('Claude credentials are missing or expired.');

  // Use TUI-based auth flow
  if (
    !(await runClaudeAuthScreen()) ||
    !(await checkClaudeCredentials(model))
  ) {
    // fallback to claude's interface
    const proc = await runClaudeInDocker({
      cmdArgs: ['/login'],
      interactive: true,
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      log.error(`claude /login exited with code ${exitCode}`);
    }
    await proc.credsCaptured;
    // Verify credentials after login
    return checkClaudeCredentials(model);
  }
  return true;
};
