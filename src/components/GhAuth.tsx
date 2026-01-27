// ============================================================================
// GitHub Authentication TUI Component
// ============================================================================

import { useKeyboard } from '@opentui/react';
import { useEffect, useRef, useState } from 'react';
import { Frame } from './Frame';

export type GhAuthStatus =
  | { type: 'waiting'; code: string; url: string }
  | { type: 'success' }
  | { type: 'error'; message: string }
  | { type: 'cancelled' };

export interface GhAuthProps {
  code: string;
  url: string;
  onComplete: (status: GhAuthStatus) => void;
}

export function GhAuth({ code, url, onComplete }: GhAuthProps) {
  const count = useRef(0);
  const [dots, setDots] = useState('');

  useKeyboard((key) => {
    if (key.name === 'escape') {
      onComplete({ type: 'cancelled' });
    }
  });

  useEffect(() => {
    const interval = setInterval(() => {
      count.current += 1;
      setDots('.'.repeat(count.current % 4).padEnd(3, ' '));
    }, 400);
    return () => clearInterval(interval);
  }, []);

  return (
    <Frame title="GitHub Authentication">
      <box flexDirection="column" alignItems="center">
        <text fg="#888">Open this URL in your browser:</text>
        <text fg="#6bf">{url}</text>

        <box height={1} />

        <text fg="#888">And enter this one-time code:</text>
        <text fg="#0f0"> {code} </text>

        <box height={2} />

        <text fg="#888">Waiting for authentication{dots}</text>

        <box height={1} />
        <text fg="#555">Press Esc to cancel</text>
      </box>
    </Frame>
  );
}
