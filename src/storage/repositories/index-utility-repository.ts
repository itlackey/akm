// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `index.db` utility-score + retrieval-count repository (MemRL signals).
 *
 * Owns the raw SQL for `utility_scores` / `utility_scores_scoped` and the
 * retrieval-frequency counting over `usage_events`. The bounded-step EMA policy
 * itself lives in `indexer/feedback/utility-policy`; this repo only reads/writes.
 * Extracted verbatim from `src/indexer/db/db.ts` (WI-5a).
 */

import path from "node:path";
import { parseAssetRef } from "../../core/asset/asset-ref";
import { computeNextUtility, type FeedbackUtilityResult } from "../../indexer/feedback/utility-policy";
import type { Database, SqlValue } from "../database";
import type { RetrievalCountOptions, ScopedUtilityRow, UtilityScoreData, UtilityScoreRow } from "./index-entry-types";
import { SQLITE_CHUNK_SIZE } from "./index-sql";

/**
 * Get the utility score for an entry, or undefined if none exists.
 */
export function getUtilityScore(db: Database, entryId: number): UtilityScoreRow | undefined {
  const row = db
    .prepare(
      "SELECT entry_id, utility, show_count, search_count, select_rate, last_used_at, updated_at FROM utility_scores WHERE entry_id = ?",
    )
    .get(entryId) as
    | {
        entry_id: number;
        utility: number;
        show_count: number;
        search_count: number;
        select_rate: number;
        last_used_at: string | null;
        updated_at: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    entryId: row.entry_id,
    utility: row.utility,
    showCount: row.show_count,
    searchCount: row.search_count,
    selectRate: row.select_rate,
    lastUsedAt: row.last_used_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

/**
 * Batch-load utility scores for multiple entry IDs in a single query.
 * Returns a `{ global, scoped }` pair, both Maps keyed by entry_id.
 *
 * When `scopeKey` is provided a second query runs against
 * `utility_scores_scoped` and the result is returned as `scoped`.
 * Both maps are always present; `scoped` is empty when `scopeKey` is absent.
 */
export function getUtilityScoresByIds(
  db: Database,
  ids: number[],
  scopeKey?: string,
): { global: Map<number, UtilityScoreRow>; scoped: Map<number, ScopedUtilityRow> } {
  const global = new Map<number, UtilityScoreRow>();
  const scoped = new Map<number, ScopedUtilityRow>();
  if (ids.length === 0) return { global, scoped };
  // Process in chunks to stay within SQLITE_MAX_VARIABLE_NUMBER
  for (let i = 0; i < ids.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT entry_id, utility, show_count, search_count, select_rate, last_used_at, updated_at FROM utility_scores WHERE entry_id IN (${placeholders})`,
      )
      .all(...chunk) as Array<{
      entry_id: number;
      utility: number;
      show_count: number;
      search_count: number;
      select_rate: number;
      last_used_at: string | null;
      updated_at: string;
    }>;
    for (const row of rows) {
      global.set(row.entry_id, {
        entryId: row.entry_id,
        utility: row.utility,
        showCount: row.show_count,
        searchCount: row.search_count,
        selectRate: row.select_rate,
        lastUsedAt: row.last_used_at ?? undefined,
        updatedAt: row.updated_at,
      });
    }
    if (scopeKey) {
      const scopedRows = db
        .prepare(
          `SELECT entry_id, scope_key, utility, last_used_at FROM utility_scores_scoped WHERE scope_key = ? AND entry_id IN (${placeholders})`,
        )
        .all(scopeKey, ...chunk) as Array<{
        entry_id: number;
        scope_key: string;
        utility: number;
        last_used_at: number;
      }>;
      for (const row of scopedRows) {
        scoped.set(row.entry_id, {
          entryId: row.entry_id,
          scopeKey: row.scope_key,
          utility: row.utility,
          lastUsedAt: row.last_used_at,
        });
      }
    }
  }
  return { global, scoped };
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
 * Reduce a ref to its bare `type:name` form, dropping any `origin//` prefix.
 *
 * usage_events store entry_ref inconsistently: search/show writers persist
 * whatever ref the result carried, which is sometimes stash-prefixed
 * (`origin//type:name`) and sometimes bare (`type:name`). Retrieval counting
 * keys on the bare form so both spellings of the same asset collapse together.
 *
 * Returns the bare form, or the original string when it cannot be parsed (best
 * effort — never throws so a malformed stored ref can't break counting).
 */
function bareRef(ref: string): string {
  try {
    const parsed = parseAssetRef(ref);
    return `${parsed.type}:${parsed.name}`;
  } catch {
    return ref;
  }
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
 * Unscoped callers retain normalization-aware legacy matching. Source-scoped
 * callers instead require either an event linked to an entry in the selected
 * stash root or a detached ref qualified with the selected source name. Bare
 * detached events are accepted only when `includeLegacyBare` is explicitly set
 * for the historical local stash.
 *
 * `curate` events are included: their per-item rows are written with
 * entry_ref populated (see logCurateEvent), so curation is a real retrieval
 * signal here. Legacy summary-only curate rows with a NULL entry_ref simply
 * contribute nothing.
 *
 * Machine-sourced events (`source` = 'improve' or 'task') are EXCLUDED: this
 * count feeds salience/ranking, and pipeline probe traffic counting as demand
 * creates a self-reinforcing loop (meta-review 05 DRIFT-6). NULL sources
 * (pre-column rows) count as user demand.
 */
export function getRetrievalCounts(
  db: Database,
  refs: string[],
  options: RetrievalCountOptions = {},
): Map<string, number> {
  if (refs.length === 0) return new Map();

  if (options.sourceName || options.stashDir) {
    return getSourceScopedRetrievalCounts(db, refs, options);
  }

  // Map each distinct bare form back to the input ref(s) that produced it so we
  // can re-key DB results (grouped by bare form) onto the caller's ref strings.
  const bareToInputs = new Map<string, string[]>();
  for (const ref of refs) {
    const bare = bareRef(ref);
    const existing = bareToInputs.get(bare);
    if (existing) existing.push(ref);
    else bareToInputs.set(bare, [ref]);
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
    // no `//` and pass through unchanged.
    const rows = db
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
           AND (source IS NULL OR source NOT IN ('improve','task'))
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
  db: Database,
  refs: string[],
  options: RetrievalCountOptions,
): Map<string, number> {
  const bareToInputs = new Map<string, string[]>();
  for (const ref of refs) {
    const bare = bareRef(ref);
    const inputs = bareToInputs.get(bare);
    if (inputs) inputs.push(ref);
    else bareToInputs.set(bare, [ref]);
  }

  const countsByBare = new Map<string, number>();
  const bareForms = [...bareToInputs.keys()];
  const selectedRoot = options.stashDir ? path.resolve(options.stashDir) : undefined;
  for (let i = 0; i < bareForms.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = bareForms.slice(i, i + SQLITE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT ue.entry_ref, ue.entry_id, e.stash_dir
           FROM usage_events ue
           LEFT JOIN entries e ON e.id = ue.entry_id
          WHERE ue.event_type IN ('search','show','curate')
            AND ue.entry_ref IS NOT NULL
            AND (ue.source IS NULL OR ue.source NOT IN ('improve','task'))
            AND CASE
                  WHEN instr(ue.entry_ref, '//') > 0
                    THEN substr(ue.entry_ref, instr(ue.entry_ref, '//') + 2)
                  ELSE ue.entry_ref
                END IN (${placeholders})`,
      )
      .all(...(chunk as SqlValue[])) as Array<{
      entry_ref: string;
      entry_id: number | null;
      stash_dir: string | null;
    }>;

    for (const row of rows) {
      const bare = bareRef(row.entry_ref);
      const linkedToSelectedRoot =
        row.entry_id !== null && selectedRoot !== undefined && row.stash_dir !== null
          ? path.resolve(row.stash_dir) === selectedRoot
          : false;
      const detached = row.entry_id === null || selectedRoot === undefined;
      const qualifiedForSource =
        detached && options.sourceName !== undefined && row.entry_ref === `${options.sourceName}//${bare}`;
      const acceptedLegacyBare = detached && options.includeLegacyBare === true && row.entry_ref === bare;
      if (!linkedToSelectedRoot && !qualifiedForSource && !acceptedLegacyBare) continue;
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
 * Apply a MemRL reward signal to a batch of entries via exponential moving
 * average (EMA): next = clamp(current + lr * (reward - current), 0, 1).
 *
 * Wrapped in a single transaction so all bumps succeed or fail together.
 * The indexer (`akm index`) will overwrite these values at next reindex run;
 * bumps are intentionally temporary hints between index runs, not permanent
 * overrides.
 *
 * When `scopeKey` is provided, also writes a scoped bump to
 * `utility_scores_scoped` so per-project usage signals accumulate alongside
 * the global ones. The global table is always updated regardless.
 */
export function bumpUtilityScoresBatch(
  db: Database,
  entryIds: number[],
  reward: number,
  lr = 0.1,
  scopeKey?: string,
): void {
  if (entryIds.length === 0) return;
  db.transaction(() => {
    const { global: scoreMap } = getUtilityScoresByIds(db, entryIds);
    const now = new Date().toISOString();
    const nowMs = Date.now();
    const stmt = db.prepare(
      `INSERT INTO utility_scores (entry_id, utility, show_count, search_count, select_rate, last_used_at, updated_at)
       VALUES (?, ?, 0, 0, 0, ?, ?)
       ON CONFLICT(entry_id) DO UPDATE SET
         utility = excluded.utility,
         updated_at = excluded.updated_at`,
    );
    // Prepare scoped upsert once outside the loop when scopeKey is present.
    const scopedStmt = scopeKey
      ? db.prepare(
          `INSERT INTO utility_scores_scoped (entry_id, scope_key, utility, last_used_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(entry_id, scope_key) DO UPDATE SET
             utility = excluded.utility,
             last_used_at = excluded.last_used_at`,
        )
      : null;
    for (const entryId of entryIds) {
      const existing = scoreMap.get(entryId);
      const current = existing?.utility ?? 0;
      const next = Math.max(0, Math.min(1, current + lr * (reward - current)));
      stmt.run(entryId, next, now, now);
      if (scopedStmt && scopeKey) {
        // Retrieve the current scoped utility so we can apply the same EMA.
        const scopedCurrent = getScopedUtility(db, entryId, scopeKey);
        const scopedNext = Math.max(0, Math.min(1, scopedCurrent + lr * (reward - scopedCurrent)));
        scopedStmt.run(entryId, scopeKey, scopedNext, nowMs);
      }
    }
  })();
}

/**
 * Return the current utility value for a single (entry_id, scope_key) pair.
 * Returns 0 when no row exists yet.
 */
function getScopedUtility(db: Database, entryId: number, scopeKey: string): number {
  const row = db
    .prepare("SELECT utility FROM utility_scores_scoped WHERE entry_id = ? AND scope_key = ?")
    .get(entryId, scopeKey) as { utility: number } | undefined;
  return row?.utility ?? 0;
}

/**
 * Apply accumulated feedback counts to the utility score of an entry, persisting
 * the result. The bounded-step EMA policy itself (MemRL, F-5 / #386,
 * arXiv:2601.03192) lives in {@link computeNextUtility} (feedback/utility-policy);
 * this function only reads the current utility, applies the policy, and writes
 * the new value.
 *
 * A new entry starts at 0.5 (neutral midpoint) before the EMA step is applied.
 * When there is no feedback (both counts zero) the score is left untouched — no
 * DB write. Returns a {@link FeedbackUtilityResult} so the caller can detect a
 * previously high-utility asset crossing below the review threshold and escalate.
 */
export function applyFeedbackToUtilityScore(
  db: Database,
  entryId: number,
  positiveCount: number,
  negativeCount: number,
): FeedbackUtilityResult {
  const existing = getUtilityScore(db, entryId);
  const previousUtility = existing?.utility ?? 0.5;

  const result = computeNextUtility(previousUtility, positiveCount, negativeCount);

  if (positiveCount === 0 && negativeCount === 0) {
    return result;
  }

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO utility_scores (entry_id, utility, show_count, search_count, select_rate, last_used_at, updated_at)
    VALUES (?, ?, 0, 0, 0, ?, ?)
    ON CONFLICT(entry_id) DO UPDATE SET
      utility    = ?,
      updated_at = ?
  `).run(entryId, result.nextUtility, now, now, result.nextUtility, now);

  return result;
}
