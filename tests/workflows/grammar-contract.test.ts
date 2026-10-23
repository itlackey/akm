// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Both workflow grammars (Markdown and GitHub-shaped YAML) compile straight to
 * the one plan. These pin what each grammar accepts, refuses (with a stable
 * code and line), and what the compiled step spec carries.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { compileWorkflowSource, workflowStepInstructions } from "../../src/workflows/compile";
import type { WorkflowPlan, WorkflowStepSpec } from "../../src/workflows/plan";

const FIXTURES = path.join(import.meta.dir, "../fixtures/execution-contracts/workflows");

function readFixture(relative: string): string {
  return fs.readFileSync(path.join(FIXTURES, relative), "utf8");
}

function compile(source: string, filePath: string) {
  return compileWorkflowSource(source, { path: filePath });
}

function plan(source: string, filePath: string): WorkflowPlan {
  const result = compile(source, filePath);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.plan;
}

/** A step spec without its source span and display prose — what actually runs. */
function runnable(spec: WorkflowStepSpec | undefined): Omit<WorkflowStepSpec, "source" | "instructions"> {
  const { source: _source, instructions: _instructions, ...rest } = spec ?? ({} as WorkflowStepSpec);
  return rest;
}

describe("the Markdown grammar compiles to the one plan", () => {
  test("Markdown direct argv is kept as an argv array", () => {
    const markdown = plan(readFixture("equivalent/contract-review.md"), "workflows/contract-review.md");
    expect(markdown.steps[0]?.spec?.exec).toEqual({ command: ["printf", "contract-reviewed"] });
  });

  test("a prose step compiles to the built-in command action with literal content", () => {
    const markdown = plan(
      `---\ntype: workflow\nsteps:\n  - id: review\n---\n# Contract review\n\n## review\n\nReview the execution contract.\n`,
      "workflows/contract-review.md",
    );
    expect(runnable(markdown.steps[0]?.spec)).toEqual({
      uses: "akm/command",
      with: { content: "Review the execution contract." },
    });
  });

  test.each([
    ["embedded whitespace", ["printf", "a b"]],
    ["literal shell operator", ["printf", "a;b"]],
    ["literal variable spelling", ["printf", "$HOME"]],
    ["literal quote bytes", ["printf", "'quoted'"]],
    ["explicit interpreter payload", ["bash", "-lc", "a | b"]],
  ] as const)("preserves %s argv without an argv-to-shell join", (_label, command) => {
    const compiled = plan(
      `---
type: workflow
steps:
  - id: direct
    unit:
      exec:
        command: ${JSON.stringify(command)}
---
# Direct

## direct

Run the direct command.
`,
      "workflows/direct.md",
    );
    expect(compiled.steps[0]?.spec?.exec?.command).toEqual([...command]);
  });

  test("keeps exec.cwd exactly as authored: relative, absolute, or carrying ${ref} tokens", () => {
    const markdown = (cwd: string) => `---
type: workflow
steps:
  - id: direct
    unit:
      exec:
        command: [bash, -lc, "a | b"]
        cwd: ${JSON.stringify(cwd)}
---
# Direct

## direct

Run the direct command.
`;
    for (const cwd of ["packages/cli", "/srv/build", "../sibling", "${tools//scripts/lab}/.."]) {
      expect(plan(markdown(cwd), "workflows/direct.md").steps[0]?.spec?.exec).toEqual({
        command: ["bash", "-lc", "a | b"],
        cwd,
      });
    }
  });

  test("a Markdown agent unit carries its engine settings beside the built-in command action", () => {
    const compiled = plan(readFixture("current/agent-unit.md"), "workflows/agent-unit.md");
    expect(compiled.steps[0]?.spec).toMatchObject({
      uses: "akm/command",
      with: { content: "Review the execution contract." },
      unit: { engine: "fixture-agent", model: "fixture-exact-model", timeoutMs: 45_000 },
    });
  });

  test("carries direct argv, cwd, map, inputs, schemas, and gates", () => {
    const compiled = plan(
      `---
type: workflow
description: Characterize every current dispatch form
defaults: { engine: local }
budget: { max_units: 9 }
steps:
  - id: discover
    output: { type: object }
  - id: review
    map:
      over: steps.discover.output.items
      concurrency: 2
      reducer: collect
      unit:
        exec:
          command: [bash, -lc, "a | b"]
          cwd: packages/cli
        on_error: continue
    inputs: [steps.discover.output]
    gate: { max_loops: 2 }
  - id: ship
  - id: repair
---
# Explicit semantics

Preamble.

## discover

Discover items.

## review

Review each item.

### gate

Every item passes.

## ship

Ship.

## repair

Repair.
`,
      "workflows/explicit.md",
    );
    expect(compiled).toMatchObject({
      description: "Characterize every current dispatch form",
      defaults: { engine: "local" },
      budget: { maxUnits: 9 },
      preamble: "# Explicit semantics\n\nPreamble.",
    });
    expect(compiled.steps[0]?.outputSchema).toEqual({ type: "object" });
    expect(compiled.steps[1]).toMatchObject({
      stepId: "review",
      spec: {
        exec: { command: ["bash", "-lc", "a | b"], cwd: "packages/cli" },
        unit: { onError: "continue" },
        map: { over: "steps.discover.output.items", concurrency: 2, reducer: "collect" },
        inputs: ["steps.discover.output"],
        instructions: "Review each item.",
      },
      gate: { maxLoops: 2, criteria: ["Every item passes."], frozenJudge: null },
    });
  });
});

describe("exec source failures are located at the authored field", () => {
  const markdownExec = (exec: string) => `---
type: workflow
steps:
  - id: cwd
    unit:
      exec:
${exec}
---
# Failures

## cwd

Run it.
`;

  test("an empty exec.cwd is the only static cwd failure", () => {
    const result = compile(markdownExec('        command: [echo, ok]\n        cwd: ""'), "workflows/empty-cwd.md");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatchObject({ code: "invalid-markdown-workflow", line: 8 });
      expect(result.errors[0]?.message).toMatch(/exec\.cwd.*non-empty string/);
    }
  });

  test("a NUL byte in argv is refused at its entry", () => {
    const result = compile(markdownExec('        command: ["bad\\0argv"]'), "workflows/bad-argv.md");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatchObject({ code: "invalid-markdown-workflow", line: 7 });
      expect(result.errors[0]?.message).toMatch(/NUL/i);
    }
  });
});
