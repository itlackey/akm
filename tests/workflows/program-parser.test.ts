// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { looksLikeWorkflowProgram, parseWorkflowProgram } from "../../src/workflows/program/parser";
import {
  PROGRAM_ISOLATION_KINDS,
  PROGRAM_ON_ERROR,
  PROGRAM_PARAM_NAME_PATTERN,
  PROGRAM_REDUCERS,
  PROGRAM_RETRY_REASONS,
  PROGRAM_STEP_ID_PATTERN,
  type WorkflowProgram,
} from "../../src/workflows/program/schema";

/**
 * YAML workflow program parser (redesign addendum, R1). Structural rules
 * mirror schemas/akm-workflow.json; semantic rules (duplicate ids,
 * exactly-one-of unit|map|route, route target ordering, timeout format,
 * retry.on vocabulary, params shape) live in the parser.
 */

const SOURCE = { path: "workflows/test.yaml" };

function parseOk(yamlText: string): WorkflowProgram {
  const result = parseWorkflowProgram(yamlText, SOURCE);
  if (!result.ok) {
    throw new Error(
      `expected parse to succeed, got: ${result.errors.map((e) => `${e.line}: ${e.message}`).join(" | ")}`,
    );
  }
  return result.program;
}

function parseErrors(yamlText: string): string[] {
  const result = parseWorkflowProgram(yamlText, SOURCE);
  if (result.ok) throw new Error("expected parse to fail");
  return result.errors.map((e) => e.message);
}

/** Minimal valid program with the given steps block. */
function withSteps(stepsYaml: string): string {
  return `version: 2\nname: t\nsteps:\n${stepsYaml}`;
}

const LINEAR = `version: 2
name: linear
steps:
  - id: first
    unit:
      instructions: Do the first thing.
  - id: second
    unit:
      instructions: Do the second thing.
`;

// The addendum's v1 sketch, completed with the three route-target steps the
// sketch references (route targets must exist and come after the router).
const ADDENDUM_EXAMPLE = `version: 2
name: review-changes
description: Review changed files and route the outcome
params:
  changed_files: { type: array, items: { type: string } }
defaults:
  engine: default-agent
  model: balanced
  timeout: 10m
  on_error: fail

steps:
  - id: discover
    title: Discover targets
    unit:
      instructions: |
        List the files that need review for \${{ params.changed_files }}.
      output:
        type: object
        properties: { files: { type: array, items: { type: string } } }
        required: [files]
    gate:
      criteria: [every target is listed]

  - id: review
    title: Review files
    map:
      over: \${{ steps.discover.output.files }}
      concurrency: 8
      reducer: collect
      unit:
        engine: reviewer
        model: deep
        timeout: 5m
        retry: { max: 1, on: [timeout, llm_rate_limit] }
        on_error: continue
        instructions: |
          Review \${{ item }} for correctness bugs.
        output: { type: object, properties: { file: { type: string }, verdict: { type: string } }, required: [file, verdict] }
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
      default: manual-triage

  - id: ship
    unit:
      instructions: Ship it.
  - id: rework
    unit:
      instructions: Rework the findings.
  - id: manual-triage
    unit:
      instructions: Triage manually.
`;

