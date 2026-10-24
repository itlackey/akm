// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The fail-closed `with:` correction (rows B-01..B-05 in test names).
 *
 * A workflow step's `with:` on `uses: tasks/<ref>` binds a DECLARED input
 * contract (task-input-bindings.test.ts owns that behavior). `taskDispatch`,
 * before `resolveOwnedAsset`, throws `UsageError` code `COMPOSITION_INVALID`
 * when `source.with !== undefined` — of ANY shape, including `{}` — on a target
 * that declares NO inputs at all: such a `with:` must be rejected rather than
 * silently dropped at freeze. Every fixture below keeps its task with no
 * `inputs:` key on purpose: task source v4 makes `inputs:` optional and this
 * fixture simply never declares one, so "no declared inputs" stays true here
 * unconditionally, independent of any binding logic. The rejection message ends
 * "<ref> declares no inputs", kept consistent with
 * task-input-bindings.test.ts's B-21/B-22/B-23 "not a binding surface" /
 * "declares no inputs" phrasing; the message text this file pins is this
 * suite's OWN authored contract.
 *
 * Every other test in this file pins behavior the guard must NOT disturb
 * (decode acceptance, the without-`with:` freeze, and the `akm/command`
 * builtin's own `with:` consumption).
 *
 * Fixture: tests/fixtures/execution-contracts/workflows/rejected/
 * with-on-task-composition.yml, registered in that family's manifest.json (id
 * "with-on-task-composition"). Unlike its three siblings — which fail to
 * compile via compileGithubWorkflowSource — this one compiles cleanly and is
 * rejected only at freeze; see the manifest entry's "note" field and the first
 * describe block below.
 *
 * Sandbox/freeze pattern: withIsolatedAkmStorage + writeWorkflowTestConfig +
 * akmIndex + startWorkflowRun + withWorkflowRunsRepo + decodeWorkflowPlan.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../src/core/config/config";
import { UsageError } from "../../src/core/errors";
import { akmIndex } from "../../src/indexer/indexer";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { compileWorkflowSource } from "../../src/workflows/compile";
import type { FrozenWorkflowTarget } from "../../src/workflows/plan";
import { decodeWorkflowPlan } from "../../src/workflows/runtime/run-plan";
import { startWorkflowRun } from "../../src/workflows/runtime/runs";
import { EXECUTION_CONTRACT_FIXTURES } from "../_helpers/execution-contracts";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";

const WORKFLOWS_FIXTURES_ROOT = path.join(EXECUTION_CONTRACT_FIXTURES, "workflows");
const FIXTURE_ID = "with-on-task-composition";
const STEP_ID = "dispatch";
const TASK_REF = "tasks/nightly";
// The trailing clause names the actual reason this fixture's target rejects a
// with: — tasks/nightly declares no inputs: key, so it is a "no declared
// inputs" target regardless of task source version.
const COMPOSITION_INVALID_MESSAGE = `Workflow step ${STEP_ID} cannot pass with: to task target ${TASK_REF}; ${TASK_REF} declares no inputs.`;

interface RejectedFixtureEntry {
  readonly id: string;
  readonly file: string;
  readonly reasonCode: string;
}

interface WorkflowsManifestRejectedFragment {
  readonly rejected: readonly RejectedFixtureEntry[];
}

function readRejectedFixture(id: string): { entry: RejectedFixtureEntry; yaml: string } {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(WORKFLOWS_FIXTURES_ROOT, "manifest.json"), "utf8"),
  ) as WorkflowsManifestRejectedFragment;
  const entry = manifest.rejected.find((candidate) => candidate.id === id);
  if (!entry) {
    throw new Error(`workflows/manifest.json rejected[] is missing fixture id ${JSON.stringify(id)}`);
  }
  const yaml = fs.readFileSync(path.join(WORKFLOWS_FIXTURES_ROOT, entry.file), "utf8");
  return { entry, yaml };
}

