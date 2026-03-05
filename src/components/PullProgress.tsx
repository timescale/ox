import { useKeyboard } from '@opentui/react';
import type { PullLayer } from '../services/docker';
import { useTheme } from '../stores/themeStore';
import { Dots } from './Dots';

export interface PullProgressProps {
  title?: string;
  message: string;
  layers: PullLayer[];
  onCancel?: () => void;
}

const BAR_WIDTH = 24;

function renderBar(done: number, total: number): string {
  if (total === 0) return '';
  const filled = Math.round((done / total) * BAR_WIDTH);
  return (
    '[' + '\u2588'.repeat(filled) + '\u2591'.repeat(BAR_WIDTH - filled) + ']'
  );
}

export function PullProgress({
  title,
  message,
  layers,
  onCancel,
}: PullProgressProps) {
  const { theme } = useTheme();

  useKeyboard((key) => {
    if (onCancel && key.name === 'escape') {
      onCancel();
    }
  });

  const done = layers.filter(
    (l) => l.state === 'complete' || l.state === 'exists',
  ).length;
  const total = layers.length;
  const bar = renderBar(done, total);

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
      {total > 0 ? (
        <text fg={theme.secondary} marginTop={1}>
          {bar}
          {'  '}
          {done} / {total} layers
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
