// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #691 invariance pins (meta-review 05, DRIFT-2).
 *
 * The v1 "retrieved-but-never-improved" penalty term was DELETED from the
 * outcome formula: its accepted_change_rate factor had corr ≈ 0.007 with
 * outcome_score across live data (noise), and because the unclamped rate
 * exceeds 1 whenever accepted changes outnumber retrievals, it paid a live
 * BONUS for churn — an asset's score could rise by being rewritten under
 * auto-accept.
 *
 * These tests pin the post-deletion invariants:
 *   1. outcome_score is INVARIANT to acceptedChangeCount.
 *   2. The old churn-bonus shape (accepted > retrievals on a positive delta)
 *      produces the same score as zero accepted changes.
 *   3. accepted_change_count is still persisted as raw telemetry.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DIVERSITY_FLOOR_FRACTION,
  getAssetOutcome,
  OUTCOME_SCORE_MAX,
  outcomeScoreToSalience,
  updateAssetOutcome,
} from "../../../../src/commands/improve/outcome-loop";
import { openStateDatabase } from "../../../../src/core/state-db";
import type { Database } from "../../../../src/storage/database";

const NOW = Date.parse("2026-07-02T00:00:00.000Z");

function openTestDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-outcome-invariance-test-"));
  const db = openStateDatabase(path.join(tmpDir, "state.db"));
  return { db, tmpDir };
}

/** Seed an existing row so updateAssetOutcome takes the differential-update path. */
function seedRow(db: Database, ref: string, retrievalCount: number, expectedRate: number, outcomeScore: number): void {
  db.prepare(
    `INSERT INTO asset_outcome
       (asset_ref, last_retrieved_at, retrieval_count, expected_retrieval_rate,
        negative_feedback_count, accepted_change_count,
        outcome_score, updated_at)
     VALUES (?, 0, ?, ?, 0, 0, ?, ?)`,
  ).run(ref, retrievalCount, expectedRate, outcomeScore, NOW);
}

describe("outcome_score is invariant to acceptedChangeCount (#691)", () => {
  test("identical updates differing only in acceptedChangeCount produce identical scores", () => {
    const { db } = openTestDb();
    try {
      seedRow(db, "skill:a", 10, 2.0, 0.2);
      seedRow(db, "skill:b", 10, 2.0, 0.2);

      const a = updateAssetOutcome(db, {
        ref: "skill:a",
        currentRetrievalCount: 15,
        lastRetrievedAt: NOW,
        acceptedChangeCount: 0,
        negativeFeedbackCount: 0,
        valence: 0.1,
        now: NOW + 1000,
      });
      const b = updateAssetOutcome(db, {
        ref: "skill:b",
        currentRetrievalCount: 15,
        lastRetrievedAt: NOW,
        acceptedChangeCount: 500,
        negativeFeedbackCount: 0,
        valence: 0.1,
        now: NOW + 1000,
      });

      expect(b.outcomeScore).toBe(a.outcomeScore);
    } finally {
      db.close();
    }
  });

  test("the old churn-bonus shape (accepted > retrievals, positive delta) earns nothing", () => {
    const { db } = openTestDb();
    try {
      // The live flip case from the meta-review: 7 accepted changes on 3
      // retrievals (rate 2.33 > 1) — under v1 the penalty term went negative
      // and PAID for churn on any positive retrieval delta.
      seedRow(db, "command:churned", 1, 0.5, 0.0);
      seedRow(db, "command:untouched", 1, 0.5, 0.0);

      const churned = updateAssetOutcome(db, {
        ref: "command:churned",
        currentRetrievalCount: 3,
        lastRetrievedAt: NOW,
        acceptedChangeCount: 7,
        negativeFeedbackCount: 0,
        valence: 0,
        now: NOW + 1000,
      });
      const untouched = updateAssetOutcome(db, {
        ref: "command:untouched",
        currentRetrievalCount: 3,
        lastRetrievedAt: NOW,
        acceptedChangeCount: 0,
        negativeFeedbackCount: 0,
        valence: 0,
        now: NOW + 1000,
      });

      expect(churned.outcomeScore).toBe(untouched.outcomeScore);
    } finally {
      db.close();
    }
  });

  test("accepted_change_count is still persisted as raw telemetry", () => {
    const { db } = openTestDb();
    try {
      seedRow(db, "lesson:telemetry", 5, 1.0, 0.1);
      updateAssetOutcome(db, {
        ref: "lesson:telemetry",
        currentRetrievalCount: 6,
        lastRetrievedAt: NOW,
        acceptedChangeCount: 42,
        negativeFeedbackCount: 0,
        valence: 0,
        now: NOW + 1000,
      });
      expect(getAssetOutcome(db, "lesson:telemetry")?.accepted_change_count).toBe(42);
    } finally {
      db.close();
    }
  });
});

describe("outcomeSalience normalisation contract", () => {
  test("normalises against the provided max and applies the diversity floor", () => {
    // Callers clip the stash-wide max to OUTCOME_SCORE_MAX before normalising
    // (preparation.ts) so legacy >MAX rows can't floor everyone else: with the
    // clipped ceiling as reference, a mid-range score keeps its spread.
    expect(outcomeScoreToSalience(OUTCOME_SCORE_MAX / 2, OUTCOME_SCORE_MAX)).toBe(0.5);
    // Negative scores clip to 0 and land on the diversity floor.
    expect(outcomeScoreToSalience(-0.4, OUTCOME_SCORE_MAX)).toBe(DIVERSITY_FLOOR_FRACTION);
    // Un-clipped legacy reference (the pre-fix behaviour) would have produced
    // 0.75/3.13 ≈ 0.24 instead of 0.5 — the clip is what keeps spread meaningful.
    expect(outcomeScoreToSalience(OUTCOME_SCORE_MAX / 2, 3.1302)).toBeLessThan(0.25);
  });
});
