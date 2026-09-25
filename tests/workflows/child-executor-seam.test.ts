// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P3b Lane A TESTS — the child-workflow dispatch SEAM (docs/plans/specs/
 * p3b-child-executor.md §2.1 "The dispatch seam", rows A-01, A-02, A-04,
 * A-05, A-06; §3.2 "The dispatch seam (exact)"). This file owns ONLY those
 * five rows — row A-03 (the internal-invariant guard's exact plain-`Error`
 * shape once the seam is bypassed) is pinned by the AUTHORIZED FLIP of
 * tests/workflows/child-workflow-dispatch-guard.test.ts (spec §6 F-A1), not
 * duplicated here.
 *
 * RED today, with NO `@ts-expect-error` pin needed anywhere in this file.
 * `src/workflows/exec/child-workflow.ts` (`driveChildWorkflowUnit`) does not
 * exist yet, but this file never imports it: every test below drives the
 * EXISTING, exported seam (`executeStepPlan`, `computeStepWorkList`) with an
 * injected `StepExecutionContext.dispatcher` and asserts on its OBSERVABLE
 * behavior, so the RED signal is a genuine failing assertion — the fake
 * dispatcher is STILL invoked directly for a `child-workflow`-kind request
 * today (row A-01), because `native-executor.ts:1168`'s
 * `dispatchJournaledAttempt` has not yet grown the two-arm branch spec §3.2
 * describes. A-05/A-06 are PRESERVE rows and are already true today by
 * construction — they are pinned here as regression guards for Implement,
 * not as RED assertions. `bunx tsc --noEmit` is green at this commit and
 * stays green through Implement: nothing here references a not-yet-existing
 * symbol.
 *
 * `FrozenChildWorkflowTarget` is real, already-landed P3a schema
 * (`src/workflows/ir/schema-v4.ts`) — no cast through `unknown` is needed to
 * build one. `childContentHash`/`buildChildTarget` mirror
 * tests/workflows/hash-v6.test.ts's established fixture-builder convention
 * for this exact target shape (kept local to this file per this repo's
 * test-file self-containment convention — that file and
 * tests/integration/storage/child-run-publication.test.ts each keep their
 * own local copy rather than sharing one, and this file does the same).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { TaskInputBinding } from "../../src/execution/input-contract";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import {
  executeStepPlan,
  type StepExecutionContext,
  type UnitDispatchRequest,
  type UnitDispatchResult,
} from "../../src/workflows/exec/native-executor";
import { computeStepWorkList, type WorkListInput } from "../../src/workflows/exec/step-work";
import { canonicalJson, computePlanHash } from "../../src/workflows/ir/plan-hash";
import type {
  FrozenChildWorkflowTarget,
  FrozenWorkflowTarget,
  IrStepPlanV4,
  WorkflowPlanGraphV4,
} from "../../src/workflows/ir/schema-v4";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";
import { freezeWorkflow } from "../_helpers/workflow";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});

afterEach(() => storage.cleanup());

// ── Shared child-workflow-target fixture builder (mirrors hash-v6.test.ts) ──

function childContentHash(fields: {
  ref: string;
  planHash: string;
  via: "direct" | "task";
  taskRef?: string;
  inputBindings?: readonly TaskInputBinding[];
}): string {
  return createHash("sha256")
    .update("akm.workflow.child-workflow\0v1\0")
    .update(
      canonicalJson({
        ref: fields.ref,
        planHash: fields.planHash,
        via: fields.via,
        taskRef: fields.taskRef ?? null,
        inputBindings: fields.inputBindings ?? null,
      }),
    )
    .digest("hex");
}

function buildChildTarget(
  childPlan: WorkflowPlanGraphV4,
  options: { ref?: string; inputBindings?: readonly TaskInputBinding[] } = {},
): FrozenChildWorkflowTarget {
  const ref = options.ref ?? "workflows/child";
  const planHash = computePlanHash(childPlan);
  return {
    kind: "child-workflow",
    ref,
    planHash,
    frozenPlan: childPlan,
    contentHash: childContentHash({ ref, planHash, via: "direct", inputBindings: options.inputBindings }),
    via: "direct",
    ...(options.inputBindings ? { inputBindings: options.inputBindings } : {}),
  };
}

