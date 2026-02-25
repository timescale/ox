import { useKeyboard } from '@opentui/react';
import open from 'open';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useContainerStats } from '../hooks/useContainerStats';
import { useWindowSize } from '../hooks/useWindowSize';
import { copyToClipboard } from '../services/clipboard';
import { useCommandStore, useRegisterCommands } from '../services/commands.tsx';
import { formatCpuPercent, formatMemUsage } from '../services/docker';
import { getPrForBranch, type PrInfo } from '../services/github';
import { log } from '../services/logger';
import { getSandboxProvider, type HermesSession } from '../services/sandbox';
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
import { formatShellError, type ShellError } from '../utils';
import { ConfirmModal } from './ConfirmModal';
import { Frame } from './Frame';
import { HotkeysBar } from './HotkeysBar';
import { LogViewer } from './LogViewer';

/** Cache TTL in milliseconds (60 seconds) */
const PR_CACHE_TTL = 60_000;

export interface SessionDetailProps {
  session: HermesSession;
  onBack: () => void;
  onAttach: (sessionId: string) => void;
  onShell: (sessionId: string) => void;
  onResume: (session: HermesSession) => void;
  onSessionDeleted: () => void;
  onNewPrompt?: () => void;
}

type ModalType = 'stop' | 'delete' | null;

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
  const { prCache, setPrInfo, addPendingDelete, removePendingDelete } =
    useSessionStore();
  const [session, setSession] = useState(initialSession);
  const [modal, setModal] = useState<ModalType>(null);
  const [actionInProgress, setActionInProgress] = useState(false);
  const { isTall } = useWindowSize();

  const isRunning = session.status === 'running';
  const isStopped = session.status === 'exited' || session.status === 'stopped';
  const providerType = session.provider;
  const sessionProvider = useMemo(
    () => getSandboxProvider(providerType),
    [providerType],
  );

  // Poll CPU/memory stats for running Docker containers only
  const statsIds = useMemo(
    () => (isRunning && providerType === 'docker' ? [session.id] : []),
    [isRunning, providerType, session.id],
  );
  const getStats = useCallback(
    (ids: string[]) => fetchDockerStats(ids, [session]),
    [session],
  );
  const containerStats = useContainerStats(statsIds, getStats);
  const stats = containerStats.get(session.id);

  // Get PR info from cache
  const cachedPr = prCache[session.id];
  const prInfo: PrInfo | null = cachedPr?.prInfo ?? null;

  // Hover state for PR indicator
  const [prHovered, setPrHovered] = useState(false);
  // Hover state for prompt box
  const [promptHovered, setPromptHovered] = useState(false);

  // Fetch PR info if not cached or stale
  const fetchPrInfo = useCallback(async () => {
    const now = Date.now();
    const cached = prCache[session.id];
    const isStale = !cached || now - cached.lastChecked > PR_CACHE_TTL;

    if (isStale) {
      const info = await getPrForBranch(session.repo, session.branch);
      setPrInfo(session.id, info);
    }
  }, [session.id, session.repo, session.branch, prCache, setPrInfo]);

  // Fetch PR info on mount
  useEffect(() => {
    fetchPrInfo();
  }, [fetchPrInfo]);

  // Refresh session metadata periodically
  useEffect(() => {
    const interval = setInterval(async () => {
      const updated = await sessionProvider.get(session.id);
      if (updated) {
        setSession(updated);
      } else {
        // Container no longer exists
        useToastStore.getState().show('Container no longer exists', 'error');
        setTimeout(() => onSessionDeleted(), 1500);
      }
      // Also refresh PR info if stale
      fetchPrInfo();
    }, 5000);

    return () => clearInterval(interval);
  }, [session.id, sessionProvider, onSessionDeleted, fetchPrInfo]);

  const handleStop = useCallback(async () => {
    setModal(null);
    setActionInProgress(true);
    useToastStore.getState().show('Stopping container...', 'info');
    try {
      await sessionProvider.stop(session.id);
      useToastStore.getState().show('Container stopped', 'success');
      // Refresh session
      const updated = await sessionProvider.get(session.id);
      if (updated) {
        setSession(updated);
      }
    } catch (err) {
      log.error({ err }, `Failed to stop container ${session.id}`);
      useToastStore.getState().show(`Failed to stop: ${err}`, 'error');
    } finally {
      setActionInProgress(false);
    }
  }, [session.id, sessionProvider]);

  const handleDelete = useCallback(() => {
    setModal(null);

    // Mark as pending delete (Layer 1: immediate in-memory hide)
    addPendingDelete(session.id);

    useToastStore.getState().show('Session deleted', 'success');

    // Enqueue background deletion
    useBackgroundTaskStore
      .getState()
      .enqueue(`Deleting "${session.name}"`, async () => {
        try {
          await sessionProvider.remove(session.id);
        } finally {
          removePendingDelete(session.id);
        }
      });

    // Navigate back to list immediately
    onSessionDeleted();
  }, [
    session.id,
    session.name,
    sessionProvider,
    onSessionDeleted,
    addPendingDelete,
    removePendingDelete,
  ]);

  const handleResume = useCallback(() => {
    onResume(session);
  }, [onResume, session]);

  const handleLogError = useCallback((error: string) => {
    useToastStore.getState().show(error, 'error');
  }, []);

  // Handle prompt click to copy to clipboard
  const handlePromptClick = useCallback(() => {
    if (session.prompt) {
      copyToClipboard(session.prompt);
      useToastStore.getState().show('Prompt copied to clipboard', 'info', 1500);
    }
  }, [session.prompt]);

  // Handle PR click
  const handlePrClick = useCallback(() => {
    if (prInfo) {
      open(prInfo.url)
        .then(() => {
          useToastStore
            .getState()
            .show(`Opening PR #${prInfo.number}...`, 'info', 1000);
        })
        .catch((err) => {
          log.error({ err }, 'Failed to open PR URL in browser');
          useToastStore
            .getState()
            .show('Failed to open PR in browser', 'error');
        });
    }
  }, [prInfo]);

  const handleGitSwitch = useCallback(async () => {
    const branchName = `hermes/${session.branch}`;
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
  }, [session.branch]);

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
        onSelect: () => onAttach(session.id),
      },
      {
        id: 'session.shell',
        title: 'Shell',
        description: 'Open a bash shell inside the running container',
        category: 'Session',
        keybind: { key: 's', ctrl: true },
        enabled: isRunning,
        onSelect: () => onShell(session.id),
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
            useToastStore
              .getState()
              .show('No PR found for this session', 'warning');
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
      session.id,
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
      running: theme.success,
      exited: session.exitCode === 0 ? theme.text : theme.error,
      stopped: theme.warning,
      unknown: theme.textMuted,
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
              {`#${prInfo.number} ${prInfo.state.toLowerCase()}`}
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
        <box flexDirection="row" gap={1}>
          <text fg={theme.textMuted}>provider</text>
          <text fg={session.provider === 'cloud' ? theme.accent : theme.text}>
            {session.provider === 'cloud' ? 'cloud' : 'docker'}
          </text>
        </box>
        {isRunning && stats && session.provider !== 'cloud' && (
          <box flexDirection="row" gap={3}>
            <box flexDirection="row" gap={1}>
              <text fg={theme.textMuted}>cpu</text>
              <text>{formatCpuPercent(stats.cpuPercent)}</text>
            </box>
            <box flexDirection="row" gap={1}>
              <text fg={theme.textMuted}>mem</text>
              <text>{formatMemUsage(stats.memUsage)}</text>
            </box>
          </box>
        )}
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
      {session.provider === 'cloud' && (
        <box flexDirection="row" gap={3} height={1} overflow="hidden">
          {session.region && (
            <box flexDirection="row" gap={1}>
              <text fg={theme.textMuted}>region</text>
              <text>{session.region}</text>
            </box>
          )}
          {session.volumeSlug && (
            <box flexDirection="row" gap={1}>
              <text fg={theme.textMuted}>volume</text>
              <text fg={theme.textMuted}>{session.volumeSlug}</text>
            </box>
          )}
          {session.snapshotSlug && (
            <box flexDirection="row" gap={1}>
              <text fg={theme.textMuted}>snapshot</text>
              <text fg={theme.textMuted}>{session.snapshotSlug}</text>
            </box>
          )}
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
          containerId={session.id}
          streamLogs={(id) => sessionProvider.streamLogs(id)}
          isInteractive={session.interactive}
          onError={handleLogError}
        />
      </box>

      <HotkeysBar keyList={actions} />

      {/* Confirmation modals */}
      {modal === 'stop' && (
        <ConfirmModal
          title="Stop Container?"
          message={`Are you sure you want to stop ${session.containerName ?? session.name}?`}
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
          message={`Are you sure you want to delete ${session.containerName ?? session.name}?`}
          detail="This action cannot be undone."
          confirmLabel="Delete"
          confirmColor={theme.warning}
          onConfirm={handleDelete}
          onCancel={() => setModal(null)}
        />
      )}
    </Frame>
  );
}
