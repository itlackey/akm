// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P2b Lane A — the IDENTITY suite (docs/plans/specs/p2b-input-bindings.md
 * §1.1(4), §3.2's file table, §3.6, A-N7; rows B-01, B-43, B-44).
 *
 * tests/workflows/task-input-bindings.test.ts is the freeze MATRIX (every
 * INPUT_BINDING_INVALID rejection, plus normalize/merge rules) and already
 * carries its own "hash coverage" describe proving a CHANGED binding changes
 * the unit input hash (B-41, B-42). This file is the complementary suite
 * §3.2's file table names separately — what stays the SAME:
 *
 *   - B-01 (PRESERVE, A-N7): a step with no `with:` on a target that
 *     declares no inputs freezes `inputBindings` ABSENT — never `[]` — so
 *     every existing frozen target's canonical JSON, and therefore every
 *     existing plan_hash / unit inputHash, is untouched by this phase.
 *   - B-44 (PRESERVE, A-N7): `computeUnitInputHash`'s own prefix
 *     (now `akm.workflow.unit\0v7\0`) and `hashVersion` (now 7), plus
 *     `WORKFLOW_PLAN_VERSION`, are pinned externally. P2b bumped NOTHING
 *     (§1.1(4): "P2b bumps nothing. P3a owns irVersion 5 + hashVersion 6");
 *     P3a landed 6; the R-R15 fix (PR #844 review F6) then bumped unit+gate
 *     to 7 when the resolved-`taskInputs` preimage field landed, and this
 *     file's fixture pins those current values. The binding-free preimage's
 *     FIELD LIST below is still byte-identical to P3a's — a step with no
 *     bindings gained no `taskInputs` key.
 *   - B-43 (NEW): freezing the identical BOUND workflow twice — the same
 *     `with:` literal, the same declared task — produces byte-identical
 *     plan hashes and unit input hashes, proving that folding
 *     `inputBindings` into the hash preimage (A-N7: covered wholesale via
 *     `computeUnitInputHash`'s `frozenTarget` field, `step-work.ts:598`)
 *     is still a PURE function of the frozen plan.
 *
 * Before this file, `rg 'hashVersion' tests/` and `rg 'akm.workflow.unit'
 * tests/` were both empty (P2b test-review finding #4) — nothing pinned the
 * frozen hash VOCABULARY itself, only its reaction to a changed binding
 * (which proves a hash CAN change, never that its prefix/version, or the
 * absence of a stray `inputBindings: []`, stayed put).
 *
 * B-01 and B-44 need no unlanded API and carry no `@ts-expect-error` pin —
 * each exercises ONLY already-working freeze/hash machinery: B-01's target
 * is a task with no `inputs:` key declared (P4
 * docs/plans/specs/p4-deletions-closeout.md §7.2 F-A2.30 converted this from
 * a `version: 3` fixture — A-N6's LC-N1 deferral this comment used to cite
 * was already lifted by P2b itself, and task source v3 acceptance is retired
 * by P4, so a `version: 4` task with no `inputs:` key is now the faithful
 * fixture for the identical "declares no inputs" claim), and B-44's fixture
 * is a plain `akm/command` step that never reaches task composition at all.
 * `computeUnitInputHash` itself is untouched code. Both are GREEN today and
 * stay green as a continuous ratchet through Implement. B-43
 * needs the `with:`-bindings path (A-N3's decode widening, A-N6's
 * composition-deferral lift) and is RED today for the same two reasons
 * documented at the top of task-input-bindings.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../src/core/config/config";
import { akmIndex } from "../../src/indexer/indexer";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { computeStepWorkList } from "../../src/workflows/exec/step-work";
import { canonicalJson } from "../../src/workflows/ir/plan-hash";
import { WORKFLOW_PLAN_VERSION } from "../../src/workflows/plan";
import { decodeWorkflowPlan } from "../../src/workflows/runtime/run-plan";
import { abandonWorkflowRun, startWorkflowRun } from "../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";

const STEP_ID = "dispatch";

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

async function planRow(runId: string) {
  return withWorkflowRunsRepo((repo) => repo.getRunById(runId));
}

/** Start a fresh run of `ref` and return its run id, stored plan_hash, and decoded plan. */
async function freeze(ref: string) {
  const started = await startWorkflowRun(ref);
  const row = await planRow(started.run.id);
  return {
    runId: started.run.id,
    planHash: row?.plan_hash ?? null,
    plan: decodeWorkflowPlan(JSON.parse(row?.plan_json ?? "null")),
  };
}

describe("P2b freeze identity — B-01: absence-when-empty is the identity-preserving default (A-N7)", () => {
  test("a task-composing step whose target declares no inputs: at all, with no with:, freezes a target with no OWN inputBindings key", async () => {
    // task source v4, no `inputs:` key declared — mirroring
    // tests/workflows/with-rejection.test.ts's own reasoning (its header
    // comment, P4 F-A2.30): "declares no inputs" holds structurally,
    // independent of any binding logic, regardless of task source version.
    // Converted from a `version: 3` fixture (P4 retired task source v3
    // acceptance); B-01's own claim is a PRESERVATION claim — "byte-
    // identical to TODAY" — and the v4 form makes the identical claim the v3
    // one used to, so this stays the more faithful fixture, not merely a
    // workaround.
    write("tasks/no-inputs.yml", ["version: 4", "uses: commands/review", 'schedule: "@daily"', ""].join("\n"));
    write("commands/review.md", "Review the composed task target.\n");
    writeWorkflow("no-with", [`      - id: ${STEP_ID}`, "        uses: tasks/no-inputs"]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const { plan } = await freeze("workflows/no-with");
    const root = plan.steps[0]!.root;
    if (!root || root.kind === "map") throw new Error("expected the step to freeze a solo unit root");
    const target = root.frozenTarget;

    expect(Object.hasOwn(target, "inputBindings")).toBe(false);
    // Belt-and-suspenders: the canonical JSON preimage never even mentions
    // the key, so a stray `inputBindings: []` cannot slip past the own-key
    // check above by construction.
    expect(canonicalJson(target)).not.toContain("inputBindings");
  });
});

describe("P2b freeze identity — B-44: the frozen hash vocabulary is unchanged (A-N7, §1.1(4))", () => {
  test('WORKFLOW_PLAN_VERSION is 6, and computeUnitInputHash\'s prefix + hashVersion are exactly "akm.workflow.unit\\0v7\\0" / 7 — P3a landed 6, the R-R15 taskInputs fix bumped 7', async () => {
    expect(WORKFLOW_PLAN_VERSION).toBe(6);

    writeWorkflow("plain-command", [
      `      - id: ${STEP_ID}`,
      "        uses: akm/command",
      "        with:",
      "          content: Say hi.",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const { runId, plan } = await freeze("workflows/plain-command");
    const root = plan.steps[0]!.root;
    if (!root || root.kind === "map") throw new Error("expected the step to freeze a solo unit root");

    // Reconstructed EXTERNALLY, field-for-field, from step-work.ts's own
    // computeUnitInputHash preimage — a plain akm/command step (no fan-out,
    // no declared step `inputs:`, no gate feedback, and NO inputBindings, so
    // no `taskInputs` key: the R-R15 field is conditional and absent here)
    // needs no unlanded API to rebuild.
    const expectedPreimage = {
      hashVersion: 7,
      role: "unit",
      stepId: plan.steps[0]!.stepId,
      nodeId: root.id,
      template: root.instructions,
      item: null,
      inputs: [],
      params: {},
      frozenTarget: root.frozenTarget,
      environment: root.environment,
      schema: root.schema ?? null,
      isolation: root.isolation ?? "none",
    };
    const expectedHash = createHash("sha256")
      .update("akm.workflow.unit\0v7\0")
      .update(canonicalJson(expectedPreimage))
      .digest("hex");

    const computed = computeStepWorkList(plan.steps[0]!, { runId, params: {}, stepOutputs: {} });
    if (!computed.ok) throw new Error(`computeStepWorkList failed: ${computed.error}`);
    expect(computed.list.units[0]!.inputHash).toBe(expectedHash);
  });
});

describe("P2b freeze identity — B-43: freezing the identical BOUND workflow twice is byte-identical", () => {
  test("two independent freezes of the same with:-bound task-composing step produce byte-identical plan hashes and unit input hashes", async () => {
    write("commands/review.md", "Review the composed task target.\n");
    write(
      "tasks/bound.yml",
      [
        "version: 4",
        "name: Bound task",
        "uses: commands/review",
        "inputs:",
        "  ticket:",
        "    type: string",
        "    required: true",
        "",
      ].join("\n"),
    );
    writeWorkflow("bound-repeat", [
      `      - id: ${STEP_ID}`,
      "        uses: tasks/bound",
      "        with:",
      "          ticket: T-1",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    // "Re-running" at the freeze level: TWO separate `startWorkflowRun`
    // calls against the IDENTICAL source file — re-planning is always an
    // explicit new run (runtime/runs.ts's own comment), so this is two
    // genuinely independent freezes, not one plan read twice.
    //
    // publishWorkflowRunV4 refuses a second concurrent run against the same
    // workflow ref + scope (RESOURCE_ALREADY_EXISTS, "already has an active
    // run in this scope") — a guard unrelated to task source schema version.
    // Abandon the first run between freezes so the two startWorkflowRun
    // calls are independent instead of colliding; the second freeze is still
    // a genuinely separate publish (a fresh run id, a fresh plan_json write),
    // and abandonment does not touch either run's already-persisted
    // plan_json / plan_hash.
    const first = await freeze("workflows/bound-repeat");
    await abandonWorkflowRun(first.runId);
    const second = await freeze("workflows/bound-repeat");

    // The stored run-row plan_hash (computePlanHash/canonicalPlanJson) is
    // byte-identical...
    expect(first.planHash).not.toBeNull();
    expect(first.planHash).toBe(second.planHash);

    // ...and so is the per-unit dispatch-time hash (computeUnitInputHash),
    // computed independently for each freeze — the fact §1.1(4) needs:
    // adding inputBindings to the preimage did not make the hash a function
    // of anything but the frozen plan itself.
    const firstUnit = computeStepWorkList(first.plan.steps[0]!, { runId: first.runId, params: {}, stepOutputs: {} });
    const secondUnit = computeStepWorkList(second.plan.steps[0]!, {
      runId: second.runId,
      params: {},
      stepOutputs: {},
    });
    if (!firstUnit.ok) throw new Error(`computeStepWorkList failed: ${firstUnit.error}`);
    if (!secondUnit.ok) throw new Error(`computeStepWorkList failed: ${secondUnit.error}`);
    expect(firstUnit.list.units[0]!.inputHash).toBe(secondUnit.list.units[0]!.inputHash);

    // Full dispatch-level UNIT REUSE (the run-lease/resume machinery keying
    // off this hash to skip a completed attempt) is pre-existing, generic
    // behavior unrelated to bindings specifically, and is covered by the
    // run-lease/crash-window preservation suites named in spec §8 — not
    // re-proven here.
  });
});
