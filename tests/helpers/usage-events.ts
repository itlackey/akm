import type { Database } from "bun:sqlite";
import { ensureUsageEventsSchema } from "../../src/usage-events";

/**
 * Record a usage event (test-only helper for M-2 utility scoring tests).
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
