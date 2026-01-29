// ============================================================================
// GHCR Credentials Input Component
// ============================================================================

import type { TextareaRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import open from 'open';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  GHCR_LOGIN_INSTRUCTIONS,
  GHCR_TOKEN_URL,
  type GhcrCredentials,
} from '../services/docker';
import { log } from '../services/logger';

export interface GhcrCredentialsProps {
  title?: string;
  onSubmit: (credentials: GhcrCredentials) => void;
  onSkip: () => void;
  onCancel: () => void;
  error?: string;
}

type FocusedField = 'username' | 'password';

export function GhcrCredentialsInput({
  title = 'Docker Setup',
  onSubmit,
  onSkip,
  onCancel,
  error,
}: GhcrCredentialsProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [focused, setFocused] = useState<FocusedField>('username');

  // Refs for the textarea elements to read values
  const usernameRef = useRef<TextareaRenderable | null>(null);
  const passwordRef = useRef<TextareaRenderable | null>(null);

  // Focus management
  const focusUsername = useCallback(() => {
    setFocused('username');
  }, []);

  const focusPassword = useCallback(() => {
    setFocused('password');
  }, []);

  // Sync state from textarea refs
  const syncValues = useCallback(() => {
    const u = usernameRef.current?.plainText.trim() ?? '';
    const p = passwordRef.current?.plainText.trim() ?? '';
    setUsername(u);
    setPassword(p);
    return { username: u, password: p };
  }, []);

  useKeyboard((key) => {
    if (key.name === 'escape') {
      onCancel();
      return;
    }

    // Skip with Ctrl+S
    if (key.ctrl && key.name === 's') {
      onSkip();
      return;
    }

    // Tab to switch between fields
    if (key.name === 'tab') {
      syncValues();
      if (focused === 'username') {
        focusPassword();
      } else {
        focusUsername();
      }
      return;
    }

    // Enter to submit or move to next field
    if (key.name === 'return') {
      const { username: u, password: p } = syncValues();
      if (focused === 'username') {
        focusPassword();
      } else if (u && p) {
        onSubmit({ username: u, password: p });
      }
      return;
    }
  });

  const canSubmit = username.length > 0 && password.length > 0;

  useEffect(() => {
    open(GHCR_TOKEN_URL).catch((err: unknown) =>
      log.error({ err }, 'Failed to open GHCR token URL'),
    );
  }, []);

  return (
    <box flexDirection="column" padding={1} flexGrow={1}>
      <box
        title={title}
        border
        borderStyle="single"
        padding={1}
        flexDirection="column"
        flexGrow={1}
      >
        {/* Instructions */}
        <text fg="#ccc">{GHCR_LOGIN_INSTRUCTIONS}</text>

        <box height={1} />

        {/* Error message */}
        {error && (
          <>
            <text fg="#ff4444">{error}</text>
            <box height={1} />
          </>
        )}

        {/* Username field */}
        <box flexDirection="row" height={1}>
          <text fg={focused === 'username' ? '#fff' : '#888'}>Username: </text>
          <textarea
            ref={usernameRef}
            placeholder="your-github-username"
            focused={focused === 'username'}
            onContentChange={syncValues}
            textColor={focused === 'username' ? '#0ff' : '#aaa'}
            focusedTextColor="#0ff"
            backgroundColor="transparent"
            focusedBackgroundColor="transparent"
            flexGrow={1}
            height={1}
          />
        </box>

        <box height={1} />

        {/* Token field */}
        <box flexDirection="row" height={1}>
          <text fg={focused === 'password' ? '#fff' : '#888'}>Token: </text>
          <textarea
            ref={passwordRef}
            placeholder="ghp_xxxxxxxxxxxx"
            focused={focused === 'password'}
            onContentChange={syncValues}
            textColor={focused === 'password' ? '#0ff' : '#aaa'}
            focusedTextColor="#0ff"
            backgroundColor="transparent"
            focusedBackgroundColor="transparent"
            flexGrow={1}
            height={1}
          />
        </box>

        <box height={1} />

        {/* Help text */}
        <text fg="#666">Tab to switch fields, Enter to submit</text>
        <box height={1} />

        {/* Actions */}
        <box flexDirection="row" gap={2}>
          <text fg={canSubmit ? '#0c0' : '#666'}>
            [Enter] Submit{canSubmit ? '' : ' (fill both fields)'}
          </text>
          <text fg="#888">[Ctrl+S] Skip (build from scratch)</text>
          <text fg="#555">[Esc] Cancel</text>
        </box>
      </box>
    </box>
  );
}
