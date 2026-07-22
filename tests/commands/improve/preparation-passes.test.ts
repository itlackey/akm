// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-7.6 — focused unit coverage for the pure preparation-stage passes
 * extracted from `runImprovePreparationStage` (R31 decomposition, testability
 * requirement).
 *
 * `partitionBySignalDelta` (the 2026-05-26 signal-delta partition) and
 * `applyForgettingSafety` (the WS-1 step-7 protective injection) are driven
 * directly with in-memory timestamp maps — no LLM, no state.db writes beyond
 * the sandboxed event emit — and their returned buckets/attribution are
 * asserted instead of the old shared closure state. End-to-end partition
 * behavior stays pinned by `improve-eligibility.test.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  applyForgettingSafety,
  buildSnapshotManifest,
  partitionBySignalDelta,
} from "../../../src/commands/improve/preparation";
import type { AkmConfig } from "../../../src/core/config/config";
import type { EligibilitySource, ImproveEligibleRef } from "../../../src/core/improve-types";
import { makeStashDir, type SandboxedDir, sandboxXdgDataHome } from "../../_helpers/sandbox";

const disposers: Array<{ cleanup: () => void }> = [];

afterEach(() => {
  for (const d of disposers.splice(0)) d.cleanup();
});

function freshStash(): string {
  const dataSb = sandboxXdgDataHome();
  disposers.push(dataSb);
  const stash: SandboxedDir = makeStashDir();
  disposers.push(stash);
  return stash.dir;
}

function ref(r: string, extra: Partial<ImproveEligibleRef> = {}): ImproveEligibleRef {
  return { ref: r, reason: "scope-type", ...extra };
}

function snapshot(overrides: {
  latestFeedbackTs?: Map<string, string>;
  lastReflectProposalTs?: Map<string, string>;
  lastDistillProposalTs?: Map<string, string>;
}) {
  return {
    feedbackSinceCutoff: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
    latestFeedbackTs: overrides.latestFeedbackTs ?? new Map(),
    lastReflectProposalTs: overrides.lastReflectProposalTs ?? new Map(),
    lastDistillProposalTs: overrides.lastDistillProposalTs ?? new Map(),
  };
}

describe("partitionBySignalDelta — the four buckets", () => {
  const T1 = "2026-07-01T00:00:00.000Z";
  const T2 = "2026-07-02T00:00:00.000Z";

  test("fresh feedback with no prior proposal → eligibleRefs (not cooled)", () => {
    const stash = freshStash();
    const refs = [ref("memories/fresh")];
    const out = partitionBySignalDelta({
      scope: { mode: "all" },
      options: { stashDir: stash, config: {} as AkmConfig },
      postCleanupRefs: refs,
      validationFailureRefs: new Set(),
      snapshot: snapshot({ latestFeedbackTs: new Map([["memories/fresh", T2]]) }),
    });

    expect(out.eligibleRefs.map((r) => r.ref)).toEqual(["memories/fresh"]);
    expect(out.distillOnlyRefs).toEqual([]);
    expect(out.noFeedbackPool).toEqual([]);
    expect(out.fullySkippedCount).toBe(0);
    expect(out.distillCooledRefs.size).toBe(0);
    expect(out.preCooldownCount).toBe(1);
  });

  test("reflect passes but distill cooled → eligible + distillCooled + synthetic skip action", () => {
    const stash = freshStash();
    // Feedback at T2; reflect proposal older (T1) → reflect passes; distill
    // proposal newer (T2) → distill gate fails. memory: ref is a distill candidate.
    const out = partitionBySignalDelta({
      scope: { mode: "all" },
      options: { stashDir: stash, config: {} as AkmConfig },
      postCleanupRefs: [ref("memories/cooled")],
      validationFailureRefs: new Set(),
      snapshot: snapshot({
        latestFeedbackTs: new Map([["memories/cooled", T2]]),
        lastReflectProposalTs: new Map([["memories/cooled", T1]]),
        lastDistillProposalTs: new Map([["memories/cooled", T2]]),
      }),
    });

    expect(out.eligibleRefs.map((r) => r.ref)).toEqual(["memories/cooled"]);
    expect([...out.distillCooledRefs]).toEqual(["memories/cooled"]);
    expect(out.actions).toEqual([
      { ref: "memories/cooled", mode: "distill-skipped", result: { ok: true, reason: "distill signal-delta" } },
    ]);
  });

  test("reflect cooled but distill passes on a distill candidate → distillOnlyRefs", () => {
    const stash = freshStash();
    const out = partitionBySignalDelta({
      scope: { mode: "all" },
      options: { stashDir: stash, config: {} as AkmConfig },
      postCleanupRefs: [ref("memories/distill-only")],
      validationFailureRefs: new Set(),
      snapshot: snapshot({
        latestFeedbackTs: new Map([["memories/distill-only", T1]]),
        lastReflectProposalTs: new Map([["memories/distill-only", T2]]),
      }),
    });

    expect(out.eligibleRefs).toEqual([]);
    expect(out.distillOnlyRefs.map((r) => r.ref)).toEqual(["memories/distill-only"]);
  });

  test("no feedback at all → deferred to the noFeedbackPool, never skipped outright", () => {
    const stash = freshStash();
    const out = partitionBySignalDelta({
      scope: { mode: "all" },
      options: { stashDir: stash, config: {} as AkmConfig },
      postCleanupRefs: [ref("memories/never-rated")],
      validationFailureRefs: new Set(),
      snapshot: snapshot({}),
    });

    expect(out.noFeedbackPool.map((r) => r.ref)).toEqual(["memories/never-rated"]);
    expect(out.fullySkippedCount).toBe(0);
    expect(out.actions).toEqual([]);
  });

  test("stale feedback with no delta since the last proposals → fully skipped with action", () => {
    const stash = freshStash();
    const out = partitionBySignalDelta({
      scope: { mode: "all" },
      options: { stashDir: stash, config: {} as AkmConfig },
      postCleanupRefs: [ref("memories/stale")],
      validationFailureRefs: new Set(),
      snapshot: snapshot({
        latestFeedbackTs: new Map([["memories/stale", T1]]),
        lastReflectProposalTs: new Map([["memories/stale", T2]]),
        lastDistillProposalTs: new Map([["memories/stale", T2]]),
      }),
    });

    expect(out.fullySkippedCount).toBe(1);
    expect(out.actions).toEqual([
      {
        ref: "memories/stale",
        mode: "distill-skipped",
        result: { ok: true, reason: "no new signal since last proposal" },
      },
    ]);
  });

  test("O-2 (#365): explicit --scope <ref> bypasses every gate", () => {
    const stash = freshStash();
    const out = partitionBySignalDelta({
      scope: { mode: "ref", value: "memories/target" },
      options: { stashDir: stash, config: {} as AkmConfig },
      postCleanupRefs: [ref("memories/target")],
      validationFailureRefs: new Set(),
      snapshot: snapshot({}), // no feedback anywhere — bypass still admits it
    });

    expect(out.eligibleRefs.map((r) => r.ref)).toEqual(["memories/target"]);
    expect(out.noFeedbackPool).toEqual([]);
  });

  test("validation failures are excluded from every bucket", () => {
    const stash = freshStash();
    const out = partitionBySignalDelta({
      scope: { mode: "all" },
      options: { stashDir: stash, config: {} as AkmConfig },
      postCleanupRefs: [ref("memories/broken"), ref("memories/ok")],
      validationFailureRefs: new Set(["memories/broken"]),
      snapshot: snapshot({ latestFeedbackTs: new Map([["memories/ok", T2]]) }),
    });

    const everywhere = [...out.eligibleRefs, ...out.distillOnlyRefs, ...out.noFeedbackPool].map((r) => r.ref);
    expect(everywhere).toEqual(["memories/ok"]);
    expect(out.fullySkippedCount).toBe(0);
  });
});

describe("applyForgettingSafety — WS-1 step-7 protective injection", () => {
  test("no forgetting candidates → mergedRefs unchanged (same identity)", () => {
    const merged = [ref("memories/a")];
    const out = applyForgettingSafety({
      pendingForgettingRefs: [],
      scope: { mode: "all" },
      mergedRefs: merged,
      eligibilitySourceByRef: new Map(),
      highSalienceRefs: [],
      proactiveRefs: [],
      signalFiltered: [],
    });
    expect(out).toBe(merged);
  });

  test("ref scope suppresses the injection entirely", () => {
    const merged = [ref("memories/a")];
    const out = applyForgettingSafety({
      pendingForgettingRefs: ["memories/dropped"],
      scope: { mode: "ref", value: "memories/a" },
      mergedRefs: merged,
      eligibilitySourceByRef: new Map(),
      highSalienceRefs: [],
      proactiveRefs: [],
      signalFiltered: [],
    });
    expect(out).toBe(merged);
    expect(out.map((r) => r.ref)).toEqual(["memories/a"]);
  });

  test("new forgetting candidates are injected as labelled stubs and deduped", () => {
    const inPool = ref("memories/already-in-pool");
    const lanes = new Map<string, EligibilitySource>();
    const out = applyForgettingSafety({
      pendingForgettingRefs: ["memories/dropped", "memories/already-in-pool"],
      scope: { mode: "all" },
      mergedRefs: [inPool],
      eligibilitySourceByRef: lanes,
      highSalienceRefs: [],
      proactiveRefs: [],
      signalFiltered: [],
    });

    expect(out.map((r) => r.ref)).toEqual(["memories/already-in-pool", "memories/dropped"]);
    const stub = out.find((r) => r.ref === "memories/dropped");
    expect(stub?.eligibilitySource).toBe("forgetting-safety");
    // The pre-existing pool object is the SAME object (stamps travel by reference).
    expect(out[0]).toBe(inPool);
  });

  test("lane precedence: signal-delta > forgetting-safety > proactive/high-salience", () => {
    const dropped = ref("memories/dropped-but-proactive");
    const fresh = ref("memories/dropped-but-fresh");
    const lanes = new Map<string, EligibilitySource>([
      ["memories/dropped-but-proactive", "proactive"],
      ["memories/dropped-but-fresh", "signal-delta"],
    ]);
    const out = applyForgettingSafety({
      pendingForgettingRefs: ["memories/dropped-but-proactive", "memories/dropped-but-fresh"],
      scope: { mode: "all" },
      mergedRefs: [dropped, fresh],
      eligibilitySourceByRef: lanes,
      highSalienceRefs: [],
      proactiveRefs: [dropped],
      signalFiltered: [fresh],
    });

    // Forgetting-safety overrides proactive; signal-delta overrides forgetting-safety.
    expect(lanes.get("memories/dropped-but-proactive")).toBe("forgetting-safety");
    expect(lanes.get("memories/dropped-but-fresh")).toBe("signal-delta");
    expect(out.find((r) => r.ref === "memories/dropped-but-proactive")?.eligibilitySource).toBe("forgetting-safety");
    expect(out.find((r) => r.ref === "memories/dropped-but-fresh")?.eligibilitySource).toBe("signal-delta");
  });
});

describe("buildSnapshotManifest", () => {
  test("empty stash → empty maps and a well-formed 30-day cutoff", () => {
    freshStash();
    const before = Date.now();
    const snap = buildSnapshotManifest({
      postCleanupRefs: [ref("memories/a")],
      validationFailureRefs: new Set(),
      options: { config: {} as AkmConfig },
    });

    expect(snap.latestFeedbackTs.size).toBe(0);
    expect(snap.lastReflectProposalTs.size).toBe(0);
    expect(snap.lastDistillProposalTs.size).toBe(0);
    const cutoffMs = new Date(snap.feedbackSinceCutoff).getTime();
    expect(cutoffMs).toBeGreaterThanOrEqual(before - 30 * 24 * 3600 * 1000 - 5000);
    expect(cutoffMs).toBeLessThanOrEqual(Date.now() - 30 * 24 * 3600 * 1000 + 5000);
  });

  test("validation-failure refs are excluded from the timestamp-map candidate set", () => {
    freshStash();
    // With every ref excluded, the maps are built over an empty candidate list.
    const snap = buildSnapshotManifest({
      postCleanupRefs: [ref("memories/broken")],
      validationFailureRefs: new Set(["memories/broken"]),
      options: { config: {} as AkmConfig },
    });
    expect(snap.latestFeedbackTs.size).toBe(0);
  });
});
