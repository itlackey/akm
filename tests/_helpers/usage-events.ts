import type { Database } from "../../src/storage/database";

/** The `usage_events` table as the state.db baseline defines it, for tests that open a bare in-memory database. */
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
      source     TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_usage_events_entry ON usage_events(entry_id);
    CREATE INDEX IF NOT EXISTS idx_usage_events_type ON usage_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_usage_events_ref ON usage_events(entry_ref);
    CREATE INDEX IF NOT EXISTS idx_usage_events_source ON usage_events(source);
  `);
}

/**
 * Record a usage event (test-only helper for M-2 utility scoring tests).
 */
export function recordUsageEvent(
  db: Database,
  event: {
    eventType: "search" | "show";
    entryId: number;
    /** The entry's durable `item_ref`: utility scores aggregate by it. */
    entryRef?: string;
    timestamp?: string;
    query?: string;
  },
): void {
  ensureUsageEventsSchema(db);
  db.prepare(
    "INSERT INTO usage_events (event_type, entry_id, entry_ref, query, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(
    event.eventType,
    event.entryId,
    event.entryRef ?? null,
    event.query ?? null,
    event.timestamp ?? new Date().toISOString(),
  );
}
