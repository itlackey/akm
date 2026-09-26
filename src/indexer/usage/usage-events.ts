// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Usage event helpers for telemetry and utility-based re-ranking.
 *
 * Schema (created by ensureUsageEventsSchema):
 *   id, event_type, query, entry_id (nullable), entry_ref, signal, metadata, source, created_at
 */

import { rethrowIfTestIsolationError } from "../../core/errors";
import type { Database } from "../../storage/database";

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Provenance of a usage event. `"user"` = interactive/direct invocation
 * (including agent sessions acting for the user); `"improve"` = the improve
 * pipeline's own retrievals; `"task"` = scheduled work; `"audit"` = eval or
 * measurement traffic; `"unknown"` = unattributed legacy/extension traffic.
 * Machine and unattributed sources are excluded from demand and utility.
 */
export type UsageEventSource = "user" | "improve" | "task" | "audit" | "unknown";

const USAGE_EVENT_SOURCES = new Set<UsageEventSource>(["user", "improve", "task", "audit", "unknown"]);

/**
 * Resolve subprocess provenance without treating an invalid value as user
 * demand.
 *
 * `fallback` (spec docs/plans/specs/p1b-model-extraction.md §5.2, F-1) is what
 * an unset/empty ambient value resolves to — it defaults to `"user"`, which
 * reproduces every pre-P1b call site byte-for-byte (P-07). A caller that
 * already knows the invocation's provenance (the task runner, threading its
 * `ExecutionProvenanceContext`) passes its resolved value as the fallback
 * instead, so a recognized ambient `AKM_EVENT_SOURCE` still wins everywhere it
 * won before, and only the *default* changes.
 */
export function resolveUsageEventSource(
  env: Record<string, string | undefined> = process.env,
  fallback: UsageEventSource = "user",
): UsageEventSource {
  const raw = env.AKM_EVENT_SOURCE;
  if (raw === undefined || raw === "") return fallback;
  return USAGE_EVENT_SOURCES.has(raw as UsageEventSource) ? (raw as UsageEventSource) : "unknown";
}

export interface UsageEvent {
  event_type: string;
  query?: string;
  entry_id?: number;
  entry_ref?: string;
  signal?: string;
  metadata?: string;
  /** Event source (see {@link UsageEventSource}). Omitted events are unattributed. */
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
      event.source ?? "unknown",
    );
  } catch (error) {
    rethrowIfTestIsolationError(error);
    /* fire-and-forget: silently ignore errors */
  }
}

// ── Query ────────────────────────────────────────────────────────────────────

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
       WHERE event_type = 'feedback' AND entry_id = ? AND source = 'user'`,
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
