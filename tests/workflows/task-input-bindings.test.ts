// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `\${{ … }}` is
// tested here as literal, hostile content a nested with: value must still
// reject (B-27) — never workflow expression grammar (spec §2.3), matching
// tests/integration/workflows/chaos.test.ts's own directive/rationale.

/**
 * P2b Lane A — FREEZE-TIME `with:` bindings on `uses: tasks/<ref>` workflow
 * steps (docs/plans/specs/p2b-input-bindings.md §2.2, §3.2-§3.5, §7 F-A2/F-A3
 * B-N1..B-N4 not applicable here — this file is the freeze matrix only;
 * pre-attempt resolution lives in
 * tests/integration/workflows/task-binding-resolution.test.ts).
 *
 * Sandbox/freeze pattern follows tests/workflows/with-rejection.test.ts and
 * tests/workflows/task-source-v4-deferral.test.ts (withIsolatedAkmStorage +
 * writeWorkflowTestConfig + akmIndex + startWorkflowRun +
 * decodeWorkflowPlanV4).
 *
 * RED TODAY, for two independent, already-understood reasons the spec names
 * explicitly (A-N6, A-N3):
 *
 *   1. LC-N1 (p2a §1.5): taskDispatch still peeks a target task source's
 *      `version` and throws UsageError/TASK_SOURCE_INVALID for ANY `version:
 *      4` task composed from a workflow step, `with:` or not. Every fixture
 *      below composes a version: 4 task, so every test in this file is RED
 *      until A-N6's deferral lift lands.
 *   2. P1a's fail-closed guard (source-freeze-v4.ts:226) still rejects EVERY
 *      `with:` on a `uses: tasks/<ref>` step unconditionally with
 *      UsageError/COMPOSITION_INVALID ("task-call inputs are not supported
 *      yet"), regardless of shape or the target's declared inputs.
 *   3. `scalarRecord` (source-ir/schema.ts:389) still rejects ANY non-scalar
 *      `with:` value on ANY target, including a task step — so every fixture
 *      using a nested `{from: ...}` or object-shaped with: value is
 *      additionally RED at COMPILE time (a plain `Error`, wrapped into
 *      UsageError/INVALID_FLAG_VALUE by resolveWorkflowSourceV4) until A-N3's
 *      task-scoped decode widening lands.
 *
 * Every test asserts the state Implement must produce; none of these are RED
 * because a referenced API fails to TYPE-CHECK — `FrozenWorkflowTarget`'s
 * `inputBindings` field (A-N7) is the ONE not-yet-existing symbol accessed
 * here, isolated behind the single `frozenInputBindings` helper below so
 * Implement removes ONE `@ts-expect-error` directive, not one per call site.
 *
 * Message text for every NEW `INPUT_BINDING_INVALID` rejection is authored by
 * this test file (the spec pins the FACTS a message must carry — B-11..B-18 —
 * never exact bytes for these, unlike the LC-N1/COMPOSITION_INVALID strings
 * quoted verbatim elsewhere). Assertions below therefore use `.toContain(...)`
 * against the pinned facts rather than `.toBe(...)` against invented prose,
 * so Implement is free to choose its own exact wording as long as the named
 * facts (step id, target ref, offending key, declared-name set, schema-error
 * detail, "earlier step" / "declared workflow param") are present.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../src/core/config/config";
import { UsageError } from "../../src/core/errors";
import type { TaskInputBinding } from "../../src/execution/input-contract";
import { akmIndex } from "../../src/indexer/indexer";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { computeStepWorkList } from "../../src/workflows/exec/step-work";
import { decodeWorkflowPlanV4, type FrozenWorkflowTarget } from "../../src/workflows/ir/schema-v4";
import { listWorkflowRuns, startWorkflowRun } from "../../src/workflows/runtime/runs";
import { decodeWorkflowSourceIrV1, type WorkflowSourceIrV1 } from "../../src/workflows/source-ir/schema";
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

function stepTarget(plan: ReturnType<typeof decodeWorkflowPlanV4>, index: number): FrozenWorkflowTarget | undefined {
  const root = plan.steps[index]?.root;
  if (!root) return undefined;
  return root.kind === "map" ? root.template.frozenTarget : root.frozenTarget;
}

/**
 * A-N7: `FrozenWorkflowTarget` gains an optional `inputBindings` field in
 * Implement. Isolated here so ONE directive is removed, not one per call
 * site, once schema-v4.ts's three target interfaces grow the field.
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

describe("P2b freeze-time — literal and reference bindings normalize into inputBindings (B-10, B-14, B-19, B-20)", () => {
  test("B-10/B-19/B-20: a literal with: value freezes alongside declared defaults, sorted by name; an unsupplied optional input with no default is absent", async () => {
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
    const plan = decodeWorkflowPlanV4(JSON.parse(row?.plan_json ?? "null"));
    const target = stepTarget(plan, 0);
    expect(target?.kind).toBe("command");

    // scope/strict get their declared defaults (B-19); files/meta stay absent
    // (B-20: optional, no default, not supplied) — sorted by name.
    expect(frozenInputBindings(target)).toEqual([
      { kind: "literal", name: "scope", value: "changed" },
      { kind: "literal", name: "strict", value: true },
      { kind: "literal", name: "ticket", value: "ABC-1" },
    ]);
  });

  test("B-14: a {from: steps.<id>.output.<path>} with: value freezes to a kind:reference binding naming the parsed reference", async () => {
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
    const plan = decodeWorkflowPlanV4(JSON.parse(row?.plan_json ?? "null"));
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

describe("P2b freeze-time — hard rejections: INPUT_BINDING_INVALID (B-11, B-12, B-13)", () => {
  test("B-11: an unknown with: key is rejected, naming the step, the offending key, and the sorted declared set", async () => {
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

  test("B-12: a required input with no default, not supplied by with:, is rejected naming the missing input", async () => {
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

  test("B-13: a literal value violating its declared schema is rejected, path-rooted at with.<name>", async () => {
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

describe("P2b freeze-time — the {from} hard-fail band never falls back to a literal (B-15, B-16)", () => {
  test("B-15: {from} plus any other key is rejected, never reinterpreted as a literal object", async () => {
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

  test('B-16a: {from: "not a reference"} is rejected with parseReference\'s own message, never reinterpreted as a literal', async () => {
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

  test("B-16b: {from: 42} (a non-string from) is rejected structurally, never reinterpreted as a literal", async () => {
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

  test('B-16c: {from: "steps.x"} (incomplete reference grammar) is rejected, never reinterpreted as a literal', async () => {
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

describe("P2b freeze-time — reference structural checks: earlier step, both grammar roots (B-17, B-18, A-N4)", () => {
  test("B-17a: a reference naming a LATER step is rejected — earlier means before this step in frozen order", async () => {
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

  test("B-17b: a self-reference is rejected", async () => {
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

  test("B-17c: a reference naming a nonexistent step id is rejected", async () => {
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

  test("B-18: a {from: params.<undeclared>} reference is rejected, naming the workflow's declared params", async () => {
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

describe("P2b freeze-time — COMPOSITION_INVALID narrows to no-declared-inputs, grows to commands/scripts (B-21, B-22, B-23, A-N5)", () => {
  test("B-21: with: on a version: 4 task target that declares no inputs: at all is rejected COMPOSITION_INVALID", async () => {
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

  test("B-22: with: on a uses: commands/<ref> step is rejected COMPOSITION_INVALID — a command ref is not a binding surface", async () => {
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

  test("B-23: with: on a uses: scripts/<ref> step is rejected COMPOSITION_INVALID — a script ref is not a binding surface", async () => {
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

describe("P2b freeze-time — decode widens for task targets only; the expression guard recurses (B-27, A-N3)", () => {
  // NEITHER text front end can exercise this directly: github-yaml.ts:183-184's
  // `checkTree` rejects ANY `${{` occurrence ANYWHERE in a GH-YAML document at
  // PARSE time ("GitHub expressions and contexts are not supported."),
  // independent of, and unconditionally earlier than, the shared semantic
  // `rejectStepWithExpressions` guard this test targets — a GH-YAML fixture
  // would be RED for the wrong reason forever, even after A-N3 lands. The
  // Markdown front end has no such pre-scan, but its OWN step grammar has no
  // `uses`/`with` fields at all (allowed step keys: id, unit, map, route,
  // inputs, output, gate) — composition is a GitHub-shaped-YAML-only
  // surface. `decodeWorkflowSourceIrV1` is the shared semantic layer BOTH
  // front ends funnel through (compile.ts's `compileGithubWorkflowSource` /
  // `compileMarkdownWorkflowSource`), and it is itself exported and callable
  // directly on a hand-built `WorkflowSourceIrV1` — exactly the pattern
  // tests/workflows/source-ir-contract.test.ts's own "strict source IR
  // decoder" suite already uses (`replaceOnlyDecodedStep` +
  // `decodeWorkflowSourceIrV1(ir)`, e.g. its `${{ github.ref }}` "uses"
  // expression-rejection case) to reach this exact semantic layer without
  // going through either text parser's own, unrelated restrictions.
  test("B-27: a ${{ … }} expression nested inside a with: value on a task step is rejected (the guard now recurses)", () => {
    const span = { path: "x.yml", start: 1, end: 9 };
    const ir: WorkflowSourceIrV1 = {
      sourceIrVersion: 1,
      name: "B-27 fixture",
      triggers: [{ kind: "workflow_dispatch", source: span }],
      jobs: [
        {
          id: "main",
          needs: [],
          steps: [
            {
              id: STEP_ID,
              uses: TASK_REF,
              with: {
                ticket: "ABC-1",
                meta: { note: "${{ params.x }}" },
              },
              source: span,
            },
          ],
          source: span,
        },
      ],
      source: span,
    };

    expect(() => decodeWorkflowSourceIrV1(ir)).toThrow(/step dispatch with\.meta contains an unsupported expression/);
  });

  // (P2b test-review finding #2) B-27 above pins that the widened decode
  // still rejects a NESTED expression — on its own that does not prove the
  // widening is TASK-SCOPED, since an implementation that relaxes
  // scalarRecord for EVERY uses: target would pass B-27 too (a nested
  // expression is still caught by rejectStepWithExpressions regardless of
  // which targets scalarRecord itself now skips). These four siblings pin
  // the actual scope boundary directly: akm/command, commands/<ref>, and
  // scripts/<ref> are UNAFFECTED (byte-identical rejection); only a
  // tasks/<ref> step's decode widens. This authors F-A2's re-scoped
  // assertion HERE, in the red commit, rather than leaving the only coverage
  // inside tests/workflows/characterization-with-drop.test.ts:98 — the very
  // test F-A2 edits during Implement (its tasks/x arm is REMOVED there; this
  // describe is the independent pin that removal does not leave the
  // task-scoping fact unpinned).
  //
  // Untyped Record<string, unknown> fixtures (rather than this file's own
  // strictly-typed WorkflowSourceIrV1 literal above) deliberately mirror
  // characterization-with-drop.test.ts's OWN `baseIr`/step shape: `with`'s
  // widened Record<string, unknown> type (A-N3) is exactly what is NOT yet
  // true for these three preserved targets, so building them through a typed
  // literal would need its own `@ts-expect-error` per call site for no
  // benefit — decodeWorkflowSourceIrV1 itself accepts `unknown`.
  function bareSpan() {
    return { path: "x.yml", start: 1, end: 9 };
  }
  function bareIr(step: Record<string, unknown>): unknown {
    return {
      sourceIrVersion: 1,
      name: "B-26/B-25 task-scoping fixture",
      triggers: [{ kind: "workflow_dispatch", source: bareSpan() }],
      jobs: [{ id: "main", needs: [], steps: [step], source: bareSpan() }],
      source: bareSpan(),
    };
  }

  test("B-26: a nested with: value on uses: akm/command is UNAFFECTED by the task-scoped widening, byte-identical (verified: validateWorkflowBuiltinCommand's OWN structural check governs this target — scalarRecord's 'must be a scalar' message is unreachable here, before or after A-N3)", () => {
    const step = {
      id: STEP_ID,
      uses: "akm/command",
      commandMode: "literal",
      with: { content: { nested: true } },
      source: bareSpan(),
    };
    // Deliberately NOT /must be a scalar/: akm/command's with: is owned by
    // validateWorkflowBuiltinCommand -> parseBuiltinCommandAction
    // (schema.ts:362-374; src/commands/command/builtin-action.ts), which
    // runs BEFORE scalarRecord in validateStep and rejects a non-string
    // content with ITS OWN message ("Built-in command action with.content
    // must be a string.") — every with: shape for this target either
    // satisfies parseBuiltinCommandAction's own field/type checks (in which
    // case the recognized fields are already scalar, so scalarRecord passes
    // too) or fails there first, so scalarRecord's message can never surface
    // for uses: akm/command, independent of A-N3. Pinning this real,
    // byte-identical fact — not an inapplicable "must be a scalar" one — is
    // what proves this target is unaffected by the task-scoped relaxation.
    expect(() => decodeWorkflowSourceIrV1(bareIr(step))).toThrow(/with\.content must be a string/);
  });

  test("B-26: a nested with: value on uses: commands/<ref> is still rejected 'must be a scalar', byte-identical", () => {
    const step = { id: STEP_ID, uses: "commands/other", with: { note: { nested: true } }, source: bareSpan() };
    expect(() => decodeWorkflowSourceIrV1(bareIr(step))).toThrow(/step dispatch with\.note must be a scalar/);
  });

  test("B-26: a nested with: value on uses: scripts/<ref> is ALSO still rejected 'must be a scalar', byte-identical", () => {
    const step = { id: STEP_ID, uses: "scripts/build.sh", with: { note: { nested: true } }, source: bareSpan() };
    expect(() => decodeWorkflowSourceIrV1(bareIr(step))).toThrow(/step dispatch with\.note must be a scalar/);
  });

  test("B-25: the IDENTICAL nested with: SHAPE on a uses: tasks/<ref> step now decodes — scalarRecord's restriction narrows to non-task targets only", () => {
    const step = {
      id: STEP_ID,
      uses: TASK_REF,
      with: { ticket: "T-1", meta: { nested: true } },
      source: bareSpan(),
    };
    const decoded = decodeWorkflowSourceIrV1(bareIr(step)) as WorkflowSourceIrV1;
    expect(decoded.jobs[0]?.steps[0]?.with).toEqual({ ticket: "T-1", meta: { nested: true } });
  });
});

describe("P2b freeze-time — no merge semantics across a two-level task -> workflow -> task composition chain (B-29, A-N4)", () => {
  /**
   * §3.5's actual chain, not two sibling steps of one workflow (a prior
   * draft of this suite used two siblings — that proves independence
   * between unrelated call sites, but nothing about a CHAIN, i.e. a task
   * that is itself composed reachable from a step that composes a further,
   * inner task).
   *
   * The ONLY reachable two-level shape is TASK (top-level, `akm task run
   * task-outer-chain`) -> workflow -> STEP composing an inner task. A
   * WORKFLOW-STEP-driven chain — step composes task X, X's own `uses:` is
   * ALSO a workflow — is rejected on its first hop by taskDispatch's
   * existing nested-workflow guard (B-30); routing the top-level hop
   * through `akm task run` instead (§4.3, B-40: a v4 task's `uses:
   * workflows/<ref>` delivers its effective inputs as the child run's
   * params) is the only way around that guard, so task-outer-chain.yml
   * below is a genuine TASK (no `with:` — D2-N1: `with:` on a v4 document is
   * legal only on `uses: akm/command`), not a workflow step.
   *
   * task-outer-chain.yml is never executed by this file (freeze-time only —
   * pre-attempt/delivery lives in
   * tests/integration/workflows/task-binding-resolution.test.ts): freezing
   * chain-child.yml (below) is a wholly separate operation from preparing
   * task-outer-chain.yml, and neither test needs the outer task to run for
   * that fact to be provable — chain-child.yml freezes identically whether
   * or not task-outer-chain.yml exists at all, which is precisely the
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

  test("B-29: the inner task's frozen binding carries its OWN declared default — the outer task's default for the identical input name never reaches it", async () => {
    writeChainFixtures();
    // No with: at all on "inner" — the point is that task-inner-chain's OWN
    // default is what freezes, with nothing from task-outer-chain.yml (which
    // this workflow's freeze never reads) to merge, forward, or shadow it.
    writeWorkflow("chain-child", ["      - id: inner", "        uses: tasks/task-inner-chain"]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const started = await startWorkflowRun("workflows/chain-child");
    const row = await planRow(started.run.id);
    const plan = decodeWorkflowPlanV4(JSON.parse(row?.plan_json ?? "null"));

    expect(frozenInputBindings(stepTarget(plan, 0))).toEqual([
      { kind: "literal", name: "scope", value: "inner-default" },
    ]);
  });

  test("A-N4: a {from: params.<name>} reference on the inner step resolves against the CHILD workflow's own declared params, never the outer task's declared inputs, even when the names coincide", async () => {
    writeChainFixtures();
    // "scope" is the exact name task-outer-chain.yml declares, and — were
    // the outer task actually run — the exact param name its effective
    // inputs would populate on THIS workflow's run (§4.3, B-40). The
    // freeze-time structural check for a `param` arm (A-N4, §3.3 point 8)
    // consults only the workflow CURRENTLY being frozen's own paramSchemas
    // (schema-v4.ts:163) — and chain-child-ref.yml, being GitHub-shaped
    // YAML, has no params: authoring surface at all (github-yaml.ts's
    // ROOT_KEYS is exactly ["name", "on", "jobs"]) — so this reference is
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

describe("P3a — a task-wrapped workflow target now composes to a child-workflow target (B-30 FLIPS in P3a; row B-12/B-13)", () => {
  /**
   * P3a FLIP (docs/plans/specs/p3a-plan-v5-child-freeze.md §1.5/§6 F-B4, rows
   * B-12/B-13): before P3a, the nested-workflow guard's ONLY pin was
   * tests/workflows/characterization-classification.test.ts, reached through
   * the v3-only `parseTaskV3Yaml` / `prepareTaskV3Execution` path
   * (now src/workflows/freeze/targets/task.ts:116,149, A-N3's corrected line
   * numbers) — the SAME two call sites this file's B-30 block pinned for the
   * v4 arm once A-N6 lifted LC-N1. P3a REPLACES both throw sites with routing
   * to the ONE childWorkflowDispatch resolver (spec §4.2): a version: 4 task
   * step whose OWN target is `uses: workflows/<ref>` no longer rejects at
   * all — it freezes to a `{kind: "child-workflow", via: "task"}` target,
   * `taskRef` naming the composing task's qualified ref, and the task's
   * effective inputs (its declared defaults, overridden by any authored
   * `with:`) become the child's params via `inputBindings` (A-N8: the SAME
   * `freezeTaskInputBindings` normalizer, re-bound against the child's own
   * declared `params:`). `workflows/inner` therefore declares a `scope`
   * param (in the markdown-frontmatter authoring surface, which — unlike
   * GitHub-YAML — has one) matching `tasks/nested-v4.yml`'s declared
   * `scope` input, so the re-bind has a real contract to bind against.
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
    const plan = decodeWorkflowPlanV4(JSON.parse(row?.plan_json ?? "null"));
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
    const plan = decodeWorkflowPlanV4(JSON.parse(row?.plan_json ?? "null"));
    const target = stepTarget(plan, 0);

    expect(target).toMatchObject({
      kind: "child-workflow",
      via: "task",
      taskRef: expect.stringContaining("tasks/nested-v4"),
    });
    // The bound input reaches the child as an inputBindings entry (F-B4):
    // the authored with.scope overrides the task's declared default.
    expect(frozenInputBindings(target)).toEqual([{ kind: "literal", name: "scope", value: "urgent" }]);
  });
});

describe("P2b freeze-time — hash coverage: a changed binding changes the unit input hash (B-41, B-42, §1.1(4))", () => {
  /** The single step's content-derived input hash, computed the SAME pure way the engine does. */
  function unitHash(
    plan: ReturnType<typeof decodeWorkflowPlanV4>,
    runId: string,
    stepOutputs: Record<string, unknown> = {},
  ) {
    const computed = computeStepWorkList(plan.steps[plan.steps.length - 1]!, { runId, params: {}, stepOutputs });
    if (!computed.ok) throw new Error(`computeStepWorkList failed: ${computed.error}`);
    return computed.list.units[0]!.inputHash;
  }

  test("B-41: changing a literal binding's value changes the unit input hash", async () => {
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
    const planA = decodeWorkflowPlanV4(JSON.parse((await planRow(runA.run.id))?.plan_json ?? "null"));
    const planB = decodeWorkflowPlanV4(JSON.parse((await planRow(runB.run.id))?.plan_json ?? "null"));

    // Computed TWO ways (once per frozen plan) and compared, per §1.1(4).
    expect(unitHash(planA, runA.run.id)).not.toBe(unitHash(planB, runB.run.id));
  });

  test("B-42: changing a reference binding's from path changes the unit input hash", async () => {
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
    const planA = decodeWorkflowPlanV4(JSON.parse((await planRow(runA.run.id))?.plan_json ?? "null"));
    const planB = decodeWorkflowPlanV4(JSON.parse((await planRow(runB.run.id))?.plan_json ?? "null"));

    // Hand-built stepOutputs (chaos.test.ts / gate-artifacts.test.ts's own
    // pattern) so the reference resolves successfully on BOTH plans without
    // needing "collect" to actually execute.
    const stepOutputs = { collect: { a: ["fileA"], b: ["fileB"] } };
    expect(unitHash(planA, runA.run.id, stepOutputs)).not.toBe(unitHash(planB, runB.run.id, stepOutputs));
  });

  test("R-R15 (hashVersion 7): changing a reference binding's RESOLVED value — same from path, changed upstream output — changes the unit input hash; an unchanged value keeps it byte-stable", async () => {
    // The case B-41/B-42 could not cover: both of those vary the FROZEN
    // binding (a literal's value, a reference's from path), which lives
    // inside frozenTarget and was hashed all along. Here ONE frozen plan is
    // hashed against two different upstream outputs, so the only thing that
    // changes is what `from: steps.collect.output.a` RESOLVES to — exactly
    // the value the unit actually receives (prompt "## Task inputs" block /
    // AKM_TASK_INPUTS / childParams). Under hashVersion 6 these two hashes
    // were IDENTICAL (R-R15); the taskInputs preimage field makes them differ,
    // so the recorded (informational) input hash tells the two asks apart.
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
    const plan = decodeWorkflowPlanV4(JSON.parse((await planRow(run.run.id))?.plan_json ?? "null"));

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
