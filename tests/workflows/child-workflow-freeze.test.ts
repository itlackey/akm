// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Freezing a child workflow (Experimental `unit.workflow`): the ONE recursive
 * resolver in `src/workflows/freeze/targets/child-workflow.ts` embeds the
 * child's complete frozen plan in the parent's target, binds `with:` against the
 * child's `params:`, and refuses a composition cycle.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, resetConfigCache } from "../../src/core/config/config";
import { UsageError } from "../../src/core/errors";
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
import { type ChildStepFixture, childParentDoc } from "../_helpers/workflow";

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

/** A markdown parent whose steps each run a child workflow (`unit.workflow`, optional `with`). */
function writeParent(name: string, steps: readonly ChildStepFixture[]): void {
  write(`workflows/${name}.md`, childParentDoc(steps));
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
    writeParent("direct-basic", [{ id: "dispatch", workflow: "workflows/child" }]);
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
    writeParent("direct-with", [{ id: "dispatch", workflow: "workflows/child", with: { scope: "urgent" } }]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const started = await startWorkflowRun("workflows/direct-with");
    const row = await planRow(started.run.id);
    const plan = decodeWorkflowPlan(JSON.parse(row?.plan_json ?? "null"));
    const fields = childWorkflowFields(stepTarget(plan, 0));

    expect(fields.inputBindings).toEqual([{ kind: "literal", name: "scope", value: "urgent" }]);
  });

  test("B-09: with: naming an undeclared child param fails INPUT_BINDING_INVALID at freeze, before publication", async () => {
    writeChild();
    writeParent("direct-bogus", [{ id: "dispatch", workflow: "workflows/child", with: { bogus: "nope" } }]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await expectInputBindingInvalid("workflows/direct-bogus");
    expect(error.message).toContain("bogus");
    await expectNoRunRowWritten();
  });

  test("B-10: with: {from: ...} plus another key is a hard INPUT_BINDING_INVALID failure, never reinterpreted as a literal", async () => {
    writeChild();
    writeParent("direct-hard-fail", [
      { id: "dispatch", workflow: "workflows/child", with: { scope: { from: "params.scope", other: 1 } } },
    ]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await expectInputBindingInvalid("workflows/direct-hard-fail");
    expect(error.message).toContain("with.scope");
    await expectNoRunRowWritten();
  });

  test("B-11: workflows/<ref> that does not resolve fails the existing asset-resolution failure, unchanged in code and shape", async () => {
    writeParent("direct-missing", [{ id: "dispatch", workflow: "workflows/does-not-exist" }]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await captureRejection("workflows/direct-missing");
    expect(error).toBeInstanceOf(UsageError);
    if (!(error instanceof UsageError)) throw new Error("unreachable");
    expect(error.code).toBe("INVALID_FLAG_VALUE");
    expect(error.message).toContain("workflows/does-not-exist");
  });
});

// ── Composition bounds — depth, cycle, aggregate size (spec §4.5, §2.6, ────
// ── rows B-18…B-25) ──────────────────────────────────────────────────────

describe("composition bounds — depth, cycle, aggregate embedded size (rows B-18…B-25)", () => {
  /** A chain of `count` workflows: chain-0 -> chain-1 -> … -> chain-(count-1), a leaf. */
  function writeChain(count: number): void {
    for (let i = 0; i < count; i++) {
      const isLast = i === count - 1;
      if (isLast) {
        write(`workflows/chain-${i}.md`, leafWorkflowDoc());
      } else {
        writeParent(`chain-${i}`, [{ id: "next", workflow: `workflows/chain-${i + 1}` }]);
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
    writeParent("self-cycle", [{ id: "loop", workflow: "workflows/self-cycle" }]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await expectCompositionInvalid("workflows/self-cycle");
    expect(error.message.toLowerCase()).toContain("cycle");
    expect(error.message).toContain("workflows/self-cycle");
    await expectNoRunRowWritten();
  });

  test("B-21: an indirect cycle (A -> B -> A) fails COMPOSITION_INVALID naming A -> B -> A", async () => {
    writeParent("cycle-a", [{ id: "hop", workflow: "workflows/cycle-b" }]);
    writeParent("cycle-b", [{ id: "hop", workflow: "workflows/cycle-a" }]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await expectCompositionInvalid("workflows/cycle-a");
    expect(error.message.toLowerCase()).toContain("cycle");
    expect(error.message).toContain("workflows/cycle-a");
    expect(error.message).toContain("workflows/cycle-b");
    await expectNoRunRowWritten();
  });

  test("B-23: the same workflow reached twice on disjoint branches (a diamond) is not a cycle and freezes, each occurrence embedding its own copy", async () => {
    write("workflows/diamond-leaf.md", leafWorkflowDoc());
    writeParent("diamond-root", [
      { id: "s1", workflow: "workflows/diamond-leaf" },
      { id: "s2", workflow: "workflows/diamond-leaf" },
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
      Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, workflow: `workflows/big-${i}` })),
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
