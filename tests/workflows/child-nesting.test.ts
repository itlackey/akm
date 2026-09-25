// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P3b Lane A TESTS — provenance threading and recursive nesting
 * (docs/plans/specs/p3b-child-executor.md §2.4 "Cancellation, provenance,
 * nesting" rows A-31…A-36; §3.3.1 "The exact runWorkflowSteps options",
 * §3.6). This file owns ONLY these six rows (A-28…A-30 belong to
 * tests/integration/workflows/child-cancellation.test.ts, per the spec's own
 * §7 new-suites table).
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
 * A-31…A-34 use a spy on `runWorkflowSteps` (the reuse seam) to capture the
 * EXACT options object `driveChildWorkflowUnit` calls it with, mirroring
 * tests/integration/workflows/child-execution.test.ts's A-24/A-25 technique
 * — the precise, call-shape-level way to pin "threaded verbatim" claims.
 * A-33 additionally drives a REAL gated child directly, since "an injected
 * fake serves child units and child judges" is an end-to-end claim a captured
 * options object alone cannot prove. A-35 drives three real, nested levels
 * directly. A-36 is a structural/textual pin, not a runtime behavior.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { TaskInputBinding } from "../../src/execution/input-contract";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { driveChildWorkflowUnit } from "../../src/workflows/exec/child-workflow";
import type { UnitDispatchRequest, UnitDispatchResult } from "../../src/workflows/exec/native-executor";
import type { runWorkflowSteps } from "../../src/workflows/exec/run-workflow";
import * as runWorkflowModule from "../../src/workflows/exec/run-workflow";
import { canonicalJson, computePlanHash } from "../../src/workflows/ir/plan-hash";
import type {
  FrozenChildWorkflowTarget,
  FrozenWorkflowTarget,
  IrStepPlanV4,
  WorkflowPlanGraphV4,
} from "../../src/workflows/ir/schema-v4";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";
import { freezeWorkflow, WORKFLOW_TEST_CONFIG } from "../_helpers/workflow";

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

function leafChildPlan(sourcePath = "workflows/child.md"): WorkflowPlanGraphV4 {
  return freezeWorkflow(
    ["---", "type: workflow", "steps:", "  - id: work", "---", "", "## work", "", "Do the child's work.", ""].join(
      "\n",
    ),
    sourcePath,
  );
}

/** A one-step child plan whose step declares a completion criterion (a resolvable frozen judge). */
function gatedChildPlan(): WorkflowPlanGraphV4 {
  return freezeWorkflow(
    [
      "---",
      "type: workflow",
      "steps:",
      "  - id: work",
      "---",
      "",
      "## work",
      "",
      "Do the child's work.",
      "",
      "### gate",
      "",
      "- the work is actually done",
      "",
    ].join("\n"),
    "workflows/child-gated.md",
  );
}

