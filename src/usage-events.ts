/**
 * Usage event helpers for telemetry (M-1) and utility-based re-ranking (M-2).
 *
 * Schema (created by ensureUsageEventsSchema):
 *   id, event_type, query, entry_id (nullable), entry_ref, signal, metadata, created_at
 */

import type { Database } from "bun:sqlite";

// ── Types ───────────────────────────────────────────────────────────────────

export interface UsageEvent {
  event_type: string;
  query?: string;
  entry_id?: number;
  entry_ref?: string;
  signal?: string;
  metadata?: string;
}

export interface UsageEventRow {
  id: number;
  event_type: string;
  query: string | null;
  entry_id: number | null;
  entry_ref: string | null;
  signal: string | null;
  metadata: string | null;
  created_at: string;
}

export interface UsageEventFilters {
  event_type?: string;
  entry_ref?: string;
}

// ── Schema ──────────────────────────────────────────────────────────────────

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

// ── Insert (M-1) ────────────────────────────────────────────────────────────

/**
 * Insert a usage event into the database. Fire-and-forget: errors are
 * silently caught so callers are never blocked or disrupted.
 */
export function insertUsageEvent(db: Database, event: UsageEvent): void {
  try {
    db.prepare(
      `INSERT INTO usage_events (event_type, query, entry_id, entry_ref, signal, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      event.event_type,
      event.query ?? null,
      event.entry_id ?? null,
      event.entry_ref ?? null,
      event.signal ?? null,
      event.metadata ?? null,
    );
  } catch {
    /* fire-and-forget: silently ignore errors */
  }
}

// ── Query (M-1) ─────────────────────────────────────────────────────────────

/**
 * Retrieve usage events, optionally filtered by event_type and/or entry_ref.
 */
export function getUsageEvents(db: Database, filters?: UsageEventFilters): UsageEventRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.event_type) {
    conditions.push("event_type = ?");
    params.push(filters.event_type);
  }
  if (filters?.entry_ref) {
    conditions.push("entry_ref = ?");
    params.push(filters.entry_ref);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT id, event_type, query, entry_id, entry_ref, signal, metadata, created_at
               FROM usage_events ${where}
               ORDER BY id ASC`;

  return db.prepare(sql).all(...(params as import("bun:sqlite").SQLQueryBindings[])) as UsageEventRow[];
}

// ── M-2: Utility scoring helpers ────────────────────────────────────────────

/**
 * Get usage event counts for an entry, grouped by event type.
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
    return { searchCount: 0, showCount: 0 };
  }
}

/**
 * Get the most recent created_at for any event on this entry.
 */
export function getLastUsedAt(db: Database, entryId: number): string | undefined {
  try {
    const row = db.prepare("SELECT MAX(created_at) AS last_used FROM usage_events WHERE entry_id = ?").get(entryId) as
      | { last_used: string | null }
      | undefined;
    return row?.last_used ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Record a usage event (used by M-2 tests and utility scoring).
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
    /* Table may not exist yet */
  }
}
