import { useBackgroundTaskStore } from '../stores/backgroundTaskStore';
import { useTheme } from '../stores/themeStore';
import { Dots } from './Dots';

export interface BackgroundTaskIndicatorProps {
  bottom?: number;
  left?: number;
  top?: number;
  right?: number;
}

export function BackgroundTaskIndicator({
  bottom,
  left,
  top,
  right,
}: BackgroundTaskIndicatorProps = {}) {
  const pendingCount = useBackgroundTaskStore((s) => s.pendingCount);
  const { theme } = useTheme();

  if (pendingCount === 0) return null;

  if (bottom == null && top == null) {
    top = 1;
  }
  if (left == null && right == null) {
    left = 2;
    right = 2;
  }

  const label = pendingCount === 1 ? '1 task' : `${pendingCount} tasks`;

  return (
    <box
      position="absolute"
      bottom={bottom}
      left={left}
      top={top}
      right={right}
      flexDirection="row"
      justifyContent="center"
      alignItems="center"
    >
      <text fg={theme.textMuted} bg={theme.background}>
        <span fg={theme.primary}> ⟳ </span> {label}
        <Dots />{' '}
      </text>
    </box>
  );
}
