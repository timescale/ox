import open from 'open';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useContainerStats } from '../hooks/useContainerStats';
import { usePollingInterval } from '../hooks/usePollingInterval';
import { useWindowSize } from '../hooks/useWindowSize.ts';
import { AGENT_INFO_MAP, type AgentInfo } from '../services/agents.ts';
import { copyToClipboard } from '../services/clipboard';
import { useCommandStore } from '../services/commands.tsx';
import { formatCpuPercent, formatMemUsage } from '../services/docker';
import { getPrForBranch, type PrInfo } from '../services/github';
import { log } from '../services/logger';
import { getSandboxProvider, type OxSession } from '../services/sandbox';
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
import { notifySessionComplete } from '../utils/notify.ts';
import { ActionButton, type ActionButtonProps } from './ActionButton.tsx';
import { ConfirmModal } from './ConfirmModal';
import { EmptyBorder } from './PromptScreen.tsx';

/** Cache TTL in milliseconds (60 seconds) */
const PR_CACHE_TTL = 60_000;

export interface SessionDetailPanelProps {
  session: OxSession;
  onAttach: (sessionId: string) => void;
  onShell: (sessionId: string) => void;
  onResume: (session: OxSession) => void;
  onSessionDeleted: () => void;
  /** Optional back button handler. When provided, a "back" button is shown. */
  onBack?: () => void;
  /** If true, polls for session updates and PR info. Defaults to true. */
  poll?: boolean;
  /** Called when the session metadata is refreshed via polling. */
  onSessionUpdated?: (session: OxSession) => void;
  /** When provided, the panel uses this as the modal state (controlled mode). */
  modal?: ModalType;
  /** Called when the panel wants to open/close a modal (controlled mode). */
  onModalChange?: (modal: ModalType) => void;
}

export type ModalType = 'stop' | 'delete' | null;