describe("parseWorkflowProgram — happy paths", () => {
  test("the addendum's full example parses", () => {
    const program = parseOk(ADDENDUM_EXAMPLE);

    expect(program.version).toBe(2);
    expect(program.name).toBe("review-changes");
    expect(program.description).toBe("Review changed files and route the outcome");
    expect(program.source).toEqual({ path: "workflows/test.yaml" });
    expect(Object.keys(program.params ?? {})).toEqual(["changed_files"]);
    expect(program.params?.changed_files).toEqual({ type: "array", items: { type: "string" } });
    expect(program.defaults).toEqual({
      engine: "default-agent",
      model: "balanced",
      timeoutMs: 600_000,
      onError: "fail",
    });

    expect(program.steps.map((s) => s.id)).toEqual(["discover", "review", "triage", "ship", "rework", "manual-triage"]);

    const discover = program.steps[0];
    expect(discover.title).toBe("Discover targets");
    expect(discover.unit?.instructions).toContain("${{ params.changed_files }}");
    expect(discover.unit?.output?.required).toEqual(["files"]);
    expect(discover.gate).toEqual({ criteria: ["every target is listed"] });
    expect(discover.map).toBeUndefined();
    expect(discover.route).toBeUndefined();

    const review = program.steps[1];
    expect(review.map?.over).toBe("${{ steps.discover.output.files }}");
    expect(review.map?.concurrency).toBe(8);
    expect(review.map?.reducer).toBe("collect");
    expect(review.map?.unit).toMatchObject({
      engine: "reviewer",
      model: "deep",
      timeoutMs: 300_000,
      retry: { max: 1, on: ["timeout", "llm_rate_limit"] },
      onError: "continue",
    });
    expect(review.output).toMatchObject({ type: "object" });
    expect(review.gate).toEqual({ criteria: ["every changed file has a verdict"], maxLoops: 2 });

    const triage = program.steps[2];
    expect(triage.route?.input).toBe("${{ steps.review.output.verdict }}");
    expect(triage.route?.branches).toEqual([
      { match: "pass", stepId: "ship" },
      { match: "fail", stepId: "rework" },
    ]);
    expect(triage.route?.defaultStepId).toBe("manual-triage");
  });

  test("a linear-only YAML (unit + instructions) parses", () => {
    const program = parseOk(LINEAR);
    expect(program.steps).toHaveLength(2);
    expect(program.steps[0].unit?.instructions.trim()).toBe("Do the first thing.");
    expect(program.steps[0].gate).toBeUndefined();
    expect(program.steps[0].map).toBeUndefined();
    expect(program.defaults).toBeUndefined();
  });

  test("timeout formats: ms/s/m/none/bare integer", () => {
    const program = parseOk(
      withSteps(
        [
          "  - id: a",
          "    unit: { instructions: x, timeout: 500ms }",
          "  - id: b",
          "    unit: { instructions: x, timeout: 5s }",
          "  - id: c",
          "    unit: { instructions: x, timeout: 10m }",
          "  - id: d",
          "    unit: { instructions: x, timeout: none }",
          "  - id: e",
          "    unit: { instructions: x, timeout: 300 }",
        ].join("\n"),
      ),
    );
    expect(program.steps.map((s) => s.unit?.timeoutMs)).toEqual([500, 5_000, 600_000, null, 300]);
  });

  test("timeout formats: unit lower bounds, uppercase units, and surrounding whitespace are accepted", () => {
    // The shipped parser lower-cases and trims before matching (`raw.trim().toLowerCase()`),
    // so "5S"/"10M" are the same as "5s"/"10m" and a padded '" 5s "' is 5000.
    const program = parseOk(
      withSteps(
        [
          "  - id: a",
          "    unit: { instructions: x, timeout: 1ms }",
          "  - id: b",
          "    unit: { instructions: x, timeout: 1s }",
          "  - id: c",
          "    unit: { instructions: x, timeout: 1m }",
          "  - id: d",
          "    unit: { instructions: x, timeout: 5S }",
          "  - id: e",
          "    unit: { instructions: x, timeout: 10M }",
          "  - id: f",
          '    unit: { instructions: x, timeout: " 5s " }',
          "  - id: g",
          "    unit: { instructions: x, timeout: NONE }",
        ].join("\n"),
      ),
    );
    expect(program.steps.map((s) => s.unit?.timeoutMs)).toEqual([1, 1_000, 60_000, 5_000, 600_000, 5_000, null]);
  });

  test("step source refs carry best-effort line anchors", () => {
    const program = parseOk(LINEAR);
    expect(program.steps[0].source.path).toBe("workflows/test.yaml");
    expect(program.steps[0].source.start).toBe(4);
    expect(program.steps[1].source.start).toBe(7);
  });
});

