// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P1a Lane A — the fail-closed `with:` correction.
 *
 * docs/plans/specs/p1a-with-rejection-classifier.md §3/§5 (rows B-01..B-05):
 * a workflow step's `with:` on `uses: tasks/<ref>` currently decodes fine and
 * is then silently DROPPED at freeze (P0 row R-01(c), pinned by
 * tests/workflows/characterization-with-drop.test.ts before this phase's
 * flip). P1a turns that drop into a fail-closed rejection: the head of
 * `taskDispatch` (src/workflows/ir/source-freeze-v4.ts:211), before
 * `resolveOwnedAsset`, throws `UsageError` code `COMPOSITION_INVALID` when
 * `source.with !== undefined` — of ANY shape, including `{}`.
 *
 * The B-02/B-03 tests below assert that new rejection and are RED for the
 * right reason right now: today's `taskDispatch` has no such guard, so
 * `startWorkflowRun` resolves successfully instead of throwing, and
 * `expect(error).toBeInstanceOf(UsageError)` fails because `error` is
 * `undefined`. They turn green only once the guard described in spec §3.1
 * lands. Every other test in this file pins behavior the new guard must NOT
 * disturb (decode acceptance, the without-`with:` freeze, and the
 * `akm/command` builtin's own `with:` consumption) and is already green
 * today — a fix that broke one of those while adding the guard would be a
 * regression, not a correct P1a.
 *
 * Fixture: tests/fixtures/execution-contracts/workflows/rejected/
 * with-on-task-composition.yml, registered in that family's manifest.json
 * (id "with-on-task-composition"). Unlike its three siblings — which fail to
 * compile via compileGithubWorkflowSource — this one compiles cleanly (R-01(a)
 * is unaffected by P1a) and is rejected only at freeze; see the manifest
 * entry's "note" field and the first describe block below.
 *
 * Sandbox/freeze pattern follows tests/workflows/characterization-with-drop.ts
 * (withIsolatedAkmStorage + writeWorkflowTestConfig + akmIndex +
 * startWorkflowRun + withWorkflowRunsRepo + decodeWorkflowPlan).
 *
 * P2b FLIP (docs/plans/specs/p2b-input-bindings.md §7 F-A3, A-N5): P1a's
 * unconditional "task-call inputs are not supported yet" rejection is
 * REPLACED by a NARROWER one — `with:` on a `tasks/<ref>` step now binds a
 * DECLARED input contract (task-input-bindings.test.ts owns that new
 * behavior). `COMPOSITION_INVALID` survives only for the case this fixture
 * happens to already be: a target that declares NO inputs at all — every
 * fixture below keeps its task with no `inputs:` key on purpose (§6.2 (d)
 * originally, now P4 docs/plans/specs/p4-deletions-closeout.md §7.2 F-A2.30):
 * task source v4 makes `inputs:` optional and this fixture simply never
 * declares one, so "no declared inputs" stays true here unconditionally,
 * independent of any binding logic — the fixture used to be pinned at
 * `version: 3` for the SAME reason back when v3 could never declare
 * `inputs:` at all (P2a §1.2 D2); P4 retired task source v3 acceptance, so a
 * `version: 4` task with no `inputs:` key is now the faithful fixture for
 * this exact claim (F-A2.30: "converting them would silently change what's
 * asserted" no longer applies once the v4 form makes the same point). This is
 * flip F-A3: CODE stays `COMPOSITION_INVALID` on every assertion below;
 * only the trailing MESSAGE CLAUSE changes, from "task-call inputs are not
 * supported yet" to "<ref> declares no inputs" — the message text this file
 * pins is this test suite's OWN authored contract (the spec pins the FACT a
 * no-declared-inputs rejection must carry, not exact bytes for it), kept
 * intentionally consistent with task-input-bindings.test.ts's B-21/B-22/B-23
 * "not a binding surface" / "declares no inputs" phrasing. `src/core/errors.ts`'s
 * `COMPOSITION_INVALID` hint string changes too (A-N5) but is not asserted
 * here. RED today for the SAME underlying reason noted above — no such guard
 * exists yet, so `startWorkflowRun` still resolves instead of throwing.
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
// P2b flip (F-A3): the trailing clause changed from "task-call inputs are not
// supported yet" to naming the actual reason this fixture's target still
// rejects a with: — tasks/nightly declares no inputs: key, so it is a
// "no declared inputs" target regardless of task source version. See this
// file's header comment (P4 F-A2.30: converted from a version: 3 fixture,
// which pinned the identical claim for the same underlying reason).
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
  // PRESERVED: the fixture family's manifest convention (id/file/reasonCode)
  // is followed even though this entry's reasonCode is a UsageError code
  // rather than a WorkflowSourceSemanticError code — see the manifest
  // entry's "note" field for why.
  test(`rejected/${FIXTURE_ID}.yml is registered in workflows/manifest.json with reasonCode COMPOSITION_INVALID`, () => {
    const { entry } = readRejectedFixture(FIXTURE_ID);
    expect(entry.file).toBe(`rejected/${FIXTURE_ID}.yml`);
    expect(entry.reasonCode).toBe("COMPOSITION_INVALID");
  });

  // PRESERVED (B-01 companion): pins that decode/compile is unaffected by
  // P1a — schema.ts:144 still accepts with: on every uses target; only
  // taskDispatch's freeze-time behavior changes. Already green today.
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
   * pre-P1a run resolves and dispatches successfully instead of failing for
   * an unrelated (missing-asset) reason — the with-half's current behavior
   * must be "silently succeeds", not "fails for the wrong reason". */
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

  // NEW BEHAVIOR (P1a, currently RED): spec §3.1 / B-02. Today taskDispatch
  // never reads source.with (see characterization-with-drop.test.ts R-01(c)),
  // so startWorkflowRun resolves instead of throwing and this fails on
  // `error` being undefined — an assertion failure on today's silent-drop
  // behavior, not a crash.
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

  // NEW BEHAVIOR (P1a, currently RED): B-03. The guard fires on
  // `source.with !== undefined` — ANY authored with: shape that survives
  // decode, including an empty mapping, not just a non-empty one. Same
  // "silently succeeds today" failure mode as B-02 above.
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

  // NEW BEHAVIOR (P1a, currently RED): pins the load-bearing placement fact
  // from spec §3.1 ("so the rejection does not depend on the task asset
  // resolving") and §10's acceptance checkbox ("before resolveOwnedAsset").
  // Every other Lane A fixture in this file backs its task ref with a real,
  // resolvable tasks/*.yml via writeTaskTarget() — deliberately NOT this one:
  // "tasks/does-not-exist" is never written, so no tasks/does-not-exist.yml
  // exists in the index. Today, with no with:-guard at all, taskDispatch
  // calls resolveOwnedAsset first, which throws UsageError INVALID_FLAG_VALUE
  // ("Workflow source target tasks/does-not-exist was not found.") — this
  // test is red today, but for the WRONG reason (an asset-resolution error,
  // not COMPOSITION_INVALID). It turns green only once the with: guard is the
  // FIRST statement in taskDispatch, ahead of resolveOwnedAsset — a guard
  // placed anywhere after resolveOwnedAsset would still fail this test even
  // though it would pass B-02/B-03 above (both of which back TASK_REF with a
  // real file, so resolution never fails there).
  //
  // P2b FLIP (F-A3, §7 table row `:218`): message bytes only, per the spec —
  // code stays COMPOSITION_INVALID, this test's structure (an unresolvable
  // ref) is retained verbatim. RECORDED TENSION for the Review log (spec
  // §0's "stop and record it" rule): A-N5's "no declared inputs" rejection is
  // reasoned from the target's PARSED `inputs:` contract, which requires
  // resolving the target — yet this fixture's ref never resolves at all, and
  // the spec table still pins COMPOSITION_INVALID (not an asset-resolution
  // error) here. Implement reconciles the mechanism (e.g. an unresolvable
  // task target with with: attached still cannot be proven a valid binding
  // surface, so it is refused the same way); this test only pins the
  // OBSERVABLE outcome the table requires — it does not prescribe how
  // taskDispatch orders resolution vs. the with: guard to get there.
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

  // PRESERVED (B-04, already green — must stay green through P1a): a step
  // authored WITHOUT with: at all must not be touched by the new guard; it
  // keeps freezing to a command dispatch exactly as today.
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

  // PRESERVED (B-05, already green — must stay green through P1a): the new
  // guard lives inside taskDispatch's task branch only. resolveStep's
  // builtin-command branch (source-freeze-v4.ts:145-151) reads source.with
  // directly and never calls taskDispatch, so a valid with: on
  // uses: akm/command keeps being consumed into the frozen command target.
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
