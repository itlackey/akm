// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Repository for the state.db `extract_sessions_seen` table — the content-hash
 * ledger that governs which harness sessions the extractor reprocesses (#602).
 * Extracted verbatim from core/state-db.ts — queries and the pure
 * `shouldSkipAlreadyExtractedSession` decision unchanged, only relocated behind
 * the repository boundary. Re-exported by core/state-db.ts so existing importers
 * resolve.
 *
 * @module extract-sessions-repository
 */

import type { Database } from "../database";

/**
 * One row of the {@link extract_sessions_seen} table. Mirrors the SQL schema
 * documented in migration 004.
 */
export interface ExtractedSessionRow {
  harness: string;
  session_id: string;
  /** ISO-8601 UTC — when extract last processed this session. */
  processed_at: string;
  /** ISO-8601 — session.endedAt at processing time. Null when unknown. */
  session_ended_at: string | null;
  /** Outcome of the extract pass. */
  outcome:
    | "candidates_queued"
    | "candidates_blocked"
    | "proposal_write_failed"
    | "no_candidates"
    | "skipped"
    | "failed";
  candidate_count: number;
  proposal_count: number;
  /** For "no_candidates", the LLM's explanation. */
  rationale: string | null;
  /** sourceRun id for PROV-DM traceability. */
  source_run: string | null;
  metadata_json: string;
  /**
   * sha256 (hex) of the normalized session content at processing time. NULL for
   * rows written before #602 (migration 013) or when content was unavailable —
   * treated as a forced one-time reprocess to backfill the hash, after which the
   * row becomes hash-stable. This — not `session_ended_at` — is the skip
   * authority (#602).
   */
  content_hash: string | null;
}

/**
 * Record (or update) one session's extract outcome. INSERT-OR-REPLACE so the
 * row reflects the most recent run. The `content_hash` persisted here is what
 * the NEXT run compares against (#602): a byte-identical session is skipped, a
 * changed session is re-processed, and a NULL-backfill row becomes hash-stable
 * after its one reprocess. `session_ended_at` is still written for
 * telemetry/forensics but is no longer the skip authority.
 */
export function upsertExtractedSession(
  db: Database,
  input: {
    harness: string;
    sessionId: string;
    processedAt: string;
    sessionEndedAt?: number | null;
    outcome: ExtractedSessionRow["outcome"];
    candidateCount: number;
    proposalCount: number;
    rationale?: string | null;
    sourceRun?: string | null;
    metadata?: Record<string, unknown>;
    /** sha256 (hex) of the normalized session content, or null when unavailable. */
    contentHash: string | null;
  },
): void {
  const endedAtIso =
    typeof input.sessionEndedAt === "number" && Number.isFinite(input.sessionEndedAt)
      ? new Date(input.sessionEndedAt).toISOString()
      : null;
  db.prepare(`
    INSERT OR REPLACE INTO extract_sessions_seen
      (harness, session_id, processed_at, session_ended_at, outcome,
       candidate_count, proposal_count, rationale, source_run, metadata_json,
       content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.harness,
    input.sessionId,
    input.processedAt,
    endedAtIso,
    input.outcome,
    input.candidateCount,
    input.proposalCount,
    input.rationale ?? null,
    input.sourceRun ?? null,
    JSON.stringify(input.metadata ?? {}),
    input.contentHash,
  );
}

/**
 * Fetch a single session's last extract record, or `undefined` when the
 * session has never been processed.
 */
export function getExtractedSession(db: Database, harness: string, sessionId: string): ExtractedSessionRow | undefined {
  // bun:sqlite returns null (not undefined) when no row matches — normalize so
  // callers can rely on `if (!row)` and `toBeUndefined()` equivalently.
  const row = db
    .prepare("SELECT * FROM extract_sessions_seen WHERE harness = ? AND session_id = ?")
    .get(harness, sessionId) as ExtractedSessionRow | null;
  return row ?? undefined;
}

/**
 * Bulk-fetch session-extract status for a list of sessionIds in one harness.
 * Returns a Map keyed by sessionId so callers can do O(1) lookups while
 * iterating the discovery list.
 */
export function getExtractedSessionsMap(
  db: Database,
  harness: string,
  sessionIds: readonly string[],
): Map<string, ExtractedSessionRow> {
  const out = new Map<string, ExtractedSessionRow>();
  if (sessionIds.length === 0) return out;
  // SQLite has a ~999 param ceiling; chunk if a caller ever exceeds that.
  const CHUNK = 500;
  for (let i = 0; i < sessionIds.length; i += CHUNK) {
    const chunk = sessionIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT * FROM extract_sessions_seen
         WHERE harness = ? AND session_id IN (${placeholders})`,
      )
      .all(harness, ...chunk) as ExtractedSessionRow[];
    for (const row of rows) out.set(row.session_id, row);
  }
  return out;
}

