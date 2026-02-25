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
  bottom = 1,
  left = 2,
  top,
  right,
}: BackgroundTaskIndicatorProps = {}) {
  const pendingCount = useBackgroundTaskStore((s) => s.pendingCount);
  const { theme } = useTheme();

  if (pendingCount === 0) return null;

  const label = pendingCount === 1 ? '1 task' : `${pendingCount} tasks`;

  return (
    <box
      position="absolute"
      bottom={bottom}
      left={left}
      top={top}
      right={right}
      backgroundColor={theme.backgroundPanel}
    >
      <text fg={theme.textMuted}>
        <span fg={theme.primary}>⟳</span> {label}
        <Dots />
      </text>
    </box>
  );
}
