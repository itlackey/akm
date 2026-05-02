/**
 * `akm history` — surfaces internal mutation/usage events for a single asset
 * (`--ref`) or stash-wide.
 *
 * Event sources:
 *   - `usage_events` SQLite table: search, show, and feedback events recorded
 *     by the local indexer during normal CLI use.
 *   - `events.jsonl` append-only stream (opt-in via `--include-proposals`):
 *     proposal lifecycle events (`promoted`, `rejected`) emitted by
 *     `akm proposal accept` / `akm proposal reject`. Use this flag to see
 *     the full proposal review trail alongside usage events.
 *
 * The two sources are merged and sorted chronologically (oldest first) so
 * consumers see a coherent lifecycle trail in a single output.
 */

import type { Database } from "bun:sqlite";
import { parseAssetRef } from "../core/asset-ref";
import { UsageError } from "../core/errors";
import { type EventsContext, readEvents } from "../core/events";
import { closeDatabase, openDatabase } from "../indexer/db";
import { ensureUsageEventsSchema, type UsageEventRow } from "../indexer/usage-events";

// ── Types ────────────────────────────────────────────────────────────────────

export interface HistoryEntry {
  id: number;
  eventType: string;
  ref: string | null;
  entryId: number | null;
  query: string | null;
  signal: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface HistoryResponse {
  schemaVersion: 1;
  ref?: string;
  since?: string;
  totalCount: number;
  entries: HistoryEntry[];
  /**
   * Event sources included in this response. Always contains "usage_events".
   * Also contains "events.jsonl" when `--include-proposals` was specified.
   */
  sources: string[];
  warnings?: string[];
}

export interface HistoryOptions {
  ref?: string;
  since?: string;
  /**
   * When true, proposal lifecycle events (`promoted`, `rejected`) from the
   * `events.jsonl` stream are merged into the history output alongside usage
   * events. This gives a complete view of an asset's lifecycle.
   *
   * Defaults to false — usage_events only — to preserve the existing behaviour
   * for callers that do not need proposal lifecycle visibility.
   */
  includeProposals?: boolean;
  /** Test seam — caller-supplied DB. Defaults to opening the cache DB. */
  db?: Database;
  /** Test seam — overrides events.jsonl path and clock for proposal events. */
  eventsCtx?: EventsContext;
}

// Proposal lifecycle event types emitted by the proposal substrate (#225).
const PROPOSAL_EVENT_TYPES = new Set(["promoted", "rejected"]);

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeSince(since: string): string {
  // Accept "YYYY-MM-DD", "YYYY-MM-DDTHH:MM:SSZ", epoch ms, or anything Date can parse.
  const trimmed = since.trim();
  if (!trimmed) {
    throw new UsageError("--since cannot be empty.", "INVALID_FLAG_VALUE");
  }
  // Pure-digit input → epoch milliseconds
  if (/^\d+$/.test(trimmed)) {
    const ms = Number.parseInt(trimmed, 10);
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) {
      throw new UsageError(`Invalid --since value: ${since}`, "INVALID_FLAG_VALUE");
    }
    return d
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d+Z$/, "");
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new UsageError(
      `Invalid --since value: ${since}. Expected ISO timestamp (e.g. 2026-04-01T00:00:00Z) or epoch ms.`,
      "INVALID_FLAG_VALUE",
    );
  }
  // Match the "YYYY-MM-DD HH:MM:SS" format SQLite's datetime('now') stores.
  return parsed
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "");
}

