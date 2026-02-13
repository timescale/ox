import { useEffect, useMemo, useRef, useState } from 'react';
import { type ContainerStats, getContainerStats } from '../services/docker';

/** Polling interval for container stats (1 second) */
const STATS_POLL_INTERVAL = 1000;

/**
 * Hook that polls `docker stats` every second for the given running container IDs.
 * Returns a Map<containerId, ContainerStats>.
 * Only fetches when there are running container IDs provided.
 */
export function useContainerStats(
  containerIds: string[],
): Map<string, ContainerStats> {
  const [stats, setStats] = useState<Map<string, ContainerStats>>(
    () => new Map(),
  );

  // Stable key that changes only when the set of IDs changes
  const idsKey = useMemo(
    () => containerIds.slice().sort().join(','),
    [containerIds],
  );

  // Keep a stable reference to the latest IDs to avoid stale closures
  const idsRef = useRef(containerIds);
  idsRef.current = containerIds;

  useEffect(() => {
    if (idsKey === '') {
      setStats(new Map());
      return;
    }

    let cancelled = false;

    const fetchStats = async () => {
      if (cancelled) return;
      const ids = idsRef.current;
      if (ids.length === 0) return;
      const result = await getContainerStats(ids);
      if (!cancelled) {
        setStats(result);
      }
    };

    // Fetch immediately, then poll
    fetchStats();
    const interval = setInterval(fetchStats, STATS_POLL_INTERVAL);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [idsKey]);

  return stats;
}
