// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A parent run's frozen plan embeds its child workflow's plan: editing the
 * child source after the parent published cannot change what the parent runs.
 * Integration-level: it re-reads the stored run from `state.db`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../src/core/config/config";
import { akmIndex } from "../../src/indexer/indexer";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import type { FrozenWorkflowTarget } from "../../src/workflows/plan";
import { decodeWorkflowPlan } from "../../src/workflows/runtime/run-plan";
import { startWorkflowRun } from "../../src/workflows/runtime/runs";
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

function stepTarget(plan: ReturnType<typeof decodeWorkflowPlan>, index: number): FrozenWorkflowTarget | undefined {
  const root = plan.steps[index]?.root;
  if (!root) return undefined;
  return root.kind === "map" ? root.template.frozenTarget : root.frozenTarget;
}

/**
 * Narrows a `FrozenWorkflowTarget` to its `child-workflow` member. Isolated here
 * (mirroring tests/workflows/child-workflow-freeze.test.ts's identical helper)
 * so the narrowing lives in one place instead of at every call site across this
 * file.
 */
function childWorkflowFields(target: FrozenWorkflowTarget | undefined): {
  readonly planHash: string;
} {
  if (!target) throw new Error("childWorkflowFields: target is undefined");
  // `FrozenChildWorkflowTarget` is a discriminated union member (schema-v4.ts):
  // `command`/`shell`/`script` do not carry `.planHash`, so TypeScript only
  // admits the access below once `kind` narrows `target`.
  if (target.kind !== "child-workflow") {
    throw new Error(`childWorkflowFields: expected a child-workflow target, got ${target.kind}`);
  }
  return {
    planHash: target.planHash,
  };
}

// ── editing child source AFTER publication cannot change the ─────────────
// ── already-frozen parent (row B-06) ────────────────────────────────────────

describe("editing child source after parent publication does not change the parent's frozen child plan (row B-06)", () => {
  test("re-reading the stored run's plan_json shows the ORIGINAL child content, byte-identical, not the edited one", async () => {
    write("workflows/child.md", leafWorkflowDoc());
    writeParent("parent-b06", ["      - id: dispatch", "        uses: workflows/child"]);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const started = await startWorkflowRun("workflows/parent-b06");
    const originalRow = await planRow(started.run.id);
    const originalPlan = decodeWorkflowPlan(JSON.parse(originalRow?.plan_json ?? "null"));
    const originalFields = childWorkflowFields(stepTarget(originalPlan, 0));

    // Edit the child source on disk AFTER the parent has already published.
    write("workflows/child.md", leafWorkflowDoc("Do DIFFERENT work, edited after publication."));

    const rereadRow = await planRow(started.run.id);
    expect(rereadRow?.plan_json).toBe(originalRow?.plan_json);
    const rereadPlan = decodeWorkflowPlan(JSON.parse(rereadRow?.plan_json ?? "null"));
    const rereadFields = childWorkflowFields(stepTarget(rereadPlan, 0));
    expect(rereadFields.planHash).toBe(originalFields.planHash);
  });
});
