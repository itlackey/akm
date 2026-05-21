/**
 * Tests for the akm-eval `planner-waste` runner — the case that detects
 * when the improve pipeline planner queues actions immediately refused
 * as no-ops by the underlying command (e.g. distill being asked to run
 * against `lesson:*` refs).
 *
 * Covers:
 *   - noOpRefuse detection against the canonical
 *     "Distill refuses lesson inputs — ..." shape.
 *   - noOpRefuse detection generically against any "X refuses Y" /
 *     "X rejects Y" message (case-insensitive, word-boundary).
 *   - `mode === "*-skipped"` is NOT llmTouched (pre-filtered) and is
 *     NOT a refuse.
 *   - llmTouched denominator + rate arithmetic.
 *   - threshold-skip when `totalActions < minActions`.
 *   - top-10 reasons cap with stable sort.
 *   - per-reason sample evidence cap at 3.
 *   - end-to-end runner against fixture improve-result.json files
 *     staged under a tmpdir-staged stash.
 */

import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  aggregatePlannerActions,
  type ClassifiedPlannerAction,
  classifyPlannerAction,
  collectPlannerActions,
  type PlannerActionInput,
  runPlannerWasteCase,
} from "../scripts/akm-eval/src/runners/planner-waste";
import type { EvalCase, EvalContext } from "../scripts/akm-eval/src/types";

const createdTmpDirs: string[] = [];

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTmpStash(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-eval-planner-waste-"));
  createdTmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, ".akm", "runs"), { recursive: true });
  return dir;
}

function writeImproveRun(stashRoot: string, runId: string, actions: PlannerActionInput[]): void {
  const dir = path.join(stashRoot, ".akm", "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  const envelope = { schemaVersion: 1, ok: true, actions };
  fs.writeFileSync(path.join(dir, "improve-result.json"), `${JSON.stringify(envelope, null, 2)}\n`);
}

function makeCtx(stashRoot: string): EvalContext {
  return {
    stashRoot,
    dataDir: path.join(stashRoot, ".akm", "data"),
    akmBin: "akm",
    casesRoot: path.join(stashRoot, "cases"),
    outRoot: path.join(stashRoot, "out"),
    keepSandbox: false,
    env: {},
  };
}

function makeCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    schemaVersion: 1,
    id: "test-planner-waste-breakdown",
    suite: "improve-smoke",
    type: "planner-waste",
    description: "test case",
    input: { windowRuns: 100 },
    expected: {},
    ...overrides,
  };
}

// The canonical refuse shape currently in flight, lifted verbatim from
// src/commands/distill.ts and observed in ~/akm/.akm/runs/.
const DISTILL_REFUSE_MESSAGE = "Distill refuses lesson inputs — lessons are the distilled form, not a source.";

