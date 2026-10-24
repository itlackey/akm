// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P3a Lane B — the ONE recursive child-workflow resolver (docs/plans/specs/
 * p3a-plan-v5-child-freeze.md §4, §6 F-B1…F-B4, §7 new-suites table: this
 * file owns rows B-04…B-25; B-01…B-03 are covered by the AUTHORIZED flips in
 * tests/workflows/characterization-classification.test.ts,
 * tests/workflows/source-ir-contract.test.ts, and
 * tests/execution/target-ref.test.ts, not duplicated here).
 *
 * Implemented: `src/workflows/freeze/targets/child-workflow.ts` is the ONE
 * resolver both forms route to — `src/workflows/source-ir/semantics.ts` no
 * longer throws `nested-workflow-unsupported` for a direct
 * `uses: workflows/<ref>` step, and `src/workflows/freeze/targets/task.ts`
 * no longer throws "A workflow task step cannot compose a nested workflow
 * target." for a task-wrapped one — both former throw sites now route to
 * `childWorkflowDispatch` instead.
 *
 * `FrozenWorkflowTarget` (src/workflows/ir/schema-v4.ts) is today's closed
 * `command | shell | script` union; it gains a fourth member,
 * `FrozenChildWorkflowTarget` (kind "child-workflow"; fields ref, planHash,
 * frozenPlan, contentHash, via, taskRef?, inputBindings?, spec §3.5), in
 * Implement. Every access to one of those NEW fields is isolated behind the
 * single `childWorkflowFields` helper below (mirroring
 * tests/workflows/task-input-bindings.test.ts's `frozenInputBindings`
 * pattern) so Implement removes each directive as its own line becomes
 * type-valid, not one per call site across this file. Structural assertions
 * that only need to check a SUBSET of a target's shape use `toMatchObject`
 * instead, whose `subset: object` parameter is untyped and needs no pin.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, resetConfigCache } from "../../src/core/config/config";
import { UsageError } from "../../src/core/errors";
import { _setWarnSinkForTests } from "../../src/core/warn";
import type { TaskInputBinding } from "../../src/execution/input-contract";
import { akmIndex } from "../../src/indexer/indexer";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { freezeWorkflow } from "../../src/workflows/freeze/freeze";
import { computePlanHash } from "../../src/workflows/ir/plan-hash";
import type { FrozenWorkflowTarget } from "../../src/workflows/plan";
import { decodeWorkflowPlan } from "../../src/workflows/runtime/run-plan";
import { listWorkflowRuns, startWorkflowRun } from "../../src/workflows/runtime/runs";
import { loadWorkflowAsset } from "../../src/workflows/runtime/workflow-asset-loader";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";
import { withSeam } from "../_helpers/seams";

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

/** A minimal markdown-frontmatter workflow with a `## work` inline-dispatch step and no declared params. */
function leafWorkflowDoc(): string {
  return ["---", "type: workflow", "steps:", "  - id: work", "---", "", "## work", "", "Do work.", ""].join("\n");
}

/** A minimal markdown-frontmatter workflow declaring one string param, `scope`, consumed by nothing (freeze-only fixture). */
function paramWorkflowDoc(): string {
  return [
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
    "Do work.",
    "",
  ].join("\n");
}

/** A GitHub-shaped parent workflow with the given pre-indented `steps:` entries. */
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

async function planRow(runId: string) {
  return withWorkflowRunsRepo((repo) => repo.getRunById(runId));
}