/** A minimal one-step child plan with no completion criteria — a plain, terminal-ready leaf. */
function leafChildPlan(): WorkflowPlanGraphV4 {
  return freezeWorkflow(
    ["---", "type: workflow", "steps:", "  - id: work", "---", "", "## work", "", "Do the child's work.", ""].join(
      "\n",
    ),
    "workflows/child.md",
  );
}

/** Wraps `target` as the sole unit of a minimal composing step plan (mirrors hash-v6.test.ts's stepPlanWithTarget). */
function stepPlanWithTarget(target: FrozenWorkflowTarget, stepId = "compose"): IrStepPlanV4 {
  return {
    stepId,
    title: stepId,
    sequenceIndex: 0,
    root: {
      kind: "unit",
      id: stepId,
      instructions: "Compose the child workflow.",
      onError: "fail",
      isolation: "none",
      frozenTarget: target,
      environment: [],
    },
    gate: { kind: "gate", id: `${stepId}.gate`, stepId, criteria: [], frozenJudge: null },
  };
}

/** Seed the `workflow_runs` + `workflow_run_steps` rows a direct `executeStepPlan` call needs. */
async function seedParentRun(input: { runId: string; stepId: string }): Promise<void> {
  const now = new Date().toISOString();
  await withWorkflowRunsRepo(async (repo) => {
    repo.insertRun({
      id: input.runId,
      workflowRef: "workflows/parent",
      scopeKey: "dir:v1:parent",
      workflowEntryId: null,
      workflowTitle: "Parent",
      paramsJson: "{}",
      currentStepId: input.stepId,
      createdAt: now,
      updatedAt: now,
      agentHarness: null,
      agentSessionId: null,
    });
    repo.insertSteps([
      {
        runId: input.runId,
        stepId: input.stepId,
        stepTitle: input.stepId,
        instructions: "Compose the child workflow.",
        completionJson: null,
        sequenceIndex: 0,
      },
    ]);
  });
}

/** Records every request an injected dispatcher receives. */
function recordingDispatcher(): {
  dispatcher: (request: UnitDispatchRequest) => Promise<UnitDispatchResult>;
  calls: UnitDispatchRequest[];
} {
  const calls: UnitDispatchRequest[] = [];
  return {
    calls,
    dispatcher: async (request: UnitDispatchRequest): Promise<UnitDispatchResult> => {
      calls.push(request);
      return { ok: true, text: "dispatched-directly" };
    },
  };
}

// ── A-01: the seam must route a child-workflow unit away from UnitDispatcher ─

describe("A-01 — the dispatch seam routes a child-workflow unit away from UnitDispatcher", () => {
  test("A-01: the injected dispatcher is never invoked directly with a child-workflow-kind request", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const stepId = "compose";
    await seedParentRun({ runId, stepId });

    const target = buildChildTarget(leafChildPlan());
    const plan = stepPlanWithTarget(target, stepId);
    const { dispatcher, calls } = recordingDispatcher();
    const ctx: StepExecutionContext = { runId, workflowRef: "workflows/parent", params: {}, evidence: {}, dispatcher };

    await executeStepPlan(plan, ctx);

    // Once Implement wires the seam (spec §3.2), a child-workflow-kind
    // request must never reach UnitDispatcher directly — it is routed to
    // driveChildWorkflowUnit instead. Today `dispatchJournaledAttempt` has no
    // such branch, so this injected dispatcher — which stands in for
    // UnitDispatcher at the exact point native-executor.ts calls it — DOES
    // still receive the request directly. RED.
    const routedDirectlyToDispatcher = calls.some((call) => call.frozenTarget.kind === "child-workflow");
    expect(routedDirectlyToDispatcher).toBe(false);
  });
});

// ── A-02: the composing unit's own journal bookkeeping is unaffected ───────

