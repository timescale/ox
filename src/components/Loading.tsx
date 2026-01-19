import { useKeyboard } from '@opentui/react';
import { useEffect, useState } from 'react';

export interface LoadingProps {
  title?: string;
  message?: string;
  onCancel: () => void;
}

export function Loading({
  title = 'Loading',
  message = 'Please wait...',
  onCancel,
}: LoadingProps) {
  const [dots, setDots] = useState('');

  useKeyboard((key) => {
    if (key.name === 'escape') {
      onCancel();
    }
  });

  useEffect(() => {
    const interval = setInterval(() => {
      setDots((d) => (d.length >= 3 ? '' : `${d}.`));
    }, 300);
    return () => clearInterval(interval);
  }, []);

  return (
    <box style={{ flexDirection: 'column', padding: 1, flexGrow: 1 }}>
      <box
        title={title}
        style={{
          border: true,
          borderStyle: 'single',
          padding: 1,
          flexDirection: 'column',
          flexGrow: 1,
        }}
      >
        <text>Loading{dots}</text>
        <text style={{ fg: '#888888', marginTop: 1 }}>{message}</text>
        <text style={{ fg: '#555555', marginTop: 1 }}>Press Esc to cancel</text>
      </box>
    </box>
  );
}
