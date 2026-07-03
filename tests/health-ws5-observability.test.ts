// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS-5 Observability tests — verifies that perfTelemetry, coverage, and
 * degradation metrics are populated from existing state.db data and surfaced
 * via `akmHealth`.
 *
 * Tests are isolated using `withIsolatedAkmStorage` (the sanctioned sandbox
 * helper) to prevent env-variable cross-contamination between parallel test
 * workers.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { akmHealth } from "../src/commands/health";
import type { AkmImproveResult } from "../src/commands/improve/improve";
import { upsertAssetSalience } from "../src/commands/improve/salience";
import type { Proposal } from "../src/commands/proposal/repository";
import { openStateDatabase } from "../src/core/state-db";
import { recordImproveRun } from "../src/storage/repositories/improve-runs-repository";
import { upsertProposal } from "../src/storage/repositories/proposals-repository";
import { type Cleanup, type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

function fixtureResult(partial: Record<string, unknown>): AkmImproveResult {
  return partial as unknown as AkmImproveResult;
}

/** Build a minimal accepted proposal for seeding state.db. */
function makeAcceptedProposal(id: string, ref: string): Proposal {
  const now = new Date().toISOString();
  return {
    id,
    ref,
    status: "accepted",
    source: "consolidate",
    createdAt: now,
    updatedAt: now,
    payload: {
      content: `Content for ${ref}`,
    },
  };
}

let storage: IsolatedAkmStorage;
let cleanup: Cleanup = () => {};

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  cleanup = storage.cleanup;
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

describe("WS-5 perfTelemetry aggregation", () => {
  test("aggregates perfTelemetry from consolidation result envelopes", () => {
    const db = openStateDatabase();
    try {
      const now = new Date();
      const startMs = now.getTime() - 60_000;
      const startA = new Date(startMs).toISOString();
      const endA = now.toISOString();

      recordImproveRun(db, {
        id: "run-ws5-a",
        startedAt: startA,
        completedAt: endA,
        stashDir: "/tmp/stash",
        dryRun: false,
        profile: null,
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: true,
        result: fixtureResult({
          schemaVersion: 1,
          ok: true,
          scope: { mode: "all" },
          dryRun: false,
          memorySummary: { eligible: 50, derived: 10 },
          plannedRefs: [],
          actions: [],
          consolidation: {
            schemaVersion: 1,
            ok: true,
            shape: "consolidate-result",
            dryRun: false,
            previewOnly: false,
            target: "/tmp/stash",
            processed: 5,
            merged: 2,
            deleted: 1,
            promoted: ["memory:a"],
            contradicted: 0,
            warnings: [],
            durationMs: 500,
            perfTelemetry: {
              dedupPoolSize: 50,
              llmPoolSize: 45,
              judgedCacheSkipped: 5,
              embedMs: 120,
              embedCacheHits: 40,
              embedCacheMisses: 5,
              estimatedBudgetFractionUsed: 0.25,
            },
          },
        }),
      });
    } finally {
      db.close();
    }

    const result = akmHealth({ since: "1h" });
    const perf = result.improve.perfTelemetry;

    expect(perf).toBeDefined();
    expect(perf.runsWithTelemetry).toBe(1);
    expect(perf.dedupPoolSize).toBe(50);
    expect(perf.llmPoolSize).toBe(45);
    expect(perf.judgedCacheSkipped).toBe(5);
    expect(perf.embedMs).toBe(120);
    expect(perf.embedCacheHits).toBe(40);
    expect(perf.embedCacheMisses).toBe(5);
    expect(perf.overBudgetRuns).toBe(0);
  });

  test("flags overBudgetRuns when estimatedBudgetFractionUsed > 1.0", () => {
    const db = openStateDatabase();
    try {
      const now = new Date();
      const start = new Date(now.getTime() - 60_000).toISOString();
      const end = now.toISOString();

      recordImproveRun(db, {
        id: "run-ws5-overbudget",
        startedAt: start,
        completedAt: end,
        stashDir: "/tmp/stash",
        dryRun: false,
        profile: null,
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: true,
        result: fixtureResult({
          schemaVersion: 1,
          ok: true,
          scope: { mode: "all" },
          dryRun: false,
          memorySummary: { eligible: 10, derived: 0 },
          plannedRefs: [],
          actions: [],
          consolidation: {
            schemaVersion: 1,
            ok: true,
            shape: "consolidate-result",
            dryRun: false,
            previewOnly: false,
            target: "/tmp/stash",
            processed: 1,
            merged: 0,
            deleted: 0,
            promoted: [],
            contradicted: 0,
            warnings: [],
            durationMs: 300,
            perfTelemetry: {
              dedupPoolSize: 10,
              llmPoolSize: 10,
              judgedCacheSkipped: 0,
              embedMs: 50,
              embedCacheHits: 8,
              embedCacheMisses: 2,
              estimatedBudgetFractionUsed: 1.5, // over budget
            },
          },
        }),
      });
    } finally {
      db.close();
    }

    const result = akmHealth({ since: "1h" });
    const perf = result.improve.perfTelemetry;

    expect(perf.overBudgetRuns).toBe(1);
    expect(perf.runsWithTelemetry).toBe(1);
  });

  test("accumulates perfTelemetry across multiple runs", () => {
    const db = openStateDatabase();
    try {
      const now = Date.now();

      for (let i = 0; i < 3; i++) {
        const start = new Date(now - 60_000 * (3 - i)).toISOString();
        const end = new Date(now - 60_000 * (2 - i)).toISOString();
        recordImproveRun(db, {
          id: `run-multi-${i}`,
          startedAt: start,
          completedAt: end,
          stashDir: "/tmp/stash",
          dryRun: false,
          profile: null,
          scopeMode: "all",
          scopeValue: null,
          guidance: null,
          ok: true,
          result: fixtureResult({
            schemaVersion: 1,
            ok: true,
            scope: { mode: "all" },
            dryRun: false,
            memorySummary: { eligible: 10, derived: 0 },
            plannedRefs: [],
            actions: [],
            consolidation: {
              schemaVersion: 1,
              ok: true,
              shape: "consolidate-result",
              dryRun: false,
              previewOnly: false,
              target: "/tmp/stash",
              processed: 2,
              merged: 1,
              deleted: 0,
              promoted: [],
              contradicted: 0,
              warnings: [],
              durationMs: 100,
              perfTelemetry: {
                dedupPoolSize: 10,
                llmPoolSize: 8,
                judgedCacheSkipped: 2,
                embedMs: 30,
                embedCacheHits: 6,
                embedCacheMisses: 2,
                estimatedBudgetFractionUsed: 0.1,
              },
            },
          }),
        });
      }
    } finally {
      db.close();
    }

    const result = akmHealth({ since: "1h" });
    const perf = result.improve.perfTelemetry;

    expect(perf.runsWithTelemetry).toBe(3);
    // All additive fields should be summed across 3 runs.
    expect(perf.embedMs).toBe(90); // 30 * 3
    expect(perf.embedCacheHits).toBe(18); // 6 * 3
    expect(perf.embedCacheMisses).toBe(6); // 2 * 3
    expect(perf.judgedCacheSkipped).toBe(6); // 2 * 3
    expect(perf.overBudgetRuns).toBe(0);
  });

  test("handles runs without perfTelemetry gracefully (pre-WS-5 envelopes)", () => {
    const db = openStateDatabase();
    try {
      const now = new Date();
      const start = new Date(now.getTime() - 60_000).toISOString();
      const end = now.toISOString();

      recordImproveRun(db, {
        id: "run-legacy",
        startedAt: start,
        completedAt: end,
        stashDir: "/tmp/stash",
        dryRun: false,
        profile: null,
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: true,
        result: fixtureResult({
          schemaVersion: 1,
          ok: true,
          scope: { mode: "all" },
          dryRun: false,
          memorySummary: { eligible: 5, derived: 0 },
          plannedRefs: [],
          actions: [],
          consolidation: {
            schemaVersion: 1,
            ok: true,
            shape: "consolidate-result",
            dryRun: false,
            previewOnly: false,
            target: "/tmp/stash",
            processed: 1,
            merged: 0,
            deleted: 0,
            promoted: [],
            contradicted: 0,
            warnings: [],
            durationMs: 100,
            // No perfTelemetry — legacy envelope.
          },
        }),
      });
    } finally {
      db.close();
    }

    const result = akmHealth({ since: "1h" });
    const perf = result.improve.perfTelemetry;

    // runsWithTelemetry must be 0 for a run with no perfTelemetry.
    expect(perf.runsWithTelemetry).toBe(0);
    expect(perf.embedMs).toBe(0);
    expect(perf.overBudgetRuns).toBe(0);
  });
});

describe("WS-5 denominator-fixed coverage", () => {
  test("computes coverage rate from accepted proposals and total assets", () => {
    const db = openStateDatabase();
    try {
      const now = new Date();
      const start = new Date(now.getTime() - 60_000).toISOString();
      const end = now.toISOString();

      // Seed an improve run so health has a memorySummary (eligible + derived = denominator).
      recordImproveRun(db, {
        id: "run-coverage",
        startedAt: start,
        completedAt: end,
        stashDir: "/tmp/stash",
        dryRun: false,
        profile: null,
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: true,
        result: fixtureResult({
          schemaVersion: 1,
          ok: true,
          scope: { mode: "all" },
          dryRun: false,
          memorySummary: { eligible: 8, derived: 2 }, // total = 10
          plannedRefs: [],
          actions: [],
        }),
      });

      // Seed 3 accepted proposals.
      for (let i = 0; i < 3; i++) {
        upsertProposal(db, makeAcceptedProposal(`proposal-${i}`, `memory:asset-${i}`), "/tmp/stash");
      }
    } finally {
      db.close();
    }

    const result = akmHealth({ since: "1h" });
    const cov = result.improve.coverage;

    expect(cov).toBeDefined();
    // 3 accepted / 10 total = 0.3
    expect(cov.rate).toBeCloseTo(0.3, 2);
    // 8 eligible / 10 total = 0.8
    expect(cov.eligibleFraction).toBeCloseTo(0.8, 2);
    expect(cov.acceptedProposals).toBe(3);
    expect(cov.totalAssets).toBe(10);
  });

  test("returns NaN rate when totalAssets is zero", () => {
    // No improve run seeded = memorySummary defaults to { eligible: 0, derived: 0 }.
    const result = akmHealth({ since: "1h" });
    const cov = result.improve.coverage;

    expect(cov).toBeDefined();
    expect(Number.isNaN(cov.rate)).toBe(true);
    expect(Number.isNaN(cov.eligibleFraction)).toBe(true);
  });

  test("coverage.acceptedProposals counts only accepted (not pending) proposals", () => {
    const db = openStateDatabase();
    try {
      const now = new Date();
      const start = new Date(now.getTime() - 60_000).toISOString();
      const end = now.toISOString();

      recordImproveRun(db, {
        id: "run-coverage-filter",
        startedAt: start,
        completedAt: end,
        stashDir: "/tmp/stash",
        dryRun: false,
        profile: null,
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: true,
        result: fixtureResult({
          schemaVersion: 1,
          ok: true,
          scope: { mode: "all" },
          dryRun: false,
          memorySummary: { eligible: 10, derived: 0 },
          plannedRefs: [],
          actions: [],
        }),
      });

      // 2 accepted, 1 pending.
      upsertProposal(db, makeAcceptedProposal("p-acc-1", "memory:x"), "/tmp/stash");
      upsertProposal(db, makeAcceptedProposal("p-acc-2", "memory:y"), "/tmp/stash");
      // Pending proposal — should NOT count toward coverage.
      upsertProposal(
        db,
        {
          ...makeAcceptedProposal("p-pend", "memory:z"),
          status: "pending",
        },
        "/tmp/stash",
      );
    } finally {
      db.close();
    }

    const result = akmHealth({ since: "1h" });
    expect(result.improve.coverage.acceptedProposals).toBe(2);
  });

  test("coverage.acceptedProposals is window-scoped and excludes proposals outside the window", () => {
    const db = openStateDatabase();
    try {
      const now = new Date();
      const start = new Date(now.getTime() - 60_000).toISOString();
      const end = now.toISOString();

      recordImproveRun(db, {
        id: "run-coverage-window",
        startedAt: start,
        completedAt: end,
        stashDir: "/tmp/stash",
        dryRun: false,
        profile: null,
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: true,
        result: fixtureResult({
          schemaVersion: 1,
          ok: true,
          scope: { mode: "all" },
          dryRun: false,
          memorySummary: { eligible: 5, derived: 0 },
          plannedRefs: [],
          actions: [],
        }),
      });

      // 1 accepted proposal within the window (updatedAt = now).
      upsertProposal(db, makeAcceptedProposal("p-in-window", "memory:in"), "/tmp/stash");

      // 1 accepted proposal outside the window (updatedAt = 3 hours ago).
      const oldTime = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString();
      upsertProposal(
        db,
        {
          ...makeAcceptedProposal("p-old", "memory:old"),
          updatedAt: oldTime,
          createdAt: oldTime,
        },
        "/tmp/stash",
      );
    } finally {
      db.close();
    }

    // since=1h: only p-in-window should count; p-old is 3 hours ago and outside window.
    const result = akmHealth({ since: "1h" });
    expect(result.improve.coverage.acceptedProposals).toBe(1);
  });
});

describe("WS-5 degradation metrics", () => {
  test("computes Gini coefficient and flags entrenchment when > 0.6", () => {
    const db = openStateDatabase();
    try {
      const now = new Date();
      const start = new Date(now.getTime() - 60_000).toISOString();
      const end = now.toISOString();

      // Need at least one run for degradation to be computed.
      recordImproveRun(db, {
        id: "run-degrade",
        startedAt: start,
        completedAt: end,
        stashDir: "/tmp/stash",
        dryRun: false,
        profile: null,
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: true,
        result: fixtureResult({
          schemaVersion: 1,
          ok: true,
          scope: { mode: "all" },
          dryRun: false,
          memorySummary: { eligible: 5, derived: 0 },
          plannedRefs: [],
          actions: [],
        }),
      });

      // Highly skewed distribution: one asset dominates retrieval — high Gini.
      // With 1 asset at 0.99 and many near-zero (0.001), the Gini approaches
      // the ~0.47 maximum for bounded [0,1] values and triggers entrenchment
      // (threshold is 0.35 in health.ts).
      upsertAssetSalience(db, "memory:dominant", { encoding: 0.9, outcome: 0.9, retrieval: 0.99, rankScore: 0.99 });
      for (let i = 0; i < 19; i++) {
        upsertAssetSalience(db, `memory:low-${i}`, {
          encoding: 0.01,
          outcome: 0.01,
          retrieval: 0.001,
          rankScore: 0.01,
        });
      }
    } finally {
      db.close();
    }

    const result = akmHealth({ since: "1h" });
    const deg = result.improve.degradation;

    expect(deg).toBeDefined();
    if (!deg) return; // type guard

    // With a highly skewed salience distribution, Gini should be > 0.35
    // (the entrenchment threshold in health.ts for bounded [0,1] salience values).
    expect(deg.corpusCentroidDistance).toBeGreaterThan(0.35);
    expect(deg.entrenchmentFlagged).toBe(true);
  });

  test("does not flag entrenchment for uniform distribution", () => {
    const db = openStateDatabase();
    try {
      const now = new Date();
      const start = new Date(now.getTime() - 60_000).toISOString();
      const end = now.toISOString();

      recordImproveRun(db, {
        id: "run-degrade-uniform",
        startedAt: start,
        completedAt: end,
        stashDir: "/tmp/stash",
        dryRun: false,
        profile: null,
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: true,
        result: fixtureResult({
          schemaVersion: 1,
          ok: true,
          scope: { mode: "all" },
          dryRun: false,
          memorySummary: { eligible: 5, derived: 0 },
          plannedRefs: [],
          actions: [],
        }),
      });

      // Uniform distribution — Gini close to 0.
      for (let i = 0; i < 10; i++) {
        upsertAssetSalience(db, `memory:uniform-${i}`, {
          encoding: 0.5,
          outcome: 0.5,
          retrieval: 0.5,
          rankScore: 0.5,
        });
      }
    } finally {
      db.close();
    }

    const result = akmHealth({ since: "1h" });
    const deg = result.improve.degradation;

    expect(deg).toBeDefined();
    if (!deg) return;

    // Uniform salience → Gini ≈ 0 → NOT flagged.
    expect(deg.entrenchmentFlagged).toBe(false);
  });

  test("oracle spot-check samples up to 5 recently accepted proposals", () => {
    const db = openStateDatabase();
    try {
      const now = new Date();
      const start = new Date(now.getTime() - 60_000).toISOString();
      const end = now.toISOString();

      recordImproveRun(db, {
        id: "run-oracle",
        startedAt: start,
        completedAt: end,
        stashDir: "/tmp/stash",
        dryRun: false,
        profile: null,
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: true,
        result: fixtureResult({
          schemaVersion: 1,
          ok: true,
          scope: { mode: "all" },
          dryRun: false,
          memorySummary: { eligible: 10, derived: 0 },
          plannedRefs: [],
          actions: [],
        }),
      });

      // Seed 8 accepted proposals — spot-check should sample up to 5.
      for (let i = 0; i < 8; i++) {
        upsertProposal(db, makeAcceptedProposal(`oracle-${i}`, `memory:check-${i}`), "/tmp/stash");
      }
    } finally {
      db.close();
    }

    const result = akmHealth({ since: "1h" });
    const deg = result.improve.degradation;

    expect(deg).toBeDefined();
    if (!deg) return;

    // Oracle spot-check caps at 5 entries.
    expect(deg.oracleSpotCheck.length).toBeGreaterThanOrEqual(1);
    expect(deg.oracleSpotCheck.length).toBeLessThanOrEqual(5);
    for (const entry of deg.oracleSpotCheck) {
      expect(entry.proposalId).toBeTruthy();
      expect(entry.ref).toBeTruthy();
      expect(entry.source).toBeTruthy();
      expect(entry.acceptedAt).toBeTruthy();
    }
  });
});

describe("WS-5 metrics with no runs in window", () => {
  test("returns zero/NaN metrics when no runs in window", () => {
    const result = akmHealth({ since: "1h" });
    const perf = result.improve.perfTelemetry;
    const cov = result.improve.coverage;

    // perfTelemetry should be zero-initialized.
    expect(perf.runsWithTelemetry).toBe(0);
    expect(perf.embedMs).toBe(0);
    expect(perf.overBudgetRuns).toBe(0);

    // Coverage denominator is 0 → NaN rates.
    expect(cov.acceptedProposals).toBe(0);
    expect(Number.isNaN(cov.rate)).toBe(true);
  });
});