describe("classifyPlannerAction", () => {
  test("flags the canonical distill-refuses-lesson shape as noOpRefuse", () => {
    const result = classifyPlannerAction(
      {
        mode: "distill",
        ref: "lesson:foo",
        result: { ok: true, outcome: "skipped", message: DISTILL_REFUSE_MESSAGE },
      },
      "run-1",
    );
    expect(result.noOpRefuse).toBe(true);
    expect(result.llmTouched).toBe(true);
    expect(result.mode).toBe("distill");
    expect(result.ref).toBe("lesson:foo");
  });

  test("flags generic 'X refuses Y' shapes as noOpRefuse (case-insensitive)", () => {
    const result = classifyPlannerAction(
      {
        mode: "consolidate",
        ref: "skill:bar",
        result: {
          ok: true,
          outcome: "skipped",
          message: "Consolidate REFUSES non-text inputs — only markdown is accepted.",
        },
      },
      "run-7",
    );
    expect(result.noOpRefuse).toBe(true);
  });

  test("flags 'X rejects Y' shapes as noOpRefuse", () => {
    const result = classifyPlannerAction(
      {
        mode: "reflect",
        ref: "script:foo.ts",
        result: {
          ok: true,
          outcome: "skipped",
          message: "Reflect rejects asset type 'script' as input.",
        },
      },
      "run-1",
    );
    expect(result.noOpRefuse).toBe(true);
  });

  test("does NOT flag config-side skips ('feedback distillation is disabled')", () => {
    // This is a legitimate skip — the planner tried, the LLM was
    // disabled. It is NOT planner waste in the no-op-refuse sense.
    const result = classifyPlannerAction(
      {
        mode: "distill",
        ref: "memory:foo",
        result: {
          ok: true,
          outcome: "skipped",
          message: "feedback distillation is disabled or the LLM call failed; no proposal created.",
        },
      },
      "run-1",
    );
    expect(result.noOpRefuse).toBe(false);
    expect(result.llmTouched).toBe(true);
  });

  test("does NOT flag '*-skipped' modes (planner pre-filter)", () => {
    // The "-skipped" suffix is the planner's pre-filter — it deliberately
    // did not invoke the command, so it is not "LLM-touched" and not a
    // refuse.
    const result = classifyPlannerAction(
      {
        mode: "distill-skipped",
        ref: "agent:foo",
        result: { ok: true, outcome: null, message: null },
      },
      "run-1",
    );
    expect(result.noOpRefuse).toBe(false);
    expect(result.llmTouched).toBe(false);
  });

  test("does NOT flag successful action (outcome != skipped)", () => {
    const result = classifyPlannerAction(
      {
        mode: "distill",
        ref: "memory:foo",
        result: { ok: true, outcome: "queued", message: null },
      },
      "run-1",
    );
    expect(result.noOpRefuse).toBe(false);
    expect(result.llmTouched).toBe(true);
  });

  test("does NOT flag ok=false outcomes (error path, not a clean refuse)", () => {
    const result = classifyPlannerAction(
      {
        mode: "distill",
        ref: "memory:foo",
        result: { ok: false, outcome: "skipped", message: "Distill refuses ..." },
      },
      "run-1",
    );
    expect(result.noOpRefuse).toBe(false);
  });

  test("does NOT flag refuses-mentioning text without outcome=skipped", () => {
    const result = classifyPlannerAction(
      {
        mode: "distill",
        ref: "memory:foo",
        result: { ok: true, outcome: "queued", message: "internal note: distill refuses recursion" },
      },
      "run-1",
    );
    expect(result.noOpRefuse).toBe(false);
  });

  test("truncates long messages in the classified-action snippet", () => {
    const longMessage = `${DISTILL_REFUSE_MESSAGE} ${"x".repeat(500)}`;
    const result = classifyPlannerAction(
      { mode: "distill", ref: "lesson:foo", result: { ok: true, outcome: "skipped", message: longMessage } },
      "run-1",
    );
    expect(result.noOpRefuse).toBe(true);
    expect(result.message).toBeDefined();
    expect((result.message as string).length).toBeLessThanOrEqual(240);
  });

  test("missing-mode action is classified safely (not llmTouched, not refuse)", () => {
    const result = classifyPlannerAction({}, "run-1");
    expect(result.noOpRefuse).toBe(false);
    expect(result.llmTouched).toBe(false);
    expect(result.mode).toBe("");
    expect(result.ref).toBe("");
  });

  test("does NOT match the bare substring 'refuse' (word-boundary)", () => {
    // "refused" / "refusenik" / similar should not match; only the verbs
    // "refuses" / "rejects" (word-boundary).
    const result = classifyPlannerAction(
      {
        mode: "distill",
        ref: "memory:foo",
        result: { ok: true, outcome: "skipped", message: "agent refused the call (transport failure)" },
      },
      "run-1",
    );
    expect(result.noOpRefuse).toBe(false);
  });
});

