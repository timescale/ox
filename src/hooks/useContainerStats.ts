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
 */
export function useContainerStats(
  containerIds: string[],
  getStats?: (ids: string[]) => Promise<Map<string, SandboxStats>>,
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
    let cancelled = false;

    const fetchStats = async () => {
      if (cancelled) return;
      const result = await getStats(containerIds);
      if (!cancelled) {
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
      cancelled = true;
      clearInterval(interval);
    };
  }, [containerIds, getStats]);

  return stats;
}
