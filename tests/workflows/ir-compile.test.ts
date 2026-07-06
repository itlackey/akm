// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { compileWorkflowPlan } from "../../src/workflows/ir/compile";
import { WORKFLOW_IR_VERSION } from "../../src/workflows/ir/schema";
import { parseWorkflow } from "../../src/workflows/parser";
import type { WorkflowDocument } from "../../src/workflows/schema";

/**
 * P0 — Workflow Plan Graph compiler. An existing linear workflow compiles to
 * a chain of `agent` nodes, one per step, each followed by its `gate` —
 * identical behavior to today's step loop. Orchestrated steps compile their
 * declared fan-out into a `map` node.
 */

function parse(markdown: string): WorkflowDocument {
  const result = parseWorkflow(markdown, { path: "workflows/test.md" });
  if (!result.ok) {
    throw new Error(`parse failed: ${result.errors.map((e) => e.message).join(" | ")}`);
  }
  return result.document;
}

const LINEAR = `# Workflow: Ship it

## Step: Build
Step ID: build

### Instructions
Build the artifact.

### Completion Criteria
- artifact exists

## Step: Deploy
Step ID: deploy

### Instructions
Deploy the artifact.
`;

const ORCHESTRATED = `# Workflow: Review

## Step: Review changed files
Step ID: review

### Runner
sdk

### Model
deep

### Timeout
5m

### Fan-out
over: changed_files
concurrency: 8
reducer: vote

### Instructions
Review {{item}}.

### Schema
\`\`\`json
{ "type": "object" }
\`\`\`

### Completion Criteria
- every file reviewed
`;

describe("compileWorkflowPlan — linear spine (P0, behavior-preserving)", () => {
  test("one agent node + gate per step, in sequence order", () => {
    const plan = compileWorkflowPlan(parse(LINEAR));
    expect(plan.irVersion).toBe(WORKFLOW_IR_VERSION);
    expect(plan.title).toBe("Ship it");
    expect(plan.steps).toHaveLength(2);

    const [build, deploy] = plan.steps;
    expect(build.stepId).toBe("build");
    expect(build.root.kind).toBe("agent");
    if (build.root.kind !== "agent") throw new Error("unreachable");
    expect(build.root.instructions).toBe("Build the artifact.");
    expect(build.root.runner).toBe("inherit");
    expect(build.gate.kind).toBe("gate");
    expect(build.gate.stepId).toBe("build");
    expect(build.gate.criteria).toEqual(["artifact exists"]);

    expect(deploy.sequenceIndex).toBe(1);
    expect(deploy.gate.criteria).toEqual([]);
  });

  test("compilation is deterministic (same input → same plan)", () => {
    const doc = parse(LINEAR);
    expect(compileWorkflowPlan(doc)).toEqual(compileWorkflowPlan(doc));
  });
});

describe("compileWorkflowPlan — orchestrated steps (P1)", () => {
  test("fan-out compiles to a map node wrapping the agent template", () => {
    const plan = compileWorkflowPlan(parse(ORCHESTRATED));
    const step = plan.steps[0];
    expect(step.root.kind).toBe("map");
    if (step.root.kind !== "map") throw new Error("unreachable");
    expect(step.root.over).toBe("changed_files");
    expect(step.root.concurrency).toBe(8);
    expect(step.root.reducer).toBe("vote");

    const template = step.root.template;
    expect(template.kind).toBe("agent");
    expect(template.runner).toBe("sdk");
    expect(template.model).toBe("deep");
    expect(template.timeoutMs).toBe(300_000);
    expect(template.schema).toEqual({ type: "object" });
    expect(template.instructions).toContain("{{item}}");
  });

  test("node ids are unique and stable across the plan", () => {
    const plan = compileWorkflowPlan(parse(ORCHESTRATED));
    const step = plan.steps[0];
    if (step.root.kind !== "map") throw new Error("unreachable");
    const ids = [step.root.id, step.root.template.id, step.gate.id];
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("dependsOn edges survive compilation", () => {
    const doc = parse(`# Workflow: D

## Step: A
Step ID: a

### Instructions
x

## Step: B
Step ID: b

### Depends On
- a

### Instructions
y
`);
    const plan = compileWorkflowPlan(doc);
    expect(plan.steps[1].dependsOn).toEqual(["a"]);
  });
});
