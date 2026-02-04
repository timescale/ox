// ============================================================================
// GitHub Authentication TUI Component
// ============================================================================

import { useKeyboard } from '@opentui/react';
import open from 'open';
import { useEffect, useState } from 'react';
import { copyToClipboard } from '../services/clipboard';
import { applyHostGhCreds, checkGhCredentials } from '../services/gh';
import { startContainerGhAuth } from '../services/ghAuth';
import { log } from '../services/logger';
import { createTui } from '../services/tui';
import { useTheme } from '../stores/themeStore';
import { CopyOnSelect } from './CopyOnSelect';
import { Dots } from './Dots';
import { Frame } from './Frame';

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

/**
 * Run the GitHub auth setup screen as a standalone TUI.
 * This is used by commands like `branch` that need to ensure creds are available
 * but aren't part of a larger wizard flow.
 *
 * @returns Promise that resolves with the setup result
 */
export const runGhAuthScreen = async (): Promise<boolean> => {
  const authProcess = await startContainerGhAuth();
  if (!authProcess) {
    log.error('Failed to start GitHub auth process');
    return false;
  }

  const { render, destroy } = await createTui();

  render(
    <CopyOnSelect>
      <GhAuth
        code={authProcess.code}
        url={authProcess.url}
        onCancel={() => {
          authProcess.cancel();
        }}
      />
    </CopyOnSelect>,
  );

  const result = await authProcess.waitForCompletion();

  await destroy();

  return result;
};

export const ensureGhAuth = async (): Promise<void> => {
  if (await checkGhCredentials()) {
    return;
  }
  log.warn('GitHub credentials are missing or expired.');

  if (await applyHostGhCreds()) return;

  if (!(await runGhAuthScreen())) {
    // Show the TUI for interactive login
    throw new Error('GitHub authentication failed or was cancelled');
  }
};
