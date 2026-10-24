// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `index.db` utility-score + retrieval-count repository (MemRL signals).
 *
 * Owns the raw SQL for `utility_scores` and the retrieval-frequency counting
 * over `usage_events`. The bounded-step EMA policy itself lives in
 * `indexer/feedback/utility-policy`; this repo only reads/writes.
 */

import { conceptIdFromTypeName, parseRefInput } from "../../core/asset/resolve-ref";
import {
  computeNextUtility,
  type FeedbackUtilityResult,
  NEUTRAL_UTILITY,
  replayFeedbackSignals,
} from "../../indexer/feedback/utility-policy";
import type { Database, SqlValue } from "../database";
import type { RetrievalCountOptions, UtilityScoreData, UtilityScoreRow } from "./index-entry-types";
import { ensureUtilityFeedbackColumns } from "./index-schema";
import { SQLITE_CHUNK_SIZE } from "./index-sql";

const feedbackColumnsPresent = new WeakMap<Database, boolean>();

/**
 * Whether `utility_scores` carries the feedback columns. A read of an index the
 * writable opener has not migrated yet does not; its rows then read as having
 * no feedback. Only a positive answer is memoized: the columns can appear on a
 * live connection, never vanish.
 */
function hasFeedbackColumns(db: Database): boolean {
  if (feedbackColumnsPresent.get(db) === true) return true;
  let present = false;
  try {
    present = (db.prepare("PRAGMA table_info(utility_scores)").all() as Array<{ name: string }>).some(
      (column) => column.name === "feedback_count",
    );
  } catch {
    present = false;
  }
  if (present) feedbackColumnsPresent.set(db, true);
  return present;
}

interface UtilityScoreSqlRow {
  entry_id: number;
  utility: number;
  show_count: number;
  search_count: number;
  select_rate: number;
  last_used_at: string | null;
  updated_at: string;
  feedback_score?: number | null;
  feedback_count?: number | null;
}

function utilityColumns(db: Database): string {
  const base = "entry_id, utility, show_count, search_count, select_rate, last_used_at, updated_at";
  return hasFeedbackColumns(db) ? `${base}, feedback_score, feedback_count` : base;
}

function toUtilityScoreRow(row: UtilityScoreSqlRow): UtilityScoreRow {
  return {
    entryId: row.entry_id,
    utility: row.utility,
    showCount: row.show_count,
    searchCount: row.search_count,
    selectRate: row.select_rate,
    lastUsedAt: row.last_used_at ?? undefined,
    updatedAt: row.updated_at,
    feedbackScore: row.feedback_score ?? undefined,
    feedbackCount: row.feedback_count ?? 0,
  };
}

/**
 * Get the utility score for an entry, or undefined if none exists.
 */
export function getUtilityScore(db: Database, entryId: number): UtilityScoreRow | undefined {
  const row = db.prepare(`SELECT ${utilityColumns(db)} FROM utility_scores WHERE entry_id = ?`).get(entryId) as
    | UtilityScoreSqlRow
    | undefined;
  return row ? toUtilityScoreRow(row) : undefined;
}

/**
 * Batch-load utility scores for multiple entry IDs, keyed by entry_id.
 */