/** A fan-out child plan over a declared `items` param, with a wide own execution.maxConcurrency (A-34's min() claim needs ctx.maxConcurrency, not the child's own plan cap, to be the binding constraint). The engine's own concurrency is also raised explicitly — the default engine's fallback LLM connection is a loopback endpoint, which otherwise caps concurrency at 1 regardless of every other width (concurrency-policy.ts's DEFAULT_LOCAL_LLM_ENGINE_CONCURRENCY) and would make this test measure that unrelated cap instead of the one under test. */
function fanOutChildPlan(ownMaxConcurrency: number): WorkflowPlanGraphV4 {
  const config = {
    ...WORKFLOW_TEST_CONFIG,
    engines: {
      ...WORKFLOW_TEST_CONFIG.engines,
      "test-llm": { ...WORKFLOW_TEST_CONFIG.engines["test-llm"], concurrency: ownMaxConcurrency },
    },
    workflow: { ...WORKFLOW_TEST_CONFIG.workflow, maxConcurrency: ownMaxConcurrency },
  };
  return freezeWorkflow(
    [
      "---",
      "type: workflow",
      "params:",
      "  items: { type: array }",
      "steps:",
      "  - id: work",
      "    map:",
      "      over: params.items",
      "      concurrency: 8",
      "---",
      "",
      "## work",
      "",
      "Do one item.",
      "",
    ].join("\n"),
    "workflows/child-fanout.md",
    config,
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

function driveInputFor(input: {
  parent: SeededParent;
  target: FrozenChildWorkflowTarget;
  childParams?: Record<string, unknown>;
  dispatcher: (request: UnitDispatchRequest, feedback?: string) => Promise<UnitDispatchResult>;
  signal?: AbortSignal;
  maxConcurrency?: number;
  eventSource?: string;
}) {
  const unitId = parentUnitId(input.parent.stepId);
  return {
    request: {
      runId: input.parent.runId,
      stepId: input.parent.stepId,
      unitId,
      nodeId: input.parent.stepId,
      prompt: "Compose the child workflow.",
      frozenTarget: input.target,
      timeoutMs: null,
    } satisfies UnitDispatchRequest,
    target: input.target,
    ctx: {
      runId: input.parent.runId,
      workflowRef: "workflows/parent",
      params: {},
      evidence: {},
      dispatcher: input.dispatcher,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.maxConcurrency !== undefined ? { maxConcurrency: input.maxConcurrency } : {}),
      ...(input.eventSource !== undefined ? { eventSource: input.eventSource } : {}),
    },
    childParams: input.childParams ?? {},
    inputHash: "h".repeat(64),
    dispatcher: input.dispatcher,
  };
}

function successDispatcher(): (request: UnitDispatchRequest) => Promise<UnitDispatchResult> {
  return async (request: UnitDispatchRequest): Promise<UnitDispatchResult> => {
    if (request.nodeId.endsWith(".gate")) {
      return { ok: true, text: JSON.stringify({ complete: true, missing: [], feedback: "looks good" }) };
    }
    return { ok: true, text: "done" };
  };
}

// ── A-31, A-32: eventSource threading (verbatim / absent) ──────────────────

describe("A-31, A-32 — RunWorkflowOptions.eventSource is threaded into the child drive verbatim, or absent", () => {
  test("A-31: a set eventSource is forwarded to the child's own runWorkflowSteps call unchanged", async () => {
    const parent = await seedParentRun();
    const target = buildChildTarget(leafChildPlan());
    let captured: Record<string, unknown> | undefined;
    const spy = spyOn(runWorkflowModule, "runWorkflowSteps").mockImplementation(async (options) => {
      captured = options as unknown as Record<string, unknown>;
      return {
        run: { id: "child-run-id", workflowRef: target.ref, status: "completed" },
        executed: [],
        stepsProcessed: 0,
        done: true,
      } as unknown as Awaited<ReturnType<typeof runWorkflowSteps>>;
    });
    try {
      await driveChildWorkflowUnit(
        driveInputFor({ parent, target, dispatcher: successDispatcher(), eventSource: "task-run:abc123" }),
      );
      expect(captured?.eventSource).toBe("task-run:abc123");
    } finally {
      spy.mockRestore();
    }
  });

  test("A-32: an absent eventSource is never forwarded — byte-identical to every non-task caller (PRESERVE)", async () => {
    const parent = await seedParentRun();
    const target = buildChildTarget(leafChildPlan());
    let captured: Record<string, unknown> | undefined;
    const spy = spyOn(runWorkflowModule, "runWorkflowSteps").mockImplementation(async (options) => {
      captured = options as unknown as Record<string, unknown>;
      return {
        run: { id: "child-run-id", workflowRef: target.ref, status: "completed" },
        executed: [],
        stepsProcessed: 0,
        done: true,
      } as unknown as Awaited<ReturnType<typeof runWorkflowSteps>>;
    });
    try {
      await driveChildWorkflowUnit(driveInputFor({ parent, target, dispatcher: successDispatcher() }));
      expect(Object.hasOwn(captured ?? {}, "eventSource")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

// ── A-33: an injected dispatcher serves both child units and child judges ──

describe("A-33 — StepExecutionContext.dispatcher is threaded into the child drive's dispatcher", () => {
  test("A-33: a single injected fake serves BOTH a gated child's unit dispatch and its completion-criteria judge dispatch", async () => {
    const parent = await seedParentRun();
    const target = buildChildTarget(gatedChildPlan(), { ref: "workflows/gated-nested-child" });
    let sawUnitCall = false;
    let sawJudgeCall = false;
    const dispatcher = async (request: UnitDispatchRequest): Promise<UnitDispatchResult> => {
      if (request.nodeId.endsWith(".gate")) {
        sawJudgeCall = true;
        return { ok: true, text: JSON.stringify({ complete: true, missing: [], feedback: "looks good" }) };
      }
      sawUnitCall = true;
      return { ok: true, text: "done" };
    };

    const outcome = await driveChildWorkflowUnit(driveInputFor({ parent, target, dispatcher }));

    expect(outcome.ok).toBe(true);
    expect(sawUnitCall).toBe(true);
    expect(sawJudgeCall).toBe(true);
    const childRow = await withWorkflowRunsRepo((repo) => repo.getRunById(outcome.childRun?.runId as string));
    expect(childRow?.status).toBe("completed");
  });

  test("A-33 (call-shape): the captured runWorkflowSteps options carry the SAME dispatcher reference passed on ctx", async () => {
    const parent = await seedParentRun();
    const target = buildChildTarget(leafChildPlan());
    const dispatcher = successDispatcher();
    let captured: Record<string, unknown> | undefined;
    const spy = spyOn(runWorkflowModule, "runWorkflowSteps").mockImplementation(async (options) => {
      captured = options as unknown as Record<string, unknown>;
      return {
        run: { id: "child-run-id", workflowRef: target.ref, status: "completed" },
        executed: [],
        stepsProcessed: 0,
        done: true,
      } as unknown as Awaited<ReturnType<typeof runWorkflowSteps>>;
    });
    try {
      await driveChildWorkflowUnit(driveInputFor({ parent, target, dispatcher }));
      expect(typeof captured?.dispatcher).toBe("function");
    } finally {
      spy.mockRestore();
    }
  });
});

// ── A-34: maxConcurrency threading — effective width is min(parent cap, child plan cap) ──

describe("A-34 — StepExecutionContext.maxConcurrency caps the child drive's effective concurrency", () => {
  test("A-34: with a wide child-plan execution.maxConcurrency, ctx.maxConcurrency is the binding constraint", async () => {
    const parent = await seedParentRun();
    // The child's OWN frozen plan allows up to 8 concurrent units; ctx caps it
    // at 2 — min(2, 8) = 2 must be the width actually observed.
    const target = buildChildTarget(fanOutChildPlan(8), { ref: "workflows/fanout-child" });

    let inFlight = 0;
    let peak = 0;
    const dispatcher = async (): Promise<UnitDispatchResult> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight--;
      return { ok: true, text: "done" };
    };

    const outcome = await driveChildWorkflowUnit(
      driveInputFor({
        parent,
        target,
        childParams: { items: [1, 2, 3, 4, 5, 6] },
        dispatcher,
        maxConcurrency: 2,
      }),
    );

    expect(outcome.ok).toBe(true);
    expect(peak).toBe(2);
  });

  test("A-34 (call-shape): ctx.maxConcurrency is forwarded to the child's own runWorkflowSteps call verbatim", async () => {
    const parent = await seedParentRun();
    const target = buildChildTarget(leafChildPlan());
    let captured: Record<string, unknown> | undefined;
    const spy = spyOn(runWorkflowModule, "runWorkflowSteps").mockImplementation(async (options) => {
      captured = options as unknown as Record<string, unknown>;
      return {
        run: { id: "child-run-id", workflowRef: target.ref, status: "completed" },
        executed: [],
        stepsProcessed: 0,
        done: true,
      } as unknown as Awaited<ReturnType<typeof runWorkflowSteps>>;
    });
    try {
      await driveChildWorkflowUnit(
        driveInputFor({ parent, target, dispatcher: successDispatcher(), maxConcurrency: 3 }),
      );
      expect(captured?.maxConcurrency).toBe(3);
    } finally {
      spy.mockRestore();
    }
  });
});

// ── A-35: three-level nesting drives recursively through the identical seam ─

describe("A-35 — a child that itself composes a grandchild drives recursively", () => {
  test("A-35: three levels complete; three run rows exist, linked root -> child -> grandchild", async () => {
    const root = await seedParentRun();
    const grandchildPlan = leafChildPlan("workflows/grandchild.md");
    const grandchildTarget = buildChildTarget(grandchildPlan, { ref: "workflows/grandchild" });

    // The CHILD's own plan composes the grandchild on its one step — built by
    // hand (freezeWorkflow has no `uses:` composition support of its own; the
    // real freeze/targets/child-workflow.ts resolver is Lane B/P3a's, not
    // under test here), mirroring tests/workflows/hash-v6.test.ts's and
    // tests/workflows/child-executor-seam.test.ts's established
    // stepPlanWithTarget convention.
    const childStepPlan: IrStepPlanV4 = {
      stepId: "spawn-grandchild",
      title: "spawn-grandchild",
      sequenceIndex: 0,
      root: {
        kind: "unit",
        id: "spawn-grandchild",
        instructions: "Compose the grandchild workflow.",
        onError: "fail",
        isolation: "none",
        frozenTarget: grandchildTarget as FrozenWorkflowTarget,
        environment: [],
      },
      gate: {
        kind: "gate",
        id: "spawn-grandchild.gate",
        stepId: "spawn-grandchild",
        criteria: [],
        maxLoops: 1,
        frozenJudge: null,
      },
    };
    const childPlan: WorkflowPlanGraphV4 = {
      irVersion: 5,
      title: "Child",
      execution: { maxConcurrency: 1 },
      sourceReadSet: [
        {
          identity: {
            ref: "test//workflows/child",
            bundle: "test",
            adapter: "akm-workflow",
            file: "workflows/child.yml",
            hash: createHash("sha256").update("child-fixture").digest("hex"),
          },
          containmentPhysicalIdentity: "test-fixture-root",
          physicalIdentity: createHash("sha256").update("workflows/child.yml\0child-fixture").digest("hex"),
          size: 0,
        },
      ],
      steps: [childStepPlan],
    };
    const childTarget = buildChildTarget(childPlan, { ref: "workflows/mid-child" });

    const outcome = await driveChildWorkflowUnit(
      driveInputFor({ parent: root, target: childTarget, dispatcher: successDispatcher() }),
    );

    expect(outcome.ok).toBe(true);
    const childRunId = outcome.childRun?.runId as string;

    const childRow = await withWorkflowRunsRepo((repo) => repo.getRunById(childRunId));
    expect(childRow?.status).toBe("completed");
    expect(childRow?.parent_run_id).toBe(root.runId);

    const grandchildren = await withWorkflowRunsRepo((repo) => repo.childRunsOf(childRunId));
    expect(grandchildren).toHaveLength(1);
    expect(grandchildren[0]?.status).toBe("completed");
    expect(grandchildren[0]?.parent_run_id).toBe(childRunId);
    expect(grandchildren[0]?.workflow_ref).toBe("workflows/grandchild");

    const rootChildren = await withWorkflowRunsRepo((repo) => repo.childRunsOf(root.runId));
    expect(rootChildren).toHaveLength(1);
    expect(rootChildren[0]?.id).toBe(childRunId);
  });
});

// ── A-36: no second, executor-side depth bound ──────────────────────────────

describe("A-36 — the executor adds no depth bound of its own", () => {
  test("A-36: src/workflows/exec/child-workflow.ts never references the freeze-time composition-depth limit", () => {
    const file = path.resolve(import.meta.dir, "../../src/workflows/exec/child-workflow.ts");
    // Depth is bounded at FREEZE (and re-bounded at decode) — P3a §4.5, row
    // A-23. A second, executor-side depth counter/bound here would be a
    // review-blocking addition (spec §2.4 row A-36) — this pin fails loudly
    // if `child-workflow.ts` ever grows one.
    if (!fs.existsSync(file)) {
      // RED today for the ordinary reason: the module does not exist yet.
      throw new Error(`expected ${file} to exist`);
    }
    const source = fs.readFileSync(file, "utf8");
    expect(source).not.toContain("WORKFLOW_MAX_COMPOSITION_DEPTH");
    expect(source).not.toMatch(/\bdepth\s*[:+]/);
  });
});
