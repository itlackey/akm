import { ensureUsageEventsSchema } from "../../src/indexer/usage/usage-events";
import type { Database } from "../../src/storage/database";

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