export function getUtilityScoresByIds(db: Database, ids: number[]): Map<number, UtilityScoreRow> {
  const scores = new Map<number, UtilityScoreRow>();
  // Process in chunks to stay within SQLITE_MAX_VARIABLE_NUMBER
  for (let i = 0; i < ids.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT ${utilityColumns(db)} FROM utility_scores WHERE entry_id IN (${placeholders})`)
      .all(...chunk) as UtilityScoreSqlRow[];
    for (const row of rows) scores.set(row.entry_id, toUtilityScoreRow(row));
  }
  return scores;
}

/**
 * Insert or update a utility score for an entry.
 */
export function upsertUtilityScore(db: Database, entryId: number, data: UtilityScoreData): boolean {
  // Pre-flight FK guard (mirrors `upsertEmbedding`): when an entry is
  // deleted between when its id is aggregated from usage_events and when
  // this INSERT runs, the FK constraint fails and rolls back the entire
  // finalize transaction. A cheap SELECT here turns the race into a
  // clean skip. Returns false when the entry no longer exists.
  const exists = db.prepare("SELECT 1 FROM entries WHERE id = ?").get(entryId);
  if (!exists) return false;

  db.prepare(`
    INSERT INTO utility_scores (entry_id, utility, show_count, search_count, select_rate, last_used_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(entry_id) DO UPDATE SET
      utility = excluded.utility,
      show_count = excluded.show_count,
      search_count = excluded.search_count,
      select_rate = excluded.select_rate,
      last_used_at = excluded.last_used_at,
      updated_at = datetime('now')
  `).run(entryId, data.utility, data.showCount, data.searchCount, data.selectRate, data.lastUsedAt ?? null);
  return true;
}

/**
 * Reduce a stored ref to its bare form, dropping any `origin//` / `bundle//`
 * prefix, matching the counting SQL's `substr` after the first `//`.
 */
function bareRef(ref: string): string {
  const boundary = ref.indexOf("//");
  return boundary >= 0 ? ref.slice(boundary + 2) : ref;
}

/**
 * The bare-form (conceptId) candidate a caller ref matches a stored
 * `usage_events` row under. Every stored row is conceptId-spelled, so the
 * conceptId is the only candidate.
 */
function bareRefCandidates(ref: string): string[] {
  const bare = bareRef(ref.trim());
  const parsed = parseRefInput(bare);
  return [conceptIdFromTypeName(parsed.type, parsed.name)];
}

/**
 * Count retrieval events for the given entry refs.
 *
 * Counts `search`, `show`, and `curate` usage events. Returns a
 * Map<inputRef, count> keyed by the *input* ref strings (only those with at
 * least one matching event appear). Used by the improve loop's
 * proactive-maintenance selector to rank zero-feedback assets by retrieval
 * frequency.
 *
 * Source-scoped callers require either an event linked to an entry in the
 * selected stash root or a detached ref qualified with the selected source
 * name.
 *
 * `curate` events are included: their per-item rows are written with
 * entry_ref populated (see logCurateEvent), so curation is a real retrieval
 * signal here. Summary-only rows with a NULL entry_ref contribute nothing.
 *
 * Machine/eval/unattributed/extension events are excluded: this count feeds
 * salience, so only explicitly attributed `user` traffic counts.
 */
export function getRetrievalCounts(
  indexDb: Database,
  stateDb: Database,
  refs: string[],
  options: RetrievalCountOptions = {},
): Map<string, number> {
  if (refs.length === 0) return new Map();

  if (options.sourceName) {
    return getSourceScopedRetrievalCounts(indexDb, stateDb, refs, options);
  }

  // Map each conceptId back to the input refs that produced it so DB results
  // can be re-keyed onto the caller's strings.
  const bareToInputs = new Map<string, string[]>();
  for (const ref of refs) {
    for (const bare of bareRefCandidates(ref)) {
      const existing = bareToInputs.get(bare);
      if (existing) existing.push(ref);
      else bareToInputs.set(bare, [ref]);
    }
  }
  const bareForms = [...bareToInputs.keys()];

  // Accumulate counts per bare form across chunks before re-keying.
  const countsByBare = new Map<string, number>();
  // Chunk to stay within SQLITE_MAX_VARIABLE_NUMBER (same pattern as getUtilityScoresByIds).
  for (let i = 0; i < bareForms.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = bareForms.slice(i, i + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    // Normalize the stored entry_ref to its bare form inside SQL by stripping
    // everything up to and including the last `//` separator. SQLite has no
    // rfind, but stored origins never themselves contain `//`, so a stash ref
    // has exactly one `//` and `substr(... instr ...)` is exact; bare refs have
    // no `//` and are excluded above.
    // usage_events lives in state.db; this global count needs no entries join,
    // so it reads state.db directly.
    const rows = stateDb
      .prepare(
        `SELECT
           CASE
             WHEN instr(entry_ref, '//') > 0
               THEN substr(entry_ref, instr(entry_ref, '//') + 2)
             ELSE entry_ref
           END AS bare_ref,
           COUNT(*) AS cnt
         FROM usage_events
         WHERE event_type IN ('search','show','curate')
           AND entry_ref IS NOT NULL
           AND instr(entry_ref, '//') > 0
           AND source = 'user'
           AND CASE
                 WHEN instr(entry_ref, '//') > 0
                   THEN substr(entry_ref, instr(entry_ref, '//') + 2)
                 ELSE entry_ref
               END IN (${placeholders})
         GROUP BY bare_ref`,
      )
      .all(...(chunk as SqlValue[])) as Array<{ bare_ref: string; cnt: number }>;
    for (const r of rows) {
      countsByBare.set(r.bare_ref, (countsByBare.get(r.bare_ref) ?? 0) + r.cnt);
    }
  }

  // Re-key bare-form counts onto every input ref that maps to that bare form.
  const result = new Map<string, number>();
  for (const [bare, count] of countsByBare) {
    for (const input of bareToInputs.get(bare) ?? []) {
      result.set(input, count);
    }
  }
  return result;
}

function getSourceScopedRetrievalCounts(
  indexDb: Database,
  stateDb: Database,
  refs: string[],
  options: RetrievalCountOptions,
): Map<string, number> {
  const bareToInputs = new Map<string, string[]>();
  for (const ref of refs) {
    for (const bare of bareRefCandidates(ref)) {
      const inputs = bareToInputs.get(bare);
      if (inputs) inputs.push(ref);
      else bareToInputs.set(bare, [ref]);
    }
  }

  // Cross-DB: usage rows come from state.db; resolve the linked entry's
  // canonical bundle identity from index.db by entry_id.
  const entryBundle = indexDb.prepare("SELECT bundle_id FROM entries WHERE id = ?");
  const bundleFor = (entryId: number | null): string | null => {
    if (entryId === null) return null;
    const row = entryBundle.get(entryId) as { bundle_id: string } | undefined;
    return row?.bundle_id ?? null;
  };

  const countsByBare = new Map<string, number>();
  const bareForms = [...bareToInputs.keys()];
  const selectedBundle = options.sourceName;
  for (let i = 0; i < bareForms.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = bareForms.slice(i, i + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    const rawRows = stateDb
      .prepare(
        `SELECT ue.entry_ref, ue.entry_id
           FROM usage_events ue
          WHERE ue.event_type IN ('search','show','curate')
            AND ue.entry_ref IS NOT NULL
            AND instr(ue.entry_ref, '//') > 0
            AND ue.source = 'user'
            AND CASE
                  WHEN instr(ue.entry_ref, '//') > 0
                    THEN substr(ue.entry_ref, instr(ue.entry_ref, '//') + 2)
                  ELSE ue.entry_ref
                END IN (${placeholders})`,
      )
      .all(...(chunk as SqlValue[])) as Array<{
      entry_ref: string;
      entry_id: number | null;
    }>;
    const rows = rawRows.map((r) => ({ ...r, bundle_id: bundleFor(r.entry_id) }));

    for (const row of rows) {
      const bare = bareRef(row.entry_ref);
      const linkedToSelectedBundle = row.entry_id !== null && row.bundle_id === selectedBundle;
      const detached = row.entry_id === null;
      const qualifiedForSource =
        detached && options.sourceName !== undefined && row.entry_ref === `${options.sourceName}//${bare}`;
      if (!linkedToSelectedBundle && !qualifiedForSource) continue;
      countsByBare.set(bare, (countsByBare.get(bare) ?? 0) + 1);
    }
  }

  const result = new Map<string, number>();
  for (const [bare, count] of countsByBare) {
    for (const input of bareToInputs.get(bare) ?? []) result.set(input, count);
  }
  return result;
}

/**
 * Apply accumulated feedback counts to an entry's scores, persisting the result.
 * The bounded-step EMA policy itself (MemRL, #386, arXiv:2601.03192) lives
 * in {@link computeNextUtility} (feedback/utility-policy); this function only
 * reads the current scores, applies the policy, and writes the new values.
 *
 * Two scores move by the same step. `utility` (which `akm improve` reads) starts
 * from the stored value, or the 0.5 midpoint for a new entry. `feedback_score`
 * (which search ranks by) starts from the 0.5 midpoint and moves on feedback
 * alone, and `feedback_count` becomes the number of events behind it. When there
 * is no feedback (both counts zero) nothing is written. Returns a
 * {@link FeedbackUtilityResult} for the `utility` step so the caller can detect a
 * previously high-utility asset crossing below the review threshold and escalate.
 */
export function applyFeedbackToUtilityScore(
  db: Database,
  entryId: number,
  positiveCount: number,
  negativeCount: number,
): FeedbackUtilityResult {
  ensureUtilityFeedbackColumns(db);
  const existing = getUtilityScore(db, entryId);
  const previousUtility = existing?.utility ?? NEUTRAL_UTILITY;

  const result = computeNextUtility(previousUtility, positiveCount, negativeCount);

  if (positiveCount === 0 && negativeCount === 0) {
    return result;
  }

  const feedbackScore = computeNextUtility(
    existing?.feedbackScore ?? NEUTRAL_UTILITY,
    positiveCount,
    negativeCount,
  ).nextUtility;
  const feedbackCount = positiveCount + negativeCount;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO utility_scores (entry_id, utility, show_count, search_count, select_rate, last_used_at, updated_at, feedback_score, feedback_count)
    VALUES (?, ?, 0, 0, 0, ?, ?, ?, ?)
    ON CONFLICT(entry_id) DO UPDATE SET
      utility        = ?,
      updated_at     = ?,
      feedback_score = ?,
      feedback_count = ?
  `).run(
    entryId,
    result.nextUtility,
    now,
    now,
    feedbackScore,
    feedbackCount,
    result.nextUtility,
    now,
    feedbackScore,
    feedbackCount,
  );

  return result;
}

/** Store an entry's feedback score and the number of events behind it; `undefined` clears both. */
export function setFeedbackScore(
  db: Database,
  entryId: number,
  feedback: { score: number; count: number } | undefined,
): void {
  db.prepare("UPDATE utility_scores SET feedback_score = ?, feedback_count = ? WHERE entry_id = ?").run(
    feedback?.score ?? null,
    feedback?.count ?? 0,
    entryId,
  );
}

/**
 * Every entry's feedback score, rebuilt from the user-attributed feedback events
 * in state.db: each entry's signals, oldest first, replayed from the 0.5 midpoint
 * (see {@link replayFeedbackSignals}). Search and show history never enter it.
 */
export function replayUserFeedback(stateDb: Database): Map<number, { score: number; count: number }> {
  const rows = stateDb
    .prepare(
      `SELECT entry_id, signal FROM usage_events
        WHERE event_type = 'feedback' AND source = 'user' AND entry_id IS NOT NULL
          AND signal IN ('positive', 'negative')
        ORDER BY id`,
    )
    .all() as Array<{ entry_id: number; signal: "positive" | "negative" }>;
  const signalsByEntry = new Map<number, Array<"positive" | "negative">>();
  for (const { entry_id, signal } of rows) {
    const signals = signalsByEntry.get(entry_id);
    if (signals) signals.push(signal);
    else signalsByEntry.set(entry_id, [signal]);
  }
  return new Map([...signalsByEntry].map(([entryId, signals]) => [entryId, replayFeedbackSignals(signals)]));
}

/** One indexed entry with its utility score, or `undefined` scores when it has none. */
export interface UtilityWithRef {
  /** Durable `bundle//conceptId` (`entries.item_ref`). */
  ref: string;
  score?: Pick<UtilityScoreRow, "utility" | "showCount" | "searchCount" | "selectRate" | "lastUsedAt">;
}

/**
 * Every indexed entry with its `utility_scores` row (when it has one), for
 * `akm metrics`. `utility_scores` is keyed by the unstable `entry_id`, so the
 * join to `entries` is what yields a durable ref.
 */
export function listUtilityWithRefs(db: Database): UtilityWithRef[] {
  const rows = db
    .prepare(
      `SELECT e.item_ref AS ref, u.utility, u.show_count, u.search_count, u.select_rate, u.last_used_at
       FROM entries e LEFT JOIN utility_scores u ON u.entry_id = e.id
       ORDER BY e.item_ref`,
    )
    .all() as Array<{
    ref: string;
    utility: number | null;
    show_count: number | null;
    search_count: number | null;
    select_rate: number | null;
    last_used_at: string | null;
  }>;
  return rows.map((row) =>
    row.utility === null
      ? { ref: row.ref }
      : {
          ref: row.ref,
          score: {
            utility: row.utility,
            showCount: row.show_count ?? 0,
            searchCount: row.search_count ?? 0,
            selectRate: row.select_rate ?? 0,
            lastUsedAt: row.last_used_at ?? undefined,
          },
        },
  );
}
