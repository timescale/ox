import { useKeyboard } from '@opentui/react';
import { useTheme } from '../stores/themeStore';
import { Dots } from './Dots';

export interface LoadingProps {
  title?: string;
  message?: string;
  detail?: string;
  hint?: string;
  onCancel?: () => void;
}

export function Loading({
  title,
  message = 'Please wait',
  detail,
  hint,
  onCancel,
}: LoadingProps) {
  const { theme } = useTheme();
  useKeyboard((key) => {
    if (onCancel && key.name === 'escape') {
      onCancel();
    }
  });

  return (
    <box
      title={title}
      border={!!title}
      borderStyle={title ? 'single' : undefined}
      padding={1}
      flexDirection="column"
      flexGrow={1}
      alignItems="center"
      justifyContent="center"
    >
      <text fg={theme.primary}>
        {message}
        <Dots />
      </text>
      {detail ? (
        <text fg={theme.secondary} marginTop={1}>
          {detail}
        </text>
      ) : null}
      {hint ? (
        <text fg={theme.textMuted} marginTop={1}>
          {hint}
        </text>
      ) : null}
      {onCancel ? (
        <text fg={theme.textMuted} marginTop={1}>
          Press Esc to cancel
        </text>
      ) : null}
    </box>
  );
}