function stepTarget(plan: ReturnType<typeof decodeWorkflowPlan>, index: number): FrozenWorkflowTarget | undefined {
  const root = plan.steps[index]?.root;
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

async function expectCompositionInvalid(ref: string): Promise<UsageError> {
  const error = await captureRejection(ref);
  expect(error).toBeInstanceOf(UsageError);
  if (!(error instanceof UsageError)) throw new Error("unreachable");
  expect(error.code).toBe("COMPOSITION_INVALID");
  return error;
}

async function expectInputBindingInvalid(ref: string): Promise<UsageError> {
  const error = await captureRejection(ref);
  expect(error).toBeInstanceOf(UsageError);
  if (!(error instanceof UsageError)) throw new Error("unreachable");
  expect(error.code).toBe("INPUT_BINDING_INVALID");
  return error;
}

/** B-25: every composition-bound violation fails BEFORE the run row is published. */
async function expectNoRunRowWritten(): Promise<void> {
  const { runs } = await listWorkflowRuns();
  expect(runs).toHaveLength(0);
}

/**
 * §3.5: `FrozenWorkflowTarget` gains a `child-workflow` member,
 * `FrozenChildWorkflowTarget`, in Implement (kind, ref, planHash, frozenPlan,
 * contentHash, via, taskRef?, inputBindings?). `kind` and `inputBindings`
 * already exist on today's command|shell|script union and need no pin; the
 * rest do not exist on any current variant.
 */
function childWorkflowFields(target: FrozenWorkflowTarget | undefined): {
  readonly ref: string;
  readonly planHash: string;
  readonly frozenPlanIrVersion: number;
  readonly frozenPlanTitle: string;
  readonly contentHash: string;
  readonly via: "direct" | "task";
  readonly taskRef: string | undefined;
  readonly inputBindings: readonly TaskInputBinding[] | undefined;
} {
  if (!target) throw new Error("childWorkflowFields: target is undefined");
  // Implement landed `FrozenChildWorkflowTarget` as a proper discriminated
  // union member (schema-v4.ts A-N1): `command`/`shell`/`script` do not carry
  // ref/planHash/frozenPlan/via/taskRef, so TypeScript only admits the access
  // below once `kind` narrows `target`. This narrows for the whole function;
  // every red-phase `@ts-expect-error` pin below is now genuinely unused and
  // is removed, per this file's own header comment above.
  if (target.kind !== "child-workflow") {
    throw new Error(`childWorkflowFields: expected a child-workflow target, got ${target.kind}`);
  }
  return {
    ref: target.ref,
    planHash: target.planHash,
    frozenPlanIrVersion: target.frozenPlan.irVersion,
    frozenPlanTitle: target.frozenPlan.title,
    // contentHash already exists (as `string`) on all three current
    // FrozenWorkflowTarget variants — no pin needed for the access itself,
    // only for the NEW "child-workflow" preimage §3.5 defines for it.
    contentHash: target.contentHash,
    via: target.via,
    taskRef: target.taskRef,
    inputBindings: target.inputBindings,
  };
}

// ── Direct child workflows — uses: workflows/<ref> (spec §2.4, rows B-04…B-11) ─

describe("direct child workflows — uses: workflows/<ref> (rows B-04…B-11)", () => {
  function writeChild(): void {
    write("workflows/child.md", paramWorkflowDoc());
  }

  test("B-04: a direct uses: workflows/<ref> step freezes to a child-workflow target with the embedded frozen child plan and its planHash", async () => {
    writeChild();
    writeParent("direct-basic", ["      - id: dispatch", "        uses: workflows/child"]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    // Independently freeze the child on its own and compare hashes, so this
    // test proves the EMBEDDED plan really is the child's own frozen plan,
    // not merely that SOME plan got embedded.
    const childAsset = await loadWorkflowAsset("workflows/child");
    const independentChild = await freezeWorkflow(childAsset, loadConfig());
    const expectedChildPlanHash = computePlanHash(independentChild.plan);

    const started = await startWorkflowRun("workflows/direct-basic");
    const row = await planRow(started.run.id);
    const plan = decodeWorkflowPlan(JSON.parse(row?.plan_json ?? "null"));
    const target = stepTarget(plan, 0);

    expect(target).toMatchObject({ kind: "child-workflow", via: "direct" });
    const fields = childWorkflowFields(target);
    expect(fields.ref).toMatch(/\/\/workflows\/child$/);
    expect(fields.planHash).toBe(expectedChildPlanHash);
    expect(fields.frozenPlanIrVersion).toBe(6);
    expect(fields.taskRef).toBeUndefined();
  });

  test("B-08: with: on the direct step naming a declared child param freezes as an inputBindings entry", async () => {
    writeChild();
    writeParent("direct-with", [
      "      - id: dispatch",
      "        uses: workflows/child",
      "        with:",
      "          scope: urgent",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const started = await startWorkflowRun("workflows/direct-with");
    const row = await planRow(started.run.id);
    const plan = decodeWorkflowPlan(JSON.parse(row?.plan_json ?? "null"));
    const fields = childWorkflowFields(stepTarget(plan, 0));

    expect(fields.inputBindings).toEqual([{ kind: "literal", name: "scope", value: "urgent" }]);
  });

  test("B-09: with: naming an undeclared child param fails INPUT_BINDING_INVALID at freeze, before publication", async () => {
    writeChild();
    writeParent("direct-bogus", [
      "      - id: dispatch",
      "        uses: workflows/child",
      "        with:",
      "          bogus: nope",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await expectInputBindingInvalid("workflows/direct-bogus");
    expect(error.message).toContain("bogus");
    await expectNoRunRowWritten();
  });

  test("B-10: with: {from: ...} plus another key is a hard INPUT_BINDING_INVALID failure, never reinterpreted as a literal", async () => {
    writeChild();
    writeParent("direct-hard-fail", [
      "      - id: dispatch",
      "        uses: workflows/child",
      "        with:",
      "          scope:",
      "            from: params.scope",
      "            other: 1",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await expectInputBindingInvalid("workflows/direct-hard-fail");
    expect(error.message).toContain("with.scope");
    await expectNoRunRowWritten();
  });

  test("B-11: workflows/<ref> that does not resolve fails the existing asset-resolution failure, unchanged in code and shape", async () => {
    writeParent("direct-missing", ["      - id: dispatch", "        uses: workflows/does-not-exist"]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await captureRejection("workflows/direct-missing");
    expect(error).toBeInstanceOf(UsageError);
    if (!(error instanceof UsageError)) throw new Error("unreachable");
    expect(error.code).toBe("INVALID_FLAG_VALUE");
    expect(error.message).toContain("workflows/does-not-exist");
  });
});

// ── Task-wrapped child workflows — uses: tasks/<t>, t targets a workflow ────
// ── (spec §2.5, rows B-12…B-17; the v4-declared-inputs case, B-13, is the ──
// ── AUTHORIZED flip in tests/workflows/task-input-bindings.test.ts) ─────────

describe("task-wrapped child workflows — uses: tasks/<t> where t targets a workflow (rows B-12, B-14, B-15)", () => {
  function writeChild(): void {
    write("workflows/child.md", paramWorkflowDoc());
  }

  // P4 (docs/plans/specs/p4-deletions-closeout.md §3.2, row B-28, F-A2.29)
  // retired task source v3 acceptance — a task's own `with:` on a workflow
  // target no longer exists as a grammar at all (v4 accepts `with:` only
  // alongside `uses: akm/command`, R-R2 resolved by deletion, spec §8).
  // Converted to a task source v4 wrapper that declares a typed `inputs:`
  // with a default value instead: `resolveTaskForComposition`'s bindings are
  // computed from the wrapper's OWN declared-input contract regardless of
  // whether the composing step authors a `with:` (it cannot, on a task
  // target), so the child's params still arrive as a literal binding — just
  // sourced from the input's `default:` rather than an authored `with:`.
  test("B-12/B-14: a task whose own uses: targets a workflow freezes to a child-workflow target, via task, and the task's own declared input default becomes the child's params", async () => {
    writeChild();
    write(
      "tasks/v4-wrapper.yml",
      [
        "version: 4",
        "uses: workflows/child",
        "inputs:",
        "  scope:",
        "    type: string",
        "    default: from-v4-task",
        'schedule: "@daily"',
        "",
      ].join("\n"),
    );
    writeParent("v4-wrapped", ["      - id: dispatch", "        uses: tasks/v4-wrapper"]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const started = await startWorkflowRun("workflows/v4-wrapped");
    const row = await planRow(started.run.id);
    const plan = decodeWorkflowPlan(JSON.parse(row?.plan_json ?? "null"));
    const target = stepTarget(plan, 0);

    expect(target).toMatchObject({ kind: "child-workflow", via: "task" });
    const fields = childWorkflowFields(target);
    expect(fields.taskRef).toMatch(/\/\/tasks\/v4-wrapper$/);
    expect(fields.inputBindings).toEqual([{ kind: "literal", name: "scope", value: "from-v4-task" }]);
  });

  test("B-15: a task with env: on a workflow target runs anyway, ignoring env:", async () => {
    writeChild();
    write(
      "tasks/v4-env-wrapper.yml",
      ["version: 4", "uses: workflows/child", "env:", "  FOO: bar", 'schedule: "@daily"', ""].join("\n"),
    );
    writeParent("v4-env-wrapped", ["      - id: dispatch", "        uses: tasks/v4-env-wrapper"]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const started = await startWorkflowRun("workflows/v4-env-wrapped");
    const row = await planRow(started.run.id);
    const plan = decodeWorkflowPlan(JSON.parse(row?.plan_json ?? "null"));
    const target = stepTarget(plan, 0);

    expect(target).toMatchObject({ kind: "child-workflow", via: "task" });
    const fields = childWorkflowFields(target);
    expect(fields.taskRef).toMatch(/\/\/tasks\/v4-env-wrapper$/);
  });
});

// ── Code-review finding: a composing step's own env: has no path into a ────
// ── child run (the frozen environment is the CHILD's own, not the parent ───
// ── step's) — src/workflows/freeze/targets/child-workflow.ts's ─────────────
// ── assertNoStepEnvironment. Distinct from B-15 above: B-15 is the ─────────
// ── task DOCUMENT's own top-level env:; this is env: authored on the ───────
// ── WORKFLOW STEP that composes a child, direct or task-wrapped. ───────────

describe("a step composing a child workflow that also authors env: warns instead of refusing to freeze", () => {
  function writeChild(): void {
    write("workflows/child.md", paramWorkflowDoc());
  }

  test("a direct uses: workflows/<ref> step with env: freezes fine, warning names the step and the child ref", async () => {
    writeChild();
    writeParent("direct-env", [
      "      - id: dispatch",
      "        uses: workflows/child",
      "        env:",
      "          FOO: bar",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const warnCalls: string[] = [];
    const started = await withSeam(
      _setWarnSinkForTests,
      (level, args) => {
        if (level !== "warn") return;
        warnCalls.push(args.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" "));
      },
      () => startWorkflowRun("workflows/direct-env"),
    );
    expect(warnCalls.some((w) => w.includes("dispatch") && w.includes("//workflows/child"))).toBe(true);
    const row = await planRow(started.run.id);
    const plan = decodeWorkflowPlan(JSON.parse(row?.plan_json ?? "null"));
    expect(stepTarget(plan, 0)).toMatchObject({ kind: "child-workflow", via: "direct" });
  });

  test("a task-wrapped uses: tasks/<t> step (t targets a workflow) with env: on the COMPOSING STEP freezes fine the same way", async () => {
    writeChild();
    write("tasks/wrapper.yml", ["version: 4", "uses: workflows/child", 'schedule: "@daily"', ""].join("\n"));
    writeParent("task-env", [
      "      - id: dispatch",
      "        uses: tasks/wrapper",
      "        env:",
      "          FOO: bar",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const warnCalls: string[] = [];
    const started = await withSeam(
      _setWarnSinkForTests,
      (level, args) => {
        if (level !== "warn") return;
        warnCalls.push(args.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" "));
      },
      () => startWorkflowRun("workflows/task-env"),
    );
    expect(warnCalls.some((w) => w.includes("dispatch"))).toBe(true);
    const row = await planRow(started.run.id);
    const plan = decodeWorkflowPlan(JSON.parse(row?.plan_json ?? "null"));
    expect(stepTarget(plan, 0)).toMatchObject({ kind: "child-workflow", via: "task" });
  });

  test("a direct uses: workflows/<ref> step with NO env: still freezes fine, no warning (regression guard)", async () => {
    writeChild();
    writeParent("direct-no-env", ["      - id: dispatch", "        uses: workflows/child"]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const warnCalls: string[] = [];
    const started = await withSeam(
      _setWarnSinkForTests,
      (level, args) => {
        if (level !== "warn") return;
        warnCalls.push(args.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" "));
      },
      () => startWorkflowRun("workflows/direct-no-env"),
    );
    expect(warnCalls).toEqual([]);
    const row = await planRow(started.run.id);
    const plan = decodeWorkflowPlan(JSON.parse(row?.plan_json ?? "null"));
    expect(stepTarget(plan, 0)).toMatchObject({ kind: "child-workflow", via: "direct" });
  });
});

// ── Direct and task-wrapped composition lower to the SAME target shape ─────

describe("direct and task-wrapped composition of the SAME child lower to the same target shape, modulo identity fields", () => {
  test("a direct step and a task-wrapped step composing the same child with the same effective params freeze to structurally equal child-workflow targets — only via/taskRef (and contentHash, whose preimage covers them) differ", async () => {
    write("workflows/shared-child.md", paramWorkflowDoc());
    // P4 (spec §3.2, row B-28, F-A2.29): the wrapper's own with: is retired
    // along with task source v3 — a declared input default reaches the
    // identical literal binding the direct step's authored with: does, which
    // is exactly the equality this test proves.
    write(
      "tasks/shared-wrapper.yml",
      [
        "version: 4",
        "uses: workflows/shared-child",
        "inputs:",
        "  scope:",
        "    type: string",
        "    default: shared-value",
        'schedule: "@daily"',
        "",
      ].join("\n"),
    );
    writeParent("compare-direct", [
      "      - id: dispatch",
      "        uses: workflows/shared-child",
      "        with:",
      "          scope: shared-value",
    ]);
    writeParent("compare-task", ["      - id: dispatch", "        uses: tasks/shared-wrapper"]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const directRun = await startWorkflowRun("workflows/compare-direct");
    const taskRun = await startWorkflowRun("workflows/compare-task");
    const directPlan = decodeWorkflowPlan(JSON.parse((await planRow(directRun.run.id))?.plan_json ?? "null"));
    const taskPlan = decodeWorkflowPlan(JSON.parse((await planRow(taskRun.run.id))?.plan_json ?? "null"));
    const directFields = childWorkflowFields(stepTarget(directPlan, 0));
    const taskFields = childWorkflowFields(stepTarget(taskPlan, 0));

    // The identical child, reached with identical resolved inputs: ref,
    // planHash, the embedded plan's identity, and the resulting
    // inputBindings must be equal regardless of route.
    expect(taskFields.ref).toBe(directFields.ref);
    expect(taskFields.planHash).toBe(directFields.planHash);
    expect(taskFields.frozenPlanIrVersion).toBe(directFields.frozenPlanIrVersion);
    expect(taskFields.frozenPlanTitle).toBe(directFields.frozenPlanTitle);
    expect(taskFields.inputBindings).toEqual(directFields.inputBindings);
    // Only the declared-identity fields recording HOW the child was reached
    // differ between the two routes.
    expect(directFields.via).toBe("direct");
    expect(taskFields.via).toBe("task");
    expect(directFields.taskRef).toBeUndefined();
    expect(taskFields.taskRef).toMatch(/\/\/tasks\/shared-wrapper$/);
  });
});

// ── Composition bounds — depth, cycle, aggregate size (spec §4.5, §2.6, ────
// ── rows B-18…B-25) ──────────────────────────────────────────────────────

describe("composition bounds — depth, cycle, aggregate embedded size (rows B-18…B-25)", () => {
  /**
   * A chain of `count` workflows: chain-0 -> chain-1 -> … -> chain-(count-2)
   * -> chain-(count-1) (a leaf). Every COMPOSING node must be GitHub-YAML
   * (via writeParent): the markdown-frontmatter step schema's `unit:`
   * dispatch-override bag has no `uses` key at all (STEP_KEYS/UNIT_KEYS,
   * src/workflows/parser.ts) — only the GitHub-shaped `jobs.<id>.steps[].uses`
   * surface can author composition. Only the final, non-composing leaf uses
   * the markdown body-only shape.
   */
  function writeChain(count: number): void {
    for (let i = 0; i < count; i++) {
      const isLast = i === count - 1;
      if (isLast) {
        write(`workflows/chain-${i}.md`, leafWorkflowDoc());
      } else {
        writeParent(`chain-${i}`, ["      - id: next", `        uses: workflows/chain-${i + 1}`]);
      }
    }
  }

  test("B-19: a composition chain 10 levels deep freezes — depth is unbounded, only the cycle check (B-20/B-21) bounds composition", async () => {
    writeChain(11);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const started = await startWorkflowRun("workflows/chain-0");
    expect(started.run.id).toBeTruthy();
  });

  test("B-20: a direct self-reference (A -> A) fails COMPOSITION_INVALID naming the cycle path", async () => {
    writeParent("self-cycle", ["      - id: loop", "        uses: workflows/self-cycle"]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await expectCompositionInvalid("workflows/self-cycle");
    expect(error.message.toLowerCase()).toContain("cycle");
    expect(error.message).toContain("workflows/self-cycle");
    await expectNoRunRowWritten();
  });

  test("B-21: an indirect cycle (A -> B -> A) fails COMPOSITION_INVALID naming A -> B -> A", async () => {
    writeParent("cycle-a", ["      - id: hop", "        uses: workflows/cycle-b"]);
    writeParent("cycle-b", ["      - id: hop", "        uses: workflows/cycle-a"]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await expectCompositionInvalid("workflows/cycle-a");
    expect(error.message.toLowerCase()).toContain("cycle");
    expect(error.message).toContain("workflows/cycle-a");
    expect(error.message).toContain("workflows/cycle-b");
    await expectNoRunRowWritten();
  });

  test("B-22: a task-mediated cycle (A -> tasks/w -> B -> A) fails COMPOSITION_INVALID, the reported path naming the intermediate task ref", async () => {
    writeParent("task-cycle-a", ["      - id: hop", "        uses: tasks/wrap-task-cycle-b"]);
    write(
      "tasks/wrap-task-cycle-b.yml",
      ["version: 4", "uses: workflows/task-cycle-b", 'schedule: "@daily"', ""].join("\n"),
    );
    writeParent("task-cycle-b", ["      - id: back", "        uses: workflows/task-cycle-a"]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await expectCompositionInvalid("workflows/task-cycle-a");
    expect(error.message.toLowerCase()).toContain("cycle");
    expect(error.message).toContain("tasks/wrap-task-cycle-b");
    await expectNoRunRowWritten();
  });

  test("B-23: the same workflow reached twice on disjoint branches (a diamond) is not a cycle and freezes, each occurrence embedding its own copy", async () => {
    write("workflows/diamond-leaf.md", leafWorkflowDoc());
    writeParent("diamond-root", [
      "      - id: s1",
      "        uses: workflows/diamond-leaf",
      "      - id: s2",
      "        uses: workflows/diamond-leaf",
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    // Independently freeze the leaf and compare hashes at BOTH occurrences,
    // exactly as B-04 does for a single occurrence, so this proves each step
    // embeds its OWN correct copy of the child's frozen plan — not merely
    // that both steps froze to SOME child-workflow-shaped target (which
    // `toMatchObject({ kind: "child-workflow" })` alone cannot distinguish
    // from a wrong, stale, or empty embedded plan on either occurrence).
    const leafAsset = await loadWorkflowAsset("workflows/diamond-leaf");
    const independentLeaf = await freezeWorkflow(leafAsset, loadConfig());
    const expectedPlanHash = computePlanHash(independentLeaf.plan);

    const started = await startWorkflowRun("workflows/diamond-root");
    const row = await planRow(started.run.id);
    const plan = decodeWorkflowPlan(JSON.parse(row?.plan_json ?? "null"));

    const fields1 = childWorkflowFields(stepTarget(plan, 0));
    const fields2 = childWorkflowFields(stepTarget(plan, 1));

    expect(fields1.ref).toMatch(/\/\/workflows\/diamond-leaf$/);
    expect(fields2.ref).toMatch(/\/\/workflows\/diamond-leaf$/);
    expect(fields1.planHash).toBe(expectedPlanHash);
    expect(fields2.planHash).toBe(expectedPlanHash);
    expect(fields1.frozenPlanTitle).toBe(fields2.frozenPlanTitle);
    expect(fields1.frozenPlanIrVersion).toBe(fields2.frozenPlanIrVersion);
  });

  test("B-24: aggregate embedded child plan bytes once over the former 1 MiB cap now freezes fine (a large plan is not a wrong plan)", async () => {
    // Five children at 250,000 'x' bytes each (well under the 256 KiB
    // per-instruction cap and the 1 MiB per-source-file cap individually)
    // sum to 1,250,000 bytes — comfortably over the 1,048,576-byte
    // (1 MiB) aggregate cap once every embedded plan's structural overhead
    // is added on top.
    const bigBody = (n: number) =>
      ["---", "type: workflow", "steps:", "  - id: work", "---", "", "## work", "", "x".repeat(n), ""].join("\n");
    for (let i = 0; i < 5; i++) write(`workflows/big-${i}.md`, bigBody(250_000));
    writeParent(
      "aggregate-root",
      Array.from({ length: 5 }, (_, i) => [`      - id: s${i}`, `        uses: workflows/big-${i}`]).flat(),
    );
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const started = await startWorkflowRun("workflows/aggregate-root");
    const row = await planRow(started.run.id);
    const plan = decodeWorkflowPlan(JSON.parse(row?.plan_json ?? "null"));
    for (let i = 0; i < 5; i++) {
      const fields = childWorkflowFields(stepTarget(plan, i));
      expect(fields.ref).toMatch(new RegExp(`//workflows/big-${i}$`));
    }
  });
});
