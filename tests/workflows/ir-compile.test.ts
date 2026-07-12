// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { compileWorkflowPlan, compileWorkflowProgram, type WorkflowPlanDraft } from "../../src/workflows/ir/compile";
import { computePlanHash } from "../../src/workflows/ir/plan-hash";
import { WORKFLOW_IR_VERSION, type WorkflowPlanGraph } from "../../src/workflows/ir/schema";
import { parseWorkflow } from "../../src/workflows/parser";
import { parseWorkflowProgram } from "../../src/workflows/program/parser";
import type { WorkflowProgram } from "../../src/workflows/program/schema";
import type { WorkflowDocument, WorkflowError } from "../../src/workflows/schema";
import { freezeMarkdownWorkflow, freezeWorkflowProgram } from "../_helpers/workflow";

/**
 * Pre-freeze compilers. Both frontends lower into the same structural draft:
 *
 *   - classic linear markdown -> one fail-fast unit per step;
 *   - YAML workflow programs → full expression validation (closed grammar,
 *     earlier-step references, whole-value contexts, item scoping) with
 *     source selectors retained for the single resolve/freeze boundary.
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

function compileProgramOk(yamlText: string): WorkflowPlanDraft {
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

describe("compileWorkflowPlan — linear markdown pre-freeze golden", () => {
  test("compiles to the golden linear structural plan", () => {
    expect(compileWorkflowPlan(parseMarkdown(LINEAR_MD))).toEqual({
      title: "Ship it",
      steps: [
        {
          stepId: "build",
          title: "Build",
          sequenceIndex: 0,
          root: {
            kind: "unit",
            id: "build",
            instructions: "Build the artifact.",
            templating: "verbatim",
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
            kind: "unit",
            id: "deploy",
            instructions: "Deploy the artifact.",
            templating: "verbatim",
            onError: "fail",
            source: { path: "workflows/test.md", start: 16, end: 17 },
          },
          gate: { kind: "gate", id: "deploy.gate", stepId: "deploy", criteria: [] },
        },
      ],
    });
  });

  test("keeps executable versioning out of the unresolved draft", () => {
    expect(WORKFLOW_IR_VERSION).toBe(3);
    expect(compileWorkflowPlan(parseMarkdown(LINEAR_MD))).not.toHaveProperty("irVersion");
  });

  test("compilation is deterministic (same document → same plan)", () => {
    const doc = parseMarkdown(LINEAR_MD);
    expect(compileWorkflowPlan(doc)).toEqual(compileWorkflowPlan(doc));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// YAML program golden (defaults merging, route shape, typed artifacts)
// ─────────────────────────────────────────────────────────────────────────────

const PROGRAM_YAML = `version: 2
name: review-changes
description: Review changed files and route the outcome
params:
  changed_files: { type: array, items: { type: string } }
defaults:
  engine: default-agent
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
        engine: reviewer
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
  test("compiles the structural plan without executable engine fields", () => {
    const plan = compileProgramOk(PROGRAM_YAML);
    expect(plan.title).toBe("review-changes");
    expect(plan.params).toEqual(["changed_files"]);
    expect(plan.steps).toHaveLength(5);

    const [discover, review, triage, ship, rework] = plan.steps;

    // Step 1: selectors remain on the parsed source until engine freezing.
    expect(discover).toEqual({
      stepId: "discover",
      title: "Discover targets",
      sequenceIndex: 0,
      root: {
        kind: "unit",
        id: "discover",
        instructions: "List the files that need review for ${{ params.changed_files }}.\n",
        templating: "expressions",
        schema: { type: "object", properties: { files: { type: "array" } }, required: ["files"] },
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
          kind: "unit",
          id: "review.unit",
          instructions: "Review ${{ item }} (#${{ item_index }}) for bugs.\n",
          templating: "expressions",
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

    // Steps 4/5: policy defaults are structural; execution settings freeze later.
    for (const step of [ship, rework]) {
      if (step.root?.kind !== "unit") throw new Error("expected unit root");
      expect(step.root.onError).toBe("continue");
    }
  });

  test("without a defaults block, units are fail-fast", () => {
    const plan = compileProgramOk(`version: 2
name: t
steps:
  - id: a
    unit:
      instructions: Do the thing.
`);
    const root = plan.steps[0].root;
    if (root?.kind !== "unit") throw new Error("expected unit root");
    expect(root.onError).toBe("fail");
    expect(root).not.toHaveProperty("invocation");
  });

  test(`defaults "timeout: none" remains source configuration until freeze`, () => {
    const plan = compileProgramOk(`version: 2
name: t
defaults:
  timeout: none
steps:
  - id: a
    unit:
      instructions: Do the thing.
`);
    const root = plan.steps[0].root;
    if (root?.kind !== "unit") throw new Error("expected unit root");
    expect(root).not.toHaveProperty("timeoutMs");
  });

  test("node ids are unique and stable across the plan", () => {
    const plan = compileProgramOk(PROGRAM_YAML);
    const ids: string[] = [];
    for (const step of plan.steps) {
      ids.push(step.gate.id);
      if (step.root?.kind === "unit") ids.push(step.root.id);
      if (step.root?.kind === "map") ids.push(step.root.id, step.root.template.id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a budget block is carried onto the plan (and absent otherwise)", () => {
    const withBudget = compileProgramOk(`version: 2
name: t
budget:
  max_tokens: 5000
  max_units: 7
steps:
  - id: a
    unit:
      instructions: Do the thing.
`);
    expect(withBudget.budget).toEqual({ maxTokens: 5000, maxUnits: 7 });
    // The budget is retained for the freeze boundary.
    const withoutBudget = compileProgramOk(`version: 2
name: t
steps:
  - id: a
    unit:
      instructions: Do the thing.
`);
    expect(withoutBudget.budget).toBeUndefined();
    expect(withBudget).not.toEqual(withoutBudget);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Expression validation
// ─────────────────────────────────────────────────────────────────────────────

describe("compileWorkflowProgram — expression validation", () => {
  test("steps.<id> must reference an EARLIER step (forward reference rejected)", () => {
    const errors = compileProgramErrors(`version: 2
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
    const errors = compileProgramErrors(`version: 2
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
    const errors = compileProgramErrors(`version: 2
name: t
steps:
  - id: a
    unit:
      instructions: "Use \${{ steps.ghost.output }}"
`);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain(`"ghost" is not a step in this workflow`);
  });

  // Codex round-3 (later finding): param presence is a RUN-SCOPE concern, not a
  // compile-time one. A declared `params:` block is NOT a closed set — the
  // runtime resolves any param SUPPLIED at start and `validateWorkflowParams`
  // permits undeclared params, so a workflow that declares a SUBSET of its
  // params and references start-supplied extras must COMPILE (it runs fine).
  // Compiling would otherwise disagree with the runtime contract. A genuine typo
  // surfaces at run time ("is not defined in the run's params"), never here.
  test("params.<name> outside the declared block compiles — presence is a run-scope concern (instructions)", () => {
    const plan = compileProgramOk(`version: 2
name: t
params:
  changed_files: { type: array }
steps:
  - id: a
    unit:
      instructions: "Review \${{ params.changed_file }} in \${{ params.mode }} mode"
`);
    // Only the declared name is frozen onto the plan; the references themselves
    // are accepted regardless (they resolve against start-supplied params).
    expect(plan.params).toEqual(["changed_files"]);
  });

  test("undeclared params.<name> in map.over and route.input compiles too (run-scope)", () => {
    const plan = compileProgramOk(`version: 2
name: t
params:
  files: { type: array }
steps:
  - id: route
    route:
      input: \${{ params.mode }}
      when: { a: fan }
  - id: fan
    map:
      over: \${{ params.filez }}
      unit:
        instructions: Review \${{ item }}.
`);
    expect(plan.params).toEqual(["files"]);
  });

  test("a declared param reference compiles cleanly", () => {
    const plan = compileProgramOk(`version: 2
name: t
params:
  files: { type: array }
steps:
  - id: fan
    map:
      over: \${{ params.files }}
      unit:
        instructions: Review \${{ item }}.
`);
    expect(plan.params).toEqual(["files"]);
  });

  test("with NO params block, any params.<name> reference is accepted (run-scope concern)", () => {
    // Documented: a program that declares no params block keeps the prior
    // behavior — presence is validated at run/start, not compile.
    const plan = compileProgramOk(`version: 2
name: t
steps:
  - id: a
    unit:
      instructions: "Use \${{ params.anything }}"
`);
    expect(plan.params).toBeUndefined();
  });

  test("item / item_index are invalid outside a map unit", () => {
    const errors = compileProgramErrors(`version: 2
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
    const plan = compileProgramOk(`version: 2
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
    const plan = compileProgramOk(`version: 2
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
    const errors = compileProgramErrors(`version: 2
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
      version: 2,
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
    const errors = compileProgramErrors(`version: 2
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
    const errors = compileProgramErrors(`version: 2
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
    const errors = compileProgramErrors(`version: 2
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
    const errors = compileProgramErrors(`version: 2
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
    const errors = compileProgramErrors(`version: 2
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
  const executableProgram = PROGRAM_YAML.replace("default-agent", "test-agent").replace(
    "engine: reviewer",
    "engine: test-agent",
  );

  test("same program → same hash (deterministic across compiles)", () => {
    const a = freezeWorkflowProgram(executableProgram);
    const b = freezeWorkflowProgram(executableProgram);
    const hash = computePlanHash(a);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computePlanHash(b)).toBe(hash);
  });

  test("hash is key-order independent (canonical sorted-keys JSON)", () => {
    const plan = freezeWorkflowProgram(executableProgram);
    const reordered = Object.fromEntries(Object.entries(plan).reverse()) as WorkflowPlanGraph;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(plan));
    expect(computePlanHash(reordered)).toBe(computePlanHash(plan));
  });

  test("a different program → a different hash", () => {
    const a = freezeWorkflowProgram(executableProgram);
    const b = freezeWorkflowProgram(executableProgram.replace("Ship it.", "Ship it now."));
    expect(computePlanHash(b)).not.toBe(computePlanHash(a));
  });

  test("both frontends hash through the same function (markdown plan hashes too)", () => {
    const plan = freezeMarkdownWorkflow(LINEAR_MD);
    expect(computePlanHash(plan)).toBe(computePlanHash(freezeMarkdownWorkflow(LINEAR_MD)));
  });
});
