import { describe, expect, mock, test } from 'bun:test';

// Mock only the specific functions handleNeedsGhAuth calls.
// Spread the real modules so transitive imports still resolve.
const ensureDockerImageMock = mock(async () => 'ox-sandbox:test');
const ensureGhAuthMock = mock(async () => {});

const realDocker = await import('../services/docker');
const realGhAuth = await import('../components/GhAuth.tsx');

mock.module('../services/docker', () => ({
  ...realDocker,
  ensureDockerImage: ensureDockerImageMock,
}));

mock.module('../components/GhAuth.tsx', () => ({
  ...realGhAuth,
  ensureGhAuth: ensureGhAuthMock,
}));

const { handleNeedsGhAuth } = await import('./sessions');

describe('handleNeedsGhAuth', () => {
  test('calls ensureDockerImage and ensureGhAuth, returns retry state', async () => {
    ensureDockerImageMock.mockClear();
    ensureGhAuthMock.mockClear();

    const result = await handleNeedsGhAuth({
      type: 'needs-gh-auth',
      ghAuthInfo: {
        agent: 'opencode',
        model: 'anthropic/claude-3-5-sonnet',
        prompt: 'add metrics',
        mountDir: '/tmp/repo',
        isGitRepo: true,
      },
    });

    expect(ensureDockerImageMock).toHaveBeenCalledTimes(1);
    expect(ensureGhAuthMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      nextView: 'starting',
      nextPrompt: 'add metrics',
      nextAgent: 'opencode',
      nextModel: 'anthropic/claude-3-5-sonnet',
      nextMountDir: '/tmp/repo',
      nextIsGitRepo: true,
    });
  });

  test('returns null for non gh-auth results', async () => {
    ensureDockerImageMock.mockClear();
    ensureGhAuthMock.mockClear();

    const result = await handleNeedsGhAuth({
      type: 'quit',
    });

    expect(result).toBeNull();
    expect(ensureDockerImageMock).toHaveBeenCalledTimes(0);
    expect(ensureGhAuthMock).toHaveBeenCalledTimes(0);
  });
});
