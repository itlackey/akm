// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Repository for the collapse/churn detector state (migration 016): the
 * `canary_queries` fixed retrieval probes and the `improve_cycle_metrics`
 * store-health snapshot ledger. Extracted verbatim from core/state-db.ts —
 * queries unchanged, only relocated behind the repository boundary. Re-exported
 * by core/state-db.ts so existing importers resolve.
 *
 * @module canaries-repository
 */

import type { Database } from "../database";

/** One canary query row (the fixed retrieval probes for collapse detection). */
export interface CanaryQueryRow {
  id: number;
  canary_set_id: string;
  anchor_ref: string;
  query: string;
  source: string;
  active: number;
  created_at: string;
}

/** One improve-cycle store-health snapshot (mirrors improve_cycle_metrics). */
export interface CycleMetricsRow {
  run_id: string;
  ts: string;
  pass: "consolidate" | "recombine" | "both";
  canary_set_id: string;
  mean_recall: number;
  mean_ndcg: number;
  mean_mrr: number;
  /** JSON `[[canaryId, rankOfHit|-1], ...]` — ints only, bounded by canaryCount. */
  canary_ranks_json: string;
  store_total: number;
  /** JSON `{"memory": n, "lesson": n, ...}`. */
  store_by_type_json: string;
  distinct_content_ratio: number;
  mean_bigram_diversity: number;
  over_generation_count: number;
  accepted_actions: number;
  merge_floor_violations: number;
  /** JSON array of fired alert kinds for this cycle. */
  alerts_json: string;
}

/** Insert a freshly minted canary set (all rows active, one shared set id). */
export function insertCanaries(
  db: Database,
  canarySetId: string,
  canaries: Array<{ anchorRef: string; query: string; source?: string }>,
  now?: string,
): void {
  if (canaries.length === 0) return;
  const ts = now ?? new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO canary_queries (canary_set_id, anchor_ref, query, source, active, created_at)
    VALUES (?, ?, ?, ?, 1, ?)
  `);
  db.transaction(() => {
    for (const c of canaries) {
      stmt.run(canarySetId, c.anchorRef, c.query, c.source ?? "auto", ts);
    }
  })();
}

/** Load the active canary set (empty array = never minted). */
export function getActiveCanaries(db: Database): CanaryQueryRow[] {
  // Scope to the NEWEST active set: if an interrupted refresh (or a bug) ever
  // leaves two sets active, mixing their rows would silently corrupt the
  // recall/entropy trend baselines. The newest set wins; stale-active rows are
  // simply never returned.
  return db
    .prepare(
      `SELECT * FROM canary_queries
       WHERE active = 1 AND canary_set_id = (
         SELECT canary_set_id FROM canary_queries WHERE active = 1
         ORDER BY created_at DESC, id DESC LIMIT 1
       )
       ORDER BY id`,
    )
    .all() as CanaryQueryRow[];
}

/** Load one canary set's rows by its exact set id (any active state), insertion order. */
export function getCanariesBySetId(db: Database, canarySetId: string): CanaryQueryRow[] {
  return db
    .prepare(`SELECT * FROM canary_queries WHERE canary_set_id = ? ORDER BY id`)
    .all(canarySetId) as CanaryQueryRow[];
}

/** List every distinct canary_set_id that still has active rows. */
export function listActiveCanarySetIds(db: Database): string[] {
  const rows = db.prepare(`SELECT DISTINCT canary_set_id FROM canary_queries WHERE active = 1`).all() as Array<{
    canary_set_id: string;
  }>;
  return rows.map((r) => r.canary_set_id);
}

/**
 * Deactivate every canary row in a set. Rows are RETAINED (active = 0) so
 * historical improve_cycle_metrics rows keyed on the old canary_set_id stay
 * interpretable; only `akm improve canary --refresh` calls this.
 */
export function deactivateCanarySet(db: Database, canarySetId: string): number {
  const result = db
    .prepare(`UPDATE canary_queries SET active = 0 WHERE canary_set_id = ? AND active = 1`)
    .run(canarySetId);
  const changes = (result as { changes?: number | bigint }).changes ?? 0;
  return typeof changes === "bigint" ? Number(changes) : changes;
}

/** Persist one qualifying cycle's store-health snapshot. */
export function insertCycleMetrics(db: Database, row: CycleMetricsRow): void {
  db.prepare(`
    INSERT INTO improve_cycle_metrics
      (run_id, ts, pass, canary_set_id, mean_recall, mean_ndcg, mean_mrr,
       canary_ranks_json, store_total, store_by_type_json, distinct_content_ratio,
       mean_bigram_diversity, over_generation_count, accepted_actions,
       merge_floor_violations, alerts_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.run_id,
    row.ts,
    row.pass,
    row.canary_set_id,
    row.mean_recall,
    row.mean_ndcg,
    row.mean_mrr,
    row.canary_ranks_json,
    row.store_total,
    row.store_by_type_json,
    row.distinct_content_ratio,
    row.mean_bigram_diversity,
    row.over_generation_count,
    row.accepted_actions,
    row.merge_floor_violations,
    row.alerts_json,
  );
}

/**
 * Load the most recent cycle rows for one canary set, OLDEST-first (the alert
 * evaluator's window order). Scoped by canary_set_id so trends never compare
 * across canary re-mints.
 */
export function queryRecentCycleMetrics(db: Database, canarySetId: string, limit: number): CycleMetricsRow[] {
  const rows = db
    .prepare(
      `SELECT run_id, ts, pass, canary_set_id, mean_recall, mean_ndcg, mean_mrr,
              canary_ranks_json, store_total, store_by_type_json, distinct_content_ratio,
              mean_bigram_diversity, over_generation_count, accepted_actions,
              merge_floor_violations, alerts_json
       FROM improve_cycle_metrics WHERE canary_set_id = ?
       ORDER BY ts DESC, id DESC LIMIT ?`,
    )
    .all(canarySetId, Math.max(0, limit)) as CycleMetricsRow[];
  return rows.reverse();
}

/** Load the single most recent cycle row across all canary sets (health surface). */
export function getLatestCycleMetrics(db: Database): CycleMetricsRow | undefined {
  const row = db
    .prepare(
      `SELECT run_id, ts, pass, canary_set_id, mean_recall, mean_ndcg, mean_mrr,
              canary_ranks_json, store_total, store_by_type_json, distinct_content_ratio,
              mean_bigram_diversity, over_generation_count, accepted_actions,
              merge_floor_violations, alerts_json
       FROM improve_cycle_metrics ORDER BY ts DESC, id DESC LIMIT 1`,
    )
    .get();
  return row == null ? undefined : (row as CycleMetricsRow);
}

/**
 * Delete cycle rows older than `retentionDays` (default 365 — owner-approved;
 * a slow collapse needs a longer trend window than the 90-day events log).
 * Returns the purged row count. canary_queries rows are never purged.
 */
export function purgeOldCycleMetrics(db: Database, retentionDays = 365): number {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const result = db.prepare("DELETE FROM improve_cycle_metrics WHERE ts < ?").run(cutoff);
  const changes = (result as { changes?: number | bigint }).changes ?? 0;
  return typeof changes === "bigint" ? Number(changes) : changes;
}
