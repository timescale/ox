// ============================================================================
// Sandbox Provider Types - Provider-agnostic interface and shared types
// ============================================================================

import type { AgentType } from '../config.ts';
import type { PullLayer } from '../docker.ts';
import type { RepoInfo } from '../git.ts';
import type { RequestSudoFn } from '../portForwarding/sudo.ts';
import type { PortUrl } from '../portForwarding/types.ts';

export type SandboxProviderType = 'docker' | 'cloud';

// Docker-specific exec type (keep for backward compat)
export type ExecType = 'agent' | 'shell';

// How the agent runs in the sandbox (affects interactivity + agent flags)
export type AgentMode = 'async' | 'interactive' | 'plan';

/** Options for attaching to a running sandbox session. */
export interface AttachOptions {
  /** Agent type running in the session (affects terminal mouse handling). */
  agent?: AgentType;
}

// Unified session metadata (provider-agnostic)
export interface OxSession {
  id: string; // containerId (Docker) or sandbox ID (cloud)
  name: string; // human-readable session name
  provider: SandboxProviderType;
  status: 'running' | 'stopped' | 'exited' | 'unknown';
  exitCode?: number;
  agent: AgentType;
  model?: string;
  prompt: string;
  branch: string;
  repo: string;
  created: string; // ISO timestamp
  interactive: boolean;
  execType?: ExecType;
  resumedFrom?: string;
  mountDir?: string; // Docker mount mode only
  region?: string; // cloud only
  containerName?: string; // Docker only
  volumeSlug?: string; // cloud only
  snapshotSlug?: string; // cloud only (for resume)
  startedAt?: string;
  finishedAt?: string;
  agentMode?: AgentMode;
  /** Port forwarding URLs for this session (when appPort configured) */
  portUrls?: PortUrl[];
}

// Options for creating a new sandbox
export interface CreateSandboxOptions {
  name: string;
  branchName: string;
  prompt: string;
  repoInfo: RepoInfo | null;
  agent: AgentType;
  model?: string;
  interactive: boolean;
  envVars?: Record<string, string>;
  mountDir?: string; // Docker-only: local dir mount
  isGitRepo?: boolean;
  agentArgs?: string[];
  agentMode?: AgentMode;
  initScript?: string;
  overlayMounts?: string[];
  onProgress?: (step: string) => void;
  requestSudo?: RequestSudoFn;
}

// Options for creating a shell sandbox
export interface CreateShellSandboxOptions {
  repoInfo: RepoInfo | null;
  mountDir?: string;
  isGitRepo?: boolean;
  onProgress?: (step: string) => void;
}

// Handle returned by createShell for split connect/cleanup lifecycle
export interface ShellSession {
  /** Connect to the shell (SSH/docker attach). Blocks until the user exits. */
  connect: () => Promise<void>;
  /**
   * Clean up resources (kill sandbox, delete volume, etc.).
   * Safe to call multiple times. Errors are swallowed (best-effort).
   */
  cleanup: () => Promise<void>;
}

// Options for resuming a stopped session
export interface ResumeSandboxOptions {
  mode: 'interactive' | 'detached' | 'shell';
  prompt?: string;
  model?: string;
  mountDir?: string;
  agentArgs?: string[];
  agentMode?: AgentMode;
  onProgress?: (step: string) => void;
  requestSudo?: RequestSudoFn;
}

// Container resource stats
export interface SandboxStats {
  id: string;
  cpuPercent: number;
  memUsage: string;
  memPercent: number;
}

// Async log stream
export interface LogStream {
  lines: AsyncIterable<string>;
  stop(): void;
}

// Image/snapshot build progress (provider-agnostic)
export type SandboxBuildProgress =
  | { type: 'checking' }
  | { type: 'exists' }
  | { type: 'pulling'; message: string; layers?: PullLayer[] }
  | { type: 'pulling-cache'; message: string; layers?: PullLayer[] }
  | { type: 'building'; message: string }
  | { type: 'done' };

// The main provider interface
export interface SandboxProvider {
  readonly type: SandboxProviderType;

  // Setup -- ensure runtime/image/snapshot is ready
  ensureReady(): Promise<void>;

  // Image/snapshot management
  ensureImage(options?: {
    agent?: AgentType;
    onProgress?: (progress: SandboxBuildProgress) => void;
  }): Promise<string>;

  // Lifecycle — create/resume always return a session (never attach internally).
  // For interactive sessions, the caller should call attach() after create/resume.
  create(options: CreateSandboxOptions): Promise<OxSession>;
  createShell(options: CreateShellSandboxOptions): Promise<ShellSession>;
  resume(sessionId: string, options: ResumeSandboxOptions): Promise<OxSession>;

  // Session management
  list(): Promise<OxSession[]>;
  get(sessionId: string): Promise<OxSession | null>;
  remove(sessionId: string): Promise<void>;
  stop(sessionId: string): Promise<void>;

  // Interactive access
  attach(sessionId: string, options?: AttachOptions): Promise<void>;
  shell(sessionId: string): Promise<void>;

  // Logs
  getLogs(sessionId: string, tail?: number): Promise<string>;
  streamLogs(sessionId: string): LogStream;

  // Stats (optional -- cloud does not support CPU/mem stats)
  getStats?(
    sessionIds: string[],
    signal?: AbortSignal,
  ): Promise<Map<string, SandboxStats>>;

  /** Read a file from a running sandbox. Returns null if file doesn't exist or sandbox is not running. */
  readFile(sessionId: string, path: string): Promise<string | null>;

  /** Write a file into a running sandbox. No-op if sandbox is not running. */
  writeFile(sessionId: string, path: string, content: string): Promise<void>;
}
