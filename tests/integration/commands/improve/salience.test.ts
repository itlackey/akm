// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS-1 salience vector — unit tests.
 *
 * Covers:
 *   - computeSalience: pure-function correctness, recency decay, size penalty,
 *     [0,1] normalization, rankScore projection.
 *   - state.db persistence: upsertAssetSalience / getAssetSalience round-trip.
 *   - Plasticity helpers: recordNoOp, resetConsecutiveNoOps, getConsecutiveNoOps.
 *   - buildRankChangeReport: forgetting-candidate detection.
 *   - W_ENCODING + W_OUTCOME + W_RETRIEVAL == 1.0.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildRankChangeReport,
  computeSalience,
  DEFAULT_ENCODING_SALIENCE,
  DEFAULT_TYPE_ENCODING_WEIGHTS,
  getAssetSalience,
  getConsecutiveNoOps,
  isContentEncodingRow,
  recordNoOp,
  resetConsecutiveNoOps,
  upsertAssetSalience,
  W_ENCODING,
  W_ENCODING_PARITY,
  W_OUTCOME,
  W_OUTCOME_PARITY,
  W_RETRIEVAL,
  W_RETRIEVAL_PARITY,
} from "../../../../src/commands/improve/salience";
import { openStateDatabase } from "../../../../src/core/state-db";

// ── Helpers ────────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-06-14T12:00:00.000Z");
const DAY_MS = 86_400_000;

/** Open a fresh in-memory state.db for tests. */
function openTestStateDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-salience-test-"));
  const db = openStateDatabase(path.join(tmpDir, "state.db"));
  return { db, tmpDir };
}

// ── Weight contract ────────────────────────────────────────────────────────────

describe("WS-1/WS-2 weight contract", () => {
  test("W_ENCODING + W_OUTCOME + W_RETRIEVAL = 1.0", () => {
    expect(W_ENCODING + W_OUTCOME + W_RETRIEVAL).toBeCloseTo(1.0, 9);
  });

  test("W_OUTCOME constant is 0.15 (WS-2 target value)", () => {
    // The constant reflects the WS-2 opt-in target. The weight is only
    // applied in the rankScore projection when outcomeWeightEnabled=true.
    expect(W_OUTCOME).toBe(0.15);
  });

  test("W_ENCODING_PARITY + W_OUTCOME_PARITY + W_RETRIEVAL_PARITY = 1.0", () => {
    expect(W_ENCODING_PARITY + W_OUTCOME_PARITY + W_RETRIEVAL_PARITY).toBeCloseTo(1.0, 9);
  });

  test("parity constants reflect WS-1 two-way split (w_e=0.30, w_r=0.70, w_o=0)", () => {
    expect(W_ENCODING_PARITY).toBe(0.3);
    expect(W_OUTCOME_PARITY).toBe(0);
    expect(W_RETRIEVAL_PARITY).toBe(0.7);
  });

  test("opt-out ranking uses parity constants (no bare literals in else branch)", () => {
    // With outcomeWeightEnabled=false (explicit opt-out), rankScore must match
    // the formula using parity constants. Verify by computing with high
    // outcomeSalience: the outcome term must be zeroed (W_OUTCOME_PARITY=0).
    const vHigh = computeSalience({
      ref: "skills/foo",
      type: "skill",
      retrievalFreq: 5,
      lastUseMs: NOW,
      outcomeSalience: 1.0,
      outcomeWeightEnabled: false,
      now: NOW,
    });
    const vZero = computeSalience({
      ref: "skills/foo",
      type: "skill",
      retrievalFreq: 5,
      lastUseMs: NOW,
      outcomeSalience: 0,
      outcomeWeightEnabled: false,
      now: NOW,
    });
    // rankScore must be identical since W_OUTCOME_PARITY=0 zeros the outcome term.
    expect(vHigh.rankScore).toBe(vZero.rankScore);
  });
});

// ── computeSalience — encoding sub-score ──────────────────────────────────────

