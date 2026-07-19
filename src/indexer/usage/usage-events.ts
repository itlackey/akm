// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Usage event helpers for telemetry and utility-based re-ranking.
 *
 * Schema (created by ensureUsageEventsSchema):
 *   id, event_type, query, entry_id (nullable), entry_ref, signal, metadata, source, created_at
 */

import { legacyConceptId, parseStoredRef } from "../../migrate/legacy-ref-grammar";
import type { Database, SqlValue } from "../../storage/database";

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Provenance of a usage event. `"user"` = interactive/direct invocation
 * (including agent sessions acting for the user); `"improve"` = the improve
 * pipeline's own retrievals (reflect/distill agents); `"task"` = the task
 * runner (scheduled/cron work). Non-`"user"` sources are machine demand and
 * are excluded from retrieval-derived ranking signals (`getRetrievalCounts`,
 * utility bumps) so pipeline traffic cannot inflate them (meta-review 05
 * DRIFT-6). Propagated across process boundaries via `AKM_EVENT_SOURCE`.
 */
export type UsageEventSource = "user" | "improve" | "task";

export interface UsageEvent {
  event_type: string;
  query?: string;
  entry_id?: number;
  entry_ref?: string;
  signal?: string;
  metadata?: string;
  /** Event source (see {@link UsageEventSource}). Defaults to `"user"` when omitted. */
  source?: UsageEventSource;
}

export interface UsageEventRow {
  id: number;
  event_type: string;
  query: string | null;
  entry_id: number | null;
  entry_ref: string | null;
  signal: string | null;
  metadata: string | null;
  source: string;
  created_at: string;
}

export interface UsageEventFilters {
  event_type?: string;
  entry_ref?: string;
  source?: UsageEventSource;
  /**
   * Inclusive lower bound on `created_at` (SQLite `YYYY-MM-DD HH:MM:SS`
   * timestamp). When set, only events with `created_at >= since` are returned.
   * Mirrors the `--since` filter formerly hand-rolled in `akm history`.
   */
  since?: string;
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
      source     TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_usage_events_entry ON usage_events(entry_id);
    CREATE INDEX IF NOT EXISTS idx_usage_events_type ON usage_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_usage_events_ref ON usage_events(entry_ref);
    CREATE INDEX IF NOT EXISTS idx_usage_events_source ON usage_events(source);
  `);
}

// ── Insert ───────────────────────────────────────────────────────────────────

/**
 * Insert a usage event into the database. Fire-and-forget: errors are
 * silently caught so callers are never blocked or disrupted.
 */
export function insertUsageEvent(db: Database, event: UsageEvent): void {
  try {
    db.prepare(
      `INSERT INTO usage_events (event_type, query, entry_id, entry_ref, signal, metadata, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.event_type,
      event.query ?? null,
      event.entry_id ?? null,
      event.entry_ref ?? null,
      event.signal ?? null,
      event.metadata ?? null,
      event.source ?? "user",
    );
  } catch {
    /* fire-and-forget: silently ignore errors */
  }
}

/**
 * Bare-form candidate a bare `entry_ref` filter matches a stored row under.
 * Post-flip every stored row is conceptId-spelled, so the filter is normalized
 * to its conceptId form (accepting a still-legacy `type:name` filter, which maps
 * onto the same conceptId) and matched against that alone.
 *
 * Chunk-8: once the state.db re-key lands and every input is the new grammar,
 * this reduces to the trimmed conceptId.
 */
function usageEventBareCandidates(ref: string): string[] {
  const trimmed = ref.trim();
  try {
    const parsed = parseStoredRef(trimmed);
    return [legacyConceptId(parsed.type, parsed.name)];
  } catch {
    return [trimmed];
  }
}

// ── Query ────────────────────────────────────────────────────────────────────

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
    if (filters.entry_ref.includes("//")) {
      // Fully-qualified filter (`bundle//conceptId` or legacy `origin//type:name`)
      // — the user named a specific bundle/origin, so match it exactly.
      conditions.push("entry_ref = ?");
      params.push(filters.entry_ref);
    } else {
      // Bare filter — match the stored bare form (everything after the first
      // `//`, or the whole value when un-qualified) against the conceptId the
      // filter normalizes to.
      const candidates = usageEventBareCandidates(filters.entry_ref);
      const placeholders = candidates.map(() => "?").join(", ");
      conditions.push(
        `(CASE WHEN instr(entry_ref, '//') > 0 THEN substr(entry_ref, instr(entry_ref, '//') + 2) ELSE entry_ref END) ` +
          `IN (${placeholders})`,
      );
      params.push(...candidates);
    }
  }
  if (filters?.source) {
    conditions.push("source = ?");
    params.push(filters.source);
  }
  if (filters?.since) {
    conditions.push("created_at >= ?");
    params.push(filters.since);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT id, event_type, query, entry_id, entry_ref, signal, metadata, source, created_at
               FROM usage_events ${where}
               ORDER BY id ASC`;

  return db.prepare(sql).all(...(params as SqlValue[])) as UsageEventRow[];
}

/**
 * Aggregate positive/negative feedback counts for a single entry.
 *
 * Lifted verbatim from `akm feedback` (feedback-cli.ts) where the same
 * SUM(CASE …) query was hand-rolled inline. Returns plain numbers (NULL SUMs
 * over an empty set are coalesced to 0) so the result fully materialises before
 * any owning connection closes.
 */
export function countFeedbackSignals(db: Database, entryId: number): { pos: number; neg: number } {
  const counts = db
    .prepare(
      `SELECT
         SUM(CASE WHEN signal = 'positive' THEN 1 ELSE 0 END) AS pos,
         SUM(CASE WHEN signal = 'negative' THEN 1 ELSE 0 END) AS neg
       FROM usage_events
       WHERE event_type = 'feedback' AND entry_id = ?`,
    )
    .get(entryId) as { pos: number | null; neg: number | null } | undefined;
  return { pos: counts?.pos ?? 0, neg: counts?.neg ?? 0 };
}

/**
 * Count usage events of a given `event_type`.
 *
 * Lifted verbatim from `akm improve` (improve.ts) where the show-event count
 * was hand-rolled inline to drive the zero-feedback fallback warning.
 */
export function countUsageEventsByType(db: Database, eventType: string): number {
  return (db.prepare("SELECT COUNT(*) AS cnt FROM usage_events WHERE event_type = ?").get(eventType) as { cnt: number })
    .cnt;
}

/**
 * Delete usage events older than the given number of days.
 */
export function purgeOldUsageEvents(db: Database, retentionDays: number): void {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return;
  try {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    db.prepare("DELETE FROM usage_events WHERE created_at < ?").run(cutoff);
  } catch {
    /* Table may not exist yet */
  }
}
