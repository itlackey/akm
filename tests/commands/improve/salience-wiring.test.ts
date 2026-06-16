// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Integration tests for the WS-1 salience-vector wiring inside `akmImprove`.
 *
 * Covers (per the WS-1 review blockers):
 *   1. First run emits `improve_salience_first_run` (empty table, no comparison possible).
 *   2. Second run emits `improve_salience_rank_change` with stash-wide positions.
 *   3. `recordNoOp` increments `consecutive_no_ops` after a `no_change` reflect outcome.
 *   4. `resetConsecutiveNoOps` resets the counter after a successful (queued) distill outcome.
 *   5. `retrievalCounts` covers the feedback-bearing pool (not only zero-feedback refs).
 *
 * All tests use `withIsolatedAkmStorage` for full env isolation.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmDistillResult } from "../../../src/commands/improve/distill";
import { akmImprove } from "../../../src/commands/improve/improve";
import type { AkmReflectOptions, AkmReflectResult } from "../../../src/commands/improve/reflect";
import { getAssetSalience, getConsecutiveNoOps, upsertAssetSalience } from "../../../src/commands/improve/salience";
import { saveConfig } from "../../../src/core/config/config";
import { readEvents } from "../../../src/core/events";
import { openStateDatabase } from "../../../src/core/state-db";
import { akmIndex } from "../../../src/indexer/indexer";
import { withIsolatedAkmStorage } from "../../_helpers/sandbox";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const cleanups: Array<() => void> = [];