describe("parseWorkflowProgram — top-level validation", () => {
  test("non-mapping document is rejected without crashing", () => {
    expect(parseErrors("just a string")).toEqual([
      `A workflow program must be a YAML mapping with "version: 2", "name", and "steps".`,
    ]);
    expect(parseErrors("- a\n- b")).toHaveLength(1);
  });

  test("version must be the number 2 and v1 is retired", () => {
    expect(parseErrors(`name: t\nsteps:\n  - id: a\n    unit: { instructions: x }`).join(" ")).toContain(
      '"version: 2" is required',
    );
    expect(parseErrors(`version: 1\nname: t\nsteps:\n  - id: a\n    unit: { instructions: x }`).join(" ")).toContain(
      "version 1 retired",
    );
    expect(parseErrors(`version: "2"\nname: t\nsteps:\n  - id: a\n    unit: { instructions: x }`).join(" ")).toContain(
      'got "2"',
    );
  });

  test("name is required and non-empty", () => {
    expect(parseErrors(`version: 2\nsteps:\n  - id: a\n    unit: { instructions: x }`).join(" ")).toContain(
      '"name" is required',
    );
    expect(parseErrors(`version: 2\nname: ""\nsteps:\n  - id: a\n    unit: { instructions: x }`).join(" ")).toContain(
      '"name" is required',
    );
  });

  test("steps must be a non-empty list", () => {
    expect(parseErrors(`version: 2\nname: t`).join(" ")).toContain('"steps" is required');
    expect(parseErrors(`version: 2\nname: t\nsteps: []`).join(" ")).toContain("at least one step");
    expect(parseErrors(`version: 2\nname: t\nsteps: not-a-list`).join(" ")).toContain('"steps" is required');
  });

  test("unknown top-level keys are rejected", () => {
    const errors = parseErrors(`version: 2\nname: t\nbogus: 4\nsteps:\n  - id: a\n    unit: { instructions: x }`);
    expect(errors.join(" ")).toContain('Unknown top-level key "bogus"');
  });

  test("params must map identifier names to schema objects", () => {
    expect(
      parseErrors(`version: 2\nname: t\nparams: nope\nsteps:\n  - id: a\n    unit: { instructions: x }`).join(" "),
    ).toContain('"params" must be a mapping');
    expect(
      parseErrors(
        `version: 2\nname: t\nparams:\n  bad-name: { type: string }\nsteps:\n  - id: a\n    unit: { instructions: x }`,
      ).join(" "),
    ).toContain('Param name "bad-name" is invalid');
    expect(
      parseErrors(
        `version: 2\nname: t\nparams:\n  files: string\nsteps:\n  - id: a\n    unit: { instructions: x }`,
      ).join(" "),
    ).toContain('Param "files" must be a JSON Schema object');
  });

  test("defaults are validated (engine, timeout, on_error, retired selectors, unknown keys)", () => {
    const errors = parseErrors(
      `version: 2\nname: t\ndefaults:\n  engine: ""\n  runner: cloud\n  timeout: 10h\n  on_error: retry\n  concurrency: 2\nsteps:\n  - id: a\n    unit: { instructions: x }`,
    );
    const joined = errors.join(" | ");
    expect(joined).toContain('"defaults.engine" must be a non-empty engine name');
    expect(joined).toContain('Unknown "defaults" key "runner"');
    expect(joined).toContain('invalid timeout "10h"');
    expect(joined).toContain('"defaults.on_error" must be one of: fail | continue');
    expect(joined).toContain('Unknown "defaults" key "concurrency"');
  });

  test("budget: max_tokens/max_units parse into camelCase ceilings", () => {
    const program = parseOk(
      `version: 2\nname: t\nbudget:\n  max_tokens: 50000\n  max_units: 20\nsteps:\n  - id: a\n    unit: { instructions: x }`,
    );
    expect(program.budget).toEqual({ maxTokens: 50000, maxUnits: 20 });

    const only = parseOk(
      `version: 2\nname: t\nbudget: { max_units: 3 }\nsteps:\n  - id: a\n    unit: { instructions: x }`,
    );
    expect(only.budget).toEqual({ maxUnits: 3 });

    // An empty budget block declares no ceilings — same treatment as an
    // empty defaults block (omitted from the parsed program).
    const empty = parseOk(`version: 2\nname: t\nbudget: {}\nsteps:\n  - id: a\n    unit: { instructions: x }`);
    expect(empty.budget).toBeUndefined();
  });

  test("budget is validated (mapping shape, integer >= 1 ceilings, unknown keys)", () => {
    expect(
      parseErrors(`version: 2\nname: t\nbudget: 4\nsteps:\n  - id: a\n    unit: { instructions: x }`).join(" "),
    ).toContain('"budget" must be a mapping with any of: max_tokens, max_units');

    const joined = parseErrors(
      `version: 2\nname: t\nbudget:\n  max_tokens: 0\n  max_units: 1.5\n  max_dollars: 2\nsteps:\n  - id: a\n    unit: { instructions: x }`,
    ).join(" | ");
    expect(joined).toContain('"budget.max_tokens" must be an integer >= 1');
    expect(joined).toContain('"budget.max_units" must be an integer from 1 through 10000');

    expect(
      parseErrors(
        `version: 2\nname: t\nbudget: { max_units: 10001 }\nsteps:\n  - id: a\n    unit: { instructions: x }`,
      ).join(" | "),
    ).toContain('"budget.max_units" must be an integer from 1 through 10000');
    expect(joined).toContain('Unknown "budget" key "max_dollars"');

    expect(
      parseErrors(
        `version: 2\nname: t\nbudget: { max_tokens: many }\nsteps:\n  - id: a\n    unit: { instructions: x }`,
      ).join(" "),
    ).toContain('"budget.max_tokens" must be an integer >= 1');
  });
});