export function SessionDetailPanel({
  session: initialSession,
  onAttach,
  onShell,
  onResume,
  onSessionDeleted,
  onBack,
  poll = true,
  onSessionUpdated,
  modal: controlledModal,
  onModalChange,
}: SessionDetailPanelProps) {
  const { theme } = useTheme();
  const { prCache, setPrInfo, addPendingDelete, removePendingDelete } =
    useSessionStore();
  const [session, setSession] = useState(initialSession);
  // Ref to hold the latest session so callbacks can read it without depending
  // on the object reference (which changes on every poll).
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const onSessionUpdatedRef = useRef(onSessionUpdated);
  onSessionUpdatedRef.current = onSessionUpdated;
  // Track the previous status to detect running → exited transitions for notifications.
  const prevStatusRef = useRef(initialSession.status);
  // Support controlled (external) or uncontrolled (internal) modal state.
  const [internalModal, setInternalModal] = useState<ModalType>(null);
  const modal = controlledModal !== undefined ? controlledModal : internalModal;
  const setModal = onModalChange ?? setInternalModal;
  const [actionInProgress, setActionInProgress] = useState(false);
  const showCommands = useCommandStore((s) => s.show);
  const { isWide } = useWindowSize();

  // Sync session when the prop changes (e.g. highlighted session changes in list)
  useEffect(() => {
    setSession(initialSession);
    prevStatusRef.current = initialSession.status;
  }, [initialSession]);

  const isRunning = session.status === 'running';
  const isStopped = session.status === 'exited' || session.status === 'stopped';
  const providerType = session.provider;
  const sessionProvider = useMemo(
    () => getSandboxProvider(providerType),
    [providerType],
  );

  // Poll CPU/memory stats for running Docker containers only.
  // Stabilize `statsIds` so it only gets a new reference when the actual set
  // of IDs changes — not on every poll cycle.
  const statsIdsKey = useMemo(
    () => (isRunning && providerType === 'docker' ? session.id : ''),
    [isRunning, providerType, session.id],
  );
  const statsIds = useMemo(
    () => (statsIdsKey ? [statsIdsKey] : []),
    [statsIdsKey],
  );
  // Use sessionRef so the callback identity is stable across polls.
  const getStats = useCallback(
    (ids: string[], signal: AbortSignal) =>
      fetchDockerStats(ids, [sessionRef.current], signal),
    [],
  );
  const containerStats = useContainerStats(statsIds, getStats);
  const stats = containerStats.get(session.id);

  // Get PR info from cache
  const cachedPr = prCache[session.id];
  const prInfo: PrInfo | null = cachedPr?.prInfo ?? null;

  // Hover state for PR indicator
  const [prHovered, setPrHovered] = useState(false);

  // AbortController ref for cancelling in-flight PR fetches on unmount.
  // This prevents `gh pr list` docker containers from keeping the process alive
  // after the TUI exits.
  const prAbortRef = useRef(new AbortController());
  useEffect(() => {
    return () => {
      try {
        prAbortRef.current.abort();
      } catch {
        // AbortController.abort() can throw if listeners throw synchronously.
        // Safe to ignore — the abort signal is still marked as aborted.
      }
    };
  }, []);

  // Fetch PR info if not cached or stale.  Reads from the store directly
  // (not via the `prCache` selector) so callers don't re-trigger on every
  // cache update.
  const fetchPrIfStale = useCallback(() => {
    const now = Date.now();
    const cached = useSessionStore.getState().prCache[session.id];
    const isStale = !cached || now - cached.lastChecked > PR_CACHE_TTL;
    if (!isStale) return;

    getPrForBranch(session.repo, session.branch, prAbortRef.current.signal)
      .then((info) => {
        if (!prAbortRef.current.signal.aborted) {
          setPrInfo(session.id, info);
        }
      })
      .catch((err) => {
        if (!prAbortRef.current.signal.aborted) {
          log.error({ err }, 'Failed to fetch PR info');
        }
      });
  }, [session.id, session.repo, session.branch, setPrInfo]);

  // Fetch PR info on mount (or when session identity changes).
  useEffect(() => {
    fetchPrIfStale();
  }, [fetchPrIfStale]);

  // Refresh session metadata with exponential backoff polling.
  const pollSession = useCallback(async () => {
    if (!poll) return;
    const updated = await sessionProvider.get(session.id);
    if (updated) {
      // Notify when an async session transitions from running to exited.
      // Interactive sessions are attached by the user, so a notification is not useful.
      if (
        !updated.interactive &&
        prevStatusRef.current === 'running' &&
        updated.status === 'exited'
      ) {
        notifySessionComplete(updated.name, updated.exitCode === 0);
      }
      prevStatusRef.current = updated.status;
      setSession(updated);
      onSessionUpdatedRef.current?.(updated);
    } else {
      useToastStore.getState().show('Container no longer exists', 'error');
      setTimeout(() => onSessionDeleted(), 1500);
    }
    fetchPrIfStale();
  }, [poll, session.id, sessionProvider, onSessionDeleted, fetchPrIfStale]);

  const { rush: rushSessionPoll } = usePollingInterval(pollSession, {
    initialMs: poll ? 100 : 60_000,
    maxMs: poll ? 5000 : 60_000,
  });

  const handleStop = useCallback(async () => {
    setModal(null);
    setActionInProgress(true);
    useToastStore.getState().show('Stopping container...', 'info');
    try {
      await sessionProvider.stop(session.id);
      useToastStore.getState().show('Container stopped', 'success');
      rushSessionPoll();
    } catch (err) {
      log.error({ err }, `Failed to stop container ${session.id}`);
      useToastStore.getState().show(`Failed to stop: ${err}`, 'error');
    } finally {
      setActionInProgress(false);
    }
  }, [session.id, sessionProvider, rushSessionPoll, setModal]);

  const handleDelete = useCallback(() => {
    setModal(null);
    addPendingDelete(session.id);
    useToastStore.getState().show('Session deleted', 'success');
    useBackgroundTaskStore
      .getState()
      .enqueue(`Deleting "${session.name}"`, async () => {
        try {
          await sessionProvider.remove(session.id);
        } finally {
          removePendingDelete(session.id);
        }
      });
    onSessionDeleted();
  }, [
    session.id,
    session.name,
    sessionProvider,
    onSessionDeleted,
    addPendingDelete,
    removePendingDelete,
    setModal,
  ]);

  const handleResume = useCallback(() => {
    onResume(sessionRef.current);
  }, [onResume]);

  // Handle prompt click to copy to clipboard
  const handlePromptClick = useCallback(() => {
    const { prompt } = sessionRef.current;
    if (prompt) {
      copyToClipboard(prompt);
      useToastStore.getState().show('Prompt copied to clipboard', 'info', 1500);
    }
  }, []);

  // Handle PR click
  const handlePrClick = useCallback(() => {
    const pr =
      useSessionStore.getState().prCache[sessionRef.current.id]?.prInfo;
    if (pr) {
      open(pr.url)
        .then(() => {
          useToastStore
            .getState()
            .show(`Opening PR #${pr.number}...`, 'info', 1000);
        })
        .catch((err) => {
          log.error({ err }, 'Failed to open PR URL in browser');
          useToastStore
            .getState()
            .show('Failed to open PR in browser', 'error');
        });
    }
  }, []);

  // Suspend command keybind dispatch when modal is open
  const suspend = useCommandStore((s) => s.suspend);
  useEffect(() => {
    if (modal || actionInProgress) {
      return suspend();
    }
  }, [modal, actionInProgress, suspend]);

  // Build action button definitions based on session state.
  // Uses sessionRef in onPress handlers so the memo only needs to recompute
  // when status or theme changes, not on every poll cycle.
  const actionButtons: ActionButtonProps[] = useMemo(
    () =>
      isRunning
        ? [
            {
              label: session.interactive ? 'attach' : 'resume',
              keybind: session.interactive ? '^a' : '^r',
              color: theme.primary,
              onPress: session.interactive
                ? () => onAttach(sessionRef.current.id)
                : () => onResume(sessionRef.current),
            },
            {
              label: 'shell',
              keybind: '^s',
              color: theme.accent,
              onPress: () => onShell(sessionRef.current.id),
            },
            {
              label: 'stop',
              keybind: '^x',
              color: theme.warning,
              onPress: () => setModal('stop'),
            },
          ]
        : isStopped
          ? [
              {
                label: 'resume',
                keybind: '^r',
                color: theme.primary,
                onPress: handleResume,
              },
              {
                label: 'delete',
                keybind: '^d',
                color: theme.error,
                onPress: () => setModal('delete'),
              },
            ]
          : [],
    [
      isRunning,
      isStopped,
      session.interactive,
      theme,
      onAttach,
      onShell,
      onResume,
      handleResume,
      setModal,
    ],
  );

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
  const agentInfo: AgentInfo = AGENT_INFO_MAP[session.agent];

  return (
    <>
      {/* Metadata section */}
      <box flexDirection="row" gap={1} overflow="hidden">
        <box flexDirection="row" gap={1}>
          <text wrapMode="none" fg={theme.textMuted}>
            name
          </text>
          <text wrapMode="none">{session.name}</text>
        </box>
        <box flexDirection="row" gap={1} flexGrow={1} justifyContent="flex-end">
          <text fg={theme.textMuted}>created</text>
          <text>
            {session.created ? formatRelativeTime(session.created) : 'unknown'}
          </text>
        </box>
      </box>
      <box flexDirection="row" gap={2} height={1} overflow="hidden">
        <box flexDirection="row" gap={1}>
          <text wrapMode="none" fg={theme.textMuted}>
            repo
          </text>
          <text wrapMode="none">
            {session.repo} : ox/{session.branch}
          </text>
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
      </box>
      <box
        flexDirection="row"
        columnGap={isWide ? 3 : 2}
        overflow="hidden"
        flexWrap="wrap"
      >
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
          <>
            <box flexDirection="row" gap={1}>
              <text fg={theme.textMuted}>cpu</text>
              <text>{formatCpuPercent(stats.cpuPercent)}</text>
            </box>
            <box flexDirection="row" gap={1}>
              <text fg={theme.textMuted}>mem</text>
              <text>{formatMemUsage(stats.memUsage)}</text>
            </box>
          </>
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
        <box
          flexDirection="row"
          columnGap={isWide ? 3 : 2}
          overflow="hidden"
          flexWrap="wrap"
        >
          {session.region && (
            <box flexDirection="row" gap={1}>
              <text fg={theme.textMuted}>region</text>
              <text>{session.region}</text>
            </box>
          )}
          {session.volumeSlug && (
            <box flexDirection="row" gap={1}>
              <text fg={theme.textMuted}>volume</text>
              <text>{session.volumeSlug}</text>
            </box>
          )}
          {session.snapshotSlug && (
            <box flexDirection="row" gap={1}>
              <text fg={theme.textMuted}>snapshot</text>
              <text>{session.snapshotSlug}</text>
            </box>
          )}
        </box>
      )}

      {/* Prompt section */}
      {/* Half-height padding top */}
      <box
        height={1}
        flexShrink={0}
        border={['left', 'right']}
        borderColor={agentInfo?.color}
        customBorderChars={{
          ...EmptyBorder,
          vertical: '\u257B',
        }}
      >
        <box
          height={1}
          flexShrink={0}
          border={['top']}
          borderColor={theme.backgroundElement}
          customBorderChars={{
            ...EmptyBorder,
            horizontal: '\u2584',
          }}
        />
      </box>
      <box
        flexShrink={0}
        border={['left', 'right']}
        borderColor={agentInfo?.color}
        customBorderChars={{
          ...EmptyBorder,
          vertical: '\u2503',
          bottomLeft: '\u2579',
        }}
      >
        <box
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
          flexShrink={0}
          backgroundColor={theme.backgroundElement}
          onMouseDown={handlePromptClick}
        >
          <textarea
            textColor={theme.text}
            backgroundColor={theme.backgroundElement}
            focusedBackgroundColor={theme.backgroundElement}
            minHeight={1}
            maxHeight={3}
            initialValue={session.prompt || '(no prompt)'}
            onKeyDown={(evt) => {
              if (!['left', 'right', 'up', 'down'].includes(evt.name)) {
                evt.preventDefault();
              }
            }}
          />
        </box>
      </box>
      {/* Half-height padding bottom */}
      <box
        height={1}
        flexShrink={0}
        border={['left', 'right']}
        borderColor={agentInfo?.color}
        customBorderChars={{
          ...EmptyBorder,
          vertical: '\u2579',
        }}
      >
        <box
          height={1}
          flexShrink={0}
          border={['bottom']}
          borderColor={theme.backgroundElement}
          customBorderChars={{
            ...EmptyBorder,
            horizontal: '\u2580',
          }}
        />
      </box>

      {/* Action buttons */}
      <box flexDirection="row" flexWrap="wrap" gap={1}>
        {actionButtons.map((btn) => (
          <ActionButton key={btn.label} {...btn} />
        ))}
        <box flexGrow={1} />
        {onBack && (
          <ActionButton label="back" color={theme.textMuted} onPress={onBack} />
        )}
        <ActionButton
          label="commands"
          keybind="^p"
          color={theme.text}
          onPress={showCommands}
        />
      </box>

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
    </>
  );
}
