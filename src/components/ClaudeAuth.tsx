// ============================================================================
// Claude Authentication TUI Component
// ============================================================================

import { useKeyboard } from '@opentui/react';
import open from 'open';
import { useEffect, useRef, useState } from 'react';
import {
  type ClaudeAuthProcess,
  type ClaudeLoginMethod,
  LOGIN_METHOD_OPTIONS,
  startClaudeAuth,
} from '../services/claudeAuth';
import { copyToClipboard } from '../services/clipboard';
import { log } from '../services/logger';
import { createTui } from '../services/tui';
import { useTheme } from '../stores/themeStore';
import { resetTerminal, restoreConsole } from '../utils';
import { CopyOnSelect } from './CopyOnSelect';
import { Dots } from './Dots';
import { Frame } from './Frame';
import { Selector } from './Selector';

// ============================================================================
// Types
// ============================================================================

type AuthStage =
  | 'select-method'
  | 'waiting-url'
  | 'enter-code'
  | 'waiting-completion'
  | 'success'
  | 'error';

export interface ClaudeAuthProps {
  authProcess: ClaudeAuthProcess;
  onComplete: (success: boolean) => void;
}

// ============================================================================
// Main Component
// ============================================================================

export function ClaudeAuth({ authProcess, onComplete }: ClaudeAuthProps) {
  const { theme } = useTheme();
  const [stage, setStage] = useState<AuthStage>('select-method');
  const [url, setUrl] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const completionStarted = useRef(false);

  // Handle escape key for cancellation
  useKeyboard((key) => {
    if (key.name === 'escape' && stage !== 'waiting-completion') {
      authProcess.cancel();
      onComplete(false);
    }
  });

  // Handle login method selection
  const handleMethodSelect = async (value: string | null) => {
    if (!value) return;
    const method = Number(value) as ClaudeLoginMethod;
    log.debug({ method }, 'User selected login method');

    authProcess.selectLoginMethod(method);
    setStage('waiting-url');

    try {
      const authUrl = await authProcess.waitForUrl();
      log.debug({ url: authUrl }, 'Received authorization URL');
      setUrl(authUrl);
      setStage('enter-code');

      // Auto-open URL in browser
      open(authUrl)
        .then(() => setOpened(true))
        .catch((err: unknown) => {
          log.debug({ err }, 'Failed to open URL in browser');
        });
    } catch (err) {
      log.error({ err }, 'Failed to get authorization URL');
      setError(
        err instanceof Error ? err.message : 'Failed to get authorization URL',
      );
      setStage('error');
      authProcess.cancel();
    }
  };

  // Handle code submission
  const handleCodeSubmit = async () => {
    if (!code.trim()) return;
    if (completionStarted.current) return; // Prevent double-submit
    completionStarted.current = true;

    log.debug('User submitting auth code');
    setStage('waiting-completion');

    // Submit code and wait for it to be sent (includes Enter key)
    await authProcess.submitCode(code.trim());

    // Now wait for completion
    const success = await authProcess.waitForCompletion();
    if (success) {
      setStage('success');
      // Kill the docker process now that we're done
      authProcess.cancel();
      // Brief delay to show success, then complete
      setTimeout(() => onComplete(true), 500);
    } else {
      setError('Login failed. Please check your code and try again.');
      setStage('error');
      authProcess.cancel();
    }
  };

  // Handle code input changes
  const handleCodeInput = (value: string) => {
    setCode(value);
  };

  // Render based on current stage
  switch (stage) {
    case 'select-method':
      return (
        <Frame title="Claude Login">
          <Selector
            title=""
            description="Select login method:"
            options={LOGIN_METHOD_OPTIONS.map((opt) => ({
              name: opt.name,
              description: opt.description,
              value: String(opt.value),
            }))}
            initialIndex={0}
            onSelect={handleMethodSelect}
            onCancel={() => {
              authProcess.cancel();
              onComplete(false);
            }}
          />
        </Frame>
      );

    case 'waiting-url':
      return (
        <Frame title="Claude Login">
          <box flexDirection="column" alignItems="center" padding={2}>
            <text fg={theme.secondary}>
              Waiting for authorization URL
              <Dots />
            </text>
            <box height={1} />
            <text fg={theme.textMuted}>Press Esc to cancel</text>
          </box>
        </Frame>
      );

    case 'enter-code':
      // url is guaranteed to be set when we reach enter-code stage
      if (!url) {
        setError('Internal error: missing authorization URL');
        setStage('error');
        return null;
      }
      return (
        <Frame title="Claude Login">
          <CodeEntryScreen
            url={url}
            code={code}
            opened={opened}
            onCodeChange={handleCodeInput}
            onSubmit={handleCodeSubmit}
            onCancel={() => {
              authProcess.cancel();
              onComplete(false);
            }}
          />
        </Frame>
      );

    case 'waiting-completion':
      return (
        <Frame title="Claude Login">
          <box flexDirection="column" alignItems="center" padding={2}>
            <text fg={theme.secondary}>
              Authenticating
              <Dots />
            </text>
            <box height={1} />
            <text fg={theme.textMuted}>Please wait...</text>
          </box>
        </Frame>
      );

    case 'success':
      return (
        <Frame title="Claude Login">
          <box flexDirection="column" alignItems="center" padding={2}>
            <text fg={theme.success}>Login successful!</text>
          </box>
        </Frame>
      );

    case 'error':
      return (
        <Frame title="Claude Login">
          <box flexDirection="column" alignItems="center" padding={2}>
            <text fg={theme.error}>Error</text>
            <box height={1} />
            <text fg={theme.text}>{error}</text>
            <box height={1} />
            <text fg={theme.textMuted}>Press Esc to exit</text>
          </box>
        </Frame>
      );
  }
}

