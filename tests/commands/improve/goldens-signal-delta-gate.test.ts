// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Golden capture: the signal-delta gate (WI-06, plan §11 Chunk 0a / R5, §6
 * preserve list). Chunk 0a brief §2.3/§2.1, `anchors.md`
 * `eligibility.ts:349` (`buildLatestFeedbackTsMap`), `:382`
 * (`buildLatestProposalTsMap`), `:421-431` (`isSignalDeltaEligible`);
 * partition wiring `preparation.ts:1030-1153`.
 *
 * The signal-delta gate is the ONE piece of `runImprovePreparationStage`'s
 * eligibility machinery that plan §6 explicitly says SURVIVES Chunk 7's
 * deletion of the P0-A high-retrieval lane and self-consistency voting (both
 * pinned separately, and deliberately, by WI-02's
 * `goldens-self-consistency.test.ts` / `goldens-p0a-selection.test.ts`, each
 * designated `re-baseline` @ 7). This suite therefore pins:
 *
 *   1. `isSignalDeltaEligible`'s truth table directly (pure function, no I/O).
 *   2. `buildLatestFeedbackTsMap`'s signal/note metadata filter + max-ts-per-ref
 *      + `since` cutoff behavior (state.db-backed, via `appendEvent`/the
 *      function itself -- no `akmImprove` needed).
 *   3. `buildLatestProposalTsMap`'s cursor rules: `reflect_invoked` always
 *      counts; `distill_invoked` counts ONLY for `outcome` in
 *      `{queued, skipped, validation_failed}` (a `llm_failed` distill attempt
 *      must NOT move the cursor).
 *   4. The `eligibleRefs`/`distillOnlyRefs`/`noFeedbackPool` partition COUNTS
 *      from one full `akmImprove` preparation run -- deliberately COUNTS
 *      only. Per brief Risk 9 / acceptance: this suite must not pin P0-A lane
 *      membership or SC voting internals (Chunk 7 deletes both), so the
 *      partition scenario below runs with `proactiveMaintenance` disabled and
 *      zero retrievals/salience seeded so ONLY the signal-delta gate can ever
 *      select a ref -- every selected ref is asserted to carry
 *      `eligibilitySource:'signal-delta'` (part of the preserved GATE's own
 *      vocabulary, not a P0-A-specific selection algorithm) but individual
 *      ref-to-lane membership beyond that single tag is never asserted.
 *
 * Terminology note: the work-item acceptance criterion and the top-level plan
 * (architecture plan §6 / bundle-adapter-spec.md :376) both name this surface
 * "the LOOK/CHANGE separation and signal-delta corrective-evidence gate" --
 * that phrase is never defined operationally anywhere in this chunk's brief
 * (docs/design/execution/chunk-0a/brief.md), whose own WI-06 testsFirst/steps
 * sections operationalize the SAME surface exclusively in terms of the
 * `eligibleRefs`/`distillOnlyRefs`/`noFeedbackPool` partition pinned above.
 * This suite follows the brief's concrete, actionable operationalization (the
 * higher authority per this work's instructions where the plan is abstract
 * and the brief is concrete); no separate "LOOK" vs "CHANGE" boolean/count
 * exists anywhere in the codebase for this suite to pin in addition to the
 * partition it already captures.
 *
 * ## Code-organization note (see goldens-consolidate-journal.test.ts's header
 * for the same convention, adopted here too): `capture*` helpers are single,
 * self-contained, idempotent functions (fresh sandbox in, fresh sandbox torn
 * down on exit). Assertion `test()` blocks and the final golden-serializing
 * test both call the SAME helper -- never a hand-duplicated copy -- so the
 * golden capture cannot depend on which subset of tests bun:test executed.
 *
 * ## Designation
 *
 * `frozen-migration-input` (`DESIGNATIONS.json`) -- the gate survives Chunk 7
 * per §6's binding preserve list. No ref literals are embedded in the
 * committed fixture beyond fixture-local names sourced from
 * `tests/fixtures/goldens/improve/fixture-refs.ts` (already the shared
 * constants module for this area, per brief §3.2 rule 3).
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmDistillResult } from "../../../src/commands/improve/distill";
import {
  buildLatestFeedbackTsMap,
  buildLatestProposalTsMap,
  isSignalDeltaEligible,
} from "../../../src/commands/improve/eligibility";
import { akmImprove } from "../../../src/commands/improve/improve";
import type { AkmReflectResult } from "../../../src/commands/improve/reflect";
import type { AkmConfig } from "../../../src/core/config/config";
import { saveConfig } from "../../../src/core/config/config";
import { appendEvent } from "../../../src/core/events";
import { akmIndex } from "../../../src/indexer/indexer";
import { expectGolden } from "../../_helpers/golden";
import { withTestImproveLlm } from "../../_helpers/improve-config";
import { withIsolatedAkmStorage } from "../../_helpers/sandbox";
import {
  memoryRef,
  SDG_DISTILL_ONLY_NAME,
  SDG_ELIGIBLE_A_NAME,
  SDG_ELIGIBLE_B_NAME,
  SDG_FEEDBACK_MAP_NAME,
  SDG_NO_FEEDBACK_A_NAME,
  SDG_NO_FEEDBACK_B_NAME,
  SDG_PROPOSAL_MAP_NAME,
} from "../../fixtures/goldens/improve/fixture-refs";

