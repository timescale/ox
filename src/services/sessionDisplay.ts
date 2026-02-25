import { getSandboxProvider } from './sandbox/index.ts';
import type { HermesSession, SandboxStats } from './sandbox/types.ts';

export function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) {
    return `${diffDays}d ago`;
  }
  if (diffHours > 0) {
    return `${diffHours}h ago`;
  }
  if (diffMins > 0) {
    return `${diffMins}m ago`;
  }
  return 'just now';
}

export function getStatusIcon(session: HermesSession): string {
  switch (session.status) {
    case 'running':
      return '●';
    case 'exited':
      return session.exitCode === 0 ? '✓' : '✗';
    case 'stopped':
      return '⏸';
    case 'unknown':
      return '○';
    default:
      return '○';
  }
}

export function getStatusText(session: HermesSession): string {
  if (session.status === 'exited') {
    if (session.exitCode === 0) return 'complete';
    if (session.exitCode == null) return 'exited';
    return `failed (${session.exitCode})`;
  }
  return session.status;
}

export function getStatusColor(session: HermesSession): string {
  switch (session.status) {
    case 'running':
      return 'green';
    case 'exited':
      return session.exitCode === 0 ? 'blue' : 'red';
    case 'stopped':
      return 'yellow';
    case 'unknown':
      return 'gray';
    default:
      return 'gray';
  }
}

/**
 * Fetch sandbox stats for the given session IDs, filtering to only Docker sessions.
 * This is a shared utility used by components that need container CPU/memory stats.
 *
 * @param ids - Session IDs to fetch stats for
 * @param sessions - Full session list used to filter to running Docker sessions.
 *   When omitted the ids are assumed to already be running Docker container IDs.
 */
export async function fetchDockerStats(
  ids: string[],
  sessions?: HermesSession[],
): Promise<Map<string, SandboxStats>> {
  const dockerIds = sessions
    ? ids.filter((id) =>
        sessions.some(
          (s) =>
            s.id === id && s.provider === 'docker' && s.status === 'running',
        ),
      )
    : ids;

  if (dockerIds.length === 0) {
    return new Map();
  }

  const dockerProvider = getSandboxProvider('docker');
  if (!dockerProvider.getStats) {
    return new Map();
  }

  return dockerProvider.getStats(dockerIds);
}

/** Format a byte count as a compact human-readable string (e.g. 1.2G, 456M). */
export function formatSize(bytes?: number): string {
  if (bytes == null) return '-';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)}K`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)}M`;
  return `${(bytes / 1024 ** 3).toFixed(1)}G`;
}
