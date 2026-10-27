// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Repository for the state.db `events` table (append-only event bus) and the
 * one-time `events.jsonl` importer. Extracted verbatim from core/state-db.ts —
 * queries and behaviour unchanged, only relocated behind the repository
 * boundary. Re-exported by core/state-db.ts so existing importers resolve.
 *
 * @module events-repository
 */

import type { EventEnvelope } from "../../core/events-types";
import { isReadOnlyFilesystemError } from "../../core/system-error";
import { error } from "../../core/warn";
import type { Database, SqlValue } from "../database";

/**
 * Raw SQLite row shape for the `events` table.
 *
 * Maps to {@link EventEnvelope} as follows:
 *   EventEnvelope.id           ← EventRow.id        (monotonic rowid; replaces byte-offset)
 *   EventEnvelope.schemaVersion ← always 1 for current rows
 *   EventEnvelope.ts           ← EventRow.ts
 *   EventEnvelope.eventType    ← EventRow.event_type
 *   EventEnvelope.ref          ← EventRow.ref         (nullable)
 *   EventEnvelope.metadata     ← JSON.parse(EventRow.metadata_json)
 */
export interface EventRow {
  id: number;
  event_type: string;
  ts: string;
  ref: string | null;
  metadata_json: string;
}

/**
 * Convert a raw `EventRow` from the database to the public `EventEnvelope`
 * interface used throughout the events module.
 */
