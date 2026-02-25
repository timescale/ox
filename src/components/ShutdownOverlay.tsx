import { TextAttributes } from '@opentui/core';
import { useBackgroundTaskStore } from '../stores/backgroundTaskStore';
import { useTheme } from '../stores/themeStore';
import { Dots } from './Dots';

export function ShutdownOverlay() {
  const shuttingDown = useBackgroundTaskStore((s) => s.shuttingDown);
  const tasks = useBackgroundTaskStore((s) => s.tasks);
  const pendingCount = useBackgroundTaskStore((s) => s.pendingCount);
  const { theme } = useTheme();

  if (!shuttingDown || pendingCount === 0) return null;

  const activeTasks = tasks.filter(
    (t) => t.status === 'running' || t.status === 'pending',
  );

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      backgroundColor={theme.backgroundPanel}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      gap={1}
    >
      <text fg={theme.warning} attributes={TextAttributes.BOLD}>
        Waiting for {pendingCount} background{' '}
        {pendingCount === 1 ? 'task' : 'tasks'} to complete
        <Dots />
      </text>

      <box flexDirection="column" padding={1}>
        {activeTasks.map((task) => (
          <text key={task.id} fg={theme.text}>
            ⟳ {task.label}
          </text>
        ))}
      </box>

      <text fg={theme.textMuted}>Press Ctrl+C again to force quit</text>
    </box>
  );
}
