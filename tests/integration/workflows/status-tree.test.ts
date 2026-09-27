// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P3b Lane B TESTS — the parent-child status tree, `akm workflow list`'s
 * child-exclusion, the scope-attach guard, and `akm show`'s active-run guard
 * (spec docs/plans/specs/p3b-child-executor.md §4.5, B-N10, rows B-33…B-45;
 * named in §7's new-suites table as this file).
 *
 * Row B-33 (the byte-identity baseline for a childless run) is written
 * FIRST, per §7's baseline gate: "Pin the existing status output shape
 * before extending (read the current renderer + its envelope tests)."
 *
 * Technique: parent and child run rows are built directly with the existing
 * `seedWorkflowRun`/`storeFrozenWorkflowPlan` test helpers plus the
 * already-implemented (P3a) `WorkflowRunsRepository.publishChildWorkflowRun`
 * / `reserveUnitAttempt` / `updateRunState` — never through the not-yet-wired
 * child EXECUTOR (Lane A), which this file does not depend on. This mirrors
 * `tests/integration/workflows/persistence-write-path.test.ts`'s direct-DB
 * seeding style. Every not-yet-existing FIELD this file reads
 * (`WorkflowRunDetail.children`, `WorkflowRunSummary.parentRunId` /
 * `.spawnedByUnitId` / `.outputs`) is read through a small structural view
 * interface — a cast through `unknown`, never a not-yet-existing named type
 * import — so this file needs no `@ts-expect-error` directive anywhere.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../../src/core/config/config";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { formatWorkflowStatusPlain } from "../../../src/output/text/workflow-format";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import { getCurrentWorkflowScopeKey } from "../../../src/workflows/authoring/scope-key";
import { canonicalPlanJson, computePlanHash } from "../../../src/workflows/ir/plan-hash";
import {
  getActiveWorkflowRun,
  getWorkflowStatus,
  listWorkflowRuns,
  startWorkflowRun,
} from "../../../src/workflows/runtime/runs";
import { loadWorkflowAsset } from "../../../src/workflows/runtime/workflow-asset-loader";
import { runCliCapture } from "../../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../../_helpers/sandbox";
import { freezeWorkflow, seedWorkflowRun, storeFrozenWorkflowPlan } from "../../_helpers/workflow";

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

const PARENT_MD = [
  "---",
  "type: workflow",
  "steps:",
  "  - id: spawn",
  "---",
  "",
  "## spawn",
  "",
  "Spawn a child.",
  "",
].join("\n");
const CHILD_MD = ["---", "type: workflow", "steps:", "  - id: work", "---", "", "## work", "", "Do it.", ""].join("\n");

const PARENT_PLAN = freezeWorkflow(PARENT_MD, "workflows/status-tree-parent.md");
const CHILD_PLAN = freezeWorkflow(CHILD_MD, "workflows/status-tree-child.md");

function seedParentRun(runId: string, ref = "test//workflows/status-tree-parent", scopeKey?: string): string {
  const key = scopeKey ?? getCurrentWorkflowScopeKey();
  const db = openStateDatabase(getStateDbPath());
  try {
    seedWorkflowRun(db, {
      runId,
      workflowRef: ref,
      scopeKey: key,
      steps: [{ stepId: "spawn", stepTitle: "Spawn child" }],
      currentStepId: "spawn",
    });
    storeFrozenWorkflowPlan(db, runId, PARENT_PLAN);
  } finally {
    db.close();
  }
  return key;
}

async function reserveParentUnit(runId: string, stepId: string, unitId: string): Promise<void> {
  await withWorkflowRunsRepo((repo) =>
    repo.reserveUnitAttempt({
      runId,
      unitId,
      stepId,
      nodeId: stepId,
      phase: "unit",
      runner: "exec",
      engine: null,
      model: null,
      inputHash: "0".repeat(64),
      now: new Date().toISOString(),
    }),
  );
}

interface PublishChildOptions {
  parentRunId: string;
  spawnedByUnitId: string;
  invocationKey: string;
  childRunId: string;
  workflowRef?: string;
  scopeKey: string;
  createdAt?: string;
}

async function publishChild(opts: PublishChildOptions): Promise<void> {
  const now = opts.createdAt ?? new Date().toISOString();
  await withWorkflowRunsRepo((repo) =>
    repo.publishChildWorkflowRun({
      parentRunId: opts.parentRunId,
      spawnedByUnitId: opts.spawnedByUnitId,
      invocationKey: opts.invocationKey,
      run: {
        id: opts.childRunId,
        workflowRef: opts.workflowRef ?? "test//workflows/status-tree-child",
        scopeKey: opts.scopeKey,
        workflowEntryId: null,
        workflowTitle: "Child",
        paramsJson: "{}",
        currentStepId: "work",
        createdAt: now,
        updatedAt: now,
        agentHarness: null,
        agentSessionId: null,
      },
      steps: [
        {
          runId: opts.childRunId,
          stepId: "work",
          stepTitle: "work",
          instructions: "Do it.",
          completionJson: null,
          sequenceIndex: 0,
        },
      ],
      planJson: canonicalPlanJson(CHILD_PLAN),
      planHash: computePlanHash(CHILD_PLAN),
    }),
  );
}

async function setRunStatus(
  runId: string,
  status: "active" | "completed" | "blocked" | "failed",
  currentStepId: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  await withWorkflowRunsRepo((repo) =>
    repo.updateRunState({
      status,
      currentStepId,
      updatedAt: now,
      completedAt: status === "completed" ? now : null,
      runId,
    }),
  );
}

// ── B-33: the byte-identity baseline for a childless run (PRESERVE) ────────
// Written FIRST, per §7's baseline gate.

describe("akm workflow status — byte-identity baseline for a run with NO children (B-33, PRESERVE)", () => {
  test("the JSON envelope carries no children key, and the text renderer's line shape is exactly today's", async () => {
    const runId = randomUUID();
    seedParentRun(runId);

    const detail = await getWorkflowStatus(runId);

    // No `children` key at all — absent, never [] or null.
    expect(Object.hasOwn(detail, "children")).toBe(false);
    expect(Object.keys(detail).sort()).toEqual(["run", "workflow"].sort());
    expect(Object.hasOwn(detail.run, "outputs")).toBe(false);
    expect(Object.hasOwn(detail.run, "parentRunId")).toBe(false);
    expect(Object.hasOwn(detail.run, "spawnedByUnitId")).toBe(false);

    // The exact documented text shape (§4.5's "Pinned baseline"): workflow:,
    // run:, title:, status:, optional currentStep:, then the steps: block —
    // and nothing else, for a run with one pending step and no children.
    const text = formatWorkflowStatusPlain(detail as unknown as Record<string, unknown>);
    expect(text).toBe(
      [
        "workflow: test//workflows/status-tree-parent",
        `run: ${runId}`,
        "title: Demo",
        "status: active",
        "currentStep: spawn",
        "steps:",
        // frozenStepRows derives a Markdown step's title from its id when the
        // source authors no explicit title ("a step is its id" — schema.ts) —
        // storeFrozenWorkflowPlan overwrites this file's own seeded
        // stepTitle with that plan-derived value, matching what a real
        // startWorkflowRun-published run would also show.
        "  - spawn [spawn] (pending)",
      ].join("\n"),
    );
  });

  test("akm workflow list on a childless scope carries no parentRunId/spawnedByUnitId/outputs on any run (B-45)", async () => {
    const runId = randomUUID();
    seedParentRun(runId);

    const { runs } = await listWorkflowRuns();
    expect(runs).toHaveLength(1);
    expect(Object.hasOwn(runs[0] as object, "parentRunId")).toBe(false);
    expect(Object.hasOwn(runs[0] as object, "spawnedByUnitId")).toBe(false);
    expect(Object.hasOwn(runs[0] as object, "outputs")).toBe(false);
  });
});

// ── B-34…B-37: the parent-child tree, JSON envelope ─────────────────────────

interface ChildNodeView {
  readonly runId: string;
  readonly workflowRef: string;
  readonly workflowTitle: string;
  readonly status: string;
  readonly spawnedByUnitId: string;
  readonly stepId: string | null;
  readonly currentStepId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resume?: { readonly command: string; readonly then: string };
  readonly children?: readonly ChildNodeView[];
}
interface DetailChildrenView {
  readonly children?: readonly ChildNodeView[];
}
function childrenOf(detail: unknown): readonly ChildNodeView[] | undefined {
  return (detail as unknown as DetailChildrenView).children;
}

describe("the parent-child tree — JSON envelope (B-34…B-36)", () => {
  test("a parent with one child gains children: [...] carrying the documented shape, ordered by created_at then id", async () => {
    const parentId = randomUUID();
    const scopeKey = seedParentRun(parentId);
    await reserveParentUnit(parentId, "spawn", "spawn:1");
    const childId = randomUUID();
    await publishChild({
      parentRunId: parentId,
      spawnedByUnitId: "spawn:1",
      invocationKey: "key-1",
      childRunId: childId,
      scopeKey,
    });

    const detail = await getWorkflowStatus(parentId);
    const children = childrenOf(detail);
    expect(children).toHaveLength(1);
    const child = children?.[0] as ChildNodeView;
    expect(child.runId).toBe(childId);
    expect(child.workflowRef).toBe("test//workflows/status-tree-child");
    expect(child.status).toBe("active");
    expect(child.spawnedByUnitId).toBe("spawn:1");
    expect(child.currentStepId).toBe("work");
    expect(typeof child.createdAt).toBe("string");
    expect(typeof child.updatedAt).toBe("string");

    // B-36: stepId is the PARENT step that spawned it, resolved via the real
    // workflow_run_units row this file reserved.
    expect(child.stepId).toBe("spawn");
  });

  test("B-36: stepId is null when the spawning unit row is gone", async () => {
    const parentId = randomUUID();
    const scopeKey = seedParentRun(parentId);
    // Deliberately no reserveParentUnit call: spawnedByUnitId names a unit
    // row that was never (or is no longer) journaled.
    const childId = randomUUID();
    await publishChild({
      parentRunId: parentId,
      spawnedByUnitId: "spawn:ghost",
      invocationKey: "key-ghost",
      childRunId: childId,
      scopeKey,
    });

    const detail = await getWorkflowStatus(parentId);
    const children = childrenOf(detail);
    expect(children).toHaveLength(1);
    expect((children?.[0] as ChildNodeView).stepId).toBeNull();
  });

  test("multiple children are ordered by created_at, id (P3a's childRunsOf order)", async () => {
    const parentId = randomUUID();
    const scopeKey = seedParentRun(parentId);
    await reserveParentUnit(parentId, "spawn", "spawn:1");

    const firstChild = randomUUID();
    const secondChild = randomUUID();
    await publishChild({
      parentRunId: parentId,
      spawnedByUnitId: "spawn:1",
      invocationKey: "key-a",
      childRunId: firstChild,
      scopeKey,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await publishChild({
      parentRunId: parentId,
      spawnedByUnitId: "spawn:1",
      invocationKey: "key-b",
      childRunId: secondChild,
      scopeKey,
      createdAt: "2026-01-01T00:00:01.000Z",
    });

    const detail = await getWorkflowStatus(parentId);
    const children = childrenOf(detail) ?? [];
    expect(children.map((c) => c.runId)).toEqual([firstChild, secondChild]);
  });

  test("B-35: a blocked child carries a resume {command, then}", async () => {
    const parentId = randomUUID();
    const scopeKey = seedParentRun(parentId);
    await reserveParentUnit(parentId, "spawn", "spawn:1");
    const childId = randomUUID();
    await publishChild({
      parentRunId: parentId,
      spawnedByUnitId: "spawn:1",
      invocationKey: "key-blocked",
      childRunId: childId,
      scopeKey,
    });
    await setRunStatus(childId, "blocked", "work");

    const detail = await getWorkflowStatus(parentId);
    const children = childrenOf(detail) ?? [];
    expect(children).toHaveLength(1);
    const child = children[0] as ChildNodeView;
    expect(child.status).toBe("blocked");
    expect(child.resume?.command).toContain(childId);
    expect(child.resume?.command).toContain("akm workflow resume");
    expect(child.resume?.then).toContain(parentId);
  });
});

describe("a 3-level composition tree (B-37)", () => {
  test("children nest recursively — depth of the rendered tree equals composition depth", async () => {
    const rootId = randomUUID();
    const scopeKey = seedParentRun(rootId, "test//workflows/status-tree-root");
    await reserveParentUnit(rootId, "spawn", "spawn:root");
    const midId = randomUUID();
    await publishChild({
      parentRunId: rootId,
      spawnedByUnitId: "spawn:root",
      invocationKey: "key-mid",
      childRunId: midId,
      workflowRef: "test//workflows/status-tree-mid",
      scopeKey,
    });
    // The mid run gets its OWN step ("work", from CHILD_PLAN) to spawn a
    // grandchild from.
    await reserveParentUnit(midId, "work", "work:mid");
    const leafId = randomUUID();
    await publishChild({
      parentRunId: midId,
      spawnedByUnitId: "work:mid",
      invocationKey: "key-leaf",
      childRunId: leafId,
      workflowRef: "test//workflows/status-tree-leaf",
      scopeKey,
    });

    const detail = await getWorkflowStatus(rootId);
    const rootChildren = childrenOf(detail) ?? [];
    expect(rootChildren).toHaveLength(1);
    const mid = rootChildren[0] as ChildNodeView;
    expect(mid.runId).toBe(midId);
    const midChildren = mid.children ?? [];
    expect(midChildren).toHaveLength(1);
    const leaf = midChildren[0] as ChildNodeView;
    expect(leaf.runId).toBe(leafId);
    expect(leaf.children ?? []).toHaveLength(0);
  });
});

// ── B-38, B-39: text rendering (renderer contract, independent of wiring) ──

describe("akm workflow status — text rendering of the children: block (B-38, B-39)", () => {
  /**
   * These feed `formatWorkflowStatusPlain` a hand-built envelope carrying a
   * `children` array in the documented shape directly — pinning the
   * RENDERER's contract independently of whether `getWorkflowStatus` already
   * populates it (it does not, today). `formatWorkflowStatusPlain` ignores
   * unknown fields today, so these are genuine RED assertions: the
   * `children:` block is absent from today's rendered text.
   */
  function baseEnvelope(children: unknown[]): Record<string, unknown> {
    return {
      run: { id: "11111111-1111-4111-8111-111111111111", status: "active", currentStepId: "spawn" },
      workflow: {
        ref: "test//workflows/status-tree-parent",
        title: "Parent",
        steps: [{ id: "spawn", title: "Spawn child", status: "completed" }],
      },
      children,
    };
  }

  test("B-38: a children: block renders after steps:, one glyph-prefixed line per child", () => {
    const text = formatWorkflowStatusPlain(
      baseEnvelope([
        {
          runId: "22222222-2222-4222-8222-222222222222",
          workflowRef: "test//workflows/leaf",
          status: "completed",
          stepId: "spawn",
        },
      ]),
    );
    expect(text).toContain("children:");
    expect(text).toContain("22222222-2222-4222-8222-222222222222");
    expect(text).toContain("test//workflows/leaf");
    expect(text).toContain("completed");
    // §4.5's glyph table: a completed child is prefixed "✓".
    expect(text).toContain("✓");
    // children: comes after steps:, matching §4.5's documented order.
    expect((text ?? "").indexOf("steps:")).toBeLessThan((text ?? "").indexOf("children:"));
  });

  test("B-39: a blocked child in text mode adds indented resume: and then: lines", () => {
    const text = formatWorkflowStatusPlain(
      baseEnvelope([
        {
          runId: "33333333-3333-4333-8333-333333333333",
          workflowRef: "test//workflows/leaf",
          status: "blocked",
          stepId: "spawn",
          resume: {
            command: "akm workflow resume 33333333-3333-4333-8333-333333333333",
            // biome-ignore lint/suspicious/noThenProperty: mirrors spec §4.5's real WorkflowChildRunNode.resume.then field name
            then: "akm workflow resume 11111111-1111-4111-8111-111111111111 && akm workflow run 11111111-1111-4111-8111-111111111111",
          },
        },
      ]),
    );
    expect(text).toContain("resume:");
    expect(text).toContain("akm workflow resume 33333333-3333-4333-8333-333333333333");
    expect(text).toContain("then:");
    expect(text).toContain("11111111-1111-4111-8111-111111111111");
  });
});

// ── B-40, B-42, B-43: children are invisible to the three scope queries ────

describe("child runs are invisible to the three scope queries (B-40, B-42, B-43, B-N10)", () => {
  test("B-40: akm workflow list excludes a child run sharing the parent's scope and workflow_ref", async () => {
    const parentId = randomUUID();
    const scopeKey = seedParentRun(parentId);
    await reserveParentUnit(parentId, "spawn", "spawn:1");
    const childId = randomUUID();
    await publishChild({
      parentRunId: parentId,
      spawnedByUnitId: "spawn:1",
      invocationKey: "key-list",
      childRunId: childId,
      scopeKey,
    });

    const { runs } = await listWorkflowRuns();
    expect(runs.map((r) => r.id)).toEqual([parentId]);
    expect(runs.map((r) => r.id)).not.toContain(childId);
  });

  test("B-42: getActiveRunRowForScope (the scope-attach lookup akm workflow run <ref> uses) does not resolve a childless-looking scope to the child", async () => {
    const parentId = randomUUID();
    const scopeKey = seedParentRun(parentId);
    await reserveParentUnit(parentId, "spawn", "spawn:1");
    const childRef = "test//workflows/status-tree-child";
    const childId = randomUUID();
    await publishChild({
      parentRunId: parentId,
      spawnedByUnitId: "spawn:1",
      invocationKey: "key-attach",
      childRunId: childId,
      workflowRef: childRef,
      scopeKey,
    });

    // Only the CHILD (not any top-level run) matches childRef+scopeKey — so
    // the scope-attach lookup `akm workflow run workflows/<childRef>` uses
    // must find NOTHING to attach to, which is what makes it start a new
    // top-level run instead of ATTACHING to the parent-driven child.
    const attach = await withWorkflowRunsRepo((repo) => repo.getActiveRunRowForScope([childRef], scopeKey));
    expect(attach).toBeUndefined();
  });

  test("B-42 (fourth site, code-review round 4 finding 2 / Review log R2): akm workflow run workflows/<childRef> starts a NEW top-level run end to end, never refusing in favor of the parent-driven child", async () => {
    const parentId = randomUUID();
    const scopeKey = seedParentRun(parentId);
    await reserveParentUnit(parentId, "spawn", "spawn:1");

    // A REAL, on-disk, freshly-indexable workflow file — unlike this
    // describe block's other tests, this one drives the real
    // `startWorkflowRun` (via `loadWorkflowAsset` + `startWorkflowRun`, the
    // exact pair `akm workflow run <ref>` itself calls, runs.ts:263,268),
    // not just the repository's scope-query method directly. That is what
    // exercises `publishWorkflowRunV4`'s own scope-conflict guard
    // (`findActiveRunForScope`, B-N10's FOURTH site) rather than only the
    // ALREADY-filtered `getActiveRunRowForScope` the test above covers.
    const childFileName = "status-tree-child-e2e";
    fs.mkdirSync(path.join(storage.stashDir, "workflows"), { recursive: true });
    fs.writeFileSync(path.join(storage.stashDir, "workflows", `${childFileName}.md`), CHILD_MD, "utf8");
    const childRef = (await loadWorkflowAsset(`workflows/${childFileName}`)).ref;

    const childId = randomUUID();
    await publishChild({
      parentRunId: parentId,
      spawnedByUnitId: "spawn:1",
      invocationKey: "key-attach-e2e",
      childRunId: childId,
      workflowRef: childRef,
      scopeKey,
    });

    // Before the fix, `findActiveRunForScope` had no `parent_run_id IS NULL`
    // predicate, so this resolved to the CHILD row and `startWorkflowRun`
    // failed with `RESOURCE_ALREADY_EXISTS` naming the CHILD's own run id —
    // telling the operator to `akm workflow abandon` a child a parent is
    // actively driving. It must instead start cleanly with a brand-new id.
    const started = await startWorkflowRun(`workflows/${childFileName}`, {});
    expect(started.run.workflowRef).toBe(childRef);
    expect(started.run.id).not.toBe(childId);
    expect(started.run.id).not.toBe(parentId);
  });

  test("B-43: akm show's active-run guard (getActiveWorkflowRun) reports the PARENT run, never the child", async () => {
    const parentId = randomUUID();
    const scopeKey = seedParentRun(parentId);
    await reserveParentUnit(parentId, "spawn", "spawn:1");
    const childId = randomUUID();
    await publishChild({
      parentRunId: parentId,
      spawnedByUnitId: "spawn:1",
      invocationKey: "key-show",
      childRunId: childId,
      scopeKey,
    });

    const active = await getActiveWorkflowRun(scopeKey);
    expect(active?.runId).toBe(parentId);
    expect(active?.runId).not.toBe(childId);
  });
});

// ── B-41: akm workflow list --children ──────────────────────────────────────

describe("akm workflow list --children (B-41)", () => {
  test("includes child rows, each carrying parentRunId, when the flag is passed", async () => {
    const parentId = randomUUID();
    const scopeKey = seedParentRun(parentId);
    await reserveParentUnit(parentId, "spawn", "spawn:1");
    const childId = randomUUID();
    await publishChild({
      parentRunId: parentId,
      spawnedByUnitId: "spawn:1",
      invocationKey: "key-flag",
      childRunId: childId,
      scopeKey,
    });

    const withoutFlag = await runCliCapture(["workflow", "list", "--format", "json"]);
    expect(withoutFlag.code).toBe(0);
    const withoutFlagRuns = (JSON.parse(withoutFlag.stdout) as { runs: Array<{ id: string }> }).runs;
    expect(withoutFlagRuns.map((r) => r.id)).not.toContain(childId);

    const withFlag = await runCliCapture(["workflow", "list", "--children", "--format", "json"]);
    expect(withFlag.code).toBe(0);
    const withFlagRuns = JSON.parse(withFlag.stdout) as {
      runs: Array<{ id: string; parentRunId?: string }>;
    };
    const childRow = withFlagRuns.runs.find((r) => r.id === childId);
    expect(childRow).toBeDefined();
    expect(childRow?.parentRunId).toBe(parentId);
  });
});

// ── B-44: akm workflow status <childRunId> ──────────────────────────────────

interface RunSummaryParentageView {
  readonly parentRunId?: string;
  readonly spawnedByUnitId?: string;
}

describe("akm workflow status <childRunId> (B-44)", () => {
  test("works directly on a child run id; the envelope gains run.parentRunId and run.spawnedByUnitId", async () => {
    const parentId = randomUUID();
    const scopeKey = seedParentRun(parentId);
    await reserveParentUnit(parentId, "spawn", "spawn:1");
    const childId = randomUUID();
    await publishChild({
      parentRunId: parentId,
      spawnedByUnitId: "spawn:1",
      invocationKey: "key-child-status",
      childRunId: childId,
      scopeKey,
    });

    const detail = await getWorkflowStatus(childId);
    expect(detail.run.id).toBe(childId);
    const view = detail.run as unknown as RunSummaryParentageView;
    expect(view.parentRunId).toBe(parentId);
    expect(view.spawnedByUnitId).toBe("spawn:1");
  });
});
