/**
 * Usage event tracking for the MemRL utility-based re-ranking system.
 *
 * Records search appearances and show events for entries, which are
 * later aggregated by recomputeUtilityScores() during `akm index`.
 */

import type { Database } from "bun:sqlite";

// ── Types ───────────────────────────────────────────────────────────────────

export interface UsageEvent {
  eventType: "search" | "show";
  entryId: number;
  timestamp: string;
  query?: string;
}

// ── Event recording ─────────────────────────────────────────────────────────

/**
 * Record a usage event (search appearance or show) for an entry.
 */
export function recordUsageEvent(db: Database, event: UsageEvent): void {
  db.prepare("INSERT INTO usage_events (event_type, entry_id, timestamp, query) VALUES (?, ?, ?, ?)").run(
    event.eventType,
    event.entryId,
    event.timestamp,
    event.query ?? null,
  );
}

/**
 * Get usage event counts for an entry, grouped by event type.
 */
export function getUsageEventCounts(db: Database, entryId: number): { searchCount: number; showCount: number } {
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
}

/**
 * Get the most recent timestamp for any event on this entry.
 */
export function getLastUsedAt(db: Database, entryId: number): string | undefined {
  const row = db.prepare("SELECT MAX(timestamp) AS last_used FROM usage_events WHERE entry_id = ?").get(entryId) as
    | { last_used: string | null }
    | undefined;
  return row?.last_used ?? undefined;
}