describe("computeSalience — encoding sub-score", () => {
  test("skill type gets the highest encoding weight", () => {
    const v = computeSalience({ ref: "skills/foo", type: "skill", retrievalFreq: 0, now: NOW });
    expect(v.encoding).toBe(DEFAULT_TYPE_ENCODING_WEIGHTS.skill!);
    expect(v.encoding).toBeGreaterThanOrEqual(0.9);
  });

  test("memory type gets the lowest encoding weight", () => {
    const v = computeSalience({ ref: "memories/foo", type: "memory", retrievalFreq: 0, now: NOW });
    expect(v.encoding).toBe(DEFAULT_TYPE_ENCODING_WEIGHTS.memory!);
    expect(v.encoding).toBeLessThan(DEFAULT_TYPE_ENCODING_WEIGHTS.skill ?? 1);
  });

  test("unknown type falls back to DEFAULT_ENCODING_SALIENCE", () => {
    const v = computeSalience({ ref: "customtype:foo", type: "customtype", retrievalFreq: 0, now: NOW });
    expect(v.encoding).toBe(DEFAULT_ENCODING_SALIENCE);
  });

  test("empty type string falls back to DEFAULT_ENCODING_SALIENCE", () => {
    const v = computeSalience({ ref: "", type: "", retrievalFreq: 0, now: NOW });
    expect(v.encoding).toBe(DEFAULT_ENCODING_SALIENCE);
  });
});

// ── computeSalience — outcome sub-score ──────────────────────────────────────

describe("computeSalience — outcome sub-score", () => {
  test("outcome is 0 when no outcomeSalience or utilityScore is provided", () => {
    const v = computeSalience({ ref: "skills/foo", type: "skill", retrievalFreq: 100, now: NOW });
    // No outcomeSalience input, no utilityScore → warm-start seed = 0.
    expect(v.outcome).toBe(0);
  });

  test("outcome uses outcomeSalience when provided", () => {
    const v = computeSalience({
      ref: "skills/foo",
      type: "skill",
      retrievalFreq: 0,
      outcomeSalience: 0.7,
      now: NOW,
    });
    expect(v.outcome).toBeCloseTo(0.7, 9);
  });

  test("outcome warm-starts from utilityScore clipped to WARM_START_CAP when outcomeSalience absent", () => {
    const v = computeSalience({
      ref: "skills/foo",
      type: "skill",
      retrievalFreq: 100,
      utilityScore: 0.9, // above WARM_START_CAP (0.3)
      now: NOW,
    });
    // utilityScore 0.9 gets clipped to WARM_START_CAP = 0.3.
    expect(v.outcome).toBeCloseTo(0.3, 9);
  });

  test("outcome warm-start with low utilityScore below WARM_START_CAP", () => {
    const v = computeSalience({
      ref: "skills/foo",
      type: "skill",
      retrievalFreq: 0,
      utilityScore: 0.1, // below WARM_START_CAP (0.3)
      now: NOW,
    });
    expect(v.outcome).toBeCloseTo(0.1, 9);
  });

  test("outcome is clamped to [0,1]", () => {
    const v = computeSalience({
      ref: "skills/foo",
      type: "skill",
      retrievalFreq: 0,
      outcomeSalience: 1.5, // above 1 → clamped
      now: NOW,
    });
    expect(v.outcome).toBe(1.0);
  });

  test("outcome affects rankScore by DEFAULT (R1 loop closure) and not on explicit opt-out", () => {
    // Default: outcomeWeightEnabled absent → WS-2 weights (w_o=0.15) — the
    // outcome signal shapes ranking out of the box.
    const vHigh = computeSalience({
      ref: "skills/foo",
      type: "skill",
      retrievalFreq: 0,
      outcomeSalience: 1.0,
      now: NOW,
    });
    const vZero = computeSalience({
      ref: "skills/foo",
      type: "skill",
      retrievalFreq: 0,
      outcomeSalience: 0,
      now: NOW,
    });
    expect(vHigh.rankScore).toBeGreaterThan(vZero.rankScore);

    // Explicit opt-out: outcomeWeightEnabled=false → WS-1 parity (w_o=0);
    // outcomeSalience is stored in the vector but does not change rankScore.
    const vHighOff = computeSalience({
      ref: "skills/foo",
      type: "skill",
      retrievalFreq: 0,
      outcomeSalience: 1.0,
      outcomeWeightEnabled: false,
      now: NOW,
    });
    const vZeroOff = computeSalience({
      ref: "skills/foo",
      type: "skill",
      retrievalFreq: 0,
      outcomeSalience: 0,
      outcomeWeightEnabled: false,
      now: NOW,
    });
    expect(vHighOff.rankScore).toBe(vZeroOff.rankScore);
    // outcome sub-score is still stored in the vector for observability.
    expect(vHighOff.outcome).toBe(1.0);
    expect(vZeroOff.outcome).toBe(0);
  });

  test("opt-out rankScore matches WS-1 parity formula exactly (ranking-invariance assertion)", () => {
    // Integration invariant: outcomeWeightEnabled=false must produce rankScore
    // equal to (W_ENCODING_PARITY * encoding + W_RETRIEVAL_PARITY * retrieval) *
    // sizePenalty, clamped to [0,1].  This test uses deterministic inputs and
    // replicates the sizePenalty computation inline so any future accidental drift
    // of the parity weights (e.g. changing a literal in the else branch) fails here.
    const SIZE_BYTES = 4_000;
    const v = computeSalience({
      ref: "lessons/invariance-check",
      type: "lesson",
      retrievalFreq: 8,
      lastUseMs: NOW - 3 * DAY_MS,
      sizeBytes: SIZE_BYTES,
      outcomeSalience: 0.85, // non-zero; must NOT appear in the opt-out rankScore
      outcomeWeightEnabled: false,
      now: NOW,
    });

    // Replicate the sizePenalty the same way salience.ts does it.
    const SIZE_FLOOR_BYTES = 200;
    const sizePenalty = 1 / Math.log10(Math.max(SIZE_FLOOR_BYTES, SIZE_BYTES));
    // Expected rankScore using the WS-1 parity formula (w_o=0 → outcome term absent).
    const expected = Math.min(
      1,
      Math.max(0, (W_ENCODING_PARITY * v.encoding + W_RETRIEVAL_PARITY * v.retrieval) * sizePenalty),
    );

    expect(v.rankScore).toBeCloseTo(expected, 12);
    // Confirm the outcome sub-score IS non-zero (proves we tested a non-trivial input).
    expect(v.outcome).toBeCloseTo(0.85, 9);
  });

  test("outcome is W_OUTCOME-weighted in rankScore when outcomeWeightEnabled=true", () => {
    // With outcomeWeightEnabled=true and outcomeSalience = 1.0 and no retrieval,
    // the outcome term raises rankScore above the zero-outcome baseline.
    const vHigh = computeSalience({
      ref: "skills/foo",
      type: "skill",
      retrievalFreq: 0,
      outcomeSalience: 1.0,
      outcomeWeightEnabled: true,
      now: NOW,
    });
    const vZero = computeSalience({
      ref: "skills/foo",
      type: "skill",
      retrievalFreq: 0,
      outcomeSalience: 0,
      outcomeWeightEnabled: true,
      now: NOW,
    });
    // rankScore with high outcomeSalience should exceed rankScore with zero.
    expect(vHigh.rankScore).toBeGreaterThan(vZero.rankScore);
  });
});

