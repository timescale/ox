#!/usr/bin/env bun
// Seed the session database with sample sessions for VHS tape recording.
// Usage: ./bun docs/tapes/seed-sessions.ts [--cleanup]

import { openSessionDb, upsertSession } from '../../src/services/sandbox/sessionDb.ts';
import type { OxSession } from '../../src/services/sandbox/types.ts';

const SEED_IDS = [
  'vhs-seed-session-001',
  'vhs-seed-session-002',
  'vhs-seed-session-003',
];

const db = openSessionDb();

if (process.argv.includes('--cleanup')) {
  for (const id of SEED_IDS) {
    db.prepare('DELETE FROM sessions WHERE id = $id').run({ $id: id });
  }
  console.log('Cleaned up seed sessions.');
  process.exit(0);
}

const now = new Date();

const sessions: OxSession[] = [
  {
    id: SEED_IDS[0]!,
    provider: 'cloud',
    name: 'add-jwt-auth-middleware',
    branch: 'add-jwt-auth-middleware',
    agent: 'claude',
    model: 'sonnet',
    prompt: 'Add JWT authentication middleware to the API routes',
    repo: 'timescale/ox',
    created: new Date(now.getTime() - 25 * 60_000).toISOString(),
    status: 'running',
    interactive: false,
    agentMode: 'async',
    startedAt: new Date(now.getTime() - 25 * 60_000).toISOString(),
  },
  {
    id: SEED_IDS[1]!,
    provider: 'cloud',
    name: 'fix-signup-form-validation',
    branch: 'fix-signup-form-validation',
    agent: 'claude',
    model: 'opus',
    prompt: 'Fix input validation on the signup form and add proper error messages',
    repo: 'timescale/ox',
    created: new Date(now.getTime() - 2 * 3600_000).toISOString(),
    status: 'exited',
    exitCode: 0,
    interactive: false,
    agentMode: 'async',
    startedAt: new Date(now.getTime() - 2 * 3600_000).toISOString(),
    finishedAt: new Date(now.getTime() - 90 * 60_000).toISOString(),
  },
  {
    id: SEED_IDS[2]!,
    provider: 'cloud',
    name: 'feat-dashboard-redesign',
    branch: 'feat-dashboard-redesign',
    agent: 'opencode',
    model: 'sonnet',
    prompt: 'Redesign the analytics dashboard with new chart components',
    repo: 'timescale/ox',
    created: new Date(now.getTime() - 5 * 3600_000).toISOString(),
    status: 'exited',
    exitCode: 0,
    interactive: false,
    agentMode: 'async',
    startedAt: new Date(now.getTime() - 5 * 3600_000).toISOString(),
    finishedAt: new Date(now.getTime() - 4 * 3600_000).toISOString(),
  },
];

for (const session of sessions) {
  upsertSession(db, session);
}

console.log(`Seeded ${sessions.length} sessions.`);
