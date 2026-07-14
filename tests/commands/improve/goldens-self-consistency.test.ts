// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Golden capture: self-consistency (SC) reflect call-count behavior (WI-02,
 * plan §5 ledger bullet 1 / R1). Chunk 0a brief §2.1, `anchors.md`
 * `loop-stages.ts:116-173` (helpers), `:308-365` (trigger/fan-out/persist).
 *
 * `akm improve` runs N=SC_N (default 3, clamped 2..5) reflect samples in
 * `draftMode` for any ref whose utility score is >= SC_THRESHOLD (default
 * 0.7, `>=` comparison at `loop-stages.ts:311`), then persists only the
 * majority-vote winner as a single real proposal via `createProposal`
 * (`loop-stages.ts:335-359`, `sourceRun: reflect-sc-${Date.now()}`). Below
 * the threshold, reflect runs once, with no `draftMode`.
 *
 * This suite pins the exact call counts and winner-persistence behavior so
 * Chunk 7's deletion of the SC lane (3x -> 1x) has a diff-reviewable before
 * state (plan §12.2 DoD, §12.4). It is capture-only: no `src/` changes.
 *
 * IMPORTANT — stub vs production semantics (brief §2.6 / risk 2):
 *   - `reflectFn` here is a recording stub injected via the sanctioned DI
 *     seam (`AkmImproveOptions.reflectFn`, `improve.ts:412`). It bypasses
 *     the real `akmReflect` entirely, so it NEVER emits a `reflect_invoked`
 *     event. Call counts below come from stub invocations, not events.
 *     Production telemetry sees exactly `SC_N` `reflect_invoked` events per
 *     hot ref (`reflect.ts:953`).
 *   - Because the stub bypasses `akmReflect`, the ONLY proposal-persisting
 *     code path exercised here is the SC winner-persist tail in
 *     `loop-stages.ts` itself (`createProposal` at `:335-359`) — the
 *     non-SC (cold) branch calls the stub directly and never calls
 *     `createProposal`, so a cold ref golden-captures zero persisted
 *     proposals in this harness (a real `akm reflect` invocation would
 *     persist its own non-SC proposal via `akmReflect`'s own
 *     `createProposal` call, which this suite does not exercise).
 *
 * Every case uses a FRESH `withIsolatedAkmStorage()` sandbox (brief step 2 /
 * risk 3) so the SC winner-persist call never diverts into the
 * dedup/cooldown branch (`loop-stages.ts:346-356`), and the default 2h
 * `timeoutMs` budget (never overridden here) so `loop-stages.ts:316`'s
 * budget check never truncates the N-sample loop.
 *
 * Designation: `re-baseline` @ Chunk 7 (`DESIGNATIONS.json`) — Chunk 7
 * deletes the SC lane; this fixture is the reviewed before-state.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmDistillResult } from "../../../src/commands/improve/distill";
import { akmImprove } from "../../../src/commands/improve/improve";
import type { AkmReflectResult } from "../../../src/commands/improve/reflect";
import { listProposals } from "../../../src/commands/proposal/repository";
import { saveConfig } from "../../../src/core/config/config";
import { appendEvent } from "../../../src/core/events";
import { getDbPath } from "../../../src/core/paths";
import { closeDatabase, getAllEntries, openExistingDatabase, upsertUtilityScore } from "../../../src/indexer/db/db";
import { akmIndex } from "../../../src/indexer/indexer";
import { expectGolden } from "../../_helpers/golden";
import { withTestImproveLlm } from "../../_helpers/improve-config";
import { withIsolatedAkmStorage } from "../../_helpers/sandbox";
import {
  memoryRef,
  SC_BOUNDARY_NAME,
  SC_COLD_NAME,
  SC_HOT_NAME,
  SC_MIXED_COLD_A_NAME,
  SC_MIXED_COLD_B_NAME,
  SC_MIXED_HOT_A_NAME,
  SC_MIXED_HOT_B_NAME,
} from "../../fixtures/goldens/improve/fixture-refs";

const GOLDEN_PATH = "tests/fixtures/goldens/improve/self-consistency.json";
const HEAD_SHA = "3d9ee7b1917e8c4872f135fe9993d94b61b36ed1";

