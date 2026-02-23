// ============================================================================
// Session Database Tests
// ============================================================================

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  deleteSession,
  getSession,
  initSessionSchema,
  listSessions,
  softDeleteSession,
  updateSessionSnapshot,
  updateSessionStatus,
  upsertSession,
} from './sessionDb.ts';
import type { HermesSession } from './types.ts';

function createTestDb(): Database {
  const db = new Database(':memory:');
  initSessionSchema(db);
  return db;
}

function makeSession(overrides?: Partial<HermesSession>): HermesSession {
  return {
    id: 'test-id-1',
    provider: 'docker',
    name: 'test-session',
    branch: 'main',
    agent: 'claude',
    model: 'sonnet',
    prompt: 'fix the bug',
    repo: 'timescale/hermes',
    created: '2025-01-15T10:00:00Z',
    status: 'running',
    interactive: true,
    ...overrides,
  };
}

describe('sessionDb', () => {
  // ==========================================================================
  // upsert + get
  // ==========================================================================

  test('upsertSession inserts and getSession retrieves', () => {
    const db = createTestDb();
    const session = makeSession();

    upsertSession(db, session);
    const result = getSession(db, session.id);

    expect(result).not.toBeNull();
    expect(result?.id).toBe(session.id);
    expect(result?.provider).toBe('docker');
    expect(result?.name).toBe('test-session');
    expect(result?.branch).toBe('main');
    expect(result?.agent).toBe('claude');
    expect(result?.model).toBe('sonnet');
    expect(result?.prompt).toBe('fix the bug');
    expect(result?.status).toBe('running');
    expect(result?.interactive).toBe(true);
  });

  test('upsertSession updates existing record', () => {
    const db = createTestDb();
    const session = makeSession();

    upsertSession(db, session);
    upsertSession(db, { ...session, status: 'stopped', exitCode: 0 });

    const result = getSession(db, session.id);
    expect(result?.status).toBe('stopped');
    expect(result?.exitCode).toBe(0);
  });

  test('getSession returns null for non-existent id', () => {
    const db = createTestDb();
    const result = getSession(db, 'does-not-exist');
    expect(result).toBeNull();
  });

  test('interactive field maps boolean to integer and back', () => {
    const db = createTestDb();

    upsertSession(db, makeSession({ id: 'a', interactive: true }));
    upsertSession(db, makeSession({ id: 'b', interactive: false }));

    expect(getSession(db, 'a')?.interactive).toBe(true);
    expect(getSession(db, 'b')?.interactive).toBe(false);
  });

  test('optional fields round-trip as undefined when null', () => {
    const db = createTestDb();
    const session = makeSession({
      model: undefined,
      exitCode: undefined,
      mountDir: undefined,
      region: undefined,
      containerName: undefined,
      volumeSlug: undefined,
      snapshotSlug: undefined,
      startedAt: undefined,
      finishedAt: undefined,
      execType: undefined,
      resumedFrom: undefined,
    });

    upsertSession(db, session);
    const result = getSession(db, session.id);

    expect(result?.model).toBeUndefined();
    expect(result?.exitCode).toBeUndefined();
    expect(result?.mountDir).toBeUndefined();
    expect(result?.region).toBeUndefined();
    expect(result?.containerName).toBeUndefined();
    expect(result?.volumeSlug).toBeUndefined();
    expect(result?.snapshotSlug).toBeUndefined();
    expect(result?.startedAt).toBeUndefined();
    expect(result?.finishedAt).toBeUndefined();
    expect(result?.execType).toBeUndefined();
    expect(result?.resumedFrom).toBeUndefined();
  });

  // ==========================================================================
  // listSessions
  // ==========================================================================

  test('listSessions returns all sessions', () => {
    const db = createTestDb();

    upsertSession(db, makeSession({ id: 's1', name: 'first' }));
    upsertSession(db, makeSession({ id: 's2', name: 'second' }));
    upsertSession(db, makeSession({ id: 's3', name: 'third' }));

    const sessions = listSessions(db);
    expect(sessions).toHaveLength(3);
  });

  test('listSessions filters by provider', () => {
    const db = createTestDb();

    upsertSession(db, makeSession({ id: 'd1', provider: 'docker' }));
    upsertSession(db, makeSession({ id: 'c1', provider: 'cloud' }));
    upsertSession(db, makeSession({ id: 'd2', provider: 'docker' }));

    const dockerSessions = listSessions(db, { provider: 'docker' });
    expect(dockerSessions).toHaveLength(2);
    expect(dockerSessions.every((s) => s.provider === 'docker')).toBe(true);

    const cloudSessions = listSessions(db, { provider: 'cloud' });
    expect(cloudSessions).toHaveLength(1);
    expect(cloudSessions[0]?.provider).toBe('cloud');
  });

  test('listSessions filters by status', () => {
    const db = createTestDb();

    upsertSession(db, makeSession({ id: 'r1', status: 'running' }));
    upsertSession(db, makeSession({ id: 'r2', status: 'running' }));
    upsertSession(db, makeSession({ id: 's1', status: 'stopped' }));

    const running = listSessions(db, { status: 'running' });
    expect(running).toHaveLength(2);

    const stopped = listSessions(db, { status: 'stopped' });
    expect(stopped).toHaveLength(1);
  });

  test('listSessions filters by provider and status', () => {
    const db = createTestDb();

    upsertSession(
      db,
      makeSession({ id: 'dr', provider: 'docker', status: 'running' }),
    );
    upsertSession(
      db,
      makeSession({ id: 'ds', provider: 'docker', status: 'stopped' }),
    );
    upsertSession(
      db,
      makeSession({ id: 'cr', provider: 'cloud', status: 'running' }),
    );

    const result = listSessions(db, { provider: 'docker', status: 'running' });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('dr');
  });

  test('listSessions returns results ordered by created DESC', () => {
    const db = createTestDb();

    upsertSession(
      db,
      makeSession({ id: 'old', created: '2025-01-01T00:00:00Z' }),
    );
    upsertSession(
      db,
      makeSession({ id: 'new', created: '2025-06-01T00:00:00Z' }),
    );
    upsertSession(
      db,
      makeSession({ id: 'mid', created: '2025-03-01T00:00:00Z' }),
    );

    const sessions = listSessions(db);
    expect(sessions[0]?.id).toBe('new');
    expect(sessions[1]?.id).toBe('mid');
    expect(sessions[2]?.id).toBe('old');
  });

  // ==========================================================================
  // deleteSession
  // ==========================================================================

  test('deleteSession removes the session', () => {
    const db = createTestDb();

    upsertSession(db, makeSession({ id: 'to-delete' }));
    expect(getSession(db, 'to-delete')).not.toBeNull();

    deleteSession(db, 'to-delete');
    expect(getSession(db, 'to-delete')).toBeNull();
  });

  test('deleteSession is a no-op for non-existent id', () => {
    const db = createTestDb();
    // should not throw
    deleteSession(db, 'does-not-exist');
  });

  // ==========================================================================
  // updateSessionStatus
  // ==========================================================================

  test('updateSessionStatus updates status', () => {
    const db = createTestDb();
    upsertSession(db, makeSession({ id: 'u1', status: 'running' }));

    updateSessionStatus(db, 'u1', 'exited', 0);

    const result = getSession(db, 'u1');
    expect(result?.status).toBe('exited');
    expect(result?.exitCode).toBe(0);
  });

  test('updateSessionStatus without exitCode sets it to null', () => {
    const db = createTestDb();
    upsertSession(
      db,
      makeSession({ id: 'u2', status: 'running', exitCode: 1 }),
    );

    updateSessionStatus(db, 'u2', 'stopped');

    const result = getSession(db, 'u2');
    expect(result?.status).toBe('stopped');
    expect(result?.exitCode).toBeUndefined();
  });

  // ==========================================================================
  // updateSessionSnapshot
  // ==========================================================================

  test('updateSessionSnapshot updates the snapshot slug', () => {
    const db = createTestDb();
    upsertSession(db, makeSession({ id: 'snap1', provider: 'cloud' }));

    updateSessionSnapshot(db, 'snap1', 'my-snapshot-v2');

    const result = getSession(db, 'snap1');
    expect(result?.snapshotSlug).toBe('my-snapshot-v2');
  });

  // ==========================================================================
  // Cloud-specific fields
  // ==========================================================================

  test('cloud session fields round-trip correctly', () => {
    const db = createTestDb();
    const session = makeSession({
      id: 'cloud-1',
      provider: 'cloud',
      region: 'ord',
      volumeSlug: 'vol-abc',
      snapshotSlug: 'snap-xyz',
    });

    upsertSession(db, session);
    const result = getSession(db, 'cloud-1');

    expect(result?.provider).toBe('cloud');
    expect(result?.region).toBe('ord');
    expect(result?.volumeSlug).toBe('vol-abc');
    expect(result?.snapshotSlug).toBe('snap-xyz');
  });

  // ==========================================================================
  // Docker-specific fields
  // ==========================================================================

  test('docker session fields round-trip correctly', () => {
    const db = createTestDb();
    const session = makeSession({
      id: 'docker-1',
      provider: 'docker',
      mountDir: '/home/user/project',
      containerName: 'hermes-docker-1',
    });

    upsertSession(db, session);
    const result = getSession(db, 'docker-1');

    expect(result?.provider).toBe('docker');
    expect(result?.mountDir).toBe('/home/user/project');
    expect(result?.containerName).toBe('hermes-docker-1');
  });

  // ==========================================================================
  // softDeleteSession
  // ==========================================================================

  test('softDeleteSession hides session from listSessions', () => {
    const db = createTestDb();
    upsertSession(db, makeSession({ id: 'to-soft-delete' }));

    softDeleteSession(db, 'to-soft-delete');

    // Should not appear in list
    const sessions = listSessions(db);
    expect(sessions.find((s) => s.id === 'to-soft-delete')).toBeUndefined();
  });

  test('softDeleteSession preserves record for direct retrieval', () => {
    const db = createTestDb();
    upsertSession(db, makeSession({ id: 'soft-del' }));
    softDeleteSession(db, 'soft-del');

    // Direct get still finds it
    const session = getSession(db, 'soft-del');
    expect(session).not.toBeNull();
    expect(session?.id).toBe('soft-del');
  });

  test('listSessions excludes soft-deleted sessions by default', () => {
    const db = createTestDb();
    upsertSession(db, makeSession({ id: 'active' }));
    upsertSession(db, makeSession({ id: 'deleted' }));
    softDeleteSession(db, 'deleted');

    const sessions = listSessions(db);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('active');
  });
});
