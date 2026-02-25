// ============================================================================
// GitHub App Service - Device flow OAuth and token management
//
// Implements the GitHub App OAuth device flow for CLI authentication.
// The Hermes GitHub App's client_id is hardcoded — no server-side secrets
// are needed. Users authorize via the device flow, and the resulting user
// access token is stored in the OS keyring.
//
// With this token, GitHub actions (PRs, comments, pushes) appear as the
// user "via Hermes" — attributed to the Hermes GitHub App.
// ============================================================================

import {
  deleteHermesSecret,
  getHermesSecret,
  setHermesSecret,
} from './keyring';
import { log } from './logger';

// ============================================================================
// Constants
// ============================================================================

/**
 * The Hermes GitHub App client ID.
 *
 * This is a public identifier (not a secret). It is different from the App ID.
 * Find it on the GitHub App settings page under "Client ID".
 */
export const GITHUB_APP_CLIENT_ID = 'Iv23likQt3nKCe1zzgkw';

/** The URL-friendly slug of the Hermes GitHub App (from https://github.com/apps/<slug>). */
export const GITHUB_APP_SLUG = 'hermes-cli';

/** URL to install the Hermes GitHub App on new orgs/repos. */
export const GITHUB_APP_INSTALL_URL = `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`;

/** Keyring account name for the GitHub App user access token. */
const KEYRING_ACCOUNT_TOKEN = 'github-app/user-token';

/** Keyring account name for the cached GitHub username. */
const KEYRING_ACCOUNT_USER = 'github-app/username';

// ============================================================================
// Types
// ============================================================================

/** Response from the GitHub device code endpoint. */
export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

/** A validated GitHub App credential (token + username). */
export interface GithubAppCredentials {
  token: string;
  username: string;
}

/** Error codes from the token polling endpoint. */
type DeviceFlowError =
  | 'authorization_pending'
  | 'slow_down'
  | 'expired_token'
  | 'unsupported_grant_type'
  | 'incorrect_client_credentials'
  | 'incorrect_device_code'
  | 'access_denied'
  | 'device_flow_disabled';

// ============================================================================
// Device Flow - HTTP Implementation
// ============================================================================

/**
 * Start the device flow by requesting a device code from GitHub.
 *
 * POST https://github.com/login/device/code
 */
export async function startDeviceFlow(): Promise<DeviceCodeResponse> {
  const response = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: GITHUB_APP_CLIENT_ID,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `GitHub device code request failed (${response.status}): ${text}`,
    );
  }

  return (await response.json()) as DeviceCodeResponse;
}

/**
 * Poll GitHub for a user access token after the user has entered the device code.
 *
 * POST https://github.com/login/oauth/access_token
 *
 * Handles `authorization_pending` (keep polling), `slow_down` (+5s to interval),
 * and terminal errors (expired_token, access_denied, etc.).
 *
 * @param deviceCode - The device_code from startDeviceFlow()
 * @param interval - Polling interval in seconds (from startDeviceFlow())
 * @param signal - Optional AbortSignal to cancel polling
 * @returns The access token string, or null if cancelled/failed
 */
export async function pollForToken(
  deviceCode: string,
  interval: number,
  signal?: AbortSignal,
): Promise<string | null> {
  let pollInterval = interval;

  while (!signal?.aborted) {
    await sleep(pollInterval * 1000);
    if (signal?.aborted) return null;

    const response = await fetch(
      'https://github.com/login/oauth/access_token',
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: GITHUB_APP_CLIENT_ID,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      log.error(`Token poll failed (${response.status}): ${text}`);
      return null;
    }

    const data = (await response.json()) as
      | { access_token: string; token_type: string }
      | {
          error: DeviceFlowError;
          error_description?: string;
          interval?: number;
        };

    if ('access_token' in data) {
      return data.access_token;
    }

    switch (data.error) {
      case 'authorization_pending':
        // User hasn't entered the code yet — keep polling
        break;
      case 'slow_down':
        // Add 5 seconds to the poll interval
        pollInterval = (data.interval ?? pollInterval) + 5;
        break;
      case 'expired_token':
        log.debug('Device code expired before user completed authorization');
        return null;
      case 'access_denied':
        log.debug('User denied authorization');
        return null;
      default:
        log.error(
          { error: data.error, description: data.error_description },
          'Device flow error',
        );
        return null;
    }
  }

  return null;
}

