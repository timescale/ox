import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { file } from 'bun';
import { runClaudeAuthScreen } from '../components/ClaudeAuth';
import type {
  ClaudeCredentialsJson,
  ClaudeOAuthAccount,
} from '../types/agentConfig';
import { Deferred } from '../types/deferred';
import { colorEnvArgs } from '../utils/shell';
import { readCache, writeCache } from './cache';
import { ensureDockerImageForAgent } from './docker';
import { CONTAINER_HOME, readFileFromContainer } from './dockerFiles';
import { getOxSecret, getSecret, setOxSecret, setSecret } from './keyring';
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

export const claudeCredsValid = (
  creds?: ClaudeCredentialsJson | null,
): boolean => {
  if (!creds?.claudeAiOauth?.accessToken) return false;
  if (creds.claudeAiOauth.refreshToken) return true; // if we have a refresh token, we can get a new access token
  const expiresAt = creds.claudeAiOauth.expiresAt || 0;
  return expiresAt > Date.now();
};

/**
 * Read the oauthAccount field from the host's ~/.claude.json.
 */
const readHostOAuthAccount = async (): Promise<ClaudeOAuthAccount | null> => {
  try {
    const hostConfigFile = file(homePaths.configJson);
    if (!(await hostConfigFile.exists())) return null;
    const config: ClaudeConfigJson = await hostConfigFile.json();
    if (config.oauthAccount) {
      log.trace('Found oauthAccount in host .claude.json');
      return config.oauthAccount;
    }
  } catch (err) {
    log.debug({ err }, 'Failed to read oauthAccount from host .claude.json');
  }
  return null;
};

export const readHostClaudeCredentials =
  async (): Promise<ClaudeCredentialsJson | null> => {
    const { username } = userInfo();
    try {
      const raw = await getSecret('Claude Code-credentials', username);
      if (raw) {
        const creds = JSON.parse(raw) as ClaudeCredentialsJson;
        if (claudeCredsValid(creds)) {
          log.trace('Found valid claude credentials in OS keyring');
          creds.oauthAccount = await readHostOAuthAccount();
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
        log.trace('Found valid claude credentials in home directory');
        creds.oauthAccount = await readHostOAuthAccount();
        return creds;
      }
      log.debug('Claude credentials present in home directory, but invalid.');
    } catch (err) {
      log.debug({ err }, 'Failed to read claude credentials from file.');
    }
    return null;
  };

const OX_CREDS_ACCOUNT = 'claude/.credentials.json';

export const readOxClaudeCredentialCache =
  async (): Promise<ClaudeCredentialsJson | null> => {
    try {
      const raw = await getOxSecret(OX_CREDS_ACCOUNT);
      const creds = JSON.parse(raw || '{}') as ClaudeCredentialsJson;
      if (claudeCredsValid(creds)) {
        log.trace('Found valid claude credentials in ox keyring');
        return creds;
      }
      log.debug('Claude credentials present in ox keyring, but invalid.');
    } catch {
      log.debug('No claude/.credentials.json found in ox keyring');
    }
    return null;
  };

/**
 * Write Claude credentials to the ox keyring cache and in-memory cache.
 */
export const writeOxClaudeCredentials = async (
  creds: ClaudeCredentialsJson,
): Promise<void> => {
  await setOxSecret(OX_CREDS_ACCOUNT, JSON.stringify(creds));
  writeCache('claudeCredentialsJson', creds);
};

/**
 * Write Claude OAuth credentials back to the host credential sources.
 * Updates both the OS keyring entry (Claude Code-credentials) and
 * the file (~/.claude/.credentials.json). Best-effort — logs errors
 * but does not throw.
 */
export const writeHostClaudeCredentials = async (
  creds: ClaudeCredentialsJson,
): Promise<void> => {
  const { username } = userInfo();
  const credsJson = JSON.stringify(creds);

  // Write to OS keyring
  try {
    await setSecret('Claude Code-credentials', username, credsJson);
    log.debug('Wrote claude credentials to host OS keyring');
  } catch (err) {
    log.warn({ err }, 'Failed to write claude credentials to host OS keyring');
  }

  // Write to host file
  try {
    await Bun.write(homePaths.credentialsJson, credsJson);
    log.debug('Wrote claude credentials to host file');
  } catch (err) {
    log.warn({ err }, 'Failed to write claude credentials to host file');
  }

  // Also update oauthAccount in ~/.claude.json if present in creds
  if (creds.oauthAccount) {
    try {
      const hostConfigFile = file(homePaths.configJson);
      if (await hostConfigFile.exists()) {
        const config = (await hostConfigFile.json()) as ClaudeConfigJson;
        config.oauthAccount = creds.oauthAccount;
        await Bun.write(homePaths.configJson, JSON.stringify(config, null, 2));
        log.debug('Updated oauthAccount in host .claude.json');
      }
    } catch (err) {
      log.warn({ err }, 'Failed to update oauthAccount in host .claude.json');
    }
  }
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

      // Also capture oauthAccount from the container's .claude.json
      try {
        const configContent = await readFileFromContainer(
          containerId,
          containerPaths.configJson,
        );
        const config = JSON.parse(configContent) as ClaudeConfigJson;
        if (config.oauthAccount) {
          creds.oauthAccount = config.oauthAccount;
          log.debug('Captured oauthAccount from container .claude.json');
        }
      } catch {
        log.debug('No .claude.json found in container for oauthAccount');
      }

      await writeOxClaudeCredentials(creds);
      return true;
    }
    log.debug('Invalid claude credentials found in container');
  } catch {
    log.debug('No claude/.credentials.json found in container');
  }
  return false;
};

