/**
 * `akm history` — surfaces internal mutation/usage events captured in the
 * `usage_events` SQLite table for a single asset (`--ref`) or stash-wide.
 *
 * Backed by `usage_events` (search/show/feedback today). Richer per-asset
 * lifecycle entries (add/edit/delete) require the events stream introduced
 * in #204; this command surfaces whatever the indexer has captured so
 * downstream tooling stops reinventing audit trails.
 */

import type { Database } from "bun:sqlite";
import { parseAssetRef } from "../core/asset-ref";
import { UsageError } from "../core/errors";
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
  warnings?: string[];
}

export interface HistoryOptions {
  ref?: string;
  since?: string;
  /** Test seam — caller-supplied DB. Defaults to opening the cache DB. */
  db?: Database;
}

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

// ── Main ─────────────────────────────────────────────────────────────────────

/**
 * Read mutation/usage history. When `ref` is provided, results are filtered to
 * that asset (validated via `parseAssetRef`). Always returns chronological
 * order (oldest first) so consumers can display a lifecycle trail.
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
    const entries = rows.map(toEntry);

    const response: HistoryResponse = {
      schemaVersion: 1,
      ...(normalizedRef !== undefined ? { ref: normalizedRef } : {}),
      ...(sinceNormalized !== undefined ? { since: sinceNormalized } : {}),
      totalCount: entries.length,
      entries,
    };
    return response;
  } finally {
    if (ownsDb) closeDatabase(db);
  }
}
