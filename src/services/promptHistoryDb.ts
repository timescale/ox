// ============================================================================
// Prompt History Database - SQLite persistence for user prompt history
// ============================================================================

import type { Database } from 'bun:sqlite';

// ============================================================================
// Schema
// ============================================================================

const PROMPT_HISTORY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS prompt_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_prompt_history_created ON prompt_history(created_at);
`;

// ============================================================================
// Schema Initialization
// ============================================================================

/** Initialize the prompt history schema on a database instance */
export function initPromptHistorySchema(db: Database): void {
  db.run(PROMPT_HISTORY_SCHEMA_SQL);
}

// ============================================================================
// Types
// ============================================================================

export interface PromptHistoryEntry {
  id: number;
  prompt: string;
  createdAt: string;
}

interface PromptHistoryRow {
  id: number;
  prompt: string;
  created_at: string;
}

function rowToEntry(row: PromptHistoryRow): PromptHistoryEntry {
  return {
    id: row.id,
    prompt: row.prompt,
    createdAt: row.created_at,
  };
}

// ============================================================================
// CRUD Operations
// ============================================================================

/**
 * Add a prompt to the history.
 * Skips insertion if the most recent entry has the same prompt text
 * (consecutive duplicate suppression, like bash history).
 */
export function addPromptHistoryEntry(db: Database, prompt: string): void {
  const trimmed = prompt.trim();
  if (!trimmed) return;

  // Check for consecutive duplicate
  const lastRow = db
    .prepare('SELECT prompt FROM prompt_history ORDER BY id DESC LIMIT 1')
    .get() as { prompt: string } | null;

  if (lastRow && lastRow.prompt === trimmed) {
    return;
  }

  db.prepare(
    'INSERT INTO prompt_history (prompt, created_at) VALUES ($prompt, $created_at)',
  ).run({
    $prompt: trimmed,
    $created_at: new Date().toISOString(),
  });
}

/**
 * Get recent prompts, newest first.
 * Supports cursor-based pagination via `beforeId` — pass the id of the oldest
 * loaded entry to fetch the next page of older entries.
 */
export function getRecentPrompts(
  db: Database,
  limit: number,
  beforeId?: number,
): PromptHistoryEntry[] {
  if (beforeId != null) {
    const rows = db
      .prepare(
        'SELECT * FROM prompt_history WHERE id < $beforeId ORDER BY id DESC LIMIT $limit',
      )
      .all({ $beforeId: beforeId, $limit: limit }) as PromptHistoryRow[];
    return rows.map(rowToEntry);
  }

  const rows = db
    .prepare('SELECT * FROM prompt_history ORDER BY id DESC LIMIT $limit')
    .all({ $limit: limit }) as PromptHistoryRow[];
  return rows.map(rowToEntry);
}

/** Get the total number of prompt history entries */
export function getPromptHistoryCount(db: Database): number {
  const row = db
    .prepare('SELECT COUNT(*) as count FROM prompt_history')
    .get() as { count: number };
  return row.count;
}
