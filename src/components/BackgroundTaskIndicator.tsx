import { useBackgroundTaskStore } from '../stores/backgroundTaskStore';
import { useTheme } from '../stores/themeStore';
import { Dots } from './Dots';

export function BackgroundTaskIndicator() {
  const pendingCount = useBackgroundTaskStore((s) => s.pendingCount);
  const { theme } = useTheme();

  if (pendingCount === 0) return null;

  const label = pendingCount === 1 ? '1 task' : `${pendingCount} tasks`;

  return (
    <box
      position="absolute"
      bottom={1}
      left={2}
      backgroundColor={theme.backgroundPanel}
    >
      <text fg={theme.textMuted}>
        <span fg={theme.primary}>⟳</span> {label}
        <Dots />
      </text>
    </box>
  );
}
