// ============================================================================
// Cloud Setup Component - Token validation and snapshot creation
// ============================================================================

import { useKeyboard } from '@opentui/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { readConfig } from '../services/config';
import {
  getDenoToken,
  setDenoToken,
  validateDenoToken,
} from '../services/deno';
import { log } from '../services/logger';
import {
  ensureCloudSnapshot,
  type SnapshotBuildProgress,
} from '../services/sandbox/cloudSnapshot';
import { createTui } from '../services/tui';
import { useTheme } from '../stores/themeStore';
import { CopyOnSelect } from './CopyOnSelect';
import { Frame } from './Frame';
import { Loading } from './Loading';

// ============================================================================
// Types
// ============================================================================

export type CloudSetupResultType = 'ready' | 'cancelled' | 'error';

export interface CloudSetupResult {
  type: CloudSetupResultType;
  error?: string;
}

export interface CloudSetupProps {
  /** Title to show in the UI (e.g., "Step 1/4: Cloud Setup") */
  title?: string;
  /** Called when cloud setup completes, is cancelled, or errors */
  onComplete: (result: CloudSetupResult) => void;
  /** Whether to show back button (for wizard integration) */
  showBack?: boolean;
  /** Called when back is pressed */
  onBack?: () => void;
}

type CloudSetupState =
  | { type: 'checking-token' }
  | { type: 'need-token' }
  | { type: 'validating-token'; message: string }
  | { type: 'invalid-token'; message: string }
  | { type: 'checking-snapshot' }
  | { type: 'building-snapshot'; message: string; detail?: string }
  | { type: 'ready' }
  | { type: 'error'; message: string };

// ============================================================================
// Default region for snapshot builds
// ============================================================================

const DEFAULT_REGION = 'ord';

// ============================================================================
// Component
// ============================================================================

