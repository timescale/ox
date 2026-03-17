import { create } from 'zustand';
import type { AgentType } from '../services/config';
import type { PullLayer } from '../services/docker';
import type {
  AgentMode,
  OxSession,
  SandboxProviderType,
  ShellSession,
} from '../services/sandbox';

// ============================================================================
// View Types
// ============================================================================

export type SessionsView =
  | { type: 'init' } // Initial loading state
  | { type: 'docker' }
  | { type: 'config'; returnToPrompt?: { resumeSession?: OxSession } }
  | {
      type: 'cloud-setup';
      // Store the pending action so we can resume after setup completes
      pendingStart?: {
        prompt: string;
        agent: AgentType;
        model: string;
        mode: AgentMode;
        mountDir?: string;
      };
      pendingResume?: {
        session: OxSession;
        prompt: string;
        model: string;
        mode: AgentMode;
        mountDir?: string;
      };
    }
  | { type: 'prompt'; resumeSession?: OxSession }
  | {
      type: 'starting';
      prompt: string;
      agent: AgentType;
      model: string;
      step: string;
      /** Latest output line from the current build step */
      detail?: string;
      mode: AgentMode;
      layers?: PullLayer[];
    }
  | {
      type: 'resuming';
      session: OxSession;
      model: string;
      step: string;
      mode: AgentMode;
    }
  | { type: 'starting-shell'; step: string; detail?: string }
  | { type: 'detail'; session: OxSession }
  | { type: 'list' }
  | { type: 'resources' }
  | { type: 'setup-db'; returnToPrompt?: { resumeSession?: OxSession } }
  | {
      type: 'build-error';
      title: string;
      message: string;
      outputLines: string[];
    };

// ============================================================================
// Result Types (for exiting the TUI)
// ============================================================================

export interface SessionsResult {
  type:
    | 'quit'
    | 'attach'
    | 'attach-session'
    | 'exec-shell'
    | 'shell'
    | 'connect-shell'
    | 'needs-agent-auth'
    | 'needs-gh-auth';
  sessionId?: string;
  // For attach/exec-shell: the session to return to after detaching
  session?: OxSession;
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
  // For connect-shell: prepared shell session ready to connect
  shellSession?: ShellSession;
  // For needs-agent-auth: info needed to retry after login
  authInfo?: {
    agent: AgentType;
    model: string;
    prompt: string;
    mountDir?: string;
    isGitRepo?: boolean;
  };
  ghAuthInfo?: {
    agent: AgentType;
    model: string;
    prompt: string;
    mountDir?: string;
    isGitRepo?: boolean;
  };
}

// ============================================================================
// Router Store
// ============================================================================

interface RouterState {
  view: SessionsView;
  promptKey: number;

  // Internal: the onComplete callback registered by the outer loop
  _onComplete: ((result: SessionsResult) => void) | null;

  // Initialization — called once before rendering
  init: (onComplete: (result: SessionsResult) => void) => void;

  // Reset — called when re-entering the TUI loop
  reset: () => void;

  // ---- Navigation actions ----
  goToPrompt: (resumeSession?: OxSession) => void;
  goToNewPrompt: () => void;
  goToList: () => void;
  goToDetail: (session: OxSession) => void;
  goToResources: () => void;
  goToCloudSetup: (pending?: {
    pendingStart?: {
      prompt: string;
      agent: AgentType;
      model: string;
      mode: AgentMode;
      mountDir?: string;
    };
    pendingResume?: {
      session: OxSession;
      prompt: string;
      model: string;
      mode: AgentMode;
      mountDir?: string;
    };
  }) => void;
  goToStarting: (params: {
    prompt: string;
    agent: AgentType;
    model: string;
    step: string;
    mode: AgentMode;
    layers?: PullLayer[];
  }) => void;
  goToResuming: (params: {
    session: OxSession;
    model: string;
    step: string;
    mode: AgentMode;
  }) => void;
  goToStartingShell: (step: string) => void;
  goToDocker: () => void;
  goToConfig: (returnToPrompt?: { resumeSession?: OxSession }) => void;
  goToSetupDb: (returnToPrompt?: { resumeSession?: OxSession }) => void;
  goToBuildError: (
    title: string,
    message: string,
    outputLines: string[],
  ) => void;

