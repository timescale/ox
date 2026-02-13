import { useKeyboard } from '@opentui/react';
import open from 'open';
import { useCallback, useEffect, useState } from 'react';
import { useWindowSize } from '../hooks/useWindowSize';
import { copyToClipboard } from '../services/clipboard';
import { useCommandStore, useRegisterCommands } from '../services/commands.tsx';
import {
  getSession,
  type HermesSession,
  removeContainer,
  stopContainer,
} from '../services/docker';
import { getPrForBranch, type PrInfo } from '../services/github';
import { log } from '../services/logger';
import { useSessionStore } from '../stores/sessionStore';
import { useTheme } from '../stores/themeStore';
import { formatShellError, type ShellError } from '../utils';
import { ConfirmModal } from './ConfirmModal';
import { Frame } from './Frame';
import { HotkeysBar } from './HotkeysBar';
import { LogViewer } from './LogViewer';
import { Toast, type ToastType } from './Toast';

/** Cache TTL in milliseconds (60 seconds) */
const PR_CACHE_TTL = 60_000;

export interface SessionDetailProps {
  session: HermesSession;
  onBack: () => void;
  onAttach: (containerId: string) => void;
  onShell: (containerId: string) => void;
  onResume: (session: HermesSession) => void;
  onSessionDeleted: () => void;
  onNewPrompt?: () => void;
}

type ModalType = 'stop' | 'delete' | null;

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
    return session.exitCode === 0 ? 'complete' : `failed (${session.exitCode})`;
  }
  return session.status;
}

