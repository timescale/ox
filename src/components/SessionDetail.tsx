import { useKeyboard } from '@opentui/react';
import open from 'open';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useWindowSize } from '../hooks/useWindowSize';
import { copyToClipboard } from '../services/clipboard';
import {
  type ContainerDiffResult,
  getContainerDiff,
  getSession,
  type HermesSession,
  removeContainer,
  stopContainer,
} from '../services/docker';
import {
  getPrForBranch,
  type PrInfo,
  pushAndCreatePr,
} from '../services/github';
import { log } from '../services/logger';
import { useSessionStore } from '../stores/sessionStore';
import { useTheme } from '../stores/themeStore';
import { formatShellError, type ShellError } from '../utils';
import { ConfirmModal } from './ConfirmModal';
import { DiffViewer } from './DiffViewer';
import { Frame } from './Frame';
import { HotkeysBar } from './HotkeysBar';
import { LogViewer } from './LogViewer';
import { OptionsModal } from './OptionsModal';
import { Toast, type ToastType } from './Toast';

/** Cache TTL in milliseconds (60 seconds) */
const PR_CACHE_TTL = 60_000;

export interface SessionDetailProps {
  session: HermesSession;
  onBack: () => void;
  onAttach: (containerId: string) => void;
  onResume: (session: HermesSession, promptPrefix?: string) => void;
  onSessionDeleted: () => void;
  onNewPrompt?: () => void;
}