describe("aggregatePlannerActions", () => {
  const refuse = (mode: string, ref: string, message: string, runId = "run-1"): ClassifiedPlannerAction => ({
    runId,
    ref,
    mode,
    noOpRefuse: true,
    llmTouched: true,
    message,
  });
  const llmAttempt = (mode: string, ref: string, runId = "run-1"): ClassifiedPlannerAction => ({
    runId,
    ref,
    mode,
    noOpRefuse: false,
    llmTouched: true,
  });
  const planSkipped = (mode: string, ref: string, runId = "run-1"): ClassifiedPlannerAction => ({
    runId,
    ref,
    mode,
    noOpRefuse: false,
    llmTouched: false,
  });

  test("counts totals, llm-touched, and refuses", () => {
    const a = aggregatePlannerActions([
      refuse("distill", "lesson:a", DISTILL_REFUSE_MESSAGE),
      refuse("distill", "lesson:b", DISTILL_REFUSE_MESSAGE),
      llmAttempt("distill", "memory:c"),
      llmAttempt("reflect", "memory:d"),
      planSkipped("distill-skipped", "memory:e"),
      planSkipped("distill-skipped", "memory:f"),
    ]);
    expect(a.counts.totalActions).toBe(6);
    expect(a.counts.llmTouchedActions).toBe(4);
    expect(a.counts.noOpRefuses).toBe(2);
    expect(a.counts.refusesByMode).toEqual({ distill: 2 });
  });

  test("computes rates against the right denominators", () => {
    // 2 refuses / 6 total = 0.333; 2 / 4 llm-touched = 0.5
    const a = aggregatePlannerActions([
      refuse("distill", "lesson:a", DISTILL_REFUSE_MESSAGE),
      refuse("distill", "lesson:b", DISTILL_REFUSE_MESSAGE),
      llmAttempt("distill", "memory:c"),
      llmAttempt("reflect", "memory:d"),
      planSkipped("distill-skipped", "memory:e"),
      planSkipped("distill-skipped", "memory:f"),
    ]);
    expect(a.noOpRefuseRate).toBeCloseTo(2 / 6, 9);
    expect(a.noOpRefuseRateLlmTouched).toBeCloseTo(2 / 4, 9);
  });

  test("rates are null when their denominators are zero", () => {
    expect(aggregatePlannerActions([]).noOpRefuseRate).toBeNull();
    expect(aggregatePlannerActions([]).noOpRefuseRateLlmTouched).toBeNull();
    const onlyPlanSkipped = aggregatePlannerActions([planSkipped("distill-skipped", "x")]);
    expect(onlyPlanSkipped.noOpRefuseRate).toBe(0);
    expect(onlyPlanSkipped.noOpRefuseRateLlmTouched).toBeNull();
  });

  test("collects per-mode refuse breakdown across multiple modes", () => {
    const a = aggregatePlannerActions([
      refuse("distill", "lesson:a", DISTILL_REFUSE_MESSAGE),
      refuse("distill", "lesson:b", DISTILL_REFUSE_MESSAGE),
      refuse("consolidate", "skill:c", "Consolidate refuses non-text inputs — only markdown is accepted."),
    ]);
    expect(a.counts.refusesByMode).toEqual({ distill: 2, consolidate: 1 });
  });

  test("histograms refuse-reasons sorted by count then alphabetically", () => {
    const m1 = "Distill refuses lesson inputs — A.";
    const m2 = "Reflect rejects asset type 'script'.";
    const m3 = "Consolidate refuses non-text inputs.";
    const a = aggregatePlannerActions([
      refuse("distill", "lesson:1", m1),
      refuse("distill", "lesson:2", m1),
      refuse("distill", "lesson:3", m1),
      refuse("reflect", "script:1", m2),
      refuse("reflect", "script:2", m2),
      refuse("consolidate", "skill:1", m3),
    ]);
    expect(a.topReasons.map((r) => `${r.count}:${r.message[0]}`)).toEqual(["3:D", "2:R", "1:C"]);
    // Modes appear in the histogram for triage.
    expect(a.topReasons[0].modes).toEqual(["distill"]);
  });

  test("caps top-reasons at 10 with stable sort", () => {
    const actions: ClassifiedPlannerAction[] = [];
    for (let i = 0; i < 15; i++) {
      // Reason `r-04` appears 4 times, all others appear once each.
      const reps = i === 4 ? 4 : 1;
      for (let j = 0; j < reps; j++) {
        actions.push(refuse("distill", `lesson:${i}-${j}`, `r-${String(i).padStart(2, "0")}`));
      }
    }
    const a = aggregatePlannerActions(actions);
    expect(a.topReasons.length).toBe(10);
    expect(a.topReasons[0]).toEqual({ message: "r-04", count: 4, modes: ["distill"] });
    // Remaining 9 entries are ties at count=1, ordered alphabetically.
    expect(a.topReasons.slice(1, 4).map((r) => r.message)).toEqual(["r-00", "r-01", "r-02"]);
  });

  test("caps per-reason samples at 3 in encounter order", () => {
    const a = aggregatePlannerActions([
      refuse("distill", "lesson:1", DISTILL_REFUSE_MESSAGE, "run-A"),
      refuse("distill", "lesson:2", DISTILL_REFUSE_MESSAGE, "run-A"),
      refuse("distill", "lesson:3", DISTILL_REFUSE_MESSAGE, "run-B"),
      refuse("distill", "lesson:4", DISTILL_REFUSE_MESSAGE, "run-B"),
      refuse("distill", "lesson:5", DISTILL_REFUSE_MESSAGE, "run-C"),
    ]);
    expect(a.samplesByReason).toHaveLength(1);
    expect(a.samplesByReason[0].samples).toEqual([
      { runId: "run-A", ref: "lesson:1", mode: "distill" },
      { runId: "run-A", ref: "lesson:2", mode: "distill" },
      { runId: "run-B", ref: "lesson:3", mode: "distill" },
    ]);
  });
});