// ============================================================================
// Token Storage & Validation
// ============================================================================

/**
 * Validate a token by calling the GitHub API and return the username.
 * Returns null if the token is invalid or expired.
 */
export async function validateToken(token: string): Promise<string | null> {
  try {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      log.debug(`GitHub App token validation failed: ${response.status}`);
      return null;
    }

    const data = (await response.json()) as { login?: string };
    return data.login ?? null;
  } catch (err) {
    log.debug({ err }, 'Failed to validate GitHub App token');
    return null;
  }
}

/**
 * Save GitHub App credentials to the OS keyring.
 */
export async function saveCredentials(
  token: string,
  username: string,
): Promise<void> {
  await setHermesSecret(KEYRING_ACCOUNT_TOKEN, token);
  await setHermesSecret(KEYRING_ACCOUNT_USER, username);
  log.debug('Saved GitHub App credentials to keyring');
}

/**
 * Read and validate stored GitHub App credentials.
 * Returns credentials if valid, null otherwise.
 *
 * This performs a live API call to validate the token. Use
 * readCredentialsUnchecked() if you only need the stored values.
 */
export async function readCredentials(): Promise<GithubAppCredentials | null> {
  const token = await getHermesSecret(KEYRING_ACCOUNT_TOKEN);
  if (!token) {
    log.debug('No GitHub App token found in keyring');
    return null;
  }

  const username = await validateToken(token);
  if (!username) {
    log.debug('Stored GitHub App token is invalid or expired');
    return null;
  }

  return { token, username };
}

/**
 * Read stored credentials without validating against the API.
 * Useful for fast checks where network calls are undesirable.
 */
export async function readCredentialsUnchecked(): Promise<GithubAppCredentials | null> {
  const token = await getHermesSecret(KEYRING_ACCOUNT_TOKEN);
  const username = await getHermesSecret(KEYRING_ACCOUNT_USER);
  if (!token || !username) return null;
  return { token, username };
}

/**
 * Delete stored GitHub App credentials from the keyring.
 */
export async function deleteCredentials(): Promise<void> {
  await deleteHermesSecret(KEYRING_ACCOUNT_TOKEN);
  await deleteHermesSecret(KEYRING_ACCOUNT_USER);
  log.debug('Deleted GitHub App credentials from keyring');
}

/**
 * Check whether GitHub App credentials are configured and valid.
 */
export async function isGithubAppConfigured(): Promise<boolean> {
  const creds = await readCredentials();
  return creds !== null;
}

// ============================================================================
// Installation Checks
// ============================================================================

/**
 * Check whether the Hermes GitHub App has any installations accessible to
 * the authenticated user. This is used after the device flow to determine
 * if the user needs to install the app on their orgs/repos.
 *
 * @param token - A valid GitHub App user access token
 * @returns true if at least one installation exists
 */
export async function hasAnyInstallation(token: string): Promise<boolean> {
  try {
    const response = await fetch(
      'https://api.github.com/user/installations?per_page=1',
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );

    if (!response.ok) {
      log.debug(`Failed to check app installations: ${response.status}`);
      return false;
    }

    const data = (await response.json()) as {
      total_count?: number;
    };
    return (data.total_count ?? 0) > 0;
  } catch (err) {
    log.debug({ err }, 'Failed to check app installations');
    return false;
  }
}

/**
 * Check whether the GitHub App user access token has access to a specific
 * repository. This verifies that the Hermes app is installed on the org/account
 * that owns the repo AND that the user has access to it.
 *
 * @param token - A valid GitHub App user access token
 * @param repoFullName - Repository in "owner/repo" format
 * @returns true if the token can access the repository
 */
export async function checkRepoAccess(
  token: string,
  repoFullName: string,
): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${repoFullName}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );

    if (!response.ok) {
      log.debug(
        `Repo access check failed for ${repoFullName}: ${response.status}`,
      );
      return false;
    }

    return true;
  } catch (err) {
    log.debug({ err }, `Failed to check repo access for ${repoFullName}`);
    return false;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
