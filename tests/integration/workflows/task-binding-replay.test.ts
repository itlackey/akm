// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * R-R15 (PR #844 review finding F6) — a reference binding's RESOLVED value
 * reaches the unit's prompt and its (informational) input hash, `hashVersion`
 * 7. Resume skips a completed unit by id: a resumed invocation whose upstream
 * journaled output changed reuses the completed row rather than re-running
 * work that already ran; a fresh run is what picks up new upstream output.
 *
 * Setup mirrors tests/integration/workflows/exec-unit.test.ts (sandbox +
 * seedWorkflowRun + storeFrozenWorkflowPlan + executeStepPlan with an
 * injected counting dispatcher). `inputBindings` are grafted onto the frozen
 * consume step post-freeze (chaos.test.ts's plant-the-exact-durable-state
 * pattern) so the fixture needs no task source / indexer pass — the executor
 * consumes only the frozen plan it is handed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openStateDatabase } from "../../../src/core/state-db";
import type { TaskInputBinding } from "../../../src/execution/input-contract";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import {
  executeStepPlan,
  type UnitDispatchRequest,
  type UnitDispatchResult,
} from "../../../src/workflows/exec/native-executor";
import { computeStepWorkList } from "../../../src/workflows/exec/step-work";
import type { IrStepPlanV4, WorkflowPlanGraphV4 } from "../../../src/workflows/ir/schema-v4";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../../_helpers/sandbox";
import { freezeWorkflow, seedWorkflowRun, storeFrozenWorkflowPlan } from "../../_helpers/workflow";

let storage: IsolatedAkmStorage;

const RUN_ID = "66666666-6666-4666-8666-666666666666";

const WF = `---
type: workflow
steps:
  - id: fetch
  - id: consume
---

## fetch

Fetch the thing.

## consume

Consume the thing.
`;

const BINDINGS: readonly TaskInputBinding[] = [
  { kind: "reference", name: "payload", from: "steps.fetch.output", schema: { type: "string" } },
];

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});

afterEach(() => storage.cleanup());

/**
 * Freeze the two-step workflow, graft the reference binding onto the consume
 * step's frozen target, seed + store the run so the journal has a home, and
 * return the consume step plan the executor is driven with.
 */
function seedBoundConsumeStep(): IrStepPlanV4 {
  // Deep-clone before grafting: freezeWorkflow Object.freezes its targets,
  // and the stored plan should carry the SAME bytes the executor is handed.
  const plan = JSON.parse(JSON.stringify(freezeWorkflow(WF))) as WorkflowPlanGraphV4;
  const root = plan.steps[1]!.root;
  if (!root || root.kind === "map") throw new Error("expected a solo consume root");
  (root.frozenTarget as { inputBindings?: readonly TaskInputBinding[] }).inputBindings = BINDINGS;

  const db = openStateDatabase();
  try {
    seedWorkflowRun(db, { runId: RUN_ID, steps: ["fetch", "consume"], currentStepId: "consume" });
    storeFrozenWorkflowPlan(db, RUN_ID, plan);
  } finally {
    db.close();
  }
  return plan.steps[1]!;
}

function countingDispatcher(reply: string) {
  let calls = 0;
  const prompts: string[] = [];
  const dispatcher = async (req: UnitDispatchRequest): Promise<UnitDispatchResult> => {
    calls++;
    prompts.push(req.prompt);
    return { ok: true, text: reply };
  };
  return { dispatcher, prompts, count: () => calls };
}

function invoke(step: IrStepPlanV4, upstreamOutput: string, dispatcher: ReturnType<typeof countingDispatcher>) {
  return executeStepPlan(step, {
    runId: RUN_ID,
    workflowRef: "workflows/demo",
    params: {},
    evidence: { fetch: { output: upstreamOutput } },
    dispatcher: dispatcher.dispatcher,
  });
}

describe("R-R15 — resolved task inputs reach the prompt and input hash; resume skips completed units", () => {
  test("resume reuses the journaled row whether or not the bound value changed", async () => {
    const step = seedBoundConsumeStep();

    // Pure layer, the repro's defect assertion INVERTED: the same frozen
    // step against two different upstream outputs now computes two different
    // unit hashes for the same content-derived unit id — and still delivers
    // two different prompts, as it always did.
    const listV1 = computeStepWorkList(step, { runId: RUN_ID, params: {}, stepOutputs: { fetch: "VALUE-ONE" } });
    const listV2 = computeStepWorkList(step, { runId: RUN_ID, params: {}, stepOutputs: { fetch: "VALUE-TWO" } });
    if (!listV1.ok || !listV2.ok) throw new Error("work list failed");
    expect(listV1.list.units[0]!.unitId).toBe(listV2.list.units[0]!.unitId);
    expect(listV1.list.units[0]!.inputHash).not.toBe(listV2.list.units[0]!.inputHash);
    expect(listV1.list.units[0]!.prompt).toContain("VALUE-ONE");
    expect(listV2.list.units[0]!.prompt).toContain("VALUE-TWO");

    // Invocation 1 ("original run"): upstream fetch produced VALUE-ONE — one
    // live dispatch, delivered through the "## Task inputs" block, journaled
    // completed under the hashVersion 7 input hash.
    const d1 = countingDispatcher("RESULT-FROM-VALUE-ONE");
    const r1 = await invoke(step, "VALUE-ONE", d1);
    expect(r1.ok).toBe(true);
    expect(d1.count()).toBe(1);
    expect(d1.prompts[0]).toContain("## Task inputs");
    expect(d1.prompts[0]).toContain("VALUE-ONE");

    const rows = await withWorkflowRunsRepo((repo) => repo.getUnitsForStep(RUN_ID, "consume"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("completed");
    expect(rows[0]!.input_hash).toBe(listV1.list.units[0]!.inputHash);

    // Invocation 2 (resume, upstream evidence byte-identical): the recomputed
    // hash matches the journaled row, so the row is reused — zero dispatches,
    // same promoted result. Unchanged inputs stay reusable across resume.
    const d2 = countingDispatcher("NEVER-DISPATCHED");
    const r2 = await invoke(step, "VALUE-ONE", d2);
    expect(r2.ok).toBe(true);
    expect(d2.count()).toBe(0);
    expect(r2.units[0]!.text).toBe("RESULT-FROM-VALUE-ONE");
    expect(r2.evidence.output).toBe("RESULT-FROM-VALUE-ONE");

    // Invocation 3 (resume where the upstream journaled artifact now says
    // VALUE-TWO): the same unit id recomputes a different input hash, which
    // is informational — the completed row is still the unit's result, so
    // nothing dispatches.
    const d3 = countingDispatcher("RESULT-FROM-VALUE-TWO");
    const r3 = await invoke(step, "VALUE-TWO", d3);
    expect(r3.ok).toBe(true);
    expect(d3.count()).toBe(0);
    expect(r3.evidence.output).toBe("RESULT-FROM-VALUE-ONE");
  });
});