describe("parseWorkflowProgram — step validation", () => {
  test("step ids: required, pattern, duplicates", () => {
    const joined = parseErrors(
      withSteps(
        [
          "  - unit: { instructions: x }",
          "  - id: -bad",
          "    unit: { instructions: x }",
          "  - id: dup",
          "    unit: { instructions: x }",
          "  - id: dup",
          "    unit: { instructions: x }",
        ].join("\n"),
      ),
    ).join(" | ");
    expect(joined).toContain('Step 1 requires a non-empty string "id"');
    expect(joined).toContain('invalid id "-bad"');
    expect(joined).toContain('Duplicate step id "dup"');
  });

  test("rejects step ids outside the ${{ }}-addressable grammar (leading digit, dots)", () => {
    for (const bad of ["1build", "build.js", "a.gate", "build.step"]) {
      const errors = parseErrors(withSteps(`  - id: ${bad}\n    unit: { instructions: x }`));
      const joined = errors.join(" | ");
      expect(joined).toContain(`invalid id "${bad}"`);
      // The message must point at the addressability root cause.
      expect(joined).toContain("cannot be referenced from ${{ }} expressions");
    }
  });

  test("accepts step ids with underscores/dashes/digits after a valid first char", () => {
    for (const good of ["build", "_hidden", "build_js", "build-js", "b1", "step2output"]) {
      const program = parseOk(withSteps(`  - id: ${good}\n    unit: { instructions: x }`));
      expect(program.steps[0]?.id).toBe(good);
      // Every accepted id must satisfy the addressable pattern.
      expect(PROGRAM_STEP_ID_PATTERN.test(good)).toBe(true);
    }
  });

  test("exactly one of unit | map | route", () => {
    const none = parseErrors(withSteps("  - id: a")).join(" ");
    expect(none).toContain('must declare exactly one of "unit", "map", or "route" (found none)');

    const both = parseErrors(
      withSteps(
        [
          "  - id: a",
          "    unit: { instructions: x }",
          "    map:",
          "      over: ${{ params.files }}",
          "      unit: { instructions: y }",
        ].join("\n"),
      ),
    ).join(" ");
    expect(both).toContain("found unit + map");
  });

  test("unknown step and unit keys are rejected", () => {
    const joined = parseErrors(
      withSteps(["  - id: a", "    runner: sdk", "    unit:", "      instructions: x", "      fanout: 3"].join("\n")),
    ).join(" | ");
    expect(joined).toContain('Unknown Step "a" key "runner"');
    expect(joined).toContain('Unknown Step "a" "unit" key "fanout"');
  });

  test("unit requires non-empty instructions", () => {
    expect(parseErrors(withSteps("  - id: a\n    unit: {}")).join(" ")).toContain(
      'requires non-empty string "instructions"',
    );
    expect(parseErrors(withSteps(`  - id: a\n    unit: { instructions: "" }`)).join(" ")).toContain(
      'requires non-empty string "instructions"',
    );
  });

  test("unit fields: engine, on_error, isolation, retired runner, env entries, output shape", () => {
    const joined = parseErrors(
      withSteps(
        [
          "  - id: a",
          "    unit:",
          "      instructions: x",
          '      engine: ""',
          "      runner: gpu",
          "      on_error: explode",
          "      isolation: chroot",
          "      env: [ok, 3]",
          "      output: not-a-schema",
        ].join("\n"),
      ),
    ).join(" | ");
    expect(joined).toContain('"engine" must be a non-empty engine name');
    expect(joined).toContain('Unknown Step "a" "unit" key "runner"');
    expect(joined).toContain('"on_error" must be one of: fail | continue');
    expect(joined).toContain('"isolation" must be one of: none | worktree');
    expect(joined).toContain('"env" must be a list of non-empty env asset refs');
    expect(joined).toContain("must be a JSON Schema object");
  });

  test("timeout format errors", () => {
    const joined = parseErrors(
      withSteps(
        [
          "  - id: a",
          "    unit: { instructions: x, timeout: 10h }",
          "  - id: b",
          "    unit: { instructions: x, timeout: 0s }",
          "  - id: c",
          "    unit: { instructions: x, timeout: true }",
          "  - id: d",
          "    unit: { instructions: x, timeout: -5 }",
        ].join("\n"),
      ),
    ).join(" | ");
    expect(joined).toContain('invalid timeout "10h"');
    expect(joined).toContain('non-positive timeout "0s"');
    expect(joined).toContain("must be a duration string");
    expect(joined).toContain("non-positive timeout -5");
  });

  test("timeout format errors: bare zero, unknown units, non-numeric, and empty strings are all rejected", () => {
    const joined = parseErrors(
      withSteps(
        [
          "  - id: a",
          "    unit: { instructions: x, timeout: 0 }", // bare zero → non-positive
          "  - id: b",
          "    unit: { instructions: x, timeout: 1h }", // hours are not a unit
          "  - id: c",
          "    unit: { instructions: x, timeout: abc }", // not a duration at all
          "  - id: d",
          '    unit: { instructions: x, timeout: "" }', // empty string
        ].join("\n"),
      ),
    ).join(" | ");
    expect(joined).toContain("non-positive timeout 0");
    expect(joined).toContain('invalid timeout "1h"');
    expect(joined).toContain('invalid timeout "abc"');
    expect(joined).toContain('invalid timeout ""');
  });

  test("retry: shape, max, and the failure-reason vocabulary", () => {
    const joined = parseErrors(
      withSteps(
        [
          "  - id: a",
          "    unit: { instructions: x, retry: nope }",
          "  - id: b",
          "    unit: { instructions: x, retry: { max: -1, on: [timeout] } }",
          "  - id: c",
          "    unit: { instructions: x, retry: { max: 2 } }",
          "  - id: d",
          "    unit: { instructions: x, retry: { max: 2, on: [flaky_network] } }",
        ].join("\n"),
      ),
    ).join(" | ");
    expect(joined).toContain('"retry" must be a mapping');
    expect(joined).toContain('"retry.max" is required and must be a non-negative integer');
    expect(joined).toContain('"retry.on" is required and must be a non-empty list');
    expect(joined).toContain('unknown failure reason "flaky_network"');
    expect(joined).toContain(PROGRAM_RETRY_REASONS.join(", "));
  });

  test("map: over and unit required, concurrency positive int, reducer enum", () => {
    const joined = parseErrors(
      withSteps(["  - id: a", "    map:", "      concurrency: 0", "      reducer: best-of-n"].join("\n")),
    ).join(" | ");
    expect(joined).toContain('"map" requires "over"');
    expect(joined).toContain('"concurrency" must be a positive integer');
    expect(joined).toContain('"reducer" must be one of: collect | vote');
    expect(joined).toContain('"map" requires a nested "unit"');
  });

  test("gate: criteria required non-empty, max_loops >= 1", () => {
    const joined = parseErrors(
      withSteps(
        [
          "  - id: a",
          "    unit: { instructions: x }",
          "    gate: { criteria: [] }",
          "  - id: b",
          "    unit: { instructions: x }",
          "    gate: { criteria: [ok], max_loops: 0 }",
        ].join("\n"),
      ),
    ).join(" | ");
    expect(joined).toContain('"gate" requires "criteria": a non-empty list');
    expect(joined).toContain('"gate.max_loops" must be an integer >= 1');
  });

  test("errors carry best-effort line numbers", () => {
    const result = parseWorkflowProgram(
      `version: 2\nname: t\nsteps:\n  - id: a\n    unit:\n      instructions: x\n      engine: ""\n`,
      SOURCE,
    );
    if (result.ok) throw new Error("expected failure");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].line).toBe(7);
  });
});