export function SessionDetail({
  session: initialSession,
  onBack,
  onAttach,
  onShell,
  onResume,
  onSessionDeleted,
  onNewPrompt,
}: SessionDetailProps) {
  const { theme } = useTheme();
  const { prCache, setPrInfo } = useSessionStore();
  const [session, setSession] = useState(initialSession);
  const [modal, setModal] = useState<ModalType>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [actionInProgress, setActionInProgress] = useState(false);
  const { isTall } = useWindowSize();

  const isRunning = session.status === 'running';
  const isStopped = session.status === 'exited' || session.status === 'dead';

  // Get PR info from cache
  const cachedPr = prCache[session.containerId];
  const prInfo: PrInfo | null = cachedPr?.prInfo ?? null;

  // Hover state for PR indicator
  const [prHovered, setPrHovered] = useState(false);
  // Hover state for prompt box
  const [promptHovered, setPromptHovered] = useState(false);

  // Fetch PR info if not cached or stale
  const fetchPrInfo = useCallback(async () => {
    const now = Date.now();
    const cached = prCache[session.containerId];
    const isStale = !cached || now - cached.lastChecked > PR_CACHE_TTL;

    if (isStale) {
      const info = await getPrForBranch(session.repo, session.branch);
      setPrInfo(session.containerId, info);
    }
  }, [session.containerId, session.repo, session.branch, prCache, setPrInfo]);

  // Fetch PR info on mount
  useEffect(() => {
    fetchPrInfo();
  }, [fetchPrInfo]);

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
      // Also refresh PR info if stale
      fetchPrInfo();
    }, 5000);

    return () => clearInterval(interval);
  }, [session.containerId, onSessionDeleted, fetchPrInfo]);

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
      log.error({ err }, `Failed to stop container ${session.containerId}`);
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
      log.error({ err }, `Failed to remove container ${session.containerId}`);
      showToast(`Failed to remove: ${err}`, 'error');
      setActionInProgress(false);
    }
  }, [session.containerId, showToast, onSessionDeleted]);

  const handleResume = useCallback(() => {
    onResume(session);
  }, [onResume, session]);

  const handleLogError = useCallback(
    (error: string) => {
      showToast(error, 'error');
    },
    [showToast],
  );

  // Handle prompt click to copy to clipboard
  const handlePromptClick = useCallback(() => {
    if (session.prompt) {
      copyToClipboard(session.prompt);
      setToast({
        message: 'Prompt copied to clipboard',
        type: 'info',
        duration: 1500,
      });
    }
  }, [session.prompt]);

  // Handle PR click
  const handlePrClick = useCallback(() => {
    if (prInfo) {
      open(prInfo.url)
        .then(() => {
          setToast({
            message: `Opening PR #${prInfo.number}...`,
            type: 'info',
            duration: 1000,
          });
        })
        .catch((err) => {
          log.error({ err }, 'Failed to open PR URL in browser');
          setToast({
            message: `Failed to open PR in browser`,
            type: 'error',
          });
        });
    }
  }, [prInfo]);

  const handleGitSwitch = useCallback(async () => {
    const branchName = `hermes/${session.branch}`;
    setActionInProgress(true);
    try {
      await Bun.$`git fetch && git switch ${branchName}`.quiet();
      showToast(`Switched to branch ${branchName}`, 'success');
    } catch (err) {
      const formattedError = formatShellError(err as ShellError);
      log.error({ err }, `Failed to switch to branch ${branchName}`);
      showToast(formattedError.message, 'error');
    } finally {
      setActionInProgress(false);
    }
  }, [session.branch, showToast]);

  // Suspend command keybind dispatch when modal is open
  const suspend = useCommandStore((s) => s.suspend);
  useEffect(() => {
    if (modal || actionInProgress) {
      return suspend();
    }
  }, [modal, actionInProgress, suspend]);

  // Register commands for the command palette
  useRegisterCommands(
    () => [
      {
        id: 'nav.sessionsList',
        title: 'View sessions list',
        description: 'Go back to the sessions list',
        category: 'Navigation',
        keybind: { key: 'l', ctrl: true },
        onSelect: () => onBack(),
      },
      {
        id: 'task.new',
        title: 'New task',
        description: 'Start a new hermes session',
        category: 'Navigation',
        keybind: { key: 'n', ctrl: true },
        enabled: !!onNewPrompt,
        onSelect: () => onNewPrompt?.(),
      },
      {
        id: 'session.attach',
        title: 'Attach',
        description: 'Connect to the running agent container interactively',
        category: 'Session',
        keybind: { key: 'a', ctrl: true },
        enabled: isRunning,
        onSelect: () => onAttach(session.containerId),
      },
      {
        id: 'session.shell',
        title: 'Shell',
        description: 'Open a bash shell inside the running container',
        category: 'Session',
        keybind: { key: 's', ctrl: true },
        enabled: isRunning,
        onSelect: () => onShell(session.containerId),
      },
      {
        id: 'session.stop',
        title: 'Stop',
        description: 'Stop the running container',
        category: 'Session',
        keybind: { key: 'x', ctrl: true },
        enabled: isRunning,
        onSelect: () => setModal('stop'),
      },
      {
        id: 'session.resume',
        title: 'Resume',
        description: 'Resume this stopped session with a new prompt',
        category: 'Session',
        keybind: { key: 'r', ctrl: true },
        enabled: isStopped,
        onSelect: handleResume,
      },
      {
        id: 'session.delete',
        title: 'Delete',
        description: 'Remove the stopped container permanently',
        category: 'Session',
        keybind: { key: 'd', ctrl: true },
        enabled: isStopped,
        onSelect: () => setModal('delete'),
      },
      {
        id: 'session.openPr',
        title: 'Open PR',
        description: 'Open the pull request in browser',
        category: 'Session',
        keybind: { key: 'o', ctrl: true },
        onSelect: () => {
          if (!prInfo) {
            setToast({
              message: 'No PR found for this session',
              type: 'warning',
            });
            return;
          }
          handlePrClick();
        },
      },
      {
        id: 'session.gitSwitch',
        title: 'Git switch',
        description: "Switch local git branch to this session's branch",
        category: 'Session',
        keybind: { key: 'g', ctrl: true },
        onSelect: handleGitSwitch,
      },
    ],
    [
      onBack,
      onNewPrompt,
      isRunning,
      isStopped,
      session.containerId,
      onAttach,
      onShell,
      handleResume,
      prInfo,
      handlePrClick,
      handleGitSwitch,
    ],
  );

  // Read palette open state so escape doesn't go back when closing the palette
  const isOpen = useCommandStore((s) => s.isOpen);

  // Keyboard shortcuts — navigation only.
  // Action keybinds are handled by the centralized CommandPaletteHost.
  useKeyboard((key) => {
    if (modal || actionInProgress) return;

    if (key.name === 'escape') {
      if (!isOpen) onBack();
      return;
    }
  });

  const statusColor =
    {
      created: theme.info,
      exited: session.exitCode === 0 ? theme.text : theme.error,
      restarting: theme.accent,
      running: theme.success,
      paused: theme.warning,
      dead: theme.error,
    }[session.status] || theme.textMuted;
  const statusIcon = getStatusIcon(session);
  const statusText = getStatusText(session);
  const model = session.model?.split('/').pop();
  const agentDisplay = model ? `${session.agent} (${model})` : session.agent;

  // Build hotkey hints based on available actions
  const actions = [
    ...(isRunning
      ? [
          ['ctrl+a', 'attach'],
          ['ctrl+s', 'shell'],
          ['ctrl+x', 'stop'],
        ]
      : []),
    ...(isStopped
      ? [
          ['ctrl+r', 'resume'],
          ['ctrl+d', 'delete'],
        ]
      : []),
    ...(prInfo ? [['ctrl+o', 'open PR']] : []),
    ['ctrl+g', 'git switch'],
    ['ctrl+p', 'commands'],
  ] as unknown as readonly [string, string][];

  return (
    <Frame title={session.branch}>
      {/* Metadata section */}
      <box flexDirection="row" gap={1} height={1} overflow="hidden">
        <box flexDirection="row" gap={3}>
          <text wrapMode="none" fg={theme.textMuted}>
            repo
          </text>
          <text wrapMode="none">{session.repo}</text>
        </box>
        {prInfo && (
          <box
            backgroundColor={prHovered ? theme.backgroundElement : undefined}
            onMouseDown={handlePrClick}
            onMouseOver={() => setPrHovered(true)}
            onMouseOut={() => setPrHovered(false)}
          >
            <text
              fg={
                {
                  OPEN: theme.success,
                  MERGED: theme.accent,
                  CLOSED: theme.textMuted,
                }[prInfo.state]
              }
              wrapMode="none"
            >
              #{prInfo.number} {prInfo.state.toLowerCase()}
            </text>
          </box>
        )}
        <box flexDirection="row" gap={1} flexGrow={1} justifyContent="flex-end">
          <text fg={theme.textMuted}>created</text>
          <text>
            {session.created ? formatRelativeTime(session.created) : 'unknown'}
          </text>
        </box>
      </box>
      <box flexDirection="row" gap={3} height={1} overflow="hidden">
        <box flexDirection="row" gap={1}>
          <text fg={theme.textMuted}>status</text>
          <text fg={statusColor}>
            {statusIcon} {statusText}
          </text>
        </box>
        <box flexDirection="row" flexGrow={1} justifyContent="flex-end">
          <text>{agentDisplay}</text>
        </box>
      </box>
      {session.resumedFrom && (
        <box height={1} flexDirection="row" gap={1} overflow="hidden">
          <text fg={theme.textMuted}>resumed from</text>
          <text>{session.resumedFrom}</text>
        </box>
      )}

      {/* Prompt section */}
      <box
        title="Prompt"
        border
        borderStyle="single"
        height={3}
        marginTop={isTall ? 1 : 0}
        backgroundColor={
          promptHovered && session.prompt ? theme.backgroundElement : undefined
        }
        onMouseDown={handlePromptClick}
        onMouseOver={() => setPromptHovered(true)}
        onMouseOut={() => setPromptHovered(false)}
      >
        <text fg={theme.text} height={1} overflow="scroll">
          {session.prompt || '(no prompt)'}
        </text>
      </box>

      {/* Logs section */}
      <box
        title="Logs"
        border
        borderStyle="single"
        flexGrow={1}
        flexShrink={1}
        flexDirection="column"
      >
        <LogViewer
          containerId={session.containerId}
          isInteractive={session.interactive}
          onError={handleLogError}
        />
      </box>

      <HotkeysBar keyList={actions} />

      {/* Confirmation modals */}
      {modal === 'stop' && (
        <ConfirmModal
          title="Stop Container?"
          message={`Are you sure you want to stop ${session.containerName}?`}
          detail="This will terminate the running agent session."
          confirmLabel="Stop"
          confirmColor={theme.warning}
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
          confirmColor={theme.warning}
          onConfirm={handleDelete}
          onCancel={() => setModal(null)}
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
