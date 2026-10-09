// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Integration tests for the WS-1 salience-vector wiring inside `akmImprove`.
 *
 * Covers (per the WS-1 review blockers):
 *   1. First run (empty table) writes asset_salience rows; no comparison is possible.
 *   2. `recordNoOp` increments `consecutive_no_ops` after a `no_change` reflect outcome.
 *   3. `resetConsecutiveNoOps` resets the counter after a successful (queued) distill outcome.
 *   4. `retrievalCounts` covers the feedback-bearing pool (not only zero-feedback refs).
 *
 * All tests use `withIsolatedAkmStorage` for full env isolation.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { akmImprove } from "../../../../src/commands/improve/improve";
import { getAssetSalience, getConsecutiveNoOps, upsertAssetSalience } from "../../../../src/commands/improve/salience";
import { saveConfig } from "../../../../src/core/config/config";
import { appendEvent } from "../../../../src/core/events";
import type { AkmDistillResult, AkmReflectResult } from "../../../../src/core/improve-types";
import { openStateDatabase } from "../../../../src/core/state-db";
import { akmIndex } from "../../../../src/indexer/indexer";
import { writeSkill } from "../../../_helpers/assets";
import { withTestImproveLlm } from "../../../_helpers/improve-config";
import { withIsolatedAkmStorage } from "../../../_helpers/sandbox";

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

async function buildIndex(stashDir: string, bundle = "stash"): Promise<void> {
  saveConfig(
    withTestImproveLlm({
      semanticSearchMode: "off",
      bundles: { [bundle]: { path: stashDir, writable: true } },
      defaultBundle: bundle,
      defaultWriteTarget: bundle,
      index: { enrichment: { enabled: false } },
    }),
  );
  await akmIndex({ stashDir, full: true });
}

function durableRef(ref: string, bundle = "stash"): string {
  return `${bundle}//${ref}`;
}

/** Negative feedback on skills: the only signal that plans a reflect (and with it the plasticity counters). */
function complain(bundle: string, ...names: string[]): void {
  for (const name of names) {
    appendEvent({
      eventType: "feedback",
      ref: durableRef(`skills/${name}`, bundle),
      metadata: { signal: "negative", reason: "names a removed flag" },
    });
  }
}

const noopIndexFns = {
  ensureIndexFn: async () => false,
  reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
};

/** Reflect stub that returns no_change (LLM found nothing to improve). */
const noChangeReflect = (_ref: string): AkmReflectResult => ({
  schemaVersion: 2,
  ok: false,
  reason: "no_change",
  error: "no change detected",
  exitCode: 0,
  ref: _ref,
});

/** Reflect stub that returns a successful proposal. */
const okReflect = (ref: string): AkmReflectResult => ({
  schemaVersion: 2,
  ok: true,
  proposal: {
    id: `p-${ref.replace(/[^a-z0-9]/gi, "-")}`,
    ref,
    status: "pending",
    source: "reflect",
    createdAt: "2026-06-14T12:00:00.000Z",
    updatedAt: "2026-06-14T12:00:00.000Z",
    payload: { content: "# improved" },
    changes: [{ path: "lessons/proposal.md", after: "# improved", op: "update" }],
    proposedTarget: { source: "stash", root: "/tmp/stash" },
  },
  ref,
  engine: "test",
  durationMs: 1,
});

/** Distill stub that returns a queued outcome (success). */
const queuedDistill = (ref: string): AkmDistillResult => ({
  schemaVersion: 1,
  ok: true,
  outcome: "queued",
  inputRef: ref,
  proposalRef: `lessons/${ref.replaceAll("/", "-")}-lesson`,
});

/** Distill stub that returns quality_rejected. */
const qualityRejectedDistill = (ref: string): AkmDistillResult => ({
  schemaVersion: 1,
  ok: true,
  outcome: "quality_rejected",
  inputRef: ref,
  proposalRef: `lessons/${ref.replaceAll("/", "-")}-lesson`,
  reason: "below quality threshold",
});

/**
 * Minimal config: disable noisy passes, but keep proactiveMaintenance enabled
 * so never-reflected, zero-feedback assets are selected into the salience map.
 * The lane plans them with the feedback-bearing refs.
 */