describe("collectPlannerActions", () => {
  test("walks <stash>/.akm/runs/ and classifies actions across runs", () => {
    const stash = makeTmpStash();
    writeImproveRun(stash, "2026-05-01T00-00-00-000Z-aaaa", [
      {
        mode: "distill",
        ref: "lesson:a",
        result: { ok: true, outcome: "skipped", message: DISTILL_REFUSE_MESSAGE },
      },
      { mode: "distill-skipped", ref: "agent:b", result: { ok: true } },
    ]);
    writeImproveRun(stash, "2026-05-01T01-00-00-000Z-bbbb", [
      {
        mode: "distill",
        ref: "lesson:c",
        result: { ok: true, outcome: "skipped", message: DISTILL_REFUSE_MESSAGE },
      },
    ]);
    const { actions, runIdsRead } = collectPlannerActions(stash, 20);
    expect(runIdsRead.length).toBe(2);
    expect(actions.length).toBe(3);
    expect(actions.filter((a) => a.noOpRefuse).length).toBe(2);
  });

  test("clamps to the most recent windowRuns runs", () => {
    const stash = makeTmpStash();
    // Lexicographic sort of ISO-prefixed names is chronological.
    for (let i = 0; i < 5; i++) {
      writeImproveRun(stash, `2026-05-${String(i + 1).padStart(2, "0")}T00-00-00-000Z-xxxx`, [
        {
          mode: "distill",
          ref: `lesson:${i}`,
          result: { ok: true, outcome: "skipped", message: DISTILL_REFUSE_MESSAGE },
        },
      ]);
    }
    const { actions, runIdsRead } = collectPlannerActions(stash, 2);
    // Most recent 2 only.
    expect(runIdsRead.length).toBe(2);
    expect(actions.length).toBe(2);
    expect(runIdsRead[1].startsWith("2026-05-05")).toBe(true);
  });

  test("returns empty when the runs root is missing", () => {
    const stash = fs.mkdtempSync(path.join(os.tmpdir(), "akm-eval-planner-waste-empty-"));
    createdTmpDirs.push(stash);
    const { actions, runIdsRead } = collectPlannerActions(stash, 20);
    expect(actions).toEqual([]);
    expect(runIdsRead).toEqual([]);
  });

  test("skips malformed improve-result.json envelopes", () => {
    const stash = makeTmpStash();
    const goodId = "2026-05-01T00-00-00-000Z-good";
    const badId = "2026-05-01T01-00-00-000Z-bad";
    writeImproveRun(stash, goodId, [
      {
        mode: "distill",
        ref: "lesson:a",
        result: { ok: true, outcome: "skipped", message: DISTILL_REFUSE_MESSAGE },
      },
    ]);
    fs.mkdirSync(path.join(stash, ".akm", "runs", badId), { recursive: true });
    fs.writeFileSync(path.join(stash, ".akm", "runs", badId, "improve-result.json"), "not json");
    const { runIdsRead } = collectPlannerActions(stash, 20);
    expect(runIdsRead).toEqual([goodId]);
  });
});