// ============================================================================
// Code Entry Screen Component
// ============================================================================

interface CodeEntryScreenProps {
  url: string;
  code: string;
  opened: boolean;
  onCodeChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

function CodeEntryScreen({
  url,
  code,
  opened,
  onCodeChange,
  onSubmit,
  onCancel,
}: CodeEntryScreenProps) {
  const { theme } = useTheme();
  const [copied, setCopied] = useState(false);

  // Copy URL to clipboard on mount
  useEffect(() => {
    copyToClipboard(url)
      .then(() => setCopied(true))
      .catch((err: unknown) => {
        log.debug({ err }, 'Failed to copy URL to clipboard');
      });
  }, [url]);

  useKeyboard((key) => {
    if (key.name === 'return' && code.trim()) {
      onSubmit();
    }
    if (key.name === 'escape') {
      onCancel();
    }
  });

  return (
    <box flexDirection="column" padding={1}>
      <text fg={theme.textMuted}>
        {opened ? 'Opening in your browser:' : 'Open this URL in your browser:'}
      </text>
      <box height={1} />
      <text fg={theme.primary}>{url}</text>
      {copied && (
        <text fg={theme.textMuted} marginTop={1}>
          (copied to clipboard)
        </text>
      )}

      <box height={2} />

      <text fg={theme.text}>Paste code here if prompted:</text>
      <box marginTop={1} flexDirection="row" height={1}>
        <input
          focused
          value={code}
          placeholder="Enter authorization code..."
          onInput={onCodeChange}
          flexGrow={1}
          backgroundColor={theme.backgroundElement}
          textColor={theme.text}
        />
      </box>

      <box height={2} />

      <text fg={theme.textMuted}>Press Enter to submit, Esc to cancel</text>
    </box>
  );
}

// ============================================================================
// Standalone TUI Runner
// ============================================================================

/**
 * Run the Claude auth setup screen as a standalone TUI.
 * This is used when credentials are missing or expired.
 *
 * @returns Promise that resolves with true on success, false on failure/cancel
 */
export const runClaudeAuthScreen = async (): Promise<boolean> => {
  log.debug('runClaudeAuthScreen: starting');
  const authProcess = await startClaudeAuth();
  if (!authProcess) {
    log.error('Failed to start Claude auth process');
    return false;
  }
  log.debug('runClaudeAuthScreen: auth process started, creating TUI');

  const { renderer, render, destroy } = await createTui();
  log.debug('runClaudeAuthScreen: TUI created, rendering');

  return new Promise<boolean>((resolve) => {
    let resolved = false;
    const handleComplete = async (success: boolean) => {
      if (resolved) return;
      resolved = true;
      log.debug({ success }, 'runClaudeAuthScreen: completing');
      await destroy();
      resolve(success);
    };

    // If the renderer is destroyed externally (e.g. Ctrl+C triggers
    // exitOnCtrlC), cancel the auth process and exit. The user pressed
    // Ctrl+C to quit, so we should exit the process entirely rather than
    // falling through to a fallback login flow.
    renderer.on('destroy', () => {
      if (resolved) return;
      resolved = true;
      log.debug('runClaudeAuthScreen: renderer destroyed, cancelling auth');
      authProcess.cancel();
      // Defer exit until after opentui's finalizeDestroy() completes —
      // the 'destroy' event fires mid-teardown, before raw mode is
      // restored and the native renderer is cleaned up.
      setImmediate(() => {
        restoreConsole();
        resetTerminal();
        process.exit(0);
      });
    });

    render(
      <CopyOnSelect>
        <ClaudeAuth authProcess={authProcess} onComplete={handleComplete} />
      </CopyOnSelect>,
    );
  });
};
