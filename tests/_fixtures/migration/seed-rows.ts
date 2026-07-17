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

import type { Database } from "../../../src/storage/database";

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
