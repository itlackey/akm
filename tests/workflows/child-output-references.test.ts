// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P3b Lane B TESTS — the freeze-time child-output reference check (spec
 * docs/plans/specs/p3b-child-executor.md §4.4, rows B-28…B-32; named in §7's
 * new-suites table as this file). Exercises the observable effect of the
 * not-yet-existing `src/workflows/freeze/child-output-references.ts`
 * (`assertChildOutputReferences`) through the real, already-existing freeze
 * pipeline — never a direct import of that module — so this file needs no
 * `@ts-expect-error` directive.
 *
 * Authoring note: a GitHub-shaped step schema (`STEP_KEYS`,
 * `src/workflows/source-ir/github-yaml.ts`) has no `inputs:` key at all — only
 * a Markdown unit step can declare `inputs:`, and Markdown cannot author a
 * `uses:` step (B-N4). So the "parent step [that] reads steps.<child>.output…"
 * §4.4 describes is authored here as a SECOND composing step's `with: {name:
 * {from: "steps.<child>.output…"}}` — a `reference`-kind `inputBindings[].from`
 * entry, the OTHER surface §4.4 explicitly names. That step targets a v4 TASK
 * wrapping an ordinary command (`tasks/consume-task`, declaring one input
 * `note`) — reusing P2b's already-frozen task-binding machinery
 * (`src/workflows/freeze/task-bindings.ts`), which validates a reference's
 * SYNTAX and that it names an earlier step, but not what property that step's
 * output actually carries. That gap is exactly what the new freeze-time check
 * fills.
 *
 * RED phase: rows B-28…B-30 also depend on the child declaring `outputs:`
 * (B-28's declared child, B-29's declared child) — since `outputs:` frontmatter
 * is not parseable at all yet (see
 * tests/workflows/workflow-outputs-source.test.ts), those two additionally
 * fail today for that reason; B-30…B-32 need no `outputs:` declaration at all,
 * so they isolate the NEW freeze-time check cleanly (B-30/B-31 are
 * `COMPOSITION_INVALID`, B-32 is a childless-reference regression pin, and
 * B-31 pins that only the first segment is checked — see its own comment for
 * why it is written as an acceptance rather than a strict red assertion).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../src/core/config/config";
import { UsageError } from "../../src/core/errors";
import { akmIndex } from "../../src/indexer/indexer";
import { listWorkflowRuns, startWorkflowRun } from "../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";

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

/** A GitHub-shaped parent workflow with the given pre-indented `steps:` entries (mirrors tests/workflows/plan-v5-schema.test.ts). */
function writeParent(name: string, stepLines: readonly string[]): void {
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

function writeNoopCommand(): void {
  write("commands/noop.md", "Do nothing.\n");
}

function writeConsumeTask(): void {
  write(
    "tasks/consume-task.yml",
    ["version: 4", "inputs:", "  note:", "    type: string", "uses: commands/noop", ""].join("\n"),
  );
}

/** A leaf child workflow declaring outputs: { report: { from: steps.work.output } }. RED until outputs: parses. */
function writeChildWithOutputs(name: string): void {
  write(
    `workflows/${name}.md`,
    [
      "---",
      "type: workflow",
      "outputs:",
      "  report:",
      "    from: steps.work.output",
      "steps:",
      "  - id: work",
      "---",
      "",
      "## work",
      "",
      "Do the work.",
      "",
    ].join("\n"),
  );
}

/** A leaf child workflow declaring no outputs: at all — exports {runId, status} by default. */
function writeChildNoOutputs(name: string): void {
  write(
    `workflows/${name}.md`,
    ["---", "type: workflow", "steps:", "  - id: work", "---", "", "## work", "", "Do the work.", ""].join("\n"),
  );
}

/** The "consume" step: a task-wrapped composing step whose with.note is a reference into `fromPath`. */
function consumeStepLines(fromPath: string): string[] {
  return [
    "      - id: consume",
    "        uses: tasks/consume-task",
    "        with:",
    "          note:",
    `            from: ${fromPath}`,
  ];
}

async function captureRejection(ref: string): Promise<unknown> {
  try {
    await startWorkflowRun(ref);
    return undefined;
  } catch (error) {
    return error;
  }
}

async function expectCompositionInvalid(ref: string): Promise<UsageError> {
  const error = await captureRejection(ref);
  expect(error).toBeInstanceOf(UsageError);
  if (!(error instanceof UsageError)) throw new Error("unreachable");
  expect(error.code).toBe("COMPOSITION_INVALID");
  return error;
}

/** B-25-style guard: a rejected freeze must not have published a run row. */
async function expectNoRunRowWritten(): Promise<void> {
  const { runs } = await listWorkflowRuns();
  expect(runs).toHaveLength(0);
}

describe("a reference into a declared child output freezes (B-28)", () => {
  test("steps.<child>.output.<declaredName> freezes when the child declares that output", async () => {
    writeNoopCommand();
    writeConsumeTask();
    writeChildWithOutputs("child-with-report");
    writeParent("consume-declared-output", [
      "      - id: dispatch",
      "        uses: workflows/child-with-report",
      ...consumeStepLines("steps.dispatch.output.report"),
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const started = await startWorkflowRun("workflows/consume-declared-output");
    expect(started.run.id).toBeTruthy();
  });
});

describe("a reference into an undeclared child output fails at freeze (B-29)", () => {
  test("steps.<child>.output.<bogus> fails COMPOSITION_INVALID, naming the step, the child ref, the bad name, and the child's declared names", async () => {
    writeNoopCommand();
    writeConsumeTask();
    // The child's own ref must NOT contain "report" (the declared output
    // name) — otherwise the toContain("report") assertion below is trivially
    // satisfied by the ref assertion one line above it, without the message
    // actually enumerating the child's declared output names.
    writeChildWithOutputs("child-alpha");
    writeParent("consume-undeclared-output", [
      "      - id: dispatch",
      "        uses: workflows/child-alpha",
      ...consumeStepLines("steps.dispatch.output.bogus"),
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await expectCompositionInvalid("workflows/consume-undeclared-output");
    expect(error.message).toContain("consume");
    expect(error.message).toContain("child-alpha");
    expect(error.message).toContain("bogus");
    // Non-trivial only because "child-alpha" does not itself contain
    // "report" — this pins that the message enumerates the child's declared
    // output names, not just that it names the child ref.
    expect(error.message).toContain("report");
    await expectNoRunRowWritten();
  });
});

describe("a reference into a no-outputs child's non-{runId,status} name fails at freeze (B-30)", () => {
  test("steps.<child>.output.<bogus> fails COMPOSITION_INVALID when the child declares no outputs:, message pointing at outputs:", async () => {
    writeNoopCommand();
    writeConsumeTask();
    // The child's own ref must NOT contain "outputs" — otherwise the
    // toLowerCase().toContain("outputs") assertion below is trivially
    // satisfied by the ref assertion one line above it, without the message
    // actually pointing at the child's `outputs:` frontmatter.
    writeChildNoOutputs("child-bare");
    writeParent("consume-no-outputs-bogus", [
      "      - id: dispatch",
      "        uses: workflows/child-bare",
      ...consumeStepLines("steps.dispatch.output.bogus"),
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await expectCompositionInvalid("workflows/consume-no-outputs-bogus");
    expect(error.message).toContain("bogus");
    expect(error.message).toContain("child-bare");
    // Non-trivial only because "child-bare" does not itself contain
    // "outputs" — this pins that the message actually points at the child's
    // `outputs:` frontmatter, not just that it names the child ref.
    expect(error.message.toLowerCase()).toContain("outputs");
    // Positive pin for the spec §4.4 exact wording: a no-outputs child
    // exports only {runId, status}.
    expect(error.message).toContain("{runId, status}");
    await expectNoRunRowWritten();
  });

  test("steps.<child>.output.status (a default name) still freezes when the child declares no outputs:", async () => {
    writeNoopCommand();
    writeConsumeTask();
    writeChildNoOutputs("child-no-outputs-status");
    writeParent("consume-no-outputs-status", [
      "      - id: dispatch",
      "        uses: workflows/child-no-outputs-status",
      ...consumeStepLines("steps.dispatch.output.status"),
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const started = await startWorkflowRun("workflows/consume-no-outputs-status");
    expect(started.run.id).toBeTruthy();
  });
});

describe("freeze checks only the first path segment (B-31)", () => {
  test("steps.<child>.output.status.extra freezes — the freeze-time check does not walk past the first segment", async () => {
    // The default export is {runId, status}; "status" is a valid first
    // segment, so a deeper path is accepted at freeze even though "status" is
    // a plain string at run time and could never actually hold ".extra" — the
    // spec is explicit that only the FIRST segment is a freeze-time concern,
    // and everything past it resolves (and, if wrong, fails) at pre-attempt
    // through the existing, unchanged resolver. Exercising that pre-attempt
    // failure would require actually DRIVING the child (Lane A, not yet
    // wired), so this test is deliberately scoped to the freeze-time
    // guarantee alone.
    writeNoopCommand();
    writeConsumeTask();
    writeChildNoOutputs("child-deep-path");
    writeParent("consume-deep-path", [
      "      - id: dispatch",
      "        uses: workflows/child-deep-path",
      ...consumeStepLines("steps.dispatch.output.status.extra"),
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const started = await startWorkflowRun("workflows/consume-deep-path");
    expect(started.run.id).toBeTruthy();
  });
});

describe("a reference into a NON-child step's output is unaffected (B-32, PRESERVE)", () => {
  test("steps.<ordinaryTaskStep>.output.<anything> still freezes — the new check applies only to child-workflow targets", async () => {
    writeNoopCommand();
    writeConsumeTask();
    writeParent("consume-non-child", [
      "      - id: produce",
      "        uses: tasks/consume-task",
      "        with:",
      "          note: literal-value",
      ...consumeStepLines("steps.produce.output.anything"),
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const started = await startWorkflowRun("workflows/consume-non-child");
    expect(started.run.id).toBeTruthy();
  });
});
