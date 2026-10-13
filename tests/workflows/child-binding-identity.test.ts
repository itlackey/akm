// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The IDENTITY suite for child-workflow `with:` bindings:
 *
 *   - a child step with no `with:` and a child declaring no params freezes
 *     `inputBindings` ABSENT, never `[]`, so a binding-free target's canonical
 *     JSON (and every hash over it) carries no stray key;
 *   - `computeUnitInputHash`'s prefix, `hashVersion` and `WORKFLOW_PLAN_VERSION`
 *     are pinned externally, field for field;
 *   - freezing the identical bound workflow twice yields byte-identical plan
 *     hashes and unit input hashes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../src/core/config/config";
import { akmIndex } from "../../src/indexer/indexer";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { computeStepWorkList } from "../../src/workflows/exec/step-work";
import { canonicalJson } from "../../src/workflows/ir/plan-hash";
import { WORKFLOW_PLAN_VERSION } from "../../src/workflows/plan";
import { decodeWorkflowPlan } from "../../src/workflows/runtime/run-plan";
import { abandonWorkflowRun, startWorkflowRun } from "../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";
import { childParentDoc } from "../_helpers/workflow";

const STEP_ID = "dispatch";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
  resetConfigCache();
});

afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

function write(relative: string, content: string): void {
  const file = path.join(storage.stashDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function leafChild(params = ""): string {
  return `---\ntype: workflow\n${params}steps:\n  - id: work\n---\n\n## work\n\nDo the child work.\n`;
}

async function planRow(runId: string) {
  return withWorkflowRunsRepo((repo) => repo.getRunById(runId));
}

/** Start a fresh run of `ref` and return its run id, stored plan_hash, and decoded plan. */
async function freeze(ref: string) {
  const started = await startWorkflowRun(ref);
  const row = await planRow(started.run.id);
  return {
    runId: started.run.id,
    planHash: row?.plan_hash ?? null,
    plan: decodeWorkflowPlan(JSON.parse(row?.plan_json ?? "null")),
  };
}

describe("child binding identity — absence-when-empty is the identity-preserving default", () => {
  test("a child step whose child declares no params, with no with:, freezes a target with no inputBindings key", async () => {
    write("workflows/child.md", leafChild());
    write("workflows/no-with.md", childParentDoc([{ id: STEP_ID, workflow: "workflows/child" }]));
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const { plan } = await freeze("workflows/no-with");
    const root = plan.steps[0]!.root;
    if (!root || root.kind === "map") throw new Error("expected the step to freeze a solo unit root");
    const target = root.frozenTarget;

    expect(target.kind).toBe("child-workflow");
    expect(Object.hasOwn(target, "inputBindings")).toBe(false);
    // The canonical JSON preimage never even mentions the key, so a stray
    // `inputBindings: []` cannot slip past the own-key check by construction.
    expect(canonicalJson(target)).not.toContain("inputBindings");
  });
});

describe("child binding identity — the frozen hash vocabulary is unchanged", () => {
  test('WORKFLOW_PLAN_VERSION is 6, and computeUnitInputHash\'s prefix + hashVersion are exactly "akm.workflow.unit\\0v7\\0" / 7', async () => {
    expect(WORKFLOW_PLAN_VERSION).toBe(6);

    write(
      "workflows/plain-command.md",
      `---\ntype: workflow\nsteps:\n  - id: ${STEP_ID}\n---\n\n## ${STEP_ID}\n\nSay hi.\n`,
    );
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const { runId, plan } = await freeze("workflows/plain-command");
    const root = plan.steps[0]!.root;
    if (!root || root.kind === "map") throw new Error("expected the step to freeze a solo unit root");

    // Reconstructed externally, field for field, from step-work.ts's own
    // computeUnitInputHash preimage: a plain step (no fan-out, no declared step
    // `inputs:`, no gate feedback, no inputBindings) carries no `taskInputs` key.
    const expectedPreimage = {
      hashVersion: 7,
      role: "unit",
      stepId: plan.steps[0]!.stepId,
      nodeId: root.id,
      template: root.instructions,
      item: null,
      inputs: [],
      params: {},
      frozenTarget: root.frozenTarget,
      environment: root.environment,
      schema: root.schema ?? null,
      isolation: "none",
    };
    const expectedHash = createHash("sha256")
      .update("akm.workflow.unit\0v7\0")
      .update(canonicalJson(expectedPreimage))
      .digest("hex");

    const computed = computeStepWorkList(plan.steps[0]!, { runId, params: {}, stepOutputs: {} });
    if (!computed.ok) throw new Error(`computeStepWorkList failed: ${computed.error}`);
    expect(computed.list.units[0]!.inputHash).toBe(expectedHash);
  });
});

describe("child binding identity — freezing the identical bound workflow twice is byte-identical", () => {
  test("two independent freezes of the same with:-bound child step produce byte-identical plan hashes and unit input hashes", async () => {
    write("workflows/child.md", leafChild("params:\n  ticket: { type: string }\n"));
    write(
      "workflows/bound-repeat.md",
      childParentDoc([{ id: STEP_ID, workflow: "workflows/child", with: { ticket: "T-1" } }]),
    );
    await akmIndex({ stashDir: storage.stashDir, full: true });

    // Two genuinely independent freezes: re-planning is always an explicit new
    // run. A second concurrent run of the same ref is refused, so abandon the
    // first between freezes; abandonment does not touch its persisted plan.
    const first = await freeze("workflows/bound-repeat");
    await abandonWorkflowRun(first.runId);
    const second = await freeze("workflows/bound-repeat");

    expect(first.planHash).not.toBeNull();
    expect(first.planHash).toBe(second.planHash);

    const firstUnit = computeStepWorkList(first.plan.steps[0]!, { runId: first.runId, params: {}, stepOutputs: {} });
    const secondUnit = computeStepWorkList(second.plan.steps[0]!, {
      runId: second.runId,
      params: {},
      stepOutputs: {},
    });
    if (!firstUnit.ok) throw new Error(`computeStepWorkList failed: ${firstUnit.error}`);
    if (!secondUnit.ok) throw new Error(`computeStepWorkList failed: ${secondUnit.error}`);
    expect(firstUnit.list.units[0]!.inputHash).toBe(secondUnit.list.units[0]!.inputHash);
  });
});
