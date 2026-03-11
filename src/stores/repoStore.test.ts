import { afterEach, describe, expect, test } from 'bun:test';
import { useRepoStore } from './repoStore.ts';

describe('repoStore', () => {
  afterEach(() => {
    // Reset to initial state between tests
    useRepoStore.setState({
      repoInfo: null,
      isGitRepo: false,
      fullName: undefined,
    });
  });

  test('initial state has no repo info', () => {
    const state = useRepoStore.getState();
    expect(state.repoInfo).toBeNull();
    expect(state.isGitRepo).toBe(false);
    expect(state.fullName).toBeUndefined();
  });

  test('initialize with repo info sets derived fields', () => {
    useRepoStore.getState().initialize({
      owner: 'timescale',
      repo: 'ox',
      fullName: 'timescale/ox',
    });

    const state = useRepoStore.getState();
    expect(state.repoInfo).toEqual({
      owner: 'timescale',
      repo: 'ox',
      fullName: 'timescale/ox',
    });
    expect(state.isGitRepo).toBe(true);
    expect(state.fullName).toBe('timescale/ox');
  });

  test('initialize with null sets not-in-repo state', () => {
    // First set some repo info
    useRepoStore.getState().initialize({
      owner: 'foo',
      repo: 'bar',
      fullName: 'foo/bar',
    });
    expect(useRepoStore.getState().isGitRepo).toBe(true);

    // Then initialize with null
    useRepoStore.getState().initialize(null);

    const state = useRepoStore.getState();
    expect(state.repoInfo).toBeNull();
    expect(state.isGitRepo).toBe(false);
    expect(state.fullName).toBeUndefined();
  });
});