// ── computeSalience — retrieval sub-score ─────────────────────────────────────

describe("computeSalience — retrieval sub-score", () => {
  test("zero retrievals => retrieval = 0", () => {
    const v = computeSalience({ ref: "lessons/foo", type: "lesson", retrievalFreq: 0, now: NOW });
    expect(v.retrieval).toBe(0);
  });

  test("non-zero retrievals => retrieval > 0", () => {
    const v = computeSalience({ ref: "lessons/foo", type: "lesson", retrievalFreq: 10, now: NOW });
    expect(v.retrieval).toBeGreaterThan(0);
  });

  test("retrieval is bounded to [0,1]", () => {
    // Extremely high retrieval count — still normalized to < 1.
    const v = computeSalience({
      ref: "lessons/foo",
      type: "lesson",
      retrievalFreq: 1_000_000,
      lastUseMs: NOW,
      now: NOW,
    });
    expect(v.retrieval).toBeGreaterThan(0);
    expect(v.retrieval).toBeLessThanOrEqual(1);
  });

  test("fresh lastUseMs gives higher retrieval than stale lastUseMs (same freq)", () => {
    const fresh = computeSalience({
      ref: "lessons/foo",
      type: "lesson",
      retrievalFreq: 5,
      lastUseMs: NOW - 1 * DAY_MS,
      now: NOW,
    });
    const stale = computeSalience({
      ref: "lessons/foo",
      type: "lesson",
      retrievalFreq: 5,
      lastUseMs: NOW - 120 * DAY_MS,
      now: NOW,
    });
    expect(fresh.retrieval).toBeGreaterThan(stale.retrieval);
  });

  test("absent lastUseMs (never retrieved) gets floor recency (~0.1 decay)", () => {
    const noUse = computeSalience({
      ref: "lessons/foo",
      type: "lesson",
      retrievalFreq: 5,
      lastUseMs: undefined,
      now: NOW,
    });
    const recent = computeSalience({
      ref: "lessons/foo",
      type: "lesson",
      retrievalFreq: 5,
      lastUseMs: NOW,
      now: NOW,
    });
    // Never-used asset should score significantly lower than recently-used one.
    expect(noUse.retrieval).toBeLessThan(recent.retrieval);
  });

  test("recency floor keeps decaying on the long half-life (R4 — no parking at 0.1)", () => {
    // Under the old formula both very-stale assets parked at the 0.1 floor and
    // became indistinguishable. The floor now halves every 180 days, so an
    // unreviewed-forever asset keeps drifting down monotonically.
    const at = (days: number) =>
      computeSalience({
        ref: "lessons/foo",
        type: "lesson",
        retrievalFreq: 5,
        lastUseMs: NOW - days * DAY_MS,
        now: NOW,
      }).retrieval;
    const d100 = at(100);
    const d400 = at(400);
    const d800 = at(800);
    expect(d400).toBeLessThan(d100);
    expect(d800).toBeLessThan(d400);
    // And an 800-day-stale asset sits well below the old 0.1-floor equivalent:
    // old formula gave log(1+5)×~0.1 → normalised ≈ 0.152.
    expect(d800).toBeLessThan(0.05);
  });
});

