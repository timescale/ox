import type { ScrollBoxRenderable } from '@opentui/core';
import { flushSync, useKeyboard } from '@opentui/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type HermesSession, listHermesSessions } from '../services/docker';
import { Frame } from './Frame';
import { HotkeysBar } from './HotkeysBar';
import { Toast, type ToastType } from './Toast';

export type FilterMode = 'all' | 'running' | 'completed';

export interface SessionsListProps {
  onSelect: (session: HermesSession) => void;
  onQuit: () => void;
  onNewTask?: () => void;
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

function getStatusColor(session: HermesSession): string {
  switch (session.status) {
    case 'running':
      return '#51cf66';
    case 'exited':
      return session.exitCode === 0 ? '#868e96' : '#ff6b6b';
    case 'paused':
      return '#fcc419';
    case 'dead':
      return '#ff6b6b';
    default:
      return '#888888';
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

export function SessionsList({
  onSelect,
  onQuit,
  onNewTask,
}: SessionsListProps) {
  const [sessions, setSessions] = useState<HermesSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterText, setFilterText] = useState('');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [toast, setToast] = useState<ToastState | null>(null);
  const scrollboxRef = useRef<ScrollBoxRenderable | null>(null);

  // Filter sessions based on text and mode
  const filteredSessions = sessions.filter((session) => {
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

  // Load sessions
  const loadSessions = useCallback(async () => {
    try {
      const result = await listHermesSessions();
      setSessions(result);
      setLoading(false);
    } catch (err) {
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

  // Keep selected index in bounds
  useEffect(() => {
    if (selectedIndex >= filteredSessions.length) {
      setSelectedIndex(Math.max(0, filteredSessions.length - 1));
    }
  }, [filteredSessions.length, selectedIndex]);

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
      flushSync(() => setSelectedIndex(newIndex));
      scrollToIndex(newIndex);
      return;
    }

    if (
      key.name === 'down' ||
      (key.name === 'j' && key.ctrl) ||
      key.name === 'linefeed'
    ) {
      const newIndex = Math.min(filteredSessions.length - 1, selectedIndex + 1);
      flushSync(() => setSelectedIndex(newIndex));
      scrollToIndex(newIndex);
      return;
    }

    if (key.name === 'tab') {
      const currentIdx = FILTER_ORDER.indexOf(filterMode);
      const nextIdx = (currentIdx + 1) % FILTER_ORDER.length;
      const nextMode = FILTER_ORDER[nextIdx];
      if (nextMode) {
        setFilterMode(nextMode);
        setSelectedIndex(0);
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
      setSelectedIndex(0);
      return;
    }

    // Printable characters for filter
    if (key.raw && key.raw.length === 1 && key.raw.match(/[a-zA-Z0-9-_./]/)) {
      setFilterText((prev) => prev + key.raw);
      setSelectedIndex(0);
    }
  });

  if (loading && sessions.length === 0) {
    return (
      <Frame title="Hermes Sessions" centered>
        <text fg="#888888">Loading sessions...</text>
      </Frame>
    );
  }

  const filterLabel = FILTER_LABELS[filterMode];
  const countText = `${filteredSessions.length} of ${sessions.length}`;

  return (
    <Frame title="Hermes Sessions">
      {/* Filter bar */}
      <box height={1} marginBottom={1} flexDirection="row">
        <text height={1}>
          Filter: <span fg="#51cf66">{filterText || ''}</span>
          <span fg="#444444">█</span>
        </text>
        <text height={1} flexGrow={1} />
        <text height={1} fg="#888888">
          [{filterLabel}] {countText}
        </text>
      </box>

      {/* Column headers */}
      <box height={1} flexDirection="row" paddingLeft={1} paddingRight={1}>
        <text height={1} width={3} />
        <text height={1} flexGrow={2} flexBasis={0} fg="#888888">
          NAME
        </text>
        <text height={1} width={12} fg="#888888">
          STATUS
        </text>
        <text height={1} flexGrow={1} flexBasis={0} fg="#888888">
          AGENT
        </text>
        <text height={1} flexGrow={2} flexBasis={0} fg="#888888">
          REPO
        </text>
        <text height={1} width={10} fg="#888888">
          CREATED
        </text>
      </box>

      {/* Session list */}
      {filteredSessions.length === 0 ? (
        <box flexGrow={1} alignItems="center" justifyContent="center">
          <text fg="#888888">
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
            const statusColor = getStatusColor(session);
            const statusText = getStatusText(session);
            const agentText = session.model
              ? `${session.agent}/${session.model}`
              : session.agent;
            const timeText = session.created
              ? formatRelativeTime(session.created)
              : '';

            return (
              <box
                key={session.containerId}
                height={1}
                flexDirection="row"
                backgroundColor={isSelected ? '#0066cc' : undefined}
                paddingLeft={1}
                paddingRight={1}
              >
                <text
                  height={1}
                  width={3}
                  fg={isSelected ? '#ffffff' : statusColor}
                >
                  {statusIcon}
                </text>
                <text
                  height={1}
                  flexGrow={2}
                  flexBasis={0}
                  fg={isSelected ? '#ffffff' : undefined}
                >
                  {session.name}
                </text>
                <text
                  height={1}
                  width={12}
                  fg={isSelected ? '#cccccc' : '#888888'}
                >
                  {statusText}
                </text>
                <text
                  height={1}
                  flexGrow={1}
                  flexBasis={0}
                  fg={isSelected ? '#ffffff' : undefined}
                >
                  {agentText}
                </text>
                <text
                  height={1}
                  flexGrow={2}
                  flexBasis={0}
                  fg={isSelected ? '#ffffff' : undefined}
                >
                  {session.repo}
                </text>
                <text
                  height={1}
                  width={10}
                  fg={isSelected ? '#cccccc' : '#666666'}
                >
                  {timeText}
                </text>
              </box>
            );
          })}
        </scrollbox>
      )}

      <HotkeysBar
        keyList={[
          ['enter', 'view'],
          ['tab', 'filter'],
          ['ctrl+p', 'new'],
          ['ctrl+r', 'refresh'],
        ]}
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