describe("with-on-task-composition rejected fixture — registered, and accepted at decode/compile", () => {
  // The fixture family's manifest convention (id/file/reasonCode) is followed
  // even though this entry's reasonCode is a UsageError code rather than a
  // WorkflowSourceSemanticError code — see the manifest entry's "note" field for
  // why.
  test(`rejected/${FIXTURE_ID}.yml is registered in workflows/manifest.json with reasonCode COMPOSITION_INVALID`, () => {
    const { entry } = readRejectedFixture(FIXTURE_ID);
    expect(entry.file).toBe(`rejected/${FIXTURE_ID}.yml`);
    expect(entry.reasonCode).toBe("COMPOSITION_INVALID");
  });

  // Decode/compile accepts with: on every uses target; only taskDispatch's
  // freeze-time behavior rejects it.
  test("the fixture compiles cleanly via compileWorkflowSource — decode/compile is unaffected by P1a", () => {
    const { yaml } = readRejectedFixture(FIXTURE_ID);
    const result = compileWorkflowSource(yaml, { path: `workflows/rejected/${FIXTURE_ID}.yml` });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.steps[0]?.spec?.uses).toBe(TASK_REF);
    expect(result.plan.steps[0]?.spec?.with).toEqual({ scope: "all" });
  });
});

describe("P1a Lane A — with: on uses: tasks/<ref> rejects at freeze (COMPOSITION_INVALID)", () => {
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

  /** A real tasks/nightly.yml + commands/review.md backing TASK_REF, so a
   * rejection is the `with:` guard and not an unrelated missing-asset failure. */
  function writeTaskTarget(): void {
    write("commands/review.md", "Review the workflow-composed task target.\n");
    write("tasks/nightly.yml", ["version: 4", "uses: commands/review", 'schedule: "@daily"', ""].join("\n"));
  }

  async function planRow(runId: string) {
    return withWorkflowRunsRepo((repo) => repo.getRunById(runId));
  }

  function firstTarget(plan: ReturnType<typeof decodeWorkflowPlan>): FrozenWorkflowTarget | undefined {
    const root = plan.steps[0]?.root;
    if (!root) return undefined;
    return root.kind === "map" ? root.template.frozenTarget : root.frozenTarget;
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

  // B-02: taskDispatch rejects a `with:` on a target that declares no inputs.
  test("B-02: a task-composed step with with: rejects at freeze with UsageError COMPOSITION_INVALID naming the step id", async () => {
    writeTaskTarget();
    const { yaml } = readRejectedFixture(FIXTURE_ID);
    write(`workflows/${FIXTURE_ID}.yml`, yaml);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await captureRejection(`workflows/${FIXTURE_ID}`);
    expect(error).toBeInstanceOf(UsageError);
    if (!(error instanceof UsageError)) return;
    expect(error.code).toBe("COMPOSITION_INVALID");
    expect(error.message).toBe(COMPOSITION_INVALID_MESSAGE);
  });

  // B-03. The guard fires on `source.with !== undefined` — ANY authored with:
  // shape that survives decode, including an empty mapping, not just a non-empty
  // one.
  test("B-03: an empty with: {} mapping rejects identically to a non-empty one", async () => {
    writeTaskTarget();
    write(
      "workflows/empty-with-task-composition.yml",
      [
        "name: Empty with rejected",
        "on:",
        "  workflow_dispatch:",
        "jobs:",
        "  contract:",
        "    runs-on: [self-hosted]",
        "    steps:",
        `      - id: ${STEP_ID}`,
        `        uses: ${TASK_REF}`,
        "        with: {}",
        "",
      ].join("\n"),
    );
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await captureRejection("workflows/empty-with-task-composition");
    expect(error).toBeInstanceOf(UsageError);
    if (!(error instanceof UsageError)) return;
    expect(error.code).toBe("COMPOSITION_INVALID");
    expect(error.message).toBe(COMPOSITION_INVALID_MESSAGE);
  });

  // Pins the load-bearing placement fact: the rejection does not depend on the
  // task asset resolving, i.e. the guard fires before resolveOwnedAsset. Every
  // other fixture in this file backs its task ref with a real, resolvable
  // tasks/*.yml via writeTaskTarget() — deliberately NOT this one:
  // "tasks/does-not-exist" is never written, so no tasks/does-not-exist.yml
  // exists in the index. A guard placed after resolveOwnedAsset would throw
  // UsageError INVALID_FLAG_VALUE ("Workflow source target
  // tasks/does-not-exist was not found.") here instead of COMPOSITION_INVALID,
  // even though it would pass B-02/B-03 above (both of which back TASK_REF with a
  // real file, so resolution never fails there). This test pins only the
  // OBSERVABLE outcome — COMPOSITION_INVALID for an unresolvable task target
  // with with: attached — not how taskDispatch orders resolution vs. the with:
  // guard to get there.
  test("B-02b: the with: rejection fires before resolveOwnedAsset — an unresolvable task target still rejects with COMPOSITION_INVALID, not an asset-resolution error", async () => {
    write(
      "workflows/with-on-missing-task.yml",
      [
        "name: With on missing task",
        "on:",
        "  workflow_dispatch:",
        "jobs:",
        "  contract:",
        "    runs-on: [self-hosted]",
        "    steps:",
        `      - id: ${STEP_ID}`,
        "        uses: tasks/does-not-exist",
        "        with:",
        "          scope: all",
        "",
      ].join("\n"),
    );
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await captureRejection("workflows/with-on-missing-task");
    expect(error).toBeInstanceOf(UsageError);
    if (!(error instanceof UsageError)) return;
    expect(error.code).toBe("COMPOSITION_INVALID");
    expect(error.message).toBe(
      `Workflow step ${STEP_ID} cannot pass with: to task target tasks/does-not-exist; tasks/does-not-exist declares no inputs.`,
    );
  });

  // B-04: a step authored WITHOUT with: at all must not be touched by the guard;
  // it keeps freezing to a command dispatch.
  test("B-04: the same step authored WITHOUT with: still freezes to a command dispatch, unchanged", async () => {
    writeTaskTarget();
    write(
      "workflows/without-with-task-composition.yml",
      [
        "name: Without with",
        "on:",
        "  workflow_dispatch:",
        "jobs:",
        "  main:",
        "    runs-on: [self-hosted]",
        "    steps:",
        `      - id: ${STEP_ID}`,
        `        uses: ${TASK_REF}`,
        "",
      ].join("\n"),
    );
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const started = await startWorkflowRun("workflows/without-with-task-composition");
    const row = await planRow(started.run.id);
    const plan = decodeWorkflowPlan(JSON.parse(row?.plan_json ?? "null"));
    expect(firstTarget(plan)?.kind).toBe("command");
  });

  // B-05: the guard lives inside taskDispatch's task branch only. resolveStep's
  // builtin-command branch reads source.with directly and never calls
  // taskDispatch, so a valid with: on uses: akm/command keeps being consumed into
  // the frozen command target.
  test("B-05: with: {content} on uses: akm/command is still consumed into the frozen command target", async () => {
    write(
      "workflows/builtin-with-consumed.yml",
      [
        "name: Builtin with consumed",
        "on:",
        "  workflow_dispatch:",
        "jobs:",
        "  main:",
        "    runs-on: [self-hosted]",
        "    steps:",
        "      - id: dispatch",
        "        uses: akm/command",
        "        with:",
        "          content: Consume this with-rejection-suite value.",
        "",
      ].join("\n"),
    );
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const started = await startWorkflowRun("workflows/builtin-with-consumed");
    const row = await planRow(started.run.id);
    const plan = decodeWorkflowPlan(JSON.parse(row?.plan_json ?? "null"));
    const target = firstTarget(plan);
    expect(target?.kind).toBe("command");
    if (target?.kind !== "command") return;
    expect(target.request.command.content).toBe("Consume this with-rejection-suite value.");
  });
});
