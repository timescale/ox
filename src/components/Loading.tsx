import { useKeyboard } from '@opentui/react';
import { useEffect, useRef, useState } from 'react';

export interface LoadingProps {
  title?: string;
  message?: string;
  detail?: string;
  onCancel: () => void;
}

export function Loading({
  title = 'Loading',
  message = 'Please wait',
  detail,
  onCancel,
}: LoadingProps) {
  const count = useRef(0);
  const [dots, setDots] = useState('');

  useKeyboard((key) => {
    if (key.name === 'escape') {
      onCancel();
    }
  });

  useEffect(() => {
    const interval = setInterval(() => {
      count.current += 1;
      setDots('.'.repeat(count.current % 4).padEnd(3, ' '));
    }, 300);
    return () => clearInterval(interval);
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
        alignItems="center"
        justifyContent="center"
      >
        <text fg="#eee">
          {message}
          {dots}
        </text>
        {detail && (
          <text fg="#888" marginTop={1}>
            {detail}
          </text>
        )}
        <text fg="#555" marginTop={1}>
          Press Esc to cancel
        </text>
      </box>
    </box>
  );
}
