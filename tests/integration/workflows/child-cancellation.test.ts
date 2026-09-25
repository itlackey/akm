// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P3b Lane A TESTS — cancellation across the parent/child boundary
 * (docs/plans/specs/p3b-child-executor.md §2.4 "Cancellation, provenance,
 * nesting" rows A-28…A-30; §3.5 "Cancellation and leases"). This file owns
 * ONLY these three rows (A-31…A-36 belong to
 * tests/integration/workflows/child-nesting.test.ts, per the spec's own §7
 * new-suites table).
 *
 * GREEN: this file's one import of `driveChildWorkflowUnit` from
 * `src/workflows/exec/child-workflow.ts` resolves normally; `bunx tsc
 * --noEmit` stays green. Before Implement created that module, the import
 * carried the established `@ts-expect-error` red-phase directive (see
 * tests/integration/workflows/child-execution.test.ts's file header for the
 * full rationale) and every test below failed as a block at the bun:test
 * *runtime*; Implement removed the directive the moment the module was
 * created.
 *
 * A-28/A-29 use DIRECT `driveChildWorkflowUnit(input)` calls with a
 * two-step child plan: the injected dispatcher aborts a local
 * `AbortController` as a side effect of answering the FIRST unit, so the
 * SECOND unit's pre-dispatch abort check (`runUnit`'s
 * `if (input.signal?.aborted) …`, native-executor.ts — existing, unchanged)
 * fires cleanly, mirroring `ctx.signal` being "the parent unit's dispatch
 * signal" (§3.3.1) exactly as a real engine invocation would thread it.
 *
 * A-30 drives the FULL top-level engine on both levels (`runWorkflowSteps`
 * on a real parent whose one step composes a real child) and aborts the
 * parent's caller signal while the child's unit is in flight — proving the
 * cascade reaches all the way into the nested child drive, not just the
 * parent's own units.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import type { TaskInputBinding } from "../../../src/execution/input-contract";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import { driveChildWorkflowUnit } from "../../../src/workflows/exec/child-workflow";
import { runWorkflowSteps, workflowRunLockPath } from "../../../src/workflows/exec/run-workflow";
import { canonicalJson, computePlanHash } from "../../../src/workflows/ir/plan-hash";
import type {
  FrozenChildWorkflowTarget,
  FrozenWorkflowTarget,
  WorkflowPlanGraphV4,
} from "../../../src/workflows/ir/schema-v4";
import { frozenStepRows } from "../../../src/workflows/runtime/run-plan";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../../_helpers/sandbox";
import { freezeWorkflow } from "../../_helpers/workflow";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});

afterEach(() => storage.cleanup());

// ── Shared fixtures (mirrors tests/integration/workflows/child-execution.test.ts) ──

function childContentHash(fields: {
  ref: string;
  planHash: string;
  via: "direct" | "task";
  inputBindings?: readonly TaskInputBinding[];
}): string {
  return createHash("sha256")
    .update("akm.workflow.child-workflow\0v1\0")
    .update(
      canonicalJson({
        ref: fields.ref,
        planHash: fields.planHash,
        via: fields.via,
        taskRef: null,
        inputBindings: fields.inputBindings ?? null,
      }),
    )
    .digest("hex");
}

function buildChildTarget(childPlan: WorkflowPlanGraphV4, options: { ref?: string } = {}): FrozenChildWorkflowTarget {
  const ref = options.ref ?? "workflows/child";
  const planHash = computePlanHash(childPlan);
  return {
    kind: "child-workflow",
    ref,
    planHash,
    frozenPlan: childPlan,
    contentHash: childContentHash({ ref, planHash, via: "direct" }),
    via: "direct",
  };
}

/** A two-step child plan — step 2 exists so a mid-drive abort has a second dispatch attempt to observe it at. */
function twoStepChildPlan(): WorkflowPlanGraphV4 {
  return freezeWorkflow(
    [
      "---",
      "type: workflow",
      "steps:",
      "  - id: step1",
      "  - id: step2",
      "---",
      "",
      "## step1",
      "",
      "Do step 1.",
      "",
      "## step2",
      "",
      "Do step 2.",
      "",
    ].join("\n"),
    "workflows/child-two.md",
  );
}

interface SeededParent {
  runId: string;
  stepId: string;
  scopeKey: string;
}

