// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `readRunPlan` — the tolerant read of a run row's frozen plan. A plan that
 * decodes runs whatever `plan_ir_version`/`plan_hash` say; one that cannot be
 * decoded comes back as a problem sentence naming the run (the engine then
 * abandons the run — `tests/integration/workflows/frozen-plan.test.ts`).
 * Pure in-memory logic (no db/network/spawn).
 */

import { describe, expect, test } from "bun:test";
import { canonicalPlanJson } from "../../src/workflows/ir/plan-hash";
import { readRunPlan } from "../../src/workflows/runtime/run-plan";
import { freezeWorkflow } from "../_helpers/workflow";

const plan = freezeWorkflow(`---
type: workflow
steps:
  - id: only-step
---

## only-step

Do the work.
`);

describe("readRunPlan — an older plan runs", () => {
  test("a decodable plan is read whatever irVersion the row and the plan itself record", () => {
    for (const version of [null, 3, 4, 5, 111]) {
      const planJson = JSON.stringify({ ...JSON.parse(canonicalPlanJson(plan)), irVersion: version ?? 5 });
      const read = readRunPlan({ id: `run-${version}`, plan_json: planJson, plan_ir_version: version });
      if (!read.ok) throw new Error(read.problem);
      expect(read.plan.steps.map((step) => step.stepId)).toEqual(["only-step"]);
    }
  });

  test("an irVersion 5 plan (source read set, host executable identity) decodes into the current plan", () => {
    const current = JSON.parse(canonicalPlanJson(plan)) as Record<string, unknown> & {
      steps: Array<{ root: { frozenTarget: Record<string, unknown> } }>;
    };
    const { sourceHash, ...rest } = current;
    const target = current.steps[0]?.root.frozenTarget ?? {};
    const v5 = {
      ...rest,
      irVersion: 5,
      sourceReadSet: [
        {
          identity: {
            ref: "local//workflows/demo",
            bundle: "local",
            adapter: "akm",
            file: "workflows/demo.md",
            hash: sourceHash,
          },
          containmentPhysicalIdentity: "inode:1:2",
          physicalIdentity: "inode:1:3",
          size: 10,
        },
      ],
      steps: [
        {
          ...current.steps[0],
          root: { ...current.steps[0]?.root, frozenTarget: { ...target, executable: { requested: "x" } } },
        },
      ],
    };
    const read = readRunPlan({
      id: "v5-run",
      plan_json: JSON.stringify(v5),
      plan_ir_version: 5,
      workflow_ref: "local//workflows/demo",
    });
    if (!read.ok) throw new Error(read.problem);
    expect(read.plan.sourceHash).toBe(sourceHash as string);
    expect(read.plan.steps[0]?.root?.kind).toBe("unit");
    const unit = read.plan.steps[0]?.root;
    expect(unit?.kind === "unit" ? unit.frozenTarget.kind : undefined).toBe("command");
  });

  test("non-canonical bytes (whitespace, key order) decode — nothing re-hashes the stored plan", () => {
    const reordered = Object.fromEntries(Object.entries(JSON.parse(canonicalPlanJson(plan))).reverse());
    const read = readRunPlan({ id: "pretty", plan_json: JSON.stringify(reordered, null, 2), plan_ir_version: 5 });
    expect(read.ok).toBe(true);
  });
});

describe("readRunPlan — an undecodable plan is a problem, not an exception", () => {
  test("invalid JSON names the run", () => {
    const read = readRunPlan({ id: "corrupt-run", plan_json: "{not json", plan_ir_version: 5 });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problem).toContain("Workflow run corrupt-run has a frozen plan this akm cannot decode");
  });

  test("a shape this akm cannot decode names the run and the version it was frozen as", () => {
    const read = readRunPlan({ id: "old-run", plan_json: '{"irVersion":2}', plan_ir_version: 2 });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problem).toContain("old-run");
    expect(read.problem).toContain("frozen as plan irVersion 2");
  });

  test("a missing plan names the run", () => {
    const read = readRunPlan({ id: "planless", plan_json: null, plan_ir_version: null });
    expect(read).toEqual({ ok: false, newer: false, problem: "Workflow run planless has no frozen workflow plan." });
  });

  test("a newer akm's plan that does not decode names upgrading akm as the remedy", () => {
    const read = readRunPlan({ id: "future-run", plan_json: '{"irVersion":7,"novel":true}', plan_ir_version: 7 });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.newer).toBe(true);
    expect(read.problem).toContain("frozen by a newer akm (plan irVersion 7)");
    expect(read.problem).toContain("Upgrade akm");
  });
});