describe("runPlannerWasteCase", () => {
  test("breakdown case (no expectations) always passes and reports metrics", async () => {
    const stash = makeTmpStash();
    writeImproveRun(stash, "2026-05-01T00-00-00-000Z-aaaa", [
      {
        mode: "distill",
        ref: "lesson:a",
        result: { ok: true, outcome: "skipped", message: DISTILL_REFUSE_MESSAGE },
      },
      { mode: "graph-extraction", ref: "memory:b", result: { ok: true, outcome: "queued" } },
    ]);
    const result = await runPlannerWasteCase(makeCase(), makeCtx(stash));
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
    expect(result.skipped).toBeUndefined();
    expect((result.metrics as Record<string, unknown>).noOpRefuseRate).toBeCloseTo(0.5, 9);
    expect((result.metrics as Record<string, unknown>).noOpRefuseRateLlmTouched).toBeCloseTo(0.5, 9);
  });

  test("ceiling case fails when rate > maxNoOpRefuseRate", async () => {
    const stash = makeTmpStash();
    // 2 refuses in 4 actions → 50% rate.
    writeImproveRun(stash, "2026-05-01T00-00-00-000Z-aaaa", [
      {
        mode: "distill",
        ref: "lesson:a",
        result: { ok: true, outcome: "skipped", message: DISTILL_REFUSE_MESSAGE },
      },
      {
        mode: "distill",
        ref: "lesson:b",
        result: { ok: true, outcome: "skipped", message: DISTILL_REFUSE_MESSAGE },
      },
      { mode: "graph-extraction", ref: "memory:c", result: { ok: true, outcome: "queued" } },
      { mode: "reflect", ref: "memory:d", result: { ok: true, outcome: "queued" } },
    ]);
    const result = await runPlannerWasteCase(
      makeCase({ id: "planner-waste-rate-ceiling", expected: { maxNoOpRefuseRate: 0.05 } }),
      makeCtx(stash),
    );
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    const checks = (result.metrics as Record<string, unknown>).checks as Array<{
      name: string;
      ok: boolean;
      value: number | null;
    }>;
    expect(checks.find((c) => c.name === "maxNoOpRefuseRate")?.ok).toBe(false);
  });

  test("ceiling case passes when rate <= maxNoOpRefuseRate", async () => {
    const stash = makeTmpStash();
    // 1 refuse in 100 actions = 0.01 ≤ 0.05.
    const actions: PlannerActionInput[] = [];
    actions.push({
      mode: "distill",
      ref: "lesson:a",
      result: { ok: true, outcome: "skipped", message: DISTILL_REFUSE_MESSAGE },
    });
    for (let i = 0; i < 99; i++) {
      actions.push({
        mode: "graph-extraction",
        ref: `memory:${i}`,
        result: { ok: true, outcome: "queued" },
      });
    }
    writeImproveRun(stash, "2026-05-01T00-00-00-000Z-aaaa", actions);
    const result = await runPlannerWasteCase(
      makeCase({
        id: "planner-waste-rate-ceiling",
        expected: { maxNoOpRefuseRate: 0.05 },
        requires: { minActions: 50 },
      }),
      makeCtx(stash),
    );
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  test("threshold-skips when totalActions < minActions", async () => {
    const stash = makeTmpStash();
    writeImproveRun(stash, "2026-05-01T00-00-00-000Z-aaaa", [
      {
        mode: "distill",
        ref: "lesson:a",
        result: { ok: true, outcome: "skipped", message: DISTILL_REFUSE_MESSAGE },
      },
    ]);
    const result = await runPlannerWasteCase(
      makeCase({
        id: "planner-waste-rate-ceiling",
        expected: { maxNoOpRefuseRate: 0.05 },
        requires: { minActions: 50 },
      }),
      makeCtx(stash),
    );
    expect(result.skipped).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
    expect(result.skipReason).toContain("only 1 action");
    expect(result.skipReason).toContain("minActions=50");
  });

  test("skips with explanatory reason when no improve runs exist", async () => {
    const stash = fs.mkdtempSync(path.join(os.tmpdir(), "akm-eval-planner-waste-noruns-"));
    createdTmpDirs.push(stash);
    const result = await runPlannerWasteCase(makeCase(), makeCtx(stash));
    expect(result.skipped).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.skipReason).toMatch(/no improve runs under/);
  });

  test("emits per-reason evidence samples capped at 3", async () => {
    const stash = makeTmpStash();
    const actions: PlannerActionInput[] = [];
    for (let i = 0; i < 5; i++) {
      actions.push({
        mode: "distill",
        ref: `lesson:${i}`,
        result: { ok: true, outcome: "skipped", message: DISTILL_REFUSE_MESSAGE },
      });
    }
    writeImproveRun(stash, "2026-05-01T00-00-00-000Z-aaaa", actions);
    const result = await runPlannerWasteCase(makeCase(), makeCtx(stash));
    const samples = (result.evidence as Record<string, unknown>).samplesByReason as Array<{
      message: string;
      samples: unknown[];
    }>;
    expect(samples).toHaveLength(1);
    expect(samples[0].samples).toHaveLength(3);
  });
});