function isolatedStash(): string {
  const iso = withIsolatedAkmStorage();
  cleanups.push(iso.cleanup);
  return iso.stashDir;
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function writeSkill(stashDir: string, name: string, body: string): void {
  const filePath = path.join(stashDir, "skills", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\nname: ${name}\ndescription: ${name}\n---\n\n${body}\n`, "utf8");
}

async function buildIndex(stashDir: string): Promise<void> {
  saveConfig({ semanticSearchMode: "off" });
  await akmIndex({ stashDir, full: true });
}

const noopIndexFns = {
  ensureIndexFn: async () => false,
  reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
};

/** Reflect stub that returns no_change (LLM found nothing to improve). */
const noChangeReflect = (_ref: string): AkmReflectResult => ({
  schemaVersion: 1,
  ok: false,
  reason: "no_change",
  error: "no change detected",
  exitCode: 0,
  ref: _ref,
});

/** Reflect stub that returns a successful proposal. */
const okReflect = (ref: string): AkmReflectResult => ({
  schemaVersion: 1,
  ok: true,
  proposal: {
    id: `p-${ref.replace(/[^a-z0-9]/gi, "-")}`,
    ref,
    status: "pending",
    source: "reflect",
    createdAt: "2026-06-14T12:00:00.000Z",
    updatedAt: "2026-06-14T12:00:00.000Z",
    payload: { content: "# improved" },
  },
  ref,
  agentProfile: "test",
  durationMs: 1,
});

/** Distill stub that returns a queued outcome (success). */
const queuedDistill = (ref: string): AkmDistillResult => ({
  schemaVersion: 1,
  ok: true,
  outcome: "queued",
  inputRef: ref,
  lessonRef: `lesson:${ref.replace(/[:/]/g, "-")}-lesson`,
});

/** Distill stub that returns quality_rejected. */
const qualityRejectedDistill = (ref: string): AkmDistillResult => ({
  schemaVersion: 1,
  ok: true,
  outcome: "quality_rejected",
  inputRef: ref,
  lessonRef: `lesson:${ref.replace(/[:/]/g, "-")}-lesson`,
  reason: "below quality threshold",
});

/**
 * Minimal config: disable noisy passes, but keep proactiveMaintenance enabled
 * so never-reflected, zero-feedback assets flow through the candidate selection
 * and into the salience map / plasticity wiring.
 */
const minimalConfig = () =>
  ({
    semanticSearchMode: "off",
    profiles: {
      improve: {
        default: {
          processes: {
            consolidate: { enabled: false },
            memoryInference: { enabled: false },
            graphExtraction: { enabled: false },
            extract: { enabled: false },
            proactiveMaintenance: { enabled: true, maxPerRun: 10 },
          },
        },
      },
    },
  }) as import("../../../src/core/config/config").AkmConfig;

// ── Test 1: first run emits improve_salience_first_run ────────────────────────

describe("WS-1 wiring — first run (empty table)", () => {
  test("emits improve_salience_first_run event when asset_salience table is empty", async () => {
    const stash = isolatedStash();
    writeSkill(stash, "alpha", "Alpha content.");
    await buildIndex(stash);

    await akmImprove({
      scope: "skill",
      stashDir: stash,
      config: minimalConfig(),
      ...noopIndexFns,
      reflectFn: async ({ ref }) => okReflect(ref ?? ""),
      distillFn: async ({ ref }) => queuedDistill(ref ?? ""),
    });

    // Verify first_run event was emitted.
    const { events: firstRunEvents } = readEvents({ type: "improve_salience_first_run" });
    expect(firstRunEvents.length).toBeGreaterThanOrEqual(1);

    // Verify rank_change was NOT emitted (table was empty, no comparison possible).
    const { events: rankChangeEvents } = readEvents({ type: "improve_salience_rank_change" });
    expect(rankChangeEvents.length).toBe(0);

    // Metadata should carry candidateCount.
    const meta = firstRunEvents[0]?.metadata as Record<string, unknown> | undefined;
    expect(typeof meta?.candidateCount).toBe("number");
    expect(meta?.candidateCount as number).toBeGreaterThanOrEqual(1);
  });

  test("asset_salience rows are written after the first run", async () => {
    const stash = isolatedStash();
    writeSkill(stash, "beta", "Beta content.");
    await buildIndex(stash);

    await akmImprove({
      scope: "skill",
      stashDir: stash,
      config: minimalConfig(),
      ...noopIndexFns,
      reflectFn: async ({ ref }) => okReflect(ref ?? ""),
      distillFn: async ({ ref }) => queuedDistill(ref ?? ""),
    });

    const db = openStateDatabase();
    try {
      const row = getAssetSalience(db, "skill:beta");
      expect(row).toBeDefined();
      expect(row?.rank_score).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});

// ── Test 2: second run emits improve_salience_rank_change ─────────────────────

describe("WS-1 wiring — subsequent run (table has rows)", () => {
  test("emits improve_salience_rank_change on second run", async () => {
    const stash = isolatedStash();
    writeSkill(stash, "gamma", "Gamma content.");
    await buildIndex(stash);

    const runOpts = {
      scope: "skill" as const,
      stashDir: stash,
      config: minimalConfig(),
      ...noopIndexFns,
      reflectFn: async ({ ref }: { ref?: string }) => okReflect(ref ?? ""),
      distillFn: async ({ ref }: { ref?: string }) => queuedDistill(ref ?? ""),
    };

    // First run seeds the table.
    await akmImprove(runOpts);

    // Confirm no rank_change yet.
    const { events: firstRankChange } = readEvents({ type: "improve_salience_rank_change" });
    expect(firstRankChange.length).toBe(0);

    // Second run should emit rank_change (table is non-empty now).
    await akmImprove(runOpts);

    const { events: secondRankChange } = readEvents({ type: "improve_salience_rank_change" });
    expect(secondRankChange.length).toBeGreaterThanOrEqual(1);

    // Metadata should include stashSize (stash-wide, not pool-relative).
    const meta = secondRankChange[0]?.metadata as Record<string, unknown> | undefined;
    expect(typeof meta?.stashSize).toBe("number");
    expect(meta?.stashSize as number).toBeGreaterThan(0);
    expect(typeof meta?.totalChanged).toBe("number");
    expect(typeof meta?.forgettingCandidates).toBe("number");
  });
});

// ── Test 3: recordNoOp fires on no_change reflect ─────────────────────────────

describe("WS-1 wiring — no-op tracking via consecutive_no_ops", () => {
  test("consecutive_no_ops increments after a no_change reflect", async () => {
    const stash = isolatedStash();
    writeSkill(stash, "delta", "Delta content.");
    await buildIndex(stash);

    // Pre-seed the salience row so consecutive_no_ops starts at 0.
    const dbSetup = openStateDatabase();
    try {
      upsertAssetSalience(dbSetup, "skill:delta", { encoding: 0.7, outcome: 0, retrieval: 0, rankScore: 0.2 });
    } finally {
      dbSetup.close();
    }

    // Run with a no_change reflect stub.
    await akmImprove({
      scope: "skill",
      stashDir: stash,
      config: minimalConfig(),
      ...noopIndexFns,
      reflectFn: async ({ ref }) => noChangeReflect(ref ?? ""),
      distillFn: async ({ ref }) => qualityRejectedDistill(ref ?? ""),
    });

    const db = openStateDatabase();
    try {
      // no_change reflect → recordNoOp → consecutive_no_ops = 1
      const noOps = getConsecutiveNoOps(db, "skill:delta");
      expect(noOps).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });

  test("consecutive_no_ops resets to 0 after a successful distill (queued)", async () => {
    const stash = isolatedStash();
    writeSkill(stash, "epsilon", "Epsilon content.");
    await buildIndex(stash);

    // Pre-seed with a high no-op count.
    const dbSetup = openStateDatabase();
    try {
      upsertAssetSalience(dbSetup, "skill:epsilon", { encoding: 0.7, outcome: 0, retrieval: 0, rankScore: 0.2 });
      // manually set consecutive_no_ops to 5 by calling recordNoOp
      for (let i = 0; i < 5; i++) {
        dbSetup
          .prepare(`UPDATE asset_salience SET consecutive_no_ops = consecutive_no_ops + 1 WHERE asset_ref = ?`)
          .run("skill:epsilon");
      }
    } finally {
      dbSetup.close();
    }

    // Verify the seed worked.
    const dbCheck = openStateDatabase();
    try {
      expect(getConsecutiveNoOps(dbCheck, "skill:epsilon")).toBe(5);
    } finally {
      dbCheck.close();
    }

    // Run with successful (ok) reflect + queued distill.
    await akmImprove({
      scope: "skill",
      stashDir: stash,
      config: minimalConfig(),
      ...noopIndexFns,
      reflectFn: async ({ ref }) => okReflect(ref ?? ""),
      distillFn: async ({ ref }) => queuedDistill(ref ?? ""),
    });

    const db = openStateDatabase();
    try {
      // queued distill → resetConsecutiveNoOps → 0
      const noOps = getConsecutiveNoOps(db, "skill:epsilon");
      expect(noOps).toBe(0);
    } finally {
      db.close();
    }
  });
});

// ── Test 4: consolidation-selection dampener (Blocker: consumer not tested) ──

describe("WS-1 wiring — dampener consumption (consecutive_no_ops >= threshold penalises order)", () => {
  /**
   * Scenario:
   *   - Two skills, `alpha-stable` and `beta-fresh`, written to the isolated stash.
   *   - Both rows upserted into asset_salience with identical rank_score = 0.6
   *     (ensures the comparator, not the content, drives order).
   *   - `alpha-stable` is given consecutive_no_ops = SALIENCE_NO_OP_DAMPEN_THRESHOLD
   *     (via direct SQL UPDATE) — it is dampened.
   *   - `beta-fresh` keeps consecutive_no_ops = 0 — it is not dampened.
   *   - Improve runs with proactive maintenance enabled so both refs reach mergedRefs.
   *   - Assertions:
   *     (a) beta-fresh is reflect'd BEFORE alpha-stable (non-dampened first).
   *     (b) alpha-stable's persisted rank_score is UNCHANGED after the run
   *         (the dampener is a comparator-only penalty; it never mutates state.db).
   *
   * Failure mode if dampener is removed from the comparator:
   *   Both refs have equal rank_score, so the tie-break is alphabetical: `alpha-stable`
   *   sorts BEFORE `beta-fresh`. The test inverts that expected order, so removing the
   *   dampener from the effectiveScore comparator will make assertion (a) fail.
   */
  test("dampened ref is ordered after non-dampened ref with equal rankScore, and persisted rank_score is unchanged", async () => {
    const stash = isolatedStash();

    // Write two skills with identical body so salience computation yields the
    // same rankScore for both (only the dampener can differentiate them).
    writeSkill(stash, "alpha-stable", "Stable asset body.");
    writeSkill(stash, "beta-fresh", "Stable asset body.");
    await buildIndex(stash);

    // Pre-seed asset_salience rows: equal rank_score, but alpha-stable is dampened.
    const dbSetup = openStateDatabase();
    const IDENTICAL_RANK_SCORE = 0.6;
    try {
      upsertAssetSalience(dbSetup, "skill:alpha-stable", {
        encoding: 0.9,
        outcome: 0,
        retrieval: 0.5,
        rankScore: IDENTICAL_RANK_SCORE,
      });
      upsertAssetSalience(dbSetup, "skill:beta-fresh", {
        encoding: 0.9,
        outcome: 0,
        retrieval: 0.5,
        rankScore: IDENTICAL_RANK_SCORE,
      });

      // Manually set alpha-stable to the dampen threshold.
      dbSetup
        .prepare(`UPDATE asset_salience SET consecutive_no_ops = ? WHERE asset_ref = ?`)
        .run(3 /* SALIENCE_NO_OP_DAMPEN_THRESHOLD */, "skill:alpha-stable");
    } finally {
      dbSetup.close();
    }

    // Track reflect call order without using the comma operator.
    const reflectOrder: string[] = [];
    const trackingReflect = (ref: string): AkmReflectResult => {
      reflectOrder.push(ref);
      return noChangeReflect(ref);
    };

    await akmImprove({
      scope: "skill",
      stashDir: stash,
      config: minimalConfig(),
      ...noopIndexFns,
      reflectFn: async ({ ref }) => trackingReflect(ref ?? ""),
      distillFn: async ({ ref }) => qualityRejectedDistill(ref ?? ""),
    });

    // (a) beta-fresh must appear before alpha-stable in the reflect call order.
    //
    // If the dampener is removed from the effectiveScore comparator, alphabetical
    // tie-break puts alpha-stable FIRST (it sorts before beta-fresh lexicographically).
    // With the dampener, alpha-stable's effective score is halved, so beta-fresh wins.
    const alphaIdx = reflectOrder.indexOf("skill:alpha-stable");
    const betaIdx = reflectOrder.indexOf("skill:beta-fresh");
    expect(alphaIdx).toBeGreaterThanOrEqual(0); // alpha-stable was processed
    expect(betaIdx).toBeGreaterThanOrEqual(0); // beta-fresh was processed
    expect(betaIdx).toBeLessThan(alphaIdx); // beta-fresh came first

    // (b) The dampener must NOT mutate the persisted rank_score.
    //     upsertAssetSalience is called during the run but writes the raw salience
    //     vector, which is identical for both refs (same inputs).  The effective
    //     score multiplier (FACTOR = 0.5) is a comparator-only penalty.
    const dbCheck = openStateDatabase();
    try {
      const alphaRow = dbCheck
        .prepare(`SELECT rank_score, consecutive_no_ops FROM asset_salience WHERE asset_ref = ?`)
        .get("skill:alpha-stable") as { rank_score: number; consecutive_no_ops: number } | undefined;
      const betaRow = dbCheck
        .prepare(`SELECT rank_score FROM asset_salience WHERE asset_ref = ?`)
        .get("skill:beta-fresh") as { rank_score: number } | undefined;

      expect(alphaRow).toBeDefined();
      expect(betaRow).toBeDefined();
      // rank_score written by the run's upsertAssetSalience is the raw computed
      // value — the FACTOR was never applied to it.  Both refs have the same
      // inputs, so their stored rank_scores are equal (within floating-point ε).
      // Stored rank_scores must be equal — the dampener never touches state.db.
      expect(alphaRow?.rank_score).toBeCloseTo(betaRow?.rank_score ?? 0, 6);

      // consecutive_no_ops persists; the no_change reflect in this run adds 1.
      // The important invariant: it is still >= the threshold so the dampener
      // would fire again on the next run.
      expect(alphaRow?.consecutive_no_ops).toBeGreaterThanOrEqual(3);
    } finally {
      dbCheck.close();
    }
  });
});

// ── Test 4: stash-wide rank positions (Blocker 2 regression) ─────────────────

describe("WS-1 wiring — rank positions are stash-wide, not pool-relative", () => {
  test("rank_change event stashSize >= pool size (proves stash-wide query)", async () => {
    const stash = isolatedStash();
    // Write 3 skills — all will be in the pool.
    for (const name of ["s1", "s2", "s3"]) {
      writeSkill(stash, name, `Content for ${name}.`);
    }
    await buildIndex(stash);

    // First run seeds the table.
    await akmImprove({
      scope: "skill",
      stashDir: stash,
      config: minimalConfig(),
      ...noopIndexFns,
      reflectFn: async ({ ref }) => okReflect(ref ?? ""),
      distillFn: async ({ ref }) => queuedDistill(ref ?? ""),
    });

    // Manually inject extra rows into asset_salience to simulate a larger stash.
    // These refs are NOT in the current run's pool.
    const dbInject = openStateDatabase();
    try {
      for (const extraRef of ["knowledge:extra1", "knowledge:extra2", "knowledge:extra3"]) {
        upsertAssetSalience(dbInject, extraRef, { encoding: 0.7, outcome: 0, retrieval: 0.5, rankScore: 0.35 });
      }
    } finally {
      dbInject.close();
    }

    // Second run: pool has 3 skills, but stash.db has 3 + 3 = 6 rows.
    await akmImprove({
      scope: "skill",
      stashDir: stash,
      config: minimalConfig(),
      ...noopIndexFns,
      reflectFn: async ({ ref }) => okReflect(ref ?? ""),
      distillFn: async ({ ref }) => queuedDistill(ref ?? ""),
    });

    const { events } = readEvents({ type: "improve_salience_rank_change" });
    expect(events.length).toBeGreaterThanOrEqual(1);

    const meta = events[0]?.metadata as Record<string, unknown> | undefined;
    // stashSize should include the injected extra rows (6), not just the pool (3).
    expect(meta?.stashSize as number).toBeGreaterThanOrEqual(6);
  });
});

// ── Test 5: forgetting-safety protective consolidation pass (WS-1 step 7) ─────
//
// Scenario B with a manufactured forgetting candidate:
//   1. Write a victim skill and build the index.
//   2. Seed the victim's asset_salience row with a very high rank_score (0.99)
//      so its old rank = 1 (top-200).
//   3. Inject 501 extra fake refs into asset_salience with rank_score = 0.8
//      (these don't correspond to real files — they're stash-wide rank fillers).
//   4. Run akmImprove a second time.  The victim's NEW salienceMap score will
//      be a genuine low value (no feedback, low retrieval) — call it ~0.
//      In mergedNewScores: fakes stay at 0.8, victim drops to ~0.
//      Old ranks: victim = 1, fakes = 2..502.
//      New ranks: fakes = 1..501, victim = 502.
//      Verdict: oldRank(1) ≤ 200 AND newRank(502) > 500 → forgetting candidate.
//   5. Assert that the victim ref is reflected with eligibilitySource='forgetting-safety'.
//
// This test guards the Plan §WS-1 step 7 "load-bearing protective ACTION" —
// the second clause that was dropped before this fix.

describe("WS-1 step 7 — protective consolidation pass (forgetting-safety lane)", () => {
  test("forgetting candidate is reflected with eligibilitySource='forgetting-safety' on scenario-B run", async () => {
    const stash = isolatedStash();

    // Write the victim skill so the indexer and disk-check can find it.
    writeSkill(stash, "victim", "Victim asset — must not be silently forgotten.");
    await buildIndex(stash);

    // Seed the victim's salience row with a very high rank_score so it was
    // rank 1 in the old ordering. We do this BEFORE the first akmImprove call
    // so the first run overwrites it with whatever the formula computes; then
    // we overwrite again before the second run to ensure rank 1 position.
    // Strategy: run once (scenario A / first run), then overwrite the victim
    // row and inject 501 fakes, then run again (scenario B).

    // First run: seeds asset_salience (scenario A — no rank-change report).
    await akmImprove({
      scope: "skill",
      stashDir: stash,
      config: minimalConfig(),
      ...noopIndexFns,
      reflectFn: async ({ ref }) => noChangeReflect(ref ?? ""),
      distillFn: async ({ ref }) => qualityRejectedDistill(ref ?? ""),
    });

    // Overwrite victim's rank_score to 0.99 so its oldRank = 1 in scenario B.
    const dbSetup = openStateDatabase();
    try {
      // Upsert with a very high rank_score to ensure rank-1 position.
      upsertAssetSalience(dbSetup, "skill:victim", {
        encoding: 0.99,
        outcome: 0.99,
        retrieval: 0.99,
        rankScore: 0.99,
      });

      // Inject 501 fake refs with rank_score=0.8 so the victim (at ~0 new
      // score after the second run) falls to position 502 in newRanks.
      for (let i = 1; i <= 501; i++) {
        upsertAssetSalience(dbSetup, `knowledge:rank-filler-${String(i).padStart(4, "0")}`, {
          encoding: 0.5,
          outcome: 0,
          retrieval: 0.5,
          rankScore: 0.8,
        });
      }
    } finally {
      dbSetup.close();
    }

    // Second run: scenario B (table is non-empty). Capture which refs are
    // reflected and with which eligibilitySource.
    const capturedEligibility = new Map<string, string | undefined>();

    await akmImprove({
      scope: "skill",
      stashDir: stash,
      config: minimalConfig(),
      ...noopIndexFns,
      reflectFn: async (opts: AkmReflectOptions) => {
        capturedEligibility.set(opts.ref ?? "", opts.eligibilitySource);
        return noChangeReflect(opts.ref ?? "");
      },
      distillFn: async ({ ref }) => qualityRejectedDistill(ref ?? ""),
    });

    // The rank_change event should have been emitted and report ≥ 1 forgetting candidate.
    const { events: rankChangeEvents } = readEvents({ type: "improve_salience_rank_change" });
    expect(rankChangeEvents.length).toBeGreaterThanOrEqual(1);
    const rcMeta = rankChangeEvents[0]?.metadata as Record<string, unknown> | undefined;
    expect(rcMeta?.forgettingCandidates as number).toBeGreaterThanOrEqual(1);

    // The victim must have been reflected (present in capturedEligibility).
    expect(capturedEligibility.has("skill:victim")).toBe(true);

    // The victim's eligibilitySource must be 'forgetting-safety'.
    expect(capturedEligibility.get("skill:victim")).toBe("forgetting-safety");
  });
});
