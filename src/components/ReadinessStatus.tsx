import { useKeyboard } from '@opentui/react';
import type { AgentType } from '../services/config.ts';
import { useReadinessStore } from '../stores/readinessStore.ts';
import { useRouterStore } from '../stores/routerStore.ts';
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
  const sandboxBaseImage = useReadinessStore((s) => s.sandboxBaseImage);
  const basePullLayers = useReadinessStore((s) => s.basePullLayers);
  const sandboxAgentImage = useReadinessStore((s) => s.sandboxAgentImage);
  const agentImageAgent = useReadinessStore((s) => s.agentImageAgent);
  const agentBuildMessage = useReadinessStore((s) => s.agentBuildMessage);
  const agentBuildDetail = useReadinessStore((s) => s.agentBuildDetail);
  const claudeAuth = useReadinessStore((s) => s.claudeAuth);
  const opencodeAuth = useReadinessStore((s) => s.opencodeAuth);
  const codexAuth = useReadinessStore((s) => s.codexAuth);
  const ghAuth = useReadinessStore((s) => s.ghAuth);
  const error = useReadinessStore((s) => s.error);
  const errorOutputLines = useReadinessStore((s) => s.errorOutputLines);

  const hasErrorDetails = error && errorOutputLines.length > 0;

  // Navigate to build error view when Enter is pressed on an error with details
  useKeyboard((key) => {
    if (hasErrorDetails && key.name === 'return') {
      useRouterStore
        .getState()
        .goToBuildError('Build Failed', error, errorOutputLines);
    }
  });

  // Error state
  if (
    error &&
    (dockerRunning === 'not-running' ||
      sandboxBaseImage === 'error' ||
      sandboxAgentImage === 'error')
  ) {
    // Truncate to first line — full details available via "Press Enter"
    const firstLine = error.split('\n')[0] ?? error;
    return (
      <box flexDirection="column">
        <text fg={theme.error}>
          {'\u2717 '} {firstLine}
        </text>
        {hasErrorDetails ? (
          <text fg={theme.textMuted}>
            {'  '} Press Enter to view build output
          </text>
        ) : null}
      </box>
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

  // Base image pulling
  if (sandboxBaseImage === 'pulling') {
    const done = basePullLayers.filter(
      (l) => l.state === 'complete' || l.state === 'exists',
    ).length;
    const total = basePullLayers.length;
    const suffix = total > 0 ? ` (${done}/${total} layers)` : '';
    return (
      <text fg={theme.warning}>
        {'\u27F3 '} Pulling sandbox image{suffix}
        <Dots />
      </text>
    );
  }

  // Base image checking
  if (sandboxBaseImage === 'checking') {
    return (
      <text fg={theme.textMuted}>
        {'\u27F3 '} Checking sandbox image
        <Dots />
      </text>
    );
  }

  // Agent image building
  if (sandboxAgentImage === 'building') {
    const agentName = agentImageAgent ?? 'agent';
    const message = agentBuildMessage ?? `Building ${agentName} agent image`;
    return (
      <box flexDirection="column">
        <text fg={theme.warning}>
          {'\u27F3 '} {message}
          <Dots />
        </text>
        {agentBuildDetail ? (
          <text fg={theme.textMuted} overflow="hidden" wrapMode="none">
            {'  \u2502 '}
            {agentBuildDetail}
          </text>
        ) : null}
      </box>
    );
  }

  // Agent image checking
  if (sandboxAgentImage === 'checking') {
    return (
      <text fg={theme.textMuted}>
        {'\u27F3 '} Checking agent image
        <Dots />
      </text>
    );
  }

  // Credential checking (in progress)
  const agentAuth =
    agent === 'claude'
      ? claudeAuth
      : agent === 'codex'
        ? codexAuth
        : opencodeAuth;
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
    const agentName =
      agent === 'claude' ? 'Claude' : agent === 'codex' ? 'Codex' : 'OpenCode';
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
  const error = useReadinessStore((s) => s.error);
  const errorOutputLines = useReadinessStore((s) => s.errorOutputLines);
  const sandboxAgentImage = useReadinessStore((s) => s.sandboxAgentImage);
  const sandboxBaseImage = useReadinessStore((s) => s.sandboxBaseImage);
  const dockerRunning = useReadinessStore((s) => s.dockerRunning);

  // Need an extra row when showing "Press Enter to view build output" hint
  const hasErrorWithDetails =
    error &&
    errorOutputLines.length > 0 &&
    (dockerRunning === 'not-running' ||
      sandboxBaseImage === 'error' ||
      sandboxAgentImage === 'error');
  const height = hasErrorWithDetails ? 3 : 2;

  return (
    <box height={height} paddingLeft={1} paddingRight={1} overflow="hidden">
      <ReadinessStatusInner agent={agent} />
    </box>
  );
}
