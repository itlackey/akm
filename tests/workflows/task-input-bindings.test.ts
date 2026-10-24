// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `\${{ … }}` is
// tested here as literal, hostile content a nested with: value must still
// reject (B-27) — never workflow expression grammar, matching
// tests/integration/workflows/chaos.test.ts's own directive/rationale.

/**
 * FREEZE-TIME `with:` bindings on `uses: tasks/<ref>` workflow steps. This file
 * is the freeze matrix only; pre-attempt resolution lives in
 * tests/workflows/task-binding-resolution.test.ts.
 *
 * Sandbox/freeze pattern follows tests/workflows/with-rejection.test.ts and
 * tests/workflows/task-source-v4-deferral.test.ts (withIsolatedAkmStorage +
 * writeWorkflowTestConfig + akmIndex + startWorkflowRun +
 * decodeWorkflowPlan).
 *
 * `FrozenWorkflowTarget`'s `inputBindings` field is read through the single
 * `frozenInputBindings` helper below so the access lives in one place.
 *
 * Message text for every `INPUT_BINDING_INVALID` rejection is authored by this
 * test file: the contract pins the FACTS a message must carry, never exact
 * bytes. Assertions below therefore use `.toContain(...)` against the pinned
 * facts rather than `.toBe(...)` against invented prose, so the implementation
 * is free to choose its own exact wording as long as the named facts (step id,
 * target ref, offending key, declared-name set, schema-error detail, "earlier
 * step" / "declared workflow param") are present.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../src/core/config/config";
import { UsageError } from "../../src/core/errors";
import type { TaskInputBinding } from "../../src/execution/input-contract";
import { akmIndex } from "../../src/indexer/indexer";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { compileWorkflowSource } from "../../src/workflows/compile";
import { computeStepWorkList } from "../../src/workflows/exec/step-work";
import type { FrozenWorkflowTarget } from "../../src/workflows/plan";
import { decodeWorkflowPlan } from "../../src/workflows/runtime/run-plan";
import { listWorkflowRuns, startWorkflowRun } from "../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";

const STEP_ID = "dispatch";
const TASK_REF = "tasks/nightly-v4";
// Sorted (INPUT_NAME_PATTERN order), for B-11's "declared inputs" detail.
const DECLARED_INPUT_NAMES = ["files", "meta", "scope", "strict", "ticket"];

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
  resetConfigCache();
});

afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

function write(relative: string, content: string): void {
  const file = path.join(storage.stashDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

/** One `steps:` list entry, pre-indented to nest under a GitHub-shaped `jobs.<id>.steps:` block. */
function writeWorkflow(name: string, stepLines: readonly string[]): void {
  write(
    `workflows/${name}.yml`,
    [
      `name: ${name}`,
      "on:",
      "  workflow_dispatch:",
      "jobs:",
      "  main:",
      "    runs-on: [self-hosted]",
      "    steps:",
      ...stepLines,
      "",
    ].join("\n"),
  );
}

/**
 * The shared task source v4 fixture: five declared inputs covering every
 * shape this file's freeze matrix needs — `scope` (string enum + default),
 * `strict` (boolean + default), `ticket` (required string, no default),
 * `files` (optional array, no default — a reference-binding target), `meta`
 * (optional, unconstrained object — the B-15/B-16 hard-fail-band proof: if a
 * malformed `{from: ...}` value were ever silently reinterpreted as a
 * literal, an unconstrained `type: object` schema would accept it and freeze
 * would wrongly succeed).
 */
function writeCentralTaskFixture(): void {
  write("commands/review.md", "Review the workflow-composed task target.\n");
  write(
    "tasks/nightly-v4.yml",
    [
      "version: 4",
      "name: Nightly review v4",
      "uses: commands/review",
      "inputs:",
      "  scope:",
      "    type: string",
      "    enum: [changed, all]",
      "    default: changed",
      "  strict:",
      "    type: boolean",
      "    default: true",
      "  ticket:",
      "    type: string",
      "    required: true",
      "  files:",
      "    type: array",
      "    items:",
      "      type: string",
      "  meta:",
      "    type: object",
      "",
    ].join("\n"),
  );
}

async function planRow(runId: string) {
  return withWorkflowRunsRepo((repo) => repo.getRunById(runId));
}

function stepTarget(plan: ReturnType<typeof decodeWorkflowPlan>, index: number): FrozenWorkflowTarget | undefined {
  const root = plan.steps[index]?.root;
  if (!root) return undefined;
  return root.kind === "map" ? root.template.frozenTarget : root.frozenTarget;
}

