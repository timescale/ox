import type { ScrollBoxRenderable } from '@opentui/core';
import { flushSync, useKeyboard } from '@opentui/react';
import fuzzysort from 'fuzzysort';
import open from 'open';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useContainerStats } from '../hooks/useContainerStats';
import { usePollingInterval } from '../hooks/usePollingInterval';
import { useWindowSize } from '../hooks/useWindowSize';
import { useCommandStore, useRegisterCommands } from '../services/commands.tsx';
import { formatCpuPercent, formatMemUsage } from '../services/docker';
import { getPrForBranch } from '../services/github';
import { log } from '../services/logger';
import {
  getProviderForSession,
  listAllSessions,
  type OxSession,
} from '../services/sandbox';
import {
  fetchDockerStats,
  formatRelativeTime,
  getStatusIcon,
  getStatusText,
} from '../services/sessionDisplay';
import { useBackgroundTaskStore } from '../stores/backgroundTaskStore';
import { useSessionStore } from '../stores/sessionStore';
import { useTheme } from '../stores/themeStore';
import { useToastStore } from '../stores/toastStore';
import { formatShellError, type ShellError } from '../utils/shell.ts';
import { ActionButton } from './ActionButton.tsx';
import { ConfirmModal } from './ConfirmModal';
import { SessionDetailPanel } from './SessionDetailPanel.tsx';

/** Cache TTL in milliseconds (60 seconds) */
const PR_CACHE_TTL = 60_000;

export type FilterMode = 'all' | 'running' | 'completed';
export type ScopeMode = 'local' | 'global';

export interface SessionsListProps {
  onSelect: (session: OxSession) => void;
  onQuit: () => void;
  onNewTask?: () => void;
  onAttach?: (session: OxSession) => void;
  onShell?: (session: OxSession) => void;
  onResume?: (session: OxSession) => void;
  onResources?: () => void;
  /** Current repo fullName (e.g., "owner/repo") if in a git repo, undefined otherwise */
  currentRepo?: string;
}

const FILTER_LABELS: Record<FilterMode, string> = {
  all: 'All',
  running: 'Running',
  completed: 'Completed',
};

const FILTER_ORDER: FilterMode[] = ['all', 'running', 'completed'];

const SCOPE_LABELS: Record<ScopeMode, string> = {
  local: 'Local',
  global: 'Global',
};

const SCOPE_ORDER: ScopeMode[] = ['local', 'global'];

