// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { collectProgramWarnings, compileWorkflowPlan, compileWorkflowProgram } from "../../src/workflows/ir/compile";
import { computePlanHash } from "../../src/workflows/ir/plan-hash";
import { parseWorkflow } from "../../src/workflows/parser";
import { parseWorkflowProgram } from "../../src/workflows/program/parser";
import type { WorkflowProgram } from "../../src/workflows/program/schema";
import type { WorkflowError } from "../../src/workflows/schema";

/**
 * Non-fatal WARNINGS channel for YAML program validation (redesign addendum).
 *
 *   A. A unit/map step with no step-level `output:` schema carries its units'
 *      raw results as an untyped artifact — permitted, but the validator warns.
 *   B. A `${{ params.<name> }}` reference to a param the declared `params:`
 *      block omits — a likely typo. Only when a `params:` block is declared;
 *      never an error (the runtime resolves start-supplied undeclared params).
 *
 * Warnings are additive: compilation stays OK, and the plan + its hash are
 * unchanged by them.
 */

function parseProgram(yamlText: string): WorkflowProgram {
  const result = parseWorkflowProgram(yamlText, { path: "workflows/test.yaml" });
  if (!result.ok) {
    throw new Error(`program parse failed: ${result.errors.map((e) => `${e.line}: ${e.message}`).join(" | ")}`);
  }
  return result.program;
}

function warningsFor(yamlText: string): WorkflowError[] {
  const compiled = compileWorkflowProgram(parseProgram(yamlText));
  if (!compiled.ok) {
    throw new Error(`compile failed: ${compiled.errors.map((e) => `${e.line}: ${e.message}`).join(" | ")}`);
  }
  return compiled.warnings;
}

// ── Warning A: untyped step artifact ─────────────────────────────────────────

describe("warning A — a unit/map step with no output schema", () => {
  test("fires for a unit step lacking a step-level output, with step context", () => {
    const warnings = warningsFor(`version: 1
name: untyped-unit
steps:
  - id: analyze
    unit:
      instructions: Do the analysis.
`);
    expect(warnings).toHaveLength(1);
    const [w] = warnings;
    expect(w?.message).toContain('Step "analyze"');
    expect(w?.message).toMatch(/no `output:` schema/);
    expect(w?.message).toMatch(/untyped/);
    expect(typeof w?.line).toBe("number");
  });

  test("fires for a map step lacking a step-level output", () => {
    const warnings = warningsFor(`version: 1
name: untyped-map
params:
  items: { type: array }
steps:
  - id: fan
    map:
      over: \${{ params.items }}
      unit:
        instructions: Handle \${{ item }}.
`);
    expect(warnings.map((w) => w.message).join("\n")).toContain('Step "fan"');
    expect(warnings.some((w) => /no `output:` schema/.test(w.message))).toBe(true);
  });

  test("does NOT fire when the step declares a step-level output schema", () => {
    const warnings = warningsFor(`version: 1
name: typed-unit
steps:
  - id: analyze
    unit:
      instructions: Do the analysis.
    output:
      type: object
      properties: { ok: { type: boolean } }
`);
    expect(warnings).toEqual([]);
  });

  test("still fires when only a per-UNIT output is declared (step artifact stays untyped)", () => {
    const warnings = warningsFor(`version: 1
name: unit-only-output
steps:
  - id: analyze
    unit:
      instructions: Do the analysis.
      output:
        type: object
        properties: { ok: { type: boolean } }
`);
    expect(warnings.some((w) => /Step "analyze".*no `output:` schema/.test(w.message))).toBe(true);
  });

  test("does NOT fire for a route-only step (it dispatches no units, produces no artifact)", () => {
    const warnings = warningsFor(`version: 1
name: route-step
steps:
  - id: pick
    route:
      input: \${{ params.mode }}
      when: { a: done }
      default: done
  - id: done
    unit:
      instructions: Finish.
    output:
      type: object
`);
    // Only the "done" unit step is untyped; "pick" (route) contributes no A warning.
    expect(warnings.filter((w) => /no `output:` schema/.test(w.message)).length).toBe(0);
  });
});

// ── Warning B: undeclared param reference ────────────────────────────────────

