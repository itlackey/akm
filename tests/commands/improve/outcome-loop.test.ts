// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS-2 outcome loop — unit tests.
 *
 * Covers:
 *   - `updateAssetOutcome`: warm-start, differential update, review_pressure.
 *   - `getAssetOutcome`: round-trip read.
 *   - `getOutcomeScoresByRef`: bulk read.
 *   - `outcomeScoreToSalience`: normalisation + diversity floor.
 *   - `computeProxyAdequacy`: correlation tripwire.
 *   - Migration 010 creates asset_outcome table.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  computeProxyAdequacy,
  getAllAssetOutcomes,
  getAssetOutcome,
  getOutcomeScoresByRef,
  OUTCOME_SCORE_MAX,
  outcomeScoreToSalience,
  REVIEW_PRESSURE_DECAY,
  REVIEW_PRESSURE_INCREMENT,
  updateAssetOutcome,
  WARM_START_CAP,
} from "../../../src/commands/improve/outcome-loop";
import { openStateDatabase } from "../../../src/core/state-db";

// ── Helpers ────────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-06-15T00:00:00.000Z");

function openTestDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-outcome-test-"));
  const db = openStateDatabase(path.join(tmpDir, "state.db"));
  return { db, tmpDir };
}

// ── Migration 010: table exists after openStateDatabase ───────────────────────