interface ClaudeConfigJsonProject {
  allowedTools?: string[];
  disabledMcpjsonServers?: string[];
  enabledMcpjsonServers?: string[];
  exampleFiles?: string[];
  exampleFilesGeneratedAt?: number;
  hasClaudeMdExternalIncludesApproved?: boolean;
  hasCompletedProjectOnboarding?: boolean;
  hasTrustDialogAccepted?: boolean;
  mcpContextUris?: string[];
  mcpServers?: Record<string, unknown>;
}

interface ClaudeConfigJson {
  autoUpdates?: boolean;
  bypassPermissionsModeAccepted?: boolean;
  editorMode?: string;
  effortCalloutDismissed?: boolean;
  hasAcknowledgedCostThreshold?: boolean;
  hasCompletedOnboarding?: boolean;
  installMethod?: string;
  numStartups?: number;
  oauthAccount?: ClaudeOAuthAccount | null;
  primaryApiKey?: string;
  projects?: Record<string, ClaudeConfigJsonProject>;
  theme?: string;
  userID?: string;
}

const projectConfig: ClaudeConfigJsonProject = {
  allowedTools: [],
  disabledMcpjsonServers: [],
  enabledMcpjsonServers: [],
  hasClaudeMdExternalIncludesApproved: true,
  hasCompletedProjectOnboarding: true,
  hasTrustDialogAccepted: true,
  mcpContextUris: [],
  mcpServers: {},
};

export const baseConfig: ClaudeConfigJson = {
  autoUpdates: false,
  bypassPermissionsModeAccepted: true,
  effortCalloutDismissed: true,
  hasAcknowledgedCostThreshold: true,
  hasCompletedOnboarding: true,
  installMethod: 'native',
  numStartups: 1,
  projects: { '/work': projectConfig, '/work/app': projectConfig },
};

export const readHostConfigJson =
  async (): Promise<ClaudeConfigJson | null> => {
    try {
      const hostConfigFile = file(homePaths.configJson);
      if (!(await hostConfigFile.exists())) return null;
      const config: ClaudeConfigJson = await hostConfigFile.json();
      return config;
    } catch (err) {
      log.debug({ err }, 'Failed to read host .claude.json');
      return null;
    }
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
    const config = await readHostConfigJson();
    if (config?.primaryApiKey) {
      log.debug('Found claude API key in home directory');
      return config.primaryApiKey;
    }
    log.trace('Claude config present in home directory, but no API key.');
  } catch (err) {
    log.debug({ err }, 'Failed to read claude config from file.');
  }
  return null;
};

const OX_APIKEY_ACCOUNT = '.claude.json/primaryApiKey';