export function eventRowToEnvelope(row: EventRow): EventEnvelope {
  let metadata: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(row.metadata_json) as Record<string, unknown>;
    // Only attach metadata when the JSON blob is non-empty so downstream
    // consumers that check `envelope.metadata !== undefined` keep working.
    if (Object.keys(parsed).length > 0) {
      metadata = parsed;
    }
  } catch {
    // Corrupt JSON in the DB — treat as no metadata.
  }
  return {
    schemaVersion: 1,
    id: row.id,
    ts: row.ts,
    eventType: row.event_type,
    ...(row.ref !== null ? { ref: row.ref } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

/**
 * Insert a single event. Returns the auto-assigned monotonic rowid, which
 * callers can store as a "sinceId" cursor for future `readEventsSince` calls.
 *
 * Best-effort: mirrors the behaviour of the old `appendEvent` — errors are
 * caught and logged to stderr rather than propagated so observability never
 * breaks mutation.
 */
export function insertEvent(
  db: Database,
  input: {
    eventType: string;
    ts: string;
    ref?: string;
    metadata?: Record<string, unknown>;
  },
): number | undefined {
  try {
    return insertEventStrict(db, input);
  } catch (err) {
    if (isReadOnlyFilesystemError(err)) return undefined;
    const message = err instanceof Error ? err.message : String(err);
    error(`akm: state.db event insert failed (${message})`);
    return undefined;
  }
}

/** Insert an event without best-effort error swallowing for transaction-coupled mutations. */
export function insertEventStrict(
  db: Database,
  input: {
    eventType: string;
    ts: string;
    ref?: string;
    metadata?: Record<string, unknown>;
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO events (event_type, ts, ref, metadata_json)
       VALUES (?, ?, ?, ?)
       RETURNING id`,
    )
    .get(input.eventType, input.ts, input.ref ?? null, JSON.stringify(input.metadata ?? {})) as
    | { id: number }
    | undefined;
  if (!result) throw new Error(`Failed to persist ${input.eventType} event.`);
  return result.id;
}

/** Strict idempotent event insert for durable mutation journals. */
export function insertEventOnce(
  db: Database,
  input: {
    eventType: string;
    ts: string;
    ref?: string;
    metadata: Record<string, unknown>;
    idempotencyKey: string;
    idempotencyMetadataKey?: string;
  },
): number {
  const rows = db
    .prepare("SELECT id, metadata_json FROM events WHERE event_type = ? AND ref IS ? ORDER BY id")
    .all(input.eventType, input.ref ?? null) as Array<{ id: number; metadata_json: string }>;
  for (const row of rows) {
    try {
      const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      if (metadata[input.idempotencyMetadataKey ?? "proposalTransactionId"] === input.idempotencyKey) return row.id;
    } catch {
      // Corrupt unrelated event metadata cannot satisfy this idempotency key.
    }
  }
  const result = db
    .prepare(
      `INSERT INTO events (event_type, ts, ref, metadata_json)
       VALUES (?, ?, ?, ?)
       RETURNING id`,
    )
    .get(input.eventType, input.ts, input.ref ?? null, JSON.stringify(input.metadata)) as { id: number } | undefined;
  if (!result) throw new Error(`Failed to persist ${input.eventType} event.`);
  return result.id;
}

export interface ReadStateEventsOptions {
  /** Monotonic id lower bound: only return rows with id > sinceId. */
  sinceId?: number;
  /** ISO timestamp lower bound: only return rows with ts >= since. */
  since?: string;
  /** Filter to a single event_type. */
  type?: string;
  /** Filter to a single asset ref. */
  ref?: string;
  /**
   * D-38 (`akm log list --limit`): cap the number of rows returned to the
   * MOST RECENT `limit` matching the SQL-level filter above (id/ts/type/ref).
   *
   * Implemented as `ORDER BY id DESC LIMIT ?` — a real SQL LIMIT, not a
   * fetch-everything-then-slice — so a large event history is not read into
   * memory just to keep the last few rows. The DESC-ordered page is then
   * reversed before returning so the function's own ascending-id contract
   * (documented below) holds regardless of whether `limit` was supplied.
   *
   * Callers that also need to filter on event `metadata.tags` (not a SQL
   * column — see `readEvents` in `src/core/events.ts`) must NOT pass `limit`
   * here: a SQL-level LIMIT is applied BEFORE any JS-side post-filter, so
   * rows a tag filter would later drop still count against the cap, silently
   * returning fewer than `limit` (or the wrong — oldest-in-the-SQL-window —
   * ones). `readEvents` handles that by leaving this unset and applying
   * `limit` itself, AFTER its tag/type-alias post-filter.
   */
  limit?: number;
}

/**
 * Read events from the database matching the filter. Returns events in
 * ascending id order so consumers can process them in emission order —
 * true even when `options.limit` selects the most-recent page (see
 * {@link ReadStateEventsOptions.limit}).
 *
 * The returned `nextId` is the maximum id seen (or `sinceId` when no rows
 * match), suitable as the next `sinceId` cursor value. This is unaffected by
 * `limit`: it is always the id of the last row actually returned, which —
 * because a `limit` page is the MOST RECENT matching rows — is the same
 * value an unbounded read of the same filter would have produced.
 */
export function readStateEvents(
  db: Database,
  options: ReadStateEventsOptions = {},
): { events: EventEnvelope[]; nextId: number } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.sinceId !== undefined && options.sinceId > 0) {
    conditions.push("id > ?");
    params.push(options.sinceId);
  }
  if (options.since) {
    conditions.push("ts >= ?");
    params.push(options.since);
  }
  if (options.type) {
    conditions.push("event_type = ?");
    params.push(options.type);
  }
  if (options.ref) {
    conditions.push("ref = ?");
    params.push(options.ref);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const hasLimit = options.limit !== undefined && options.limit > 0;
  const orderAndLimit = hasLimit ? "ORDER BY id DESC LIMIT ?" : "ORDER BY id ASC";
  const queryParams = hasLimit ? [...params, options.limit] : params;
  const rows = db
    .prepare(`SELECT id, event_type, ts, ref, metadata_json FROM events ${where} ${orderAndLimit}`)
    .all(...(queryParams as SqlValue[])) as EventRow[];

  // A DESC-ordered LIMIT page comes back newest-first; reverse it so the
  // returned array is always ascending by id, matching the unbounded path.
  const events = (hasLimit ? rows.slice().reverse() : rows).map(eventRowToEnvelope);
  const nextId = events.length > 0 ? events[events.length - 1]!.id : (options.sinceId ?? 0);
  return { events, nextId };
}

/**
 * Delete events older than `retentionDays` (default: 90). Safe to call from
 * a maintenance cron; uses a single DELETE with an index-covered ts predicate.
 *
 * Returns the number of rows actually deleted so callers can emit an
 * `events_purged` observability event. A non-positive or non-finite
 * `retentionDays` is treated as "disabled" and returns 0 without scanning.
 */
export function purgeOldEvents(db: Database, retentionDays = 90): number {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const result = db.prepare("DELETE FROM events WHERE ts < ?").run(cutoff);
  // bun:sqlite's run() returns { changes, lastInsertRowid }. `changes` may be
  // a number or bigint depending on the underlying lib; coerce to number for
  // the metadata payload.
  const changes = (result as { changes?: number | bigint }).changes ?? 0;
  return typeof changes === "bigint" ? Number(changes) : changes;
}

/**
 * Rewrite every `events.ref` naming `oldBundleId` to `newBundleId` (`akm bundle
 * rename`). Improve reads an asset's feedback events by this ref, and
 * `insertEventOnce` finds a journal event by it under the proposal or workflow
 * ref the rename also rewrites, so an event left under the old prefix stops
 * counting for the renamed bundle. A legacy unqualified ref is not matched by
 * the `<old>//` prefix and is left alone; refs inside `metadata_json` are
 * history and stay as written. Returns the number of rows rewritten.
 */
export function renameEventRefs(db: Database, oldBundleId: string, newBundleId: string): number {
  const prefix = `${oldBundleId}//`;
  return Number(
    db
      .prepare(`UPDATE events SET ref = ? || substr(ref, length(?) + 1) WHERE substr(ref, 1, length(?)) = ?`)
      .run(newBundleId, oldBundleId, prefix, prefix).changes,
  );
}