/**
 * The most recent extract-run time for a harness — `MAX(processed_at)` across
 * its ledger rows, as ms epoch — or `null` when the harness has never been
 * extracted. Used to default the discovery window to "since the last run" so an
 * intermittently-online host that was off for days still rediscovers sessions
 * that ended during the gap (the content-hash ledger keeps the widened window
 * free of redundant LLM cost).
 */
export function getLastExtractRunAt(db: Database, harness: string): number | null {
  const row = db
    .prepare("SELECT MAX(processed_at) AS last FROM extract_sessions_seen WHERE harness = ?")
    .get(harness) as { last: string | null } | null;
  if (!row?.last) return null;
  const ms = Date.parse(row.last);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * One grouped row of {@link getExtractOutcomeCountsSince}: how many sessions
 * a harness recorded with a given outcome/skipReason/engine combination.
 */
export interface ExtractOutcomeCount {
  harness: string;
  outcome: ExtractedSessionRow["outcome"];
  /** `metadata_json.skipReason`, or `null` for a non-skip outcome or a row a pre-#912 release wrote (no such key). */
  skipReason: string | null;
  /** `metadata_json.engine`, or `null` for a row a pre-#913 release wrote (no such key). */
  engine: string | null;
  count: number;
}

/**
 * #914: outcome counts from the `extract_sessions_seen` ledger since
 * `sinceIso`, grouped by harness/outcome/skipReason/engine. This is what lets
 * `akm health`'s `session-extraction` check derive its verdict from what
 * standalone `akm proposal extract` actually recorded — the only write path
 * the hook-driven SessionEnd extraction uses (`improve_runs` is never
 * populated by it). `skipReason`/`engine` are read from `metadata_json` via
 * `json_extract` and come back `null` both for a non-skip outcome and for a
 * row a release before #912/#913 wrote (no key at that path) — callers must
 * treat a `null` reason as "skipped, reason unknown", not as evidence of a
 * specific cause.
 */
export function getExtractOutcomeCountsSince(db: Database, sinceIso: string): ExtractOutcomeCount[] {
  return db
    .prepare(
      `SELECT harness, outcome,
              json_extract(metadata_json, '$.skipReason') AS skipReason,
              json_extract(metadata_json, '$.engine') AS engine,
              COUNT(*) AS count
       FROM extract_sessions_seen
       WHERE processed_at >= ?
       GROUP BY harness, outcome, skipReason, engine`,
    )
    .all(sinceIso) as ExtractOutcomeCount[];
}

/**
 * Decide whether a session should be skipped because the extractor has already
 * processed BYTE-IDENTICAL content (#602). The skip authority is the content
 * hash, NOT `session_ended_at` — this is clock-independent, so it is immune to
 * the clock-skew / out-of-order-endedAt problems that caused the Jun 11-12
 * double-extract + over-throttle incident.
 *
 * Rules:
 *   - no prior row              → `false` (never seen → process; AC3).
 *   - prior.content_hash == null → `false` (legacy / hash-less row → process
 *     exactly once to backfill the hash, then it becomes hash-stable; AC4).
 *   - hashes equal              → `true`  (unchanged content → skip; AC1).
 *   - hashes differ             → `false` (changed content → re-process; AC2).
 */
export function shouldSkipAlreadyExtractedSession(
  prior: ExtractedSessionRow | undefined,
  currentContentHash: string,
): boolean {
  if (!prior) return false;
  if (prior.content_hash == null) return false;
  return prior.content_hash === currentContentHash;
}
