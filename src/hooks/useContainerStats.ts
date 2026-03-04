import { useEffect, useState } from 'react';
import { log } from '../services/logger';
import type { SandboxStats } from '../services/sandbox';

/** Polling interval for container stats (1 second) */
const STATS_POLL_INTERVAL = 1000;

/**
 * Hook that polls sandbox stats every second for the given running session IDs.
 * Returns a Map<sessionId, SandboxStats>.
 * Only fetches when there are running session IDs and a getStats function provided.
 *
 * Important: callers must pass a stable (memoized) array reference to avoid
 * restarting the polling interval on every render.
 *
 * @param getStats - Callback that fetches stats. Receives the container IDs and
 *   an AbortSignal that is aborted when the effect cleans up, so in-flight
 *   `docker stats` subprocesses are killed promptly on unmount.
 */
export function useContainerStats(
  containerIds: string[],
  getStats?: (
    ids: string[],
    signal: AbortSignal,
  ) => Promise<Map<string, SandboxStats>>,
): Map<string, SandboxStats> {
  const [stats, setStats] = useState<Map<string, SandboxStats>>(
    () => new Map(),
  );

  useEffect(() => {
    if (containerIds.length === 0 || !getStats) {
      setStats(new Map());
      return;
    }

    log.debug({ containerIds }, 'Starting container stats polling');
    const controller = new AbortController();

    const fetchStats = async () => {
      if (controller.signal.aborted) return;
      const result = await getStats(containerIds, controller.signal);
      if (!controller.signal.aborted) {
        log.trace(
          { statsCount: result.size, containerCount: containerIds.length },
          'Container stats update',
        );
        setStats(result);
      }
    };

    // Fetch immediately, then poll
    fetchStats();
    const interval = setInterval(fetchStats, STATS_POLL_INTERVAL);

    return () => {
      log.debug('Stopping container stats polling');
      clearInterval(interval);
      controller.abort();
    };
  }, [containerIds, getStats]);

  return stats;
}
