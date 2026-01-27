import { useEffect } from 'react';

export type ToastType = 'error' | 'success' | 'info';

export interface ToastProps {
  message: string;
  type: ToastType;
  duration?: number;
  onDismiss: () => void;
}

const COLORS: Record<ToastType, string> = {
  error: '#ff6b6b',
  success: '#51cf66',
  info: '#888888',
};

const ICONS: Record<ToastType, string> = {
  error: '✗',
  success: '✓',
  info: '●',
};

export function Toast({
  message,
  type,
  duration = 3000,
  onDismiss,
}: ToastProps) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, duration);
    return () => clearTimeout(timer);
  }, [duration, onDismiss]);

  const color = COLORS[type];
  const icon = ICONS[type];

  return (
    <box
      position="absolute"
      bottom={1}
      right={1}
      border
      borderStyle="single"
      padding={1}
      paddingLeft={2}
      paddingRight={2}
    >
      <text>
        <span fg={color}>{icon}</span> {message}
      </text>
    </box>
  );
}
