import type { ScrollBoxRenderable } from '@opentui/core';
import { flushSync, useKeyboard } from '@opentui/react';
import open from 'open';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type HermesSession,
  listHermesSessions,
  removeContainer,
} from '../services/docker';
import { getPrForBranch } from '../services/github';
import { log } from '../services/logger';
import { useSessionStore } from '../stores/sessionStore';
import { useTheme } from '../stores/themeStore';
import { ConfirmModal } from './ConfirmModal';
import { Frame } from './Frame';
import { HotkeysBar } from './HotkeysBar';
import { Toast, type ToastType } from './Toast';

/** Cache TTL in milliseconds (60 seconds) */
const PR_CACHE_TTL = 60_000;

export type FilterMode = 'all' | 'running' | 'completed';
export type ScopeMode = 'local' | 'global';

export interface SessionsListProps {
  onSelect: (session: HermesSession) => void;
  onQuit: () => void;
  onNewTask?: () => void;
  /** Current repo fullName (e.g., "owner/repo") if in a git repo, undefined otherwise */
  currentRepo?: string;
}

interface ToastState {
  message: string;
  type: ToastType;
  duration?: number;
}

function formatRelativeTime(isoDate: string): string {
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

function getStatusIcon(session: HermesSession): string {
  switch (session.status) {
    case 'running':
      return '●';
    case 'exited':
      return session.exitCode === 0 ? '✓' : '✗';
    case 'paused':
      return '⏸';
    case 'dead':
      return '✗';
    default:
      return '○';
  }
}

function getStatusText(session: HermesSession): string {
  if (session.status === 'exited') {
    return session.exitCode === 0 ? 'complete' : `failed(${session.exitCode})`;
  }
  return session.status;
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
  currentRepo,
}: SessionsListProps) {
  const { theme } = useTheme();
  const {
    selectedSessionId,
    setSelectedSessionId,
    prCache,
    setPrInfo,
    clearPrCache,
  } = useSessionStore();
  const [sessions, setSessions] = useState<HermesSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterText, setFilterText] = useState('');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  // Default to 'local' if in a repo, otherwise 'global'
  const [scopeMode, setScopeMode] = useState<ScopeMode>(
    currentRepo ? 'local' : 'global',
  );
  const [toast, setToast] = useState<ToastState | null>(null);
  const [deleteModal, setDeleteModal] = useState<HermesSession | null>(null);
  const [actionInProgress, setActionInProgress] = useState(false);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const scrollboxRef = useRef<ScrollBoxRenderable | null>(null);

  // Filter sessions based on text, mode, and scope
  const filteredSessions = sessions.filter((session) => {
    // Scope filter (only when in a repo)
    if (currentRepo && scopeMode === 'local' && session.repo !== currentRepo) {
      return false;
    }

    // Mode filter
    if (filterMode === 'running' && session.status !== 'running') {
      return false;
    }
    if (filterMode === 'completed' && session.status === 'running') {
      return false;
    }

    // Text filter (search name, branch, repo, prompt)
    if (filterText) {
      const searchText = filterText.toLowerCase();
      const matches =
        session.name.toLowerCase().includes(searchText) ||
        session.branch.toLowerCase().includes(searchText) ||
        session.repo.toLowerCase().includes(searchText) ||
        session.prompt.toLowerCase().includes(searchText);
      if (!matches) return false;
    }

    return true;
  });

  // Compute selected index from session ID
  // If the selected session is in the filtered list, use its index
  // Otherwise, fall back to 0 (first item)
  const selectedIndex = (() => {
    if (selectedSessionId) {
      const index = filteredSessions.findIndex(
        (s) => s.containerId === selectedSessionId,
      );
      if (index >= 0) return index;
    }
    return 0;
  })();

  // Helper to select by index (updates the store with session ID)
  const selectByIndex = useCallback(
    (index: number) => {
      const session = filteredSessions[index];
      if (session) {
        setSelectedSessionId(session.containerId);
      }
    },
    [filteredSessions, setSelectedSessionId],
  );

  // Load sessions
  const loadSessions = useCallback(async () => {
    try {
      const result = await listHermesSessions();
      setSessions(result);
      setLoading(false);
    } catch (err) {
      log.error({ err }, 'Failed to load sessions');
      setToast({ message: `Failed to load sessions: ${err}`, type: 'error' });
      setLoading(false);
    }
  }, []);

  // Fetch PR info for sessions that need it
  const fetchPrInfo = useCallback(
    async (sessionsToFetch: HermesSession[], forceRefresh = false) => {
      const now = Date.now();
      for (const session of sessionsToFetch) {
        const cached = prCache[session.containerId];
        const isStale = !cached || now - cached.lastChecked > PR_CACHE_TTL;

        if (forceRefresh || isStale) {
          const prInfo = await getPrForBranch(session.repo, session.branch);
          setPrInfo(session.containerId, prInfo);
        }
      }
    },
    [prCache, setPrInfo],
  );

  // Mouse handlers for session rows
  const handleRowClick = useCallback(
    (session: HermesSession) => {
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

  // Delete session handler
  const handleDelete = useCallback(async () => {
    if (!deleteModal) return;
    const session = deleteModal;

    // Determine which session to select after deletion:
    // prefer next item, fall back to previous if deleting last item
    const deleteIndex = filteredSessions.findIndex(
      (s) => s.containerId === session.containerId,
    );
    const nextSession =
      filteredSessions[deleteIndex + 1] ?? filteredSessions[deleteIndex - 1];
    const nextSessionId = nextSession?.containerId ?? null;

    setDeleteModal(null);
    setActionInProgress(true);
    try {
      await removeContainer(session.containerId);
      setToast({ message: 'Session deleted', type: 'success' });
      // Update selection before refreshing so it persists
      setSelectedSessionId(nextSessionId);
      await loadSessions();
    } catch (err) {
      log.error({ err }, `Failed to remove container ${session.containerId}`);
      setToast({ message: `Failed to delete: ${err}`, type: 'error' });
    } finally {
      setActionInProgress(false);
    }
  }, [deleteModal, filteredSessions, loadSessions, setSelectedSessionId]);

  // Initial load
  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  // Auto-refresh every 60 seconds
  useEffect(() => {
    const interval = setInterval(loadSessions, 60000);
    return () => clearInterval(interval);
  }, [loadSessions]);

  // Fetch PR info for all sessions when sessions list changes
  useEffect(() => {
    if (sessions.length > 0) {
      fetchPrInfo(sessions);
    }
  }, [sessions, fetchPrInfo]);

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

  // Keyboard handling
  useKeyboard((key) => {
    // Ignore keyboard input when modal is open or action in progress
    if (deleteModal || actionInProgress) return;

    if (key.name === 'escape') {
      onQuit();
      return;
    }

    // Delete selected session (ctrl+d or delete key)
    if ((key.name === 'd' && key.ctrl) || key.name === 'delete') {
      const session = filteredSessions[selectedIndex];
      if (session) {
        setDeleteModal(session);
      }
      return;
    }

    if (key.name === 'return' && filteredSessions.length > 0) {
      const session = filteredSessions[selectedIndex];
      if (session) {
        onSelect(session);
      }
      return;
    }

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

    if (key.name === 'tab') {
      const currentIdx = FILTER_ORDER.indexOf(filterMode);
      const nextIdx = (currentIdx + 1) % FILTER_ORDER.length;
      const nextMode = FILTER_ORDER[nextIdx];
      if (nextMode) {
        setFilterMode(nextMode);
        // Don't reset selection when changing filter - the selectedIndex
        // computation will handle finding the session or falling back to 0
      }
      return;
    }

    // Ctrl+L to toggle scope (only when in a repo)
    if (key.name === 'l' && key.ctrl && currentRepo) {
      const currentIdx = SCOPE_ORDER.indexOf(scopeMode);
      const nextIdx = (currentIdx + 1) % SCOPE_ORDER.length;
      const nextScope = SCOPE_ORDER[nextIdx];
      if (nextScope) {
        setScopeMode(nextScope);
      }
      return;
    }

    if (key.name === 'r' && key.ctrl) {
      setLoading(true);
      clearPrCache(); // Force re-fetch of PR info
      loadSessions().then(() => {
        setToast({ message: 'Refreshed', type: 'info' });
      });
      return;
    }

    // Ctrl+O to open PR in browser
    if (key.name === 'o' && key.ctrl) {
      const session = filteredSessions[selectedIndex];
      if (session) {
        const prInfo = prCache[session.containerId]?.prInfo;
        if (prInfo) {
          open(prInfo.url)
            .then(() => {
              setToast({
                message: `Opening PR #${prInfo.number}...`,
                type: 'info',
                duration: 1000,
              });
            })
            .catch((err: unknown) => {
              log.debug({ err }, 'Failed to open PR URL in browser');
              setToast({
                message: `Failed to open PR in browser`,
                type: 'error',
              });
            });
        } else {
          setToast({
            message: 'No PR found for this session',
            type: 'warning',
          });
        }
      }
      return;
    }

    if (key.name === 'p' && key.ctrl && onNewTask) {
      onNewTask();
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

  if (loading && sessions.length === 0) {
    return (
      <Frame title="Hermes Sessions" centered>
        <text fg={theme.textMuted}>Loading sessions...</text>
      </Frame>
    );
  }

  const filterLabel = FILTER_LABELS[filterMode];
  const scopeLabel = currentRepo ? SCOPE_LABELS[scopeMode] : null;
  const countText = `${filteredSessions.length} of ${sessions.length}`;

  return (
    <Frame title="Hermes Sessions">
      {/* Filter bar */}
      <box height={1} marginBottom={1} flexDirection="row">
        <text height={1}>
          Filter: <span fg={theme.primary}>{filterText || ''}</span>
          <span fg={theme.textMuted}>█</span>
        </text>
        <text height={1} flexGrow={1} />
        <text height={1} fg={theme.textMuted}>
          {scopeLabel && `[${scopeLabel}] `}[{filterLabel}] {countText}
        </text>
      </box>

      {/* Column headers */}
      <box
        height={1}
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
        gap={2}
      >
        <text height={1} width={3} />
        <text height={1} flexGrow={2} flexBasis={0} fg={theme.textMuted}>
          NAME
        </text>
        <text height={1} width={12} fg={theme.textMuted}>
          STATUS
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
        <text height={1} width={10} fg={theme.textMuted}>
          CREATED
        </text>
      </box>

      {/* Session list */}
      {filteredSessions.length === 0 ? (
        <box flexGrow={1} alignItems="center" justifyContent="center">
          <text fg={theme.textMuted}>
            {sessions.length === 0
              ? 'No sessions found. Run `hermes branch <prompt>` to create one.'
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
                created: theme.info,
                exited: session.exitCode === 0 ? theme.text : theme.error,
                restarting: theme.accent,
                running: theme.success,
                paused: theme.warning,
                dead: theme.error,
              }[session.status] || theme.textMuted;
            const statusText = getStatusText(session);

            // PR info from cache
            const cachedPr = prCache[session.containerId];
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
                key={session.containerId}
                height={1}
                flexDirection="row"
                backgroundColor={bgColor}
                paddingLeft={1}
                paddingRight={1}
                gap={2}
                onMouseDown={() => handleRowClick(session)}
                onMouseOver={() => handleRowHover(index)}
              >
                <text height={1} width={3} fg={statusColor}>
                  {statusIcon}
                </text>
                <text height={1} flexGrow={2} flexBasis={0} fg={itemFg}>
                  {session.name}
                </text>
                <text height={1} width={12} fg={itemFgMuted}>
                  {statusText}
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
                <text height={1} width={10} fg={itemFgMuted}>
                  {timeText}
                </text>
              </box>
            );
          })}
        </scrollbox>
      )}

      <HotkeysBar
        keyList={[
          ['tab', 'filter'],
          ...(currentRepo ? [['ctrl+l', 'scope'] as [string, string]] : []),
          ['ctrl+o', 'open PR'],
          ['ctrl+p', 'new'],
          ['ctrl+r', 'refresh'],
        ]}
      />

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

      {/* Toast notifications */}
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          duration={toast.duration}
          onDismiss={() => setToast(null)}
        />
      )}
    </Frame>
  );
}
