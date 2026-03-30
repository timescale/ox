import { describe, expect, mock, test } from 'bun:test';

const ensureGhostAuthMock = mock(async () => {});

const realGhostAuth = await import('../components/GhostAuth.tsx');

mock.module('../components/GhostAuth.tsx', () => ({
  ...realGhostAuth,
  ensureGhostAuth: ensureGhostAuthMock,
}));

const { handleNeedsGhostAuth } = await import('./sessions');

describe('handleNeedsGhostAuth', () => {
  test('calls ensureGhostAuth and returns retry state', async () => {
    ensureGhostAuthMock.mockClear();

    const result = await handleNeedsGhostAuth({
      type: 'needs-ghost-auth',
      ghostAuthInfo: {
        agent: 'opencode',
        model: 'anthropic/claude-3-5-sonnet',
        prompt: 'add metrics',
        mode: 'interactive',
        mountDir: '/tmp/repo',
        isGitRepo: true,
      },
    });

    expect(ensureGhostAuthMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      nextView: 'starting',
      nextPrompt: 'add metrics',
      nextAgent: 'opencode',
      nextModel: 'anthropic/claude-3-5-sonnet',
      nextMountDir: '/tmp/repo',
      nextAutoSubmitAgentMode: 'interactive',
    });
  });

  test('returns null for non ghost-auth results', async () => {
    ensureGhostAuthMock.mockClear();

    const result = await handleNeedsGhostAuth({
      type: 'quit',
    });

    expect(result).toBeNull();
    expect(ensureGhostAuthMock).toHaveBeenCalledTimes(0);
  });
});
