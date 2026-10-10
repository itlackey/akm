// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pre-attempt resolution of a child step's `with:` bindings. Freeze-time
 * normalization lives in `child-workflow-freeze.test.ts`; this file starts
 * where that one ends: a real frozen plan whose child target already carries
 * `inputBindings`, exercised through `computeStepWorkList` — the pure function
 * the native executor calls immediately before `reserveUnitAttempt` — with
 * hand-built `stepOutputs`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../src/core/config/config";
import { akmIndex } from "../../src/indexer/indexer";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { runWorkflowSteps } from "../../src/workflows/exec/run-workflow";
import { computeStepWorkList, unitIdFor } from "../../src/workflows/exec/step-work";
import { decodeWorkflowPlan } from "../../src/workflows/runtime/run-plan";
import { startWorkflowRun } from "../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";

const STEP_ID = "dispatch";
const CHILD_REF = "workflows/review-child";

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

/** A parent with a prose `collect` step and a `dispatch` step running the child with the given `with:` lines. */
function writeParent(name: string, withLines: readonly string[]): void {
  write(
    `workflows/${name}.md`,
    [
      "---",
      "type: workflow",
      "steps:",
      "  - id: collect",
      `  - id: ${STEP_ID}`,
      "    unit:",
      `      workflow: ${CHILD_REF}`,
      "      with:",
      ...withLines.map((line) => `        ${line}`),
      "---",
      "",
      "## collect",
      "",
      "Collect a scope decision.",
      "",
      `## ${STEP_ID}`,
      "",
      "Run the child.",
      "",
    ].join("\n"),
  );
}

function writeChild(): void {
  write(
    `${CHILD_REF}.md`,
    [
      "---",
      "type: workflow",
      "params:",
      "  scope: { type: string, enum: [changed, all] }",
      "  ticket: { type: string }",
      "steps:",
      "  - id: work",
      "---",
      "",
      "## work",
      "",
      "Review the change.",
      "",
    ].join("\n"),
  );
}

async function frozenPlan(name: string) {
  await akmIndex({ stashDir: storage.stashDir, full: true });
  const started = await startWorkflowRun(`workflows/${name}`);
  const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
  return { runId: started.run.id, plan: decodeWorkflowPlan(JSON.parse(row?.plan_json ?? "null")) };
}

describe("a reference resolves successfully against a prior step's output", () => {
  test("computeStepWorkList succeeds and the child's params carry the resolved value", async () => {
    writeChild();
    writeParent("collect-dispatch", ["ticket: T-1", "scope: { from: steps.collect.output.scope }"]);
    const { runId, plan } = await frozenPlan("collect-dispatch");

    const computed = computeStepWorkList(plan.steps[1]!, {
      runId,
      params: {},
      stepOutputs: { collect: { scope: "all" } },
    });
    expect(computed.ok).toBe(true);
    if (!computed.ok) return;
    expect(computed.list.units).toHaveLength(1);
    // The resolved VALUE ("all", not the {from: ...} shape it was authored as)
    // is what the child run will be started with.
    expect(computed.list.units[0]?.childParams).toEqual({ ticket: "T-1", scope: "all" });
  });
});

describe("a resolved reference violating its declared schema fails before dispatch", () => {
  test("computeStepWorkList fails, naming the step, the input, the reference, and the schema error", async () => {
    writeChild();
    writeParent("collect-dispatch", ["ticket: T-1", "scope: { from: steps.collect.output.scope }"]);
    const { runId, plan } = await frozenPlan("collect-dispatch");

    // Same plan as the success case: only the prior step's output changes,
    // from "all" (valid) to "bogus" (violates scope's enum).
    const computed = computeStepWorkList(plan.steps[1]!, {
      runId,
      params: {},
      stepOutputs: { collect: { scope: "bogus" } },
    });
    expect(computed.ok).toBe(false);
    if (computed.ok) return;
    expect(computed.error).toContain(STEP_ID);
    expect(computed.error).toContain("scope");
    expect(computed.error).toContain("steps.collect.output.scope");
    expect(computed.error).toContain("is not one of");
    // The input name must not be doubled in the rendered path ("scope.scope").
    expect(computed.error).not.toContain("scope.scope");
  });

  test("the real engine never reserves a dispatch attempt for the failing unit — its attempt row set stays empty", async () => {
    writeChild();
    writeParent("attempt-gate", ["ticket: T-1", "scope: { from: steps.collect.output.definitely_missing_field }"]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const started = await startWorkflowRun("workflows/attempt-gate");
    const result = await runWorkflowSteps({
      target: started.run.id,
      summaryJudge: null,
      dispatcher: async () => ({ ok: true, text: "collected" }),
    });

    expect(result.run.status).toBe("failed");

    // "collect" DID get dispatched and journaled, so the attempt table is not
    // vacuously empty for some unrelated reason.
    const accounting = await withWorkflowRunsRepo((repo) => repo.getAttemptAccounting(started.run.id));
    expect(accounting.dispatchAttempts).toBe(1);

    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    const plan = decodeWorkflowPlan(JSON.parse(row?.plan_json ?? "null"));
    const dispatchRoot = plan.steps[1]!.root;
    if (!dispatchRoot) throw new Error("expected the dispatch step to have a root exec node");
    const dispatchUnitId = unitIdFor(dispatchRoot.id, undefined, false, true);
    const dispatchUnitAttempts = await withWorkflowRunsRepo((repo) =>
      repo.getUnitAttempts(started.run.id, dispatchUnitId),
    );
    expect(dispatchUnitAttempts).toHaveLength(0);
  });
});

describe("a reference that fails to resolve at all fails before dispatch", () => {
  test("computeStepWorkList fails, carrying resolveStepReference's own message when the referenced path is missing", async () => {
    writeChild();
    writeParent("collect-dispatch", ["ticket: T-1", "scope: { from: steps.collect.output.scope }"]);
    const { runId, plan } = await frozenPlan("collect-dispatch");

    // "collect" ran, but its output never had a "scope" property at all.
    const computed = computeStepWorkList(plan.steps[1]!, { runId, params: {}, stepOutputs: { collect: {} } });
    expect(computed.ok).toBe(false);
    if (computed.ok) return;
    expect(computed.error).toContain(`Step "${STEP_ID}"`);
    expect(computed.error).toContain('input "scope"');
    expect(computed.error).toContain("steps.collect.output.scope");
    expect(computed.error).toContain("failed to resolve");
    expect(computed.error).toContain("is missing");
  });
});

describe("a literal binding passes through unchanged, with no re-validation", () => {
  test("computeStepWorkList succeeds for a purely-literal binding set with no stepOutputs at all", async () => {
    writeChild();
    writeParent("literal-only", ["ticket: T-1"]);
    const { runId, plan } = await frozenPlan("literal-only");

    const computed = computeStepWorkList(plan.steps[1]!, { runId, params: {}, stepOutputs: {} });
    expect(computed.ok).toBe(true);
  });
});
