// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { checkWorkflowPlan, compileWorkflowSource } from "../../src/workflows/compile";
import { computePlanHash } from "../../src/workflows/ir/plan-hash";
import type { WorkflowError, WorkflowPlan } from "../../src/workflows/plan";
import { freezeWorkflow } from "../_helpers/workflow";

/**
 * A workflow source compiles straight to the plan (`compileWorkflowSource`);
 * `checkWorkflowPlan` then validates cross-step references. Freeze-time
 * resolution is exercised by the freeze suites; this file pins the compiled
 * plan and the reference rules.
 */

function compileOk(markdown: string, title = "t", path = "workflows/test.md"): WorkflowPlan {
  const result = compileWorkflowSource(markdown, { path, title });
  if (!result.ok) {
    throw new Error(`source compile failed: ${result.errors.map((e) => `${e.line}: ${e.message}`).join(" | ")}`);
  }
  const checked = checkWorkflowPlan(result.plan);
  if (!checked.ok) {
    throw new Error(`compile failed: ${checked.errors.map((e) => `${e.line}: ${e.message}`).join(" | ")}`);
  }
  return result.plan;
}

function compileErrors(markdown: string, path = "workflows/test.md"): WorkflowError[] {
  const result = compileWorkflowSource(markdown, { path });
  if (!result.ok) throw new Error(`source compile failed: ${JSON.stringify(result.errors)}`);
  const checked = checkWorkflowPlan(result.plan);
  if (checked.ok) throw new Error("expected compile errors, got a plan");
  return checked.errors;
}

