// ============================================================================
// Sessions Command - Unified TUI for hermes
// ============================================================================

import { YAML } from 'bun';
import { Command } from 'commander';
import { nanoid } from 'nanoid';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfigWizard, type ConfigWizardResult } from '../commands/config.tsx';
import { CloudSetup, type CloudSetupResult } from '../components/CloudSetup';
import { CopyOnSelect } from '../components/CopyOnSelect';
import { DockerSetup, type DockerSetupResult } from '../components/DockerSetup';
import { ensureGhAuth } from '../components/GhAuth.tsx';
import { PromptScreen, type SubmitMode } from '../components/PromptScreen';
import { SessionDetail } from '../components/SessionDetail';
import { SessionsList } from '../components/SessionsList';
import { StartingScreen } from '../components/StartingScreen';
import { Toast, type ToastType } from '../components/Toast';
import { checkClaudeCredentials, ensureClaudeAuth } from '../services/claude';
import { CommandPaletteHost } from '../services/commands.tsx';
import {
  type AgentType,
  type HermesConfig,
  projectConfig,
  readConfig,
} from '../services/config';
import { type ForkResult, forkDatabase } from '../services/db';
import { getDenoToken } from '../services/deno';
import { checkGhCredentials } from '../services/gh.ts';
import {
  generateBranchName,
  getRepoInfo,
  type RepoInfo,
  tryGetRepoInfo,
} from '../services/git';
import { log } from '../services/logger';
import {
  checkOpencodeCredentials,
  ensureOpencodeAuth,
} from '../services/opencode';
import {
  getDefaultProvider,
  getProviderForSession,
  getSandboxProvider,
  type HermesSession,
  listAllSessions,
  type SandboxProvider,
  type SandboxProviderType,
} from '../services/sandbox';
import { formatRelativeTime } from '../services/sessionDisplay';
import { createTui } from '../services/tui.ts';
import {
  checkForUpdate,
  isCompiledBinary,
  performUpdate,
} from '../services/updater';
import {
  ensureGitignore,
  enterSubprocessScreen,
  resetTerminal,
} from '../utils';

// ============================================================================
// Types
// ============================================================================

type SessionsView =
  | { type: 'init' } // Initial loading state
  | { type: 'docker' }
  | { type: 'config' }
  | {
      type: 'cloud-setup';
      // Store the pending action so we can resume after setup completes
      pendingStart?: {
        prompt: string;
        agent: AgentType;
        model: string;
        mode: SubmitMode;
        mountDir?: string;
      };
      pendingResume?: {
        session: HermesSession;
        prompt: string;
        model: string;
        mode: SubmitMode;
        mountDir?: string;
      };
    }
  | { type: 'prompt'; resumeSession?: HermesSession }
  | {
      type: 'starting';
      prompt: string;
      agent: AgentType;
      model: string;
      step: string;
      mode: SubmitMode;
    }
  | {
      type: 'resuming';
      session: HermesSession;
      model: string;
      step: string;
      mode: SubmitMode;
    }
  | { type: 'detail'; session: HermesSession }
  | { type: 'list' };

interface SessionsResult {
  type:
    | 'quit'
    | 'attach'
    | 'attach-session'
    | 'exec-shell'
    | 'shell'
    | 'needs-agent-auth';
  sessionId?: string;
  // For attach/exec-shell: the session to return to after detaching
  session?: HermesSession;
  // For attach-session: the provider type to use
  attachProvider?: SandboxProviderType;
  // For shell: session ID if resuming, undefined if fresh shell
  resumeSessionId?: string;
  // Provider to use when resuming an existing session
  resumeProvider?: SandboxProviderType;
  // For shell: optional mount directory for fresh shell
  shellMountDir?: string;
  // For shell: whether running from a git repo
  shellIsGitRepo?: boolean;
  // For shell: provider to use
  shellProvider?: SandboxProviderType;
  // For needs-agent-auth: info needed to retry after login
  authInfo?: {
    agent: AgentType;
    model: string;
    prompt: string;
    mountDir?: string;
    isGitRepo?: boolean;
  };
}

interface ToastState {
  message: string;
  type: ToastType;
}

export interface RunSessionsTuiOptions {
  initialView?: 'prompt' | 'list' | 'starting' | 'detail';
  initialPrompt?: string;
  initialAgent?: AgentType;
  initialModel?: string;
  /** Session to display when initialView is 'detail' */
  initialSession?: HermesSession;
  // Options for starting flow
  serviceId?: string;
  dbFork?: boolean;
  /** Mount local directory instead of git clone */
  mountDir?: string;
  /** Whether running from a git repository (affects git/gh operations) */
  isGitRepo?: boolean;
  /** Sandbox provider override from CLI flag (overrides config) */
  sandboxProvider?: SandboxProviderType;
}