const minimalConfig = () =>
  withTestImproveLlm({
    semanticSearchMode: "off",
    improve: {
      strategies: {
        default: {
          processes: {
            consolidate: { enabled: false },
            memoryInference: { enabled: false },
            extract: { enabled: false },
            proactiveMaintenance: { enabled: true, maxPerRun: 10 },
          },
        },
      },
    },
  } as import("../../../../src/core/config/config").AkmConfig);

/**
 * Declare the working stash as the primary `defaultBundle`. Tests that supply
 * their own config must identify the bundle whose indexed item refs and durable
 * improve state belong to the test stash.
 */
function withPrimaryStashBundle(
  config: import("../../../../src/core/config/config").AkmConfig,
  stash: string,
): import("../../../../src/core/config/config").AkmConfig {
  // A config that already declares its own bundles (e.g. a named-source scenario)
  // owns its primary; only synthesize the default "stash" primary otherwise.
  if (config.bundles) return config;
  return {
    ...config,
    bundles: { stash: { path: stash, writable: true } },
    defaultBundle: "stash",
  } as import("../../../../src/core/config/config").AkmConfig;
}

// ── Test 1: first run writes asset_salience rows ─────────────────────────────

describe("WS-1 wiring — first run (empty table)", () => {
  test("asset_salience rows are written after the first run", async () => {
    const stash = isolatedStash();
    writeSkill(stash, "beta", "Beta content.");
    await buildIndex(stash);

    await akmImprove({
      scope: "skill",
      stashDir: stash,
      config: withPrimaryStashBundle(minimalConfig(), stash),
      ...noopIndexFns,
      reflectFn: async ({ ref }) => okReflect(ref ?? ""),
      distillFn: async ({ ref }) => queuedDistill(ref ?? ""),
    });

    const db = openStateDatabase();
    try {
      const row = getAssetSalience(db, durableRef("skills/beta"));
      expect(row).toBeDefined();
      expect(row?.rank_score).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test("salience and plasticity counters are keyed by the selected source", async () => {
    const stash = isolatedStash();
    writeSkill(stash, "shared", "Shared source-local content.");
    await buildIndex(stash, "team");
    complain("team", "shared");
    const config = {
      ...minimalConfig(),
      bundles: { team: { path: stash, writable: true } },
      defaultBundle: "team",
      defaultWriteTarget: "team",
    };

    await akmImprove({
      target: "team",
      scope: "skill",
      config,
      ...noopIndexFns,
      reflectFn: async ({ ref }) => noChangeReflect(ref ?? ""),
      distillFn: async ({ ref }) => qualityRejectedDistill(ref ?? ""),
    });

    const db = openStateDatabase();
    try {
      expect(getAssetSalience(db, durableRef("skills/shared", "team"))).toBeDefined();
      expect(getAssetSalience(db, "skills/shared")).toBeUndefined();
      expect(getConsecutiveNoOps(db, durableRef("skills/shared", "team"))).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});

// ── Test 3: recordNoOp fires on no_change reflect ─────────────────────────────

describe("WS-1 wiring — no-op tracking via consecutive_no_ops", () => {
  test("consecutive_no_ops increments after a no_change reflect", async () => {
    const stash = isolatedStash();
    writeSkill(stash, "delta", "Delta content.");
    await buildIndex(stash);
    complain("stash", "delta");

    // Pre-seed the salience row so consecutive_no_ops starts at 0.
    const dbSetup = openStateDatabase();
    try {
      upsertAssetSalience(dbSetup, durableRef("skills/delta"), {
        encoding: 0.7,
        outcome: 0,
        retrieval: 0,
        rankScore: 0.2,
      });
    } finally {
      dbSetup.close();
    }

    // Run with a no_change reflect stub.
    await akmImprove({
      scope: "skill",
      stashDir: stash,
      config: withPrimaryStashBundle(minimalConfig(), stash),
      ...noopIndexFns,
      reflectFn: async ({ ref }) => noChangeReflect(ref ?? ""),
      distillFn: async ({ ref }) => qualityRejectedDistill(ref ?? ""),
    });

    const db = openStateDatabase();
    try {
      // no_change reflect → recordNoOp → consecutive_no_ops = 1
      const noOps = getConsecutiveNoOps(db, durableRef("skills/delta"));
      expect(noOps).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });

  test("consecutive_no_ops resets to 0 after a successful distill (queued)", async () => {
    const stash = isolatedStash();
    writeSkill(stash, "epsilon", "Epsilon content.");
    await buildIndex(stash);
    complain("stash", "epsilon");

    // Pre-seed with a high no-op count.
    const dbSetup = openStateDatabase();
    try {
      upsertAssetSalience(dbSetup, durableRef("skills/epsilon"), {
        encoding: 0.7,
        outcome: 0,
        retrieval: 0,
        rankScore: 0.2,
      });
      // manually set consecutive_no_ops to 5 by calling recordNoOp
      for (let i = 0; i < 5; i++) {
        dbSetup
          .prepare(`UPDATE asset_salience SET consecutive_no_ops = consecutive_no_ops + 1 WHERE asset_ref = ?`)
          .run(durableRef("skills/epsilon"));
      }
    } finally {
      dbSetup.close();
    }

    // Verify the seed worked.
    const dbCheck = openStateDatabase();
    try {
      expect(getConsecutiveNoOps(dbCheck, durableRef("skills/epsilon"))).toBe(5);
    } finally {
      dbCheck.close();
    }

    // Run with successful (ok) reflect + queued distill.
    await akmImprove({
      scope: "skill",
      stashDir: stash,
      config: withPrimaryStashBundle(minimalConfig(), stash),
      ...noopIndexFns,
      reflectFn: async ({ ref }) => okReflect(ref ?? ""),
      distillFn: async ({ ref }) => queuedDistill(ref ?? ""),
    });

    const db = openStateDatabase();
    try {
      // queued distill → resetConsecutiveNoOps → 0
      const noOps = getConsecutiveNoOps(db, durableRef("skills/epsilon"));
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
   *   - Both refs carry negative feedback, so both are planned and ranked.
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
    complain("stash", "alpha-stable", "beta-fresh");

    // Pre-seed asset_salience rows: equal rank_score, but alpha-stable is dampened.
    const dbSetup = openStateDatabase();
    const IDENTICAL_RANK_SCORE = 0.6;
    try {
      upsertAssetSalience(dbSetup, durableRef("skills/alpha-stable"), {
        encoding: 0.9,
        outcome: 0,
        retrieval: 0.5,
        rankScore: IDENTICAL_RANK_SCORE,
      });
      upsertAssetSalience(dbSetup, durableRef("skills/beta-fresh"), {
        encoding: 0.9,
        outcome: 0,
        retrieval: 0.5,
        rankScore: IDENTICAL_RANK_SCORE,
      });

      // Manually set alpha-stable to the dampen threshold.
      dbSetup
        .prepare(`UPDATE asset_salience SET consecutive_no_ops = ? WHERE asset_ref = ?`)
        .run(3 /* SALIENCE_NO_OP_DAMPEN_THRESHOLD */, durableRef("skills/alpha-stable"));
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
      config: withPrimaryStashBundle(minimalConfig(), stash),
      ...noopIndexFns,
      reflectFn: async ({ ref }) => trackingReflect(ref ?? ""),
      distillFn: async ({ ref }) => qualityRejectedDistill(ref ?? ""),
    });

    // (a) beta-fresh must appear before alpha-stable in the reflect call order.
    //
    // If the dampener is removed from the effectiveScore comparator, alphabetical
    // tie-break puts alpha-stable FIRST (it sorts before beta-fresh lexicographically).
    // With the dampener, alpha-stable's effective score is halved, so beta-fresh wins.
    const alphaIdx = reflectOrder.indexOf("skills/alpha-stable");
    const betaIdx = reflectOrder.indexOf("skills/beta-fresh");
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
        .get(durableRef("skills/alpha-stable")) as { rank_score: number; consecutive_no_ops: number } | undefined;
      const betaRow = dbCheck
        .prepare(`SELECT rank_score FROM asset_salience WHERE asset_ref = ?`)
        .get(durableRef("skills/beta-fresh")) as { rank_score: number } | undefined;

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
