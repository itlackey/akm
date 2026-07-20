// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Row-level seeding helpers shared by the chunk-0b migration DB fixture
 * builders (`orphan-state.ts`, `rc-train-state.ts`).
 *
 * Both builders apply the REAL migration chain (via
 * `src/core/state-db.ts#openStateDatabase` — never hand-written DDL) and then
 * insert rows into `asset_salience` / `asset_outcome`. This module centralizes
 * the exact, HEAD-verified column lists so there is exactly one place that
 * INSERT statement lives, instead of two copies that could silently drift out
 * of sync with the live schema.
 *
 * Column sets verified directly against `src/core/state/migrations.ts` at
 * chunk-0b's capture HEAD (`3c178568`, 2026-07-17):
 *
 *   - `asset_salience` (migration `009-asset-salience` :507-523 CREATE TABLE,
 *     `011-asset-salience-homeostatic-demoted-at` :591-596 ADD COLUMN
 *     `homeostatic_demoted_at`, `015-asset-salience-encoding-source` :715-720
 *     ADD COLUMN `encoding_source`): asset_ref, encoding_salience,
 *     outcome_salience, retrieval_salience, rank_score, consecutive_no_ops,
 *     updated_at, homeostatic_demoted_at, encoding_source. Nothing dropped.
 *
 *   - `asset_outcome` (migration `010-asset-outcome` :555-577 CREATE TABLE;
 *     `review_pressure` DROPPED by migration `018-drop-dead-lane-schema`
 *     :803-813): asset_ref, last_retrieved_at, retrieval_count,
 *     expected_retrieval_rate, negative_feedback_count, accepted_change_count,
 *     outcome_score, updated_at. `review_pressure` is NOT a live column at
 *     this HEAD — it must never appear in an INSERT here.
 */

import fs from "node:fs";
import path from "node:path";
import { STATE_MIGRATIONS } from "../../../src/core/state/migrations";
import { type Database, openDatabase } from "../../../src/storage/database";
import { runMigrations as runSqliteMigrations } from "../../../src/storage/engines/sqlite-migrations";
import { applyStandardPragmas } from "../../../src/storage/sqlite-pragmas";

/**
 * The pre-cutover state.db migration ceiling: the LAST migration that existed
 * before the WI-8.2 three-DB cutover (`020-three-db-cutover`) was appended.
 * The rc-train / orphan FROM-state fixtures pin themselves here so they are a
 * faithful pre-cutover snapshot — the exact ledger a real rc-train install
 * carried before it ran `migrate apply` into the cutover. Migration 020 is then
 * applied by the migrate-apply flow under test, never baked into the fixture.
 */
export const PRE_CUTOVER_STATE_CEILING = "019-proposal-fingerprints";

/**
 * Open a state.db migrated to an EXPLICIT ceiling migration id (a prefix of
 * STATE_MIGRATIONS), NOT the live tip. `openStateDatabase` always applies the
 * full live chain (which now includes the cutover DDL), so a genuine
 * pre-cutover FROM-state fixture cannot use it. This applies exactly the prefix
 * `[001 … ceilingId]` via the real shared migration runner (never hand-written
 * DDL — the checksums are still sealed), leaving the DB legitimately "old"
 * relative to the live ledger. Caller owns the returned handle (seed, then
 * close).
 */
export function openStateDbAtCeiling(dbPath: string, ceilingId: string): Database {
  const ceilingIndex = STATE_MIGRATIONS.findIndex((m) => m.id === ceilingId);
  if (ceilingIndex < 0) throw new Error(`Unknown state.db migration ceiling "${ceilingId}"`);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  applyStandardPragmas(db, { dataDir: path.dirname(dbPath) });
  runSqliteMigrations(db, STATE_MIGRATIONS.slice(0, ceilingIndex + 1));
  return db;
}

export interface AssetSalienceSeedRow {
  assetRef: string;
  encodingSalience: number;
  outcomeSalience: number;
  retrievalSalience: number;
  rankScore: number;
  consecutiveNoOps: number;
  updatedAt: number;
  homeostaticDemotedAt: number | null;
  encodingSource: string | null;
}

export interface AssetOutcomeSeedRow {
  assetRef: string;
  lastRetrievedAt: number;
  retrievalCount: number;
  expectedRetrievalRate: number;
  negativeFeedbackCount: number;
  acceptedChangeCount: number;
  outcomeScore: number;
  updatedAt: number;
}

/** Insert one `asset_salience` row using the live (HEAD-verified) column set. */
export function insertAssetSalienceRow(db: Database, row: AssetSalienceSeedRow): void {
  db.prepare(
    `INSERT INTO asset_salience
       (asset_ref, encoding_salience, outcome_salience, retrieval_salience,
        rank_score, consecutive_no_ops, updated_at, homeostatic_demoted_at, encoding_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.assetRef,
    row.encodingSalience,
    row.outcomeSalience,
    row.retrievalSalience,
    row.rankScore,
    row.consecutiveNoOps,
    row.updatedAt,
    row.homeostaticDemotedAt,
    row.encodingSource,
  );
}

/**
 * Insert one `asset_outcome` row using the live (HEAD-verified) column set.
 * Deliberately has no `reviewPressure` field — that column was dropped by
 * migration 018 and must not be resurrected (chunk-0b brief trap list #6).
 */
export function insertAssetOutcomeRow(db: Database, row: AssetOutcomeSeedRow): void {
  db.prepare(
    `INSERT INTO asset_outcome
       (asset_ref, last_retrieved_at, retrieval_count, expected_retrieval_rate,
        negative_feedback_count, accepted_change_count, outcome_score, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.assetRef,
    row.lastRetrievedAt,
    row.retrievalCount,
    row.expectedRetrievalRate,
    row.negativeFeedbackCount,
    row.acceptedChangeCount,
    row.outcomeScore,
    row.updatedAt,
  );
}