export function CloudSetup({
  title = 'Cloud Setup',
  onComplete,
  showBack = false,
  onBack,
}: CloudSetupProps) {
  const { theme } = useTheme();
  const [state, setState] = useState<CloudSetupState>({
    type: 'checking-token',
  });
  const [tokenInput, setTokenInput] = useState('');
  const buildingRef = useRef(false);
  const unmountedRef = useRef(false);

  // Start snapshot check after token is validated
  const startSnapshotCheck = useCallback(
    async (token: string) => {
      setState({ type: 'checking-snapshot' });

      if (buildingRef.current) return;
      buildingRef.current = true;

      let region = DEFAULT_REGION;
      try {
        const config = await readConfig();
        region = config.cloudRegion ?? DEFAULT_REGION;
      } catch (err) {
        log.debug({ err }, 'Failed to read config for cloud region');
      }

      ensureCloudSnapshot({
        token,
        region,
        onProgress: (progress: SnapshotBuildProgress) => {
          if (unmountedRef.current) return;

          switch (progress.type) {
            case 'checking':
              setState({
                type: 'checking-snapshot',
              });
              break;
            case 'exists':
              buildingRef.current = false;
              setState({ type: 'ready' });
              setTimeout(() => {
                if (!unmountedRef.current) {
                  onComplete({ type: 'ready' });
                }
              }, 500);
              break;
            case 'creating-volume':
            case 'booting-sandbox':
            case 'installing':
            case 'snapshotting':
            case 'cleaning-up':
              setState({
                type: 'building-snapshot',
                message: progress.message,
                detail: 'detail' in progress ? progress.detail : undefined,
              });
              break;
            case 'done':
              buildingRef.current = false;
              setState({ type: 'ready' });
              setTimeout(() => {
                if (!unmountedRef.current) {
                  onComplete({ type: 'ready' });
                }
              }, 500);
              break;
            case 'error':
              buildingRef.current = false;
              setState({ type: 'error', message: progress.message });
              break;
          }
        },
      }).catch((err) => {
        if (unmountedRef.current) return;
        buildingRef.current = false;
        setState({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      });
    },
    [onComplete],
  );

  // Check for existing token on mount
  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        const token = await getDenoToken();
        if (cancelled) return;

        if (!token) {
          setState({ type: 'need-token' });
          return;
        }

        setState({ type: 'validating-token', message: 'Validating token' });
        const result = await validateDenoToken(token);
        if (cancelled) return;

        if (result === 'invalid') {
          setState({
            type: 'invalid-token',
            message: 'Stored token is invalid or expired',
          });
        } else {
          // 'valid' or 'error' (API down) — proceed with stored token
          startSnapshotCheck(token);
        }
      } catch (err) {
        if (cancelled) return;
        log.debug({ err }, 'Error checking Deno token');
        setState({ type: 'need-token' });
      }
    };

    check();
    return () => {
      cancelled = true;
    };
  }, [startSnapshotCheck]);

  // Track unmount
  useEffect(() => {
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  const handleCancel = useCallback(() => {
    if (showBack && onBack) {
      onBack();
    } else {
      onComplete({ type: 'cancelled' });
    }
  }, [showBack, onBack, onComplete]);

  // Handle token submission
  const handleTokenSubmit = useCallback(async () => {
    const token = tokenInput.trim();
    if (!token) return;

    setState({ type: 'validating-token', message: 'Validating token' });

    try {
      const result = await validateDenoToken(token);
      if (result === 'invalid') {
        setState({
          type: 'invalid-token',
          message: 'Token is invalid. Please check and try again.',
        });
      } else {
        // 'valid' or 'error' (API down) — save and proceed
        await setDenoToken(token);
        startSnapshotCheck(token);
      }
    } catch (err) {
      log.debug({ err }, 'Error validating token');
      setState({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [tokenInput, startSnapshotCheck]);

  useKeyboard((key) => {
    if (key.name === 'escape') {
      handleCancel();
    }
    if (
      key.name === 'return' &&
      (state.type === 'need-token' || state.type === 'invalid-token')
    ) {
      handleTokenSubmit();
    }
    if (
      key.name === 'backspace' &&
      showBack &&
      (state.type === 'need-token' || state.type === 'invalid-token')
    ) {
      onBack?.();
    }
  });

  // ---- Checking Token State ----
  if (state.type === 'checking-token') {
    return (
      <Loading
        title={title}
        message="Checking Deno Deploy token"
        onCancel={handleCancel}
      />
    );
  }

  // ---- Validating Token State ----
  if (state.type === 'validating-token') {
    return (
      <Loading title={title} message={state.message} onCancel={handleCancel} />
    );
  }

  // ---- Checking Snapshot State ----
  if (state.type === 'checking-snapshot') {
    return (
      <Loading
        title={title}
        message="Checking cloud snapshot"
        onCancel={handleCancel}
      />
    );
  }

  // ---- Building Snapshot State ----
  if (state.type === 'building-snapshot') {
    return (
      <Loading
        title={title}
        message={state.message}
        detail={state.detail ?? 'This may take several minutes on first run'}
        onCancel={handleCancel}
      />
    );
  }

  // ---- Ready State ----
  if (state.type === 'ready') {
    return (
      <Frame title={title} centered>
        <text fg={theme.success}>Cloud sandbox is ready!</text>
        <text fg={theme.textMuted} marginTop={1}>
          Press Esc to exit
        </text>
      </Frame>
    );
  }

  // ---- Error State ----
  if (state.type === 'error') {
    const isNetworkError =
      state.message.includes('Network error') ||
      state.message.includes('fetch failed') ||
      state.message.includes('ECONNREFUSED');
    const isTokenError =
      state.message.includes('token') || state.message.includes('401');

    return (
      <Frame title={title} centered>
        <text fg={theme.error}>Error: {state.message}</text>
        <text fg={theme.textMuted} marginTop={1}>
          {isNetworkError
            ? 'Cannot connect to Deno Deploy. Check your internet connection and try again.'
            : isTokenError
              ? 'Invalid or expired token. Please provide a new token.'
              : 'Snapshot build failed. Please try again.'}
        </text>
        <text fg={theme.primary}>
          Visit: https://console.deno.com (Settings {'>'} Organization tokens)
        </text>
        <text fg={theme.textMuted} marginTop={1}>
          Press Esc to exit
        </text>
      </Frame>
    );
  }

  // ---- Need Token / Invalid Token State ----
  const isInvalid = state.type === 'invalid-token';

  return (
    <Frame title={title}>
      <box flexDirection="column" padding={1}>
        {isInvalid ? (
          <text fg={theme.error}>{state.message}</text>
        ) : (
          <text fg={theme.text}>
            A Deno Deploy organization token is required for cloud sandboxes.
          </text>
        )}

        <text fg={theme.textMuted} marginTop={1}>
          Create one at your org Settings {'>'} Organization tokens:
        </text>
        <text fg={theme.primary}>https://console.deno.com</text>

        <box marginTop={2} flexDirection="column">
          <text fg={theme.text}>Paste your token:</text>
          <box marginTop={1} flexDirection="row" height={1}>
            <input
              focused
              value={tokenInput}
              placeholder="ddo_xxxxxxxxxxxxxxxxxxxx"
              onInput={setTokenInput}
              flexGrow={1}
              backgroundColor={theme.backgroundElement}
              textColor={theme.text}
            />
          </box>
        </box>

        <box marginTop={2} flexDirection="row">
          <text fg={theme.textMuted}>
            Press Enter to submit
            {showBack ? ', Backspace to go back' : ', Esc to cancel'}
          </text>
        </box>
      </box>
    </Frame>
  );
}

// ============================================================================
// Standalone TUI Runner
// ============================================================================

/**
 * Run the cloud setup screen as a standalone TUI.
 * This is used by commands that need to ensure the cloud sandbox is ready
 * but aren't part of a larger wizard flow.
 *
 * The TUI handles token validation and snapshot creation.
 *
 * @returns Promise that resolves with the setup result
 */
export async function runCloudSetupScreen(): Promise<CloudSetupResult> {
  let resolveSetup!: (result: CloudSetupResult) => void;
  const setupPromise = new Promise<CloudSetupResult>((resolve) => {
    resolveSetup = resolve;
  });

  const { render, destroy } = await createTui();

  render(
    <CopyOnSelect>
      <CloudSetup
        title="Cloud Setup"
        onComplete={(result) => resolveSetup(result)}
      />
    </CopyOnSelect>,
  );

  const result = await setupPromise;

  await destroy();

  return result;
}