/** Errors from either stage: the grammar (reference syntax) or the cross-step check. */
function errorsFrom(markdown: string, path = "workflows/test.md"): WorkflowError[] {
  const source = compileWorkflowSource(markdown, { path });
  if (!source.ok) return source.errors.map(({ line, message }) => ({ line, message }));
  const checked = checkWorkflowPlan(source.plan);
  if (checked.ok) throw new Error("expected errors, got a plan");
  return checked.errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// Structural golden (stable CLI contract) — two plain unit steps, one gated
// ─────────────────────────────────────────────────────────────────────────────

const LINEAR_MD = `---
type: workflow
steps:
  - id: build
  - id: deploy
---

## build

Build the artifact.

### gate

- artifact exists

## deploy

Deploy the artifact.
`;

describe("compiled plan — structural golden", () => {
  test("compiles to the golden plan", () => {
    expect(compileOk(LINEAR_MD, "Ship it")).toEqual({
      irVersion: 6,
      title: "Ship it",
      steps: [
        {
          stepId: "build",
          // The unified format has no titles anywhere — a step is its id.
          title: "build",
          sequenceIndex: 0,
          spec: {
            uses: "akm/command",
            commandMode: "literal",
            with: { content: "Build the artifact." },
            source: { path: "workflows/test.md", start: 4, end: 4 },
          },
          gate: {
            kind: "gate",
            id: "build.gate",
            stepId: "build",
            criteria: ["- artifact exists"],
            maxLoops: 1,
            frozenJudge: null,
          },
        },
        {
          stepId: "deploy",
          title: "deploy",
          sequenceIndex: 1,
          spec: {
            uses: "akm/command",
            commandMode: "literal",
            with: { content: "Deploy the artifact." },
            source: { path: "workflows/test.md", start: 5, end: 5 },
          },
          gate: { kind: "gate", id: "deploy.gate", stepId: "deploy", criteria: [], maxLoops: 1, frozenJudge: null },
        },
      ],
    });
  });

  test("compilation is deterministic (same document → same plan)", () => {
    expect(compileOk(LINEAR_MD, "Ship it")).toEqual(compileOk(LINEAR_MD, "Ship it"));
  });

  test("an empty gate section compiles with no validation criteria", () => {
    const emptyGate = LINEAR_MD.replace("### gate\n\n- artifact exists", "### gate\n");
    expect(compileOk(emptyGate, "Ship it").steps[0]?.gate.criteria).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Full-vocabulary golden (defaults merging, map/vote, route shape, typed artifacts)
// ─────────────────────────────────────────────────────────────────────────────

const FULL_WF = `---
type: workflow
description: Review changed files and route the outcome
params:
  changed_files: { type: array, items: { type: string } }
defaults: { engine: default-agent, model: balanced, timeout: 10m, on_error: continue }
steps:
  - id: discover
    unit:
      output: { type: object, properties: { files: { type: array } }, required: [files] }
  - id: review
    map:
      over: steps.discover.output.files
      concurrency: 8
      reducer: vote
      unit: { engine: reviewer, model: deep, timeout: 5m, retry: { max: 1, on: [timeout, llm_rate_limit] }, on_error: fail }
    output: { type: object, properties: { verdict: { type: string } } }
    gate: { max_loops: 2 }
  - id: triage
    route:
      input: steps.review.output.verdict
      when: [{ match: pass, step: ship }, { match: fail, step: rework }]
      default: rework
  - id: ship
  - id: rework
---

## discover

List the files that need review.

### gate

every target is listed

## review

Review the assigned issue for bugs.

### gate

every changed file has a verdict

## triage

Route on the verdict.

## ship

Ship it.

## rework

Rework it.
`;

describe("compiled and frozen plan — full-vocabulary golden", () => {
  test("the canonical workflow-format example parses and compiles", () => {
    const specPath = path.resolve(import.meta.dir, "../../docs/architecture/specs/workflow-format-unification.md");
    const spec = fs.readFileSync(specPath, "utf8");
    const example = spec.match(/### 2\.2 The format\n\n````markdown\n([\s\S]*?)\n````/);
    if (!example?.[1]) throw new Error("canonical workflow example not found");
    expect(compileOk(example[1], "github-issues", specPath).steps).toHaveLength(6);
  });

  test("defaults, unit overrides, map, route, and schemas land where freeze reads them", () => {
    const plan = compileOk(FULL_WF, "review-changes", "workflows/test.md");
    expect(plan.title).toBe("review-changes");
    expect(plan.params).toEqual(["changed_files"]);
    expect(plan.defaults).toEqual({
      engine: "default-agent",
      model: "balanced",
      timeoutMs: 600_000,
      onError: "continue",
    });
    expect(plan.steps.map((step) => step.stepId)).toEqual(["discover", "review", "triage", "ship", "rework"]);
    expect(plan.steps[0]?.spec?.unit).toEqual({
      output: { type: "object", properties: { files: { type: "array" } }, required: ["files"] },
    });
    expect(plan.steps[1]).toMatchObject({
      spec: {
        map: { over: "steps.discover.output.files", concurrency: 8, reducer: "vote" },
        unit: {
          engine: "reviewer",
          model: "deep",
          timeoutMs: 300_000,
          retry: { max: 1, on: ["timeout", "llm_rate_limit"] },
          onError: "fail",
        },
      },
      outputSchema: { type: "object", properties: { verdict: { type: "string" } } },
      gate: { criteria: ["every changed file has a verdict"], maxLoops: 2 },
    });
    expect(plan.steps[2]).toMatchObject({
      route: { input: "steps.review.output.verdict", when: { pass: "ship", fail: "rework" }, defaultStepId: "rework" },
    });
  });

  test("freeze turns each step into its frozen node: unit ids, map template, defaults applied", () => {
    const executable = FULL_WF.replace("default-agent", "test-agent").replace("engine: reviewer", "engine: test-agent");
    const plan = freezeWorkflow(executable, "workflows/test.md");
    const [discover, review, triage, ship] = plan.steps;
    expect(discover?.root).toMatchObject({
      kind: "unit",
      id: "discover",
      instructions: "List the files that need review.",
      schema: { type: "object", properties: { files: { type: "array" } }, required: ["files"] },
      onError: "continue",
    });
    expect(review?.root).toMatchObject({
      kind: "map",
      id: "review.map",
      over: "steps.discover.output.files",
      concurrency: 8,
      reducer: "vote",
      template: {
        kind: "unit",
        id: "review.unit",
        retry: { max: 1, on: ["timeout", "llm_rate_limit"] },
        onError: "fail",
      },
    });
    expect(triage?.root).toBeUndefined();
    expect(ship?.root).toMatchObject({ kind: "unit", onError: "continue" });
    const ids = plan.steps.flatMap((step) => [
      step.gate.id,
      ...(step.root?.kind === "map" ? [step.root.id, step.root.template.id] : step.root ? [step.root.id] : []),
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("without a defaults block, units are fail-fast", () => {
    const plan = freezeWorkflow(`---
type: workflow
steps:
  - id: a
---

## a

Do the thing.
`);
    expect(plan.steps[0]?.root).toMatchObject({ kind: "unit", onError: "fail" });
  });

  test("a budget block is carried onto the plan (and absent otherwise)", () => {
    const withBudget = compileOk(`---
type: workflow
budget: { max_tokens: 5000, max_units: 7 }
steps:
  - id: a
---

## a

Do the thing.
`);
    expect(withBudget.budget).toEqual({ maxTokens: 5000, maxUnits: 7 });
    const withoutBudget = compileOk(`---
type: workflow
steps:
  - id: a
---

## a

Do the thing.
`);
    expect(withoutBudget.budget).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reference validation (map.over / route.input / inputs[])
// ─────────────────────────────────────────────────────────────────────────────
//
// SEMANTIC CHANGE (workflow-format-unification, spec §2.3): the closed
// reference grammar now lives in exactly three frontmatter positions
// (`map.over`, `route.input`, `inputs[]`) — prose is NEVER scanned for it.
// The pre-unification tests that exercised references INSIDE instructions
// (`${{ steps.b.output.x }}` in prose) are ported onto `inputs:` — the new
// declared-input surface that replaced prose splicing as how a step names an
// upstream artifact — since that is the closest surviving equivalent
// (a step-level, non-map/route reference to a prior step's output). Tests
// about `item` / `item_index` in prose are DELETED outright below; there is
// no equivalent — those roots no longer exist in the language at all (they
// are not merely restricted to map units, per spec §2.3).

describe("checkWorkflowPlan — reference validation", () => {
  test("steps.<id> must reference an EARLIER step (forward reference rejected)", () => {
    const errors = compileErrors(`---
type: workflow
steps:
  - id: a
    inputs: [steps.b.output.x]
  - id: b
---

## a

Use it.

## b

hi
`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("steps.b.output.x");
    expect(errors[0]!.message).toContain("does not come before this step");
  });

  test("steps.<id> naming its own step is rejected", () => {
    const errors = compileErrors(`---
type: workflow
steps:
  - id: a
    inputs: [steps.a.output]
---

## a

Use it.
`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("does not come before this step");
  });

  test("steps.<id> naming an unknown step is rejected with a distinct message", () => {
    const errors = compileErrors(`---
type: workflow
steps:
  - id: a
    inputs: [steps.ghost.output]
---

## a

Use it.
`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain(`"ghost" is not a step in this workflow`);
  });

  // DELETED (workflow-format-unification, spec §2.3): the pre-unification
  // "params.<name> outside the declared block compiles — presence is a
  // run-scope concern" case was tested against an INSTRUCTIONS reference.
  // Prose is never scanned for references any more, so that specific surface
  // is gone; the identical run-scope-concern property for the two whole-value
  // positions that still carry the grammar (`map.over`/`route.input`) is
  // covered by the next test.

  test("undeclared params.<name> in map.over and route.input compiles too (run-scope concern)", () => {
    const plan = compileOk(`---
type: workflow
params:
  files: { type: array }
steps:
  - id: route
    route:
      input: params.mode
      when: [{ match: a, step: fan }]
  - id: fan
    map:
      over: params.filez
---

## route

r

## fan

f
`);
    expect(plan.params).toEqual(["files"]);
  });

  test("a declared param reference compiles cleanly", () => {
    const plan = compileOk(`---
type: workflow
params:
  files: { type: array }
steps:
  - id: fan
    map:
      over: params.files
---

## fan

Review the assigned item.
`);
    expect(plan.params).toEqual(["files"]);
  });

  test("with NO params block, any params.<name> reference is accepted (run-scope concern)", () => {
    // Documented: a workflow that declares no params block keeps the prior
    // behavior — presence is validated at run/start, not compile.
    const plan = compileOk(`---
type: workflow
steps:
  - id: a
    route:
      input: params.anything
      when: [{ match: x, step: b }]
  - id: b
---

## a

r

## b

d
`);
    expect(plan.params).toBeUndefined();
  });

  // DELETED (workflow-format-unification, spec §2.3): `item` / `item_index`
  // are deleted from the reference grammar entirely — not merely restricted
  // to map units. There is no "valid inside a map unit, invalid outside" case
  // any more: neither position exists anywhere in the language, and prose is
  // never scanned for it regardless of step kind. A map unit's item/index
  // reach it as attached context (`buildUnitPrompt` in
  // `src/workflows/exec/step-work.ts`), never as a resolved reference — see
  // `native-executor.test.ts` and `step-work.test.ts` for the new contract.

  test("map.over referencing an earlier step's output is valid", () => {
    const plan = compileOk(`---
type: workflow
steps:
  - id: discover
  - id: m
    map:
      over: steps.discover.output.files
---

## discover

Find files.

## m

Review the assigned item.
`);
    expect(plan.steps[1]?.spec?.map?.over).toBe("steps.discover.output.files");
  });

  test("errors accumulate across steps instead of stopping at the first", () => {
    // Ported onto two independently-invalid whole-value references (an
    // unknown-step `inputs:` and a forward-referencing `map.over`) since
    // instructions can no longer carry a reference at all — see the module
    // doc above.
    const errors = compileErrors(`---
type: workflow
steps:
  - id: a
    inputs: [steps.zzz.output]
  - id: b
    map:
      over: steps.later.output
  - id: later
    inputs: [steps.b.output]
---

## a

x

## b

y

## later

z
`);
    expect(errors.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Whole-value reference enforcement (map.over, route.input)
// ─────────────────────────────────────────────────────────────────────────────
//
// SEMANTIC CHANGE: with the `${{ … }}` delimiter gone, "surrounded by literal
// text" is expressed as "the string isn't a bare reference at all" — the
// parser's closed two-root grammar (`program/expressions.ts`) rejects it as
// an unknown root rather than the old "single whole-value expression"
// wording. The underlying property (only a single whole-value reference is
// legal here, never prose-with-an-expression-inside) is unchanged.

describe("checkWorkflowPlan — whole-value references", () => {
  test("map.over with surrounding literal text is rejected", () => {
    const errors = errorsFrom(`---
type: workflow
params:
  files: { type: array }
steps:
  - id: m
    map:
      over: "the params.files list"
---

## m

Do the assigned item.
`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("over");
    expect(errors[0]!.message).toContain("Unknown root");
  });

  test("map.over as a bare name (no reference grammar) is rejected — P1 ambient lookup is gone", () => {
    const errors = errorsFrom(`---
type: workflow
steps:
  - id: m
    map:
      over: changed_files
---

## m

Do the assigned item.
`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("Unknown root");
  });

  test("route.input with surrounding literal text is rejected", () => {
    const errors = errorsFrom(`---
type: workflow
steps:
  - id: a
  - id: r
    route:
      input: "verdict is steps.a.output.verdict"
      when: [{ match: pass, step: done }]
  - id: done
---

## a

Classify.

## r

Route.

## done

Done.
`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("route.input");
    expect(errors[0]!.message).toContain("Unknown root");
  });

  test("route.input referencing a later step is rejected", () => {
    const errors = compileErrors(`---
type: workflow
steps:
  - id: r
    route:
      input: steps.done.output.verdict
      when: [{ match: pass, step: done }]
  - id: done
---

## r

Route.

## done

Done.
`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("does not come before this step");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Plan hash
// ─────────────────────────────────────────────────────────────────────────────

// DELETED (workflow-format-unification): the pre-unification "both frontends
// hash through the same function (markdown plan hashes too)" test proved two
// DIFFERENT frontends (classic linear markdown + YAML program) shared one
// hashing path. There is only one frontend now, so that cross-frontend proof
// no longer has a second frontend to compare against; the determinism +
// key-order-independence properties it also covered are pinned by the two
// tests above and by `freezeWorkflow`'s exclusive use in every other suite.
describe("computePlanHash", () => {
  const executableWf = FULL_WF.replace("default-agent", "test-agent").replace("engine: reviewer", "engine: test-agent");

  test("same workflow → same hash (deterministic across compiles)", () => {
    const a = freezeWorkflow(executableWf, "workflows/test.md");
    const b = freezeWorkflow(executableWf, "workflows/test.md");
    const hash = computePlanHash(a);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computePlanHash(b)).toBe(hash);
  });

  test("hash is key-order independent (canonical sorted-keys JSON)", () => {
    const plan = freezeWorkflow(executableWf, "workflows/test.md");
    const reordered = Object.fromEntries(Object.entries(plan).reverse()) as WorkflowPlan;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(plan));
    expect(computePlanHash(reordered)).toBe(computePlanHash(plan));
  });

  test("a different workflow → a different hash", () => {
    const a = freezeWorkflow(executableWf, "workflows/test.md");
    const b = freezeWorkflow(executableWf.replace("Ship it.", "Ship it now."), "workflows/test.md");
    expect(computePlanHash(b)).not.toBe(computePlanHash(a));
  });
});
