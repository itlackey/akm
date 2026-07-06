// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { compileWorkflowPlan, compileWorkflowProgram } from "../../src/workflows/ir/compile";
import { computePlanHash } from "../../src/workflows/ir/plan-hash";
import { WORKFLOW_IR_VERSION, type WorkflowPlanGraph } from "../../src/workflows/ir/schema";
import { parseWorkflow } from "../../src/workflows/parser";
import { parseWorkflowProgram } from "../../src/workflows/program/parser";
import type { WorkflowProgram } from "../../src/workflows/program/schema";
import type { WorkflowDocument, WorkflowError } from "../../src/workflows/schema";

/**
 * IR v2 compilers (redesign addendum, R1). Both frontends lower into the same
 * Workflow Plan Graph:
 *
 *   - classic linear markdown → one `agent` node per step, runner inherited,
 *     fail-fast (the stable CLI contract, golden-pinned below);
 *   - YAML workflow programs → full expression validation (closed grammar,
 *     earlier-step references, whole-value contexts, item scoping) with
 *     compile-time `defaults` merging so the frozen plan is self-contained.
 *
 * Plus `computePlanHash`: the sha256 of the plan's canonical JSON that
 * `workflow start` freezes onto the run row (migration 006).
 */

function parseMarkdown(markdown: string): WorkflowDocument {
  const result = parseWorkflow(markdown, { path: "workflows/test.md" });
  if (!result.ok) {
    throw new Error(`parse failed: ${result.errors.map((e) => e.message).join(" | ")}`);
  }
  return result.document;
}

function parseProgram(yamlText: string): WorkflowProgram {
  const result = parseWorkflowProgram(yamlText, { path: "workflows/test.yaml" });
  if (!result.ok) {
    throw new Error(`program parse failed: ${result.errors.map((e) => `${e.line}: ${e.message}`).join(" | ")}`);
  }
  return result.program;
}

function compileProgramOk(yamlText: string): WorkflowPlanGraph {
  const result = compileWorkflowProgram(parseProgram(yamlText));
  if (!result.ok) {
    throw new Error(`compile failed: ${result.errors.map((e) => `${e.line}: ${e.message}`).join(" | ")}`);
  }
  return result.plan;
}

