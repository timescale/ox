import { useKeyboard } from '@opentui/react';
import { useCallback, useEffect, useState } from 'react';
import {
  type ConductorSession,
  getSession,
  removeContainer,
  stopContainer,
} from '../services/docker';
import { ConfirmModal } from './ConfirmModal';
import { Frame } from './Frame';
import { LogViewer } from './LogViewer';
import { Toast, type ToastType } from './Toast';

export interface SessionDetailProps {
  session: ConductorSession;
  onBack: () => void;
  onQuit: () => void;
  onAttach: (containerId: string) => void;
  onSessionDeleted: () => void;
}

type ModalType = 'stop' | 'delete' | null;

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

function getStatusColor(status: ConductorSession['status']): string {
  switch (status) {
    case 'running':
      return '#51cf66';
    case 'exited':
      return '#868e96';
    case 'paused':
      return '#fcc419';
    case 'dead':
      return '#ff6b6b';
    default:
      return '#888888';
  }
}

function getStatusIcon(session: ConductorSession): string {
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

function getStatusText(session: ConductorSession): string {
  if (session.status === 'exited') {
    return session.exitCode === 0 ? 'complete' : `failed (${session.exitCode})`;
  }
  return session.status;
}

export function SessionDetail({
  session: initialSession,
  onBack,
  onQuit,
  onAttach,
  onSessionDeleted,
}: SessionDetailProps) {
  const [session, setSession] = useState(initialSession);
  const [modal, setModal] = useState<ModalType>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [actionInProgress, setActionInProgress] = useState(false);

  const isRunning = session.status === 'running';
  const isStopped = session.status === 'exited' || session.status === 'dead';

  // Refresh session metadata periodically
  useEffect(() => {
    const interval = setInterval(async () => {
      const updated = await getSession(session.containerId);
      if (updated) {
        setSession(updated);
      } else {
        // Container no longer exists
        setToast({ message: 'Container no longer exists', type: 'error' });
        setTimeout(() => onSessionDeleted(), 1500);
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [session.containerId, onSessionDeleted]);

  const showToast = useCallback((message: string, type: ToastType) => {
    setToast({ message, type });
  }, []);

  const handleStop = useCallback(async () => {
    setModal(null);
    setActionInProgress(true);
    try {
      await stopContainer(session.containerId);
      showToast('Container stopped', 'success');
      // Refresh session
      const updated = await getSession(session.containerId);
      if (updated) {
        setSession(updated);
      }
    } catch (err) {
      showToast(`Failed to stop: ${err}`, 'error');
    } finally {
      setActionInProgress(false);
    }
  }, [session.containerId, showToast]);

  const handleDelete = useCallback(async () => {
    setModal(null);
    setActionInProgress(true);
    try {
      await removeContainer(session.containerId);
      showToast('Container removed', 'success');
      setTimeout(() => onSessionDeleted(), 1000);
    } catch (err) {
      showToast(`Failed to remove: ${err}`, 'error');
      setActionInProgress(false);
    }
  }, [session.containerId, showToast, onSessionDeleted]);

  const handleLogError = useCallback(
    (error: string) => {
      showToast(error, 'error');
    },
    [showToast],
  );

  // Keyboard shortcuts
  useKeyboard((key) => {
    // Ignore if modal is open or action in progress
    if (modal || actionInProgress) return;

    if (key.raw === 'q') {
      onQuit();
    } else if (
      key.name === 'escape' ||
      key.name === 'backspace' ||
      key.raw === 'b'
    ) {
      onBack();
    } else if (key.raw === 's' && isRunning) {
      setModal('stop');
    } else if ((key.raw === 'd' || key.raw === 'x') && isStopped) {
      setModal('delete');
    } else if (key.raw === 'a' && isRunning) {
      onAttach(session.containerId);
    }
  });

  const statusColor = getStatusColor(session.status);
  const statusIcon = getStatusIcon(session);
  const statusText = getStatusText(session);
  const agentDisplay = session.model
    ? `${session.agent} (${session.model})`
    : session.agent;

  // Build help text based on available actions
  const actions: string[] = [];
  if (isRunning) {
    actions.push('[s]top', '[a]ttach');
  }
  if (isStopped) {
    actions.push('[d]elete');
  }
  actions.push('[b]ack', '[q]uit');
  const helpText = actions.join('  ');

  return (
    <Frame title={session.branch}>
      {/* Metadata section */}
      <box style={{ height: 3, flexDirection: 'column', marginBottom: 1 }}>
        <box style={{ height: 1, flexDirection: 'row' }}>
          <text style={{ height: 1 }}>
            Status:{' '}
            <span fg={statusColor}>
              {statusIcon} {statusText}
            </span>
          </text>
          <text style={{ height: 1, flexGrow: 1 }} />
          <text style={{ height: 1 }}>
            Created:{' '}
            {session.created ? formatRelativeTime(session.created) : 'unknown'}
          </text>
        </box>
        <box style={{ height: 1, flexDirection: 'row' }}>
          <text style={{ height: 1 }}>Repo: {session.repo}</text>
          <text style={{ height: 1, flexGrow: 1 }} />
          <text style={{ height: 1 }}>Agent: {agentDisplay}</text>
        </box>
        <box style={{ height: 1, flexDirection: 'row' }}>
          <text style={{ height: 1 }}>Branch: conductor/{session.branch}</text>
          <text style={{ height: 1, flexGrow: 1 }} />
          <text style={{ height: 1 }}>Container: {session.containerName}</text>
        </box>
      </box>

      {/* Prompt section */}
      <box
        title="Prompt"
        style={{
          border: true,
          borderStyle: 'single',
          height: 3,
        }}
      >
        <text style={{ fg: '#cccccc', height: 1, overflow: 'scroll' }}>
          {session.prompt || '(no prompt)'}
        </text>
      </box>

      {/* Logs section */}
      <box
        title="Logs"
        style={{
          border: true,
          borderStyle: 'single',
          flexGrow: 1,
          flexDirection: 'column',
        }}
      >
        <LogViewer
          containerId={session.containerId}
          isRunning={isRunning}
          onError={handleLogError}
        />
      </box>

      {/* Help bar */}
      <text style={{ height: 1, fg: '#888888' }}>{helpText}</text>

      {/* Confirmation modals */}
      {modal === 'stop' && (
        <ConfirmModal
          title="Stop Container?"
          message={`Are you sure you want to stop ${session.containerName}?`}
          detail="This will terminate the running agent session."
          confirmLabel="Stop"
          confirmColor="#ff6b6b"
          onConfirm={handleStop}
          onCancel={() => setModal(null)}
        />
      )}

      {modal === 'delete' && (
        <ConfirmModal
          title="Delete Container?"
          message={`Are you sure you want to delete ${session.containerName}?`}
          detail="This action cannot be undone."
          confirmLabel="Delete"
          confirmColor="#ff6b6b"
          onConfirm={handleDelete}
          onCancel={() => setModal(null)}
        />
      )}

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
