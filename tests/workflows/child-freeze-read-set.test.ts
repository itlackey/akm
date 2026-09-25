// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P3a Lane B — child-workflow source-read-set absorption and the
 * frozen-before-publication guarantee (docs/plans/specs/
 * p3a-plan-v5-child-freeze.md §4.3-§4.4, A-N7, rows B-05…B-07).
 *
 * Complements tests/workflows/child-workflow-freeze.test.ts (which owns the
 * target-shape and composition-bound rows, B-04…B-25): this file is
 * integration-level because its three properties need the REAL storage
 * layer — the parent's `sourceReadSet`, a stored run re-read from `state.db`
 * after an on-disk edit, and the repository's real
 * `publishWorkflowRunV4`/`GuardedExecutionSourceCollector.revalidate` CAS —
 * not just the frozen in-memory plan `startWorkflowRun` hands back.
 *
 * Implemented, for the same two reasons as the sibling suite:
 * `src/workflows/freeze/targets/child-workflow.ts` is the ONE resolver, and
 * `src/workflows/source-ir/semantics.ts` no longer throws
 * `nested-workflow-unsupported` for a direct `uses: workflows/<ref>` step —
 * so every composing `startWorkflowRun` call below freezes instead of
 * rejecting. `GuardedExecutionSourceCollector.absorb` (A-N7,
 * src/execution/guarded-source.ts) is what B-07 exercises directly, at the
 * mechanism level.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, resetConfigCache } from "../../src/core/config/config";
import { akmIndex } from "../../src/indexer/indexer";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { compileResolveFreezeWorkflowV4 } from "../../src/workflows/ir/freeze-v4";
import { canonicalPlanJson, computePlanHash } from "../../src/workflows/ir/plan-hash";
import { decodeWorkflowPlanV4, type FrozenWorkflowTarget } from "../../src/workflows/ir/schema-v4";
import { frozenStepRows } from "../../src/workflows/runtime/run-plan";
import { listWorkflowRuns, startWorkflowRun } from "../../src/workflows/runtime/runs";
import { loadWorkflowAsset } from "../../src/workflows/runtime/workflow-asset-loader";
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