function compileProgramErrors(yamlText: string): WorkflowError[] {
  const result = compileWorkflowProgram(parseProgram(yamlText));
  if (result.ok) throw new Error("expected compile errors, got a plan");
  return result.errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// Linear markdown golden (stable CLI contract)
// ─────────────────────────────────────────────────────────────────────────────

const LINEAR_MD = `# Workflow: Ship it

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

describe("compileWorkflowPlan — linear markdown (v2 golden)", () => {
  test("compiles to the golden linear plan: agent per step, runner inherit, fail-fast", () => {
    expect(compileWorkflowPlan(parseMarkdown(LINEAR_MD))).toEqual({
      irVersion: 2,
      title: "Ship it",
      steps: [
        {
          stepId: "build",
          title: "Build",
          sequenceIndex: 0,
          root: {
            kind: "agent",
            id: "build",
            instructions: "Build the artifact.",
            runner: "inherit",
            onError: "fail",
            source: { path: "workflows/test.md", start: 7, end: 8 },
          },
          gate: { kind: "gate", id: "build.gate", stepId: "build", criteria: ["artifact exists"] },
        },
        {
          stepId: "deploy",
          title: "Deploy",
          sequenceIndex: 1,
          root: {
            kind: "agent",
            id: "deploy",
            instructions: "Deploy the artifact.",
            runner: "inherit",
            onError: "fail",
            source: { path: "workflows/test.md", start: 16, end: 17 },
          },
          gate: { kind: "gate", id: "deploy.gate", stepId: "deploy", criteria: [] },
        },
      ],
    });
  });

  test("irVersion is 2", () => {
    expect(WORKFLOW_IR_VERSION).toBe(2);
    expect(compileWorkflowPlan(parseMarkdown(LINEAR_MD)).irVersion).toBe(2);
  });

  test("compilation is deterministic (same document → same plan)", () => {
    const doc = parseMarkdown(LINEAR_MD);
    expect(compileWorkflowPlan(doc)).toEqual(compileWorkflowPlan(doc));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// YAML program golden (defaults merging, route shape, typed artifacts)
// ─────────────────────────────────────────────────────────────────────────────

const PROGRAM_YAML = `version: 1
name: review-changes
description: Review changed files and route the outcome
params:
  changed_files: { type: array, items: { type: string } }
defaults:
  runner: sdk
  model: balanced
  timeout: 10m
  on_error: continue
steps:
  - id: discover
    title: Discover targets
    unit:
      instructions: |
        List the files that need review for \${{ params.changed_files }}.
      output:
        type: object
        properties: { files: { type: array } }
        required: [files]
    gate:
      criteria: [every target is listed]
  - id: review
    map:
      over: \${{ steps.discover.output.files }}
      concurrency: 8
      reducer: vote
      unit:
        runner: agent
        profile: reviewer
        model: deep
        timeout: 5m
        retry: { max: 1, on: [timeout, llm_rate_limit] }
        on_error: fail
        instructions: |
          Review \${{ item }} (#\${{ item_index }}) for bugs.
    output:
      type: object
      properties: { verdict: { type: string } }
    gate:
      criteria: [every changed file has a verdict]
      max_loops: 2
  - id: triage
    route:
      input: \${{ steps.review.output.verdict }}
      when: { pass: ship, fail: rework }
      default: rework
  - id: ship
    unit:
      instructions: Ship it.
  - id: rework
    unit:
      instructions: Rework it.
`;

describe("compileWorkflowProgram — YAML program golden", () => {
  test("compiles to the golden plan with defaults merged into every unit", () => {
    const plan = compileProgramOk(PROGRAM_YAML);
    expect(plan.irVersion).toBe(2);
    expect(plan.title).toBe("review-changes");
    expect(plan.params).toEqual(["changed_files"]);
    expect(plan.steps).toHaveLength(5);

    const [discover, review, triage, ship, rework] = plan.steps;

    // Step 1: unit step — run defaults (sdk/balanced/10m/continue) merged in.
    expect(discover).toEqual({
      stepId: "discover",
      title: "Discover targets",
      sequenceIndex: 0,
      root: {
        kind: "agent",
        id: "discover",
        instructions: "List the files that need review for ${{ params.changed_files }}.\n",
        runner: "sdk",
        model: "balanced",
        schema: { type: "object", properties: { files: { type: "array" } }, required: ["files"] },
        timeoutMs: 600_000,
        onError: "continue",
        source: expect.objectContaining({ path: "workflows/test.yaml" }),
      },
      gate: { kind: "gate", id: "discover.gate", stepId: "discover", criteria: ["every target is listed"] },
    });

    // Step 2: map step — per-unit declarations WIN over the defaults.
    expect(review).toEqual({
      stepId: "review",
      title: "review",
      sequenceIndex: 1,
      root: {
        kind: "map",
        id: "review.map",
        over: "${{ steps.discover.output.files }}",
        template: {
          kind: "agent",
          id: "review.unit",
          instructions: "Review ${{ item }} (#${{ item_index }}) for bugs.\n",
          runner: "agent",
          profile: "reviewer",
          model: "deep",
          timeoutMs: 300_000,
          retry: { max: 1, on: ["timeout", "llm_rate_limit"] },
          onError: "fail",
          source: expect.objectContaining({ path: "workflows/test.yaml" }),
        },
        concurrency: 8,
        reducer: "vote",
        source: expect.objectContaining({ path: "workflows/test.yaml" }),
      },
      outputSchema: { type: "object", properties: { verdict: { type: "string" } } },
      gate: {
        kind: "gate",
        id: "review.gate",
        stepId: "review",
        criteria: ["every changed file has a verdict"],
        maxLoops: 2,
      },
    });

    // Step 3: route step — no root, raw expression input, when as a record.
    expect(triage).toEqual({
      stepId: "triage",
      title: "triage",
      sequenceIndex: 2,
      route: {
        input: "${{ steps.review.output.verdict }}",
        when: { pass: "ship", fail: "rework" },
        defaultStepId: "rework",
      },
      gate: { kind: "gate", id: "triage.gate", stepId: "triage", criteria: [] },
    });
    expect(triage.root).toBeUndefined();

    // Steps 4/5: bare units still absorb the run defaults.
    for (const step of [ship, rework]) {
      if (step.root?.kind !== "agent") throw new Error("expected agent root");
      expect(step.root.runner).toBe("sdk");
      expect(step.root.model).toBe("balanced");
      expect(step.root.timeoutMs).toBe(600_000);
      expect(step.root.onError).toBe("continue");
    }
  });

  test("without a defaults block, units fall back to inherit + fail-fast", () => {
    const plan = compileProgramOk(`version: 1
name: t
steps:
  - id: a
    unit:
      instructions: Do the thing.
`);
    const root = plan.steps[0].root;
    if (root?.kind !== "agent") throw new Error("expected agent root");
    expect(root.runner).toBe("inherit");
    expect(root.onError).toBe("fail");
    expect(root.model).toBeUndefined();
    expect(root.timeoutMs).toBeUndefined();
  });

  test(`defaults "timeout: none" merges as an explicit null timeout`, () => {
    const plan = compileProgramOk(`version: 1
name: t
defaults:
  timeout: none
steps:
  - id: a
    unit:
      instructions: Do the thing.
`);
    const root = plan.steps[0].root;
    if (root?.kind !== "agent") throw new Error("expected agent root");
    expect(root.timeoutMs).toBeNull();
  });

  test("node ids are unique and stable across the plan", () => {
    const plan = compileProgramOk(PROGRAM_YAML);
    const ids: string[] = [];
    for (const step of plan.steps) {
      ids.push(step.gate.id);
      if (step.root?.kind === "agent") ids.push(step.root.id);
      if (step.root?.kind === "map") ids.push(step.root.id, step.root.template.id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Expression validation
// ─────────────────────────────────────────────────────────────────────────────

describe("compileWorkflowProgram — expression validation", () => {
  test("steps.<id> must reference an EARLIER step (forward reference rejected)", () => {
    const errors = compileProgramErrors(`version: 1
name: t
steps:
  - id: a
    unit:
      instructions: "Use \${{ steps.b.output.x }}"
  - id: b
    unit:
      instructions: hi
`);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("steps.b.output.x");
    expect(errors[0].message).toContain("does not come before this step");
  });

  test("steps.<id> naming its own step is rejected", () => {
    const errors = compileProgramErrors(`version: 1
name: t
steps:
  - id: a
    unit:
      instructions: "Use \${{ steps.a.output }}"
`);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("does not come before this step");
  });

  test("steps.<id> naming an unknown step is rejected with a distinct message", () => {
    const errors = compileProgramErrors(`version: 1
name: t
steps:
  - id: a
    unit:
      instructions: "Use \${{ steps.ghost.output }}"
`);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain(`"ghost" is not a step in this workflow`);
  });

  test("item / item_index are invalid outside a map unit", () => {
    const errors = compileProgramErrors(`version: 1
name: t
steps:
  - id: a
    unit:
      instructions: "Handle \${{ item }} at \${{ item_index }}"
`);
    expect(errors).toHaveLength(2);
    expect(errors[0].message).toContain("only valid inside a map unit");
    expect(errors[1].message).toContain("only valid inside a map unit");
  });

  test("item / item_index are valid inside a map unit's instructions", () => {
    const plan = compileProgramOk(`version: 1
name: t
params:
  files: { type: array }
steps:
  - id: m
    map:
      over: \${{ params.files }}
      unit:
        instructions: "Review \${{ item }} (#\${{ item_index }})."
`);
    expect(plan.steps[0].root?.kind).toBe("map");
  });

  test("map.over referencing an earlier step's output is valid", () => {
    const plan = compileProgramOk(`version: 1
name: t
steps:
  - id: discover
    unit:
      instructions: Find files.
  - id: m
    map:
      over: \${{ steps.discover.output.files }}
      unit:
        instructions: "Review \${{ item }}."
`);
    const root = plan.steps[1].root;
    if (root?.kind !== "map") throw new Error("expected map root");
    expect(root.over).toBe("${{ steps.discover.output.files }}");
  });

  test("errors accumulate across steps instead of stopping at the first", () => {
    const errors = compileProgramErrors(`version: 1
name: t
steps:
  - id: a
    unit:
      instructions: "\${{ steps.zzz.output }} and \${{ item }}"
  - id: b
    map:
      over: not-an-expression
      unit:
        instructions: "\${{ steps.later.output }}"
  - id: later
    unit:
      instructions: hi
`);
    expect(errors.length).toBe(4);
  });

  test("grammar violations are caught at compile even when the program bypasses the parser", () => {
    const src = { path: "workflows/t.yaml", start: 3, end: 5 };
    const program: WorkflowProgram = {
      version: 1,
      name: "t",
      steps: [
        { id: "a", unit: { instructions: "Bad ${{ nope() }}", source: src }, source: src },
        { id: "b", unit: { instructions: "Unterminated ${{ params.x", source: src }, source: src },
      ],
      source: { path: "workflows/t.yaml" },
    };
    const result = compileWorkflowProgram(program);
    if (result.ok) throw new Error("expected compile errors");
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].message).toContain("Unknown root");
    expect(result.errors[1].message).toContain("Unterminated");
    expect(result.errors.every((e) => e.line === 3)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Whole-value reference enforcement (map.over, route.input)
// ─────────────────────────────────────────────────────────────────────────────

describe("compileWorkflowProgram — whole-value references", () => {
  test("map.over with surrounding literal text is rejected", () => {
    const errors = compileProgramErrors(`version: 1
name: t
params:
  files: { type: array }
steps:
  - id: m
    map:
      over: "files: \${{ params.files }}"
      unit:
        instructions: "Do \${{ item }}."
`);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("map.over");
    expect(errors[0].message).toContain("single whole-value");
  });

  test("map.over as a bare name (no expression) is rejected — P1 ambient lookup is gone", () => {
    const errors = compileProgramErrors(`version: 1
name: t
steps:
  - id: m
    map:
      over: changed_files
      unit:
        instructions: "Do \${{ item }}."
`);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("single whole-value");
  });

  test("map.over must not use item (there is no item before the list resolves)", () => {
    const errors = compileProgramErrors(`version: 1
name: t
steps:
  - id: m
    map:
      over: \${{ item }}
      unit:
        instructions: "Do \${{ item }}."
`);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("only valid inside a map unit");
  });

  test("route.input with surrounding literal text is rejected", () => {
    const errors = compileProgramErrors(`version: 1
name: t
steps:
  - id: a
    unit:
      instructions: Classify.
  - id: r
    route:
      input: "verdict is \${{ steps.a.output.verdict }}"
      when: { pass: done }
  - id: done
    unit:
      instructions: Done.
`);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("route.input");
    expect(errors[0].message).toContain("single whole-value");
  });

  test("route.input referencing a later step is rejected", () => {
    const errors = compileProgramErrors(`version: 1
name: t
steps:
  - id: r
    route:
      input: \${{ steps.done.output.verdict }}
      when: { pass: done }
  - id: done
    unit:
      instructions: Done.
`);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("does not come before this step");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Plan hash
// ─────────────────────────────────────────────────────────────────────────────

describe("computePlanHash", () => {
  test("same program → same hash (deterministic across compiles)", () => {
    const a = compileProgramOk(PROGRAM_YAML);
    const b = compileProgramOk(PROGRAM_YAML);
    const hash = computePlanHash(a);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computePlanHash(b)).toBe(hash);
  });

  test("hash is key-order independent (canonical sorted-keys JSON)", () => {
    const plan = compileProgramOk(PROGRAM_YAML);
    const reordered = { steps: plan.steps, title: plan.title, params: plan.params, irVersion: plan.irVersion };
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(plan));
    expect(computePlanHash(reordered as WorkflowPlanGraph)).toBe(computePlanHash(plan));
  });

  test("a different program → a different hash", () => {
    const a = compileProgramOk(PROGRAM_YAML);
    const b = compileProgramOk(PROGRAM_YAML.replace("Ship it.", "Ship it now."));
    expect(computePlanHash(b)).not.toBe(computePlanHash(a));
  });

  test("both frontends hash through the same function (markdown plan hashes too)", () => {
    const plan = compileWorkflowPlan(parseMarkdown(LINEAR_MD));
    expect(computePlanHash(plan)).toBe(computePlanHash(compileWorkflowPlan(parseMarkdown(LINEAR_MD))));
  });
});