describe("parseWorkflowProgram — route validation", () => {
  function routeProgram(routeYaml: string, extraSteps = ""): string {
    return withSteps(
      ["  - id: start", "    unit: { instructions: x }", "  - id: router", `    route:\n${routeYaml}`, extraSteps]
        .filter((s) => s !== "")
        .join("\n"),
    );
  }

  test("input and when are required", () => {
    const joined = parseErrors(routeProgram("      default: start")).join(" | ");
    expect(joined).toContain('"route" requires "input"');
    expect(joined).toContain('"route" requires "when"');
  });

  test("when must be a non-empty mapping to step-id strings", () => {
    expect(parseErrors(routeProgram(`      input: \${{ steps.start.output.v }}\n      when: {}`)).join(" ")).toContain(
      '"when" must contain at least one match',
    );
    expect(
      parseErrors(routeProgram(`      input: \${{ steps.start.output.v }}\n      when: { pass: 42 }`)).join(" "),
    ).toContain('"when: pass" must map to a step id string');
  });

  test("route targets must exist", () => {
    const joined = parseErrors(
      routeProgram(`      input: \${{ steps.start.output.v }}\n      when: { pass: ghost }`),
    ).join(" ");
    expect(joined).toContain('routes to unknown step "ghost"');
  });

  test("no self-route", () => {
    const joined = parseErrors(
      routeProgram(`      input: \${{ steps.start.output.v }}\n      when: { pass: router }`),
    ).join(" ");
    expect(joined).toContain("must not route to itself");
  });

  test("route targets must come after the routing step", () => {
    const joined = parseErrors(
      routeProgram(`      input: \${{ steps.start.output.v }}\n      when: { pass: start }`),
    ).join(" ");
    expect(joined).toContain('routes backward to "start"');
    expect(joined).toContain("must come after the routing step");
  });

  test("default target gets the same checks", () => {
    const joined = parseErrors(
      routeProgram(
        `      input: \${{ steps.start.output.v }}\n      when: { pass: after }\n      default: ghost`,
        "  - id: after\n    unit: { instructions: x }",
      ),
    ).join(" ");
    expect(joined).toContain('routes to unknown step "ghost"');
  });

  test("when-match uniqueness survives YAML key-type confusion", () => {
    // `true` and `"true"` are different YAML keys but the same match string.
    const joined = parseErrors(
      routeProgram(
        `      input: \${{ steps.start.output.v }}\n      when:\n        true: after\n        "true": after`,
        "  - id: after\n    unit: { instructions: x }",
      ),
    ).join(" ");
    expect(joined).toContain('duplicate "when" match "true"');
  });

  test("duplicate identical when keys are caught by YAML itself", () => {
    const result = parseWorkflowProgram(
      routeProgram(
        `      input: \${{ steps.start.output.v }}\n      when:\n        pass: after\n        pass: after`,
        "  - id: after\n    unit: { instructions: x }",
      ),
      SOURCE,
    );
    expect(result.ok).toBe(false);
  });
});

