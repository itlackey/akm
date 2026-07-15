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
 *
 * The exploration-budget describes (below-threshold promotion,
 * budget-exhaustion deferral, no-confidence-never-exploration,
 * makeGateConfig's config-driven budget computation, and
 * budget-restoration-on-failure) were deleted in Chunk 7 (WI-7.2, R14)
 * alongside the exploration lane itself. The auto-tune ceiling / per-phase
 * auto-tune persistence / per-phase calibration isolation describes were
 * deleted in Chunk 7 (WI-7.3, R16) alongside `maybeAutoTuneThreshold` and the
 * rest of the calibration surface — see `docs/design/execution/chunk-7/ledger.md`.
 * `persistPhaseThreshold`/`getPhaseThreshold` (Migration 012) and
 * `makeGateConfig`'s phaseThreshold READ path are retained for Chunk 6.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ProposalCandidate } from "../../../src/commands/improve/improve-auto-accept";
import { makeGateConfig, runAutoAcceptGate } from "../../../src/commands/improve/improve-auto-accept";
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
