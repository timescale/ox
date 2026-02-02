import { useEffect } from 'react';
import type { ThemeColors } from '../services/theme.ts';
import { useTheme } from '../stores/themeStore.ts';

export type ToastType = 'error' | 'success' | 'info' | 'warning';

export interface ToastProps {
  message: string;
  type: ToastType;
  duration?: number;
  onDismiss: () => void;
}

function getColor(type: ToastType, theme: ThemeColors): string {
  switch (type) {
    case 'error':
      return theme.error;
    case 'success':
      return theme.success;
    case 'warning':
      return theme.warning;
    case 'info':
      return theme.textMuted;
  }
}

const ICONS: Record<ToastType, string> = {
  error: '\u2717',
  success: '\u2713',
  warning: '\u26a0',
  info: '\u25cf',
};

export function Toast({
  message,
  type,
  duration = 3000,
  onDismiss,
}: ToastProps) {
  const { theme } = useTheme();

  useEffect(() => {
    const timer = setTimeout(onDismiss, duration);
    return () => clearTimeout(timer);
  }, [duration, onDismiss]);

  const color = getColor(type, theme);
  const icon = ICONS[type];

  return (
    <box
      position="absolute"
      bottom={1}
      right={1}
      border
      borderStyle="single"
      borderColor={theme.border}
      backgroundColor={theme.backgroundPanel}
      padding={1}
      paddingLeft={2}
      paddingRight={2}
    >
      <text fg={theme.text}>
        <span fg={color}>{icon}</span> {message}
      </text>
    </box>
  );
}