const GOLDEN_PATH = "tests/fixtures/goldens/improve/signal-delta-gate.json";
const HEAD_SHA = "3d9ee7b1917e8c4872f135fe9993d94b61b36ed1";

// Strictly-ordered deterministic timestamps (injected via appendEvent's `now`
// option), same pattern as tests/commands/improve/improve-eligibility.test.ts.
const T_OLDEST = Date.now() - 4 * 60_000;
const T_OLDER = Date.now() - 3 * 60_000;
const T_NEWER = Date.now() - 2 * 60_000;
const T_NEWEST = Date.now() - 60_000;
const EPOCH_ISO = new Date(0).toISOString();

function configWithoutPoolGuard(): AkmConfig {
  return withTestImproveLlm({
    semanticSearchMode: "off",
    improve: {
      strategies: {
        default: { processes: { consolidate: { minPoolSize: 0 }, proactiveMaintenance: { enabled: false } } },
      },
    },
  } as AkmConfig);
}

function writeMemory(stashDir: string, name: string, body: string): void {
  const filePath = path.join(stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\ndescription: ${name}\n---\n\n${body}\n`, "utf8");
}

const okReflect = (ref: string): AkmReflectResult => ({
  schemaVersion: 2,
  ok: true,
  proposal: {
    id: `p-${ref.replace(/[^a-z0-9]/gi, "-")}`,
    ref,
    status: "pending",
    source: "reflect",
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
    payload: { content: "# proposal" },
    changes: [{ path: "", after: "# proposal", op: "update" }],
  },
  ref,
  engine: "test",
  durationMs: 1,
});

const okDistill = (ref: string): AkmDistillResult => ({
  schemaVersion: 1,
  ok: true,
  outcome: "queued",
  inputRef: ref,
  lessonRef: `lesson:${ref.replace(/[:/]/g, "-")}-lesson`,
});

// ── isSignalDeltaEligible truth table (pure function, eligibility.ts:421-431) ─

describe("isSignalDeltaEligible truth table (eligibility.ts:421-431)", () => {
  const REF = memoryRef("sdg-truth-table-ref");
  const T1 = "2026-01-01T00:00:00.000Z";
  const T2 = "2026-02-01T00:00:00.000Z";

  test("no feedback at all -> ineligible, regardless of prior proposal", () => {
    expect(isSignalDeltaEligible(REF, new Map(), new Map())).toBe(false);
    expect(isSignalDeltaEligible(REF, new Map(), new Map([[REF, T1]]))).toBe(false);
  });

  test("feedback present, no prior proposal at all -> eligible", () => {
    expect(isSignalDeltaEligible(REF, new Map([[REF, T1]]), new Map())).toBe(true);
  });

  test("feedback strictly newer than the prior proposal -> eligible", () => {
    expect(isSignalDeltaEligible(REF, new Map([[REF, T2]]), new Map([[REF, T1]]))).toBe(true);
  });

  test("feedback exactly equal to the prior proposal ts -> ineligible (strict >, not >=)", () => {
    expect(isSignalDeltaEligible(REF, new Map([[REF, T1]]), new Map([[REF, T1]]))).toBe(false);
  });

  test("feedback older than the prior proposal -> ineligible", () => {
    expect(isSignalDeltaEligible(REF, new Map([[REF, T1]]), new Map([[REF, T2]]))).toBe(false);
  });
});

// ── buildLatestFeedbackTsMap signal/note filter (eligibility.ts:349) ───────

describe("buildLatestFeedbackTsMap signal/note filter (eligibility.ts:349)", () => {
  test("metadata.signal counts as signal", () => {
    const storage = withIsolatedAkmStorage();
    try {
      const ref = memoryRef(SDG_FEEDBACK_MAP_NAME);
      appendEvent({ eventType: "feedback", ref, metadata: { signal: "positive" } }, { now: () => T_NEWER });
      expect(buildLatestFeedbackTsMap([ref], EPOCH_ISO).has(ref)).toBe(true);
    } finally {
      storage.cleanup();
    }
  });

  test("metadata.note counts as signal", () => {
    const storage = withIsolatedAkmStorage();
    try {
      const ref = memoryRef(SDG_FEEDBACK_MAP_NAME);
      appendEvent({ eventType: "feedback", ref, metadata: { note: "a free-form annotation" } }, { now: () => T_NEWER });
      expect(buildLatestFeedbackTsMap([ref], EPOCH_ISO).has(ref)).toBe(true);
    } finally {
      storage.cleanup();
    }
  });

  test("empty metadata object does NOT count as signal", () => {
    const storage = withIsolatedAkmStorage();
    try {
      const ref = memoryRef(SDG_FEEDBACK_MAP_NAME);
      appendEvent({ eventType: "feedback", ref, metadata: {} }, { now: () => T_NEWER });
      expect(buildLatestFeedbackTsMap([ref], EPOCH_ISO).has(ref)).toBe(false);
    } finally {
      storage.cleanup();
    }
  });

  test("event with no metadata at all does NOT count as signal", () => {
    const storage = withIsolatedAkmStorage();
    try {
      const ref = memoryRef(SDG_FEEDBACK_MAP_NAME);
      appendEvent({ eventType: "feedback", ref }, { now: () => T_NEWER });
      expect(buildLatestFeedbackTsMap([ref], EPOCH_ISO).has(ref)).toBe(false);
    } finally {
      storage.cleanup();
    }
  });

  test("keeps the MAX ts across multiple signal events for the same ref", () => {
    const storage = withIsolatedAkmStorage();
    try {
      const ref = memoryRef(SDG_FEEDBACK_MAP_NAME);
      appendEvent({ eventType: "feedback", ref, metadata: { signal: "negative" } }, { now: () => T_OLDER });
      appendEvent({ eventType: "feedback", ref, metadata: { signal: "positive" } }, { now: () => T_NEWEST });
      const map = buildLatestFeedbackTsMap([ref], EPOCH_ISO);
      expect(map.get(ref)).toBe(new Date(T_NEWEST).toISOString());
    } finally {
      storage.cleanup();
    }
  });

  test("`since` excludes events strictly older than the cutoff", () => {
    const storage = withIsolatedAkmStorage();
    try {
      const ref = memoryRef(SDG_FEEDBACK_MAP_NAME);
      appendEvent({ eventType: "feedback", ref, metadata: { signal: "positive" } }, { now: () => T_OLDEST });
      const cutoff = new Date(T_NEWER).toISOString();
      expect(buildLatestFeedbackTsMap([ref], cutoff).has(ref)).toBe(false);
    } finally {
      storage.cleanup();
    }
  });
});

// ── buildLatestProposalTsMap cursor rules (eligibility.ts:382) ─────────────

describe("buildLatestProposalTsMap cursor rules (eligibility.ts:382)", () => {
  test("reflect_invoked always counts, regardless of metadata", () => {
    const storage = withIsolatedAkmStorage();
    try {
      const ref = memoryRef(SDG_PROPOSAL_MAP_NAME);
      appendEvent({ eventType: "reflect_invoked", ref }, { now: () => T_NEWER });
      expect(buildLatestProposalTsMap([ref], "reflect").has(ref)).toBe(true);
    } finally {
      storage.cleanup();
    }
  });

  test.each(["queued", "skipped", "validation_failed"])('distill_invoked with outcome "%s" counts', (outcome) => {
    const storage = withIsolatedAkmStorage();
    try {
      const ref = memoryRef(SDG_PROPOSAL_MAP_NAME);
      appendEvent({ eventType: "distill_invoked", ref, metadata: { outcome } }, { now: () => T_NEWER });
      expect(buildLatestProposalTsMap([ref], "distill").has(ref)).toBe(true);
    } finally {
      storage.cleanup();
    }
  });

  test('distill_invoked with outcome "llm_failed" does NOT move the cursor', () => {
    const storage = withIsolatedAkmStorage();
    try {
      const ref = memoryRef(SDG_PROPOSAL_MAP_NAME);
      appendEvent({ eventType: "distill_invoked", ref, metadata: { outcome: "llm_failed" } }, { now: () => T_NEWER });
      expect(buildLatestProposalTsMap([ref], "distill").has(ref)).toBe(false);
    } finally {
      storage.cleanup();
    }
  });

  test("keeps the MAX ts across multiple qualifying events for the same ref", () => {
    const storage = withIsolatedAkmStorage();
    try {
      const ref = memoryRef(SDG_PROPOSAL_MAP_NAME);
      appendEvent({ eventType: "reflect_invoked", ref }, { now: () => T_OLDER });
      appendEvent({ eventType: "reflect_invoked", ref }, { now: () => T_NEWEST });
      const map = buildLatestProposalTsMap([ref], "reflect");
      expect(map.get(ref)).toBe(new Date(T_NEWEST).toISOString());
    } finally {
      storage.cleanup();
    }
  });
});

// ── eligibleRefs/distillOnlyRefs/noFeedbackPool partition COUNTS ───────────
//
// Isolation: proactiveMaintenance disabled (configWithoutPoolGuard) and zero
// retrievals/salience seeded for every ref -> P0-A and high-salience can
// never fire (their gates require retrievalCount>0 / a content-scored
// asset_salience row respectively, neither of which exists here). The ONLY
// mechanism that can select any ref below is the signal-delta gate itself.

async function capturePartitionCounts(): Promise<Record<string, unknown>> {
  const storage = withIsolatedAkmStorage();
  try {
    const stash = storage.stashDir;
    const cfg = configWithoutPoolGuard();
    saveConfig(cfg);

    for (const name of [
      SDG_ELIGIBLE_A_NAME,
      SDG_ELIGIBLE_B_NAME,
      SDG_DISTILL_ONLY_NAME,
      SDG_NO_FEEDBACK_A_NAME,
      SDG_NO_FEEDBACK_B_NAME,
    ]) {
      writeMemory(stash, name, `${name} body content, long enough to be a realistic indexed memory.`);
    }
    await akmIndex({ stashDir: stash, full: true });

    // Group A (eligibleRefs): feedback signal, no prior reflect/distill
    // proposal at all -> both gates pass -> eligibleRefs.
    appendEvent(
      { eventType: "feedback", ref: memoryRef(SDG_ELIGIBLE_A_NAME), metadata: { signal: "positive" } },
      { now: () => T_NEWER },
    );
    appendEvent(
      { eventType: "feedback", ref: memoryRef(SDG_ELIGIBLE_B_NAME), metadata: { signal: "positive" } },
      { now: () => T_NEWER },
    );

    // Group B (distillOnlyRef): stale feedback + a NEWER reflect_invoked
    // (reflect blocked) but NO distill_invoked at all (distill stays open) ->
    // distillOnlyRefs.
    appendEvent(
      { eventType: "feedback", ref: memoryRef(SDG_DISTILL_ONLY_NAME), metadata: { signal: "negative" } },
      { now: () => T_OLDER },
    );
    appendEvent({ eventType: "reflect_invoked", ref: memoryRef(SDG_DISTILL_ONLY_NAME) }, { now: () => T_NEWER });

    // Group C (noFeedbackPool): zero feedback events, zero retrievals ->
    // deliberately nothing appended.

    const reflectSeen = new Map<string, string | undefined>();
    const distillSeen = new Map<string, string | undefined>();

    const result = await akmImprove({
      scope: "memory",
      stashDir: stash,
      config: cfg,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async ({ ref, eligibilitySource }) => {
        if (ref) reflectSeen.set(ref, eligibilitySource);
        return okReflect(ref ?? "");
      },
      distillFn: async ({ ref, eligibilitySource }) => {
        if (ref) distillSeen.set(ref, eligibilitySource);
        return okDistill(ref ?? "");
      },
    });

    const plannedRefs = result.plannedRefs.map((r) => r.ref);
    const noFeedbackRefs = [memoryRef(SDG_NO_FEEDBACK_A_NAME), memoryRef(SDG_NO_FEEDBACK_B_NAME)];
    const distillOnlyCount = [...distillSeen.keys()].filter((r) => !reflectSeen.has(r)).length;

    return {
      eligibleRefsCount: reflectSeen.size,
      distillOnlyRefsCount: distillOnlyCount,
      noFeedbackPoolCount: noFeedbackRefs.length,
      plannedRefsCount: plannedRefs.length,
      allPlannedRefsTaggedSignalDelta: result.plannedRefs.every((r) => r.eligibilitySource === "signal-delta"),
      noFeedbackRefsExcludedFromReflect: noFeedbackRefs.every((r) => !reflectSeen.has(r)),
      noFeedbackRefsExcludedFromDistill: noFeedbackRefs.every((r) => !distillSeen.has(r)),
      noFeedbackRefsExcludedFromPlanned: noFeedbackRefs.every((r) => !plannedRefs.includes(r)),
      eligibleRefsAlsoInPlanned: [...reflectSeen.keys()].every((r) => plannedRefs.includes(r)),
    };
  } finally {
    storage.cleanup();
  }
}

describe("eligibleRefs/distillOnlyRefs/noFeedbackPool partition counts (preparation.ts:1030-1153)", () => {
  test("2 eligible + 1 distill-only + 2 excluded no-feedback refs", async () => {
    const captured = await capturePartitionCounts();
    expect(captured.eligibleRefsCount).toBe(2);
    expect(captured.distillOnlyRefsCount).toBe(1);
    expect(captured.noFeedbackPoolCount).toBe(2);
    expect(captured.plannedRefsCount).toBe(3);
    expect(captured.allPlannedRefsTaggedSignalDelta).toBe(true);
    expect(captured.noFeedbackRefsExcludedFromReflect).toBe(true);
    expect(captured.noFeedbackRefsExcludedFromDistill).toBe(true);
    expect(captured.noFeedbackRefsExcludedFromPlanned).toBe(true);
    expect(captured.eligibleRefsAlsoInPlanned).toBe(true);
  });
});

// ── Golden fixture: serialize every scenario above ─────────────────────────

test("golden fixture: signal-delta-gate.json", async () => {
  const TT_REF = "memory:truth-table";
  const truthTableCases: Array<{ fb: string | undefined; lp: string | undefined }> = [
    { fb: undefined, lp: undefined },
    { fb: undefined, lp: "2026-01-01T00:00:00.000Z" },
    { fb: "2026-01-01T00:00:00.000Z", lp: undefined },
    { fb: "2026-02-01T00:00:00.000Z", lp: "2026-01-01T00:00:00.000Z" },
    { fb: "2026-01-01T00:00:00.000Z", lp: "2026-01-01T00:00:00.000Z" },
    { fb: "2026-01-01T00:00:00.000Z", lp: "2026-02-01T00:00:00.000Z" },
  ];
  const truthTable = truthTableCases.map(({ fb, lp }) => ({
    latestFeedback: fb ?? null,
    lastProposal: lp ?? null,
    eligible: isSignalDeltaEligible(
      TT_REF,
      fb ? new Map([[TT_REF, fb]]) : new Map(),
      lp ? new Map([[TT_REF, lp]]) : new Map(),
    ),
  }));

  const partitionCounts = await capturePartitionCounts();

  expectGolden(GOLDEN_PATH, {
    scenario:
      "signal-delta gate (§6 preserve list): truth table + feedback/proposal cursor maps + partition counts (WI-06, R5)",
    capturedAtHead: HEAD_SHA,
    notes: [
      "This gate SURVIVES Chunk 7's deletion of the P0-A high-retrieval lane and self-consistency voting -- it is the " +
        "one piece of eligibility machinery this suite pins as frozen-migration-input rather than re-baseline @ 7.",
      "The partition-counts scenario deliberately isolates the signal-delta gate from every other selection lane " +
        "(proactiveMaintenance disabled; zero retrievals/salience seeded) and asserts COUNTS + the shared " +
        "'signal-delta' eligibilitySource tag only -- P0-A lane membership and SC voting internals are out of scope " +
        "for this suite (brief Risk 9); see goldens-self-consistency.test.ts / goldens-p0a-selection.test.ts (WI-02, " +
        "designated re-baseline @ 7) for those.",
      "Contains only fixture-local ref names (tests/fixtures/goldens/improve/fixture-refs.ts), booleans, and counts -- " +
        "no production refs.",
    ],
    isSignalDeltaEligibleTruthTable: truthTable,
    partitionCounts,
  });
});
