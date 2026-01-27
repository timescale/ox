import { useKeyboard } from '@opentui/react';
import { useCallback, useEffect, useState } from 'react';
import {
  getSession,
  type HermesSession,
  removeContainer,
  stopContainer,
} from '../services/docker';
import { ConfirmModal } from './ConfirmModal';
import { Frame } from './Frame';
import { HotkeysBar } from './HotkeysBar';
import { LogViewer } from './LogViewer';
import { OptionsModal } from './OptionsModal';
import { PromptModal } from './PromptModal';
import { Toast, type ToastType } from './Toast';

export interface SessionDetailProps {
  session: HermesSession;
  onBack: () => void;
  onQuit: () => void;
  onAttach: (containerId: string) => void;
  onResume: (
    containerId: string,
    mode: 'interactive' | 'detached',
    prompt?: string,
  ) => Promise<void> | void;
  onSessionDeleted: () => void;
}

type ModalType = 'stop' | 'delete' | 'resume' | 'resumePrompt' | null;

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

function getStatusColor(status: HermesSession['status']): string {
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
    return session.exitCode === 0 ? 'complete' : `failed (${session.exitCode})`;
  }
  return session.status;
}

export function SessionDetail({
  session: initialSession,
  onBack,
  onQuit,
  onAttach,
  onResume,
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
    showToast('Stopping container...', 'info');
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

  const handleResumeInteractive = useCallback(() => {
    setModal(null);
    onResume(session.containerId, 'interactive');
  }, [onResume, session.containerId]);

  const handleResumeDetached = useCallback(() => {
    setModal('resumePrompt');
  }, []);

  const handleResumePromptSubmit = useCallback(
    async (prompt: string) => {
      setModal(null);
      setActionInProgress(true);
      showToast('Resuming in background...', 'info');
      try {
        await onResume(session.containerId, 'detached', prompt);
        showToast('Resume started', 'success');
        onBack();
      } catch (err) {
        showToast(`Failed to resume: ${err}`, 'error');
      } finally {
        setActionInProgress(false);
      }
    },
    [onBack, onResume, session.containerId, showToast],
  );

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
    } else if (key.raw === 'r' && isStopped) {
      setModal('resume');
    }
  });

  const statusColor = getStatusColor(session.status);
  const statusIcon = getStatusIcon(session);
  const statusText = getStatusText(session);
  const agentDisplay = session.model
    ? `${session.agent} (${session.model})`
    : session.agent;
  const metadataHeight = session.resumedFrom ? 5 : 4;

  // Build help text based on available actions
  const actions = [
    ...(isRunning
      ? [
          ['s', 'top'],
          ['a', 'ttach'],
        ]
      : []),
    ...(isStopped
      ? [
          ['r', 'esume'],
          ['d', 'elete'],
        ]
      : []),
    ['b', 'ack'],
    ['q', 'uit'],
  ] as unknown as readonly [string, string][];

  return (
    <Frame title={session.branch}>
      {/* Metadata section */}
      <box height={metadataHeight} flexDirection="column" marginBottom={1}>
        <box height={1} flexDirection="row">
          <text height={1}>
            Status:{' '}
            <span fg={statusColor}>
              {statusIcon} {statusText}
            </span>
          </text>
          <text height={1} flexGrow={1} />
          <text height={1}>
            Created:{' '}
            {session.created ? formatRelativeTime(session.created) : 'unknown'}
          </text>
        </box>
        <box height={1} flexDirection="row">
          <text height={1}>Repo: {session.repo}</text>
          <text height={1} flexGrow={1} />
          <text height={1}>Agent: {agentDisplay}</text>
        </box>
        <box height={1} flexDirection="row">
          <text height={1}>Name: {session.name}</text>
          <text height={1} flexGrow={1} />
          <text height={1}>Branch: hermes/{session.branch}</text>
        </box>
        <box height={1} flexDirection="row">
          <text height={1}>Container: {session.containerName}</text>
        </box>
        {session.resumedFrom && (
          <box height={1} flexDirection="row">
            <text height={1}>Resumed From: {session.resumedFrom}</text>
          </box>
        )}
      </box>

      {/* Prompt section */}
      <box title="Prompt" border borderStyle="single" height={3}>
        <text fg="#cccccc" height={1} overflow="scroll">
          {session.prompt || '(no prompt)'}
        </text>
      </box>

      {/* Logs section */}
      <box
        title="Logs"
        border
        borderStyle="single"
        flexGrow={1}
        flexDirection="column"
      >
        <LogViewer
          containerId={session.containerId}
          isRunning={isRunning}
          isInteractive={session.interactive}
          onError={handleLogError}
        />
      </box>

      <HotkeysBar compact keyList={actions} />

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

      {modal === 'resume' && (
        <OptionsModal
          title="Resume Session"
          message={`Resume ${session.containerName}?`}
          options={[
            {
              key: 'd',
              name: 'Detached',
              description: 'runs in the background',
              onSelect: handleResumeDetached,
              color: '#339af0',
            },
            {
              key: 'i',
              name: 'Interactive',
              description: 'runs in this terminal',
              onSelect: handleResumeInteractive,
              color: '#51cf66',
            },
          ]}
          onCancel={() => setModal(null)}
        />
      )}

      {modal === 'resumePrompt' && (
        <PromptModal
          title="Resume (Detached)"
          message="Enter a prompt to continue this session."
          placeholder="Describe what the agent should do next..."
          onSubmit={handleResumePromptSubmit}
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
