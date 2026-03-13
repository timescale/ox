import { useKeyboard } from '@opentui/react';
import open from 'open';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useCommandStore, useRegisterCommands } from '../services/commands.tsx';
import { log } from '../services/logger';
import { getSandboxProvider } from '../services/sandbox';
import { useRouterStore } from '../stores/routerStore.ts';
import { useSessionStore } from '../stores/sessionStore';
import { useSessionWorkflowStore } from '../stores/sessionWorkflowStore.ts';
import { useToastStore } from '../stores/toastStore';
import { formatShellError, type ShellError } from '../utils/shell.ts';
import { LogViewer } from './LogViewer';
import { type ModalType, SessionDetailPanel } from './SessionDetailPanel.tsx';

export function SessionDetail() {
  const view = useRouterStore((s) => s.view);
  const session = view.type === 'detail' ? view.session : null;
  const handleResume = useSessionWorkflowStore((s) => s.handleResume);

  // Track the live session (updated by SessionDetailPanel polling).
  // The prop `session` is set once when navigating to the detail view and
  // doesn't update, so we maintain our own copy for derived state.
  const [liveSession, setLiveSession] = useState(session);
  const sessionRef = useRef(liveSession);
  sessionRef.current = liveSession;

  // Modal state shared with SessionDetailPanel (controlled mode).
  const [modal, setModal] = useState<ModalType>(null);

  const isRunning = liveSession?.status === 'running';
  const isStopped =
    liveSession?.status === 'exited' || liveSession?.status === 'stopped';
  const providerType = session?.provider;
  const sessionProvider = useMemo(
    () => (providerType ? getSandboxProvider(providerType) : null),
    [providerType],
  );

  const handleGitSwitch = useCallback(async () => {
    const branchName = `ox/${sessionRef.current?.branch}`;
    try {
      await Bun.$`git fetch && git switch ${branchName}`.quiet();
      useToastStore
        .getState()
        .show(`Switched to branch ${branchName}`, 'success');
    } catch (err) {
      const formattedError = formatShellError(err as ShellError);
      log.error({ err }, `Failed to switch to branch ${branchName}`);
      useToastStore.getState().show(formattedError.message, 'error');
    }
  }, []);

  const handlePrOpen = useCallback(() => {
    const prInfo =
      useSessionStore.getState().prCache[sessionRef.current?.id ?? '']?.prInfo;
    if (!prInfo) {
      useToastStore.getState().show('No PR found for this session', 'warning');
      return;
    }
    open(prInfo.url)
      .then(() => {
        useToastStore
          .getState()
          .show(`Opening PR #${prInfo.number}...`, 'info', 1000);
      })
      .catch((err) => {
        log.error({ err }, 'Failed to open PR URL in browser');
        useToastStore.getState().show('Failed to open PR in browser', 'error');
      });
  }, []);

  // Register commands for the command palette.
  // Handlers read dynamic state at invocation time via sessionRef / store.getState()
  // so only values that affect `enabled`/`hidden` flags need to be deps.
  useRegisterCommands(
    () => [
      {
        id: 'nav.sessionsList',
        title: 'View sessions list',
        description: 'Go back to the sessions list',
        category: 'Navigation',
        keybind: { key: 'l', ctrl: true },
        onSelect: () => useRouterStore.getState().goToList(),
      },
      {
        id: 'task.new',
        title: 'New task',
        description: 'Start a new ox session',
        category: 'Navigation',
        keybind: { key: 'n', ctrl: true },
        onSelect: () => useRouterStore.getState().goToPrompt(),
      },
      {
        id: 'navigate-resources',
        title: 'Manage Resources',
        description: 'View and manage sandbox images, volumes, and snapshots',
        category: 'Navigation',
        keybind: { key: 'e', ctrl: true, display: 'ctrl+e' },
        onSelect: () => useRouterStore.getState().goToResources(),
      },
      {
        id: 'session.attach',
        title: 'Attach',
        description: 'Connect to the running agent container interactively',
        category: 'Session',
        keybind: { key: 'a', ctrl: true },
        enabled: isRunning,
        onSelect: () => {
          const s = sessionRef.current;
          if (s) useRouterStore.getState().attach(s.id, s);
        },
      },
      {
        id: 'session.shell',
        title: 'Shell',
        description: 'Open a bash shell inside the running container',
        category: 'Session',
        keybind: { key: 's', ctrl: true },
        enabled: isRunning,
        onSelect: () => {
          const s = sessionRef.current;
          if (s) useRouterStore.getState().execShell(s.id, s);
        },
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
        description: 'Resume this stopped session',
        category: 'Session',
        keybind: { key: 'r', ctrl: true },
        enabled: isStopped,
        onSelect: () => {
          const s = sessionRef.current;
          if (s) handleResume(s);
        },
      },
      {
        id: 'session.delete',
        title: 'Delete',
        description: 'Remove the stopped container permanently',
        category: 'Session',
        keybind: [{ key: 'd', ctrl: true }, { key: 'delete' }],
        onSelect: () => setModal('delete'),
      },
      {
        id: 'session.openPr',
        title: 'View PR',
        description: 'Open the pull request in browser',
        category: 'Session',
        keybind: { key: 'o', ctrl: true },
        onSelect: handlePrOpen,
      },
      {
        id: 'session.openApp',
        title: 'Open app',
        description: 'Open the default app URL in your browser',
        category: 'Session',
        keybind: { key: 'b', ctrl: true },
        enabled: isRunning && !!liveSession?.portUrls?.length,
        onSelect: () => {
          const s = sessionRef.current;
          const defaultUrl = s?.portUrls?.find((pu) => !pu.subdomain)?.url;
          if (defaultUrl) {
            open(defaultUrl)
              .then(() => {
                useToastStore
                  .getState()
                  .show('Opening app in browser...', 'info', 1000);
              })
              .catch((err) => {
                log.error({ err }, 'Failed to open app URL in browser');
                useToastStore
                  .getState()
                  .show('Failed to open app in browser', 'error');
              });
          } else {
            useToastStore.getState().show('No app URL available', 'warning');
          }
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
      isRunning,
      isStopped,
      handleResume,
      handlePrOpen,
      handleGitSwitch,
      liveSession?.portUrls,
    ],
  );

  // Read palette open state so escape doesn't go back when closing the palette
  const isOpen = useCommandStore((s) => s.isOpen);

  const handleLogError = useCallback((error: string) => {
    useToastStore.getState().show(error, 'error');
  }, []);

  // Keyboard shortcuts — escape to go back
  useKeyboard((key) => {
    if (key.name === 'escape') {
      if (!isOpen) useRouterStore.getState().goToList();
    }
  });

  if (!session) return null;

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box flexGrow={1} flexDirection="column" padding={1}>
        <SessionDetailPanel
          session={session}
          onResume={handleResume}
          onSessionDeleted={() => useRouterStore.getState().goToList()}
          showBack
          onSessionUpdated={setLiveSession}
          modal={modal}
          onModalChange={setModal}
        />

        {/* Logs section (hidden for interactive sessions) */}
        {!session.interactive && sessionProvider && (
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
        )}
      </box>
    </box>
  );
}
