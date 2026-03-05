import type { AgentType } from '../services/config.ts';
import { useReadinessStore } from '../stores/readinessStore.ts';
import { useTheme } from '../stores/themeStore.ts';
import { Dots } from './Dots.tsx';

export interface ReadinessStatusProps {
  /** Currently selected agent — used to highlight relevant auth warnings */
  agent?: AgentType;
}

/**
 * Status row that displays readiness check progress on the prompt screen.
 * Shows the highest-priority active status. Renders nothing when all checks
 * are complete and successful.
 */
function ReadinessStatusInner({ agent }: ReadinessStatusProps) {
  const { theme } = useTheme();
  const dockerRunning = useReadinessStore((s) => s.dockerRunning);
  const sandboxImage = useReadinessStore((s) => s.sandboxImage);
  const pullLayers = useReadinessStore((s) => s.pullLayers);
  const claudeAuth = useReadinessStore((s) => s.claudeAuth);
  const opencodeAuth = useReadinessStore((s) => s.opencodeAuth);
  const ghAuth = useReadinessStore((s) => s.ghAuth);
  const error = useReadinessStore((s) => s.error);

  // Error state
  if (error && (dockerRunning === 'not-running' || sandboxImage === 'error')) {
    return (
      <text fg={theme.error}>
        {'\u2717 '} {error}
      </text>
    );
  }

  // Docker starting
  if (dockerRunning === 'starting' || dockerRunning === 'checking') {
    return (
      <text fg={theme.warning}>
        {'\u27F3 '} Starting Docker
        <Dots />
      </text>
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
      <text fg={theme.warning}>
        {'\u27F3 '} Pulling sandbox image{suffix}
        <Dots />
      </text>
    );
  }

  // Image checking
  if (sandboxImage === 'checking') {
    return (
      <text fg={theme.textMuted}>
        {'\u27F3 '} Checking sandbox image
        <Dots />
      </text>
    );
  }

  // Credential checking (in progress)
  const agentAuth = agent === 'claude' ? claudeAuth : opencodeAuth;
  if (agentAuth === 'checking' || ghAuth === 'checking') {
    return (
      <text fg={theme.textMuted}>
        {'\u27F3 '} Checking credentials
        <Dots />
      </text>
    );
  }

  // Credential warnings (invalid auth — deferred to submit)
  const warnings: string[] = [];
  if (ghAuth === 'invalid') {
    warnings.push('GitHub auth needed');
  }
  if (agentAuth === 'invalid') {
    const agentName = agent === 'claude' ? 'Claude' : 'OpenCode';
    warnings.push(`${agentName} auth needed`);
  }
  if (warnings.length > 0) {
    return (
      <text fg={theme.warning}>
        {'\u26A0 '} {warnings.join(' \u2022 ')} (will prompt on submit)
      </text>
    );
  }

  // All clear — render nothing
  return null;
}

export function ReadinessStatus({ agent }: ReadinessStatusProps) {
  return (
    <box height={1} paddingLeft={1} paddingRight={1}>
      <ReadinessStatusInner agent={agent} />
    </box>
  );
}
