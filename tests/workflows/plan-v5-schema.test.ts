// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Decoding a stored plan whose unit targets a child workflow: the embedded
 * child plan decodes recursively, its recorded hashes and irVersion are
 * provenance rather than gates, and nesting depth is unbounded. Fixtures are
 * hand-built JSON spliced from independently frozen one-unit plans.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalJson, canonicalPlanJson, computePlanHash } from "../../src/workflows/ir/plan-hash";
import { decodeWorkflowPlan } from "../../src/workflows/runtime/run-plan";
import { freezeWorkflow } from "../_helpers/workflow";

const ONE_STEP_MD = [
  "---",
  "type: workflow",
  "steps:",
  "  - id: work",
  "---",
  "",
  "## work",
  "",
  "Do the work.",
  "",
].join("\n");

/**
 * A fresh, independently-valid one-unit plan, forced to declare irVersion 5.
 * No explicit return type: `JSON.parse` is already `any` (lib.d.ts), and
 * spreading it keeps the object `any` — every caller below treats this as
 * plain untyped JSON on the way into `decodeWorkflowPlan(input: unknown)`.
 */
function freshUnitPlan(sourcePath: string) {
  return { ...JSON.parse(canonicalPlanJson(freezeWorkflow(ONE_STEP_MD, sourcePath))), irVersion: 5 };
}

/** §3.5's exact `contentHash` formula. */
function childContentHash(fields: {
  ref: string;
  planHash: string;
  via: "direct" | "task";
  taskRef?: string;
  inputBindings?: unknown;
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

/** A structurally-correct `FrozenChildWorkflowTarget` (§3.5), as plain JSON. */
function buildChildTarget(options: {
  ref?: string;
  planHash: string;
  frozenPlan: unknown;
  via?: "direct" | "task";
  taskRef?: string;
  inputBindings?: unknown;
}): unknown {
  const ref = options.ref ?? "workflows/child";
  const via = options.via ?? "direct";
  return {
    kind: "child-workflow",
    ref,
    planHash: options.planHash,
    frozenPlan: options.frozenPlan,
    contentHash: childContentHash({
      ref,
      planHash: options.planHash,
      via,
      taskRef: options.taskRef,
      inputBindings: options.inputBindings,
    }),
    via,
    ...(options.taskRef ? { taskRef: options.taskRef } : {}),
    ...(options.inputBindings ? { inputBindings: options.inputBindings } : {}),
  };
}

/** Splice `childTarget` into `parentPlan`'s (sole) unit's `frozenTarget`. No explicit return type: see {@link freshUnitPlan}. */
function embedChildTarget(parentPlan: unknown, childTarget: unknown) {
  const cloned = JSON.parse(JSON.stringify(parentPlan));
  cloned.steps[0].root.frozenTarget = childTarget;
  return cloned;
}

/** A loose view onto a decoded plan's child-workflow frozenTarget (see file header). */
interface DecodedChildTargetView {
  readonly kind: "child-workflow";
  readonly ref: string;
  readonly planHash: string;
  readonly via: "direct" | "task";
  readonly taskRef?: string;
}

function asChildTargetView(frozenTarget: unknown): DecodedChildTargetView {
  return frozenTarget as unknown as DecodedChildTargetView;
}

describe("plan irVersion 5 — a child-workflow frozen target decodes (A-01, A-02)", () => {
  test("a parent plan whose unit targets a child workflow decodes: irVersion 5, frozenTarget.kind child-workflow", () => {
    const childPlan = freshUnitPlan("workflows/child.md");
    const planHash = computePlanHash(childPlan);
    const childTarget = buildChildTarget({ ref: "workflows/child", planHash, frozenPlan: childPlan, via: "direct" });
    const parentPlanJson = embedChildTarget(freshUnitPlan("workflows/parent.md"), childTarget);

    expect(() => decodeWorkflowPlan(parentPlanJson)).not.toThrow();

    const decoded = decodeWorkflowPlan(parentPlanJson);
    expect(decoded.irVersion).toBe<number>(5);
    expect(decoded.steps).toHaveLength(1); // A-02: structurally sound, like any other decoded plan
    const root = decoded.steps[0]?.root;
    if (!root || root.kind === "map") throw new Error("expected a solo unit root");
    expect(root.frozenTarget.kind).toBe<string>("child-workflow");
    const target = asChildTargetView(root.frozenTarget);
    expect(target.ref).toBe("workflows/child");
    expect(target.planHash).toBe(planHash);
    expect(target.via).toBe("direct");
  });

  test("the same fixture, task-wrapped (via: task, taskRef present), also decodes", () => {
    const childPlan = freshUnitPlan("workflows/child-via-task.md");
    const planHash = computePlanHash(childPlan);
    const childTarget = buildChildTarget({
      ref: "workflows/child-via-task",
      planHash,
      frozenPlan: childPlan,
      via: "task",
      taskRef: "tasks/nested",
    });
    const parentPlanJson = embedChildTarget(freshUnitPlan("workflows/parent-via-task.md"), childTarget);

    expect(() => decodeWorkflowPlan(parentPlanJson)).not.toThrow();
    const decoded = decodeWorkflowPlan(parentPlanJson);
    const root = decoded.steps[0]?.root;
    if (!root || root.kind === "map") throw new Error("expected a solo unit root");
    expect(root.frozenTarget.kind).toBe<string>("child-workflow");
    const target = asChildTargetView(root.frozenTarget);
    expect(target.via).toBe("task");
    expect(target.taskRef).toBe("tasks/nested");
  });
});

describe("embedded child plans at decode (A-20…A-23, §2.7)", () => {
  test("an embedded child's planHash, contentHash and irVersion are recorded, not gates: stale hashes and an older irVersion decode", () => {
    const childPlan = freshUnitPlan("workflows/child-provenance.md");
    const childTarget = buildChildTarget({
      ref: "workflows/child",
      planHash: computePlanHash(childPlan),
      frozenPlan: childPlan,
      via: "direct",
    });
    const plan = JSON.parse(
      JSON.stringify(embedChildTarget(freshUnitPlan("workflows/parent-provenance.md"), childTarget)),
    );
    const target = plan.steps[0].root.frozenTarget;
    target.frozenPlan.title = `${target.frozenPlan.title}-edited`;
    target.frozenPlan.irVersion = 4;
    target.contentHash = "0".repeat(64);

    expect(() => decodeWorkflowPlan(plan)).not.toThrow();
  });

  test("a chain nested past the former composition depth bound (10 descendant levels) still decodes — depth is unbounded at decode time", () => {
    function buildNestedRootPlan(descendantLevels: number): unknown {
      let plan: unknown = freshUnitPlan("workflows/nest-leaf.md");
      for (let level = 0; level < descendantLevels; level++) {
        const base = freshUnitPlan(`workflows/nest-${level}.md`);
        const planHash = computePlanHash(plan);
        const target = buildChildTarget({
          ref: `workflows/nested-child-${level}`,
          planHash,
          frozenPlan: plan,
          via: "direct",
        });
        plan = embedChildTarget(base, target);
      }
      return plan;
    }

    const deep = buildNestedRootPlan(10);

    expect(() => decodeWorkflowPlan(deep)).not.toThrow();
  });

  test("an unknown frozenTarget.kind still fails with the existing closed-kind message shape (A-24, PRESERVE)", () => {
    const parentPlanJson = embedChildTarget(freshUnitPlan("workflows/parent-unknown-kind.md"), {
      kind: "not-a-real-target-kind",
    });
    expect(() => decodeWorkflowPlan(parentPlanJson)).toThrow(/unsupported frozen target kind/);
  });
});
