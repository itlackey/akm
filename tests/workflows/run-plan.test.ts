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
import { computeStepWorkList } from "../../src/workflows/exec/step-work";
import { canonicalPlanJson } from "../../src/workflows/ir/plan-hash";
import type { WorkflowPlanStep } from "../../src/workflows/plan";
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

const execPlan = freezeWorkflow(`---
type: workflow
steps:
  - id: build
    unit:
      exec:
        command: [bun, run, build]
---

## build

Build.
`);

interface ExecPlanJson {
  irVersion: number;
  steps: Array<{ root: { frozenTarget: Record<string, unknown>; environment: unknown[] } }>;
}

/** What 0.10 pre-releases froze for an exec step: physical locations beside the identities. */
function irVersion6ExecPlan(): ExecPlanJson {
  const raw = JSON.parse(canonicalPlanJson(execPlan)) as ExecPlanJson;
  const unit = raw.steps[0]!.root;
  unit.frozenTarget.cwdIdentity = {
    requestedRoot: "/gone/rev1",
    realRoot: "/gone/rev1",
    rootDevice: "7",
    rootInode: "100",
    requestedCwd: "/gone/rev1",
    realCwd: "/gone/rev1",
    cwdDevice: "7",
    cwdInode: "100",
  };
  unit.environment = [
    {
      kind: "env-ref",
      ref: "team//env/prod",
      owner: {
        bundle: "team",
        adapter: "dotenv",
        requestedRoot: "/gone/rev1",
        requestedPath: "/gone/rev1/env/prod.env",
        relativePath: "env/prod.env",
      },
      keys: ["TOKEN"],
      secretNames: ["secrets/token"],
      precedence: 0,
    },
  ];
  return { ...raw, irVersion: 6 };
}

describe("readRunPlan — an older plan runs", () => {
  test("a decodable plan is read whatever irVersion the row and the plan itself record", () => {
    for (const version of [null, 3, 4, 5, 7]) {
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

/** The unit input hash of a step's only unit, as `computeStepWorkList` derives it. */
function unitInputHash(step: WorkflowPlanStep): string {
  const work = computeStepWorkList(step, { runId: "run", params: {}, stepOutputs: {} });
  if (!work.ok) throw new Error(work.error);
  return work.list.units[0]!.inputHash;
}

describe("readRunPlan — a stored plan keeps its stored targets", () => {
  test("an irVersion 6 plan decodes with its frozen locations carried unread, so its hashes survive the upgrade", () => {
    const raw = irVersion6ExecPlan();
    const read = readRunPlan({ id: "v6-run", plan_json: JSON.stringify(raw), plan_ir_version: 6 });
    if (!read.ok) throw new Error(read.problem);
    const unit = read.plan.steps[0]?.root;
    if (!unit || unit.kind !== "unit") throw new Error("expected a unit");
    const stored = raw.steps[0]!.root;
    expect(unit.frozenTarget).toEqual(stored.frozenTarget as never);
    expect(unit.environment).toEqual(stored.environment as never);
    expect(unitInputHash(read.plan.steps[0]!)).toBe(unitInputHash(raw.steps[0] as unknown as WorkflowPlanStep));
  });

  test("an irVersion 6 command target keeps its cwdIdentity and its retired secret:// credential as stored", () => {
    const raw = JSON.parse(canonicalPlanJson(plan)) as ExecPlanJson;
    const target = raw.steps[0]!.root.frozenTarget as { cwdIdentity?: unknown; runner: Record<string, unknown> };
    target.cwdIdentity = { requestedRoot: "/gone/rev1", realRoot: "/gone/rev1", requestedCwd: "/gone/rev1" };
    target.runner.fallbackApiKeySecretRef = "secret://openai";
    const read = readRunPlan({ id: "v6-cmd", plan_json: JSON.stringify({ ...raw, irVersion: 6 }), plan_ir_version: 6 });
    if (!read.ok) throw new Error(read.problem);
    const unit = read.plan.steps[0]?.root;
    if (!unit || unit.kind !== "unit" || unit.frozenTarget.kind !== "command") throw new Error("expected a command");
    expect(unit.frozenTarget.cwdIdentity).toEqual(target.cwdIdentity as never);
    expect((unit.frozenTarget.runner as unknown as Record<string, unknown>).fallbackApiKeySecretRef).toBe(
      "secret://openai",
    );
    expect(unitInputHash(read.plan.steps[0]!)).toBe(unitInputHash(raw.steps[0] as unknown as WorkflowPlanStep));
  });

  test("a plan that never recorded a location decodes", () => {
    const raw = irVersion6ExecPlan();
    const unit = raw.steps[0]!.root;
    delete unit.frozenTarget.cwdIdentity;
    unit.environment = [{ kind: "env-ref", ref: "team//env/prod", precedence: 0 }];
    const read = readRunPlan({ id: "v7-run", plan_json: JSON.stringify({ ...raw, irVersion: 7 }), plan_ir_version: 7 });
    if (!read.ok) throw new Error(read.problem);
    expect(read.plan.irVersion).toBe(7);
    expect(read.plan.steps[0]?.root).toMatchObject({ environment: [{ kind: "env-ref", precedence: 0 }] });
  });
});

describe("readRunPlan — a newer akm's plan is refused", () => {
  test("a plan a newer akm froze is refused even when it decodes, naming the upgrade", () => {
    const planJson = JSON.stringify({ ...JSON.parse(canonicalPlanJson(plan)), irVersion: 8 });
    const read = readRunPlan({ id: "future-ok", plan_json: planJson, plan_ir_version: 8 });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.newer).toBe(true);
    expect(read.problem).toContain("future-ok");
    expect(read.problem).toContain("frozen by a newer akm (plan irVersion 8)");
    expect(read.problem).toContain("Upgrade akm");
  });

  test("a v7 command target's cwdIdentity of {} decodes and is carried, unread", () => {
    // Freeze writes it so 0.10.0 and earlier, which decode a command-only v7 plan, refuse it at dispatch.
    const raw = JSON.parse(canonicalPlanJson(plan)) as ExecPlanJson;
    raw.steps[0]!.root.frozenTarget.cwdIdentity = {};
    const read = readRunPlan({ id: "v7-cmd", plan_json: JSON.stringify(raw), plan_ir_version: 7 });
    if (!read.ok) throw new Error(read.problem);
    expect(JSON.parse(canonicalPlanJson(read.plan))).toEqual(raw as never);
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
    const read = readRunPlan({ id: "future-run", plan_json: '{"irVersion":8,"novel":true}', plan_ir_version: 8 });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.newer).toBe(true);
    expect(read.problem).toContain("frozen by a newer akm (plan irVersion 8)");
    expect(read.problem).toContain("Upgrade akm");
  });
});
