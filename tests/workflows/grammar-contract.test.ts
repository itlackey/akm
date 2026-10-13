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
import os from "node:os";
import path from "node:path";
import { compileWorkflowSource, workflowStepInstructions } from "../../src/workflows/compile";
import type { WorkflowPlan, WorkflowStepSpec } from "../../src/workflows/plan";

const FIXTURES = path.join(import.meta.dir, "../fixtures/execution-contracts/workflows");

function readFixture(relative: string): string {
  return fs.readFileSync(path.join(FIXTURES, relative), "utf8");
}

function compile(source: string, filePath: string, workspaceRoot?: string) {
  return compileWorkflowSource(source, { path: filePath, ...(workspaceRoot ? { workspaceRoot } : {}) });
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

  test("canonicalizes equivalent direct cwd spellings without changing argv bytes", () => {
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
    for (const cwd of ["packages/./cli", "packages\\cli"]) {
      expect(plan(markdown(cwd), "workflows/direct.md").steps[0]?.spec?.exec).toEqual({
        command: ["bash", "-lc", "a | b"],
        cwd: "packages/cli",
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
          cwd: packages/./cli
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

describe("working-directory physical containment", () => {
  const markdownCwd = (cwd: string) => `---
type: workflow
steps:
  - id: cwd
    unit:
      exec:
        command: [echo, ok]
        cwd: ${cwd}
---
# Escape

## cwd

Run it.
`;

  test("rejects a working-directory symlink that physically escapes its workspace", () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akm-grammar-"));
    const workspace = path.join(sandbox, "workspace");
    const outside = path.join(sandbox, "outside");
    fs.mkdirSync(workspace);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(workspace, "escape"), "dir");
    try {
      const markdown = compile(markdownCwd("escape"), "workflows/escape.md", workspace);
      expect(markdown.ok).toBe(false);
      if (!markdown.ok) expect(markdown.errors.some((error) => error.code === "working-directory-escape")).toBe(true);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("source-locates Markdown cwd and argv failures at the authored field", () => {
    const source = markdownCwd('"bad\\0cwd"');
    const result = compile(source, "workflows/bad-cwd.md", process.cwd());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: "working-directory-control-character", line: 8 }),
      );
    }
    const invalidArgv = compile(
      source.replace("command: [echo, ok]", 'command: ["bad\\0argv"]'),
      "workflows/bad-argv.md",
      process.cwd(),
    );
    expect(invalidArgv.ok).toBe(false);
    if (!invalidArgv.ok) {
      expect(invalidArgv.errors[0]).toMatchObject({ code: "invalid-markdown-workflow", line: 7 });
      expect(invalidArgv.errors[0]?.message).toMatch(/NUL/i);
    }
  });

  test("fails closed on dangling cwd symlinks before an outside target can appear", () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akm-grammar-dangling-"));
    const workspace = path.join(sandbox, "workspace");
    const outside = path.join(sandbox, "outside-missing");
    fs.mkdirSync(workspace);
    fs.symlinkSync(outside, path.join(workspace, "escape"), "dir");
    const compileMarkdown = () => compile(markdownCwd("escape"), "workflows/dangling.md", workspace);
    try {
      const before = compileMarkdown();
      expect(before.ok).toBe(false);
      if (!before.ok) expect(before.errors[0]).toMatchObject({ code: "working-directory-unverifiable", line: 8 });
      fs.mkdirSync(outside);
      const after = compileMarkdown();
      expect(after.ok).toBe(false);
      if (!after.ok) expect(after.errors[0]?.code).toMatch(/working-directory-(?:escape|unverifiable)/);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
