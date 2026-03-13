// ============================================================================
// Session Workflow Store - Async session lifecycle workflows
// ============================================================================
//
// Owns the core async workflows (startSession, resumeSessionFlow,
// startShellSession) and handler callbacks that were previously large
// useCallback functions in the SessionsApp component.
// ============================================================================

import type { CliRenderer } from '@opentui/core';
import { nanoid } from 'nanoid';
import { create } from 'zustand';
import type { ConfigWizardResult } from '../commands/config.tsx';
import type { CloudSetupResult } from '../components/CloudSetup.tsx';
import type { DockerSetupResult } from '../components/DockerSetup.tsx';
import type { SetupDbResult } from '../components/SetupDb.tsx';
import type { AgentType, OxConfig } from '../services/config.ts';
import { projectConfig, readConfig } from '../services/config.ts';
import type { ForkResult } from '../services/db.ts';
import { forkDatabase } from '../services/db.ts';
import { getDenoToken } from '../services/deno.ts';
import type { PullLayer } from '../services/docker.ts';
import { ensureDockerImage } from '../services/docker.ts';
import { checkGhCredentials } from '../services/gh.ts';
import { generateBranchName } from '../services/git.ts';
import { log } from '../services/logger.ts';
import type { RequestSudoFn } from '../services/portForwarding/sudo.ts';
import { getSandboxProvider } from '../services/sandbox/index.ts';
import type {
  AgentMode,
  OxSession,
  SandboxProvider,
  SandboxProviderType,
} from '../services/sandbox/types.ts';
import { ensureGitignore } from '../utils/shell.ts';
import { usePromptSettingsStore } from './promptSettingsStore.ts';
import { useReadinessStore, waitForAgentAuthCheck } from './readinessStore.ts';
import { useRepoStore } from './repoStore.ts';
import { useRouterStore } from './routerStore.ts';
import { useToastStore } from './toastStore.ts';

// ============================================================================
// Types
// ============================================================================

export type InitialView =
  | 'prompt'
  | 'list'
  | 'starting'
  | 'detail'
  | 'resources';

export interface SessionWorkflowState {
  // ---- Initialization state ----
  config: OxConfig | null;
  provider: SandboxProvider | null;
  cliSandboxProvider: SandboxProviderType | undefined;
  serviceId: string | undefined;
  dbFork: boolean;
  initialMountDir: string | undefined;
  initialView: InitialView;
  initialPrompt: string | undefined;
  initialAgent: AgentType | undefined;
  initialModel: string | undefined;
  initialSession: OxSession | undefined;
  renderer: CliRenderer | null;
  requestSudo: RequestSudoFn | undefined;

  // ---- Actions ----
  initialize: (params: {
    provider: SandboxProvider;
    cliSandboxProvider?: SandboxProviderType;
    serviceId?: string;
    dbFork?: boolean;
    initialMountDir?: string;
    initialView?: InitialView;
    initialPrompt?: string;
    initialAgent?: AgentType;
    initialModel?: string;
    initialSession?: OxSession;
  }) => void;

  setConfig: (config: OxConfig) => void;

  startSession: (
    prompt: string,
    agent: AgentType,
    model: string,
    mode?: AgentMode,
    passedMountDir?: string,
    selectedProvider?: SandboxProviderType,
  ) => Promise<void>;

  resumeSessionFlow: (
    session: OxSession,
    prompt: string,
    model: string,
    mode?: AgentMode,
    mountDir?: string,
    selectedProvider?: SandboxProviderType,
  ) => Promise<void>;

  startShellSession: (
    shellMountDir?: string,
    shellIsGitRepo?: boolean,
    selectedProvider?: SandboxProviderType,
  ) => Promise<void>;

  handleResume: (session: OxSession) => void;

  handleDockerComplete: (result: DockerSetupResult) => void;

  handleConfigComplete: (result: ConfigWizardResult) => Promise<void>;

  handleSetupDbComplete: (result: SetupDbResult) => void;

  handleCloudSetupComplete: (result: CloudSetupResult) => void;