async function seedParentRun(overrides: Partial<SeededParent> = {}): Promise<SeededParent> {
  const parent: SeededParent = {
    runId: overrides.runId ?? randomUUID(),
    stepId: overrides.stepId ?? "compose",
    scopeKey: overrides.scopeKey ?? "dir:v1:parent",
  };
  const now = new Date().toISOString();
  await withWorkflowRunsRepo(async (repo) => {
    repo.insertRun({
      id: parent.runId,
      workflowRef: "workflows/parent",
      scopeKey: parent.scopeKey,
      workflowEntryId: null,
      workflowTitle: "Parent",
      paramsJson: "{}",
      currentStepId: parent.stepId,
      createdAt: now,
      updatedAt: now,
      agentHarness: null,
      agentSessionId: null,
    });
    repo.insertSteps([
      {
        runId: parent.runId,
        stepId: parent.stepId,
        stepTitle: parent.stepId,
        instructions: "Compose the child workflow.",
        completionJson: null,
        sequenceIndex: 0,
      },
    ]);
  });
  return parent;
}

function parentUnitId(stepId: string): string {
  return `${stepId}:solo`;
}

// ── A-28, A-29: an abort mid-child-drive leaves both runs resumable ─────────

describe("A-28, A-29 — a parent AbortSignal aborted mid-child-drive is observed by the child, leaving it resumable", () => {
  /** One shared dispatcher for BOTH `ctx.dispatcher` and the top-level `dispatcher` field — the row is agnostic about which of the two the drive actually reads, so both must observe the identical abort-on-first-call behavior. */
  function abortingDispatcher(controller: AbortController, counter: { count: number }) {
    return async (): Promise<{ ok: true; text: string }> => {
      counter.count++;
      // Abort as a side effect of answering the FIRST unit — the SECOND
      // unit's pre-dispatch check (native-executor.ts's runUnit, existing
      // and unchanged) then observes an already-aborted signal and never
      // reaches this dispatcher again.
      if (counter.count === 1) controller.abort();
      return { ok: true, text: "done" };
    };
  }

  test("A-28: the child drive returns ok: false, failureReason 'aborted', once the signal fires mid-drive", async () => {
    const parent = await seedParentRun();
    const target = buildChildTarget(twoStepChildPlan(), { ref: "workflows/two-step-child" });
    const controller = new AbortController();
    const counter = { count: 0 };
    const dispatcher = abortingDispatcher(controller, counter);

    const outcome = await driveChildWorkflowUnit({
      request: {
        runId: parent.runId,
        stepId: parent.stepId,
        unitId: parentUnitId(parent.stepId),
        nodeId: parent.stepId,
        prompt: "Compose the child workflow.",
        frozenTarget: target,
        timeoutMs: null,
      },
      target,
      ctx: {
        runId: parent.runId,
        workflowRef: "workflows/parent",
        params: {},
        evidence: {},
        signal: controller.signal,
        dispatcher,
      },
      childParams: {},
      inputHash: "h".repeat(64),
      dispatcher,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.failureReason).toBe("aborted");
    // Only the first unit ever actually dispatched.
    expect(counter.count).toBe(1);
  });

  test("A-29: after the abort, the child's own run lock is released and the child run stays active (resumable)", async () => {
    const parent = await seedParentRun();
    const target = buildChildTarget(twoStepChildPlan(), { ref: "workflows/two-step-child-b" });
    const controller = new AbortController();
    const counter = { count: 0 };
    const dispatcher = abortingDispatcher(controller, counter);

    const outcome = await driveChildWorkflowUnit({
      request: {
        runId: parent.runId,
        stepId: parent.stepId,
        unitId: parentUnitId(parent.stepId),
        nodeId: parent.stepId,
        prompt: "Compose the child workflow.",
        frozenTarget: target,
        timeoutMs: null,
      },
      target,
      ctx: {
        runId: parent.runId,
        workflowRef: "workflows/parent",
        params: {},
        evidence: {},
        signal: controller.signal,
        dispatcher,
      },
      childParams: {},
      inputHash: "h".repeat(64),
      dispatcher,
    });

    const childRunId = outcome.childRun?.runId as string;
    expect(childRunId).toBeDefined();
    const childRow = await withWorkflowRunsRepo((repo) => repo.getRunById(childRunId));
    // Left active/resumable (§3.4's table): the aborted drive never finalized
    // the interrupted step, so the run derives "active", never "failed".
    expect(childRow?.status).toBe("active");
    // The child's OWN runWorkflowAttempt `finally` releases its OWN run lock
    // on every exit path, so a resume can drive it immediately.
    expect(fs.existsSync(workflowRunLockPath(childRunId))).toBe(false);
  });
});

// ── A-30: aborting the PARENT drive aborts the nested child drive too ──────

describe("A-30 — aborting the parent's drive mid-dispatch aborts the child drive too", () => {
  test("A-30: the parent's abort cascades into the child; both stop, and the child is left resumable", async () => {
    const parentRunId = randomUUID();
    const parentStepId = "compose";
    const childPlan = twoStepChildPlan();
    const target = buildChildTarget(childPlan, { ref: "workflows/lease-loss-child" });
    const parentPlan: WorkflowPlanGraphV4 = {
      irVersion: 5,
      title: "Parent",
      execution: { maxConcurrency: 1 },
      sourceReadSet: [
        {
          identity: {
            ref: "test//workflows/parent",
            bundle: "test",
            adapter: "akm-workflow",
            file: "workflows/parent.yml",
            hash: createHash("sha256").update("parent-fixture").digest("hex"),
          },
          containmentPhysicalIdentity: "test-fixture-root",
          physicalIdentity: createHash("sha256").update("workflows/parent.yml\0parent-fixture").digest("hex"),
          size: 0,
        },
      ],
      steps: [
        {
          stepId: parentStepId,
          title: parentStepId,
          sequenceIndex: 0,
          root: {
            kind: "unit",
            id: parentStepId,
            instructions: "Compose the child workflow.",
            onError: "fail",
            isolation: "none",
            frozenTarget: target as FrozenWorkflowTarget,
            environment: [],
          },
          gate: {
            kind: "gate",
            id: `${parentStepId}.gate`,
            stepId: parentStepId,
            criteria: [],
            maxLoops: 1,
            frozenJudge: null,
          },
        },
      ],
    };
    const now = new Date().toISOString();
    const db = openStateDatabase(getStateDbPath());
    try {
      db.prepare(
        `INSERT INTO workflow_runs
           (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
            params_json, current_step_id, created_at, updated_at, plan_json, plan_hash, plan_ir_version)
         VALUES (?, 'workflows/parent', 'dir:v1:parent', NULL, 'Parent', 'active', '{}', ?, ?, ?, ?, ?, 5)`,
      ).run(parentRunId, parentStepId, now, now, canonicalJson(parentPlan), computePlanHash(parentPlan));
      const parentStepRow = frozenStepRows(parentPlan)[0]!;
      db.prepare(
        `INSERT INTO workflow_run_steps
           (run_id, step_id, step_title, instructions, completion_json, sequence_index, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      ).run(
        parentRunId,
        parentStepRow.stepId,
        parentStepRow.stepTitle,
        parentStepRow.instructions,
        parentStepRow.completionJson,
        parentStepRow.sequenceIndex,
      );
    } finally {
      db.close();
    }

    let markChildDispatchStarted: (() => void) | undefined;
    let finishChildDispatch: ((value: { ok: true; text: string }) => void) | undefined;
    const childDispatchStarted = new Promise<void>((resolve) => {
      markChildDispatchStarted = resolve;
    });
    const childDispatchResult = new Promise<{ ok: true; text: string }>((resolve) => {
      finishChildDispatch = resolve;
    });

    const controller = new AbortController();
    const running = runWorkflowSteps({
      target: parentRunId,
      signal: controller.signal,
      dispatcher: async () => {
        markChildDispatchStarted?.();
        // Parked until the parent's signal has been aborted below.
        return childDispatchResult;
      },
    });

    await childDispatchStarted;
    controller.abort();
    finishChildDispatch?.({ ok: true, text: "late result" });

    const result = await running;
    expect(result.aborted).toBe(true);
    expect(result.run.status).toBe("active");

    // The child was published (dispatch reached it) and is left resumable —
    // never marked failed by an interrupted drive.
    const children = await withWorkflowRunsRepo((repo) => repo.childRunsOf(parentRunId));
    expect(children).toHaveLength(1);
    const childRow = await withWorkflowRunsRepo((repo) => repo.getRunById(children[0]!.id));
    expect(childRow?.status).toBe("active");
    expect(fs.existsSync(workflowRunLockPath(children[0]!.id))).toBe(false);
  });
});
