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

function github(yaml: string, filePath = "workflows/contract.yml") {
  return compile(yaml, filePath);
}

function expectGithubError(yaml: string, code: string, line?: number): void {
  const result = github(yaml);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(
    result.errors.some((error) => error.code === code),
    JSON.stringify(result.errors),
  ).toBe(true);
  if (line !== undefined) expect(result.errors.find((error) => error.code === code)?.line).toBe(line);
}

/** A step spec without its source span and display prose — what actually runs. */
function runnable(spec: WorkflowStepSpec | undefined): Omit<WorkflowStepSpec, "source" | "instructions"> {
  const { source: _source, instructions: _instructions, ...rest } = spec ?? ({} as WorkflowStepSpec);
  return rest;
}

const VALID_HEADER = `name: Local contract
on:
  workflow_dispatch:
jobs:
  main:
    runs-on: [self-hosted]
    steps:`;

describe("both grammars compile to the one plan", () => {
  test("Markdown direct argv stays distinct from GitHub shell text", () => {
    const markdown = plan(readFixture("equivalent/contract-review.md"), "workflows/contract-review.md");
    const yaml = plan(readFixture("equivalent/contract-review.yml"), "workflows/contract-review.yml");
    expect(markdown.steps[0]?.spec?.exec).toEqual({ command: ["printf", "contract-reviewed"] });
    expect(yaml.steps[0]?.spec?.exec).toEqual({ command: ["sh", "-c", "printf contract-reviewed"] });
    expect(markdown.steps.map((step) => step.stepId)).toEqual(yaml.steps.map((step) => step.stepId));
  });

  test("equivalent built-in command sources compile to the same runnable step", () => {
    const markdown = plan(
      `---\ntype: workflow\nsteps:\n  - id: review\n---\n# Contract review\n\n## review\n\nReview the execution contract.\n`,
      "workflows/contract-review.md",
    );
    const yaml = plan(
      `name: Contract review
on: { workflow_dispatch: null }
jobs:
  contract:
    runs-on: [self-hosted]
    steps:
      - id: review
        uses: akm/command
        with:
          content: Review the execution contract.
`,
      "workflows/contract-review.yml",
    );
    expect(runnable(markdown.steps[0]?.spec)).toEqual(runnable(yaml.steps[0]?.spec));
    expect(runnable(markdown.steps[0]?.spec)).toEqual({
      uses: "akm/command",
      commandMode: "literal",
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

  test("carries direct argv, cwd, map, route, inputs, schemas, and gates", () => {
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
  - id: choose
    route:
      input: steps.review.output
      when:
        - { match: pass, step: ship }
      default: repair
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

## choose

Routing documentation.

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
    expect(compiled.steps[2]).toMatchObject({
      route: { input: "steps.review.output", when: { pass: "ship" }, defaultStepId: "repair" },
      spec: { instructions: "Routing documentation." },
    });
  });
});

describe("strict bounded GitHub-shaped YAML", () => {
  test.each([
    ["duplicate-key", `name: A\nname: B\non: { workflow_dispatch: null }\njobs: {}`],
    ["yaml-anchor", `name: A\non: &events { workflow_dispatch: null }\njobs: {}`],
    ["yaml-alias", `name: A\non: &events { workflow_dispatch: null }\njobs: *events`],
    ["yaml-custom-tag", `name: !contract A\non: { workflow_dispatch: null }\njobs: {}`],
    ["mapping-root-required", `- name\n- on\n- jobs`],
    ["unsafe-key", `name: A\non: { workflow_dispatch: null }\njobs:\n  constructor: {}`],
    ["unknown-key", `name: A\non: { workflow_dispatch: null }\njobs: {}\npermissions: read-all`],
  ])("rejects %s", (code, yaml) => expectGithubError(yaml, code));

  test("rejects excessive source bytes, YAML depth, and collection size", () => {
    expectGithubError(
      `${VALID_HEADER}\n      - id: huge\n        run: echo ${"x".repeat(1_048_576)}\n`,
      "source-size-limit",
    );
    const nested = `${VALID_HEADER}\n      - id: deep\n        uses: commands/deep\n        with:\n          value: ${"[".repeat(40)}x${"]".repeat(40)}\n`;
    expectGithubError(nested, "yaml-depth-limit");
    const steps = Array.from({ length: 257 }, (_, index) => `      - id: s${index}\n        run: echo s${index}`).join(
      "\n",
    );
    expectGithubError(`${VALID_HEADER}\n${steps}\n`, "step-count-limit");
  });

  test("accepts only local schedule/manual triggers; schedules compile in order with their lines", () => {
    const valid = github(`name: Timed
on:
  schedule:
    - cron: "0 8 * * 1"
    - cron: "30 9 * * 2"
  workflow_dispatch: null
jobs:
  main:
    runs-on: [self-hosted]
    steps: [{ id: ok, run: echo ok }]
`);
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.plan.schedules).toEqual([
        { cron: "0 8 * * 1", ordinal: 0, line: 4 },
        { cron: "30 9 * * 2", ordinal: 1, line: 5 },
      ]);
    }
    expectGithubError(`name: Push\non:\n  push: { branches: [main] }\njobs: {}`, "unsupported-service-event", 3);
    expectGithubError(
      `name: Inputs\non:\n  workflow_dispatch:\n    inputs:\n      name: { required: true }\njobs: {}`,
      "workflow-dispatch-inputs-unsupported",
      4,
    );
  });

  test("requires exactly the local self-hosted runner", () => {
    expectGithubError(
      `${VALID_HEADER.replace("[self-hosted]", "ubuntu-latest")}\n      - id: ok\n        run: echo ok\n`,
      "unsupported-runner",
    );
    expectGithubError(
      `${VALID_HEADER.replace("[self-hosted]", "[self-hosted, linux]")}\n      - id: ok\n        run: echo ok\n`,
      "unsupported-runner",
    );
  });

  test.each([
    ["job strategy", "strategy: { matrix: { node: [20, 22] } }", "unknown-key"],
    ["job container", "container: node:22", "unknown-key"],
    ["job services", "services: { db: { image: postgres } }", "unknown-key"],
  ])("rejects unsupported %s semantics", (_label, field, code) => {
    expectGithubError(
      `name: Unsupported
on: { workflow_dispatch: null }
jobs:
  main:
    runs-on: [self-hosted]
    ${field}
    steps: [{ id: ok, run: echo ok }]
`,
      code,
    );
  });

  test("rejects step conditionals and duplicate step ids", () => {
    expectGithubError(
      `${VALID_HEADER}\n      - id: conditional\n        if: success()\n        run: echo ok\n`,
      "unknown-key",
    );
    expectGithubError(
      `${VALID_HEADER}\n      - id: repeated\n        run: echo one\n      - id: repeated\n        run: echo two\n`,
      "duplicate-step-id",
    );
  });

  test("accepts local asset targets and rejects remote actions", () => {
    for (const uses of [
      "akm/command",
      "commands/review",
      "team//commands/review",
      "tasks/review",
      "team//tasks/review",
      "scripts/build.sh",
      "workflows/child",
    ]) {
      const withBlock = uses === "akm/command" ? "\n        with: { content: Review this }" : "";
      const result = github(`${VALID_HEADER}\n      - id: local\n        uses: ${uses}${withBlock}\n`);
      expect(result.ok, uses).toBe(true);
    }
    for (const [uses, code] of [
      ["actions/checkout@v4", "unsupported-uses-target"],
      ["./actions/review", "local-action-path-unsupported"],
      ["docker://alpine:latest", "docker-action-unsupported"],
      ["agents/reviewer", "non-executable-asset-ref"],
      ["akm:commands/review", "unsupported-uses-target"],
      ["bad.bundle//commands/review", "unsupported-uses-target"],
      ["commands/review#fragment", "unsupported-uses-target"],
      ["actions/checkout@bad:ref", "unsupported-uses-target"],
      ["review", "unsupported-uses-target"],
    ] as const) {
      expectGithubError(`${VALID_HEADER}\n      - id: rejected\n        uses: ${uses}\n`, code);
    }
  });

  test("keeps the built-in command action's exact empty content and arguments", () => {
    const result = github(`${VALID_HEADER}
      - id: inline
        uses: akm/command
        with:
          content: ""
          arguments: ""
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.steps[0]?.spec).toMatchObject({
      with: { content: "", arguments: "" },
      commandMode: "portable-template",
    });
  });

  test("classifies inline, stored, and literal command content without scanning it", () => {
    const inline = plan(
      `${VALID_HEADER}
      - id: safe
        uses: akm/command
        with:
          content: echo $HOME
          arguments: exact input
`,
      "workflows/contract.yml",
    );
    expect(inline.steps[0]?.spec).toMatchObject({
      commandMode: "portable-template",
      with: { content: "echo $HOME", arguments: "exact input" },
    });
    const stored = plan(
      `${VALID_HEADER}
      - id: stored
        uses: akm/command
        with:
          ref: commands/review
          arguments: "  exact $HOME input  "
`,
      "workflows/contract.yml",
    );
    expect(stored.steps[0]?.spec).toMatchObject({
      uses: "akm/command",
      commandMode: "stored-ref",
      with: { ref: "commands/review", arguments: "  exact $HOME input  " },
    });
    expect(workflowStepInstructions(stored.steps[0]!)).toBe("Invoke stored command commands/review with arguments.");

    const markdown = plan(
      `---
type: workflow
steps:
  - id: review
---
# Review

## review

Review $ARGUMENTS and \${{ github.sha }} literally.
`,
      "workflows/literal.md",
    );
    const templated = plan(
      `${VALID_HEADER}
      - id: review
        uses: akm/command
        with:
          content: Review $ARGUMENTS
          arguments: "  exact $HOME input  "
`,
      "workflows/contract.yml",
    );
    expect(markdown.steps[0]?.spec?.commandMode).toBe("literal");
    expect(templated.steps[0]?.spec?.commandMode).toBe("portable-template");
    expect(workflowStepInstructions(markdown.steps[0]!)).toContain(
      "Review $ARGUMENTS and $" + "{{ github.sha }} literally.",
    );
    expect(workflowStepInstructions(templated.steps[0]!)).toBe("Review   exact $HOME input  ");
  });

  test("accepts local run with the closed shell table and contained working directories", () => {
    for (const shell of ["bash", "sh", "zsh", "pwsh", "powershell", "cmd"]) {
      const result = github(
        `${VALID_HEADER}\n      - id: local\n        run: bun run check --filter=unit\n        shell: ${shell}\n        working-directory: packages/cli\n`,
      );
      expect(result.ok, shell).toBe(true);
    }
    for (const run of ["echo ok && curl example.com", "echo $HOME", "echo %PATH%", 'echo "quoted"']) {
      const result = github(`${VALID_HEADER}\n      - id: safe\n        run: ${run}\n`);
      expect(result.ok, run).toBe(true);
    }
    const multiline = plan(
      `${VALID_HEADER}\n      - id: multiline\n        run: |\n          echo one\n          echo two\n`,
      "workflows/contract.yml",
    );
    expect(multiline.steps[0]?.spec).toMatchObject({
      exec: { command: ["sh", "-c", "echo one\necho two\n"] },
      instructions: "Run echo one\necho two\n.",
    });
    expectGithubError(
      `${VALID_HEADER}\n      - id: unsafe\n        run: echo \${{ github.sha }}\n`,
      "unsupported-github-expression",
    );
    expectGithubError(
      `${VALID_HEADER}\n      - id: shell\n        run: echo ok\n        shell: fish\n`,
      "unsupported-shell",
    );
    expectGithubError(
      `${VALID_HEADER}\n      - id: cwd\n        run: echo ok\n        working-directory: ../outside\n`,
      "working-directory-escape",
    );
    expectGithubError(
      `${VALID_HEADER}\n      - id: cwd\n        run: echo ok\n        working-directory: packages//cli\n`,
      "working-directory-escape",
    );
  });

  test("canonicalizes cron and cwd spellings — run: is kept verbatim", () => {
    const compiled = plan(
      `name: Canonical
on:
  schedule: [{ cron: "0  8\t* * 1" }]
jobs:
  main:
    runs-on: [self-hosted]
    steps:
      - id: run
        run: "bun\t run   check"
        shell: bash
        working-directory: packages/./cli
`,
      "workflows/contract.yml",
    );
    expect(compiled.schedules?.[0]?.cron).toBe("0 8 * * 1");
    expect(compiled.steps[0]?.spec?.exec).toEqual({
      command: ["bash", "-c", "bun\t run   check"],
      cwd: "packages/cli",
    });
  });

  test("rejects multi-job YAML and any job needs with multi-job-unsupported", () => {
    const result = github(`name: Multi-job
on: { workflow_dispatch: null }
jobs:
  build:
    runs-on: [self-hosted]
    steps: [{ id: build, run: echo build }]
  deploy:
    needs: build
    runs-on: [self-hosted]
    steps: [{ id: deploy, run: echo deploy }]
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      {
        code: "multi-job-unsupported",
        message:
          "AKM workflow YAML requires exactly one job; this document declares 2. AKM's YAML is an AKM workflow " +
          "format executed by AKM's native engine, not GitHub Actions — split the jobs into separate workflows.",
        path: "workflows/contract.yml",
        line: 7,
      },
    ]);
    expectGithubError(
      `${VALID_HEADER}\n      - id: ok\n        run: echo ok\n    needs: absent\n`,
      "multi-job-unsupported",
    );
  });

  test("rejects NUL and control bytes in working directories", () => {
    expectGithubError(
      `${VALID_HEADER}\n      - id: nul\n        run: echo ok\n        working-directory: "packages\\0cli"\n`,
      "working-directory-control-character",
    );
    expectGithubError(
      `${VALID_HEADER}\n      - id: control\n        run: echo ok\n        working-directory: "packages\\x1fcli"\n`,
      "working-directory-control-character",
    );
  });

  test("anchors a missing akm/command with: at the uses selector", () => {
    expectGithubError(`${VALID_HEADER}\n      - id: inline\n        uses: akm/command\n`, "builtin-command-inputs", 9);
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
      const yaml = compile(
        `${VALID_HEADER}\n      - id: cwd\n        run: echo ok\n        working-directory: escape\n`,
        "workflows/escape.yml",
        workspace,
      );
      expect(yaml.ok).toBe(false);
      if (!yaml.ok) expect(yaml.errors.some((error) => error.code === "working-directory-escape")).toBe(true);
      expect(compile(markdownCwd("escape"), "workflows/escape.md", workspace).ok).toBe(false);
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
    const compileBoth = () => [
      compile(
        `${VALID_HEADER}\n      - id: cwd\n        run: echo ok\n        working-directory: escape\n`,
        "workflows/dangling.yml",
        workspace,
      ),
      compile(markdownCwd("escape"), "workflows/dangling.md", workspace),
    ];
    try {
      const before = compileBoth();
      for (const result of before) {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.errors[0]).toMatchObject({ code: "working-directory-unverifiable" });
      }
      const markdownBefore = before[1];
      if (markdownBefore && !markdownBefore.ok) expect(markdownBefore.errors[0]).toMatchObject({ line: 8 });
      fs.mkdirSync(outside);
      for (const result of compileBoth()) {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.errors[0]?.code).toMatch(/working-directory-(?:escape|unverifiable)/);
      }
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