  setRenderer: (renderer: CliRenderer | null) => void;

  navigateToTargetView: (
    cfg: OxConfig,
    initialView: 'prompt' | 'list' | 'starting' | 'detail' | 'resources',
    initialPrompt?: string,
  ) => void;
}

// ============================================================================
// Store
// ============================================================================

export const useSessionWorkflowStore = create<SessionWorkflowState>()(
  (set, get) => ({
    // ---- Initial state ----
    config: null,
    provider: null,
    cliSandboxProvider: undefined,
    serviceId: undefined,
    dbFork: true,
    initialMountDir: undefined,
    initialView: 'list',
    initialPrompt: undefined,
    initialAgent: undefined,
    initialModel: undefined,
    initialSession: undefined,
    renderer: null,
    requestSudo: undefined,

    // ---- Actions ----

    setRenderer: (renderer) => {
      const requestSudo: RequestSudoFn | undefined = renderer
        ? async (reason: string): Promise<boolean> => {
            try {
              renderer.suspend();
              process.stderr.write(`\r\n${reason}\r\n\r\n`);
              const proc = Bun.spawn(['sudo', '-v'], {
                stdin: 'inherit',
                stdout: 'inherit',
                stderr: 'inherit',
              });
              await proc.exited;
              return proc.exitCode === 0;
            } catch (err) {
              log.warn({ err }, 'sudo -v failed');
              return false;
            } finally {
              renderer.resume();
            }
          }
        : undefined;
      set({ renderer, requestSudo });
    },

    initialize: (params) => {
      set({
        provider: params.provider,
        cliSandboxProvider: params.cliSandboxProvider,
        serviceId: params.serviceId,
        dbFork: params.dbFork ?? true,
        initialMountDir: params.initialMountDir,
        initialView: params.initialView ?? 'list',
        initialPrompt: params.initialPrompt,
        initialAgent: params.initialAgent,
        initialModel: params.initialModel,
        initialSession: params.initialSession,
      });
    },

    setConfig: (config) => {
      set({ config });
    },

    // Start session - handles the full flow of starting an agent
    startSession: async (
      prompt,
      agent,
      model,
      mode = 'async',
      passedMountDir?,
      selectedProvider?,
    ) => {
      const {
        updateView,
        goToCloudSetup,
        goToStarting,
        goToPrompt,
        goToDetail,
      } = useRouterStore.getState();
      try {
        const state = get();
        // Use selected provider or fall back to the default provider
        const activeProvider = selectedProvider
          ? getSandboxProvider(selectedProvider)
          : state.provider;

        if (!activeProvider) {
          throw new Error('No sandbox provider available');
        }

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
            goToCloudSetup({
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

        goToStarting({
          prompt,
          agent,
          model,
          step: 'Preparing sandbox environment',
          mode,
        });
        await activeProvider.ensureImage({
          agent,
          onProgress: (progress) => {
            if (
              progress.type === 'pulling' ||
              progress.type === 'pulling-cache'
            ) {
              updateView((v) =>
                v.type === 'starting'
                  ? { ...v, step: progress.message, layers: progress.layers }
                  : v,
              );
            } else if (progress.type === 'building') {
              updateView((v) =>
                v.type === 'starting'
                  ? { ...v, step: progress.message, layers: undefined }
                  : v,
              );
            }
          },
        });

        // Credential checks always run via Docker containers, so ensure the
        // Docker image is available even when using a non-Docker sandbox provider.
        if (activeProvider.type !== 'docker') {
          await ensureDockerImage({
            onProgress: (progress) => {
              if (
                progress.type === 'pulling' ||
                progress.type === 'pulling-cache'
              ) {
                updateView((v) =>
                  v.type === 'starting'
                    ? { ...v, step: progress.message, layers: progress.layers }
                    : v,
                );
              } else if (progress.type === 'building') {
                updateView((v) =>
                  v.type === 'starting'
                    ? { ...v, step: progress.message, layers: undefined }
                    : v,
                );
              }
            },
          });
        }

        // Check agent credentials before starting container
        // Use cached result from readiness store if available
        const readiness = useReadinessStore.getState();
        const cachedAgentAuth =
          agent === 'claude'
            ? readiness.claudeAuth
            : agent === 'codex'
              ? readiness.codexAuth
              : readiness.opencodeAuth;
        let agentAuthValid: boolean;
        if (cachedAgentAuth === 'ready') {
          agentAuthValid = true;
        } else if (cachedAgentAuth === 'invalid') {
          agentAuthValid = false;
        } else {
          updateView((v) =>
            v.type === 'starting'
              ? { ...v, step: `Checking ${agent} credentials` }
              : v,
          );
          // If a background readiness check is already in flight, await it
          // instead of launching a duplicate.  Concurrent checks race on
          // OAuth token refresh and cause "refresh_token_reused" errors.
          const pending = waitForAgentAuthCheck(agent);
          if (pending) {
            agentAuthValid = await pending;
          } else {
            const { checkClaudeCredentials } = await import(
              '../services/claude.ts'
            );
            const { checkCodexCredentials } = await import(
              '../services/codex.ts'
            );
            const { checkOpencodeCredentials } = await import(
              '../services/opencode.ts'
            );
            switch (agent) {
              case 'claude':
                agentAuthValid = await checkClaudeCredentials(
                  model || undefined,
                );
                break;
              case 'codex':
                agentAuthValid = await checkCodexCredentials();
                break;
              default:
                agentAuthValid = await checkOpencodeCredentials(
                  model || undefined,
                );
                break;
            }
          }
        }

        const { isGitRepo: inGitRepo } = useRepoStore.getState();

        // Force mount mode if not in a git repo (Docker only — cloud
        // sandboxes don't support mount mode and always clone from GitHub).
        const mountDir =
          activeProvider.type === 'cloud'
            ? undefined
            : (passedMountDir ?? (!inGitRepo ? process.cwd() : undefined));

        // Cloud sandboxes require a git repo (no mount mode support)
        if (activeProvider.type === 'cloud' && !inGitRepo) {
          useToastStore
            .getState()
            .show(
              'Cloud sandboxes require a git remote. Use Docker for non-git directories.',
              'error',
            );
          goToPrompt();
          return;
        }

        if (!agentAuthValid) {
          // Exit TUI to run interactive login, then retry
          useRouterStore.getState().needsAgentAuth({
            agent,
            model,
            prompt,
            mountDir,
            isGitRepo: inGitRepo,
          });
          return;
        }

        // Read repo info from the centralized store (already fetched)
        const { repoInfo } = useRepoStore.getState();

        // Generate branch name: LLM-generated if we have a prompt, fallback otherwise
        let branchName: string;
        if (prompt) {
          updateView((v) =>
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
        const {
          serviceId: svcId,
          dbFork: doFork,
          config: currentConfig,
        } = get();
        const effectiveServiceId = svcId ?? currentConfig?.tigerServiceId;
        let forkResult: ForkResult | null = null;
        if (!isPlan && doFork && effectiveServiceId) {
          updateView((v) =>
            v.type === 'starting' ? { ...v, step: 'Forking database' } : v,
          );
          forkResult = await forkDatabase(branchName, effectiveServiceId);
        }

        // Only check GitHub credentials if in a git repo
        // Use cached result from readiness store if available
        const cachedGhAuth = useReadinessStore.getState().ghAuth;
        const ghAuthValid =
          cachedGhAuth === 'ready'
            ? true
            : cachedGhAuth === 'invalid'
              ? false
              : await checkGhCredentials();
        if (inGitRepo && !ghAuthValid) {
          useRouterStore.getState().needsGhAuth({
            agent,
            model,
            prompt,
            mountDir,
            isGitRepo: inGitRepo,
          });
          return;
        }

        const isInteractive = mode === 'interactive' || mode === 'plan';
        const agentArgs = isPlan
          ? agent === 'claude'
            ? ['--permission-mode', 'plan']
            : ['--agent', 'plan']
          : undefined;

        updateView((v) =>
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
          agentMode: mode,
          onProgress: (step) => {
            updateView((v) => (v.type === 'starting' ? { ...v, step } : v));
          },
          requestSudo: get().requestSudo,
        });

        if (isInteractive) {
          // Exit TUI so the caller can attach to the interactive session
          useRouterStore
            .getState()
            .attachSession(session.id, session, activeProvider.type);
        } else {
          goToDetail(session);
        }
      } catch (err) {
        log.error({ err }, 'Failed to start session');
        useToastStore
          .getState()
          .show(
            `Failed to start: ${err instanceof Error ? err.message : String(err)}`,
            'error',
          );
        useRouterStore.getState().goToPrompt();
      }
    },

    // Resume session - handles the full flow of resuming an agent
    resumeSessionFlow: async (
      session,
      prompt,
      model,
      mode = 'async',
      mountDir?,
      selectedProvider?,
    ) => {
      const {
        updateView,
        goToCloudSetup,
        goToResuming,
        goToDetail,
        goToPrompt,
      } = useRouterStore.getState();
      try {
        const state = get();
        // Use selected provider or fall back to the default provider
        const activeProvider = selectedProvider
          ? getSandboxProvider(selectedProvider)
          : state.provider;

        if (!activeProvider) {
          throw new Error('No sandbox provider available');
        }

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
            goToCloudSetup({
              pendingResume: { session, prompt, model, mode, mountDir },
            });
            return;
          }
        }

        goToResuming({
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

        updateView((v) =>
          v.type === 'resuming' ? { ...v, step: 'Resuming session' } : v,
        );

        const newSession = await activeProvider.resume(session.id, {
          mode: resumeMode,
          prompt: resumeMode === 'detached' ? prompt : undefined,
          model,
          mountDir,
          agentArgs,
          agentMode: mode,
          onProgress: (step) => {
            updateView((v) => (v.type === 'resuming' ? { ...v, step } : v));
          },
          requestSudo: get().requestSudo,
        });

        if (isInteractive) {
          // Exit TUI so the caller can attach to the interactive session
          useRouterStore
            .getState()
            .attachSession(newSession.id, newSession, activeProvider.type);
        } else {
          goToDetail(newSession);
        }
      } catch (err) {
        log.error({ err }, 'Failed to resume session');
        useToastStore
          .getState()
          .show(
            `Failed to resume: ${err instanceof Error ? err.message : String(err)}`,
            'error',
          );
        goToPrompt(session);
      }
    },

    // Start shell session - prepare the shell sandbox and hand off to connect
    startShellSession: async (
      shellMountDir?,
      shellIsGitRepo?,
      selectedProvider?,
    ) => {
      const { updateView, goToStartingShell, goToPrompt, connectShell } =
        useRouterStore.getState();
      try {
        const state = get();
        const activeProvider = selectedProvider
          ? getSandboxProvider(selectedProvider)
          : state.provider;

        if (!activeProvider) {
          throw new Error('No sandbox provider available');
        }

        goToStartingShell('Preparing sandbox environment');

        await activeProvider.ensureImage({
          onProgress: (progress) => {
            if (
              progress.type === 'pulling-cache' ||
              progress.type === 'building'
            ) {
              updateView((v) =>
                v.type === 'starting-shell'
                  ? { ...v, step: progress.message }
                  : v,
              );
            }
          },
        });

        const shellRepoInfo = shellIsGitRepo
          ? useRepoStore.getState().repoInfo
          : null;

        const shell = await activeProvider.createShell({
          repoInfo: shellRepoInfo,
          mountDir: shellMountDir,
          isGitRepo: shellIsGitRepo,
          onProgress: (step) => {
            updateView((v) =>
              v.type === 'starting-shell' ? { ...v, step } : v,
            );
          },
        });

        // Shell is prepared — exit TUI so the outer loop can connect
        connectShell(shell);
      } catch (err) {
        log.error({ err }, 'Failed to start shell');
        useToastStore
          .getState()
          .show(
            `Failed to start shell: ${err instanceof Error ? err.message : String(err)}`,
            'error',
          );
        goToPrompt();
      }
    },

    // Handle resume from session detail
    handleResume: (session) => {
      if (session.interactive) {
        // Interactive/plan sessions: skip prompt screen — agents don't support
        // new prompts in continue mode. Resume directly with -c.
        get().resumeSessionFlow(
          session,
          '', // no prompt for interactive continue
          session.model ?? '',
          session.agentMode ?? 'interactive',
          session.mountDir,
          session.provider,
        );
      } else {
        // Detached sessions: show prompt screen for new prompt entry
        useRouterStore.getState().goToPrompt(session);
      }
    },

    // Handle docker setup completion (install-only in phase 2)
    handleDockerComplete: (result) => {
      if (result.type === 'cancelled') {
        useRouterStore.getState().quit();
        return;
      }
      if (result.type === 'error') {
        useToastStore
          .getState()
          .show(result.error ?? 'Docker setup failed', 'error');
        useRouterStore.getState().quit();
        return;
      }

      // Docker was installed — go back to prompt and re-run checks
      useRouterStore.getState().goToNewPrompt();
      useReadinessStore.getState().reset();
      useReadinessStore.getState().runChecks();
    },

    // Handle config wizard completion
    handleConfigComplete: async (result) => {
      const state = get();
      const currentView = useRouterStore.getState().view;
      const returnToPrompt =
        currentView.type === 'config' ? currentView.returnToPrompt : undefined;

      if (result.type === 'cancelled') {
        if (returnToPrompt) {
          useRouterStore.getState().goToPrompt(returnToPrompt.resumeSession);
        } else {
          useRouterStore.getState().quit();
        }
        return;
      }
      if (result.type === 'error') {
        useToastStore.getState().show(result.message, 'error');
        if (returnToPrompt) {
          useRouterStore.getState().goToPrompt(returnToPrompt.resumeSession);
        } else {
          useRouterStore.getState().quit();
        }
        return;
      }

      // Save config (project config)
      await ensureGitignore();
      await projectConfig.write(result.config);
      // Re-read merged config for runtime values
      const mergedConfig = await readConfig();
      set({ config: mergedConfig });

      // Initialize prompt settings store if not already initialized
      // (covers initial setup flow where config wizard runs before prompt)
      await usePromptSettingsStore.getState().initialize(mergedConfig, {
        agent: state.initialAgent as AgentType | undefined,
        model: state.initialModel,
        sandboxProvider: state.cliSandboxProvider,
      });

      // Return to the prompt when config was launched from there.
      if (returnToPrompt) {
        useRouterStore.getState().goToPrompt(returnToPrompt.resumeSession);
      } else {
        // Initial setup flow: continue to the requested target view.
        const { initialView: targetView, initialPrompt: targetPrompt } = get();
        get().navigateToTargetView(mergedConfig, targetView, targetPrompt);
      }

      useReadinessStore.getState().runChecks();
    },

    // Handle /setup-db completion — return to prompt with toast feedback
    handleSetupDbComplete: (result) => {
      const currentView = useRouterStore.getState().view;
      const resumeSession =
        currentView.type === 'setup-db'
          ? currentView.returnToPrompt?.resumeSession
          : undefined;

      if (result.type === 'cancelled') {
        useRouterStore.getState().goToPrompt(resumeSession);
        return;
      }
      if (result.type === 'unavailable') {
        useToastStore
          .getState()
          .show(
            'Tiger CLI is not installed — cannot configure database service.',
            'error',
          );
        useRouterStore.getState().goToPrompt(resumeSession);
        return;
      }

      // Config was already persisted by the SetupDb component.
      // Re-read merged config so runtime state stays in sync.
      readConfig().then((mergedConfig) => {
        set({ config: mergedConfig });
      });

      const label =
        result.tigerServiceId === null
          ? 'Database service set to (None).'
          : `Database service set to ${result.tigerServiceId}.`;
      useToastStore.getState().show(label, 'success');
      useRouterStore.getState().goToPrompt(resumeSession);
    },

    // Handle cloud setup completion - resume pending start/resume action
    handleCloudSetupComplete: (result) => {
      if (result.type === 'cancelled') {
        useRouterStore.getState().goToPrompt();
        return;
      }
      if (result.type === 'error') {
        useToastStore
          .getState()
          .show(result.error ?? 'Cloud setup failed', 'error');
        useRouterStore.getState().goToPrompt();
        return;
      }

      // Cloud is ready - resume the pending action
      const view = useRouterStore.getState().view;
      if (view.type === 'cloud-setup') {
        if (view.pendingStart) {
          const { prompt, agent, model, mode, mountDir } = view.pendingStart;
          get().startSession(prompt, agent, model, mode, mountDir, 'cloud');
        } else if (view.pendingResume) {
          const { session, prompt, model, mode, mountDir } = view.pendingResume;
          get().resumeSessionFlow(
            session,
            prompt,
            model,
            mode,
            mountDir,
            'cloud',
          );
        } else {
          useRouterStore.getState().goToPrompt();
        }
      } else {
        useRouterStore.getState().goToPrompt();
      }
    },

    // Navigate to the appropriate view based on initialView and config
    navigateToTargetView: (cfg, initialView, initialPrompt?) => {
      const state = get();
      const {
        goToDetail,
        goToStarting,
        goToPrompt,
        goToResources,
        goToList,
        updateView,
      } = useRouterStore.getState();

      if (initialView === 'detail' && state.initialSession) {
        goToDetail(state.initialSession);
      } else if (initialView === 'starting' && initialPrompt != null) {
        const agent = state.initialAgent ?? cfg.agent ?? 'opencode';
        const model = state.initialModel ?? cfg.model ?? '';

        // Non-interactive path: wait for readiness before starting session
        goToStarting({
          prompt: initialPrompt,
          agent,
          model,
          step: 'Preparing environment',
          mode: 'async',
        });

        // Wait for Docker + image to be ready, then start
        const waitAndStart = async () => {
          const store = useReadinessStore.getState();

          // If checks haven't completed, subscribe and wait
          if (store.sandboxBaseImage !== 'ready') {
            await new Promise<void>((resolve, reject) => {
              const unsub = useReadinessStore.subscribe((s) => {
                // Update starting screen with progress
                if (s.dockerRunning === 'starting') {
                  updateView((v) =>
                    v.type === 'starting'
                      ? { ...v, step: 'Starting Docker' }
                      : v,
                  );
                } else if (
                  s.sandboxBaseImage === 'pulling' ||
                  s.sandboxBaseImage === 'checking'
                ) {
                  const layers = s.basePullLayers;
                  const done = layers.filter(
                    (l: PullLayer) =>
                      l.state === 'complete' || l.state === 'exists',
                  ).length;
                  const total = layers.length;
                  const suffix = total > 0 ? ` (${done}/${total} layers)` : '';
                  updateView((v) =>
                    v.type === 'starting'
                      ? {
                          ...v,
                          step: `Pulling sandbox image${suffix}`,
                          layers: s.basePullLayers,
                        }
                      : v,
                  );
                } else if (s.sandboxBaseImage === 'ready') {
                  unsub();
                  resolve();
                } else if (
                  s.sandboxBaseImage === 'error' ||
                  s.dockerRunning === 'not-running' ||
                  s.dockerInstalled === 'not-installed'
                ) {
                  unsub();
                  reject(
                    new Error(s.error ?? 'Docker environment is not available'),
                  );
                }
              });
            });
          }

          get().startSession(initialPrompt, agent, model);
        };

        waitAndStart().catch((err) => {
          log.error({ err }, 'Failed to prepare environment');
          useToastStore
            .getState()
            .show(
              `Failed to prepare environment: ${err instanceof Error ? err.message : String(err)}`,
              'error',
            );
          goToPrompt();
        });
      } else if (initialView === 'prompt') {
        goToPrompt();
      } else if (initialView === 'resources') {
        goToResources();
      } else {
        goToList();
      }
    },
  }),
);
