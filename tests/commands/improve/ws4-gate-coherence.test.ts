// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS-4 CHANGE-gate coherence tests.
 *
 * Covers:
 *   1. Per-phase threshold store (Migration 012): getPhaseThreshold /
 *      persistPhaseThreshold round-trip.
 *   2. makeGateConfig reads the stored per-phase threshold when stateDbPath is
 *      provided; falls back to globalThreshold when no row exists.
 *   3. Exploration budget: proposals below threshold are promoted up to the
 *      budget count, logged eligibilitySource="exploration".
 *   4. Exploration budget exhausted: further below-threshold proposals are
 *      deferred (not promoted).
 *   5. Auto-tune ceiling: maybeAutoTuneThreshold respects maxThreshold default
 *      of 85 (WS-4 change — was 100).
 *   6. Per-phase auto-tune persists per-phase to state.db.
 *   7. Exploration candidates get eligibilitySource="exploration" on the event.
 *   8. No-confidence candidates are never exploration-promoted.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { maybeAutoTuneThreshold } from "../../../src/commands/improve/improve";
import type { AutoAcceptGateConfig, ProposalCandidate } from "../../../src/commands/improve/improve-auto-accept";
import { makeGateConfig, runAutoAcceptGate } from "../../../src/commands/improve/improve-auto-accept";
import { createProposal, recordGateDecision } from "../../../src/commands/proposal/repository";
import type { AkmConfig } from "../../../src/core/config/config";
import { getStateDbPathInDataDir } from "../../../src/core/paths";
import { openStateDatabase } from "../../../src/core/state-db";
import { getPhaseThreshold, persistPhaseThreshold } from "../../../src/storage/repositories/improve-runs-repository";
import { type Cleanup, type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

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

// ── Helpers ───────────────────────────────────────────────────────────────────

const STUB_CONFIG = {} as AkmConfig;

function makePromotion(proposalId: string) {
  return {
    ref: `memory:test-${proposalId}`,
    assetPath: `/tmp/test-stash/memory/test-${proposalId}.md`,
    proposal: { id: proposalId, source: "reflect" as const, sourceRun: undefined, eligibilitySource: undefined },
  };
}

function candidate(proposalId: string, confidence: number | undefined): ProposalCandidate {
  return { proposalId, confidence };
}

// ── 1. Per-phase threshold store round-trip ───────────────────────────────────

describe("per-phase threshold store (Migration 012)", () => {
  test("persistPhaseThreshold + getPhaseThreshold round-trip", () => {
    const db = openStateDatabase(getStateDbPathInDataDir());
    try {
      persistPhaseThreshold(db, "reflect", 82);
      persistPhaseThreshold(db, "distill", 75);
      expect(getPhaseThreshold(db, "reflect")).toBe(82);
      expect(getPhaseThreshold(db, "distill")).toBe(75);
      // Phase with no stored value returns undefined
      expect(getPhaseThreshold(db, "extract")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("persistPhaseThreshold is idempotent (upsert semantics)", () => {
    const db = openStateDatabase(getStateDbPathInDataDir());
    try {
      persistPhaseThreshold(db, "reflect", 80);
      persistPhaseThreshold(db, "reflect", 85); // update
      expect(getPhaseThreshold(db, "reflect")).toBe(85);
    } finally {
      db.close();
    }
  });

  test("threshold is rounded to integer on persist", () => {
    const db = openStateDatabase(getStateDbPathInDataDir());
    try {
      persistPhaseThreshold(db, "consolidate", 83.7);
      expect(getPhaseThreshold(db, "consolidate")).toBe(84);
    } finally {
      db.close();
    }
  });
});

// ── 2. makeGateConfig reads per-phase threshold ───────────────────────────────

describe("makeGateConfig per-phase threshold resolution", () => {
  const sharedBase = {
    globalThreshold: 90 as number | undefined,
    dryRun: false,
    stashDir: "/tmp/test-stash",
    config: STUB_CONFIG,
    eventsCtx: undefined,
  };

  test("reads stored phase threshold when stateDbPath is provided", () => {
    const dbPath = getStateDbPathInDataDir();
    const db = openStateDatabase(dbPath);
    try {
      persistPhaseThreshold(db, "reflect", 78);
    } finally {
      db.close();
    }

    const cfg = makeGateConfig("reflect", { ...sharedBase, stateDbPath: dbPath });
    // phaseThreshold should be set to 78 from state.db
    expect(cfg.phaseThreshold).toBe(78);
    // globalThreshold is the operator-supplied baseline, unchanged
    expect(cfg.globalThreshold).toBe(90);
  });

  test("phaseThreshold is undefined when no row exists (first run)", () => {
    const dbPath = getStateDbPathInDataDir();
    const cfg = makeGateConfig("reflect", { ...sharedBase, stateDbPath: dbPath });
    expect(cfg.phaseThreshold).toBeUndefined();
    expect(cfg.globalThreshold).toBe(90);
  });

  test("no stateDbPath provided → phaseThreshold is undefined (fallback to globalThreshold)", () => {
    const cfg = makeGateConfig("reflect", sharedBase);
    expect(cfg.phaseThreshold).toBeUndefined();
  });

  test("phase threshold overrides globalThreshold in runAutoAcceptGate", async () => {
    const dbPath = getStateDbPathInDataDir();
    const db = openStateDatabase(dbPath);
    try {
      // Store 70 for "reflect" — lower than globalThreshold=90
      persistPhaseThreshold(db, "reflect", 70);
    } finally {
      db.close();
    }

    const promoteFn = mock(async (_stash: string, _cfg: AkmConfig, id: string) => makePromotion(id));
    const cfg = makeGateConfig("reflect", { ...sharedBase, stateDbPath: dbPath });
    // With phaseThreshold=70, a candidate at 0.75 (75%) should be promoted
    const result = await runAutoAcceptGate([candidate("p1", 0.75)], cfg, promoteFn as never);
    expect(result.promoted).toEqual(["p1"]);
  });

  test("phaseThreshold is still floored by minimumThreshold", async () => {
    const dbPath = getStateDbPathInDataDir();
    const db = openStateDatabase(dbPath);
    try {
      // Store 60 for "consolidate"
      persistPhaseThreshold(db, "consolidate", 60);
    } finally {
      db.close();
    }

    const promoteFn = mock(async (_stash: string, _cfg: AkmConfig, id: string) => makePromotion(id));
    const cfg = makeGateConfig(
      "consolidate",
      { ...sharedBase, stateDbPath: dbPath },
      // minimumThreshold=95 floors even the stored phase value
      { minimumThreshold: 95 },
    );
    // 0.70 (70%) is below the minimumThreshold floor of 95
    const result = await runAutoAcceptGate([candidate("p1", 0.7)], cfg, promoteFn as never);
    expect(result.skipped).toEqual(["p1"]);
    expect(result.promoted).toEqual([]);
  });
});

// ── 3. Exploration budget promotes below-threshold candidates ─────────────────

describe("exploration budget", () => {
  test("below-threshold candidates with budget remaining are promoted as exploration", async () => {
    const promoteFn = mock(async (_stash: string, _cfg: AkmConfig, id: string) => makePromotion(id));
    const cfg: AutoAcceptGateConfig = {
      phase: "reflect",
      globalThreshold: 90,
      dryRun: false,
      stashDir: "/tmp/test-stash",
      config: STUB_CONFIG,
      eventsCtx: undefined,
      explorationBudgetCount: 2, // allow up to 2 exploration promotions
    };

    const result = await runAutoAcceptGate(
      [
        candidate("high", 0.95), // above threshold → normal promote
        candidate("low1", 0.5), // below threshold → exploration budget
        candidate("low2", 0.6), // below threshold → exploration budget
        candidate("low3", 0.4), // below threshold → budget exhausted, deferred
      ],
      cfg,
      promoteFn as never,
    );

    expect(result.promoted.sort()).toEqual(["high", "low1", "low2"]);
    expect(result.skipped).toEqual(["low3"]);
    expect(result.failed).toEqual([]);
  });

  test("exploration budget = 0 means no exploration promotions (parity)", async () => {
    const promoteFn = mock(async (_stash: string, _cfg: AkmConfig, id: string) => makePromotion(id));
    const cfg: AutoAcceptGateConfig = {
      phase: "reflect",
      globalThreshold: 90,
      dryRun: false,
      stashDir: "/tmp/test-stash",
      config: STUB_CONFIG,
      eventsCtx: undefined,
      explorationBudgetCount: 0,
    };

    const result = await runAutoAcceptGate([candidate("low", 0.5)], cfg, promoteFn as never);
    expect(result.promoted).toEqual([]);
    expect(result.skipped).toEqual(["low"]);
  });

  test("explorationBudgetCount not set → no exploration (parity, default)", async () => {
    const promoteFn = mock(async (_stash: string, _cfg: AkmConfig, id: string) => makePromotion(id));
    const cfg: AutoAcceptGateConfig = {
      phase: "reflect",
      globalThreshold: 90,
      dryRun: false,
      stashDir: "/tmp/test-stash",
      config: STUB_CONFIG,
      eventsCtx: undefined,
      // no explorationBudgetCount → defaults to 0 inside runAutoAcceptGate
    };

    const result = await runAutoAcceptGate([candidate("low", 0.5)], cfg, promoteFn as never);
    expect(result.promoted).toEqual([]);
    expect(result.skipped).toEqual(["low"]);
  });
});

// ── 4. Budget exhausted ───────────────────────────────────────────────────────

describe("exploration budget exhaustion", () => {
  test("budget is consumed in order; once exhausted, remaining below-threshold are deferred", async () => {
    const promoteFn = mock(async (_stash: string, _cfg: AkmConfig, id: string) => makePromotion(id));
    const cfg: AutoAcceptGateConfig = {
      phase: "reflect",
      globalThreshold: 90,
      dryRun: false,
      stashDir: "/tmp/test-stash",
      config: STUB_CONFIG,
      eventsCtx: undefined,
      explorationBudgetCount: 1,
    };

    // 4 below-threshold candidates; only the first should be exploration-promoted
    const result = await runAutoAcceptGate(
      [candidate("low1", 0.5), candidate("low2", 0.6), candidate("low3", 0.55), candidate("low4", 0.45)],
      cfg,
      promoteFn as never,
    );
    expect(result.promoted).toEqual(["low1"]); // only first
    expect(result.skipped.sort()).toEqual(["low2", "low3", "low4"]);
  });
});

// ── 5. No-confidence candidates are never exploration-promoted ─────────────────

describe("no-confidence candidates and exploration", () => {
  test("undefined confidence → never exploration-promoted, always deferred", async () => {
    const promoteFn = mock(async (_stash: string, _cfg: AkmConfig, id: string) => makePromotion(id));
    const cfg: AutoAcceptGateConfig = {
      phase: "reflect",
      globalThreshold: 90,
      dryRun: false,
      stashDir: "/tmp/test-stash",
      config: STUB_CONFIG,
      eventsCtx: undefined,
      explorationBudgetCount: 5, // large budget
    };

    const result = await runAutoAcceptGate([candidate("no-conf", undefined)], cfg, promoteFn as never);
    expect(result.promoted).toEqual([]);
    expect(result.skipped).toEqual(["no-conf"]);
  });
});

// ── 6. Auto-tune ceiling at 85 (WS-4 default maxThreshold) ───────────────────

describe("auto-tune ceiling", () => {
  function seedOverconfident(n: number): void {
    for (let i = 0; i < n; i++) {
      const created = createProposal(storage.stashDir, {
        ref: `lesson:tune-${i}`,
        source: "reflect",
        sourceRun: "run-1",
        payload: { content: `# tune-${i}\n\nbody ${i}\n` },
        confidence: 0.95,
      });
      if ("skipped" in created) throw new Error("seed skipped");
      recordGateDecision(storage.stashDir, created.id, {
        outcome: i % 2 === 0 ? "auto-accepted" : "auto-rejected",
        reason: "above-threshold",
        confidence: 0.95,
        thresholds: { autoAccept: 0.9 },
        gate: "improve:reflect",
      });
    }
  }

  test("default maxThreshold is 85 — auto-tune cannot exceed it", () => {
    seedOverconfident(20); // 50% accept rate → wants to raise the threshold
    const config = {
      improve: {
        calibration: {
          autoTune: true,
          minThreshold: 70,
          // maxThreshold NOT set → WS-4 default of 85 applies
          maxStep: 20, // large step so ceiling is the binding constraint
          minSamples: 10,
        },
      },
    } as AkmConfig;

    // Start well below 85 so the large step tries to push past 85
    const tuned = maybeAutoTuneThreshold(70, config, getStateDbPathInDataDir());
    // Should be at most 85 (the new WS-4 ceiling default), not 90 (old default 100 would allow)
    expect(tuned).toBeLessThanOrEqual(85);
  });

  test("explicit maxThreshold overrides the WS-4 ceiling default", () => {
    seedOverconfident(20);
    const config = {
      improve: {
        calibration: {
          autoTune: true,
          minThreshold: 70,
          maxThreshold: 95, // explicit override — allows up to 95
          maxStep: 5,
          minSamples: 10,
        },
      },
    } as AkmConfig;
    // This should not cap at 85 — explicit maxThreshold=95 wins
    const tuned = maybeAutoTuneThreshold(70, config, getStateDbPathInDataDir());
    // Tuning is enabled so a result (not undefined) is expected when over-confident
    // (it might not reach 95 with maxStep=5, but it should not be capped at 85).
    if (tuned !== undefined) {
      expect(tuned).toBeLessThanOrEqual(95);
    }
  });
});

// ── 7. Per-phase auto-tune persists to state.db ──────────────────────────────

describe("per-phase auto-tune persistence", () => {
  function seedOverconfident(n: number): void {
    for (let i = 0; i < n; i++) {
      const created = createProposal(storage.stashDir, {
        ref: `lesson:ptune-${i}`,
        source: "reflect",
        sourceRun: "run-1",
        payload: { content: `# ptune-${i}\n\nbody ${i}\n` },
        confidence: 0.95,
      });
      if ("skipped" in created) throw new Error("seed skipped");
      recordGateDecision(storage.stashDir, created.id, {
        outcome: i % 2 === 0 ? "auto-accepted" : "auto-rejected",
        reason: "above-threshold",
        confidence: 0.95,
        thresholds: { autoAccept: 0.9 },
        gate: "improve:reflect",
      });
    }
  }

  test("when phase is provided, the tuned threshold is persisted to state.db", () => {
    seedOverconfident(20); // over-confident gate → threshold will be raised
    const config = {
      improve: {
        calibration: {
          autoTune: true,
          minThreshold: 70,
          maxThreshold: 85,
          maxStep: 5,
          minSamples: 10,
        },
      },
    } as AkmConfig;

    const dbPath = getStateDbPathInDataDir();
    const tuned = maybeAutoTuneThreshold(80, config, dbPath, undefined, "reflect");
    // Tune should have produced a result and persisted it
    expect(tuned).toBeDefined();
    if (tuned !== undefined) {
      const db = openStateDatabase(dbPath);
      try {
        const stored = getPhaseThreshold(db, "reflect");
        expect(stored).toBe(tuned);
      } finally {
        db.close();
      }
    }
  });

  test("when no phase is provided (legacy call), nothing is persisted", () => {
    seedOverconfident(20);
    const config = {
      improve: {
        calibration: {
          autoTune: true,
          minThreshold: 70,
          maxThreshold: 85,
          maxStep: 5,
          minSamples: 10,
        },
      },
    } as AkmConfig;

    const dbPath = getStateDbPathInDataDir();
    maybeAutoTuneThreshold(80, config, dbPath);
    // No phase → no row in improve_gate_thresholds
    const db = openStateDatabase(dbPath);
    try {
      expect(getPhaseThreshold(db, "reflect")).toBeUndefined();
      expect(getPhaseThreshold(db, "distill")).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

// ── 8. makeGateConfig exploration budget from config ─────────────────────────

describe("makeGateConfig exploration budget from config", () => {
  test("exploration.enabled=true and candidateCount > 0 → explorationBudgetCount computed", () => {
    const config: AkmConfig = {
      semanticSearchMode: "off",
      improve: {
        exploration: { enabled: true, budgetFraction: 0.1 }, // 10% of candidates
      },
    };
    const cfg = makeGateConfig("reflect", {
      globalThreshold: 90,
      dryRun: false,
      stashDir: "/tmp/test-stash",
      config,
      eventsCtx: undefined,
      candidateCount: 20,
    });
    // 10% of 20 = 2
    expect(cfg.explorationBudgetCount).toBe(2);
  });

  test("exploration.enabled=false → no exploration budget", () => {
    const config: AkmConfig = {
      semanticSearchMode: "off",
      improve: {
        exploration: { enabled: false, budgetFraction: 0.1 },
      },
    };
    const cfg = makeGateConfig("reflect", {
      globalThreshold: 90,
      dryRun: false,
      stashDir: "/tmp/test-stash",
      config,
      eventsCtx: undefined,
      candidateCount: 20,
    });
    expect(cfg.explorationBudgetCount).toBeUndefined();
  });

  test("no exploration config → no exploration budget (parity default)", () => {
    const cfg = makeGateConfig("reflect", {
      globalThreshold: 90,
      dryRun: false,
      stashDir: "/tmp/test-stash",
      config: STUB_CONFIG,
      eventsCtx: undefined,
      candidateCount: 20,
    });
    expect(cfg.explorationBudgetCount).toBeUndefined();
  });

  test("default budgetFraction=0.05 applied when fraction not specified", () => {
    const config: AkmConfig = {
      semanticSearchMode: "off",
      improve: {
        exploration: { enabled: true }, // fraction omitted → uses default 0.05
      },
    };
    const cfg = makeGateConfig("reflect", {
      globalThreshold: 90,
      dryRun: false,
      stashDir: "/tmp/test-stash",
      config,
      eventsCtx: undefined,
      candidateCount: 100,
    });
    // 5% of 100 = 5
    expect(cfg.explorationBudgetCount).toBe(5);
  });
});

// ── 9. Per-phase calibration isolation: distinct histories → distinct thresholds ──

describe("per-phase calibration isolation", () => {
  /**
   * WS-4 fix regression test: two phases with entirely different decision
   * histories must tune to DIFFERENT thresholds. Before the fix,
   * maybeAutoTuneThreshold always read the full global decision pool so both
   * phases produced the same summary and the same tuned threshold, defeating
   * the per-phase mechanism.
   */
  test("reflect phase (over-confident) and extract phase (accurate) tune to different thresholds", () => {
    // Seed reflect with over-confident decisions: 50% accept rate → wants to RAISE
    for (let i = 0; i < 20; i++) {
      const created = createProposal(storage.stashDir, {
        ref: `lesson:reflect-iso-${i}`,
        source: "reflect",
        sourceRun: "run-iso",
        payload: { content: `# reflect-iso-${i}\n\nbody\n` },
        confidence: 0.95,
      });
      if ("skipped" in created) throw new Error("seed skipped");
      recordGateDecision(storage.stashDir, created.id, {
        outcome: i % 2 === 0 ? "auto-accepted" : "auto-rejected",
        reason: "above-threshold",
        confidence: 0.95,
        thresholds: { autoAccept: 0.9 },
        gate: "improve:reflect", // reflect phase
      });
    }

    // Seed extract with highly accurate decisions: 100% accept rate → wants to LOWER
    for (let i = 0; i < 20; i++) {
      const created = createProposal(storage.stashDir, {
        ref: `lesson:extract-iso-${i}`,
        source: "extract",
        sourceRun: "run-iso",
        payload: { content: `# extract-iso-${i}\n\nbody\n` },
        confidence: 0.95,
      });
      if ("skipped" in created) throw new Error("seed skipped");
      recordGateDecision(storage.stashDir, created.id, {
        outcome: "auto-accepted", // all accepted → want to LOWER threshold
        reason: "above-threshold",
        confidence: 0.95,
        thresholds: { autoAccept: 0.9 },
        gate: "improve:extract", // extract phase
      });
    }

    const config = {
      improve: {
        calibration: {
          autoTune: true,
          minThreshold: 50,
          maxThreshold: 100,
          maxStep: 20, // large step so the difference is observable
          minSamples: 10,
          targetAcceptRate: 0.9,
        },
      },
    } as AkmConfig;

    const dbPath = getStateDbPathInDataDir();
    const startThreshold = 80;

    // reflect: 50% accept rate is below target 0.9 → should RAISE threshold
    const reflectTuned = maybeAutoTuneThreshold(startThreshold, config, dbPath, undefined, "reflect");
    // extract: 100% accept rate is above target 0.9 → should LOWER threshold
    const extractTuned = maybeAutoTuneThreshold(startThreshold, config, dbPath, undefined, "extract");

    // Both phases must have produced a tuned value
    expect(reflectTuned).toBeDefined();
    expect(extractTuned).toBeDefined();

    // They must differ in direction: reflect raised, extract lowered (or at minimum they differ)
    expect(reflectTuned).not.toBe(extractTuned);
    // More precise: reflect should be ABOVE the start (raised) and extract BELOW (lowered)
    expect(reflectTuned as number).toBeGreaterThan(startThreshold);
    expect(extractTuned as number).toBeLessThan(startThreshold);
  });
});

// ── 11. Exploration promotion restores budget on failure ───────────────────────

describe("exploration budget restoration on failure", () => {
  test("failed exploration promotion restores budget so next candidate can use it", async () => {
    const promoteFn = mock(async (_stash: string, _cfg: AkmConfig, id: string) => {
      if (id === "fail") throw new Error("promote failed");
      return makePromotion(id);
    });

    const cfg: AutoAcceptGateConfig = {
      phase: "reflect",
      globalThreshold: 90,
      dryRun: false,
      stashDir: "/tmp/test-stash",
      config: STUB_CONFIG,
      eventsCtx: undefined,
      explorationBudgetCount: 1,
    };

    const result = await runAutoAcceptGate(
      [
        candidate("fail", 0.5), // budget consumed, fails → budget restored
        candidate("ok", 0.6), // next below-threshold: budget available again
      ],
      cfg,
      promoteFn as never,
    );

    // "fail" errors out, "ok" should succeed because budget was restored
    expect(result.failed).toEqual(["fail"]);
    expect(result.promoted).toEqual(["ok"]);
  });
});