const readOxApiKeyCache = async (): Promise<string | null> => {
  try {
    const key = await getOxSecret(OX_APIKEY_ACCOUNT);
    if (key) {
      log.debug('Found claude API key in ox keyring');
      return key;
    }
    log.trace('No .claude.json/primaryApiKey found in ox keyring');
  } catch (err) {
    log.error({ err }, 'getOxSecret failed');
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
      await setOxSecret(OX_APIKEY_ACCOUNT, config.primaryApiKey);
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

/**
 * Returns true if claude has valid file-based credentials (host keyring,
 * host file, or ox keyring), independent of the ANTHROPIC_API_KEY env var.
 */
export const hasValidClaudeFileCredentials = async (): Promise<boolean> => {
  const creds = await readHostClaudeCredentials();
  if (claudeCredsValid(creds)) return true;
  const oxCreds = await readOxClaudeCredentialCache();
  if (claudeCredsValid(oxCreds)) return true;
  const apiKey = await readHostConfigApiKey();
  if (apiKey) return true;
  const oxApiKey = await readOxApiKeyCache();
  return !!oxApiKey;
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
  const hostCreds = await readHostClaudeCredentials();
  const oxCreds = await readOxClaudeCredentialCache();
  const creds =
    hostCreds?.claudeAiOauth?.expiresAt &&
    oxCreds?.claudeAiOauth?.expiresAt &&
    oxCreds.claudeAiOauth?.expiresAt > hostCreds.claudeAiOauth?.expiresAt
      ? oxCreds
      : hostCreds || oxCreds;
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
  const key = (await readHostConfigApiKey()) || (await readOxApiKeyCache());
  writeCache('claudeApiKey', key);
  return key;
};

export const getClaudeConfigFiles = async (): Promise<VirtualFile[]> => {
  const { oauthAccount, ...creds } = (await getClaudeCredentialsJson()) || {};
  const apiKey = await getClaudeApiKey();
  const hostConfig = await readHostConfigJson();
  const config = {
    ...baseConfig,
    ...(hostConfig?.theme ? { theme: hostConfig.theme } : null),
    ...(hostConfig?.editorMode ? { editorMode: hostConfig.editorMode } : null),
    ...(apiKey ? { primaryApiKey: apiKey } : null),
    ...(oauthAccount ? { oauthAccount } : null),
  };
  const cwdProject = hostConfig?.projects?.[process.cwd()];
  const cfgProject = config.projects?.['/work/app'];
  if (cwdProject?.exampleFiles && cfgProject) {
    cfgProject.exampleFiles = cwdProject.exampleFiles;
    cfgProject.exampleFilesGeneratedAt = cwdProject.exampleFilesGeneratedAt;
  }
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

  // Ensure the claude agent overlay image is available when no explicit image is provided
  const resolvedImage =
    dockerImage ?? (await ensureDockerImageForAgent('claude'));

  const effectiveDockerArgs = [...colorEnvArgs, ...dockerArgs];

  const result = await runInDocker({
    dockerArgs: effectiveDockerArgs,
    cmdArgs,
    cmdName: 'claude',
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
  const statusProc = await runClaudeInDocker({
    cmdArgs: ['auth', 'status'],
    shouldThrow: false,
  });
  const statusExitCode = await statusProc.exited;
  const status = statusProc.json() as { loggedIn: boolean } | null;
  const validStatus = statusExitCode === 0 && status?.loggedIn;
  if (!validStatus) {
    log.debug(
      { exitCode: statusExitCode, status },
      'claude auth status (invalid)',
    );
    return false;
  }

  const testProc = await runClaudeInDocker({
    cmdArgs: ['--model', model, '-p', 'just output `true`, and nothing else'],
    shouldThrow: false,
  });
  const exitCode = await testProc.exited;
  const valid = exitCode === 0;
  if (valid) {
    log.debug('checkClaudeCredentials (valid)');
    await testProc.credsCaptured;
    return true;
  }
  log.debug(
    {
      exitCode,
      output: testProc.text().trim(),
      errText: testProc.errorText().trim(),
      model,
    },
    'checkClaudeCredentials (invalid)',
  );
  return false;
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
