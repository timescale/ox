import type { ScrollBoxRenderable } from '@opentui/core';
import { flushSync, useKeyboard } from '@opentui/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type HermesSession, listHermesSessions } from '../services/docker';
import { log } from '../services/logger';
import { useSessionStore } from '../stores/sessionStore';
import { useTheme } from '../stores/themeStore';
import { Frame } from './Frame';
import { HotkeysBar } from './HotkeysBar';
import { Toast, type ToastType } from './Toast';

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
  const { selectedSessionId, setSelectedSessionId } = useSessionStore();
  const [sessions, setSessions] = useState<HermesSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterText, setFilterText] = useState('');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  // Default to 'local' if in a repo, otherwise 'global'
  const [scopeMode, setScopeMode] = useState<ScopeMode>(
    currentRepo ? 'local' : 'global',
  );
  const [toast, setToast] = useState<ToastState | null>(null);
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

  // Initial load
  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  // Auto-refresh every 60 seconds
  useEffect(() => {
    const interval = setInterval(loadSessions, 60000);
    return () => clearInterval(interval);
  }, [loadSessions]);

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
    if (key.name === 'escape') {
      onQuit();
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
      loadSessions().then(() => {
        setToast({ message: 'Refreshed', type: 'info' });
      });
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
      <box height={1} flexDirection="row" paddingLeft={1} paddingRight={1}>
        <text height={1} width={3} />
        <text height={1} flexGrow={2} flexBasis={0} fg={theme.textMuted}>
          NAME
        </text>
        <text height={1} width={12} fg={theme.textMuted}>
          STATUS
        </text>
        <text height={1} flexGrow={1} flexBasis={0} fg={theme.textMuted}>
          AGENT
        </text>
        <text height={1} flexGrow={2} flexBasis={0} fg={theme.textMuted}>
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
        <scrollbox ref={scrollboxRef} flexGrow={1} flexShrink={1}>
          {filteredSessions.map((session, index) => {
            const isSelected = index === selectedIndex;
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
            const agentText = session.model
              ? `${session.agent}/${session.model}`
              : session.agent;
            const timeText = session.created
              ? formatRelativeTime(session.created)
              : '';

            const itemFg = isSelected ? theme.background : theme.text;
            const itemFgMuted = isSelected
              ? theme.backgroundElement
              : theme.textMuted;
            return (
              <box
                key={session.containerId}
                height={1}
                flexDirection="row"
                backgroundColor={isSelected ? theme.primary : undefined}
                paddingLeft={1}
                paddingRight={1}
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
                <text height={1} flexGrow={1} flexBasis={0} fg={itemFg}>
                  {agentText}
                </text>
                <text height={1} flexGrow={2} flexBasis={0} fg={itemFg}>
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
        keyList={
          currentRepo
            ? [
                ['enter', 'view'],
                ['tab', 'filter'],
                ['ctrl+l', 'scope'],
                ['ctrl+p', 'new'],
                ['ctrl+r', 'refresh'],
              ]
            : [
                ['enter', 'view'],
                ['tab', 'filter'],
                ['ctrl+p', 'new'],
                ['ctrl+r', 'refresh'],
              ]
        }
      />

      {/* Toast notifications */}
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onDismiss={() => setToast(null)}
        />
      )}
    </Frame>
  );
}