type ModalType = 'stop' | 'delete' | 'review' | null;
type DetailTab = 'logs' | 'diff';

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

  // Diff review state
  const [activeTab, setActiveTab] = useState<DetailTab>('logs');
  const [diffData, setDiffData] = useState<ContainerDiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  // Track previous status for auto-switching to diff on task completion
  const prevStatusRef = useRef(initialSession.status);
  // Track selected file in DiffViewer for targeted follow-up
  const [selectedDiffFile, setSelectedDiffFile] = useState<string | null>(null);

  const isRunning = session.status === 'running';
  const isStopped = session.status === 'exited' || session.status === 'dead';
  const isGitSession = session.repo !== 'local';

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
        const wasRunning = prevStatusRef.current === 'running';
        const isNowStopped =
          updated.status === 'exited' || updated.status === 'dead';

        setSession(updated);
        prevStatusRef.current = updated.status;

        // Auto-switch to diff view when task completes
        if (
          wasRunning &&
          isNowStopped &&
          updated.repo !== 'local' &&
          !diffData
        ) {
          setDiffLoading(true);
          setActiveTab('diff');
          try {
            const result = await getContainerDiff(updated.containerId);
            setDiffData(result);
          } catch (err) {
            log.error({ err }, 'Failed to auto-load diff');
            setActiveTab('logs');
          } finally {
            setDiffLoading(false);
          }
        }
      } else {
        // Container no longer exists
        setToast({ message: 'Container no longer exists', type: 'error' });
        setTimeout(() => onSessionDeleted(), 1500);
      }
      // Also refresh PR info if stale
      fetchPrInfo();
    }, 5000);

    return () => clearInterval(interval);
  }, [session.containerId, onSessionDeleted, fetchPrInfo, diffData]);

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

  const handleResume = useCallback(
    (promptPrefix?: string) => {
      onResume(session, promptPrefix);
    },
    [onResume, session],
  );

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

  // Load and show diff from the stopped container
  const handleViewDiff = useCallback(async () => {
    if (activeTab === 'diff') {
      setActiveTab('logs');
      return;
    }
    // Use cached diff if available
    if (diffData) {
      setActiveTab('diff');
      return;
    }
    setDiffLoading(true);
    setActiveTab('diff');
    try {
      const result = await getContainerDiff(session.containerId);
      setDiffData(result);
    } catch (err) {
      log.error({ err }, 'Failed to load diff');
      showToast(
        `Failed to load diff: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      );
      setActiveTab('logs');
    } finally {
      setDiffLoading(false);
    }
  }, [activeTab, diffData, session.containerId, showToast]);

  // Push branch and create PR from the diff view
  const handleCreatePr = useCallback(async () => {
    if (prInfo) {
      // PR already exists, just open it
      handlePrClick();
      return;
    }
    setActionInProgress(true);
    showToast('Pushing branch and creating PR...', 'info');
    try {
      const pr = await pushAndCreatePr(
        session.containerId,
        session.repo,
        session.branch,
        diffData?.stat,
        diffData?.log,
      );
      if (pr) {
        setPrInfo(session.containerId, pr);
        showToast(`PR #${pr.number} created`, 'success');
        open(pr.url).catch(() => {});
      } else {
        showToast('Failed to create PR', 'error');
      }
    } catch (err) {
      log.error({ err }, 'Failed to create PR');
      showToast(
        `Failed to create PR: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      );
    } finally {
      setActionInProgress(false);
    }
  }, [
    prInfo,
    handlePrClick,
    session.containerId,
    session.repo,
    session.branch,
    diffData,
    showToast,
    setPrInfo,
  ]);

  // Keyboard shortcuts
  useKeyboard((key) => {
    // Ignore if modal is open or action in progress
    if (modal || actionInProgress) return;

    if (key.name === 'p' && key.ctrl && onNewPrompt) {
      onNewPrompt();
      return;
    }

    if (key.name === 'escape' || key.name === 'backspace' || key.raw === 'b') {
      onBack();
    } else if (key.raw === 's' && isRunning) {
      setModal('stop');
    } else if ((key.raw === 'd' || key.raw === 'x') && isStopped) {
      setModal('delete');
    } else if (key.raw === 'a' && isRunning) {
      onAttach(session.containerId);
    } else if (key.raw === 'r' && isStopped && activeTab !== 'diff') {
      handleResume();
    } else if (key.raw === 'o') {
      // Open PR in browser
      if (!prInfo) {
        setToast({ message: 'No PR found for this session', type: 'warning' });
        return;
      }
      handlePrClick();
    } else if (key.raw === 'v' && isStopped && isGitSession) {
      handleViewDiff();
    } else if (
      key.raw === 'c' &&
      isStopped &&
      isGitSession &&
      activeTab === 'diff' &&
      !prInfo
    ) {
      setModal('review');
    } else if (key.raw === 'f' && isStopped && activeTab === 'diff') {
      if (selectedDiffFile) {
        handleResume(`Regarding changes in \`${selectedDiffFile}\`: `);
      } else {
        handleResume();
      }
    } else if (key.raw === 'g' && activeTab !== 'diff') {
      handleGitSwitch();
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
          ...(activeTab === 'diff'
            ? [
                ...(prInfo ? [['o', 'pen PR']] : [['c', 'ode review']]),
                ['f', 'ollow-up'],
              ]
            : [['r', 'esume']]),
          ...(isGitSession
            ? [['v', activeTab === 'diff' ? 'iew logs' : 'iew diff']]
            : []),
          ['d', 'elete'],
        ]
      : []),
    ...(activeTab !== 'diff' && prInfo ? [['o', 'pen PR']] : []),
    ...(activeTab !== 'diff' ? [['g', 'it switch']] : []),
    ['b', 'ack'],
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

      {/* Content section - Logs or Diff */}
      <box
        title={activeTab === 'logs' ? 'Logs' : 'Review'}
        border
        borderStyle="single"
        flexGrow={1}
        flexShrink={1}
        flexDirection="column"
      >
        {activeTab === 'logs' ? (
          <LogViewer
            containerId={session.containerId}
            isInteractive={session.interactive}
            onError={handleLogError}
          />
        ) : diffLoading ? (
          <box flexGrow={1} alignItems="center" justifyContent="center">
            <text fg={theme.textMuted}>Loading diff...</text>
          </box>
        ) : diffData ? (
          <DiffViewer
            diffData={diffData}
            onSelectedFileChange={setSelectedDiffFile}
          />
        ) : (
          <box flexGrow={1} alignItems="center" justifyContent="center">
            <text fg={theme.textMuted}>No diff available</text>
          </box>
        )}
      </box>

      <HotkeysBar compact keyList={actions} />

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

      {modal === 'review' && (
        <OptionsModal
          title="Code Review"
          message="How would you like to proceed with these changes?"
          minWidth={50}
          maxWidth={65}
          options={[
            {
              key: 'a',
              name: 'Approve & Create PR',
              description: 'Push branch and open a pull request',
              onSelect: () => {
                setModal(null);
                handleCreatePr();
              },
              color: theme.success,
            },
            {
              key: 'x',
              name: 'Request Changes',
              description: 'Resume with feedback for the agent',
              onSelect: () => {
                setModal(null);
                const prefix = selectedDiffFile
                  ? `Please fix the following issues in \`${selectedDiffFile}\`: `
                  : 'Please fix the following issues: ';
                handleResume(prefix);
              },
              color: theme.warning,
            },
          ]}
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