function writeMemory(stashDir: string, name: string, body: string): void {
  const filePath = path.join(stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\ndescription: ${name}\n---\n\n${body}\n`, "utf8");
}

async function buildIndex(stashDir: string): Promise<void> {
  saveConfig(withTestImproveLlm({ semanticSearchMode: "off" }));
  await akmIndex({ stashDir, full: true });
}

/**
 * Seed a memory ref's utility score (`db.ts:1402`) — must run AFTER
 * buildIndex(). Production `entries.entry_key` is `<stashDir>:type:name`
 * (see `tests/coverage-hardening/db-ref-resolution.test.ts:55`), so this
 * resolves the entry id via `getAllEntries` + a `type`/`name` match — mirrors
 * `buildUtilityMap`'s own resolution (`eligibility.ts:467-495`) — rather than
 * `getEntryByRef`, which only matches the (non-production) bare-key shape.
 */
function seedUtility(name: string, utility: number): void {
  const db = openExistingDatabase(getDbPath());
  try {
    const found = getAllEntries(db, "memory").find((indexed) => indexed.entry.name === name);
    if (!found) {
      throw new Error(`[goldens-self-consistency] no indexed entry for memory:${name} — seed after buildIndex()`);
    }
    upsertUtilityScore(db, found.id, { utility, showCount: 0, searchCount: 0, selectRate: 0 });
  } finally {
    closeDatabase(db);
  }
}

// Config that isolates the signal-delta/SC gates from the default-ON
// proactive-maintenance lane (which would otherwise also select these
// never-reflected refs and add unrelated reflect calls to the count) —
// pattern from tests/commands/improve/improve-eligibility.test.ts:93.
// minPoolSize:0 is harmless here: semanticSearchMode:"off" (buildIndex)
// keeps consolidate's plan phase a deterministic no-op (no clusters to
// judge), so it never needs an LLM stub even on the runs where it executes
// for real (WI-05 brief step 1 note documents the same property).
function configWithoutPoolGuard(): import("../../../src/core/config/config").AkmConfig {
  return withTestImproveLlm({
    semanticSearchMode: "off",
    improve: {
      strategies: {
        default: { processes: { consolidate: { minPoolSize: 0 }, proactiveMaintenance: { enabled: false } } },
      },
    },
  } as import("../../../src/core/config/config").AkmConfig);
}

interface RecordedCall {
  ref: string;
  /** `null` normalizes the "option key absent" case (JSON can't hold `undefined`). */
  draftMode: boolean | null;
}

/** Give each SC sample distinguishable content (pickMajorityVote tie-break is otherwise irrelevant to this suite). */
function makeReflectResult(ref: string, sampleIndex: number): AkmReflectResult {
  return {
    schemaVersion: 2,
    ok: true,
    proposal: {
      id: `p-${ref.replace(/[^a-z0-9]/gi, "-")}-${sampleIndex}`,
      ref,
      status: "pending",
      source: "reflect",
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      payload: { content: `# proposal sample ${sampleIndex}\n\nCandidate body for ${ref}.` },
    },
    ref,
    engine: "test",
    durationMs: 1,
  };
}

const okDistill = (ref: string): AkmDistillResult => ({
  schemaVersion: 1,
  ok: true,
  outcome: "queued",
  inputRef: ref,
  lessonRef: `lesson:${ref.replace(/[:/]/g, "-")}-lesson`,
});

/** Make `ref` reflect-eligible via the signal-delta gate (feedback, no prior reflect_invoked). */
function seedFeedbackSignal(ref: string): void {
  appendEvent({ eventType: "feedback", ref, metadata: { signal: "negative" } });
}

/** SC-proposal count for `ref` (or all refs when omitted) in `stash`. */
function countScProposals(stash: string, ref?: string): number {
  return listProposals(stash, { includeArchive: true, ...(ref ? { ref } : {}) }).filter((p) =>
    (p.sourceRun ?? "").startsWith("reflect-sc-"),
  ).length;
}

/**
 * Run akmImprove over a single fresh-sandbox ref at the given utility,
 * recording every reflectFn call. Cleans up its own sandbox before
 * returning, so the returned `scProposalCount` is computed up front (the
 * stash is gone by the time the caller sees the result).
 */
