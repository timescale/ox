import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { SandboxProvider } from '../services/sandbox/types.ts';
import {
  attemptDatabaseFork,
  getSetupDbCompletionMessage,
  useSessionWorkflowStore,
} from './sessionWorkflowStore.ts';

// Minimal mock provider for testing synchronous state management
const mockProvider: SandboxProvider = {
  type: 'docker',
  ensureReady: async () => {},
  ensureImage: async () => '',
  create: async () => ({}) as never,
  createShell: async () => ({}) as never,
  resume: async () => ({}) as never,
  list: async () => [],
  get: async () => null,
  remove: async () => {},
  stop: async () => {},
  attach: async () => {},
  shell: async () => {},
  getLogs: async () => '',
  streamLogs: () => ({ lines: (async function* () {})(), stop: () => {} }),
  readFile: async () => null,
  writeFile: async () => {},
};

describe('getSetupDbCompletionMessage', () => {
  test('describes clearing the database provider', () => {
    expect(
      getSetupDbCompletionMessage({
        type: 'completed',
        dbServiceProvider: null,
        dbServiceId: null,
      }),
    ).toBe('Database provider set to (None).');
  });

  test('includes the provider and selected database id', () => {
    expect(
      getSetupDbCompletionMessage({
        type: 'completed',
        dbServiceProvider: 'ghost',
        dbServiceId: 'db_123',
      }),
    ).toBe('Database provider set to ghost - db_123.');
  });
});

describe('attemptDatabaseFork', () => {
  test('returns null and warns when the fork fails', async () => {
    const showToast = mock(() => {});
    const fork = mock(async () => {
      throw new Error('ghost exited with code 1');
    });

    const result = await attemptDatabaseFork({
      isPlan: false,
      dbFork: true,
      branchName: 'test-branch',
      effectiveServiceId: 'svc-123',
      dbServiceProvider: 'ghost',
      signal: undefined,
      setStep: () => {},
      showToast,
      fork,
    });

    expect(result).toBeNull();
    expect(showToast).toHaveBeenCalledWith(
      'Database fork failed: ghost exited with code 1. Continuing without a forked database.',
      'error',
    );
  });

  test('skips for plan mode and does not call fork', async () => {
    const fork = mock(async () => ({
      service_id: 'fork-1',
      name: 'x',
      envVars: {},
    }));

    const result = await attemptDatabaseFork({
      isPlan: true,
      dbFork: true,
      branchName: 'test-branch',
      effectiveServiceId: 'svc-123',
      dbServiceProvider: 'ghost',
      signal: undefined,
      setStep: () => {},
      showToast: () => {},
      fork,
    });

    expect(result).toBeNull();
    expect(fork).not.toHaveBeenCalled();
  });
});

describe('sessionWorkflowStore', () => {
  afterEach(() => {
    // Reset store to initial state
    useSessionWorkflowStore.setState({
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
    });
  });

  test('starts with null config and provider', () => {
    const state = useSessionWorkflowStore.getState();
    expect(state.config).toBeNull();
    expect(state.provider).toBeNull();
  });

  test('starts with default values', () => {
    const state = useSessionWorkflowStore.getState();
    expect(state.dbFork).toBe(true);
    expect(state.cliSandboxProvider).toBeUndefined();
    expect(state.serviceId).toBeUndefined();
    expect(state.initialMountDir).toBeUndefined();
    expect(state.initialAgent).toBeUndefined();
    expect(state.initialModel).toBeUndefined();
    expect(state.initialSession).toBeUndefined();
  });

  test('initialize sets provider and params', () => {
    const { initialize } = useSessionWorkflowStore.getState();

    initialize({
      provider: mockProvider,
      cliSandboxProvider: 'docker',
      serviceId: 'svc-123',
      dbFork: false,
      initialMountDir: '/tmp/mount',
      initialAgent: 'claude',
      initialModel: 'claude-sonnet-4-20250514',
    });

    const state = useSessionWorkflowStore.getState();
    expect(state.provider).toBe(mockProvider);
    expect(state.cliSandboxProvider).toBe('docker');
    expect(state.serviceId).toBe('svc-123');
    expect(state.dbFork).toBe(false);
    expect(state.initialMountDir).toBe('/tmp/mount');
    expect(state.initialAgent).toBe('claude');
    expect(state.initialModel).toBe('claude-sonnet-4-20250514');
  });

  test('initialize defaults dbFork to true', () => {
    const { initialize } = useSessionWorkflowStore.getState();

    initialize({
      provider: mockProvider,
    });

    const state = useSessionWorkflowStore.getState();
    expect(state.dbFork).toBe(true);
  });

  test('setConfig updates config', () => {
    const { setConfig } = useSessionWorkflowStore.getState();
    const config = {
      agent: 'claude' as const,
      model: 'claude-sonnet-4-20250514',
      dbServiceId: 'svc-456',
    };

    setConfig(config);

    const state = useSessionWorkflowStore.getState();
    expect(state.config).toEqual(config);
  });

  test('setConfig can clear config to null', () => {
    const { setConfig } = useSessionWorkflowStore.getState();
    setConfig({ agent: 'claude' as const });

    // Verify it was set
    expect(useSessionWorkflowStore.getState().config).not.toBeNull();

    // Clear it — use setState directly to set null since setConfig expects OxConfig
    useSessionWorkflowStore.setState({ config: null });
    expect(useSessionWorkflowStore.getState().config).toBeNull();
  });

  test('initialize sets initialView and initialPrompt', () => {
    const { initialize } = useSessionWorkflowStore.getState();

    initialize({
      provider: mockProvider,
      initialView: 'starting',
      initialPrompt: 'add metrics',
    });

    const state = useSessionWorkflowStore.getState();
    expect(state.initialView).toBe('starting');
    expect(state.initialPrompt).toBe('add metrics');
  });

  test('initialize defaults initialView to list', () => {
    const { initialize } = useSessionWorkflowStore.getState();

    initialize({
      provider: mockProvider,
    });

    const state = useSessionWorkflowStore.getState();
    expect(state.initialView).toBe('list');
    expect(state.initialPrompt).toBeUndefined();
  });

  test('initialize with initialSession', () => {
    const { initialize } = useSessionWorkflowStore.getState();
    const session = {
      id: 'sess-1',
      name: 'test-session',
      provider: 'docker' as const,
      status: 'running' as const,
      agent: 'claude' as const,
      prompt: 'test prompt',
      branch: 'main',
      repo: 'test/repo',
      created: new Date().toISOString(),
      interactive: false,
    };

    initialize({
      provider: mockProvider,
      initialSession: session,
    });

    expect(useSessionWorkflowStore.getState().initialSession).toBe(session);
  });
});
