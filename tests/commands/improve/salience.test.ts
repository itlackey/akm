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
  recordNoOp,
  resetConsecutiveNoOps,
  upsertAssetSalience,
  W_ENCODING,
  W_OUTCOME,
  W_RETRIEVAL,
} from "../../../src/commands/improve/salience";
import { openStateDatabase } from "../../../src/core/state-db";

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

describe("WS-1 weight contract", () => {
  test("W_ENCODING + W_OUTCOME + W_RETRIEVAL = 1.0", () => {
    expect(W_ENCODING + W_OUTCOME + W_RETRIEVAL).toBeCloseTo(1.0, 9);
  });

  test("W_OUTCOME = 0 until WS-2 lands", () => {
    expect(W_OUTCOME).toBe(0);
  });
});

// ── computeSalience — encoding sub-score ──────────────────────────────────────

describe("computeSalience — encoding sub-score", () => {
  test("skill type gets the highest encoding weight", () => {
    const v = computeSalience({ ref: "skill:foo", type: "skill", retrievalFreq: 0, now: NOW });
    expect(v.encoding).toBe(DEFAULT_TYPE_ENCODING_WEIGHTS.skill);
    expect(v.encoding).toBeGreaterThanOrEqual(0.9);
  });

  test("memory type gets the lowest encoding weight", () => {
    const v = computeSalience({ ref: "memory:foo", type: "memory", retrievalFreq: 0, now: NOW });
    expect(v.encoding).toBe(DEFAULT_TYPE_ENCODING_WEIGHTS.memory);
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

// ── computeSalience — outcome sub-score ───────────────────────────────────────

describe("computeSalience — outcome sub-score (WS-2-HOOK)", () => {
  test("outcome is always 0 in WS-1 (W_OUTCOME=0, hook not yet wired)", () => {
    const v = computeSalience({ ref: "skill:foo", type: "skill", retrievalFreq: 100, utilityScore: 0.9, now: NOW });
    expect(v.outcome).toBe(0);
  });
});

// ── computeSalience — retrieval sub-score ─────────────────────────────────────

describe("computeSalience — retrieval sub-score", () => {
  test("zero retrievals => retrieval = 0", () => {
    const v = computeSalience({ ref: "lesson:foo", type: "lesson", retrievalFreq: 0, now: NOW });
    expect(v.retrieval).toBe(0);
  });

  test("non-zero retrievals => retrieval > 0", () => {
    const v = computeSalience({ ref: "lesson:foo", type: "lesson", retrievalFreq: 10, now: NOW });
    expect(v.retrieval).toBeGreaterThan(0);
  });

  test("retrieval is bounded to [0,1]", () => {
    // Extremely high retrieval count — still normalized to < 1.
    const v = computeSalience({
      ref: "lesson:foo",
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
      ref: "lesson:foo",
      type: "lesson",
      retrievalFreq: 5,
      lastUseMs: NOW - 1 * DAY_MS,
      now: NOW,
    });
    const stale = computeSalience({
      ref: "lesson:foo",
      type: "lesson",
      retrievalFreq: 5,
      lastUseMs: NOW - 120 * DAY_MS,
      now: NOW,
    });
    expect(fresh.retrieval).toBeGreaterThan(stale.retrieval);
  });

  test("absent lastUseMs (never retrieved) gets floor recency (~0.1 decay)", () => {
    const noUse = computeSalience({
      ref: "lesson:foo",
      type: "lesson",
      retrievalFreq: 5,
      lastUseMs: undefined,
      now: NOW,
    });
    const recent = computeSalience({
      ref: "lesson:foo",
      type: "lesson",
      retrievalFreq: 5,
      lastUseMs: NOW,
      now: NOW,
    });
    // Never-used asset should score significantly lower than recently-used one.
    expect(noUse.retrieval).toBeLessThan(recent.retrieval);
  });
});

// ── computeSalience — rankScore ───────────────────────────────────────────────

describe("computeSalience — rankScore", () => {
  test("rankScore is in [0, 1]", () => {
    const cases = [
      { ref: "skill:a", type: "skill", retrievalFreq: 0 },
      { ref: "skill:b", type: "skill", retrievalFreq: 100, lastUseMs: NOW },
      { ref: "memory:c", type: "memory", retrievalFreq: 1 },
      { ref: "lesson:d", type: "lesson", retrievalFreq: 50, lastUseMs: NOW - 5 * DAY_MS, sizeBytes: 50_000 },
    ];
    for (const c of cases) {
      const v = computeSalience({ ...c, now: NOW });
      expect(v.rankScore).toBeGreaterThanOrEqual(0);
      expect(v.rankScore).toBeLessThanOrEqual(1);
    }
  });

  test("larger assets get lower rankScore than smaller ones (size penalty)", () => {
    const small = computeSalience({
      ref: "lesson:foo",
      type: "lesson",
      retrievalFreq: 10,
      lastUseMs: NOW,
      sizeBytes: 500,
      now: NOW,
    });
    const large = computeSalience({
      ref: "lesson:foo",
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
      ref: "skill:x",
      type: "skill",
      retrievalFreq: 5,
      lastUseMs: NOW,
      now: NOW,
    });
    const mem = computeSalience({
      ref: "memory:x",
      type: "memory",
      retrievalFreq: 5,
      lastUseMs: NOW,
      now: NOW,
    });
    expect(skill.rankScore).toBeGreaterThan(mem.rankScore);
  });

  test("zero retrieval => rankScore dominated by encoding only", () => {
    const v = computeSalience({
      ref: "knowledge:foo",
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
    const v = computeSalience({ ref: "memory:x", type: "memory", retrievalFreq: 0, sizeBytes: 200, now: NOW });
    expect(v.rankScore).toBeGreaterThan(0);
  });
});

// ── state.db persistence round-trip ───────────────────────────────────────────

describe("state.db persistence: upsertAssetSalience / getAssetSalience", () => {
  test("round-trip: upsert then get returns the same values", () => {
    const { db, tmpDir } = openTestStateDb();
    try {
      const vector = computeSalience({
        ref: "lesson:alpha",
        type: "lesson",
        retrievalFreq: 10,
        lastUseMs: NOW - 2 * DAY_MS,
        sizeBytes: 1000,
        now: NOW,
      });
      upsertAssetSalience(db, "lesson:alpha", vector, NOW);
      const row = getAssetSalience(db, "lesson:alpha");
      expect(row).toBeDefined();
      expect(row?.asset_ref).toBe("lesson:alpha");
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
      const row = getAssetSalience(db, "lesson:nonexistent");
      expect(row).toBeUndefined();
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("second upsert overwrites the first (idempotent ON CONFLICT DO UPDATE)", () => {
    const { db, tmpDir } = openTestStateDb();
    try {
      const v1 = computeSalience({ ref: "skill:a", type: "skill", retrievalFreq: 1, now: NOW });
      const v2 = computeSalience({ ref: "skill:a", type: "skill", retrievalFreq: 50, lastUseMs: NOW, now: NOW });
      upsertAssetSalience(db, "skill:a", v1, NOW - DAY_MS);
      upsertAssetSalience(db, "skill:a", v2, NOW);
      const row = getAssetSalience(db, "skill:a");
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
      const vector = computeSalience({ ref: "lesson:beta", type: "lesson", retrievalFreq: 0, now: NOW });
      // Manually insert with a known consecutive_no_ops.
      recordNoOp(db, "lesson:beta");
      recordNoOp(db, "lesson:beta");
      // Now upsert — should NOT reset consecutive_no_ops.
      upsertAssetSalience(db, "lesson:beta", vector, NOW);
      const row = getAssetSalience(db, "lesson:beta");
      expect(row?.consecutive_no_ops).toBe(2);
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
      expect(getConsecutiveNoOps(db, "lesson:unknown")).toBe(0);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("recordNoOp increments consecutive_no_ops", () => {
    const { db, tmpDir } = openTestStateDb();
    try {
      expect(getConsecutiveNoOps(db, "skill:x")).toBe(0);
      recordNoOp(db, "skill:x");
      expect(getConsecutiveNoOps(db, "skill:x")).toBe(1);
      recordNoOp(db, "skill:x");
      recordNoOp(db, "skill:x");
      expect(getConsecutiveNoOps(db, "skill:x")).toBe(3);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("resetConsecutiveNoOps resets to 0", () => {
    const { db, tmpDir } = openTestStateDb();
    try {
      recordNoOp(db, "skill:x");
      recordNoOp(db, "skill:x");
      expect(getConsecutiveNoOps(db, "skill:x")).toBe(2);
      resetConsecutiveNoOps(db, "skill:x");
      expect(getConsecutiveNoOps(db, "skill:x")).toBe(0);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("recordNoOp does NOT change rank_score (plasticity is separate from ranking)", () => {
    const { db, tmpDir } = openTestStateDb();
    try {
      const vector = computeSalience({ ref: "skill:y", type: "skill", retrievalFreq: 10, now: NOW });
      upsertAssetSalience(db, "skill:y", vector, NOW);
      const rowBefore = getAssetSalience(db, "skill:y");
      expect(rowBefore).toBeDefined();
      const before = rowBefore?.rank_score ?? 0;

      recordNoOp(db, "skill:y");
      recordNoOp(db, "skill:y");

      // rank_score unchanged (consecutive_no_ops only affects consolidation selection).
      const rowAfter = getAssetSalience(db, "skill:y");
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
      ["skill:a", 1],
      ["skill:b", 100],
      ["skill:c", 200],
    ]);
    const newRanks = new Map([
      ["skill:a", 1],
      ["skill:b", 150],
      ["skill:c", 499],
    ]);
    const report = buildRankChangeReport(oldRanks, newRanks);
    expect(report.forgettingCandidates).toHaveLength(0);
    expect(report.allChanges).toHaveLength(3);
  });

  test("detects old top-200 refs that fall below position 500", () => {
    const oldRanks = new Map([
      ["skill:winner", 1],
      ["lesson:loser", 50],
      ["memory:neutral", 150],
    ]);
    const newRanks = new Map([
      ["skill:winner", 1],
      ["lesson:loser", 600], // fell past 500 — forgetting candidate
      ["memory:neutral", 400],
    ]);
    const report = buildRankChangeReport(oldRanks, newRanks);
    expect(report.forgettingCandidates).toHaveLength(1);
    expect(report.forgettingCandidates[0]?.ref).toBe("lesson:loser");
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
    const oldRanks = new Map([["lesson:just-outside", 201]]);
    const newRanks = new Map([["lesson:just-outside", 999]]);
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
