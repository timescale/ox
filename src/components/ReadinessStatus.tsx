import { useReadinessStore } from '../stores/readinessStore.ts';
import { useTheme } from '../stores/themeStore.ts';
import { Dots } from './Dots.tsx';

/**
 * Status row that displays readiness check progress on the prompt screen.
 * Shows the highest-priority active status. Renders nothing when all checks
 * are complete and successful.
 */
export function ReadinessStatus() {
  const { theme } = useTheme();
  const dockerRunning = useReadinessStore((s) => s.dockerRunning);
  const sandboxImage = useReadinessStore((s) => s.sandboxImage);
  const pullLayers = useReadinessStore((s) => s.pullLayers);
  const error = useReadinessStore((s) => s.error);

  // Error state
  if (error && (dockerRunning === 'not-running' || sandboxImage === 'error')) {
    return (
      <box height={1}>
        <text fg={theme.error}>
          {'\u2717'} {error}
        </text>
      </box>
    );
  }

  // Docker starting
  if (dockerRunning === 'starting' || dockerRunning === 'checking') {
    return (
      <box height={1}>
        <text fg={theme.warning}>
          {'\u27F3'} Starting Docker
          <Dots />
        </text>
      </box>
    );
  }

  // Image pulling
  if (sandboxImage === 'pulling') {
    const done = pullLayers.filter(
      (l) => l.state === 'complete' || l.state === 'exists',
    ).length;
    const total = pullLayers.length;
    const suffix = total > 0 ? ` (${done}/${total} layers)` : '';
    return (
      <box height={1}>
        <text fg={theme.warning}>
          {'\u27F3'} Pulling sandbox image{suffix}
          <Dots />
        </text>
      </box>
    );
  }

  // Image checking
  if (sandboxImage === 'checking') {
    return (
      <box height={1}>
        <text fg={theme.textMuted}>
          {'\u27F3'} Checking sandbox image
          <Dots />
        </text>
      </box>
    );
  }

  // All clear — render nothing
  return null;
}
