import { useEffect } from 'react';
import { useTheme } from '../stores/themeStore.ts';

export type ToastType = 'error' | 'success' | 'info' | 'warning';

export interface ToastProps {
  message: string;
  type: ToastType;
  duration?: number;
  onDismiss: () => void;
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

  const color =
    {
      error: theme.error,
      success: theme.success,
      warning: theme.warning,
      info: theme.primary,
    }[type] || theme.textMuted;

  const icon = ICONS[type];

  return (
    <box
      position="absolute"
      bottom={2}
      right={2}
      backgroundColor={theme.backgroundPanel}
      padding={1}
      paddingLeft={2}
      paddingRight={2}
      marginLeft={1}
      overflow="hidden"
    >
      <text fg={theme.text} wrapMode="word">
        <span fg={color}>{icon}</span> {message}
      </text>
    </box>
  );
}