describe("parseWorkflowProgram — ${{ }} syntactic pass", () => {
  test("unterminated ${{ is rejected in instructions, over, and input", () => {
    const joined = parseErrors(
      withSteps(
        [
          "  - id: a",
          `    unit: { instructions: "review \${{ item" }`,
          "  - id: b",
          "    map:",
          `      over: "\${{ steps.a.output.files"`,
          "      unit: { instructions: x }",
        ].join("\n"),
      ),
    ).join(" | ");
    expect(joined).toContain(`Step "a" "instructions" contains an unterminated "\${{" expression`);
    expect(joined).toContain(`Step "b" "over" contains an unterminated "\${{" expression`);
  });

  test("closed-grammar violations are rejected via the expressions module when present", async () => {
    // The full syntactic pass is best-effort: parser.ts loads ./expressions
    // defensively (it is written by a parallel task). Skip when absent —
    // the compiler task enforces the grammar unconditionally.
    try {
      await import("../../src/workflows/program/expressions");
    } catch {
      return;
    }
    const joined = parseErrors(
      withSteps(["  - id: a", `    unit: { instructions: "run \${{ shell(1) }} now" }`].join("\n")),
    ).join(" | ");
    expect(joined).toContain(`Step "a" "instructions"`);
  });

  test("well-formed expressions pass", () => {
    const program = parseOk(
      withSteps(
        ["  - id: a", `    unit: { instructions: "review \${{ params.target }} and \${{ item }}" }`].join("\n"),
      ),
    );
    expect(program.steps[0].unit?.instructions).toContain("${{ params.target }}");
  });
});