  // Low-level: for async workflows that do conditional/functional updates
  updateView: (updater: (prev: SessionsView) => SessionsView) => void;

  // ---- Exit actions ----
  quit: () => void;
  attach: (sessionId: string, session: OxSession) => void;
  execShell: (sessionId: string, session: OxSession) => void;
  attachSession: (
    sessionId: string,
    session: OxSession,
    attachProvider?: SandboxProviderType,
  ) => void;
  exitShell: (
    resumeSessionId: string,
    resumeProvider?: SandboxProviderType,
  ) => void;
  connectShell: (shellSession: ShellSession) => void;
  needsAgentAuth: (authInfo: NonNullable<SessionsResult['authInfo']>) => void;
  needsGhAuth: (ghAuthInfo: NonNullable<SessionsResult['ghAuthInfo']>) => void;
}

export const useRouterStore = create<RouterState>()((set, get) => ({
  view: { type: 'init' },
  promptKey: 0,
  _onComplete: null,

  init: (onComplete) => {
    set({ _onComplete: onComplete, view: { type: 'init' }, promptKey: 0 });
  },

  reset: () => {
    set({ view: { type: 'init' }, promptKey: 0 });
  },

  // ---- Navigation actions ----

  goToPrompt: (resumeSession) => {
    set({ view: { type: 'prompt', resumeSession } });
  },

  goToNewPrompt: () => {
    set((state) => ({
      view: { type: 'prompt' },
      promptKey: state.promptKey + 1,
    }));
  },

  goToList: () => {
    set({ view: { type: 'list' } });
  },

  goToDetail: (session) => {
    set({ view: { type: 'detail', session } });
  },

  goToResources: () => {
    set({ view: { type: 'resources' } });
  },

  goToCloudSetup: (pending) => {
    set({
      view: {
        type: 'cloud-setup',
        pendingStart: pending?.pendingStart,
        pendingResume: pending?.pendingResume,
      },
    });
  },

  goToStarting: (params) => {
    set({ view: { type: 'starting', ...params } });
  },

  goToResuming: (params) => {
    set({ view: { type: 'resuming', ...params } });
  },

  goToStartingShell: (step) => {
    set({ view: { type: 'starting-shell', step } });
  },

  goToDocker: () => {
    set({ view: { type: 'docker' } });
  },

  goToConfig: (returnToPrompt) => {
    set({ view: { type: 'config', returnToPrompt } });
  },

  goToSetupDb: (returnToPrompt) => {
    set({ view: { type: 'setup-db', returnToPrompt } });
  },

  goToBuildError: (title, message, outputLines) => {
    set({ view: { type: 'build-error', title, message, outputLines } });
  },

  updateView: (updater) => {
    set((state) => ({ view: updater(state.view) }));
  },

  // ---- Exit actions ----

  quit: () => {
    get()._onComplete?.({ type: 'quit' });
  },

  attach: (sessionId, session) => {
    get()._onComplete?.({ type: 'attach', sessionId, session });
  },

  execShell: (sessionId, session) => {
    get()._onComplete?.({ type: 'exec-shell', sessionId, session });
  },

  attachSession: (sessionId, session, attachProvider) => {
    get()._onComplete?.({
      type: 'attach-session',
      sessionId,
      session,
      attachProvider,
    });
  },

  exitShell: (resumeSessionId, resumeProvider) => {
    get()._onComplete?.({ type: 'shell', resumeSessionId, resumeProvider });
  },

  connectShell: (shellSession) => {
    get()._onComplete?.({ type: 'connect-shell', shellSession });
  },

  needsAgentAuth: (authInfo) => {
    get()._onComplete?.({ type: 'needs-agent-auth', authInfo });
  },

  needsGhAuth: (ghAuthInfo) => {
    get()._onComplete?.({ type: 'needs-gh-auth', ghAuthInfo });
  },
}));
