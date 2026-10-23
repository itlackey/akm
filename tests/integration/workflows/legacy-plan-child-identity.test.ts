// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #1238 — an interrupted irVersion 6 parent resumed on this code recovers its
 * child run instead of publishing a second one. The child's invocation key is
 * derived from the parent unit's input hash, which covers the embedded child
 * plan's frozen target; a v6 plan's stored `cwdIdentity` is part of that
 * preimage, so decoding the plan must keep it. Integration-classified
 * (ORG-03/04/05/06): real state.db.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import { computeChildInvocationKey } from "../../../src/workflows/exec/child-invocation";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import { computeStepWorkList } from "../../../src/workflows/exec/step-work";
import type { WorkflowPlan, WorkflowPlanStep } from "../../../src/workflows/plan";
import { frozenStepRows } from "../../../src/workflows/runtime/run-plan";
import { startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../../_helpers/sandbox";
import { childParentDoc } from "../../_helpers/workflow";
import { writeProgram } from "../_helpers/workflow-crossproc";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});

afterEach(() => storage.cleanup());

const CHILD = [
  "---",
  "type: workflow",
  "steps:",
  "  - id: build",
  "    unit:",
  "      exec:",
  "        command: [echo, hi]",
  "---",
  "",
  "## build",
  "",
  "Build.",
  "",
].join("\n");

describe("an interrupted v6 parent resumed after the upgrade (#1238)", () => {
  test("recovers the child it already published instead of publishing a duplicate", async () => {
    writeProgram(storage.stashDir, "v6-child", CHILD);
    writeProgram(storage.stashDir, "v6-parent", childParentDoc([{ id: "dispatch", workflow: "workflows/v6-child" }]));
    const started = await startWorkflowRun("workflows/v6-parent", {});
    const parentRunId = started.run.id;

    // Rewrite the stored plan as 0.10 pre-releases froze it: a nested shell target with its cwdIdentity.
    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(parentRunId));
    const raw = JSON.parse(row?.plan_json ?? "null") as WorkflowPlan & { irVersion: number };
    const step = raw.steps[0] as WorkflowPlanStep;
    const parentUnit = step.root;
    if (parentUnit?.kind !== "unit" || parentUnit.frozenTarget.kind !== "child-workflow") {
      throw new Error("expected a child-workflow unit");
    }
    const childTarget = parentUnit.frozenTarget;
    const childPlan = childTarget.frozenPlan as { irVersion: number; steps: WorkflowPlanStep[] };
    const childUnit = childPlan.steps[0]?.root;
    if (childUnit?.kind !== "unit" || childUnit.frozenTarget.kind !== "shell") throw new Error("expected a shell unit");
    (childUnit.frozenTarget as unknown as Record<string, unknown>).cwdIdentity = {
      requestedRoot: "/gone/rev1",
      realRoot: "/gone/rev1",
      rootDevice: "7",
      rootInode: "100",
      requestedCwd: "/gone/rev1",
      realCwd: "/gone/rev1",
      cwdDevice: "7",
      cwdInode: "100",
    };
    raw.irVersion = 6;
    childPlan.irVersion = 6;
    const db = openStateDatabase(getStateDbPath());
    try {
      db.prepare("UPDATE workflow_runs SET plan_json = ?, plan_ir_version = 6 WHERE id = ?").run(
        JSON.stringify(raw),
        parentRunId,
      );
    } finally {
      db.close();
    }

    // What 0.10 pre-releases derived for the composing unit, from the plan exactly as stored, and the child
    // run they had already published under that key before the crash.
    const work = computeStepWorkList(step, { runId: parentRunId, params: {}, stepOutputs: {} });
    if (!work.ok) throw new Error(work.error);
    const unit = work.list.units[0]!;
    const now = new Date().toISOString();
    const childRunId = "11111111-1111-4111-8111-111111111111";
    await withWorkflowRunsRepo((repo) =>
      repo.publishChildWorkflowRun({
        parentRunId,
        spawnedByUnitId: unit.journalBaseId,
        invocationKey: computeChildInvocationKey({
          parentRunId,
          parentUnitId: unit.journalBaseId,
          unitInputHash: unit.inputHash,
        }),
        run: {
          id: childRunId,
          workflowRef: childTarget.ref,
          workflowTitle: "v6-child",
          paramsJson: "{}",
          currentStepId: "build",
          createdAt: now,
          updatedAt: now,
          agentHarness: row?.agent_harness ?? null,
          agentSessionId: row?.agent_session_id ?? null,
        },
        steps: frozenStepRows(childPlan as unknown as WorkflowPlan).map((s) => ({ runId: childRunId, ...s })),
        planJson: JSON.stringify(childPlan),
        planHash: childTarget.planHash,
      }),
    );

    const result = await runWorkflowSteps({
      target: parentRunId,
      dispatcher: async () => ({ ok: true, text: "done" }),
    });

    expect(result.run.status).toBe("completed");
    const children = await withWorkflowRunsRepo((repo) => repo.childRunsOf(parentRunId));
    expect(children.map((child) => child.id)).toEqual([childRunId]);
  });
});
