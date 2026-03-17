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

// ── Insert ──────────────────────────────────────────────────────────────────

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

// ── Query ───────────────────────────────────────────────────────────────────

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