async function runSingleRefCase(
  name: string,
  utility: number,
): Promise<{ calls: RecordedCall[]; scProposalCount: number }> {
  const storage = withIsolatedAkmStorage();
  try {
    const ref = memoryRef(name);
    writeMemory(storage.stashDir, name, `Content for ${name}.`);
    await buildIndex(storage.stashDir);
    seedFeedbackSignal(ref);
    seedUtility(name, utility);

    const calls: RecordedCall[] = [];
    let sampleIndex = 0;
    await akmImprove({
      scope: "memory",
      stashDir: storage.stashDir,
      config: configWithoutPoolGuard(),
      minRetrievalCount: 0,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async (opts) => {
        calls.push({ ref: opts.ref ?? "", draftMode: opts.draftMode ?? null });
        return makeReflectResult(opts.ref ?? "", sampleIndex++);
      },
      distillFn: async ({ ref: r }) => okDistill(r ?? ""),
    });

    return { calls, scProposalCount: countScProposals(storage.stashDir, ref) };
  } finally {
    storage.cleanup();
  }
}

/** Run the 2-hot/2-cold mixed scenario; returns per-ref call counts + total SC proposal count. */
async function runMixedCase(): Promise<{
  countByRef: Record<"hotA" | "hotB" | "coldA" | "coldB", number>;
  totalScProposalCount: number;
}> {
  const storage = withIsolatedAkmStorage();
  try {
    const hotA = memoryRef(SC_MIXED_HOT_A_NAME);
    const hotB = memoryRef(SC_MIXED_HOT_B_NAME);
    const coldA = memoryRef(SC_MIXED_COLD_A_NAME);
    const coldB = memoryRef(SC_MIXED_COLD_B_NAME);

    for (const name of [SC_MIXED_HOT_A_NAME, SC_MIXED_HOT_B_NAME, SC_MIXED_COLD_A_NAME, SC_MIXED_COLD_B_NAME]) {
      writeMemory(storage.stashDir, name, `Content for ${name}.`);
    }
    await buildIndex(storage.stashDir);
    for (const ref of [hotA, hotB, coldA, coldB]) seedFeedbackSignal(ref);
    seedUtility(SC_MIXED_HOT_A_NAME, 0.9);
    seedUtility(SC_MIXED_HOT_B_NAME, 0.85);
    seedUtility(SC_MIXED_COLD_A_NAME, 0.2);
    seedUtility(SC_MIXED_COLD_B_NAME, 0.5);

    const calls: RecordedCall[] = [];
    let sampleIndex = 0;
    await akmImprove({
      scope: "memory",
      stashDir: storage.stashDir,
      config: configWithoutPoolGuard(),
      minRetrievalCount: 0,
      ensureIndexFn: async () => false,
      reindexFn: async () => ({ schemaVersion: 1, ok: true, indexed: 0, warnings: [], errors: [], durationMs: 0 }),
      reflectFn: async (opts) => {
        calls.push({ ref: opts.ref ?? "", draftMode: opts.draftMode ?? null });
        return makeReflectResult(opts.ref ?? "", sampleIndex++);
      },
      distillFn: async ({ ref: r }) => okDistill(r ?? ""),
    });

    const countByRef = (ref: string) => calls.filter((c) => c.ref === ref).length;
    return {
      countByRef: {
        hotA: countByRef(hotA),
        hotB: countByRef(hotB),
        coldA: countByRef(coldA),
        coldB: countByRef(coldB),
      },
      totalScProposalCount: countScProposals(storage.stashDir),
    };
  } finally {
    storage.cleanup();
  }
}

