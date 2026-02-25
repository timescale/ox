import { describe, expect, test } from 'bun:test';
import type { HermesSession as DockerSession } from '../docker.ts';
import { mapDockerSession, mapDockerStats } from './dockerProvider.ts';

// Helper to create a minimal DockerSession for testing
function makeDockerSession(
  overrides: Partial<DockerSession> = {},
): DockerSession {
  return {
    containerId: 'abc123',
    containerName: 'hermes-test-container',
    name: 'test-session',
    branch: 'main',
    agent: 'claude',
    repo: 'https://github.com/test/repo',
    prompt: 'do something',
    created: '2025-01-01T00:00:00Z',
    interactive: false,
    status: 'running',
    ...overrides,
  };
}

describe('mapDockerSession', () => {
  test('maps running status to running', () => {
    const session = mapDockerSession(makeDockerSession({ status: 'running' }));
    expect(session.status).toBe('running');
  });

  test('maps exited status to exited', () => {
    const session = mapDockerSession(makeDockerSession({ status: 'exited' }));
    expect(session.status).toBe('exited');
  });

  test('maps created status to unknown', () => {
    const session = mapDockerSession(makeDockerSession({ status: 'created' }));
    expect(session.status).toBe('unknown');
  });

  test('maps paused status to stopped', () => {
    const session = mapDockerSession(makeDockerSession({ status: 'paused' }));
    expect(session.status).toBe('stopped');
  });

  test('maps restarting status to stopped', () => {
    const session = mapDockerSession(
      makeDockerSession({ status: 'restarting' }),
    );
    expect(session.status).toBe('stopped');
  });

  test('maps dead status to stopped', () => {
    const session = mapDockerSession(makeDockerSession({ status: 'dead' }));
    expect(session.status).toBe('stopped');
  });

  test('sets provider to docker', () => {
    const session = mapDockerSession(makeDockerSession());
    expect(session.provider).toBe('docker');
  });

  test('maps containerId to id', () => {
    const session = mapDockerSession(
      makeDockerSession({ containerId: 'container-xyz' }),
    );
    expect(session.id).toBe('container-xyz');
  });

  test('preserves all metadata fields', () => {
    const docker = makeDockerSession({
      containerId: 'cid-1',
      containerName: 'hermes-my-container',
      name: 'my-session',
      branch: 'feature/test',
      agent: 'claude',
      model: 'opus',
      repo: 'https://github.com/org/repo',
      prompt: 'fix the bug',
      created: '2025-06-01T12:00:00Z',
      interactive: true,
      execType: 'agent',
      resumedFrom: 'prev-session',
      mountDir: '/home/user/project',
      exitCode: 0,
      startedAt: '2025-06-01T12:00:01Z',
      finishedAt: '2025-06-01T12:05:00Z',
    });

    const session = mapDockerSession(docker);

    expect(session.id).toBe('cid-1');
    expect(session.containerName).toBe('hermes-my-container');
    expect(session.name).toBe('my-session');
    expect(session.branch).toBe('feature/test');
    expect(session.agent).toBe('claude');
    expect(session.model).toBe('opus');
    expect(session.repo).toBe('https://github.com/org/repo');
    expect(session.prompt).toBe('fix the bug');
    expect(session.created).toBe('2025-06-01T12:00:00Z');
    expect(session.interactive).toBe(true);
    expect(session.execType).toBe('agent');
    expect(session.resumedFrom).toBe('prev-session');
    expect(session.mountDir).toBe('/home/user/project');
    expect(session.exitCode).toBe(0);
    expect(session.startedAt).toBe('2025-06-01T12:00:01Z');
    expect(session.finishedAt).toBe('2025-06-01T12:05:00Z');
  });
});

describe('mapDockerStats', () => {
  test('maps docker stats to sandbox stats', () => {
    const input = new Map([
      [
        'container-1',
        {
          containerId: 'container-1',
          cpuPercent: 25.5,
          memUsage: '128MiB / 1GiB',
          memPercent: 12.5,
        },
      ],
    ]);

    const result = mapDockerStats(input);

    expect(result.size).toBe(1);
    const stats = result.get('container-1');
    expect(stats).toBeDefined();
    expect(stats?.id).toBe('container-1');
    expect(stats?.cpuPercent).toBe(25.5);
    expect(stats?.memUsage).toBe('128MiB / 1GiB');
    expect(stats?.memPercent).toBe(12.5);
  });

  test('handles multiple containers', () => {
    const input = new Map([
      [
        'c1',
        {
          containerId: 'c1',
          cpuPercent: 10,
          memUsage: '64MiB / 512MiB',
          memPercent: 12.5,
        },
      ],
      [
        'c2',
        {
          containerId: 'c2',
          cpuPercent: 50,
          memUsage: '256MiB / 1GiB',
          memPercent: 25,
        },
      ],
    ]);

    const result = mapDockerStats(input);

    expect(result.size).toBe(2);
    expect(result.get('c1')?.cpuPercent).toBe(10);
    expect(result.get('c2')?.cpuPercent).toBe(50);
  });

  test('handles empty input', () => {
    const input = new Map();
    const result = mapDockerStats(input);
    expect(result.size).toBe(0);
  });

  test('preserves zero values', () => {
    const input = new Map([
      [
        'idle',
        {
          containerId: 'idle',
          cpuPercent: 0,
          memUsage: '0B / 1GiB',
          memPercent: 0,
        },
      ],
    ]);

    const result = mapDockerStats(input);
    const stats = result.get('idle');
    expect(stats?.cpuPercent).toBe(0);
    expect(stats?.memPercent).toBe(0);
    expect(stats?.memUsage).toBe('0B / 1GiB');
  });
});