// ── computeSalience — rankScore ───────────────────────────────────────────────

describe("computeSalience — rankScore", () => {
  test("rankScore is in [0, 1]", () => {
    const cases = [
      { ref: "skills/a", type: "skill", retrievalFreq: 0 },
      { ref: "skills/b", type: "skill", retrievalFreq: 100, lastUseMs: NOW },
      { ref: "memories/c", type: "memory", retrievalFreq: 1 },
      { ref: "lessons/d", type: "lesson", retrievalFreq: 50, lastUseMs: NOW - 5 * DAY_MS, sizeBytes: 50_000 },
    ];
    for (const c of cases) {
      const v = computeSalience({ ...c, now: NOW });
      expect(v.rankScore).toBeGreaterThanOrEqual(0);
      expect(v.rankScore).toBeLessThanOrEqual(1);
    }
  });

  test("larger assets get lower rankScore than smaller ones (size penalty)", () => {
    const small = computeSalience({
      ref: "lessons/foo",
      type: "lesson",
      retrievalFreq: 10,
      lastUseMs: NOW,
      sizeBytes: 500,
      now: NOW,
    });
    const large = computeSalience({
      ref: "lessons/foo",
      type: "lesson",
      retrievalFreq: 10,
      lastUseMs: NOW,
      sizeBytes: 100_000,
      now: NOW,
    });
    expect(small.rankScore).toBeGreaterThan(large.rankScore);
  });

  test("higher-importance type (skill) outranks lower-importance type (memory) with same retrieval", () => {
    const skill = computeSalience({
      ref: "skills/x",
      type: "skill",
      retrievalFreq: 5,
      lastUseMs: NOW,
      now: NOW,
    });
    const mem = computeSalience({
      ref: "memories/x",
      type: "memory",
      retrievalFreq: 5,
      lastUseMs: NOW,
      now: NOW,
    });
    expect(skill.rankScore).toBeGreaterThan(mem.rankScore);
  });

  test("zero retrieval => rankScore dominated by encoding only", () => {
    const v = computeSalience({
      ref: "knowledge/foo",
      type: "knowledge",
      retrievalFreq: 0,
      sizeBytes: 1000,
      now: NOW,
    });
    // rankScore should be positive (encoding term contributes).
    expect(v.rankScore).toBeGreaterThan(0);
  });

  test("rankScore = 0 for zero retrieval when W_ENCODING = 0 is impossible (type weight always positive)", () => {
    // All types have a positive encoding weight, so rankScore can never be 0 for a real asset.
    const v = computeSalience({ ref: "memories/x", type: "memory", retrievalFreq: 0, sizeBytes: 200, now: NOW });
    expect(v.rankScore).toBeGreaterThan(0);
  });
});

// ── state.db persistence round-trip ───────────────────────────────────────────

