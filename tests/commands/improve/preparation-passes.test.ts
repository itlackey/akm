// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-7.6 — focused unit coverage for the pure preparation-stage passes
 * extracted from `runImprovePreparationStage` (R31 decomposition, testability
 * requirement).
 *
 * `partitionBySignalDelta` (the signal-delta partition read against the
 * improve ledger) is driven directly with in-memory feedback maps and ledger
 * rows — no LLM, no state.db writes — and its returned buckets/attribution
 * are asserted. End-to-end partition behavior stays pinned by
 * `improve-eligibility.test.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { type ImproveLedgerOutcome, type ImproveLedgerRow, ledgerKey } from "../../../src/commands/improve/ledger";
import { buildSnapshotManifest, partitionBySignalDelta } from "../../../src/commands/improve/preparation";
import type { AkmConfig } from "../../../src/core/config/config";
import { appendEvent } from "../../../src/core/events";
import type { ImproveEligibleRef } from "../../../src/core/improve-types";
import { openStateDatabase } from "../../../src/core/state-db";
import { nextEligibleAt, recordImproveLedger } from "../../../src/storage/repositories/improve-ledger-repository";
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

/**
 * A snapshot whose ledger holds one row per recorded attempt, all with
 * `outcome` (default `unchanged`: a revisit window a newer signal lifts), and
 * whose clock sits inside every window the fixtures open. A fixture's feedback
 * is negative unless it passes `latestNegativeTs`: only negative feedback plans
 * a reflect.
 */
function snapshot(overrides: {
  latestFeedbackTs?: Map<string, string>;
  latestNegativeTs?: Map<string, string>;
  lastReflectAttemptAt?: Map<string, string>;
  lastDistillAttemptAt?: Map<string, string>;
  outcome?: ImproveLedgerOutcome;
}) {
  const outcome = overrides.outcome ?? "unchanged";
  const ledger = new Map<string, ImproveLedgerRow>();
  for (const [source, attempts] of [
    ["reflect", overrides.lastReflectAttemptAt],
    ["distill", overrides.lastDistillAttemptAt],
  ] as const) {
    for (const [r, at] of attempts ?? []) {
      ledger.set(ledgerKey(source, r), {
        stashDir: "/stash",
        ref: r,
        source,
        lastAttemptAt: at,
        outcome,
        nextEligibleAt: nextEligibleAt(source, outcome, at),
        proposalId: null,
        detail: null,
        contentHash: null,
      });
    }
  }
  return {
    feedbackSinceCutoff: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
    nowIso: "2026-07-03T00:00:00.000Z",
    latestFeedbackTs: overrides.latestFeedbackTs ?? new Map(),
    latestNegativeTs: overrides.latestNegativeTs ?? overrides.latestFeedbackTs ?? new Map(),
    ledger,
    lastReflectAttemptAt: overrides.lastReflectAttemptAt ?? new Map(),
    lastDistillAttemptAt: overrides.lastDistillAttemptAt ?? new Map(),
  };
}

describe("partitionBySignalDelta — the four buckets", () => {
  const T1 = "2026-07-01T00:00:00.000Z";
  const T2 = "2026-07-02T00:00:00.000Z";

  test("fresh feedback with no prior attempt → eligibleRefs (not cooled)", () => {
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

  test("reflect passes but distill cooled → pure partition metadata only", () => {
    const stash = freshStash();
    // Feedback at T2; reflect attempt older (T1) → reflect passes (the newer
    // signal lifts its revisit window); distill attempt at T2 → distill gate
    // fails. memory: ref is a distill candidate.
    const out = partitionBySignalDelta({
      scope: { mode: "all" },
      options: { stashDir: stash, config: {} as AkmConfig },
      postCleanupRefs: [ref("memories/cooled")],
      validationFailureRefs: new Set(),
      snapshot: snapshot({
        latestFeedbackTs: new Map([["memories/cooled", T2]]),
        lastReflectAttemptAt: new Map([["memories/cooled", T1]]),
        lastDistillAttemptAt: new Map([["memories/cooled", T2]]),
      }),
    });

    expect(out.eligibleRefs.map((r) => r.ref)).toEqual(["memories/cooled"]);
    expect([...out.distillCooledRefs]).toEqual(["memories/cooled"]);
    expect("actions" in out).toBe(false);
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
        lastReflectAttemptAt: new Map([["memories/distill-only", T2]]),
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
    expect("actions" in out).toBe(false);
  });

  test("stale feedback with no delta since the last attempts → pure fully-skipped metadata", () => {
    const stash = freshStash();
    const out = partitionBySignalDelta({
      scope: { mode: "all" },
      options: { stashDir: stash, config: {} as AkmConfig },
      postCleanupRefs: [ref("memories/stale")],
      validationFailureRefs: new Set(),
      snapshot: snapshot({
        latestFeedbackTs: new Map([["memories/stale", T1]]),
        lastReflectAttemptAt: new Map([["memories/stale", T2]]),
        lastDistillAttemptAt: new Map([["memories/stale", T2]]),
      }),
    });

    expect(out.fullySkippedCount).toBe(1);
    expect("actions" in out).toBe(false);
  });

  test("a rejection window holds a ref even after fresh feedback", () => {
    const stash = freshStash();
    const out = partitionBySignalDelta({
      scope: { mode: "all" },
      options: { stashDir: stash, config: {} as AkmConfig },
      postCleanupRefs: [ref("memories/rejected")],
      validationFailureRefs: new Set(),
      snapshot: snapshot({
        latestFeedbackTs: new Map([["memories/rejected", T2]]),
        lastReflectAttemptAt: new Map([["memories/rejected", T1]]),
        lastDistillAttemptAt: new Map([["memories/rejected", T1]]),
        outcome: "rejected",
      }),
    });

    expect(out.eligibleRefs).toEqual([]);
    expect(out.distillOnlyRefs).toEqual([]);
    expect(out.fullySkippedCount).toBe(1);
  });

  test("no feedback but a live revisit window → skipped, not handed to the fallback lanes", () => {
    const stash = freshStash();
    const out = partitionBySignalDelta({
      scope: { mode: "all" },
      options: { stashDir: stash, config: {} as AkmConfig },
      postCleanupRefs: [ref("memories/recently-tried")],
      validationFailureRefs: new Set(),
      snapshot: snapshot({ lastReflectAttemptAt: new Map([["memories/recently-tried", T1]]) }),
    });

    expect(out.noFeedbackPool).toEqual([]);
    expect(out.fullySkippedCount).toBe(1);
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

  test("positive-only feedback never plans reflect: a memory goes to distillOnlyRefs, a skill is skipped", () => {
    const stash = freshStash();
    const out = partitionBySignalDelta({
      scope: { mode: "all" },
      options: { stashDir: stash, config: {} as AkmConfig },
      postCleanupRefs: [ref("memories/helped"), ref("skills/helped")],
      validationFailureRefs: new Set(),
      snapshot: snapshot({
        latestFeedbackTs: new Map([
          ["memories/helped", T2],
          ["skills/helped", T2],
        ]),
        latestNegativeTs: new Map(),
      }),
    });

    expect(out.eligibleRefs).toEqual([]);
    expect(out.distillOnlyRefs.map((r) => r.ref)).toEqual(["memories/helped"]);
    expect(out.noFeedbackPool).toEqual([]);
    expect(out.fullySkippedCount).toBe(1);
  });

  test("negative feedback plans reflect, and a newer positive does not reopen a window the negative closed", () => {
    const stash = freshStash();
    const out = partitionBySignalDelta({
      scope: { mode: "all" },
      options: { stashDir: stash, config: {} as AkmConfig },
      postCleanupRefs: [ref("memories/complained"), ref("memories/praised-after")],
      validationFailureRefs: new Set(),
      snapshot: snapshot({
        latestFeedbackTs: new Map([
          ["memories/complained", T2],
          ["memories/praised-after", T2],
        ]),
        // The second ref's only negative came before the reflect attempt that answered it.
        latestNegativeTs: new Map([
          ["memories/complained", T2],
          ["memories/praised-after", T1],
        ]),
        lastReflectAttemptAt: new Map([["memories/praised-after", "2026-07-01T12:00:00.000Z"]]),
      }),
    });

    expect(out.eligibleRefs.map((r) => r.ref)).toEqual(["memories/complained"]);
    expect(out.distillOnlyRefs.map((r) => r.ref)).toEqual(["memories/praised-after"]);
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

describe("buildSnapshotManifest", () => {
  test("empty stash → empty maps and a well-formed 30-day cutoff", () => {
    const stash = freshStash();
    const before = Date.now();
    const snap = buildSnapshotManifest({
      postCleanupRefs: [ref("memories/a")],
      validationFailureRefs: new Set(),
      stashDir: stash,
    });

    expect(snap.latestFeedbackTs.size).toBe(0);
    expect(snap.ledger.size).toBe(0);
    expect(snap.lastReflectAttemptAt.size).toBe(0);
    expect(snap.lastDistillAttemptAt.size).toBe(0);
    const cutoffMs = new Date(snap.feedbackSinceCutoff).getTime();
    expect(cutoffMs).toBeGreaterThanOrEqual(before - 30 * 24 * 3600 * 1000 - 5000);
    expect(cutoffMs).toBeLessThanOrEqual(Date.now() - 30 * 24 * 3600 * 1000 + 5000);
  });

  test("reads the improve ledger: an attempt keyed by the candidate's item_ref becomes its cursor", () => {
    const stash = freshStash();
    const db = openStateDatabase();
    try {
      recordImproveLedger(db, {
        stashDir: stash,
        ref: "stash//memories/a",
        source: "reflect",
        outcome: "unchanged",
        at: "2026-07-01T00:00:00.000Z",
      });
    } finally {
      db.close();
    }
    const snap = buildSnapshotManifest({
      postCleanupRefs: [ref("memories/a", { itemRef: "stash//memories/a" })],
      validationFailureRefs: new Set(),
      stashDir: stash,
    });

    expect(snap.lastReflectAttemptAt.get("memories/a")).toBe("2026-07-01T00:00:00.000Z");
    expect(snap.lastDistillAttemptAt.size).toBe(0);
  });

  test("only a negative signal in the window is the reflect cursor; a positive or a note is not", () => {
    const stash = freshStash();
    const at = (offsetMs: number) => ({ now: () => Date.now() - offsetMs });
    appendEvent({ eventType: "feedback", ref: "memories/positive", metadata: { signal: "positive" } }, at(3000));
    appendEvent({ eventType: "feedback", ref: "memories/note", metadata: { note: "worked" } }, at(2000));
    appendEvent({ eventType: "feedback", ref: "memories/negative", metadata: { signal: "negative" } }, at(1000));
    appendEvent(
      { eventType: "feedback", ref: "memories/old-negative", metadata: { signal: "negative" } },
      { now: () => Date.now() - 31 * 24 * 3600 * 1000 },
    );

    const snap = buildSnapshotManifest({
      postCleanupRefs: ["positive", "note", "negative", "old-negative"].map((name) => ref(`memories/${name}`)),
      validationFailureRefs: new Set(),
      stashDir: stash,
    });

    expect([...snap.latestFeedbackTs.keys()].sort()).toEqual([
      "memories/negative",
      "memories/note",
      "memories/positive",
    ]);
    expect([...snap.latestNegativeTs.keys()]).toEqual(["memories/negative"]);
  });

  test("validation-failure refs are excluded from the timestamp-map candidate set", () => {
    freshStash();
    // With every ref excluded, the maps are built over an empty candidate list.
    const snap = buildSnapshotManifest({
      postCleanupRefs: [ref("memories/broken")],
      validationFailureRefs: new Set(["memories/broken"]),
    });
    expect(snap.latestFeedbackTs.size).toBe(0);
    expect(snap.latestNegativeTs.size).toBe(0);
  });
});