/**
 * `FrozenWorkflowTarget`'s optional `inputBindings` field, read through one
 * helper so the access lives in one place.
 */
function frozenInputBindings(target: FrozenWorkflowTarget | undefined): readonly TaskInputBinding[] | undefined {
  return target?.inputBindings;
}

/** Run `ref` and return whatever it throws, or undefined if it resolves. */
async function captureRejection(ref: string): Promise<unknown> {
  try {
    await startWorkflowRun(ref);
    return undefined;
  } catch (error) {
    return error;
  }
}

async function expectInputBindingInvalid(ref: string): Promise<UsageError> {
  const error = await captureRejection(ref);
  expect(error).toBeInstanceOf(UsageError);
  if (!(error instanceof UsageError)) throw new Error("unreachable");
  expect(error.code).toBe("INPUT_BINDING_INVALID");
  return error;
}

/** B-11..B-13, B-15..B-18: every freeze-time rejection fails BEFORE the run row is published. */
async function expectNoRunRowWritten(): Promise<void> {
  const { runs } = await listWorkflowRuns();
  expect(runs).toHaveLength(0);
}

describe("freeze-time — literal and reference bindings normalize into inputBindings", () => {
  test("a literal with: value freezes alongside declared defaults, sorted by name; an unsupplied optional input with no default is absent", async () => {
    writeCentralTaskFixture();
    writeWorkflow("case", [
      `      - id: ${STEP_ID}`,
      `        uses: ${TASK_REF}`,
      "        with:",
      "          ticket: ABC-1",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const started = await startWorkflowRun("workflows/case");
    const row = await planRow(started.run.id);
    const plan = decodeWorkflowPlan(JSON.parse(row?.plan_json ?? "null"));
    const target = stepTarget(plan, 0);
    expect(target?.kind).toBe("command");

    // scope/strict get their declared defaults; files/meta stay absent
    // (optional, no default, not supplied) — sorted by name.
    expect(frozenInputBindings(target)).toEqual([
      { kind: "literal", name: "scope", value: "changed" },
      { kind: "literal", name: "strict", value: true },
      { kind: "literal", name: "ticket", value: "ABC-1" },
    ]);
  });

  test("a {from: steps.<id>.output.<path>} with: value freezes to a kind:reference binding naming the parsed reference", async () => {
    writeCentralTaskFixture();
    writeWorkflow("case", [
      "      - id: collect",
      "        uses: akm/command",
      "        with:",
      "          content: Collect data for the composed task.",
      `      - id: ${STEP_ID}`,
      `        uses: ${TASK_REF}`,
      "        with:",
      "          ticket: ABC-1",
      "          files:",
      "            from: steps.collect.output.files",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const started = await startWorkflowRun("workflows/case");
    const row = await planRow(started.run.id);
    const plan = decodeWorkflowPlan(JSON.parse(row?.plan_json ?? "null"));
    const target = stepTarget(plan, 1);
    const bindings = frozenInputBindings(target);
    expect(bindings).toHaveLength(4); // files, scope, strict, ticket (sorted); meta absent

    const byName = new Map((bindings ?? []).map((b) => [b.name, b]));
    expect(byName.get("files")).toMatchObject({
      kind: "reference",
      name: "files",
      from: "steps.collect.output.files",
    });
    expect(byName.get("scope")).toEqual({ kind: "literal", name: "scope", value: "changed" });
    expect(byName.get("strict")).toEqual({ kind: "literal", name: "strict", value: true });
    expect(byName.get("ticket")).toEqual({ kind: "literal", name: "ticket", value: "ABC-1" });
  });
});

describe("freeze-time — hard rejections: INPUT_BINDING_INVALID", () => {
  test("an unknown with: key is rejected, naming the step, the offending key, and the sorted declared set", async () => {
    writeCentralTaskFixture();
    writeWorkflow("case", [
      `      - id: ${STEP_ID}`,
      `        uses: ${TASK_REF}`,
      "        with:",
      "          ticket: ABC-1",
      "          bogus: nope",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await expectInputBindingInvalid("workflows/case");
    expect(error.message).toContain(STEP_ID);
    expect(error.message).toContain(TASK_REF);
    expect(error.message).toContain("with.bogus");
    for (const name of DECLARED_INPUT_NAMES) expect(error.message).toContain(name);
    await expectNoRunRowWritten();
  });

  test("a required input with no default, not supplied by with:, is rejected naming the missing input", async () => {
    writeCentralTaskFixture();
    writeWorkflow("case", [
      `      - id: ${STEP_ID}`,
      `        uses: ${TASK_REF}`,
      "        with:",
      "          scope: all",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await expectInputBindingInvalid("workflows/case");
    expect(error.message).toContain("ticket");
    expect(error.message.toLowerCase()).toContain("required");
    await expectNoRunRowWritten();
  });

  test("a literal value violating its declared schema is rejected, path-rooted at with.<name>", async () => {
    writeCentralTaskFixture();
    writeWorkflow("case", [
      `      - id: ${STEP_ID}`,
      `        uses: ${TASK_REF}`,
      "        with:",
      "          ticket: ABC-1",
      "          scope: bogus",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await expectInputBindingInvalid("workflows/case");
    expect(error.message).toContain("with.scope");
    expect(error.message).toContain("is not one of");
    await expectNoRunRowWritten();
  });
});

describe("freeze-time — the {from} hard-fail band never falls back to a literal", () => {
  test("{from} plus any other key is rejected, never reinterpreted as a literal object", async () => {
    writeCentralTaskFixture();
    writeWorkflow("case", [
      "      - id: collect",
      "        uses: akm/command",
      "        with:",
      "          content: Collect data.",
      `      - id: ${STEP_ID}`,
      `        uses: ${TASK_REF}`,
      "        with:",
      "          ticket: ABC-1",
      "          meta:",
      "            from: steps.collect.output.x",
      "            other: 1",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    // meta is declared `type: object` with no property constraints — if the
    // malformed {from, other} value were silently accepted as a literal, this
    // freeze would SUCCEED (an arbitrary object satisfies `type: object`).
    // It must fail instead.
    const error = await expectInputBindingInvalid("workflows/case");
    expect(error.message).toContain("with.meta");
    await expectNoRunRowWritten();
  });

  test('{from: "not a reference"} is rejected with parseReference\'s own message, never reinterpreted as a literal', async () => {
    writeCentralTaskFixture();
    writeWorkflow("case", [
      `      - id: ${STEP_ID}`,
      `        uses: ${TASK_REF}`,
      "        with:",
      "          ticket: ABC-1",
      "          meta:",
      "            from: not a reference",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await expectInputBindingInvalid("workflows/case");
    expect(error.message).toContain("with.meta");
    expect(error.message).toContain("allowed forms");
    await expectNoRunRowWritten();
  });

  test("{from: 42} (a non-string from) is rejected structurally, never reinterpreted as a literal", async () => {
    writeCentralTaskFixture();
    writeWorkflow("case", [
      `      - id: ${STEP_ID}`,
      `        uses: ${TASK_REF}`,
      "        with:",
      "          ticket: ABC-1",
      "          meta:",
      "            from: 42",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await expectInputBindingInvalid("workflows/case");
    expect(error.message).toContain("with.meta");
    await expectNoRunRowWritten();
  });

  test('{from: "steps.x"} (incomplete reference grammar) is rejected, never reinterpreted as a literal', async () => {
    writeCentralTaskFixture();
    writeWorkflow("case", [
      `      - id: ${STEP_ID}`,
      `        uses: ${TASK_REF}`,
      "        with:",
      "          ticket: ABC-1",
      "          meta:",
      "            from: steps.x",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await expectInputBindingInvalid("workflows/case");
    expect(error.message).toContain("with.meta");
    expect(error.message).toContain(".output");
    await expectNoRunRowWritten();
  });
});

describe("freeze-time — reference structural checks: earlier step, both grammar roots", () => {
  test("a reference naming a LATER step is rejected — earlier means before this step in frozen order", async () => {
    writeCentralTaskFixture();
    writeWorkflow("case", [
      `      - id: ${STEP_ID}`,
      `        uses: ${TASK_REF}`,
      "        with:",
      "          ticket: ABC-1",
      "          meta:",
      "            from: steps.later.output",
      "      - id: later",
      "        uses: akm/command",
      "        with:",
      "          content: Runs after dispatch.",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await expectInputBindingInvalid("workflows/case");
    expect(error.message).toContain("with.meta");
    expect(error.message.toLowerCase()).toContain("earlier step");
    await expectNoRunRowWritten();
  });

  test("a self-reference is rejected", async () => {
    writeCentralTaskFixture();
    writeWorkflow("case", [
      `      - id: ${STEP_ID}`,
      `        uses: ${TASK_REF}`,
      "        with:",
      "          ticket: ABC-1",
      "          meta:",
      `            from: steps.${STEP_ID}.output`,
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await expectInputBindingInvalid("workflows/case");
    expect(error.message).toContain("with.meta");
    expect(error.message.toLowerCase()).toContain("earlier step");
    await expectNoRunRowWritten();
  });

  test("a reference naming a nonexistent step id is rejected", async () => {
    writeCentralTaskFixture();
    writeWorkflow("case", [
      `      - id: ${STEP_ID}`,
      `        uses: ${TASK_REF}`,
      "        with:",
      "          ticket: ABC-1",
      "          meta:",
      "            from: steps.nope.output",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await expectInputBindingInvalid("workflows/case");
    expect(error.message).toContain("with.meta");
    expect(error.message.toLowerCase()).toContain("earlier step");
    await expectNoRunRowWritten();
  });

  test("a {from: params.<undeclared>} reference is rejected, naming the workflow's declared params", async () => {
    writeCentralTaskFixture();
    writeWorkflow("case", [
      `      - id: ${STEP_ID}`,
      `        uses: ${TASK_REF}`,
      "        with:",
      "          ticket: ABC-1",
      "          meta:",
      "            from: params.undeclared",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await expectInputBindingInvalid("workflows/case");
    expect(error.message).toContain("with.meta");
    expect(error.message.toLowerCase()).toContain("declared");
    expect(error.message.toLowerCase()).toContain("param");
    await expectNoRunRowWritten();
  });
});

describe("freeze-time — COMPOSITION_INVALID narrows to no-declared-inputs, grows to commands/scripts", () => {
  test("with: on a version: 4 task target that declares no inputs: at all is rejected COMPOSITION_INVALID", async () => {
    write("commands/review.md", "Review the workflow-composed task target.\n");
    write("tasks/no-inputs-v4.yml", ["version: 4", "name: No declared inputs", "uses: commands/review", ""].join("\n"));
    writeWorkflow("case", [
      `      - id: ${STEP_ID}`,
      "        uses: tasks/no-inputs-v4",
      "        with:",
      "          scope: all",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await captureRejection("workflows/case");
    expect(error).toBeInstanceOf(UsageError);
    if (!(error instanceof UsageError)) return;
    expect(error.code).toBe("COMPOSITION_INVALID");
    expect(error.message).toContain("tasks/no-inputs-v4");
    expect(error.message.toLowerCase()).toContain("no inputs");
  });

  test("with: on a uses: commands/<ref> step is rejected COMPOSITION_INVALID — a command ref is not a binding surface", async () => {
    write("commands/other.md", "Some other command.\n");
    writeWorkflow("case", [
      `      - id: ${STEP_ID}`,
      "        uses: commands/other",
      "        with:",
      "          note: hello",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await captureRejection("workflows/case");
    expect(error).toBeInstanceOf(UsageError);
    if (!(error instanceof UsageError)) return;
    expect(error.code).toBe("COMPOSITION_INVALID");
    expect(error.message).toContain("commands/other");
    expect(error.message.toLowerCase()).toContain("not a binding surface");
  });

  test("with: on a uses: scripts/<ref> step is rejected COMPOSITION_INVALID — a script ref is not a binding surface", async () => {
    write("scripts/build.sh", "#!/bin/sh\nprintf built\n");
    writeWorkflow("case", [
      `      - id: ${STEP_ID}`,
      "        uses: scripts/build.sh",
      "        with:",
      "          note: hello",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await captureRejection("workflows/case");
    expect(error).toBeInstanceOf(UsageError);
    if (!(error instanceof UsageError)) return;
    expect(error.code).toBe("COMPOSITION_INVALID");
    expect(error.message).toContain("scripts/build.sh");
    expect(error.message.toLowerCase()).toContain("not a binding surface");
  });
});

describe("compile-time — structured with: values are a task/workflow binding surface only", () => {
  function compileStep(uses: string, withLines: string[]) {
    return compileWorkflowSource(
      [
        "name: Binding scope",
        "on: { workflow_dispatch: null }",
        "jobs:",
        "  main:",
        "    runs-on: [self-hosted]",
        "    steps:",
        `      - id: ${STEP_ID}`,
        `        uses: ${uses}`,
        "        with:",
        ...withLines,
        "",
      ].join("\n"),
      { path: "workflows/binding-scope.yml" },
    );
  }

  test("a ${{ … }} expression nested inside a with: value on a task step is rejected", () => {
    const result = compileStep(TASK_REF, ["          ticket: ABC-1", '          meta: { note: "${{ params.x }}" }']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("unsupported-github-expression");
  });

  test.each([
    "akm/command",
    "commands/other",
    "scripts/build.sh",
  ])("a nested with: value on uses: %s is rejected as non-scalar", (uses) => {
    const result = compileStep(uses, ["          content: { nested: true }"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("scalar-required");
  });

  test("the identical nested with: shape on a uses: tasks/<ref> step compiles", () => {
    const result = compileStep(TASK_REF, ["          ticket: T-1", "          meta: { nested: true }"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.steps[0]?.spec?.with).toEqual({ ticket: "T-1", meta: { nested: true } });
  });
});

describe("freeze-time — no merge semantics across a two-level task -> workflow -> task composition chain", () => {
  /**
   * A chain, not two sibling steps of one workflow (two siblings prove
   * independence between unrelated call sites, but nothing about a CHAIN, i.e.
   * a task that is itself composed reachable from a step that composes a
   * further, inner task).
   *
   * The two-level shape modelled here is TASK (top-level, `akm task run
   * task-outer-chain`) -> workflow -> STEP composing an inner task. A v4
   * task's `uses: workflows/<ref>` delivers its effective inputs as the child
   * run's params, so task-outer-chain.yml below is a genuine TASK (no `with:`
   * — `with:` on a v4 document is legal only on `uses: akm/command`), not a
   * workflow step.
   *
   * task-outer-chain.yml is never executed by this file (freeze-time only):
   * freezing chain-child.yml (below) is a wholly separate operation from
   * preparing task-outer-chain.yml, and neither test needs the outer task to
   * run for that fact to be provable — chain-child.yml freezes identically
   * whether or not task-outer-chain.yml exists at all, which is precisely the
   * "nothing merges, forwards, or shadows" claim B-29 makes.
   */
  function writeChainFixtures(): void {
    write("commands/review.md", "Review the workflow-composed task target.\n");
    write(
      "tasks/task-outer-chain.yml",
      [
        "version: 4",
        "name: outer chain task",
        "uses: workflows/chain-child",
        "inputs:",
        "  scope:",
        "    type: string",
        "    default: outer-default",
        "",
      ].join("\n"),
    );
    write(
      "tasks/task-inner-chain.yml",
      [
        "version: 4",
        "name: inner chain task",
        "uses: commands/review",
        "inputs:",
        "  scope:",
        "    type: string",
        "    default: inner-default",
        "",
      ].join("\n"),
    );
  }

  test("the inner task's frozen binding carries its OWN declared default — the outer task's default for the identical input name never reaches it", async () => {
    writeChainFixtures();
    // No with: at all on "inner" — the point is that task-inner-chain's OWN
    // default is what freezes, with nothing from task-outer-chain.yml (which
    // this workflow's freeze never reads) to merge, forward, or shadow it.
    writeWorkflow("chain-child", ["      - id: inner", "        uses: tasks/task-inner-chain"]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const started = await startWorkflowRun("workflows/chain-child");
    const row = await planRow(started.run.id);
    const plan = decodeWorkflowPlan(JSON.parse(row?.plan_json ?? "null"));

    expect(frozenInputBindings(stepTarget(plan, 0))).toEqual([
      { kind: "literal", name: "scope", value: "inner-default" },
    ]);
  });

  test("a {from: params.<name>} reference on the inner step resolves against the CHILD workflow's own declared params, never the outer task's declared inputs, even when the names coincide", async () => {
    writeChainFixtures();
    // "scope" is the exact name task-outer-chain.yml declares, and — were
    // the outer task actually run — the exact param name its effective
    // inputs would populate on THIS workflow's run. The freeze-time structural
    // check for a `param` arm consults only the workflow CURRENTLY being
    // frozen's own paramSchemas — and chain-child-ref.yml, being GitHub-shaped
    // YAML, has no params: authoring surface at all — so this reference is
    // rejected as undeclared, proving the check never reaches past this
    // workflow's own (here, empty) declared params to the outer task's
    // declared input names, name coincidence notwithstanding.
    writeWorkflow("chain-child-ref", [
      "      - id: inner",
      "        uses: tasks/task-inner-chain",
      "        with:",
      "          scope:",
      "            from: params.scope",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await expectInputBindingInvalid("workflows/chain-child-ref");
    expect(error.message).toContain("with.scope");
    expect(error.message.toLowerCase()).toContain("declared");
    expect(error.message.toLowerCase()).toContain("param");
    await expectNoRunRowWritten();
  });
});

describe("a task-wrapped workflow target now composes to a child-workflow target", () => {
  /**
   * A version: 4 task step whose OWN target is `uses: workflows/<ref>` freezes
   * to a `{kind: "child-workflow", via: "task"}` target (routed to the ONE
   * childWorkflowDispatch resolver), `taskRef` naming the composing task's
   * qualified ref, and the task's effective inputs (its declared defaults,
   * overridden by any authored `with:`) become the child's params via
   * `inputBindings` (the SAME `freezeTaskInputBindings` normalizer, re-bound
   * against the child's own declared `params:`). `workflows/inner` therefore
   * declares a `scope` param (in the markdown-frontmatter authoring surface,
   * which — unlike GitHub-YAML — has one) matching `tasks/nested-v4.yml`'s
   * declared `scope` input, so the re-bind has a real contract to bind
   * against.
   */
  function writeNestedFixtures(): void {
    write(
      "workflows/inner.md",
      [
        "---",
        "type: workflow",
        "params:",
        "  scope: { type: string }",
        "steps:",
        "  - id: work",
        "---",
        "",
        "## work",
        "",
        "Do inner work.",
        "",
      ].join("\n"),
    );
    write(
      "tasks/nested-v4.yml",
      [
        "version: 4",
        "name: Nested workflow target v4",
        "uses: workflows/inner",
        "inputs:",
        "  scope:",
        "    type: string",
        "    default: changed",
        "",
      ].join("\n"),
    );
  }

  test("without an authored with:, a version: 4 task step whose target is uses: workflows/<ref> freezes to a child-workflow target carrying the task's declared default as the child's param", async () => {
    writeNestedFixtures();
    writeWorkflow("nested-no-with", [`      - id: ${STEP_ID}`, "        uses: tasks/nested-v4"]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const started = await startWorkflowRun("workflows/nested-no-with");
    const row = await planRow(started.run.id);
    const plan = decodeWorkflowPlan(JSON.parse(row?.plan_json ?? "null"));
    const target = stepTarget(plan, 0);

    expect(target).toMatchObject({
      kind: "child-workflow",
      via: "task",
      taskRef: expect.stringContaining("tasks/nested-v4"),
    });
    expect(frozenInputBindings(target)).toEqual([{ kind: "literal", name: "scope", value: "changed" }]);
  });

  test("WITH an authored with: that validly binds the target's declared input, the SAME version: 4 task step freezes to a child-workflow target carrying the bound value — the former nested-workflow guard no longer fires", async () => {
    writeNestedFixtures();
    writeWorkflow("nested-with-with", [
      `      - id: ${STEP_ID}`,
      "        uses: tasks/nested-v4",
      "        with:",
      "          scope: urgent",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const started = await startWorkflowRun("workflows/nested-with-with");
    const row = await planRow(started.run.id);
    const plan = decodeWorkflowPlan(JSON.parse(row?.plan_json ?? "null"));
    const target = stepTarget(plan, 0);

    expect(target).toMatchObject({
      kind: "child-workflow",
      via: "task",
      taskRef: expect.stringContaining("tasks/nested-v4"),
    });
    // The bound input reaches the child as an inputBindings entry: the authored
    // with.scope overrides the task's declared default.
    expect(frozenInputBindings(target)).toEqual([{ kind: "literal", name: "scope", value: "urgent" }]);
  });
});

describe("freeze-time — hash coverage: a changed binding changes the unit input hash", () => {
  /** The single step's content-derived input hash, computed the SAME pure way the engine does. */
  function unitHash(
    plan: ReturnType<typeof decodeWorkflowPlan>,
    runId: string,
    stepOutputs: Record<string, unknown> = {},
  ) {
    const computed = computeStepWorkList(plan.steps[plan.steps.length - 1]!, { runId, params: {}, stepOutputs });
    if (!computed.ok) throw new Error(`computeStepWorkList failed: ${computed.error}`);
    return computed.list.units[0]!.inputHash;
  }

  test("changing a literal binding's value changes the unit input hash", async () => {
    writeCentralTaskFixture();
    writeWorkflow("case-a", [
      `      - id: ${STEP_ID}`,
      `        uses: ${TASK_REF}`,
      "        with:",
      "          ticket: T-1",
    ]);
    writeWorkflow("case-b", [
      `      - id: ${STEP_ID}`,
      `        uses: ${TASK_REF}`,
      "        with:",
      "          ticket: T-2",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const runA = await startWorkflowRun("workflows/case-a");
    const runB = await startWorkflowRun("workflows/case-b");
    const planA = decodeWorkflowPlan(JSON.parse((await planRow(runA.run.id))?.plan_json ?? "null"));
    const planB = decodeWorkflowPlan(JSON.parse((await planRow(runB.run.id))?.plan_json ?? "null"));

    // Computed TWO ways (once per frozen plan) and compared.
    expect(unitHash(planA, runA.run.id)).not.toBe(unitHash(planB, runB.run.id));
  });

  test("changing a reference binding's from path changes the unit input hash", async () => {
    writeCentralTaskFixture();
    const collectStep = [
      "      - id: collect",
      "        uses: akm/command",
      "        with:",
      "          content: Collect data.",
    ];
    writeWorkflow("case-a", [
      ...collectStep,
      `      - id: ${STEP_ID}`,
      `        uses: ${TASK_REF}`,
      "        with:",
      "          ticket: T-1",
      "          files:",
      "            from: steps.collect.output.a",
    ]);
    writeWorkflow("case-b", [
      ...collectStep,
      `      - id: ${STEP_ID}`,
      `        uses: ${TASK_REF}`,
      "        with:",
      "          ticket: T-1",
      "          files:",
      "            from: steps.collect.output.b",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const runA = await startWorkflowRun("workflows/case-a");
    const runB = await startWorkflowRun("workflows/case-b");
    const planA = decodeWorkflowPlan(JSON.parse((await planRow(runA.run.id))?.plan_json ?? "null"));
    const planB = decodeWorkflowPlan(JSON.parse((await planRow(runB.run.id))?.plan_json ?? "null"));

    // Hand-built stepOutputs (chaos.test.ts / gate-artifacts.test.ts's own
    // pattern) so the reference resolves successfully on BOTH plans without
    // needing "collect" to actually execute.
    const stepOutputs = { collect: { a: ["fileA"], b: ["fileB"] } };
    expect(unitHash(planA, runA.run.id, stepOutputs)).not.toBe(unitHash(planB, runB.run.id, stepOutputs));
  });

  test("hashVersion 7: changing a reference binding's RESOLVED value — same from path, changed upstream output — changes the unit input hash; an unchanged value keeps it byte-stable", async () => {
    // The case B-41/B-42 do not cover: both of those vary the FROZEN binding (a
    // literal's value, a reference's from path), which lives inside frozenTarget.
    // Here ONE frozen plan is hashed against two different upstream outputs, so
    // the only thing that changes is what `from: steps.collect.output.a` RESOLVES
    // to — exactly the value the unit actually receives (prompt "## Task inputs"
    // block / AKM_TASK_INPUTS / childParams). The taskInputs preimage field makes
    // the two hashes differ, so the recorded (informational) input hash tells the
    // two asks apart.
    writeCentralTaskFixture();
    writeWorkflow("case-resolved", [
      "      - id: collect",
      "        uses: akm/command",
      "        with:",
      "          content: Collect data.",
      `      - id: ${STEP_ID}`,
      `        uses: ${TASK_REF}`,
      "        with:",
      "          ticket: T-1",
      "          files:",
      "            from: steps.collect.output.a",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const run = await startWorkflowRun("workflows/case-resolved");
    const plan = decodeWorkflowPlan(JSON.parse((await planRow(run.run.id))?.plan_json ?? "null"));

    const hashOne = unitHash(plan, run.run.id, { collect: { a: ["fileA"] } });
    const hashOneAgain = unitHash(plan, run.run.id, { collect: { a: ["fileA"] } });
    const hashTwo = unitHash(plan, run.run.id, { collect: { a: ["fileB"] } });

    // Unchanged upstream value ⇒ byte-stable hash: a resume that recomputes
    // the work list against identical journaled evidence still reuses.
    expect(hashOneAgain).toBe(hashOne);
    // Changed RESOLVED value ⇒ different hash — a materially different ask.
    expect(hashTwo).not.toBe(hashOne);
  });
});