function parseMetadata(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function toEntry(row: UsageEventRow): HistoryEntry {
  return {
    id: row.id,
    eventType: row.event_type,
    ref: row.entry_ref,
    entryId: row.entry_id,
    query: row.query,
    signal: row.signal,
    metadata: parseMetadata(row.metadata),
    createdAt: row.created_at,
  };
}

/**
 * Convert an ISO timestamp from events.jsonl ("2026-04-01T12:00:00.000Z")
 * to the SQLite-style format used in HistoryEntry.createdAt
 * ("2026-04-01 12:00:00") so entries sort consistently.
 */
function isoToSqliteTimestamp(ts: string): string {
  // Normalise to the "YYYY-MM-DD HH:MM:SS" format used by usage_events rows.
  return ts
    .replace("T", " ")
    .replace(/\.\d+Z$/, "")
    .replace("Z", "");
}

// ── Main ─────────────────────────────────────────────────────────────────────

/**
 * Read mutation/usage history. When `ref` is provided, results are filtered to
 * that asset (validated via `parseAssetRef`). Always returns chronological
 * order (oldest first) so consumers can display a lifecycle trail.
 *
 * When `includeProposals` is true, proposal lifecycle events (`promoted`,
 * `rejected`) from events.jsonl are merged into the result set. This provides
 * one coherent view of both usage signals and proposal review decisions.
 */
export async function akmHistory(options: HistoryOptions = {}): Promise<HistoryResponse> {
  let normalizedRef: string | undefined;
  if (options.ref !== undefined) {
    const trimmed = options.ref.trim();
    if (!trimmed) {
      throw new UsageError("--ref cannot be empty.", "INVALID_FLAG_VALUE");
    }
    // Validate the ref grammar; we still query by exact entry_ref string so
    // the user gets back exactly what they asked for.
    parseAssetRef(trimmed);
    normalizedRef = trimmed;
  }

  const sinceNormalized = options.since !== undefined ? normalizeSince(options.since) : undefined;

  const db = options.db ?? openDatabase();
  const ownsDb = options.db === undefined;
  try {
    // The schema is normally created during `akm index`; ensure it exists so
    // `akm history` works on a freshly-initialised stash that has never been
    // indexed (and just returns an empty list rather than an error).
    ensureUsageEventsSchema(db);

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (normalizedRef !== undefined) {
      conditions.push("entry_ref = ?");
      params.push(normalizedRef);
    }
    if (sinceNormalized !== undefined) {
      conditions.push("created_at >= ?");
      params.push(sinceNormalized);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT id, event_type, query, entry_id, entry_ref, signal, metadata, created_at
                 FROM usage_events ${where}
                 ORDER BY id ASC`;

    const rows = db.prepare(sql).all(...(params as import("bun:sqlite").SQLQueryBindings[])) as UsageEventRow[];
    const usageEntries = rows.map(toEntry);

    // ── Proposal lifecycle events (opt-in) ────────────────────────────────
    const sources: string[] = ["usage_events"];
    const proposalEntries: HistoryEntry[] = [];

    if (options.includeProposals === true) {
      sources.push("events.jsonl");

      // Convert sinceNormalized ("YYYY-MM-DD HH:MM:SS") to ISO for readEvents
      // which uses `ts >= since` where `ts` is ISO-8601.
      const sinceIso = sinceNormalized !== undefined ? sinceNormalized.replace(" ", "T") + "Z" : undefined;

      const { events } = readEvents(
        {
          since: sinceIso,
          ref: normalizedRef,
        },
        options.eventsCtx,
      );

      // Keep only proposal lifecycle event types.
      let counter = -1_000_000; // negative ids mark proposal-stream entries
      for (const event of events) {
        if (!PROPOSAL_EVENT_TYPES.has(event.eventType)) continue;
        const createdAt = event.ts ? isoToSqliteTimestamp(event.ts) : "";
        // Skip if before `since` (readEvents already filters by ts >= since,
        // but the isoToSqliteTimestamp conversion may introduce drift so we
        // guard again with the normalised form).
        if (sinceNormalized !== undefined && createdAt < sinceNormalized) continue;
        proposalEntries.push({
          id: counter--,
          eventType: event.eventType,
          ref: event.ref ?? null,
          entryId: null,
          query: null,
          signal: null,
          metadata: event.metadata ?? null,
          createdAt,
        });
      }
    }

    // ── Merge and sort ────────────────────────────────────────────────────
    const entries = [...usageEntries, ...proposalEntries].sort((a, b) => {
      // Primary sort: chronological by createdAt (string compare is safe for
      // "YYYY-MM-DD HH:MM:SS" format). Secondary sort: id ascending for ties.
      if (a.createdAt < b.createdAt) return -1;
      if (a.createdAt > b.createdAt) return 1;
      return a.id - b.id;
    });

    const response: HistoryResponse = {
      schemaVersion: 1,
      ...(normalizedRef !== undefined ? { ref: normalizedRef } : {}),
      ...(sinceNormalized !== undefined ? { since: sinceNormalized } : {}),
      totalCount: entries.length,
      entries,
      sources,
    };
    return response;
  } finally {
    if (ownsDb) closeDatabase(db);
  }
}