describe("state.db persistence: upsertAssetSalience / getAssetSalience", () => {
  test("round-trip: upsert then get returns the same values", () => {
    const { db, tmpDir } = openTestStateDb();
    try {
      const vector = computeSalience({
        ref: "lessons/alpha",
        type: "lesson",
        retrievalFreq: 10,
        lastUseMs: NOW - 2 * DAY_MS,
        sizeBytes: 1000,
        now: NOW,
      });
      upsertAssetSalience(db, "lessons/alpha", vector, NOW);
      const row = getAssetSalience(db, "lessons/alpha");
      expect(row).toBeDefined();
      expect(row?.asset_ref).toBe("lessons/alpha");
      expect(row?.encoding_salience).toBeCloseTo(vector.encoding, 6);
      expect(row?.outcome_salience).toBeCloseTo(vector.outcome, 6);
      expect(row?.retrieval_salience).toBeCloseTo(vector.retrieval, 6);
      expect(row?.rank_score).toBeCloseTo(vector.rankScore, 6);
      expect(row?.consecutive_no_ops).toBe(0);
      expect(row?.updated_at).toBe(NOW);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("get returns undefined for a ref not yet persisted", () => {
    const { db, tmpDir } = openTestStateDb();
    try {
      const row = getAssetSalience(db, "lessons/nonexistent");
      expect(row).toBeUndefined();
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("second upsert overwrites the first (idempotent ON CONFLICT DO UPDATE)", () => {
    const { db, tmpDir } = openTestStateDb();
    try {
      const v1 = computeSalience({ ref: "skills/a", type: "skill", retrievalFreq: 1, now: NOW });
      const v2 = computeSalience({ ref: "skills/a", type: "skill", retrievalFreq: 50, lastUseMs: NOW, now: NOW });
      upsertAssetSalience(db, "skills/a", v1, NOW - DAY_MS);
      upsertAssetSalience(db, "skills/a", v2, NOW);
      const row = getAssetSalience(db, "skills/a");
      expect(row?.retrieval_salience).toBeCloseTo(v2.retrieval, 6);
      expect(row?.rank_score).toBeCloseTo(v2.rankScore, 6);
      expect(row?.updated_at).toBe(NOW);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("upsert does NOT reset consecutive_no_ops (that's done by resetConsecutiveNoOps)", () => {
    const { db, tmpDir } = openTestStateDb();
    try {
      const vector = computeSalience({ ref: "lessons/beta", type: "lesson", retrievalFreq: 0, now: NOW });
      // Pre-seed the salience row, then increment consecutive_no_ops via recordNoOp.
      upsertAssetSalience(db, "lessons/beta", vector, NOW);
      recordNoOp(db, "lessons/beta");
      recordNoOp(db, "lessons/beta");
      // Now upsert again — should NOT reset consecutive_no_ops.
      upsertAssetSalience(db, "lessons/beta", vector, NOW);
      const row = getAssetSalience(db, "lessons/beta");
      expect(row?.consecutive_no_ops).toBe(2);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── #644 — encoding provenance: content scores survive the type-stub fallback ──

describe("#644 encoding_salience provenance (content vs type-stub)", () => {
  // A genuine content-derived score for an agent. The agent type stub is 0.9
  // (DEFAULT_TYPE_ENCODING_WEIGHTS.agent); 0.65 mimics the issue's measured
  // community-manager value (content formula ~0.65 < stub 0.9).
  const CONTENT_SCORE = 0.65;

  test("computeSalience tags encodingSource 'content' when encodingSalience is supplied", () => {
    const v = computeSalience({ ref: "agents/x", type: "agent", retrievalFreq: 0, encodingSalience: CONTENT_SCORE });
    expect(v.encoding).toBeCloseTo(CONTENT_SCORE, 6);
    expect(v.encodingSource).toBe("content");
  });

  test("computeSalience tags encodingSource 'type-stub' when encodingSalience is absent", () => {
    const v = computeSalience({ ref: "agents/x", type: "agent", retrievalFreq: 0 });
    expect(v.encoding).toBeCloseTo(DEFAULT_TYPE_ENCODING_WEIGHTS.agent!, 6);
    expect(v.encodingSource).toBe("type-stub");
  });

  test("upsert persists encoding_source provenance", () => {
    const { db, tmpDir } = openTestStateDb();
    try {
      const content = computeSalience({
        ref: "agents/c",
        type: "agent",
        retrievalFreq: 0,
        encodingSalience: CONTENT_SCORE,
      });
      upsertAssetSalience(db, "agents/c", content, NOW);
      expect(getAssetSalience(db, "agents/c")?.encoding_source).toBe("content");

      const stub = computeSalience({ ref: "agents/s", type: "agent", retrievalFreq: 0 });
      upsertAssetSalience(db, "agents/s", stub, NOW);
      expect(getAssetSalience(db, "agents/s")?.encoding_source).toBe("type-stub");
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("a later type-stub upsert does NOT clobber a stored content-derived score (THE #644 bug)", () => {
    const { db, tmpDir } = openTestStateDb();
    try {
      // 1. Distill writes a real content score (0.65, below the agent stub 0.9).
      const distillVector = computeSalience({
        ref: "agents/community-manager",
        type: "agent",
        retrievalFreq: 0,
        encodingSalience: CONTENT_SCORE,
      });
      upsertAssetSalience(db, "agents/community-manager", distillVector, NOW - DAY_MS);
      expect(getAssetSalience(db, "agents/community-manager")?.encoding_salience).toBeCloseTo(CONTENT_SCORE, 6);

      // 2. A later improve run with NO encodingSalience would recompute the
      //    type-weight stub (0.9). Pre-#644 this overwrote the real score.
      const stubVector = computeSalience({ ref: "agents/community-manager", type: "agent", retrievalFreq: 0 });
      expect(stubVector.encoding).toBeCloseTo(0.9, 6); // the stub
      upsertAssetSalience(db, "agents/community-manager", stubVector, NOW);

      // 3. The stored content score and provenance MUST survive.
      const row = getAssetSalience(db, "agents/community-manager");
      expect(row?.encoding_salience).toBeCloseTo(CONTENT_SCORE, 6);
      expect(row?.encoding_source).toBe("content");
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("a content upsert DOES overwrite a prior type-stub row (real score wins)", () => {
    const { db, tmpDir } = openTestStateDb();
    try {
      // 1. First seen as a stub (never content-scored).
      upsertAssetSalience(
        db,
        "agents/a",
        computeSalience({ ref: "agents/a", type: "agent", retrievalFreq: 0 }),
        NOW - DAY_MS,
      );
      expect(getAssetSalience(db, "agents/a")?.encoding_salience).toBeCloseTo(0.9, 6);

      // 2. Distill later computes a real score → it must replace the stub.
      upsertAssetSalience(
        db,
        "agents/a",
        computeSalience({ ref: "agents/a", type: "agent", retrievalFreq: 0, encodingSalience: CONTENT_SCORE }),
        NOW,
      );
      const row = getAssetSalience(db, "agents/a");
      expect(row?.encoding_salience).toBeCloseTo(CONTENT_SCORE, 6);
      expect(row?.encoding_source).toBe("content");
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("a content upsert is updated by a newer content upsert (content→content always wins)", () => {
    const { db, tmpDir } = openTestStateDb();
    try {
      upsertAssetSalience(
        db,
        "agents/a",
        computeSalience({ ref: "agents/a", type: "agent", retrievalFreq: 0, encodingSalience: 0.65 }),
        NOW - DAY_MS,
      );
      upsertAssetSalience(
        db,
        "agents/a",
        computeSalience({ ref: "agents/a", type: "agent", retrievalFreq: 0, encodingSalience: 0.42 }),
        NOW,
      );
      const row = getAssetSalience(db, "agents/a");
      expect(row?.encoding_salience).toBeCloseTo(0.42, 6);
      expect(row?.encoding_source).toBe("content");
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("isContentEncodingRow: 'content' true, 'type-stub' false", () => {
    const { db, tmpDir } = openTestStateDb();
    try {
      upsertAssetSalience(
        db,
        "agents/c",
        computeSalience({ ref: "agents/c", type: "agent", retrievalFreq: 0, encodingSalience: CONTENT_SCORE }),
        NOW,
      );
      upsertAssetSalience(db, "agents/s", computeSalience({ ref: "agents/s", type: "agent", retrievalFreq: 0 }), NOW);
      const contentRow = getAssetSalience(db, "agents/c");
      const stubRow = getAssetSalience(db, "agents/s");
      expect(contentRow && isContentEncodingRow(contentRow, "agent")).toBe(true);
      expect(stubRow && isContentEncodingRow(stubRow, "agent")).toBe(false);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("isContentEncodingRow legacy NULL-provenance heuristic: differs-from-stub ⇒ content", () => {
    const { db, tmpDir } = openTestStateDb();
    try {
      // Simulate a legacy row written before migration 015 (encoding_source NULL)
      // whose stored value differs from the type stub — i.e. a real score that was
      // never re-clobbered. The heuristic must treat it as content.
      db.prepare(
        `INSERT INTO asset_salience
           (asset_ref, encoding_salience, outcome_salience, retrieval_salience, rank_score, consecutive_no_ops, updated_at, encoding_source)
         VALUES (?, ?, 0, 0, 0, 0, ?, NULL)`,
      ).run("memories/legacy-real", 0.83, NOW);
      // And a legacy row sitting exactly on the type stub — treat as a stub.
      db.prepare(
        `INSERT INTO asset_salience
           (asset_ref, encoding_salience, outcome_salience, retrieval_salience, rank_score, consecutive_no_ops, updated_at, encoding_source)
         VALUES (?, ?, 0, 0, 0, 0, ?, NULL)`,
      ).run("agents/legacy-stub", DEFAULT_TYPE_ENCODING_WEIGHTS.agent!, NOW);

      const realRow = getAssetSalience(db, "memories/legacy-real");
      const stubRow = getAssetSalience(db, "agents/legacy-stub");
      expect(realRow?.encoding_source).toBeNull();
      expect(realRow && isContentEncodingRow(realRow, "memory")).toBe(true);
      expect(stubRow && isContentEncodingRow(stubRow, "agent")).toBe(false);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Plasticity helpers ─────────────────────────────────────────────────────────

describe("plasticity: recordNoOp / resetConsecutiveNoOps / getConsecutiveNoOps", () => {
  test("getConsecutiveNoOps returns 0 for unknown ref", () => {
    const { db, tmpDir } = openTestStateDb();
    try {
      expect(getConsecutiveNoOps(db, "lessons/unknown")).toBe(0);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("recordNoOp on a ref with no salience row leaves the table unchanged (no synthetic rank_score=0 row)", () => {
    // Invariant: recordNoOp must never fabricate a rank_score=0 row. If salience
    // persistence's best-effort try/catch swallowed an error, the asset will have
    // no salience row. A synthetic INSERT would produce a false bottom-of-stash
    // position that buildRankChangeReport could misread as a catastrophic-forgetting
    // signal. The UPDATE-only path avoids this by doing nothing when changes === 0.
    const { db, tmpDir } = openTestStateDb();
    try {
      recordNoOp(db, "skills/absent");
      expect(getConsecutiveNoOps(db, "skills/absent")).toBe(0);
      const row = db.prepare("SELECT * FROM asset_salience WHERE asset_ref = ?").get("skills/absent");
      // bun:sqlite returns null (not undefined) for a missing row.
      expect(row).toBeNull();
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("recordNoOp increments consecutive_no_ops when a salience row already exists", () => {
    const { db, tmpDir } = openTestStateDb();
    try {
      // Pre-seed the salience row so recordNoOp has a row to UPDATE.
      const vector = computeSalience({ ref: "skills/x", type: "skill", retrievalFreq: 5, now: NOW });
      upsertAssetSalience(db, "skills/x", vector, NOW);
      expect(getConsecutiveNoOps(db, "skills/x")).toBe(0);
      recordNoOp(db, "skills/x");
      expect(getConsecutiveNoOps(db, "skills/x")).toBe(1);
      recordNoOp(db, "skills/x");
      recordNoOp(db, "skills/x");
      expect(getConsecutiveNoOps(db, "skills/x")).toBe(3);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("resetConsecutiveNoOps resets to 0", () => {
    const { db, tmpDir } = openTestStateDb();
    try {
      // Pre-seed the salience row before exercising no-op/reset cycle.
      const vector = computeSalience({ ref: "skills/x", type: "skill", retrievalFreq: 5, now: NOW });
      upsertAssetSalience(db, "skills/x", vector, NOW);
      recordNoOp(db, "skills/x");
      recordNoOp(db, "skills/x");
      expect(getConsecutiveNoOps(db, "skills/x")).toBe(2);
      resetConsecutiveNoOps(db, "skills/x");
      expect(getConsecutiveNoOps(db, "skills/x")).toBe(0);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("recordNoOp does NOT change rank_score (plasticity is separate from ranking)", () => {
    const { db, tmpDir } = openTestStateDb();
    try {
      const vector = computeSalience({ ref: "skills/y", type: "skill", retrievalFreq: 10, now: NOW });
      upsertAssetSalience(db, "skills/y", vector, NOW);
      const rowBefore = getAssetSalience(db, "skills/y");
      expect(rowBefore).toBeDefined();
      const before = rowBefore?.rank_score ?? 0;

      recordNoOp(db, "skills/y");
      recordNoOp(db, "skills/y");

      // rank_score unchanged (consecutive_no_ops only affects consolidation selection).
      const rowAfter = getAssetSalience(db, "skills/y");
      expect(rowAfter).toBeDefined();
      expect(rowAfter?.rank_score).toBeCloseTo(before, 6);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── buildRankChangeReport ─────────────────────────────────────────────────────

describe("buildRankChangeReport — forgetting-safety", () => {
  test("no forgetting candidates when all top-200 stay in top-500", () => {
    const oldRanks = new Map([
      ["skills/a", 1],
      ["skills/b", 100],
      ["skills/c", 200],
    ]);
    const newRanks = new Map([
      ["skills/a", 1],
      ["skills/b", 150],
      ["skills/c", 499],
    ]);
    const report = buildRankChangeReport(oldRanks, newRanks);
    expect(report.forgettingCandidates).toHaveLength(0);
    expect(report.allChanges).toHaveLength(3);
  });

  test("detects old top-200 refs that fall below position 500", () => {
    const oldRanks = new Map([
      ["skills/winner", 1],
      ["lessons/loser", 50],
      ["memories/neutral", 150],
    ]);
    const newRanks = new Map([
      ["skills/winner", 1],
      ["lessons/loser", 600], // fell past 500 — forgetting candidate
      ["memories/neutral", 400],
    ]);
    const report = buildRankChangeReport(oldRanks, newRanks);
    expect(report.forgettingCandidates).toHaveLength(1);
    expect(report.forgettingCandidates[0]?.ref).toBe("lessons/loser");
    expect(report.forgettingCandidates[0]?.oldRank).toBe(50);
    expect(report.forgettingCandidates[0]?.newRank).toBe(600);
    expect(report.forgettingCandidates[0]?.rankDelta).toBe(550); // 600 - 50
  });

  test("forgettingCandidates are sorted by rank drop magnitude (largest drop first)", () => {
    const oldRanks = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    const newRanks = new Map([
      ["a", 900], // dropped 899
      ["b", 600], // dropped 598
    ]);
    const report = buildRankChangeReport(oldRanks, newRanks);
    expect(report.forgettingCandidates[0]?.ref).toBe("a");
    expect(report.forgettingCandidates[1]?.ref).toBe("b");
  });

  test("refs beyond the old top-N boundary are NOT flagged as forgetting candidates", () => {
    // old rank 201 is beyond the default oldTopN=200, so it doesn't qualify.
    const oldRanks = new Map([["lessons/just-outside", 201]]);
    const newRanks = new Map([["lessons/just-outside", 999]]);
    const report = buildRankChangeReport(oldRanks, newRanks);
    expect(report.forgettingCandidates).toHaveLength(0);
  });

  test("empty inputs produce empty report", () => {
    const report = buildRankChangeReport(new Map(), new Map());
    expect(report.forgettingCandidates).toHaveLength(0);
    expect(report.allChanges).toHaveLength(0);
  });

  test("custom oldTopN and forgettingThreshold are respected", () => {
    const oldRanks = new Map([["x", 5]]);
    const newRanks = new Map([["x", 51]]);
    // Default thresholds: 200/500 — no candidate. Custom: 10/50 — flagged.
    expect(buildRankChangeReport(oldRanks, newRanks).forgettingCandidates).toHaveLength(0);
    expect(buildRankChangeReport(oldRanks, newRanks, 10, 50).forgettingCandidates).toHaveLength(1);
  });
});

// ── encodingSalience override (#608) ────────────────────────────────────────

describe("computeSalience — encodingSalience override (#608)", () => {
  test("encodingSalience override: when provided, used instead of type-weight stub", () => {
    // memory type stub is 0.5, but override is 0.9 — encoding should reflect override
    const v = computeSalience({
      ref: "memories/foo",
      type: "memory",
      retrievalFreq: 0,
      encodingSalience: 0.9,
      now: NOW,
    });
    expect(v.encoding).toBeCloseTo(0.9, 9);
    expect(v.encoding).not.toBe(DEFAULT_TYPE_ENCODING_WEIGHTS.memory);
  });

  test("fallback to type-weight stub when encodingSalience is undefined (backward compat)", () => {
    const v = computeSalience({
      ref: "memories/foo",
      type: "memory",
      retrievalFreq: 0,
      now: NOW,
    });
    expect(v.encoding).toBe(DEFAULT_TYPE_ENCODING_WEIGHTS.memory!);
  });

  test("encodingSalience override propagates into rankScore (changes ranking)", () => {
    const withStub = computeSalience({
      ref: "memories/foo",
      type: "memory",
      retrievalFreq: 0,
      now: NOW,
    });
    const withOverride = computeSalience({
      ref: "memories/foo",
      type: "memory",
      retrievalFreq: 0,
      encodingSalience: 0.9,
      now: NOW,
    });
    // Higher encoding → higher rankScore
    expect(withOverride.rankScore).toBeGreaterThan(withStub.rankScore);
  });

  test("encodingSalience override is clamped to [0, 1]", () => {
    const vHigh = computeSalience({
      ref: "lessons/foo",
      type: "lesson",
      retrievalFreq: 0,
      encodingSalience: 1.5,
      now: NOW,
    });
    expect(vHigh.encoding).toBeLessThanOrEqual(1.0);

    const vLow = computeSalience({
      ref: "lessons/foo",
      type: "lesson",
      retrievalFreq: 0,
      encodingSalience: -0.1,
      now: NOW,
    });
    expect(vLow.encoding).toBeGreaterThanOrEqual(0.0);
  });
});
