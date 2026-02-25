// ============================================================================
// Session Database - SQLite persistence for sandbox session metadata
// ============================================================================

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { userConfigDir } from '../config.ts';
import { log } from '../logger.ts';
import type { HermesSession, SandboxProviderType } from './types.ts';

// ============================================================================
// Schema
// ============================================================================

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  branch TEXT,
  agent TEXT,
  model TEXT,
  prompt TEXT,
  repo TEXT,
  created TEXT NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  interactive INTEGER DEFAULT 0,
  exec_type TEXT,
  resumed_from TEXT,
  region TEXT,
  mount_dir TEXT,
  container_name TEXT,
  volume_slug TEXT,
  snapshot_slug TEXT,
  started_at TEXT,
  finished_at TEXT,
  extra TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_provider ON sessions(provider);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_name ON sessions(name);
`;

// ============================================================================
// Database Initialization
// ============================================================================

/** Initialize the schema on a database instance (useful for testing with :memory:) */
export function initSessionSchema(db: Database): void {
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(SCHEMA_SQL);

  // Migration: add deleted_at column for soft-delete support
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN deleted_at TEXT');
  } catch {
    // Column already exists — expected on subsequent runs
  }
}

let _db: Database | null = null;

/** Open or create the session database, run migrations */
export function openSessionDb(): Database {
  if (_db) return _db;
  const dir = userConfigDir();
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'sessions.db');
  log.debug(`Opening session database at ${dbPath}`);
  const db = new Database(dbPath);
  initSessionSchema(db);
  _db = db;
  return db;
}

// ============================================================================
// Row <-> HermesSession Mapping
// ============================================================================

interface SessionRow {
  id: string;
  provider: string;
  name: string;
  branch: string | null;
  agent: string | null;
  model: string | null;
  prompt: string | null;
  repo: string | null;
  created: string;
  status: string;
  exit_code: number | null;
  interactive: number;
  exec_type: string | null;
  resumed_from: string | null;
  region: string | null;
  mount_dir: string | null;
  container_name: string | null;
  volume_slug: string | null;
  snapshot_slug: string | null;
  started_at: string | null;
  finished_at: string | null;
  deleted_at: string | null;
  extra: string | null;
}

function rowToSession(row: SessionRow): HermesSession {
  return {
    id: row.id,
    provider: row.provider as SandboxProviderType,
    name: row.name,
    branch: row.branch ?? '',
    agent: (() => {
      if (row.agent == null) {
        log.warn(`Session ${row.id} has null agent, defaulting to 'claude'`);
        return 'claude';
      }
      return row.agent;
    })() as HermesSession['agent'],
    model: row.model ?? undefined,
    prompt: row.prompt ?? '',
    repo: row.repo ?? '',
    created: row.created,
    status: row.status as HermesSession['status'],
    exitCode: row.exit_code ?? undefined,
    interactive: row.interactive === 1,
    execType: (row.exec_type as HermesSession['execType']) ?? undefined,
    resumedFrom: row.resumed_from ?? undefined,
    region: row.region ?? undefined,
    mountDir: row.mount_dir ?? undefined,
    containerName: row.container_name ?? undefined,
    volumeSlug: row.volume_slug ?? undefined,
    snapshotSlug: row.snapshot_slug ?? undefined,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
  };
}

// ============================================================================
// CRUD Operations
// ============================================================================

/** Insert or update a session record from a HermesSession object.
 *  Uses ON CONFLICT to preserve the deleted_at column on updates. */
export function upsertSession(db: Database, session: HermesSession): void {
  const stmt = db.prepare(`
    INSERT INTO sessions (
      id, provider, name, branch, agent, model, prompt, repo,
      created, status, exit_code, interactive, exec_type, resumed_from,
      region, mount_dir, container_name, volume_slug, snapshot_slug,
      started_at, finished_at, extra
    ) VALUES (
      $id, $provider, $name, $branch, $agent, $model, $prompt, $repo,
      $created, $status, $exit_code, $interactive, $exec_type, $resumed_from,
      $region, $mount_dir, $container_name, $volume_slug, $snapshot_slug,
      $started_at, $finished_at, $extra
    )
    ON CONFLICT(id) DO UPDATE SET
      provider = excluded.provider,
      name = excluded.name,
      branch = excluded.branch,
      agent = excluded.agent,
      model = excluded.model,
      prompt = excluded.prompt,
      repo = excluded.repo,
      created = excluded.created,
      status = excluded.status,
      exit_code = excluded.exit_code,
      interactive = excluded.interactive,
      exec_type = excluded.exec_type,
      resumed_from = excluded.resumed_from,
      region = excluded.region,
      mount_dir = excluded.mount_dir,
      container_name = excluded.container_name,
      volume_slug = excluded.volume_slug,
      snapshot_slug = excluded.snapshot_slug,
      started_at = excluded.started_at,
      finished_at = excluded.finished_at,
      extra = excluded.extra
  `);

  stmt.run({
    $id: session.id,
    $provider: session.provider,
    $name: session.name,
    $branch: session.branch ?? null,
    $agent: session.agent ?? null,
    $model: session.model ?? null,
    $prompt: session.prompt ?? null,
    $repo: session.repo ?? null,
    $created: session.created,
    $status: session.status,
    $exit_code: session.exitCode ?? null,
    $interactive: session.interactive ? 1 : 0,
    $exec_type: session.execType ?? null,
    $resumed_from: session.resumedFrom ?? null,
    $region: session.region ?? null,
    $mount_dir: session.mountDir ?? null,
    $container_name: session.containerName ?? null,
    $volume_slug: session.volumeSlug ?? null,
    $snapshot_slug: session.snapshotSlug ?? null,
    $started_at: session.startedAt ?? null,
    $finished_at: session.finishedAt ?? null,
    $extra: null,
  });
}

/** Get a session by ID, returns HermesSession or null */
export function getSession(db: Database, id: string): HermesSession | null {
  const stmt = db.prepare('SELECT * FROM sessions WHERE id = $id');
  const row = stmt.get({ $id: id }) as SessionRow | null;
  return row ? rowToSession(row) : null;
}

/** List sessions with optional filters */
export function listSessions(
  db: Database,
  filter?: { provider?: SandboxProviderType; status?: string },
): HermesSession[] {
  const conditions: string[] = [];
  const params: Record<string, string> = {};

  // Always exclude soft-deleted sessions
  conditions.push('deleted_at IS NULL');

  if (filter?.provider) {
    conditions.push('provider = $provider');
    params.$provider = filter.provider;
  }
  if (filter?.status) {
    conditions.push('status = $status');
    params.$status = filter.status;
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const stmt = db.prepare(
    `SELECT * FROM sessions ${where} ORDER BY created DESC`,
  );
  const rows = stmt.all(params) as SessionRow[];
  return rows.map(rowToSession);
}

/** List ALL sessions including soft-deleted ones (for resource cleanup classification) */
export function listAllSessionsIncludingDeleted(db: Database): HermesSession[] {
  const stmt = db.prepare('SELECT * FROM sessions ORDER BY created DESC');
  const rows = stmt.all() as SessionRow[];
  return rows.map(rowToSession);
}

/** Delete a session by ID */
export function deleteSession(db: Database, id: string): void {
  const stmt = db.prepare('DELETE FROM sessions WHERE id = $id');
  stmt.run({ $id: id });
}

/** Soft-delete a session by setting its deleted_at timestamp */
export function softDeleteSession(db: Database, id: string): void {
  const stmt = db.prepare(
    'UPDATE sessions SET deleted_at = $deleted_at WHERE id = $id',
  );
  stmt.run({ $id: id, $deleted_at: new Date().toISOString() });
}

/** Update just the status (and optionally exit code) of a session */
export function updateSessionStatus(
  db: Database,
  id: string,
  status: string,
  exitCode?: number,
): void {
  const stmt = db.prepare(`
    UPDATE sessions SET status = $status, exit_code = $exit_code WHERE id = $id
  `);
  stmt.run({
    $id: id,
    $status: status,
    $exit_code: exitCode ?? null,
  });
}

/** Update the snapshot slug for cloud resume */
export function updateSessionSnapshot(
  db: Database,
  id: string,
  snapshotSlug: string,
): void {
  const stmt = db.prepare(`
    UPDATE sessions SET snapshot_slug = $snapshot_slug WHERE id = $id
  `);
  stmt.run({
    $id: id,
    $snapshot_slug: snapshotSlug,
  });
}
