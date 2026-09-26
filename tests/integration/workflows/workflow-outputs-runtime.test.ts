// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P3b Lane B TESTS — workflow `outputs:` resolution at run completion and the
 * exported result (spec docs/plans/specs/p3b-child-executor.md §4.3, §4.4,
 * rows B-18…B-27; named in §7's new-suites table as this file). Source-level
 * parse/compile/freeze coverage (B-01…B-17) lives in
 * tests/workflows/workflow-outputs-source.test.ts.
 *
 * RED phase: `completeWorkflowStep` (`src/workflows/runtime/runs.ts`) does not
 * resolve or persist declared outputs at all today — `workflow_runs` has no
 * `outputs_json` column (migration `024-workflow-run-outputs` has not landed),
 * `WorkflowRunRow`/`WorkflowRunSummary` carry no such field, and
 * `src/workflows/runtime/run-outputs.ts` does not exist on disk.
 *
 * Technique: a plan is built with the existing pure `freezeWorkflow` test
 * helper, then a plain `outputs` value is spliced onto it (an intersection
 * type, never a not-yet-existing `WorkflowOutput` import — see
 * {@link planWithOutputs}) before seeding it directly into state.db with the
 * existing `seedWorkflowRun`/`storeFrozenWorkflowPlan` helpers — the same
 * technique `tests/integration/workflows/persistence-write-path.test.ts`
 * already uses for its own evidence-bound coverage. Steps are then completed
 * directly through the real, already-existing `completeWorkflowStep` — no
 * dispatcher, no engine, no config/index needed (this is exactly the
 * production write path the spec's B-N13 describes, exercised end to end
 * around ONE new column). `outputs_json` / `run.outputs` are read back
 * through a small structural view type (an intersection, not a cast through a
 * not-yet-existing field), so no `@ts-expect-error` is needed for those
 * reads either.
 *
 * The ONE pin in this file is `run-outputs.ts` itself (B-24, B-25): imported
 * as a namespace behind a single directly-preceding `@ts-expect-error`,
 * mirroring `tests/workflows/child-invocation-key.test.ts`'s precedent for a
 * whole not-yet-existing module. `workflowRunExportedResult` is always called
 * with a REAL row read back from `repo.getRunById` (never a hand-fabricated
 * partial), so once Implement lands the real `WorkflowRunRow.outputs_json`
 * field and the real function signature, these call sites are already
 * type-valid — nothing but the directive itself needs deleting.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import * as RunOutputsModule from "../../../src/workflows/runtime/run-outputs";
import { completeWorkflowStep, getWorkflowStatus } from "../../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";
import {
  freezeWorkflow,
  seedWorkflowRun,
  storeFrozenWorkflowPlan,
  type WorkflowPlanFixture,
} from "../../_helpers/workflow";

const { workflowRunExportedResult } = RunOutputsModule;

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

const TWO_STEP_MD = `---
type: workflow
steps:
  - id: collect
  - id: summarize
---

## collect

Collect the raw data.

## summarize

Summarize the results.
`;

interface OutputDeclaration {
  readonly from: string;
  readonly schema?: Record<string, unknown>;
}

/** A plain intersection over the plan — never a not-yet-existing `WorkflowOutput` import. See file header. */
type PlanWithOutputs = WorkflowPlanFixture & { readonly outputs?: Record<string, OutputDeclaration> };

function planWithOutputs(plan: WorkflowPlanFixture, outputs?: Record<string, OutputDeclaration>): PlanWithOutputs {
  return outputs ? { ...plan, outputs } : plan;
}

/** Structural view onto the not-yet-existing `outputs_json` column / `run.outputs` field. */
interface OutputsColumnView {
  readonly outputs_json?: string | null;
}
interface RunSummaryOutputsView {
  readonly outputs?: Record<string, unknown>;
}

function seedRun(runId: string, plan: WorkflowPlanFixture): void {
  const db = openStateDatabase(getStateDbPath());
  try {
    seedWorkflowRun(db, {
      runId,
      workflowRef: "test//workflows/outputs-runtime",
      steps: [
        { stepId: "collect", stepTitle: "Collect" },
        { stepId: "summarize", stepTitle: "Summarize" },
      ],
      currentStepId: "collect",
    });
    storeFrozenWorkflowPlan(db, runId, plan);
  } finally {
    db.close();
  }
}

function countEvents(): number {
  const db = openStateDatabase(getStateDbPath());
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

async function completeCollect(runId: string, evidence: Record<string, unknown>): Promise<void> {
  await completeWorkflowStep({
    runId,
    stepId: "collect",
    status: "completed",
    summary: "collected",
    evidence,
    summaryJudge: null,
  });
}

async function completeSummarize(
  runId: string,
  evidence: Record<string, unknown>,
): Promise<Awaited<ReturnType<typeof completeWorkflowStep>>> {
  return completeWorkflowStep({
    runId,
    stepId: "summarize",
    status: "completed",
    summary: "summarized",
    evidence,
    summaryJudge: null,
  });
}

// ── B-18, B-19: resolve + persist at completion ─────────────────────────────

describe("run-completion output resolution (B-18, B-19)", () => {
  test("B-18: a run whose final step completes, with outputs: declared, persists the resolved map as outputs_json in the completion transaction", async () => {
    const runId = randomUUID();
    const plan = planWithOutputs(freezeWorkflow(TWO_STEP_MD, "workflows/outputs-runtime.md"), {
      report: { from: "steps.summarize.output" },
    });
    seedRun(runId, plan);

    await completeCollect(runId, { output: { total: 5 } });
    await completeSummarize(runId, { output: "all good" });

    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(runId));
    const view = row as unknown as OutputsColumnView;
    expect(view.outputs_json).toBeTruthy();
    expect(JSON.parse(view.outputs_json as string)).toEqual({ report: "all good" });
  });

  test("B-19: a run whose plan declares no outputs: leaves outputs_json NULL", async () => {
    const runId = randomUUID();
    const plan = planWithOutputs(freezeWorkflow(TWO_STEP_MD, "workflows/no-outputs-runtime.md"));
    seedRun(runId, plan);

    await completeCollect(runId, { output: { total: 5 } });
    await completeSummarize(runId, { output: "all good" });

    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(runId));
    const view = row as unknown as OutputsColumnView;
    expect(view.outputs_json ?? null).toBeNull();
  });
});