describe("warning B — a reference to an undeclared param", () => {
  test("fires for an undeclared param in unit instructions when a params: block is declared", () => {
    const warnings = warningsFor(`version: 1
name: typo-param
params:
  changed_files: { type: array }
steps:
  - id: review
    unit:
      instructions: Review \${{ params.changed_file }}.
    output: { type: object }
`);
    expect(warnings).toHaveLength(1);
    const [w] = warnings;
    expect(w?.message).toContain('Step "review" instructions');
    expect(w?.message).toContain("params.changed_file");
    expect(w?.message).toMatch(/not declared in `params:`/);
    expect(w?.message).toContain("changed_files"); // names the declared params
  });

  test("does NOT fire for a param that IS declared", () => {
    const warnings = warningsFor(`version: 1
name: ok-param
params:
  changed_files: { type: array }
steps:
  - id: review
    unit:
      instructions: Review \${{ params.changed_files }}.
    output: { type: object }
`);
    expect(warnings).toEqual([]);
  });

  test("is SILENT when the program declares NO params block (start-supplied pattern)", () => {
    const warnings = warningsFor(`version: 1
name: no-params-block
steps:
  - id: review
    unit:
      instructions: Review \${{ params.anything }}.
    output: { type: object }
`);
    expect(warnings).toEqual([]);
  });

  test("fires for an undeclared param in a route.input whole-value field", () => {
    const warnings = warningsFor(`version: 1
name: route-typo
params:
  mode: { type: string }
steps:
  - id: pick
    route:
      input: \${{ params.moed }}
      when: { a: fin }
      default: fin
  - id: fin
    unit:
      instructions: Done.
    output: { type: object }
`);
    expect(warnings.some((w) => /route\.input.*params\.moed/.test(w.message))).toBe(true);
  });

  test("fires per reference — an undeclared param used twice warns twice", () => {
    const warnings = warningsFor(`version: 1
name: twice
params:
  a: { type: string }
steps:
  - id: s
    unit:
      instructions: \${{ params.b }} and again \${{ params.b }}.
    output: { type: object }
`);
    expect(warnings.filter((w) => w.message.includes("params.b")).length).toBe(2);
  });
});

// ── Clean programs + invariants ──────────────────────────────────────────────

describe("no warnings on a fully-typed, fully-declared program", () => {
  const CLEAN = `version: 1
name: clean
params:
  files: { type: array }
steps:
  - id: discover
    unit:
      instructions: List \${{ params.files }}.
    output:
      type: object
      properties: { items: { type: array } }
  - id: fan
    map:
      over: \${{ steps.discover.output.items }}
      unit:
        instructions: Handle \${{ item }} (#\${{ item_index }}).
    output:
      type: object
`;

  test("compiles OK with an empty warnings array", () => {
    const compiled = compileWorkflowProgram(parseProgram(CLEAN));
    expect(compiled.ok).toBe(true);
    if (compiled.ok) expect(compiled.warnings).toEqual([]);
  });
});

describe("warnings never change the plan or its hash", () => {
  const NOISY = `version: 1
name: noisy
params:
  files: { type: array }
steps:
  - id: s
    unit:
      instructions: \${{ params.typo }} over \${{ params.files }}.
`;

  test("the plan carries no warnings key and the hash is stable across compiles", () => {
    const program = parseProgram(NOISY);
    const a = compileWorkflowProgram(program);
    const b = compileWorkflowProgram(program);
    if (!a.ok || !b.ok) throw new Error("expected OK compiles");
    // Warnings are present but live on the RESULT, never on the frozen plan.
    expect(a.warnings.length).toBeGreaterThan(0);
    expect(a.plan).not.toHaveProperty("warnings");
    // Deterministic + hash-stable regardless of the advisory channel.
    expect(computePlanHash(a.plan)).toBe(computePlanHash(b.plan));
  });
});

describe("markdown workflows are warning-free", () => {
  test("collectProgramWarnings has no markdown analogue — the linear plan is unchanged", () => {
    const md = `# Workflow: Ship it

## Step: Build
Step ID: build

### Instructions
Build the artifact. A literal \${{ params.x }} is content here, not grammar.
`;
    const parsed = parseWorkflow(md, { path: "workflows/test.md" });
    if (!parsed.ok) throw new Error("markdown parse failed");
    // The markdown frontend returns a bare plan (no warnings channel at all).
    const plan = compileWorkflowPlan(parsed.document);
    expect(plan).not.toHaveProperty("warnings");
  });
});

// ── Direct collectProgramWarnings surface (used by `workflow start`) ──────────

describe("collectProgramWarnings is a pure, reusable function", () => {
  test("returns the same advisories the compiler attaches to its result", () => {
    const program = parseProgram(`version: 1
name: shared
params:
  a: { type: string }
steps:
  - id: s
    unit:
      instructions: \${{ params.z }}.
`);
    const compiled = compileWorkflowProgram(program);
    if (!compiled.ok) throw new Error("expected OK compile");
    expect(collectProgramWarnings(program)).toEqual(compiled.warnings);
  });
});