export function SessionsList({
  onSelect,
  onQuit,
  onNewTask,
  onAttach,
  onShell,
  onResume,
  onResources,
  currentRepo,
}: SessionsListProps) {
  const { theme } = useTheme();
  const { rows, columns } = useWindowSize();
  const isBig = rows >= 30 && columns >= 61;
  const {
    selectedSessionId,
    setSelectedSessionId,
    prCache,
    setPrInfo,
    clearPrCache,
    addPendingDelete,
    removePendingDelete,
  } = useSessionStore();
  const [sessions, setSessions] = useState<OxSession[]>([]);
  // Ref to hold the latest sessions list so callbacks/effects can read it
  // without depending on the array reference (which changes on every poll).
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const [loading, setLoading] = useState(true);
  const [filterText, setFilterText] = useState('');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  // Default to 'local' if in a repo, otherwise 'global'
  const [scopeMode, setScopeMode] = useState<ScopeMode>(
    currentRepo ? 'local' : 'global',
  );
  const [deleteModal, setDeleteModal] = useState<OxSession | null>(null);
  const [stopModal, setStopModal] = useState<OxSession | null>(null);
  const [actionInProgress, setActionInProgress] = useState(false);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const scrollboxRef = useRef<ScrollBoxRenderable | null>(null);

  // Poll CPU/memory stats for running containers.
  // Stabilize `runningIds` so it only gets a new reference when the actual set
  // of running container IDs changes — not on every poll cycle that returns the
  // same sessions with a new array reference.
  const runningIdsKey = useMemo(
    () =>
      sessions
        .filter((s) => s.status === 'running')
        .map((s) => s.id)
        .join(','),
    [sessions],
  );
  const runningIds = useMemo(
    () => (runningIdsKey ? runningIdsKey.split(',') : []),
    [runningIdsKey],
  );
  // Use sessionsRef so the callback identity is stable across polls.
  const getStats = useCallback(
    (ids: string[], signal: AbortSignal) =>
      fetchDockerStats(ids, sessionsRef.current, signal),
    [],
  );
  const containerStats = useContainerStats(runningIds, getStats);

  // Filter sessions: first by scope/mode, then fuzzy text search
  const filteredSessions = useMemo(() => {
    // Pre-filter by scope and mode (boolean filters)
    const preFiltered = sessions.filter((session) => {
      if (
        currentRepo &&
        scopeMode === 'local' &&
        session.repo !== currentRepo
      ) {
        return false;
      }
      if (filterMode === 'running' && session.status !== 'running') {
        return false;
      }
      if (filterMode === 'completed' && session.status === 'running') {
        return false;
      }
      return true;
    });

    // Fuzzy text search via fuzzysort (replaces String.includes)
    if (!filterText) return preFiltered;
    return fuzzysort
      .go(filterText, preFiltered, {
        keys: ['name', 'branch', 'repo', 'prompt'],
        scoreFn: (r) =>
          Math.max(
            r[0]?.score ?? 0, // name (full weight)
            r[3]?.score ?? 0, // prompt (full weight)
            (r[1]?.score ?? 0) * 0.5, // branch (reduced)
            (r[2]?.score ?? 0) * 0.5, // repo (reduced)
          ),
        threshold: 0.3,
      })
      .map((r) => r.obj);
  }, [filterText, filterMode, scopeMode, sessions, currentRepo]);

  // Compute selected index from session ID
  // If the selected session is in the filtered list, use its index
  // Otherwise, fall back to 0 (first item)
  const selectedIndex = useMemo(() => {
    if (selectedSessionId) {
      const index = filteredSessions.findIndex(
        (s) => s.id === selectedSessionId,
      );
      if (index >= 0) return index;
    }
    return 0;
  }, [filteredSessions, selectedSessionId]);

  // The currently highlighted session (for split-view detail panel)
  const selectedSession = filteredSessions[selectedIndex];

  // Helper to select by index (updates the store with session ID)
  const selectByIndex = useCallback(
    (index: number) => {
      const session = filteredSessions[index];
      if (session) {
        setSelectedSessionId(session.id);
      }
    },
    [filteredSessions, setSelectedSessionId],
  );

  // Load sessions
  const loadSessions = useCallback(async () => {
    try {
      const loaded = await listAllSessions();
      const { pendingDeletes } = useSessionStore.getState();
      setSessions(loaded.filter((s) => !pendingDeletes.has(s.id)));
    } catch (err) {
      log.error({ err }, 'Failed to load sessions');
      useToastStore.getState().show(`Failed to load sessions: ${err}`, 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  // Mouse handlers for session rows
  const handleRowClick = useCallback(
    (session: OxSession) => {
      onSelect(session);
    },
    [onSelect],
  );

  const handleRowHover = useCallback((index: number) => {
    setHoveredIndex(index);
  }, []);

  const handleMouseOut = useCallback(() => {
    setHoveredIndex(null);
  }, []);

  // Clickable filter/scope toggle handlers
  const cycleFilter = useCallback(() => {
    const currentIdx = FILTER_ORDER.indexOf(filterMode);
    const nextIdx = (currentIdx + 1) % FILTER_ORDER.length;
    const nextMode = FILTER_ORDER[nextIdx];
    if (nextMode) setFilterMode(nextMode);
  }, [filterMode]);

  const toggleScope = useCallback(() => {
    const currentIdx = SCOPE_ORDER.indexOf(scopeMode);
    const nextIdx = (currentIdx + 1) % SCOPE_ORDER.length;
    const nextScope = SCOPE_ORDER[nextIdx];
    if (nextScope) setScopeMode(nextScope);
  }, [scopeMode]);

  // Delete session handler
  const handleDelete = useCallback(() => {
    if (!deleteModal) return;
    const session = deleteModal;

    // Determine next selection
    const deleteIndex = filteredSessions.findIndex((s) => s.id === session.id);
    const nextSession =
      filteredSessions[deleteIndex + 1] ?? filteredSessions[deleteIndex - 1];
    const nextSessionId = nextSession?.id ?? null;

    setDeleteModal(null);

    // Mark as pending delete (Layer 1: immediate in-memory hide)
    addPendingDelete(session.id);

    // Immediately remove session from local state
    setSessions((prev) => prev.filter((s) => s.id !== session.id));
    setSelectedSessionId(nextSessionId);

    useToastStore.getState().show('Session deleted', 'success');

    // Enqueue background deletion
    useBackgroundTaskStore
      .getState()
      .enqueue(`Deleting "${session.name}"`, async () => {
        try {
          await getProviderForSession(session).remove(session.id);
        } finally {
          removePendingDelete(session.id);
        }
      });
  }, [
    deleteModal,
    filteredSessions,
    setSelectedSessionId,
    addPendingDelete,
    removePendingDelete,
  ]);

  // Poll sessions with exponential backoff — starts fast (100ms) so the list
  // is up-to-date immediately on mount, then backs off to 60s steady-state.
  // rush() is called after actions (e.g. stop) to trigger a fast refresh cycle.
  const { rush: rushSessionsPoll } = usePollingInterval(loadSessions, {
    initialMs: 100,
    maxMs: 10_000,
  });

  // Refs for the latest filtered sessions and selected index so callbacks can
  // read current values at invocation time without depending on the references.
  const filteredSessionsRef = useRef(filteredSessions);
  filteredSessionsRef.current = filteredSessions;
  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;

  // Helper to get the currently selected session (reads from refs).
  const getSelectedSession = useCallback(
    () => filteredSessionsRef.current[selectedIndexRef.current],
    [],
  );

  const handleStop = useCallback(async () => {
    if (!stopModal) return;
    const session = stopModal;
    setStopModal(null);
    setActionInProgress(true);
    useToastStore.getState().show('Stopping container...', 'info');
    try {
      await getProviderForSession(session).stop(session.id);
      useToastStore.getState().show('Container stopped', 'success');
      // Reset polling to fast interval so the status update is reflected quickly
      rushSessionsPoll();
    } catch (err) {
      log.error({ err }, `Failed to stop container ${session.id}`);
      useToastStore.getState().show(`Failed to stop: ${err}`, 'error');
    } finally {
      setActionInProgress(false);
    }
  }, [stopModal, rushSessionsPoll]);

  const handleGitSwitch = useCallback(async () => {
    const session = getSelectedSession();
    if (!session) return;
    const branchName = `ox/${session.branch}`;
    setActionInProgress(true);
    try {
      await Bun.$`git fetch && git switch ${branchName}`.quiet();
      useToastStore
        .getState()
        .show(`Switched to branch ${branchName}`, 'success');
    } catch (err) {
      const formattedError = formatShellError(err as ShellError);
      log.error({ err }, `Failed to switch to branch ${branchName}`);
      useToastStore.getState().show(formattedError.message, 'error');
    } finally {
      setActionInProgress(false);
    }
  }, [getSelectedSession]);

  // Stable key derived from the session list — only changes when sessions are
  // added or removed, NOT on every poll cycle that returns the same set.
  const sessionIds = useMemo(
    () => sessions.map((s) => s.id).join(','),
    [sessions],
  );

  // Fetch PR info for all sessions when the session list changes.
  // An AbortController is used so that in-flight `gh pr list` docker containers
  // are killed on unmount, preventing them from keeping the process alive after
  // the TUI exits.
  useEffect(() => {
    if (!sessionIds) return;
    const controller = new AbortController();
    const now = Date.now();
    const cache = useSessionStore.getState().prCache;
    for (const session of sessionsRef.current) {
      const cached = cache[session.id];
      const isStale = !cached || now - cached.lastChecked > PR_CACHE_TTL;

      if (isStale) {
        getPrForBranch(session.repo, session.branch, controller.signal)
          .then((prInfo) => {
            if (!controller.signal.aborted) {
              setPrInfo(session.id, prInfo);
            }
          })
          .catch((err) => {
            if (!controller.signal.aborted) {
              log.error({ err }, 'Failed to fetch PR info');
            }
          });
      }
    }
    return () => {
      try {
        controller.abort();
      } catch {
        // AbortController.abort() can throw if listeners throw synchronously.
        // Safe to ignore — the abort signal is still marked as aborted.
      }
    };
  }, [sessionIds, setPrInfo]);

  // Keep selected index in bounds (update store if current selection is out of bounds)
  useEffect(() => {
    if (
      filteredSessions.length > 0 &&
      selectedIndex >= filteredSessions.length
    ) {
      selectByIndex(Math.max(0, filteredSessions.length - 1));
    }
  }, [filteredSessions.length, selectedIndex, selectByIndex]);

  // Scroll to keep selection visible
  const scrollToIndex = useCallback((index: number) => {
    if (scrollboxRef.current) {
      const viewportHeight = scrollboxRef.current.viewport?.height ?? 10;
      const itemY = index;
      const targetScrollY = Math.max(0, itemY - Math.floor(viewportHeight / 2));
      scrollboxRef.current.scrollTo({ x: 0, y: targetScrollY });
    }
  }, []);

  // Suspend command keybind dispatch when modals are open
  const suspend = useCommandStore((s) => s.suspend);
  const isOpen = useCommandStore((s) => s.isOpen);
  const showCommands = useCommandStore((s) => s.show);
  useEffect(() => {
    if (deleteModal || stopModal || actionInProgress) {
      return suspend();
    }
  }, [deleteModal, stopModal, actionInProgress, suspend]);

  // Handler for session deleted from the split-view detail panel
  const handlePanelSessionDeleted = useCallback(() => {
    // The panel handles the delete toast and background task.
    // We just need to refresh the list.
    rushSessionsPoll();
  }, [rushSessionsPoll]);

  // Stable primitives derived from the selected session, used as deps for
  // useRegisterCommands so `enabled` flags update when status changes without
  // depending on the full filteredSessions array reference.
  const hasSessions = filteredSessions.length > 0;
  const selectedStatus = selectedSession?.status;

  // Register commands for the command palette
  useRegisterCommands(() => {
    const selected = getSelectedSession();
    const isRunning = selected?.status === 'running';
    const isStopped =
      selected?.status === 'exited' || selected?.status === 'stopped';

    return [
      {
        id: 'session.view',
        title: 'View session details',
        description: 'Open the selected session detail view',
        category: 'Navigation',
        keybind: { key: 'return', display: 'enter' },
        enabled: hasSessions,
        onSelect: () => {
          const s = getSelectedSession();
          if (s) onSelect(s);
        },
      },
      {
        id: 'task.new',
        title: 'New task',
        description: 'Start a new ox session',
        category: 'Navigation',
        keybind: { key: 'n', ctrl: true },
        enabled: !!onNewTask,
        onSelect: () => onNewTask?.(),
      },
      {
        id: 'navigate-resources',
        title: 'Manage Resources',
        description: 'View and manage sandbox images, volumes, and snapshots',
        category: 'Navigation',
        keybind: { key: 'e', ctrl: true, display: 'ctrl+e' },
        enabled: !!onResources,
        onSelect: () => onResources?.(),
      },
      {
        id: 'filter.cycle',
        title: 'Cycle filter',
        description:
          'Cycle between all, running, and completed session filters',
        category: 'View',
        keybind: { key: 'tab', display: 'tab' },
        onSelect: cycleFilter,
      },
      {
        id: 'scope.toggle',
        title: 'Toggle scope',
        description:
          'Switch between local (this repo) and global session views',
        category: 'View',
        keybind: { key: 'tab', shift: true, display: 'shift+tab' },
        enabled: !!currentRepo,
        onSelect: toggleScope,
      },
      {
        id: 'sessions.refresh',
        title: 'Refresh sessions',
        description: 'Reload session list and PR info',
        category: 'Session',
        keybind: { key: 'f2', display: 'f2' },
        onSelect: () => {
          setLoading(true);
          clearPrCache();
          loadSessions().then(() => {
            useToastStore.getState().show('Refreshed', 'info');
          });
        },
      },
      {
        id: 'session.resume',
        title: 'Resume session',
        description: 'Resume the selected session with a new prompt',
        category: 'Session',
        keybind: { key: 'r', ctrl: true },
        enabled: isStopped && !!onResume,
        onSelect: () => {
          const s = getSelectedSession();
          if (s) onResume?.(s);
        },
      },
      {
        id: 'session.attach',
        title: 'Attach',
        description: 'Connect to the selected running container interactively',
        category: 'Session',
        keybind: { key: 'a', ctrl: true },
        enabled: isRunning && !!onAttach,
        onSelect: () => {
          const s = getSelectedSession();
          if (s) onAttach?.(s);
        },
      },
      {
        id: 'session.delete',
        title: 'Delete session',
        description: 'Remove the selected session container',
        category: 'Session',
        keybind: [
          { key: 'delete', display: 'delete' },
          { key: 'd', ctrl: true },
        ],
        enabled: !!selected,
        onSelect: () => {
          const s = getSelectedSession();
          if (s) setDeleteModal(s);
        },
      },
      {
        id: 'session.shell',
        title: 'Shell',
        description: 'Open a bash shell inside the selected container',
        category: 'Session',
        keybind: { key: 's', ctrl: true },
        enabled: isRunning && !!onShell,
        onSelect: () => {
          const s = getSelectedSession();
          if (s) onShell?.(s);
        },
      },
      {
        id: 'session.gitSwitch',
        title: 'Git switch',
        description: "Switch local git branch to the selected session's branch",
        category: 'Session',
        keybind: { key: 'g', ctrl: true },
        enabled: !!selected,
        onSelect: handleGitSwitch,
      },
      {
        id: 'session.stop',
        title: 'Stop session',
        description: 'Stop the selected running container',
        category: 'Session',
        keybind: { key: 'x', ctrl: true },
        enabled: isRunning && !!selected,
        onSelect: () => {
          const s = getSelectedSession();
          if (s) setStopModal(s);
        },
      },
      {
        id: 'session.openPr',
        title: 'View PR',
        description:
          'Open the pull request for the selected session in browser',
        category: 'Session',
        keybind: { key: 'o', ctrl: true },
        onSelect: () => {
          const s = getSelectedSession();
          if (s) {
            const prInfo = useSessionStore.getState().prCache[s.id]?.prInfo;
            if (prInfo) {
              open(prInfo.url)
                .then(() => {
                  useToastStore
                    .getState()
                    .show(`Opening PR #${prInfo.number}...`, 'info', 1000);
                })
                .catch((err: unknown) => {
                  log.debug({ err }, 'Failed to open PR URL in browser');
                  useToastStore
                    .getState()
                    .show('Failed to open PR in browser', 'error');
                });
            } else {
              useToastStore
                .getState()
                .show('No PR found for this session', 'warning');
            }
          }
        },
      },
    ];
    // Dependencies: only include values that affect `enabled`/`hidden` flags or
    // that change the set of commands.  Handlers read dynamic state at invocation
    // time via refs / store.getState() so they don't need to be deps.
  }, [
    onSelect,
    onNewTask,
    onAttach,
    onShell,
    onResume,
    onResources,
    cycleFilter,
    toggleScope,
    currentRepo,
    clearPrCache,
    loadSessions,
    handleGitSwitch,
    hasSessions,
    selectedStatus,
    getSelectedSession,
  ]);

  // Keyboard handling — navigation keys only.
  // Action keybinds are handled by the centralized CommandPaletteHost.
  useKeyboard((key) => {
    // Ignore keyboard input when modal is open or action in progress
    if (deleteModal || stopModal || actionInProgress) return;

    // Escape returns to prompt screen (but not if the command palette is open)
    if (key.name === 'escape') {
      if (!isOpen) {
        onNewTask ? onNewTask() : onQuit();
      }
      return;
    }

    // Don't navigate when the command palette is open
    if (isOpen) return;

    if (key.name === 'up' || (key.name === 'k' && key.ctrl)) {
      const newIndex = Math.max(0, selectedIndex - 1);
      flushSync(() => selectByIndex(newIndex));
      scrollToIndex(newIndex);
      return;
    }

    if (
      key.name === 'down' ||
      (key.name === 'j' && key.ctrl) ||
      key.name === 'linefeed'
    ) {
      const newIndex = Math.min(filteredSessions.length - 1, selectedIndex + 1);
      flushSync(() => selectByIndex(newIndex));
      scrollToIndex(newIndex);
      return;
    }

    if (key.name === 'backspace') {
      setFilterText((prev) => prev.slice(0, -1));
      // Don't reset selection when changing filter text - preserve selection if possible
      return;
    }

    // Printable characters for filter
    if (key.raw && key.raw.length === 1 && key.raw.match(/[a-zA-Z0-9-_./]/)) {
      setFilterText((prev) => prev + key.raw);
      // Don't reset selection when changing filter text - preserve selection if possible
    }
  });

  // Hover states for clickable filter chips
  const [filterHovered, setFilterHovered] = useState(false);
  const [scopeHovered, setScopeHovered] = useState(false);

  if (loading && sessions.length === 0) {
    return (
      <box flexGrow={1} flexDirection="column" padding={1}>
        <text fg={theme.textMuted}>Loading sessions...</text>
      </box>
    );
  }

  const filterLabel = FILTER_LABELS[filterMode];
  const scopeLabel = currentRepo ? SCOPE_LABELS[scopeMode] : null;
  const countText = `${filteredSessions.length} of ${sessions.length}`;

  return (
    <box flexGrow={1} flexDirection="column" padding={1}>
      {/* Filter bar */}
      <box height={1} marginBottom={1} flexDirection="row">
        <text height={1}>
          Filter: <span fg={theme.primary}>{filterText || ''}</span>
          <span fg={theme.textMuted}>█</span>
        </text>
        <box height={1} flexGrow={1} />
        <box height={1} flexDirection="row" gap={1}>
          {scopeLabel && (
            <box
              onMouseDown={toggleScope}
              onMouseOver={() => setScopeHovered(true)}
              onMouseOut={() => setScopeHovered(false)}
            >
              <text fg={scopeHovered ? theme.primary : theme.textMuted}>
                [{scopeLabel}]
              </text>
            </box>
          )}
          <box
            onMouseDown={cycleFilter}
            onMouseOver={() => setFilterHovered(true)}
            onMouseOut={() => setFilterHovered(false)}
          >
            <text fg={filterHovered ? theme.primary : theme.textMuted}>
              [{filterLabel}]
            </text>
          </box>
          <text fg={theme.textMuted}>{countText}</text>
        </box>
      </box>

      {/* Column headers */}
      <box
        height={1}
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
        gap={2}
      >
        <text height={1} width={1} />
        <text height={1} width={1} fg={theme.textMuted}>
          P
        </text>
        <text height={1} flexGrow={3} flexBasis={10} fg={theme.textMuted}>
          NAME
        </text>
        <text height={1} width={8} fg={theme.textMuted}>
          STATUS
        </text>
        <text height={1} width={6} fg={theme.textMuted}>
          CPU
        </text>
        <text height={1} width={7} fg={theme.textMuted}>
          MEM
        </text>
        <text height={1} width={10} fg={theme.textMuted}>
          PR
        </text>
        <text
          height={1}
          flexGrow={1}
          flexShrink={1}
          flexBasis={0}
          fg={theme.textMuted}
        >
          AGENT
        </text>
        <text
          height={1}
          flexGrow={2}
          flexShrink={1}
          flexBasis={0}
          fg={theme.textMuted}
        >
          REPO
        </text>
        <text height={1} width={7} fg={theme.textMuted}>
          CREATED
        </text>
      </box>

      {/* Session list */}
      {filteredSessions.length === 0 ? (
        <box flexGrow={1} alignItems="center" justifyContent="center">
          <text fg={theme.textMuted}>
            {sessions.length === 0
              ? 'No sessions found. Press `ctrl+n` to create one.'
              : 'No sessions match the current filter.'}
          </text>
        </box>
      ) : (
        <scrollbox
          ref={scrollboxRef}
          flexGrow={1}
          flexShrink={1}
          onMouseOut={handleMouseOut}
        >
          {filteredSessions.map((session, index) => {
            const isSelected = index === selectedIndex;
            const isHovered = index === hoveredIndex;
            const statusIcon = getStatusIcon(session);
            const statusColor =
              {
                running: theme.success,
                exited: session.exitCode === 0 ? theme.text : theme.error,
                stopped: theme.warning,
                unknown: theme.textMuted,
              }[session.status] || theme.textMuted;
            const statusText = getStatusText(session);

            // PR info from cache
            const cachedPr = prCache[session.id];
            const prInfo = cachedPr?.prInfo;
            const prText = prInfo
              ? `#${prInfo.number} ${prInfo.state.toLowerCase()}`
              : '-';
            const prColor = prInfo
              ? {
                  OPEN: theme.success,
                  MERGED: theme.accent,
                  CLOSED: theme.textMuted,
                }[prInfo.state]
              : theme.textMuted;

            const agent =
              {
                claude: 'cc',
                opencode: 'oc',
              }[session.agent] || session.agent;
            const modelParts = session.model?.split('/');
            const model = modelParts?.[1] || session.model;
            const agentText = `${agent}/${model}`;
            const timeText = session.created
              ? formatRelativeTime(session.created)
              : '';

            // Provider badge
            const providerBadge = session.provider === 'cloud' ? 'C' : 'D';
            const providerColor =
              session.provider === 'cloud' ? theme.accent : theme.textMuted;

            // Stats for running containers (cloud doesn't support stats)
            const stats = containerStats.get(session.id);
            const cpuText =
              session.provider === 'cloud'
                ? '-'
                : session.status === 'running' && stats
                  ? formatCpuPercent(stats.cpuPercent)
                  : '-';
            const memText =
              session.provider === 'cloud'
                ? '-'
                : session.status === 'running' && stats
                  ? formatMemUsage(stats.memUsage, true)
                  : '-';

            // Background: selected > hovered > default
            const bgColor = isSelected
              ? theme.primary
              : isHovered
                ? theme.backgroundElement
                : undefined;
            const itemFg = isSelected ? theme.background : theme.text;
            const itemFgMuted = isSelected
              ? theme.backgroundElement
              : theme.textMuted;
            return (
              <box
                key={session.id}
                height={1}
                flexDirection="row"
                backgroundColor={bgColor}
                paddingLeft={1}
                paddingRight={1}
                gap={2}
                onMouseDown={() => handleRowClick(session)}
                onMouseOver={() => handleRowHover(index)}
              >
                <text height={1} width={1} fg={statusColor}>
                  {statusIcon}
                </text>
                <text
                  height={1}
                  width={1}
                  fg={isSelected ? itemFg : providerColor}
                >
                  {providerBadge}
                </text>
                <text height={1} flexGrow={3} flexBasis={10} fg={itemFg}>
                  {session.name}
                </text>
                <text height={1} width={8} fg={itemFgMuted}>
                  {statusText}
                </text>
                <text height={1} width={6} fg={itemFgMuted}>
                  {cpuText}
                </text>
                <text height={1} width={7} fg={itemFgMuted}>
                  {memText}
                </text>
                <text height={1} width={10} fg={isSelected ? itemFg : prColor}>
                  {prText}
                </text>
                <text
                  height={1}
                  flexGrow={1}
                  flexShrink={1}
                  flexBasis={0}
                  fg={itemFg}
                  overflow="hidden"
                  wrapMode="none"
                >
                  {agentText}
                </text>
                <text
                  height={1}
                  flexGrow={2}
                  flexShrink={1}
                  flexBasis={0}
                  fg={itemFg}
                  overflow="hidden"
                  wrapMode="none"
                >
                  {session.repo}
                </text>
                <text height={1} width={7} fg={itemFgMuted}>
                  {timeText}
                </text>
              </box>
            );
          })}
        </scrollbox>
      )}

      {/* Split-view detail panel for the highlighted session (tall terminals only) */}
      {isBig && selectedSession ? (
        <box
          flexGrow={1}
          flexShrink={0}
          flexDirection="column"
          borderStyle="single"
          border={['top']}
          borderColor={theme.border}
          paddingTop={1}
        >
          <SessionDetailPanel
            key={selectedSession.id}
            session={selectedSession}
            onAttach={(id) => {
              const s = filteredSessions.find((sess) => sess.id === id);
              if (s) onAttach?.(s);
            }}
            onShell={(id) => {
              const s = filteredSessions.find((sess) => sess.id === id);
              if (s) onShell?.(s);
            }}
            onResume={(s) => onResume?.(s)}
            onSessionDeleted={handlePanelSessionDeleted}
            poll={false}
          />
        </box>
      ) : (
        <box
          flexGrow={1}
          flexShrink={0}
          flexDirection="row"
          justifyContent="flex-end"
        >
          <ActionButton
            label="commands"
            keybind="^p"
            color={theme.text}
            onPress={showCommands}
          />
        </box>
      )}

      {/* Delete confirmation modal */}
      {deleteModal && (
        <ConfirmModal
          title="Delete Session"
          message={`Delete "${deleteModal.name}"?`}
          detail="This will remove the container and any unsaved work."
          confirmLabel="Delete"
          confirmColor={theme.error}
          onConfirm={handleDelete}
          onCancel={() => setDeleteModal(null)}
        />
      )}

      {/* Stop confirmation modal */}
      {stopModal && (
        <ConfirmModal
          title="Stop Session"
          message={`Stop "${stopModal.name}"?`}
          detail="This will terminate the running agent session."
          confirmLabel="Stop"
          confirmColor={theme.warning}
          onConfirm={handleStop}
          onCancel={() => setStopModal(null)}
        />
      )}
    </box>
  );
}
