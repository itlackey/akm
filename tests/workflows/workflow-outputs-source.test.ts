// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Workflow `outputs:` — authoring grammar, compile-time reference checks, the
 * stored plan's decode, and freezing into the durable plan. Runtime resolution
 * lives in tests/integration/workflows/workflow-outputs-runtime.test.ts; the
 * freeze-time child-output reference check in
 * tests/workflows/child-output-references.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, resetConfigCache } from "../../src/core/config/config";
import { UsageError } from "../../src/core/errors";
import { akmIndex } from "../../src/indexer/indexer";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { checkWorkflowPlan, compileWorkflowSource, type WorkflowCompileResult } from "../../src/workflows/compile";
import { freezeWorkflow as freezeAsset } from "../../src/workflows/freeze/freeze";
import { canonicalPlanJson, computePlanHash } from "../../src/workflows/ir/plan-hash";
import { decodeWorkflowPlan } from "../../src/workflows/runtime/run-plan";
import { startWorkflowRun } from "../../src/workflows/runtime/runs";
import { loadWorkflowAsset } from "../../src/workflows/runtime/workflow-asset-loader";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";
import { freezeWorkflow, type WorkflowPlanFixture } from "../_helpers/workflow";

/** The name pattern outputs share with `params:` (`PROGRAM_PARAM_NAME_PATTERN`). */
const BAD_OUTPUT_NAME = "1bad";

/** A two-step markdown workflow with `collect` then `summarize`, plus arbitrary extra frontmatter lines. */
function twoStepDoc(extraFrontmatter: string[] = []): string {
  return [
    "---",
    "type: workflow",
    ...extraFrontmatter,
    "steps:",
    "  - id: collect",
    "  - id: summarize",
    "---",
    "",
    "## collect",
    "",
    "Collect the raw data.",
    "",
    "## summarize",
    "",
    "Summarize the results.",
    "",
  ].join("\n");
}

function compileSource(markdown: string, sourcePath = "workflows/test.md"): WorkflowCompileResult {
  return compileWorkflowSource(markdown, { path: sourcePath, workspaceRoot: "/tmp" });
}

/** Compile and run the cross-step reference check — pure, no config/engine resolution needed. */
function compileChecked(markdown: string, sourcePath = "workflows/test.md") {
  const compiled = compileSource(markdown, sourcePath);
  if (!compiled.ok) return compiled;
  return checkWorkflowPlan(compiled.plan);
}

function errorMessages(result: { ok: false; errors: readonly { message: string }[] }): string {
  return result.errors.map((e) => e.message).join("\n");
}

/** A loose structural view onto a decoded/compiled plan's not-yet-typed `outputs` field. See file header. */
interface DecodedOutputsView {
  readonly outputs?: Record<string, { readonly from: string; readonly schema?: Record<string, unknown> }>;
}

function outputsView(plan: unknown): DecodedOutputsView {
  return plan as unknown as DecodedOutputsView;
}

// ── B-03…B-10: pure grammar / compile-level checks (no sandbox needed) ─────

