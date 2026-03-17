/**
 * Usage event helpers for the M-2 utility-based re-ranking system.
 *
 * These functions query the usage_events table defined by M-1
 * (ensureUsageEventsSchema). M-2 does NOT create or redefine this table.
 *
 * M-1 schema:
 *   id, event_type, query, entry_id (nullable), entry_ref, signal, metadata, created_at
 */

import type { Database } from "bun:sqlite";

// ── Helpers consumed by recomputeUtilityScores (indexer.ts) ─────────────────

/**
 * Ensure the usage_events table exists (M-1 schema).
 *
 * This is a forward-compatible shim: when M-1 is merged the canonical
 * `ensureUsageEventsSchema()` takes precedence, but until then M-2 still
 * needs the table to exist so that queries against it don't crash.
 */
export function ensureUsageEventsSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      query      TEXT,
      entry_id   INTEGER,
      entry_ref  TEXT,
      signal     TEXT,
      metadata   TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_usage_events_entry ON usage_events(entry_id);
    CREATE INDEX IF NOT EXISTS idx_usage_events_type ON usage_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_usage_events_ref ON usage_events(entry_ref);
  `);
}

/**
 * Get usage event counts for an entry, grouped by event type.
 * Uses M-1 column names: entry_id (nullable) and event_type values 'search'/'show'.
 */
export function getUsageEventCounts(db: Database, entryId: number): { searchCount: number; showCount: number } {
  try {
    const rows = db
      .prepare("SELECT event_type, COUNT(*) AS cnt FROM usage_events WHERE entry_id = ? GROUP BY event_type")
      .all(entryId) as Array<{ event_type: string; cnt: number }>;

    let searchCount = 0;
    let showCount = 0;
    for (const row of rows) {
      if (row.event_type === "search") searchCount = row.cnt;
      if (row.event_type === "show") showCount = row.cnt;
    }
    return { searchCount, showCount };
  } catch {
    // Table may not exist yet (M-1 not merged); return zeros
    return { searchCount: 0, showCount: 0 };
  }
}

/**
 * Get the most recent created_at for any event on this entry.
 * Uses M-1 column name: created_at (not timestamp).
 */
export function getLastUsedAt(db: Database, entryId: number): string | undefined {
  try {
    const row = db.prepare("SELECT MAX(created_at) AS last_used FROM usage_events WHERE entry_id = ?").get(entryId) as
      | { last_used: string | null }
      | undefined;
    return row?.last_used ?? undefined;
  } catch {
    // Table may not exist yet
    return undefined;
  }
}

/**
 * Record a usage event using M-1's schema.
 * Primarily used by tests; production code uses M-1's own recording functions.
 */
export function recordUsageEvent(
  db: Database,
  event: {
    eventType: "search" | "show";
    entryId: number;
    timestamp?: string;
    query?: string;
  },
): void {
  ensureUsageEventsSchema(db);
  db.prepare("INSERT INTO usage_events (event_type, entry_id, query, created_at) VALUES (?, ?, ?, ?)").run(
    event.eventType,
    event.entryId,
    event.query ?? null,
    event.timestamp ?? new Date().toISOString(),
  );
}

/**
 * Delete usage events older than the given number of days.
 */
export function purgeOldUsageEvents(db: Database, retentionDays: number): void {
  try {
    db.prepare(`DELETE FROM usage_events WHERE created_at < datetime('now', '-${retentionDays} days')`).run();
  } catch {
    // Table may not exist yet
  }
}