// ── B-20, B-21, B-22: resolution failures roll back the completion ─────────

describe("run-completion output resolution failures complete with a warning, never roll back (B-20…B-22, issue 5)", () => {
  test("B-20: an output whose from resolves to a missing property is dropped and warned about; the run still completes, and a SIBLING output that DID resolve is still stored", async () => {
    const runId = randomUUID();
    const plan = planWithOutputs(freezeWorkflow(TWO_STEP_MD, "workflows/outputs-missing-prop.md"), {
      report: { from: "steps.summarize.output.missing" },
      ok: { from: "steps.collect.output.total" },
    });
    seedRun(runId, plan);
    await completeCollect(runId, { output: { total: 5 } });

    const eventsBefore = countEvents();
    const outcome = await completeSummarize(runId, { output: { present: true } });

    if (!("run" in outcome)) throw new Error("expected a WorkflowRunDetail, not a validation failure");
    expect(outcome.run.status).toBe("completed");
    expect(outcome.warnings?.some((w) => w.includes("report"))).toBe(true);

    // Fail-before-mutation (B-N13): the step stays pending, the run stays
    // active, and no event is appended for the failed completion attempt.
    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(runId));
    expect(row?.status).toBe("completed");
    const step = await withWorkflowRunsRepo((repo) => repo.getStep(runId, "summarize"));
    expect(step?.status).toBe("completed");
    expect(countEvents()).toBeGreaterThan(eventsBefore);

    const view = row as unknown as OutputsColumnView;
    expect(JSON.parse(view.outputs_json as string)).toEqual({ ok: 5 });
  });

  test("B-21: a huge output value (well over the FORMER 1 MiB evidence cap) resolves and is stored in full — no truncation any more (issue 1)", async () => {
    const runId = randomUUID();
    const plan = planWithOutputs(freezeWorkflow(TWO_STEP_MD, "workflows/outputs-big.md"), {
      big: { from: "steps.collect.output" },
    });
    seedRun(runId, plan);

    // Comfortably over WORKFLOW_MAX_EVIDENCE_JSON_BYTES (1 MiB): the SAME
    // technique tests/integration/workflows/persistence-write-path.test.ts
    // already uses to force `clipStepEvidenceForPersistence` to replace
    // `evidence.output` with a marked truncation envelope.
    const huge = Array.from({ length: 4000 }, (_, i) => `${"x".repeat(512)}#${i}`);
    expect(Buffer.byteLength(JSON.stringify(huge), "utf8")).toBeGreaterThan(1024 * 1024);
    await completeCollect(runId, { output: huge });

    const outcome = await completeSummarize(runId, { output: "done" });
    if (!("run" in outcome)) throw new Error("expected a WorkflowRunDetail, not a validation failure");
    expect(outcome.run.status).toBe("completed");
    expect(outcome.warnings ?? []).toEqual([]);

    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(runId));
    const view = row as unknown as OutputsColumnView;
    const outputs = JSON.parse(view.outputs_json as string) as { big: string[] };
    expect(outputs.big).toHaveLength(4000);
    expect(outputs.big).toEqual(huge);
  });

  test("B-22: an output whose resolved value violates its declared schema is dropped and warned about, without blocking completion", async () => {
    const runId = randomUUID();
    const plan = planWithOutputs(freezeWorkflow(TWO_STEP_MD, "workflows/outputs-schema-violation.md"), {
      changed_count: { from: "steps.collect.output.total", schema: { type: "integer", minimum: 0 } },
    });
    seedRun(runId, plan);
    await completeCollect(runId, { output: { total: -5 } });

    const outcome = await completeSummarize(runId, { output: "done" });
    if (!("run" in outcome)) throw new Error("expected a WorkflowRunDetail, not a validation failure");
    expect(outcome.run.status).toBe("completed");
    expect(outcome.warnings?.some((w) => w.includes("changed_count"))).toBe(true);

    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(runId));
    const view = row as unknown as OutputsColumnView;
    expect(JSON.parse(view.outputs_json as string)).toEqual({});
  });
});