// ============================================================================
// Unified Sessions App
// ============================================================================

interface SessionsAppProps {
  initialView: 'prompt' | 'list' | 'starting' | 'detail';
  initialPrompt?: string;
  initialAgent?: AgentType;
  initialModel?: string;
  /** Session to display when initialView is 'detail' */
  initialSession?: HermesSession;
  provider: SandboxProvider;
  serviceId?: string;
  dbFork?: boolean;
  /** Mount local directory instead of git clone */
  initialMountDir?: string;
  /** Current repo info if in a git repo, null otherwise */
  currentRepoInfo: RepoInfo | null;
  /** Whether running from a git repository (affects git/gh operations) */
  isGitRepo: boolean;
  onComplete: (result: SessionsResult) => void;
}

function SessionsApp({
  initialView,
  initialPrompt,
  initialAgent,
  initialModel,
  initialSession,
  provider,
  serviceId,
  dbFork = true,
  initialMountDir,
  currentRepoInfo,
  isGitRepo,
  onComplete,
}: SessionsAppProps) {
  const [view, setView] = useState<SessionsView>({ type: 'init' });
  const [config, setConfig] = useState<HermesConfig | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  // Counter to force PromptScreen remount (resets all state to defaults)
  const [promptKey, setPromptKey] = useState(0);

  // Use refs to store props/config that we need in async functions
  // This avoids dependency issues with useCallback/useEffect
  const configRef = useRef<HermesConfig | null>(null);
  const propsRef = useRef({
    initialView,
    initialPrompt,
    initialAgent,
    initialModel,
    initialSession,
    serviceId,
    dbFork,
    initialMountDir,
    isGitRepo,
  });

  // Keep refs up to date
  configRef.current = config;
  propsRef.current = {
    initialView,
    initialPrompt,
    initialAgent,
    initialModel,
    initialSession,
    serviceId,
    dbFork,
    initialMountDir,
    isGitRepo,
  };

  const showToast = useCallback((message: string, type: ToastType) => {
    setToast({ message, type });
  }, []);

  // Background auto-update check (fire-and-forget on mount)
  useEffect(() => {
    if (!isCompiledBinary()) return;

    let cancelled = false;

    (async () => {
      try {
        const update = await checkForUpdate();
        if (cancelled || !update) return;

        showToast(`Updating to v${update.latestVersion}...`, 'info');

        await performUpdate(update, (progress) => {
          if (cancelled) return;
          if (progress.phase === 'complete') {
            showToast(progress.message, 'success');
          }
        });
      } catch (err) {
        log.debug({ err }, 'Background auto-update failed');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [showToast]);

  // Start session function - handles the full flow of starting an agent
  const startSession = useCallback(
    async (
      prompt: string,
      agent: AgentType,
      model: string,
      mode: SubmitMode = 'async',
      passedMountDir?: string,
      selectedProvider?: SandboxProviderType,
    ) => {
      try {
        // Use selected provider or fall back to the default provider prop
        const activeProvider = selectedProvider
          ? getSandboxProvider(selectedProvider)
          : provider;

        log.debug(
          {
            agent,
            model,
            prompt,
            mode,
            mountDir: passedMountDir,
            provider: selectedProvider,
          },
          'startSession received',
        );

        const isPlan = mode === 'plan';

        // If using cloud provider, check that setup is complete (token exists)
        if (activeProvider.type === 'cloud') {
          const token = await getDenoToken();
          if (!token) {
            // Transition to cloud setup view, storing the pending action
            setView({
              type: 'cloud-setup',
              pendingStart: {
                prompt,
                agent,
                model,
                mode,
                mountDir: passedMountDir,
              },
            });
            return;
          }
        }

        setView({
          type: 'starting',
          prompt,
          agent,
          model,
          step: 'Preparing sandbox environment',
          mode,
        });
        await activeProvider.ensureImage({
          onProgress: (progress) => {
            if (progress.type === 'pulling-cache') {
              setView((v) =>
                v.type === 'starting' ? { ...v, step: progress.message } : v,
              );
            } else if (progress.type === 'building') {
              setView((v) =>
                v.type === 'starting' ? { ...v, step: progress.message } : v,
              );
            }
          },
        });

        // Check agent credentials before starting container
        setView((v) =>
          v.type === 'starting'
            ? { ...v, step: `Checking ${agent} credentials` }
            : v,
        );
        const agentAuthValid =
          agent === 'claude'
            ? await checkClaudeCredentials(model || undefined)
            : await checkOpencodeCredentials(model || undefined);

        const { isGitRepo: inGitRepo } = propsRef.current;

        // Force mount mode if not in a git repo (Docker only — cloud
        // sandboxes don't support mount mode and always clone from GitHub).
        const mountDir =
          activeProvider.type === 'cloud'
            ? undefined
            : (passedMountDir ?? (!inGitRepo ? process.cwd() : undefined));

        // Cloud sandboxes require a git repo (no mount mode support)
        if (activeProvider.type === 'cloud' && !inGitRepo) {
          showToast(
            'Cloud sandboxes require a git remote. Use Docker for non-git directories.',
            'error',
          );
          setView({ type: 'prompt' });
          return;
        }

        if (!agentAuthValid) {
          // Exit TUI to run interactive login, then retry
          onComplete({
            type: 'needs-agent-auth',
            authInfo: {
              agent,
              model,
              prompt,
              mountDir,
              isGitRepo: inGitRepo,
            },
          });
          return;
        }

        // Get repo info only if in a git repo
        let repoInfo: RepoInfo | null = null;
        if (inGitRepo) {
          setView((v) =>
            v.type === 'starting'
              ? { ...v, step: 'Getting repository info' }
              : v,
          );
          repoInfo = await getRepoInfo();
        }

        // Generate branch name: LLM-generated if we have a prompt, fallback otherwise
        let branchName: string;
        if (prompt) {
          setView((v) =>
            v.type === 'starting'
              ? { ...v, step: 'Generating branch name' }
              : v,
          );
          branchName = await generateBranchName({
            prompt,
            agent,
            model,
          });
        } else {
          branchName = `${mode}-${nanoid(6).toLowerCase()}`;
        }

        // Only ensure gitignore if in a git repo
        if (inGitRepo) {
          await ensureGitignore();
        }

        // Skip DB fork for plan mode
        const { serviceId: svcId, dbFork: doFork } = propsRef.current;
        const effectiveServiceId = svcId ?? configRef.current?.tigerServiceId;
        let forkResult: ForkResult | null = null;
        if (!isPlan && doFork && effectiveServiceId) {
          setView((v) =>
            v.type === 'starting' ? { ...v, step: 'Forking database' } : v,
          );
          forkResult = await forkDatabase(branchName, effectiveServiceId);
        }

        // Only check GitHub credentials if in a git repo
        if (inGitRepo && !(await checkGhCredentials())) {
          throw new Error(
            'GitHub authentication not configured. Run `hermes config` to set up.',
          );
        }

        const isInteractive = mode === 'interactive' || mode === 'plan';
        const agentArgs = isPlan
          ? agent === 'claude'
            ? ['--permission-mode', 'plan']
            : ['--agent', 'plan']
          : undefined;

        setView((v) =>
          v.type === 'starting'
            ? {
                ...v,
                step: mountDir
                  ? 'Starting agent container (mount mode)'
                  : 'Starting agent container',
              }
            : v,
        );
        const session = await activeProvider.create({
          branchName,
          name: branchName,
          prompt,
          repoInfo,
          agent,
          model,
          detach: !isInteractive,
          interactive: isInteractive,
          envVars: forkResult?.envVars,
          mountDir,
          isGitRepo: inGitRepo,
          agentArgs,
          onProgress: (step) => {
            setView((v) => (v.type === 'starting' ? { ...v, step } : v));
          },
        });

        if (isInteractive) {
          // Exit TUI so the caller can attach to the interactive session
          onComplete({
            type: 'attach-session',
            sessionId: session.id,
            session,
            attachProvider: activeProvider.type,
          });
        } else {
          setView({ type: 'detail', session });
        }
      } catch (err) {
        log.error({ err }, 'Failed to start session');
        showToast(
          `Failed to start: ${err instanceof Error ? err.message : String(err)}`,
          'error',
        );
        setView({ type: 'prompt' });
      }
    },
    [showToast, onComplete, provider],
  );

  // Resume session function - handles the full flow of resuming an agent
  const resumeSessionFlow = useCallback(
    async (
      session: HermesSession,
      prompt: string,
      model: string,
      mode: SubmitMode = 'async',
      mountDir?: string,
      selectedProvider?: SandboxProviderType,
    ) => {
      try {
        // Use selected provider or fall back to the default provider prop
        const activeProvider = selectedProvider
          ? getSandboxProvider(selectedProvider)
          : provider;

        log.debug(
          {
            session: session.name,
            model,
            prompt,
            mode,
            mountDir,
            provider: selectedProvider,
          },
          'resumeSessionFlow received',
        );

        const isPlan = mode === 'plan';

        // If using cloud provider, check that setup is complete (token exists)
        if (activeProvider.type === 'cloud') {
          const token = await getDenoToken();
          if (!token) {
            setView({
              type: 'cloud-setup',
              pendingResume: { session, prompt, model, mode, mountDir },
            });
            return;
          }
        }

        setView({
          type: 'resuming',
          session,
          model,
          step: 'Preparing to resume session',
          mode,
        });

        const isInteractive = mode === 'interactive' || mode === 'plan';

        // Build agentArgs for plan mode
        const agentArgs = isPlan
          ? session.agent === 'claude'
            ? ['--permission-mode', 'plan']
            : ['--agent', 'plan']
          : undefined;

        const resumeMode = isInteractive ? 'interactive' : 'detached';

        setView((v) =>
          v.type === 'resuming' ? { ...v, step: 'Resuming session' } : v,
        );

        const newSession = await activeProvider.resume(session.id, {
          mode: resumeMode,
          prompt: resumeMode === 'detached' ? prompt : undefined,
          model,
          mountDir,
          agentArgs,
          onProgress: (step) => {
            setView((v) => (v.type === 'resuming' ? { ...v, step } : v));
          },
        });

        if (isInteractive) {
          // Exit TUI so the caller can attach to the interactive session
          onComplete({
            type: 'attach-session',
            sessionId: newSession.id,
            session: newSession,
            attachProvider: activeProvider.type,
          });
        } else {
          setView({ type: 'detail', session: newSession });
        }
      } catch (err) {
        log.error({ err }, 'Failed to resume session');
        showToast(
          `Failed to resume: ${err instanceof Error ? err.message : String(err)}`,
          'error',
        );
        setView({ type: 'prompt', resumeSession: session });
      }
    },
    [showToast, onComplete, provider],
  );

  // Handle docker setup completion
  const handleDockerComplete = useCallback(
    async (result: DockerSetupResult) => {
      if (result.type === 'cancelled') {
        onComplete({ type: 'quit' });
        return;
      }
      if (result.type === 'error') {
        showToast(result.error ?? 'Docker setup failed', 'error');
        onComplete({ type: 'quit' });
        return;
      }

      // Docker is ready, now check config
      // Check if project config exists (we need it to run the wizard if not)
      if (!(await projectConfig.exists())) {
        setView({ type: 'config' });
        return;
      }

      // Use merged config for runtime values
      const existingConfig = await readConfig();
      setConfig(existingConfig);

      // Go to target view
      const {
        initialView: targetView,
        initialPrompt: prompt,
        initialAgent,
        initialModel,
        initialSession: session,
      } = propsRef.current;

      if (targetView === 'detail' && session) {
        setView({ type: 'detail', session });
      } else if (targetView === 'starting' && prompt) {
        const agent = initialAgent ?? existingConfig.agent ?? 'opencode';
        const model = initialModel ?? existingConfig.model ?? '';
        startSession(prompt, agent, model);
      } else if (targetView === 'prompt') {
        setView({ type: 'prompt' });
      } else {
        setView({ type: 'list' });
      }
    },
    [onComplete, showToast, startSession],
  );

  useEffect(() => {
    if (view.type === 'init') {
      handleDockerComplete({ type: 'ready' });
    }
  }, [view.type, handleDockerComplete]);

  // Handle config wizard completion
  const handleConfigComplete = useCallback(
    async (result: ConfigWizardResult) => {
      if (result.type === 'cancelled') {
        onComplete({ type: 'quit' });
        return;
      }
      if (result.type === 'error') {
        showToast(result.message, 'error');
        onComplete({ type: 'quit' });
        return;
      }

      // Save config (project config)
      await ensureGitignore();
      await projectConfig.write(result.config);
      // Re-read merged config for runtime values
      const mergedConfig = await readConfig();
      setConfig(mergedConfig);

      // Go to target view
      const {
        initialView: targetView,
        initialPrompt: prompt,
        initialAgent,
        initialModel,
        initialSession: session,
      } = propsRef.current;

      if (targetView === 'detail' && session) {
        setView({ type: 'detail', session });
      } else if (targetView === 'starting' && prompt) {
        const agent = initialAgent ?? result.config.agent ?? 'opencode';
        const model = initialModel ?? result.config.model ?? '';
        startSession(prompt, agent, model);
      } else if (targetView === 'prompt') {
        setView({ type: 'prompt' });
      } else {
        setView({ type: 'list' });
      }
    },
    [onComplete, showToast, startSession],
  );

  // Handle resume from session detail - navigate to PromptScreen with resume context
  const handleResume = useCallback((session: HermesSession) => {
    setView({ type: 'prompt', resumeSession: session });
  }, []);

  // Handle cloud setup completion - resume pending start/resume action
  const handleCloudSetupComplete = useCallback(
    (result: CloudSetupResult) => {
      if (result.type === 'cancelled') {
        setView({ type: 'prompt' });
        return;
      }
      if (result.type === 'error') {
        showToast(result.error ?? 'Cloud setup failed', 'error');
        setView({ type: 'prompt' });
        return;
      }

      // Cloud is ready - resume the pending action
      if (view.type === 'cloud-setup') {
        if (view.pendingStart) {
          const { prompt, agent, model, mode, mountDir } = view.pendingStart;
          startSession(prompt, agent, model, mode, mountDir, 'cloud');
        } else if (view.pendingResume) {
          const { session, prompt, model, mode, mountDir } = view.pendingResume;
          resumeSessionFlow(session, prompt, model, mode, mountDir, 'cloud');
        } else {
          setView({ type: 'prompt' });
        }
      } else {
        setView({ type: 'prompt' });
      }
    },
    [view, showToast, startSession, resumeSessionFlow],
  );

  // ---- Initial Loading View ----
  if (view.type === 'init') {
    return (
      <>
        <StartingScreen step="Initializing" />
        {toast && (
          <Toast
            message={toast.message}
            type={toast.type}
            onDismiss={() => setToast(null)}
          />
        )}
      </>
    );
  }

  // ---- Docker Setup View ----
  if (view.type === 'docker') {
    return (
      <>
        <DockerSetup
          title="Docker Setup"
          onComplete={handleDockerComplete}
          showBack={false}
        />
        {toast && (
          <Toast
            message={toast.message}
            type={toast.type}
            onDismiss={() => setToast(null)}
          />
        )}
      </>
    );
  }

  // ---- Cloud Setup View ----
  if (view.type === 'cloud-setup') {
    return (
      <>
        <CloudSetup
          title="Cloud Setup"
          onComplete={handleCloudSetupComplete}
          showBack
          onBack={() => setView({ type: 'prompt' })}
        />
        {toast && (
          <Toast
            message={toast.message}
            type={toast.type}
            onDismiss={() => setToast(null)}
          />
        )}
      </>
    );
  }

  // ---- Config Wizard View ----
  if (view.type === 'config') {
    return (
      <>
        <ConfigWizard onComplete={handleConfigComplete} />
        {toast && (
          <Toast
            message={toast.message}
            type={toast.type}
            onDismiss={() => setToast(null)}
          />
        )}
      </>
    );
  }

  // ---- Prompt Screen View ----
  if (view.type === 'prompt') {
    const { resumeSession: resumeSess } = view;
    return (
      <>
        <PromptScreen
          key={`${resumeSess?.id ?? 'new'}-${promptKey}`}
          defaultAgent={
            resumeSess?.agent ?? initialAgent ?? config?.agent ?? 'opencode'
          }
          defaultModel={resumeSess?.model ?? initialModel ?? config?.model}
          defaultSandboxProvider={
            resumeSess?.provider ?? config?.sandboxProvider ?? provider.type
          }
          resumeSession={resumeSess}
          initialMountDir={resumeSess?.mountDir ?? initialMountDir}
          forceMountMode={!isGitRepo}
          onNewPrompt={() => {
            setPromptKey((k) => k + 1);
            setView({ type: 'prompt' });
          }}
          onSubmit={({
            prompt,
            agent,
            model,
            mode,
            mountDir,
            sandboxProvider: selectedProvider,
          }) => {
            if (resumeSess) {
              // Resume flow - use resumeSessionFlow for loading screen
              resumeSessionFlow(
                resumeSess,
                prompt,
                model,
                mode,
                mountDir,
                selectedProvider,
              );
            } else {
              // Fresh session
              startSession(
                prompt,
                agent,
                model,
                mode,
                mountDir,
                selectedProvider,
              );
            }
          }}
          onShell={(shellMountDir, selectedProvider) => {
            if (resumeSess) {
              // Shell on resumed container
              onComplete({
                type: 'shell',
                resumeSessionId: resumeSess.id,
                resumeProvider: resumeSess.provider,
              });
            } else {
              // Fresh shell container
              onComplete({
                type: 'shell',
                shellMountDir,
                shellIsGitRepo: propsRef.current.isGitRepo,
                shellProvider: selectedProvider,
              });
            }
          }}
          onCancel={() => onComplete({ type: 'quit' })}
          onViewSessions={() => setView({ type: 'list' })}
        />
        {toast && (
          <Toast
            message={toast.message}
            type={toast.type}
            onDismiss={() => setToast(null)}
          />
        )}
        <CommandPaletteHost />
      </>
    );
  }

  // ---- Starting Screen View ----
  if (view.type === 'starting' || view.type === 'resuming') {
    const hint =
      view.mode === 'interactive' || view.mode === 'plan'
        ? 'Hint: press ctrl+\\ to detach an interactive session'
        : undefined;
    return (
      <>
        <StartingScreen step={view.step} hint={hint} />
        {toast && (
          <Toast
            message={toast.message}
            type={toast.type}
            onDismiss={() => setToast(null)}
          />
        )}
      </>
    );
  }

  // ---- Session Detail View ----
  if (view.type === 'detail') {
    return (
      <>
        <SessionDetail
          session={view.session}
          provider={provider}
          onBack={() => setView({ type: 'list' })}
          onAttach={(sessionId) =>
            onComplete({
              type: 'attach',
              sessionId,
              session: view.session,
            })
          }
          onShell={(sessionId) =>
            onComplete({
              type: 'exec-shell',
              sessionId,
              session: view.session,
            })
          }
          onResume={handleResume}
          onSessionDeleted={() => setView({ type: 'list' })}
          onNewPrompt={() => setView({ type: 'prompt' })}
        />
        {toast && (
          <Toast
            message={toast.message}
            type={toast.type}
            onDismiss={() => setToast(null)}
          />
        )}
        <CommandPaletteHost />
      </>
    );
  }

  // ---- Session List View ----
  return (
    <>
      <SessionsList
        provider={provider}
        onSelect={(session) => setView({ type: 'detail', session })}
        onQuit={() => onComplete({ type: 'quit' })}
        onNewTask={() => setView({ type: 'prompt' })}
        onAttach={(session) =>
          onComplete({
            type: 'attach',
            sessionId: session.id,
            session,
          })
        }
        onShell={(session) =>
          onComplete({
            type: 'exec-shell',
            sessionId: session.id,
            session,
          })
        }
        onResume={handleResume}
        currentRepo={currentRepoInfo?.fullName}
      />
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onDismiss={() => setToast(null)}
        />
      )}
      <CommandPaletteHost />
    </>
  );
}

// ============================================================================
// TUI Runner
// ============================================================================

export async function runSessionsTui({
  initialView = 'list',
  initialPrompt,
  initialAgent,
  initialModel,
  serviceId,
  dbFork,
  mountDir,
  isGitRepo,
  sandboxProvider,
}: RunSessionsTuiOptions = {}): Promise<void> {
  const provider = sandboxProvider
    ? getSandboxProvider(sandboxProvider)
    : await getDefaultProvider();
  await provider.ensureReady();

  // Try to detect current repo (returns null if not in a git repo)
  const currentRepoInfo = await tryGetRepoInfo();
  // Use passed isGitRepo if provided, otherwise detect from currentRepoInfo
  const effectiveIsGitRepo = isGitRepo ?? currentRepoInfo !== null;

  // Only require GitHub auth if in a git repo
  if (effectiveIsGitRepo) {
    await ensureGhAuth();
  }

  // Loop: after interactive actions (attach, shell, etc.), return to the TUI
  // instead of exiting the process.
  let nextView: SessionsAppProps['initialView'] = initialView;
  let nextPrompt = initialPrompt;
  let nextAgent = initialAgent;
  let nextModel = initialModel;
  let nextSession: HermesSession | undefined;
  let nextMountDir = mountDir;
  let nextIsGitRepo = isGitRepo;

  while (true) {
    let resolveResult: (result: SessionsResult) => void;
    const resultPromise = new Promise<SessionsResult>((resolve) => {
      resolveResult = resolve;
    });

    const { render, destroy } = await createTui();

    render(
      <CopyOnSelect>
        <SessionsApp
          initialView={nextView}
          initialPrompt={nextPrompt}
          initialAgent={nextAgent}
          initialModel={nextModel}
          initialSession={nextSession}
          provider={provider}
          serviceId={serviceId}
          dbFork={dbFork}
          initialMountDir={nextMountDir}
          currentRepoInfo={currentRepoInfo}
          isGitRepo={nextIsGitRepo ?? effectiveIsGitRepo}
          onComplete={(result) => resolveResult(result)}
        />
      </CopyOnSelect>,
    );

    const result = await resultPromise;

    await destroy();

    // After handling the action, default to returning to the session list
    nextView = 'list';
    nextPrompt = undefined;
    nextAgent = undefined;
    nextModel = undefined;
    nextSession = undefined;
    nextMountDir = mountDir;
    nextIsGitRepo = isGitRepo;

    // Quit exits the loop
    if (result.type === 'quit') {
      break;
    }

    // Handle attach action - needs to happen after TUI cleanup
    if (result.type === 'attach' && result.sessionId) {
      const actionProvider = result.session
        ? getProviderForSession(result.session)
        : provider;
      try {
        await actionProvider.attach(result.sessionId);
      } catch (err) {
        log.error(
          { err, sessionId: result.sessionId },
          'Failed to attach to session',
        );
        console.error(
          `Failed to attach: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Return to the session detail view after detaching (or on error)
      if (result.session) {
        nextView = 'detail';
        nextSession = result.session;
      }
      continue;
    }

    // Handle exec-shell action - open a bash shell in a running container
    if (result.type === 'exec-shell' && result.sessionId) {
      const actionProvider = result.session
        ? getProviderForSession(result.session)
        : provider;
      try {
        await actionProvider.shell(result.sessionId);
      } catch (err) {
        log.error({ err, sessionId: result.sessionId }, 'Failed to open shell');
        console.error(
          `Failed to open shell: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Return to the session detail view after exiting the shell (or on error)
      if (result.session) {
        nextView = 'detail';
        nextSession = result.session;
      }
      continue;
    }

    // Handle attach-session — attach to a newly created/resumed interactive session
    if (result.type === 'attach-session' && result.sessionId) {
      const actionProvider = getSandboxProvider(
        result.attachProvider ?? provider.type,
      );
      try {
        await actionProvider.attach(result.sessionId);
      } catch (err) {
        log.error(
          { err, sessionId: result.sessionId },
          'Failed to attach to new session',
        );
        console.error(
          `Failed to attach: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Return to the session detail view after detaching (or on error)
      if (result.session) {
        nextView = 'detail';
        nextSession = result.session;
      }
      continue;
    }

    // Handle shell action - start bash shell in container
    if (result.type === 'shell') {
      enterSubprocessScreen();
      try {
        if (result.resumeSessionId) {
          // Shell on resumed container
          const actionProvider = getSandboxProvider(
            result.resumeProvider ?? provider.type,
          );
          const resumed = await actionProvider.resume(result.resumeSessionId, {
            mode: 'shell',
          });
          await actionProvider.shell(resumed.id);
        } else {
          // Fresh shell container
          const actionProvider = getSandboxProvider(
            result.shellProvider ?? provider.type,
          );
          const shellRepoInfo = result.shellIsGitRepo
            ? await getRepoInfo()
            : null;
          await actionProvider.createShell({
            repoInfo: shellRepoInfo,
            mountDir: result.shellMountDir,
            isGitRepo: result.shellIsGitRepo,
          });
        }
      } catch (err) {
        log.error({ err }, 'Failed to start shell');
        console.error(`Failed to start shell: ${err}`);
      }
      resetTerminal();
      continue;
    }

    // Handle needs-agent-auth action - run interactive login and retry
    if (result.type === 'needs-agent-auth' && result.authInfo) {
      const { agent, model, prompt } = result.authInfo;
      const agentName = agent === 'claude' ? 'Claude' : 'Opencode';

      console.log(`\n${agentName} credentials are missing or expired.`);
      console.log(`Starting ${agentName} login...\n`);

      const authResult =
        agent === 'claude'
          ? await ensureClaudeAuth()
          : await ensureOpencodeAuth();

      if (!authResult) {
        console.error(`\nError: ${agentName} login failed`);
        process.exit(1);
      }

      console.log(`\n${agentName} login successful. Resuming...\n`);

      // Set up the next iteration to continue where we left off
      nextView = 'starting';
      nextPrompt = prompt;
      nextAgent = agent;
      nextModel = model;
      nextMountDir = result.authInfo.mountDir;
      nextIsGitRepo = result.authInfo.isGitRepo;
    }
  }
}

// ============================================================================
// CLI Output Functions
// ============================================================================

type OutputFormat = 'tui' | 'table' | 'json' | 'yaml';

interface SessionsOptions {
  output: OutputFormat;
  all: boolean;
}

export function getStatusDisplay(session: HermesSession): string {
  switch (session.status) {
    case 'running':
      return '\x1b[32mrunning\x1b[0m'; // green
    case 'exited':
      if (session.exitCode === 0) {
        return '\x1b[34mcomplete\x1b[0m'; // blue
      }
      if (session.exitCode == null) {
        return '\x1b[33mexited\x1b[0m'; // yellow
      }
      return `\x1b[31mfailed (${session.exitCode})\x1b[0m`; // red
    case 'stopped':
      return '\x1b[33mstopped\x1b[0m'; // yellow
    case 'unknown':
      return '\x1b[90munknown\x1b[0m'; // gray
    default:
      return session.status;
  }
}

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 3)}...`;
}

function printTable(sessions: HermesSession[]): void {
  const headers = ['NAME', 'STATUS', 'AGENT', 'REPO', 'CREATED', 'PROMPT'];
  const rows = sessions.map((s) => [
    s.name,
    getStatusDisplay(s),
    s.model ? `${s.agent}/${s.model}` : s.agent,
    s.repo,
    s.created ? formatRelativeTime(s.created) : 'unknown',
    truncate(s.prompt, 50),
  ]);

  // ANSI escape code pattern for stripping color codes
  // biome-ignore lint/suspicious/noControlCharactersInRegex: needed for ANSI codes
  const ansiPattern = /\x1b\[[0-9;]*m/g;

  // Calculate max widths (accounting for ANSI codes in status)
  const colWidths = headers.map((h, i) => {
    const dataWidths = rows.map((r) => {
      const cell = r[i];
      if (cell === undefined) return 0;
      const stripped = cell.replace(ansiPattern, '');
      return stripped.length;
    });
    const maxDataWidth = Math.max(0, ...dataWidths);
    return Math.max(h.length, maxDataWidth);
  });

  // Print header
  const headerLine = headers
    .map((h, i) => h.padEnd(colWidths[i] ?? 0))
    .join('  ');
  console.log(`\x1b[1m${headerLine}\x1b[0m`);

  // Print rows
  for (const row of rows) {
    const line = row
      .map((cell, i) => {
        const stripped = cell.replace(ansiPattern, '');
        const colWidth = colWidths[i] ?? 0;
        const padding = colWidth - stripped.length;
        return cell + ' '.repeat(Math.max(0, padding));
      })
      .join('  ');
    console.log(line);
  }
}

// ============================================================================
// Command Action
// ============================================================================

async function sessionsAction(options: SessionsOptions): Promise<void> {
  // TUI mode is default
  if (options.output === 'tui') {
    await runSessionsTui({ initialView: 'list' });
    return;
  }

  // CLI output modes
  const sessions = await listAllSessions();

  // Filter to only running sessions unless --all is specified
  const filteredSessions = options.all
    ? sessions
    : sessions.filter((s) => s.status === 'running');

  if (options.output === 'json') {
    console.log(JSON.stringify(filteredSessions, null, 2));
    return;
  }

  if (options.output === 'yaml') {
    if (filteredSessions.length === 0) {
      console.log('[]');
    } else {
      console.log(YAML.stringify(filteredSessions, null, 2));
    }
    return;
  }

  // Table output
  if (filteredSessions.length === 0) {
    if (options.all) {
      console.log('No hermes sessions found.');
    } else {
      console.log('No running hermes sessions. Use --all to see all sessions.');
    }
    return;
  }

  console.log('');
  printTable(filteredSessions);
  console.log('');

  if (!options.all) {
    const totalSessions = sessions.length;
    const runningSessions = filteredSessions.length;
    if (totalSessions > runningSessions) {
      console.log(
        `Showing ${runningSessions} running session(s). Use --all to see all ${totalSessions} session(s).`,
      );
      console.log('');
    }
  }
}

// ============================================================================
// Command Definition
// ============================================================================

export const sessionsCommand = new Command('sessions')
  .aliases(['list', 'session', 'status', 's'])
  .description('Show all hermes sessions and their status')
  .option(
    '-o, --output <format>',
    'Output format: tui, table, json, yaml',
    'tui',
  )
  .option(
    '-a, --all',
    'Show all sessions (including stopped) in table/json/yaml output',
  )
  .action(sessionsAction);

// Subcommand to remove/clean up sessions
const cleanCommand = new Command('clean')
  .description('Remove stopped hermes containers')
  .option('-a, --all', 'Remove all containers (including running)')
  .option('-f, --force', 'Skip confirmation')
  .action(async (options: { all: boolean; force: boolean }) => {
    const sessions = await listAllSessions();

    const toRemove = options.all
      ? sessions
      : sessions.filter((s) => s.status !== 'running');

    if (toRemove.length === 0) {
      console.log('No containers to remove.');
      return;
    }

    const displayName = (s: HermesSession) => s.containerName ?? s.id;

    console.log(`Found ${toRemove.length} container(s) to remove:`);
    for (const session of toRemove) {
      console.log(`  - ${displayName(session)} (${session.status})`);
    }

    if (!options.force) {
      const readline = await import('node:readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const answer = await new Promise<string>((resolve) => {
        rl.question('\nProceed? [y/N] ', resolve);
      });
      rl.close();

      if (answer.toLowerCase() !== 'y') {
        console.log('Cancelled.');
        return;
      }
    }

    console.log('');
    for (const session of toRemove) {
      const name = displayName(session);
      try {
        const actionProvider = getProviderForSession(session);
        await actionProvider.remove(session.id);
        console.log(`Removed ${name}`);
      } catch (err) {
        log.error({ err }, `Failed to remove ${name}`);
        console.error(`Failed to remove ${name}: ${err}`);
      }
    }
  });

sessionsCommand.addCommand(cleanCommand);