/** A minimal markdown-frontmatter workflow with a single `## work` inline-dispatch step. */
function leafWorkflowDoc(body = "Do work."): string {
  return ["---", "type: workflow", "steps:", "  - id: work", "---", "", "## work", "", body, ""].join("\n");
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

function stepTarget(plan: ReturnType<typeof decodeWorkflowPlanV4>, index: number): FrozenWorkflowTarget | undefined {
  const root = plan.steps[index]?.root;
  if (!root) return undefined;
  return root.kind === "map" ? root.template.frozenTarget : root.frozenTarget;
}

/**
 * §3.5: `FrozenWorkflowTarget` gains a `child-workflow` member in Implement.
 * Isolated here (mirroring tests/workflows/child-workflow-freeze.test.ts's
 * identical helper) so Implement removes each directive as its own line
 * becomes type-valid, instead of one per call site across this file.
 */
function childWorkflowFields(target: FrozenWorkflowTarget | undefined): {
  readonly planHash: string;
} {
  if (!target) throw new Error("childWorkflowFields: target is undefined");
  // Implement landed `FrozenChildWorkflowTarget` as a proper discriminated
  // union member (schema-v4.ts A-N1): `command`/`shell`/`script` do not
  // carry `.planHash`, so TypeScript only admits the access below once
  // `kind` narrows `target`. The red-phase `@ts-expect-error` pin is now
  // genuinely unused and is removed, per this file's own header comment.
  if (target.kind !== "child-workflow") {
    throw new Error(`childWorkflowFields: expected a child-workflow target, got ${target.kind}`);
  }
  return {
    planHash: target.planHash,
  };
}

// ── B-05: the parent's sourceReadSet covers every transitive child source ──

describe("the parent's sourceReadSet covers the child workflow doc and every transitive command/task ref (row B-05)", () => {
  test("child doc + its direct command ref + its task ref's OWN command ref all appear as relative paths", async () => {
    write("commands/child-command.md", "Do the child's own direct command.\n");
    write("commands/task-command.md", "Do the task-mediated command.\n");
    write("tasks/child-task.yml", ["version: 4", "uses: commands/task-command", 'schedule: "@daily"', ""].join("\n"));
    write(
      "workflows/child.yml",
      [
        "name: Child",
        "on:",
        "  workflow_dispatch:",
        "jobs:",
        "  main:",
        "    runs-on: [self-hosted]",
        "    steps:",
        "      - id: direct-command",
        "        uses: commands/child-command",
        "      - id: via-task",
        "        uses: tasks/child-task",
        "",
      ].join("\n"),
    );
    writeParent("parent-readset", ["      - id: dispatch", "        uses: workflows/child"]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const started = await startWorkflowRun("workflows/parent-readset");
    const row = await planRow(started.run.id);
    const plan = decodeWorkflowPlanV4(JSON.parse(row?.plan_json ?? "null"));

    const files = plan.sourceReadSet.map((source) => source.identity.file);
    for (const file of files) expect(path.isAbsolute(file)).toBe(false);

    expect(files.some((file) => file.endsWith("workflows/parent-readset.yml"))).toBe(true);
    expect(files.some((file) => file.endsWith("workflows/child.yml"))).toBe(true);
    expect(files.some((file) => file.endsWith("commands/child-command.md"))).toBe(true);
    expect(files.some((file) => file.endsWith("tasks/child-task.yml"))).toBe(true);
    expect(files.some((file) => file.endsWith("commands/task-command.md"))).toBe(true);
  });
});

// ── B-06: editing child source AFTER publication cannot change the ─────────
// ── already-frozen parent ───────────────────────────────────────────────

describe("editing child source after parent publication does not change the parent's frozen child plan (row B-06)", () => {
  test("re-reading the stored run's plan_json shows the ORIGINAL child content, byte-identical, not the edited one", async () => {
    write("workflows/child.md", leafWorkflowDoc());
    writeParent("parent-b06", ["      - id: dispatch", "        uses: workflows/child"]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const started = await startWorkflowRun("workflows/parent-b06");
    const originalRow = await planRow(started.run.id);
    const originalPlan = decodeWorkflowPlanV4(JSON.parse(originalRow?.plan_json ?? "null"));
    const originalFields = childWorkflowFields(stepTarget(originalPlan, 0));

    // Edit the child source on disk AFTER the parent has already published.
    write("workflows/child.md", leafWorkflowDoc("Do DIFFERENT work, edited after publication."));

    const rereadRow = await planRow(started.run.id);
    expect(rereadRow?.plan_json).toBe(originalRow?.plan_json);
    const rereadPlan = decodeWorkflowPlanV4(JSON.parse(rereadRow?.plan_json ?? "null"));
    const rereadFields = childWorkflowFields(stepTarget(rereadPlan, 0));
    expect(rereadFields.planHash).toBe(originalFields.planHash);
  });
});

// ── B-07: editing child source BETWEEN freeze and publication fails the ────
// ── final read-set CAS atomically, before any row is written ───────────────

describe("editing child source between parent freeze and parent publication fails publication atomically (row B-07)", () => {
  test("revalidate() (the same call publishWorkflowRunV4 runs first, inside IMMEDIATE, before any write) throws once the child has been mutated", async () => {
    write("workflows/child.md", leafWorkflowDoc());
    writeParent("parent-b07", ["      - id: dispatch", "        uses: workflows/child"]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const asset = await loadWorkflowAsset("workflows/parent-b07");
    const frozen = await compileResolveFreezeWorkflowV4(asset, loadConfig());

    // The window this row exists to close: the child is edited AFTER freeze
    // absorbed its source but BEFORE publication's final CAS runs.
    write("workflows/child.md", leafWorkflowDoc("Mutated during the freeze-to-publish window."));

    expect(() => frozen.sourceCollector.revalidate()).toThrow();
  });

  test("publishing through the real repository call with that same revalidateSources writes NO run row", async () => {
    write("workflows/child.md", leafWorkflowDoc());
    writeParent("parent-b07b", ["      - id: dispatch", "        uses: workflows/child"]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const asset = await loadWorkflowAsset("workflows/parent-b07b");
    const frozen = await compileResolveFreezeWorkflowV4(asset, loadConfig());

    write("workflows/child.md", leafWorkflowDoc("Mutated during the freeze-to-publish window, take two."));

    const runId = randomUUID();
    const now = new Date().toISOString();
    let publishError: unknown;
    try {
      await withWorkflowRunsRepo((repo) =>
        repo.publishWorkflowRunV4({
          workflowRefs: [asset.ref],
          run: {
            id: runId,
            workflowRef: asset.ref,
            scopeKey: null,
            workflowEntryId: null,
            workflowTitle: asset.title,
            paramsJson: "{}",
            currentStepId: frozen.plan.steps[0]?.stepId ?? null,
            createdAt: now,
            updatedAt: now,
            agentHarness: null,
            agentSessionId: null,
          },
          steps: frozenStepRows(frozen.plan).map((step) => ({ runId, ...step })),
          planJson: canonicalPlanJson(frozen.plan),
          planHash: computePlanHash(frozen.plan),
          revalidateSources: () => frozen.sourceCollector.revalidate(),
        }),
      );
    } catch (error) {
      publishError = error;
    }

    expect(publishError).toBeDefined();
    const { runs } = await listWorkflowRuns();
    expect(runs).toHaveLength(0);
  });
});