describe("goldens: improve self-consistency call counts (WI-02, R1)", () => {
  test("utility 0.9 (hot) -> exactly 3 draftMode:true calls, 1 persisted reflect-sc- proposal", async () => {
    const { calls, scProposalCount } = await runSingleRefCase(SC_HOT_NAME, 0.9);
    const ref = memoryRef(SC_HOT_NAME);

    expect(calls.length).toBe(3);
    expect(calls.every((c) => c.ref === ref)).toBe(true);
    expect(calls.every((c) => c.draftMode === true)).toBe(true);
    expect(scProposalCount).toBe(1);
  });

  test("utility 0.3 (cold) -> exactly 1 call, no draftMode, 0 persisted proposals", async () => {
    const { calls, scProposalCount } = await runSingleRefCase(SC_COLD_NAME, 0.3);
    const ref = memoryRef(SC_COLD_NAME);

    expect(calls.length).toBe(1);
    expect(calls[0]?.ref).toBe(ref);
    expect(calls[0]?.draftMode).toBeNull();
    expect(scProposalCount).toBe(0);
  });

  test("boundary utility exactly 0.7 -> 3 calls (>= comparison, loop-stages.ts:311)", async () => {
    const { calls, scProposalCount } = await runSingleRefCase(SC_BOUNDARY_NAME, 0.7);

    expect(calls.length).toBe(3);
    expect(calls.every((c) => c.draftMode === true)).toBe(true);
    expect(scProposalCount).toBe(1);
  });

  test("mixed run (2 hot + 2 cold) -> per-ref call-count histogram + total proposal count", async () => {
    const { countByRef, totalScProposalCount } = await runMixedCase();

    expect(countByRef.hotA).toBe(3);
    expect(countByRef.hotB).toBe(3);
    expect(countByRef.coldA).toBe(1);
    expect(countByRef.coldB).toBe(1);
    expect(totalScProposalCount).toBe(2);
  });

  // Re-runs every scenario above (fresh sandboxes) purely to assemble the
  // committed golden fixture — kept independent of the assertion tests above
  // so this capture never depends on bun:test's within-file execution order.
  test("golden fixture: serialize all self-consistency scenarios", async () => {
    const hot = await runSingleRefCase(SC_HOT_NAME, 0.9);
    const cold = await runSingleRefCase(SC_COLD_NAME, 0.3);
    const boundary = await runSingleRefCase(SC_BOUNDARY_NAME, 0.7);
    const mixed = await runMixedCase();

    expectGolden(GOLDEN_PATH, {
      scenario: "improve self-consistency (SC) reflect call counts + winner persistence (WI-02, R1)",
      capturedAtHead: HEAD_SHA,
      config: { selfConsistencyThreshold: 0.7, selfConsistencyN: 3, note: "programmatic defaults, not overridden" },
      notes: [
        "reflectFn is a recording stub that bypasses akmReflect entirely, so no reflect_invoked events are emitted " +
          "by these captures -- call counts come from stub invocations only. Production telemetry sees exactly " +
          "SC_N reflect_invoked events per hot ref (reflect.ts:953). Re-measured anchors: " +
          "docs/design/execution/chunk-0a/anchors.md.",
        "Designation: re-baseline @ Chunk 7 (DESIGNATIONS.json) -- Chunk 7 deletes the self-consistency lane " +
          "(3x -> 1x single call) and this fixture is the reviewed before-state the diff review verifies against.",
      ],
      cases: {
        hotUtility0_9: {
          utility: 0.9,
          callCount: hot.calls.length,
          allCallsDraftModeTrue: hot.calls.every((c) => c.draftMode === true),
          persistedProposalCount: hot.scProposalCount,
          persistedSourceRunPrefix: "reflect-sc-",
        },
        coldUtility0_3: {
          utility: 0.3,
          callCount: cold.calls.length,
          allCallsDraftModeTrue: cold.calls.every((c) => c.draftMode === true),
          persistedProposalCount: cold.scProposalCount,
        },
        boundaryUtility0_7: {
          utility: 0.7,
          callCount: boundary.calls.length,
          allCallsDraftModeTrue: boundary.calls.every((c) => c.draftMode === true),
          persistedProposalCount: boundary.scProposalCount,
          persistedSourceRunPrefix: "reflect-sc-",
          note: ">= comparison at loop-stages.ts:311 -- 0.7 triggers SC",
        },
        mixedRun: {
          refs: {
            hotA: { name: SC_MIXED_HOT_A_NAME, utility: 0.9, callCount: mixed.countByRef.hotA },
            hotB: { name: SC_MIXED_HOT_B_NAME, utility: 0.85, callCount: mixed.countByRef.hotB },
            coldA: { name: SC_MIXED_COLD_A_NAME, utility: 0.2, callCount: mixed.countByRef.coldA },
            coldB: { name: SC_MIXED_COLD_B_NAME, utility: 0.5, callCount: mixed.countByRef.coldB },
          },
          totalPersistedProposalCount: mixed.totalScProposalCount,
        },
      },
    });
  });
});
