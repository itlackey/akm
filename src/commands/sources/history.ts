// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

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
import { parseAssetRef } from "../../core/asset-ref";
import { UsageError } from "../../core/errors";
import { type EventsContext, readEvents } from "../../core/events";
import { listProposals } from "../../core/proposals";
import { isoToSqlite, parseSinceToIso } from "../../core/time";
import { closeDatabase, openExistingDatabase } from "../../indexer/db";
import { getUsageEvents, type UsageEventRow } from "../../indexer/usage-events";

// ── Types ────────────────────────────────────────────────────────────────────

export interface HistoryEntry {
  id: number;
  eventType: string;
  ref: string | null;
  entryId: number | null;
  query: string | null;
  signal: string | null;
  source: string | null;
  metadata: unknown;
  createdAt: string;
}

/**
 * Per-source accept rate metrics for proposal-source aggregation (F-4 / #385).
 *
 * Provides the core self-measurement metric for recursive self-improvement:
 * if reflect proposals are accepted at 20% and distill proposals at 60%,
 * that guides resource allocation to higher-ROI generators.
 */
export interface AcceptRateEntry {
  /** Proposal source (one of PROPOSAL_SOURCES or a custom value). */
  source: string;
  /** Total proposals seen (accepted + rejected). */
  total: number;
  /** Proposals accepted. */
  accepted: number;
  /** Proposals rejected. */
  rejected: number;
  /** Proposals still pending (not yet decided). */
  pending: number;
  /** Accept rate as a fraction [0, 1]. null when total decided = 0. */
  acceptRate: number | null;
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
  /**
   * Accept-rate per proposal source (F-4 / #385). Present only when
   * `--accept-rate-by-source` flag is set. Enables self-measurement of
   * generator ROI for the recursive self-improvement loop.
   */
  acceptRateBySource?: AcceptRateEntry[];
  warnings?: string[];
}

export interface HistoryOptions {
  ref?: string;
  since?: string;
  /**
   * Filter by event source: "user" for direct CLI invocations, "improve" for
   * operations triggered by `akm improve`.
   */
  source?: "user" | "improve";
  /**
   * When true, proposal lifecycle events (`promoted`, `rejected`) from the
   * `events.jsonl` stream are merged into the history output alongside usage
   * events. This gives a complete view of an asset's lifecycle.
   *
   * Defaults to false — usage_events only — to preserve the existing behaviour
   * for callers that do not need proposal lifecycle visibility.
   */
  includeProposals?: boolean;
  /**
   * When true, compute accept-rate-per-source metrics from the proposal store
   * and include them in the response as `acceptRateBySource` (F-4 / #385).
   *
   * Requires access to the stash directory. Reads all proposals (pending,
   * accepted, rejected) from the `.akm/proposals/` tree.
   */
  acceptRateBySource?: boolean;
  /** Override stash directory for proposal store access. */
  stashDir?: string;
  /** Test seam — caller-supplied DB. Defaults to opening the cache DB. */
  db?: Database;
  /** Test seam — overrides events.jsonl path and clock for proposal events. */
  eventsCtx?: EventsContext;
}

// Proposal lifecycle event types emitted by the proposal substrate (#225).
const PROPOSAL_EVENT_TYPES = new Set(["promoted", "rejected"]);

// ── Helpers ──────────────────────────────────────────────────────────────────

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
    source: row.source,
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

  const sinceNormalized = options.since !== undefined ? isoToSqlite(parseSinceToIso(options.since)) : undefined;

  const db = options.db ?? openExistingDatabase();
  const ownsDb = options.db === undefined;
  try {
    const rows: UsageEventRow[] = getUsageEvents(db, {
      entry_ref: normalizedRef,
      since: sinceNormalized,
      source: options.source,
    });
    const usageEntries = rows.map(toEntry);

    // ── Proposal lifecycle events (opt-in) ────────────────────────────────
    const sources: string[] = ["usage_events"];
    const proposalEntries: HistoryEntry[] = [];

    if (options.includeProposals === true) {
      sources.push("state.db");

      // Convert sinceNormalized ("YYYY-MM-DD HH:MM:SS") to ISO for readEvents
      // which uses `ts >= since` where `ts` is ISO-8601.
      const sinceIso = sinceNormalized !== undefined ? `${sinceNormalized.replace(" ", "T")}Z` : undefined;

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
          source: null,
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

    // ── Accept-rate-per-source (F-4 / #385) ─────────────────────────────────
    let acceptRateBySource: AcceptRateEntry[] | undefined;
    if (options.acceptRateBySource) {
      const stashDir = options.stashDir;
      if (stashDir) {
        const bySource = new Map<string, { accepted: number; rejected: number; pending: number }>();

        const countProposals = (statuses: Array<"pending" | "accepted" | "rejected">, includeArchive: boolean) => {
          for (const status of statuses) {
            const proposals = listProposals(stashDir, { status, includeArchive });
            for (const p of proposals) {
              const src = p.source || "(unknown)";
              const entry = bySource.get(src) ?? { accepted: 0, rejected: 0, pending: 0 };
              if (status === "accepted") entry.accepted++;
              else if (status === "rejected") entry.rejected++;
              else entry.pending++;
              bySource.set(src, entry);
            }
          }
        };

        countProposals(["pending"], false);
        countProposals(["accepted", "rejected"], true);

        acceptRateBySource = Array.from(bySource.entries())
          .map(([source, counts]) => {
            const decided = counts.accepted + counts.rejected;
            return {
              source,
              total: decided + counts.pending,
              accepted: counts.accepted,
              rejected: counts.rejected,
              pending: counts.pending,
              acceptRate: decided > 0 ? counts.accepted / decided : null,
            } satisfies AcceptRateEntry;
          })
          .sort((a, b) => b.total - a.total); // Most active source first
      }
    }

    const response: HistoryResponse = {
      schemaVersion: 1,
      ...(normalizedRef !== undefined ? { ref: normalizedRef } : {}),
      ...(sinceNormalized !== undefined ? { since: sinceNormalized } : {}),
      totalCount: entries.length,
      entries,
      sources,
      ...(acceptRateBySource !== undefined ? { acceptRateBySource } : {}),
    };
    return response;
  } finally {
    if (ownsDb) closeDatabase(db);
  }
}
