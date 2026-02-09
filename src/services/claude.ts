import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { AsyncEntry } from '@napi-rs/keyring';
import { isMac } from 'build-strap';
import { file } from 'bun';
import { runClaudeAuthScreen } from '../components/ClaudeAuth';
import { Deferred } from '../types/deferred';
import { CONTAINER_HOME, readFileFromContainer } from './dockerFiles';
import { log } from './logger';
import {
  type RunInDockerOptionsBase,
  type RunInDockerResult,
  runInDocker,
  type VirtualFile,
} from './runInDocker';

const CLAUDE_HOST_CONFIG_DIR = join(homedir(), '.claude');
const CLAUDE_AUTH_FILE_NAME = '.credentials.json';

const containerPaths = {
  credentialsJson: `${CONTAINER_HOME}/.claude/${CLAUDE_AUTH_FILE_NAME}`,
};

interface ClaudeCredentialsJson {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  };
}

const claudeCredsValid = (creds?: ClaudeCredentialsJson | null): boolean => {
  if (!creds?.claudeAiOauth?.accessToken) return false;
  const expiresAt = creds.claudeAiOauth.expiresAt || 0;
  return expiresAt > Date.now();
};

const readHostCredentials = async (): Promise<ClaudeCredentialsJson | null> => {
  const { username } = userInfo();
  if (isMac()) {
    // Prefer this method on mac, to avoid any prompt for credentials
    try {
      const secretResult =
        await Bun.$`security find-generic-password -s "Claude Code-credentials" -a "${username}" -w`.quiet();
      const creds = secretResult.json() as ClaudeCredentialsJson;
      if (claudeCredsValid(creds)) {
        log.debug('Found valid claude credentials in macOS keychain');
        return creds;
      }
      log.debug('Claude credentials present in macOS keychain, but invalid.');
    } catch (err) {
      log.debug(
        { err },
        'Failed to read claude credentials from macOS keychain.',
      );
    }
  }

  // Look in the OS keyring
  try {
    const credsEntry = new AsyncEntry('Claude Code-credentials', username);
    const creds = JSON.parse(
      (await credsEntry.getPassword()) || '{}',
    ) as ClaudeCredentialsJson;
    if (claudeCredsValid(creds)) {
      log.debug('Found valid claude credentials in OS keyring');
      return creds;
    }
    log.debug('Claude credentials present in OS keyring, but invalid.');
  } catch (err) {
    log.debug({ err }, 'Failed to read claude credentials from OS keyring.');
  }

  // Look for a file in the home directory
  try {
    const hostCredsFile = file(
      join(CLAUDE_HOST_CONFIG_DIR, CLAUDE_AUTH_FILE_NAME),
    );
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

const credsEntry = new AsyncEntry('hermes', 'claude/.credentials.json');
const readHermesCredentialCache =
  async (): Promise<ClaudeCredentialsJson | null> => {
    try {
      const creds = JSON.parse((await credsEntry.getPassword()) || '{}');
      if (claudeCredsValid(creds)) {
        log.debug('Found valid claude credentials in hermes keyring');
        return creds;
      }
      log.debug(
        { creds },
        'Claude credentials present in hermes keyring, but invalid.',
      );
    } catch {
      log.debug('No claude/.credentials.json found in hermes keyring');
    }
    return null;
  };

const writeHermesCredentialCache = async (
  creds: ClaudeCredentialsJson,
): Promise<void> => {
  await credsEntry.setPassword(JSON.stringify(creds));
};

export const captureClaudeCredentialsFromContainer = async (
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
      await writeHermesCredentialCache(creds);
      return true;
    }
    log.debug('Invalid claude credentials found in container');
  } catch {
    log.debug('No claude/.credentials.json found in container');
  }
  return false;
};

export const getClaudeConfigFiles = async (): Promise<VirtualFile[]> => {
  const creds: ClaudeCredentialsJson =
    (await readHostCredentials()) || (await readHermesCredentialCache()) || {};
  return [
    {
      path: containerPaths.credentialsJson,
      value: JSON.stringify(creds),
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
}: RunInDockerOptionsBase): Promise<
  RunInDockerResult & { credsCaptured: Promise<boolean> }
> => {
  const configFiles = await getClaudeConfigFiles();

  const result = await runInDocker({
    dockerArgs,
    cmdArgs,
    cmdName: 'claude',
    dockerImage,
    interactive,
    shouldThrow,
    files: [...configFiles, ...files],
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