describe("outputs: — authoring grammar (B-03…B-09)", () => {
  test("B-03: an output name outside the param-name grammar fails, naming the key and the grammar", () => {
    const result = compileSource(twoStepDoc(["outputs:", `  ${BAD_OUTPUT_NAME}:`, "    from: steps.summarize.output"]));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(errorMessages(result)).toContain(BAD_OUTPUT_NAME);
  });

  test("B-05: from: that is not a valid steps.<id>.output(.<seg>)* reference fails through the reference grammar", () => {
    const result = compileSource(twoStepDoc(["outputs:", "  report:", "    from: not-a-valid-reference!!"]));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(errorMessages(result)).toContain("report");
  });

  test("B-06: from: naming a step id the document does not declare fails compile, naming the step and the output", () => {
    const result = compileChecked(twoStepDoc(["outputs:", "  report:", "    from: steps.ghost.output"]));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const messages = result.errors.map((e) => e.message).join("\n");
    expect(messages).toContain("ghost");
    expect(messages).toContain("report");
  });

  test("B-07: from: params.<name> is rejected — an output projects a step artifact, never a param", () => {
    const result = compileSource(
      twoStepDoc(["params:", "  scope: { type: string }", "outputs:", "  report:", "    from: params.scope"]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(errorMessages(result)).toContain("report");
  });

  test("B-08: a schema: outside the enforced JSON Schema subset fails, same message shape as a params: schema", () => {
    const result = compileSource(
      twoStepDoc([
        "outputs:",
        "  report:",
        "    from: steps.summarize.output",
        "    schema: { type: string, pattern: '^[a-z]+$' }",
      ]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(errorMessages(result)).toContain("report");
  });

  test("B-09: a schema: over the 256 KiB resource limit fails, naming the cap", () => {
    const hugeEnum = JSON.stringify(["x".repeat(300_000)]);
    const result = compileSource(
      twoStepDoc([
        "outputs:",
        "  report:",
        "    from: steps.summarize.output",
        `    schema: { type: string, enum: ${hugeEnum} }`,
      ]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(errorMessages(result)).toContain("report");
  });
});

describe("outputs: — a GitHub-shaped workflow cannot declare one (B-10, PRESERVE, B-N4)", () => {
  test("outputs: at the root of a .yml workflow is rejected by the existing closed ROOT_KEYS check", () => {
    const yaml = [
      "name: gh-outputs-rejected",
      "on:",
      "  workflow_dispatch:",
      "outputs:",
      "  report:",
      "    from: steps.summarize.output",
      "jobs:",
      "  main:",
      "    runs-on: [self-hosted]",
      "    steps:",
      "      - id: summarize",
      "        run: echo hi",
      "",
    ].join("\n");
    const result = compileSource(yaml, "workflows/gh-outputs-rejected.yml");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(errorMessages(result)).toContain("outputs");
  });
});

// ── B-11…B-17: decode-level integrity (hand-spliced JSON, no sandbox) ──────

const TWO_STEP_MD = twoStepDoc();

function splicedOutputs(plan: WorkflowPlanFixture, outputs: unknown): unknown {
  const clone = JSON.parse(canonicalPlanJson(plan)) as Record<string, unknown>;
  clone.outputs = outputs;
  return clone;
}

function expectDecodeUsageError(input: unknown): UsageError {
  let caught: unknown;
  try {
    decodeWorkflowPlan(input);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(UsageError);
  if (!(caught instanceof UsageError)) throw new Error("unreachable");
  return caught;
}

describe("outputs: — decoding a stored plan (B-11…B-16)", () => {
  test("B-11: a workflow declaring no outputs: has plan.outputs absent (never {}), and the hash is a stable function of the plan", () => {
    const plan = freezeWorkflow(TWO_STEP_MD, "workflows/no-outputs.md");
    expect(Object.hasOwn(plan, "outputs")).toBe(false);
    expect(outputsView(plan).outputs).toBeUndefined();
    const redecoded = decodeWorkflowPlan(JSON.parse(canonicalPlanJson(plan)));
    expect(computePlanHash(redecoded)).toBe(computePlanHash(plan));
  });

  test("B-12: decodeWorkflowPlan accepts a plan with a valid outputs entry", () => {
    const plan = freezeWorkflow(TWO_STEP_MD, "workflows/valid-outputs.md");
    const decoded = decodeWorkflowPlan(splicedOutputs(plan, { report: { from: "steps.summarize.output" } }));
    expect(outputsView(decoded).outputs?.report?.from).toBe("steps.summarize.output");
  });

  test("B-13…B-16: key order, extra keys, and an unknown step are the resolver's concern, not a decode refusal", () => {
    const plan = freezeWorkflow(TWO_STEP_MD, "workflows/tolerant-outputs.md");
    const decoded = decodeWorkflowPlan(
      splicedOutputs(plan, {
        zebra: { from: "steps.summarize.output", bogus: 1 },
        apple: { from: "steps.ghost.output" },
      }),
    );
    expect(Object.keys(outputsView(decoded).outputs ?? {})).toEqual(["zebra", "apple"]);
  });

  test("an outputs entry without a from: reference is a plan this akm cannot run", () => {
    const plan = freezeWorkflow(TWO_STEP_MD, "workflows/broken-outputs.md");
    expect(expectDecodeUsageError(splicedOutputs(plan, { report: "steps.summarize.output" })).message).toContain(
      "outputs.report",
    );
  });
});

// ── B-01, B-02, B-17: the full author -> compile -> freeze -> durable-plan
// ── pipeline (needs an isolated stash + index + config) ────────────────────

describe("outputs: — end-to-end freeze into the durable plan (B-01, B-02, B-17)", () => {
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

  async function frozenPlan(ref: string): Promise<unknown> {
    const started = await startWorkflowRun(ref);
    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    return decodeWorkflowPlan(JSON.parse(row?.plan_json ?? "null"));
  }

  test("B-01: outputs: {report: {from: steps.summarize.output}} parses, compiles, and freezes into plan.outputs", async () => {
    write("workflows/with-output.md", twoStepDoc(["outputs:", "  report:", "    from: steps.summarize.output"]));
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const decoded = await frozenPlan("workflows/with-output");
    expect(outputsView(decoded).outputs?.report?.from).toBe("steps.summarize.output");
  });

  test("B-02: outputs: with a schema: freezes the schema alongside from", async () => {
    write(
      "workflows/with-schema-output.md",
      twoStepDoc([
        "outputs:",
        "  changed_count:",
        "    from: steps.collect.output.total",
        "    schema: { type: integer, minimum: 0 }",
      ]),
    );
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const decoded = await frozenPlan("workflows/with-schema-output");
    expect(outputsView(decoded).outputs?.changed_count).toEqual({
      from: "steps.collect.output.total",
      schema: { type: "integer", minimum: 0 },
    });
  });

  test("B-17: two independent freezes of the same source declaring outputs: produce a byte-identical plan hash", async () => {
    write("workflows/stable-outputs.md", twoStepDoc(["outputs:", "  report:", "    from: steps.summarize.output"]));
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const asset = await loadWorkflowAsset("workflows/stable-outputs");
    const config = loadConfig();
    const first = await freezeAsset(asset, config);
    const second = await freezeAsset(asset, config);
    expect(computePlanHash(second.plan)).toBe(computePlanHash(first.plan));
    expect(canonicalPlanJson(second.plan)).toBe(canonicalPlanJson(first.plan));
  });

  test("regression: outputs: declared out of alphabetical author order still freezes, embedded in sorted order", async () => {
    write(
      "workflows/unsorted-outputs.md",
      twoStepDoc([
        "outputs:",
        "  zebra:",
        "    from: steps.summarize.output",
        "  alpha:",
        "    from: steps.collect.output",
      ]),
    );
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const decoded = await frozenPlan("workflows/unsorted-outputs");
    expect(Object.keys(outputsView(decoded).outputs ?? {})).toEqual(["alpha", "zebra"]);
  });
});