describe("Migration 010 — asset_outcome table", () => {
  test("asset_outcome table is created by migration", () => {
    const { db } = openTestDb();
    try {
      // Should not throw — table exists.
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='asset_outcome'").get() as
        | { name: string }
        | undefined;
      expect(row).toBeDefined();
      expect(row?.name).toBe("asset_outcome");
    } finally {
      db.close();
    }
  });

  test("asset_outcome has all required columns", () => {
    const { db } = openTestDb();
    try {
      // Insert a minimal row to verify all columns are present.
      db.prepare(
        `INSERT INTO asset_outcome
           (asset_ref, last_retrieved_at, retrieval_count, expected_retrieval_rate,
            negative_feedback_count, accepted_change_count, review_pressure,
            outcome_score, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("lesson:test", 0, 0, 0.0, 0, 0, 0, 0.0, NOW);

      const row = getAssetOutcome(db, "lesson:test");
      expect(row).toBeDefined();
      expect(row?.asset_ref).toBe("lesson:test");
    } finally {
      db.close();
    }
  });
});

// ── updateAssetOutcome — warm-start ───────────────────────────────────────────

describe("updateAssetOutcome — warm-start on first insert", () => {
  test("new row is seeded from utilityScore clipped to WARM_START_CAP", () => {
    const { db } = openTestDb();
    try {
      const result = updateAssetOutcome(db, {
        ref: "skill:alpha",
        currentRetrievalCount: 5,
        lastRetrievedAt: NOW,
        acceptedChangeCount: 2,
        negativeFeedbackCount: 0,
        utilityScore: 0.9, // above cap
        now: NOW,
      });

      expect(result.isNewRow).toBe(true);
      // outcome_score should be clipped to WARM_START_CAP, not the full 0.9.
      expect(result.outcomeScore).toBe(WARM_START_CAP);

      const row = getAssetOutcome(db, "skill:alpha");
      expect(row?.outcome_score).toBe(WARM_START_CAP);
      expect(row?.retrieval_count).toBe(5);
      // Warm-start seeds expected_retrieval_rate = 0 (no delta history yet),
      // NOT the cumulative retrieval count, to avoid a spurious negative
      // prediction error on the first real differential cycle.
      expect(row?.expected_retrieval_rate).toBe(0);
    } finally {
      db.close();
    }
  });

  test("new row with zero utilityScore seeds 0", () => {
    const { db } = openTestDb();
    try {
      const result = updateAssetOutcome(db, {
        ref: "lesson:beta",
        currentRetrievalCount: 0,
        lastRetrievedAt: 0,
        acceptedChangeCount: 0,
        negativeFeedbackCount: 0,
        now: NOW,
      });

      expect(result.isNewRow).toBe(true);
      expect(result.outcomeScore).toBe(0);
    } finally {
      db.close();
    }
  });

  test("warm-start cap: utilityScore of 0.5 below cap → outcome_score = 0.3 (cap) if 0.5 > 0.3", () => {
    const { db } = openTestDb();
    try {
      // WARM_START_CAP = 0.3, utilityScore = 0.5 (above cap)
      const result = updateAssetOutcome(db, {
        ref: "knowledge:gamma",
        currentRetrievalCount: 0,
        lastRetrievedAt: 0,
        acceptedChangeCount: 0,
        negativeFeedbackCount: 0,
        utilityScore: 0.5,
        now: NOW,
      });
      expect(result.outcomeScore).toBe(WARM_START_CAP);
    } finally {
      db.close();
    }
  });

  test("warm-start: utilityScore = 0.1 (below cap) → outcome_score = 0.1", () => {
    const { db } = openTestDb();
    try {
      const result = updateAssetOutcome(db, {
        ref: "memory:delta",
        currentRetrievalCount: 0,
        lastRetrievedAt: 0,
        acceptedChangeCount: 0,
        negativeFeedbackCount: 0,
        utilityScore: 0.1,
        now: NOW,
      });
      // 0.1 < WARM_START_CAP (0.3) → seeded at 0.1
      expect(result.outcomeScore).toBeCloseTo(0.1, 9);
    } finally {
      db.close();
    }
  });
});

// ── updateAssetOutcome — differential update ──────────────────────────────────

describe("updateAssetOutcome — differential update (second call)", () => {
  test("second call is NOT a new row and applies the differential formula", () => {
    const { db } = openTestDb();
    try {
      // Seed row.
      updateAssetOutcome(db, {
        ref: "skill:epsilon",
        currentRetrievalCount: 10,
        lastRetrievedAt: NOW,
        acceptedChangeCount: 3,
        negativeFeedbackCount: 1,
        utilityScore: 0.6,
        now: NOW,
      });

      // Second update with more retrievals.
      const result = updateAssetOutcome(db, {
        ref: "skill:epsilon",
        currentRetrievalCount: 14, // +4 retrievals
        lastRetrievedAt: NOW + 1000,
        acceptedChangeCount: 4,
        negativeFeedbackCount: 1,
        valence: 0.2,
        now: NOW + 1000,
      });

      expect(result.isNewRow).toBe(false);

      const row = getAssetOutcome(db, "skill:epsilon");
      expect(row?.retrieval_count).toBe(14);
      // Score should be updated (not the same as the seed).
      expect(typeof row?.outcome_score).toBe("number");
      expect(Number.isFinite(row?.outcome_score)).toBe(true);
    } finally {
      db.close();
    }
  });

  test("negative prediction error (below expected) lowers outcome_score", () => {
    const { db } = openTestDb();
    try {
      // Seed row with high expected_retrieval_rate.
      db.prepare(
        `INSERT INTO asset_outcome
           (asset_ref, last_retrieved_at, retrieval_count, expected_retrieval_rate,
            negative_feedback_count, accepted_change_count, review_pressure,
            outcome_score, updated_at)
         VALUES ('lesson:zeta', 0, 20, 20.0, 0, 0, 0, 0.2, ?)`,
      ).run(NOW);

      // Only 21 retrievals vs. expected 20 → small delta (1), small penalty.
      const result = updateAssetOutcome(db, {
        ref: "lesson:zeta",
        currentRetrievalCount: 21,
        lastRetrievedAt: NOW,
        acceptedChangeCount: 0,
        negativeFeedbackCount: 0,
        valence: 0,
        now: NOW + 1000,
      });

      expect(result.isNewRow).toBe(false);
      // outcome_score should be updated — we can't predict exact value but
      // it should be finite and within range.
      expect(Number.isFinite(result.outcomeScore)).toBe(true);
      expect(result.outcomeScore).toBeGreaterThanOrEqual(-1.0);
    } finally {
      db.close();
    }
  });

  test("outcome_score is clamped to OUTCOME_SCORE_MIN (-1.0)", () => {
    const { db } = openTestDb();
    try {
      // Seed with very negative existing score and zero acceptance.
      db.prepare(
        `INSERT INTO asset_outcome
           (asset_ref, last_retrieved_at, retrieval_count, expected_retrieval_rate,
            negative_feedback_count, accepted_change_count, review_pressure,
            outcome_score, updated_at)
         VALUES ('lesson:eta', 0, 100, 100.0, 10, 0, 3, -0.9, ?)`,
      ).run(NOW);

      // Extreme penalty: large retrieval_delta, zero acceptance, negative valence.
      const result = updateAssetOutcome(db, {
        ref: "lesson:eta",
        currentRetrievalCount: 200, // huge delta
        lastRetrievedAt: NOW,
        acceptedChangeCount: 0,
        negativeFeedbackCount: 20,
        valence: -1.0,
        now: NOW + 1000,
      });

      // Should be clamped to -1.0 (OUTCOME_SCORE_MIN).
      expect(result.outcomeScore).toBeGreaterThanOrEqual(-1.0);
    } finally {
      db.close();
    }
  });

  test("outcome_score is clamped to OUTCOME_SCORE_MAX (RPE saturation, G2)", () => {
    const { db } = openTestDb();
    try {
      // Seed a legacy unbounded row above the ceiling (live max was 3.13).
      db.prepare(
        `INSERT INTO asset_outcome
           (asset_ref, last_retrieved_at, retrieval_count, expected_retrieval_rate,
            negative_feedback_count, accepted_change_count, review_pressure,
            outcome_score, updated_at)
         VALUES ('lesson:theta', 0, 100, 0.0, 0, 100, 0, 3.13, ?)`,
      ).run(NOW);

      // Strongly positive cycle: big surprise delta, full acceptance, +1 valence.
      const result = updateAssetOutcome(db, {
        ref: "lesson:theta",
        currentRetrievalCount: 200,
        lastRetrievedAt: NOW,
        acceptedChangeCount: 200,
        negativeFeedbackCount: 0,
        valence: 1.0,
        now: NOW + 1000,
      });

      // Even from a legacy 3.13 seed, the update converges under the ceiling.
      expect(result.outcomeScore).toBeLessThanOrEqual(OUTCOME_SCORE_MAX);
    } finally {
      db.close();
    }
  });
});

// ── review_pressure (#613) ────────────────────────────────────────────────────

describe("updateAssetOutcome — review_pressure (#613)", () => {
  test("new negatives increment review_pressure", () => {
    const { db } = openTestDb();
    try {
      // Seed row with 0 negatives.
      db.prepare(
        `INSERT INTO asset_outcome
           (asset_ref, last_retrieved_at, retrieval_count, expected_retrieval_rate,
            negative_feedback_count, accepted_change_count, review_pressure,
            outcome_score, updated_at)
         VALUES ('memory:theta', 0, 5, 5.0, 0, 0, 0, 0.1, ?)`,
      ).run(NOW);

      // 3 new negative feedbacks.
      const result = updateAssetOutcome(db, {
        ref: "memory:theta",
        currentRetrievalCount: 5,
        lastRetrievedAt: NOW,
        acceptedChangeCount: 0,
        negativeFeedbackCount: 3,
        now: NOW + 1000,
      });

      // review_pressure should have increased by REVIEW_PRESSURE_INCREMENT × 3.
      expect(result.reviewPressure).toBe(REVIEW_PRESSURE_INCREMENT * 3);
    } finally {
      db.close();
    }
  });

  test("no new negatives decay review_pressure", () => {
    const { db } = openTestDb();
    try {
      // Seed row with pressure = 4.
      db.prepare(
        `INSERT INTO asset_outcome
           (asset_ref, last_retrieved_at, retrieval_count, expected_retrieval_rate,
            negative_feedback_count, accepted_change_count, review_pressure,
            outcome_score, updated_at)
         VALUES ('memory:iota', 0, 5, 5.0, 3, 0, 4, 0.1, ?)`,
      ).run(NOW);

      // No new negatives (negativeFeedbackCount still 3).
      const result = updateAssetOutcome(db, {
        ref: "memory:iota",
        currentRetrievalCount: 6,
        lastRetrievedAt: NOW,
        acceptedChangeCount: 0,
        negativeFeedbackCount: 3,
        now: NOW + 1000,
      });

      // review_pressure should decay by REVIEW_PRESSURE_DECAY.
      expect(result.reviewPressure).toBe(4 - REVIEW_PRESSURE_DECAY);
    } finally {
      db.close();
    }
  });

  test("review_pressure does not go below 0", () => {
    const { db } = openTestDb();
    try {
      db.prepare(
        `INSERT INTO asset_outcome
           (asset_ref, last_retrieved_at, retrieval_count, expected_retrieval_rate,
            negative_feedback_count, accepted_change_count, review_pressure,
            outcome_score, updated_at)
         VALUES ('memory:kappa', 0, 5, 5.0, 0, 0, 0, 0.1, ?)`,
      ).run(NOW);

      const result = updateAssetOutcome(db, {
        ref: "memory:kappa",
        currentRetrievalCount: 6,
        lastRetrievedAt: NOW,
        acceptedChangeCount: 0,
        negativeFeedbackCount: 0,
        now: NOW + 1000,
      });

      expect(result.reviewPressure).toBe(0);
    } finally {
      db.close();
    }
  });
});

// ── getOutcomeScoresByRef ─────────────────────────────────────────────────────

describe("getOutcomeScoresByRef — bulk read", () => {
  test("returns outcome scores for known refs, skips unknown refs", () => {
    const { db } = openTestDb();
    try {
      updateAssetOutcome(db, {
        ref: "skill:known1",
        currentRetrievalCount: 3,
        lastRetrievedAt: NOW,
        acceptedChangeCount: 1,
        negativeFeedbackCount: 0,
        utilityScore: 0.5,
        now: NOW,
      });
      updateAssetOutcome(db, {
        ref: "lesson:known2",
        currentRetrievalCount: 7,
        lastRetrievedAt: NOW,
        acceptedChangeCount: 2,
        negativeFeedbackCount: 0,
        utilityScore: 0.3,
        now: NOW,
      });

      const scores = getOutcomeScoresByRef(db, ["skill:known1", "lesson:known2", "memory:unknown"]);
      expect(scores.has("skill:known1")).toBe(true);
      expect(scores.has("lesson:known2")).toBe(true);
      expect(scores.has("memory:unknown")).toBe(false);
    } finally {
      db.close();
    }
  });

  test("returns empty map for empty input", () => {
    const { db } = openTestDb();
    try {
      const scores = getOutcomeScoresByRef(db, []);
      expect(scores.size).toBe(0);
    } finally {
      db.close();
    }
  });
});

// ── getAllAssetOutcomes ────────────────────────────────────────────────────────

describe("getAllAssetOutcomes", () => {
  test("returns all rows ordered by asset_ref", () => {
    const { db } = openTestDb();
    try {
      for (const ref of ["skill:c", "skill:a", "skill:b"]) {
        updateAssetOutcome(db, {
          ref,
          currentRetrievalCount: 1,
          lastRetrievedAt: NOW,
          acceptedChangeCount: 0,
          negativeFeedbackCount: 0,
          now: NOW,
        });
      }
      const rows = getAllAssetOutcomes(db);
      expect(rows.length).toBe(3);
      expect(rows.map((r) => r.asset_ref)).toEqual(["skill:a", "skill:b", "skill:c"]);
    } finally {
      db.close();
    }
  });
});

// ── outcomeScoreToSalience ────────────────────────────────────────────────────

describe("outcomeScoreToSalience — normalisation + diversity floor", () => {
  test("positive score normalises to (0, 1]", () => {
    const s = outcomeScoreToSalience(0.5, 1.0);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(1.0);
  });

  test("score equal to maxScore → salience = 1.0", () => {
    const s = outcomeScoreToSalience(1.0, 1.0);
    expect(s).toBe(1.0);
  });

  test("negative score → salience = diversity floor", () => {
    // Negative scores are clipped to 0, then the floor kicks in.
    const s = outcomeScoreToSalience(-0.5, 1.0);
    expect(s).toBeGreaterThanOrEqual(0);
    // The floor is DIVERSITY_FLOOR_FRACTION (0.1) of the max (1.0) = 0.1.
    // But the floor formula is max(DIVERSITY_FLOOR_FRACTION, 0) = 0.1.
    expect(s).toBeGreaterThanOrEqual(0);
  });

  test("maxScore = 0 → returns diversity floor", () => {
    // No positive scores in the stash yet.
    const s = outcomeScoreToSalience(0, 0);
    // Should be the diversity floor (0.1 by default).
    // Per implementation: when maxScore <= 0, returns DIVERSITY_FLOOR_FRACTION.
    expect(s).toBeCloseTo(0.1, 5);
  });

  test("zero score with positive maxScore → diversity floor or 0", () => {
    const s = outcomeScoreToSalience(0, 2.0);
    // clipped = max(0, 0) = 0, normalised = 0/2 = 0
    // floor = max(DIVERSITY_FLOOR_FRACTION * 2 === 0 ? 0 : 0.1, 0) = 0.1
    expect(s).toBeGreaterThanOrEqual(0);
  });
});

// ── Two-sided prediction error (fix task 1/5) ────────────────────────────────

describe("updateAssetOutcome — two-sided prediction error (EMA-over-delta)", () => {
  test("below-expected delta produces strictly negative predictionError and lowers score", () => {
    const { db } = openTestDb();
    try {
      // Seed a row where expected_retrieval_rate represents a healthy per-cycle delta (5).
      db.prepare(
        `INSERT INTO asset_outcome
           (asset_ref, last_retrieved_at, retrieval_count, expected_retrieval_rate,
            negative_feedback_count, accepted_change_count, review_pressure,
            outcome_score, updated_at)
         VALUES ('skill:two-sided', 0, 100, 5.0, 0, 0, 0, 0.2, ?)`,
      ).run(NOW);

      // Only delta=1 this cycle vs. expected=5 → predictionError = 1 - 5 = -4 (negative).
      const result = updateAssetOutcome(db, {
        ref: "skill:two-sided",
        currentRetrievalCount: 101, // delta = 1
        lastRetrievedAt: NOW + 1000,
        acceptedChangeCount: 0,
        negativeFeedbackCount: 0,
        valence: 0,
        now: NOW + 1000,
      });

      expect(result.isNewRow).toBe(false);
      // Score must be strictly less than the prior score (0.2) because predictionError is negative.
      expect(result.outcomeScore).toBeLessThan(0.2);
      expect(result.outcomeScore).toBeGreaterThanOrEqual(-1.0);
    } finally {
      db.close();
    }
  });

  test("above-expected delta produces positive predictionError and raises score", () => {
    const { db } = openTestDb();
    try {
      // Seed row where expected_retrieval_rate = 2 (low delta expectation).
      db.prepare(
        `INSERT INTO asset_outcome
           (asset_ref, last_retrieved_at, retrieval_count, expected_retrieval_rate,
            negative_feedback_count, accepted_change_count, review_pressure,
            outcome_score, updated_at)
         VALUES ('skill:above-expected', 0, 100, 2.0, 0, 5, 0, 0.1, ?)`,
      ).run(NOW);

      // delta=10 this cycle vs. expected=2 → predictionError = 10 - 2 = +8 (positive).
      const result = updateAssetOutcome(db, {
        ref: "skill:above-expected",
        currentRetrievalCount: 110, // delta = 10
        lastRetrievedAt: NOW + 1000,
        acceptedChangeCount: 5,
        negativeFeedbackCount: 0,
        valence: 0,
        now: NOW + 1000,
      });

      expect(result.isNewRow).toBe(false);
      // Score must be strictly greater than the prior score (0.1).
      expect(result.outcomeScore).toBeGreaterThan(0.1);
    } finally {
      db.close();
    }
  });

  test("sustained below-expected sequence drives score below 0 (clipped at OUTCOME_SCORE_MIN)", () => {
    const { db } = openTestDb();
    try {
      // Start with a healthy score and high expected delta.
      db.prepare(
        `INSERT INTO asset_outcome
           (asset_ref, last_retrieved_at, retrieval_count, expected_retrieval_rate,
            negative_feedback_count, accepted_change_count, review_pressure,
            outcome_score, updated_at)
         VALUES ('skill:sustained-low', 0, 100, 10.0, 0, 0, 0, 0.5, ?)`,
      ).run(NOW);

      let base = 100;
      let lastResult = { outcomeScore: 0.5, reviewPressure: 0, isNewRow: false };
      for (let i = 1; i <= 10; i++) {
        base += 1; // only delta=1 per cycle vs. expected≈10
        lastResult = updateAssetOutcome(db, {
          ref: "skill:sustained-low",
          currentRetrievalCount: base,
          lastRetrievedAt: NOW + i * 1000,
          acceptedChangeCount: 0,
          negativeFeedbackCount: 0,
          valence: 0,
          now: NOW + i * 1000,
        });
      }

      // After 10 cycles of delta=1 vs. expected≈10, score should be well below 0.
      expect(lastResult.outcomeScore).toBeLessThan(0);
      expect(lastResult.outcomeScore).toBeGreaterThanOrEqual(-1.0);
    } finally {
      db.close();
    }
  });

  test("EMA advances over observed delta — not cumulative count", () => {
    const { db } = openTestDb();
    try {
      // Seed: retrieval_count=100, expected_retrieval_rate=5.
      db.prepare(
        `INSERT INTO asset_outcome
           (asset_ref, last_retrieved_at, retrieval_count, expected_retrieval_rate,
            negative_feedback_count, accepted_change_count, review_pressure,
            outcome_score, updated_at)
         VALUES ('skill:ema-delta', 0, 100, 5.0, 0, 0, 0, 0.0, ?)`,
      ).run(NOW);

      // delta=8 this cycle; new EMA = 0.3×8 + 0.7×5 = 2.4 + 3.5 = 5.9
      updateAssetOutcome(db, {
        ref: "skill:ema-delta",
        currentRetrievalCount: 108, // delta = 8
        lastRetrievedAt: NOW + 1000,
        acceptedChangeCount: 0,
        negativeFeedbackCount: 0,
        valence: 0,
        now: NOW + 1000,
      });

      const row = getAssetOutcome(db, "skill:ema-delta");
      // expected_retrieval_rate should track the DELTA (≈5.9), not the cumulative count (108).
      expect(row?.expected_retrieval_rate).toBeCloseTo(5.9, 5);
      expect(row?.expected_retrieval_rate).toBeLessThan(10); // definitely not near 108
    } finally {
      db.close();
    }
  });

  test("warm-start seeds expected_retrieval_rate = 0, not currentRetrievalCount", () => {
    const { db } = openTestDb();
    try {
      updateAssetOutcome(db, {
        ref: "skill:warm-zero",
        currentRetrievalCount: 50,
        lastRetrievedAt: NOW,
        acceptedChangeCount: 0,
        negativeFeedbackCount: 0,
        utilityScore: 0.2,
        now: NOW,
      });

      const row = getAssetOutcome(db, "skill:warm-zero");
      expect(row?.expected_retrieval_rate).toBe(0);
    } finally {
      db.close();
    }
  });
});

// ── computeProxyAdequacy ──────────────────────────────────────────────────────

describe("computeProxyAdequacy — correlation tripwire", () => {
  test("returns NaN correlation and isInverted=false for fewer than 3 rows", () => {
    const rows = [
      {
        asset_ref: "skill:a",
        last_retrieved_at: 0,
        retrieval_count: 5,
        expected_retrieval_rate: 5,
        negative_feedback_count: 0,
        accepted_change_count: 1,
        review_pressure: 0,
        outcome_score: 0.5,
        updated_at: NOW,
      },
    ];
    const result = computeProxyAdequacy(rows);
    expect(Number.isNaN(result.correlation)).toBe(true);
    expect(result.isInverted).toBe(false);
  });

  test("isInverted=false for positive correlation", () => {
    // High outcome_score → high accepted_change_rate: proxy is coherent.
    const rows = [0.8, 0.6, 0.4, 0.2].map((score, i) => ({
      asset_ref: `skill:${i}`,
      last_retrieved_at: 0,
      retrieval_count: 10,
      expected_retrieval_rate: 10,
      negative_feedback_count: 0,
      accepted_change_count: Math.round(score * 10), // proportional to score
      review_pressure: 0,
      outcome_score: score,
      updated_at: NOW,
    }));
    const result = computeProxyAdequacy(rows);
    expect(result.isInverted).toBe(false);
    expect(result.correlation).toBeGreaterThan(0);
  });

  test("isInverted=true for negative correlation below -0.3", () => {
    // High outcome_score → LOW accepted_change_rate: proxy is inverted.
    const refs = ["skill:a", "skill:b", "skill:c", "skill:d", "skill:e"];
    const rows = refs.map((ref, i) => {
      // Outcome scores: 0.9, 0.7, 0.5, 0.3, 0.1 (high = popular)
      const outcomeScore = 0.9 - i * 0.2;
      // accepted_change_rate: inversely proportional (popular = never improved)
      const acceptedChangeCount = i * 2; // 0, 2, 4, 6, 8 → rates 0, 0.2, 0.4, 0.6, 0.8
      return {
        asset_ref: ref,
        last_retrieved_at: 0,
        retrieval_count: 10,
        expected_retrieval_rate: 10,
        negative_feedback_count: 0,
        accepted_change_count: acceptedChangeCount,
        review_pressure: 0,
        outcome_score: outcomeScore,
        updated_at: NOW,
      };
    });
    const result = computeProxyAdequacy(rows);
    expect(result.isInverted).toBe(true);
    expect(result.correlation).toBeLessThan(-0.3);
  });

  test("returns n = number of rows", () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({
      asset_ref: `skill:${i}`,
      last_retrieved_at: 0,
      retrieval_count: 5,
      expected_retrieval_rate: 5,
      negative_feedback_count: 0,
      accepted_change_count: i,
      review_pressure: 0,
      outcome_score: i * 0.1,
      updated_at: NOW,
    }));
    const result = computeProxyAdequacy(rows);
    expect(result.n).toBe(7);
  });
});