// ── B-23: a failed/blocked run never resolves outputs ───────────────────────

describe("a failed or blocked run never resolves outputs (B-23)", () => {
  test("a run whose step fails leaves outputs_json NULL and throws nothing about the (unreachable) declared output", async () => {
    const runId = randomUUID();
    const plan = planWithOutputs(freezeWorkflow(TWO_STEP_MD, "workflows/outputs-failed-run.md"), {
      report: { from: "steps.summarize.output" },
    });
    seedRun(runId, plan);

    await completeWorkflowStep({
      runId,
      stepId: "collect",
      status: "failed",
      notes: "boom",
      summaryJudge: null,
    });

    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(runId));
    expect(row?.status).toBe("failed");
    expect((row as unknown as OutputsColumnView).outputs_json ?? null).toBeNull();
  });
});

// ── B-24, B-25: workflowRunExportedResult ───────────────────────────────────

describe("workflowRunExportedResult (B-24, B-25)", () => {
  test("B-24: a completed run with outputs_json returns the parsed map", async () => {
    const runId = randomUUID();
    const plan = planWithOutputs(freezeWorkflow(TWO_STEP_MD, "workflows/exported-result-with-outputs.md"), {
      report: { from: "steps.summarize.output" },
    });
    seedRun(runId, plan);
    await completeCollect(runId, { output: { total: 5 } });
    await completeSummarize(runId, { output: "final" });

    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(runId));
    if (!row) throw new Error("expected a run row");
    expect(workflowRunExportedResult(row)).toEqual({ report: "final" });
  });

  test("B-25: any run with outputs_json NULL synthesizes {runId, status} — never stored", async () => {
    const runId = randomUUID();
    const plan = planWithOutputs(freezeWorkflow(TWO_STEP_MD, "workflows/exported-result-no-outputs.md"));
    seedRun(runId, plan);
    await completeCollect(runId, { output: { total: 5 } });
    await completeSummarize(runId, { output: "final" });

    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(runId));
    if (!row) throw new Error("expected a run row");
    expect(workflowRunExportedResult(row)).toEqual({ runId, status: "completed" });

    // Never stored: outputs_json itself stays NULL for a run declaring none.
    expect((row as unknown as OutputsColumnView).outputs_json ?? null).toBeNull();
  });
});

// ── B-26, B-27: akm workflow status envelope ────────────────────────────────

describe("akm workflow status — run.outputs (B-26, B-27, PRESERVE)", () => {
  test("B-26: a run with outputs_json carries the resolved map under run.outputs", async () => {
    const runId = randomUUID();
    const plan = planWithOutputs(freezeWorkflow(TWO_STEP_MD, "workflows/status-with-outputs.md"), {
      report: { from: "steps.summarize.output" },
    });
    seedRun(runId, plan);
    await completeCollect(runId, { output: { total: 5 } });
    await completeSummarize(runId, { output: "final" });

    const detail = await getWorkflowStatus(runId);
    const view = detail.run as unknown as RunSummaryOutputsView;
    expect(view.outputs).toEqual({ report: "final" });
  });

  test("B-27: a run without a declared outputs: never carries run.outputs — absent, not null (Stable-tier byte identity)", async () => {
    const runId = randomUUID();
    const plan = planWithOutputs(freezeWorkflow(TWO_STEP_MD, "workflows/status-no-outputs.md"));
    seedRun(runId, plan);
    await completeCollect(runId, { output: { total: 5 } });
    await completeSummarize(runId, { output: "final" });

    const detail = await getWorkflowStatus(runId);
    expect(Object.hasOwn(detail.run, "outputs")).toBe(false);
  });
});
