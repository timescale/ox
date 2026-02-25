// ============================================================================
// GitHub App Authentication Orchestrator
//
// Wraps the raw device flow HTTP calls from githubApp.ts into a
// high-level auth process with cancel support. This is the equivalent
// of ghAuth.ts but without Docker — the device flow runs natively.
// ============================================================================

import {
  type DeviceCodeResponse,
  hasAnyInstallation,
  pollForToken,
  saveCredentials,
  startDeviceFlow,
  validateToken,
} from './githubApp';
import { log } from './logger';

// ============================================================================
// Types
// ============================================================================

/** Result of the GitHub App auth process. */
export interface GithubAppAuthResult {
  /** Whether the OAuth authorization succeeded. */
  success: boolean;
  /**
   * Whether the app needs to be installed on orgs/repos.
   * True when auth succeeded but no installations were found.
   */
  needsInstallation: boolean;
}

export interface GithubAppAuthProcess {
  /** The user code to display (e.g. "ABCD-1234"). */
  userCode: string;
  /** The URL where the user enters the code (https://github.com/login/device). */
  verificationUri: string;
  /** Promise that resolves with the auth result. */
  waitForCompletion: () => Promise<GithubAppAuthResult>;
  /** Cancel the auth process. */
  cancel: () => void;
}

// ============================================================================
// Auth Process
// ============================================================================

/**
 * Start the GitHub App OAuth device flow.
 *
 * 1. Requests a device code from GitHub
 * 2. Returns a handle with the user code + URL for display
 * 3. waitForCompletion() polls for the token, saves it, and checks installations
 *
 * No Docker container is needed — this is pure HTTP.
 */
export async function startGithubAppAuth(): Promise<GithubAppAuthProcess | null> {
  let deviceCode: DeviceCodeResponse;
  try {
    deviceCode = await startDeviceFlow();
  } catch (err) {
    log.error({ err }, 'Failed to start GitHub App device flow');
    return null;
  }

  const abortController = new AbortController();

  return {
    userCode: deviceCode.user_code,
    verificationUri: deviceCode.verification_uri,

    waitForCompletion: async (): Promise<GithubAppAuthResult> => {
      const token = await pollForToken(
        deviceCode.device_code,
        deviceCode.interval,
        abortController.signal,
      );

      if (!token) {
        return { success: false, needsInstallation: false };
      }

      // Validate the token and get the username
      const username = await validateToken(token);
      if (!username) {
        log.error('Got a token but failed to validate it');
        return { success: false, needsInstallation: false };
      }

      // Save to keyring
      await saveCredentials(token, username);

      log.debug({ username }, 'GitHub App auth completed successfully');

      // Check if the app is installed on any repos
      const installed = await hasAnyInstallation(token);
      if (!installed) {
        log.debug('GitHub App is not installed on any repos');
      }

      return { success: true, needsInstallation: !installed };
    },

    cancel: () => {
      abortController.abort();
    },
  };
}