describe("parseWorkflowProgram — hostile input", () => {
  test("anchors and aliases are accepted", () => {
    const program = parseOk(
      withSteps(
        ["  - id: a", "    unit: &shared", "      instructions: shared body", "  - id: b", "    unit: *shared"].join(
          "\n",
        ),
      ),
    );
    expect(program.steps[1].unit?.instructions).toBe("shared body");
  });

  test("YAML syntax errors are reported, not thrown", () => {
    const result = parseWorkflowProgram("version: 2\nname: [unclosed", SOURCE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
  });

  test("deeply nested input does not crash", () => {
    const depth = 200;
    const nested = `${Array.from({ length: depth }, (_, i) => `${"  ".repeat(i + 2)}n:`).join("\n")} 1`;
    const yamlText = `version: 2\nname: t\nparams:\n  deep:\n${nested}\nsteps:\n  - id: a\n    unit: { instructions: x }`;
    const result = parseWorkflowProgram(yamlText, SOURCE);
    expect(typeof result.ok).toBe("boolean");
  });

  test("type-confused input does not crash", () => {
    const cases = [
      "version: [1]\nname: {}\nsteps: 3",
      "version: 2\nname: t\nsteps:\n  - 42\n  - [list, step]",
      "version: 2\nname: t\nsteps:\n  - id: a\n    unit: [not, a, map]\n    gate: 9",
      "version: 2\nname: t\ndefaults: [1, 2]\nsteps:\n  - id: a\n    route: yes",
      "version: 2\nname: t\nsteps:\n  - id: a\n    route:\n      input: x\n      when: [pass, fail]",
    ];
    for (const yamlText of cases) {
      const result = parseWorkflowProgram(yamlText, SOURCE);
      expect(result.ok).toBe(false);
    }
  });

  test("alias-expansion bombs do not crash", () => {
    const bomb = [
      "version: 2",
      "name: t",
      "a: &a [x, x, x, x, x, x, x, x, x]",
      "b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]",
      "c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]",
      "d: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c]",
      "steps:",
      "  - id: a",
      "    unit: { instructions: x }",
    ].join("\n");
    const result = parseWorkflowProgram(bomb, SOURCE);
    // Either the expansion guard trips or the unknown-key check fires; the
    // parser must return errors, never throw.
    expect(result.ok).toBe(false);
  });
});

describe("looksLikeWorkflowProgram", () => {
  test("matches version: 2 plus steps: at column 0", () => {
    expect(looksLikeWorkflowProgram(LINEAR)).toBe(true);
    expect(looksLikeWorkflowProgram(ADDENDUM_EXAMPLE)).toBe(true);
    expect(looksLikeWorkflowProgram(`version: "2"\nsteps:\n  - id: a`)).toBe(true);
    expect(looksLikeWorkflowProgram("version: 2  # program\nsteps: []")).toBe(true);
  });

  test("rejects non-program text", () => {
    expect(looksLikeWorkflowProgram("# Workflow: classic markdown\n\n## Step: one")).toBe(false);
    expect(looksLikeWorkflowProgram("version: 1\nsteps:\n  - id: a")).toBe(true);
    expect(looksLikeWorkflowProgram("version: 2\nno_steps: true")).toBe(false);
    expect(looksLikeWorkflowProgram("  version: 2\n  steps:\n")).toBe(false);
    expect(looksLikeWorkflowProgram("version: 20\nsteps:\n")).toBe(false);
  });
});

describe("schemas/akm-workflow.json stays in sync with the TS vocabulary", () => {
  const schemaPath = path.resolve(import.meta.dir, "../../schemas/akm-workflow.json");
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as {
    definitions: Record<string, { enum?: string[]; pattern?: string; properties?: Record<string, unknown> }>;
    properties: Record<string, { propertyNames?: { pattern?: string } }>;
  };

  test("enum vocabularies match the exported constants", () => {
    expect(schema.definitions.onError.enum).toEqual([...PROGRAM_ON_ERROR]);
    expect(schema.definitions.reducer.enum).toEqual([...PROGRAM_REDUCERS]);
    expect(schema.definitions.isolation.enum).toEqual([...PROGRAM_ISOLATION_KINDS]);
    expect(schema.definitions.failureReason.enum).toEqual([...PROGRAM_RETRY_REASONS]);
  });

  test("id and param-name patterns match", () => {
    expect(schema.definitions.identifier.pattern).toBe(PROGRAM_STEP_ID_PATTERN.source);
    expect(schema.properties.params.propertyNames?.pattern).toBe(PROGRAM_PARAM_NAME_PATTERN.source);
  });

  test("budget block keys match the parser's vocabulary", () => {
    expect(Object.keys(schema.definitions.budget.properties ?? {}).sort()).toEqual(["max_tokens", "max_units"]);
    expect("budget" in schema.properties).toBe(true);
  });
});