describe("A-02 — the composing unit still reserves and finishes its own attempt row", () => {
  test("A-02: workflow_run_units carries phase 'unit' and runner 'exec' for the composing unit, regardless of dispatch routing", async () => {
    const runId = "22222222-2222-4222-8222-222222222222";
    const stepId = "compose";
    await seedParentRun({ runId, stepId });

    const target = buildChildTarget(leafChildPlan());
    const plan = stepPlanWithTarget(target, stepId);
    const { dispatcher } = recordingDispatcher();
    const ctx: StepExecutionContext = { runId, workflowRef: "workflows/parent", params: {}, evidence: {}, dispatcher };

    const result = await executeStepPlan(plan, ctx);
    expect(result.ok).toBe(true);

    // True both before and after Implement's fix: `reserveJournaledDispatch`
    // (which claims the attempt row) runs BEFORE the dispatch branch, and
    // `finishJournaledDispatch` runs AFTER it — bookkeeping is unconditional
    // on which arm dispatch takes (spec §3.2's "Why here and nowhere else").
    // Pinned so Implement cannot accidentally skip journal accounting while
    // adding the branch.
    const unit = await withWorkflowRunsRepo((repo) => repo.getUnit(runId, `${stepId}:solo`));
    expect(unit).toBeDefined();
    expect(unit?.phase).toBe("unit");
    expect(unit?.runner).toBe("exec");
    expect(unit?.status).toBe("completed");
  });
});

// ── A-04: the retired UsageErrorCode leaves no trace under src/ ────────────

describe("A-04 — WORKFLOW_CHILD_EXECUTION_UNSUPPORTED is retired (B-N11)", () => {
  function collectTsFiles(dir: string): string[] {
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...collectTsFiles(full));
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        results.push(full);
      }
    }
    return results;
  }

  test("A-04: no *.ts file under src/ mentions WORKFLOW_CHILD_EXECUTION_UNSUPPORTED", () => {
    const root = path.resolve(import.meta.dir, "../../src");
    const hits = collectTsFiles(root)
      .filter((file) => fs.readFileSync(file, "utf8").includes("WORKFLOW_CHILD_EXECUTION_UNSUPPORTED"))
      .map((file) => path.relative(root, file));

    // RED today: unit-dispatch.ts (the guard itself), step-work.ts and
    // native-executor.ts (stale comments naming it), and core/errors.ts (the
    // UsageErrorCode union member + its USAGE_HINTS entry) all still
    // reference it. Implement deletes every one (spec B-N11, row A-04).
    expect(hits).toEqual([]);
  });
});

// ── A-05: an ordinary command unit's dispatch path is byte-unchanged ───────

describe("A-05 — an ordinary command unit is unaffected (PRESERVE)", () => {
  test("A-05: a plain command-kind unit still reaches UnitDispatcher exactly once, unchanged", async () => {
    const runId = "33333333-3333-4333-8333-333333333333";
    const stepId = "notify";
    await seedParentRun({ runId, stepId });

    const plan = freezeWorkflow(
      ["---", "type: workflow", "steps:", "  - id: notify", "---", "", "## notify", "", "Send the notice.", ""].join(
        "\n",
      ),
      "workflows/parent.md",
    ).steps[0]!;
    expect(plan.root?.kind === "unit" ? plan.root.frozenTarget.kind : undefined).toBe("command");

    const { dispatcher, calls } = recordingDispatcher();
    const ctx: StepExecutionContext = { runId, workflowRef: "workflows/parent", params: {}, evidence: {}, dispatcher };

    const result = await executeStepPlan(plan, ctx);

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.frozenTarget.kind).toBe("command");
  });
});

// ── A-06: computeStepWorkList already builds a child-workflow unit correctly ─

describe("A-06 — computeStepWorkList already treats a child-workflow target correctly (PRESERVE)", () => {
  test("A-06: timeoutMs is null, runner is exec, and the prompt is built through the normal engine-unit path (never execContext)", () => {
    const target = buildChildTarget(leafChildPlan());
    const plan = stepPlanWithTarget(target, "compose");
    const input: WorkListInput = { runId: "run-1", params: {}, stepOutputs: {} };

    const result = computeStepWorkList(plan, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const unit = result.list.units[0];
    expect(unit).toBeDefined();
    // P3a Review log R1's arm (step-work.ts's timeoutMs ternary): a
    // child-workflow target carries no exec spec of its own, so timeoutMs is
    // a value this layer can carry without an engine ever acting on it.
    expect(unit?.timeoutMs).toBeNull();
    // Any non-"command" frozenTarget kind resolves runner to "exec".
    expect(unit?.runner).toBe("exec");
    // A child-workflow unit gets a normal assembled engine-unit prompt
    // (buildUnitPrompt), never the exec-context env path shell/script units
    // use — `frozenExec` is only set for kind "shell" | "script".
    expect(unit?.prompt.length).toBeGreaterThan(0);
    expect(unit?.execContext).toBeUndefined();
  });
});
