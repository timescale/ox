// ============================================================================
// GitHub Authentication TUI Components
// ============================================================================

import { useKeyboard } from '@opentui/react';
import open from 'open';
import { useEffect, useState } from 'react';
import { copyToClipboard } from '../services/clipboard';
import {
  GITHUB_APP_INSTALL_URL,
  hasAnyInstallation,
  isGithubAppConfigured,
  readCredentialsUnchecked,
} from '../services/githubApp';
import type { GithubAppAuthResult } from '../services/githubAppAuth';
import { startGithubAppAuth } from '../services/githubAppAuth';
import { log } from '../services/logger';
import { createTui } from '../services/tui';
import { useTheme } from '../stores/themeStore';
import { CopyOnSelect } from './CopyOnSelect';
import { Dots } from './Dots';
import { Frame } from './Frame';

// ============================================================================
// GhAuth Component — Device Flow Screen
// ============================================================================

export type GhAuthStatus =
  | { type: 'waiting'; code: string; url: string }
  | { type: 'success' }
  | { type: 'error'; message: string }
  | { type: 'cancelled' };

export interface GhAuthProps {
  code: string;
  url: string;
  onCancel: () => void;
}

export function GhAuth({ code, url, onCancel }: GhAuthProps) {
  const { theme } = useTheme();
  const [copied, setCopied] = useState(false);
  const [opened, setOpened] = useState(false);

  useKeyboard((key) => {
    if (key.name === 'escape') {
      onCancel();
    }
  });

  // Copy code to clipboard and open URL in browser on mount
  useEffect(() => {
    copyToClipboard(code)
      .then(() => setCopied(true))
      .catch((err: unknown) =>
        log.debug({ err }, 'Failed to copy code to clipboard'),
      );
    open(url)
      .then(() => setOpened(true))
      .catch((err: unknown) =>
        log.debug({ err }, 'Failed to open URL in browser'),
      );
  }, [code, url]);

  return (
    <Frame title="GitHub Authentication">
      <box flexDirection="column" alignItems="center">
        <text fg={theme.textMuted}>
          {opened
            ? 'Opening in your browser:'
            : 'Open this URL in your browser:'}
        </text>
        <text fg={theme.primary}>{url}</text>

        <box height={1} />

        <text fg={theme.textMuted}>And enter this one-time code:</text>
        <text fg={theme.success}> {code} </text>
        {copied && <text fg={theme.textMuted}>(copied to clipboard)</text>}

        <box height={2} />

        <text fg={theme.secondary}>
          Waiting for authentication
          <Dots />
        </text>

        <box height={1} />
        <text fg={theme.textMuted}>Press Esc to cancel</text>
      </box>
    </Frame>
  );
}

// ============================================================================
// GhAppInstall Component — Installation Prompt Screen
// ============================================================================

interface GhAppInstallProps {
  onDone: () => void;
  onSkip: () => void;
}

export function GhAppInstall({ onDone, onSkip }: GhAppInstallProps) {
  const { theme } = useTheme();
  const [opened, setOpened] = useState(false);

  useKeyboard((key) => {
    if (key.name === 'return') {
      onDone();
    } else if (key.name === 'escape') {
      onSkip();
    }
  });

  useEffect(() => {
    open(GITHUB_APP_INSTALL_URL)
      .then(() => setOpened(true))
      .catch((err: unknown) =>
        log.debug({ err }, 'Failed to open install URL in browser'),
      );
  }, []);

  return (
    <Frame title="Install Hermes GitHub App">
      <box flexDirection="column" alignItems="center">
        <text fg={theme.text}>
          The Hermes app needs to be installed on your GitHub
          organizations/repositories.
        </text>

        <box height={1} />

        <text fg={theme.textMuted}>
          {opened
            ? 'Opening installation page in your browser:'
            : 'Open this URL in your browser:'}
        </text>
        <text fg={theme.primary}>{GITHUB_APP_INSTALL_URL}</text>

        <box height={2} />

        <text fg={theme.textMuted}>
          After installing, press Enter to continue (or Esc to skip).
        </text>
      </box>
    </Frame>
  );
}

// ============================================================================
// Orchestration Functions
// ============================================================================

/**
 * Run the GitHub App installation prompt as a standalone TUI.
 * Opens the install URL in the browser and waits for the user to confirm.
 *
 * @returns true if the app has installations after the user confirms
 */
export const runGhAppInstallScreen = async (): Promise<boolean> => {
  const { render, destroy } = await createTui();

  const result = await new Promise<'done' | 'skip'>((resolve) => {
    render(
      <CopyOnSelect>
        <GhAppInstall
          onDone={() => resolve('done')}
          onSkip={() => resolve('skip')}
        />
      </CopyOnSelect>,
    );
  });

  await destroy();

  if (result === 'skip') {
    return false;
  }

  // Verify installation was completed
  const creds = await readCredentialsUnchecked();
  if (!creds) return false;

  const installed = await hasAnyInstallation(creds.token);
  if (!installed) {
    log.warn('GitHub App still not installed after user confirmation');
  }
  return installed;
};

/**
 * Run the GitHub App auth screen as a standalone TUI.
 * Uses the native GitHub App device flow (no Docker needed).
 * If auth succeeds but the app isn't installed, shows the install prompt.
 *
 * This is used by commands like `branch` that need to ensure creds are available
 * but aren't part of a larger wizard flow.
 *
 * @returns Promise that resolves with the setup result
 */
export const runGhAuthScreen = async (): Promise<boolean> => {
  const authProcess = await startGithubAppAuth();
  if (!authProcess) {
    log.error('Failed to start GitHub App auth process');
    return false;
  }

  const { render, destroy } = await createTui();

  render(
    <CopyOnSelect>
      <GhAuth
        code={authProcess.userCode}
        url={authProcess.verificationUri}
        onCancel={() => {
          authProcess.cancel();
        }}
      />
    </CopyOnSelect>,
  );

  const result: GithubAppAuthResult = await authProcess.waitForCompletion();

  await destroy();

  if (!result.success) {
    return false;
  }

  // If the app isn't installed anywhere, prompt the user to install it
  if (result.needsInstallation) {
    await runGhAppInstallScreen();
  }

  return true;
};

export const ensureGhAuth = async (): Promise<void> => {
  // If GitHub App credentials already exist and are valid, we're done.
  // This is the only check — we intentionally don't fall back to host gh
  // credentials here because the purpose of this flow is to obtain a
  // GitHub App token specifically.
  if (await isGithubAppConfigured()) {
    return;
  }

  // Run the GitHub App device flow interactively
  if (!(await runGhAuthScreen())) {
    throw new Error('GitHub authentication failed or was cancelled');
  }
};
