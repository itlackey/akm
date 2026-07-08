// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { _setWarnSinkForTests } from "../../src/core/warn";
import { resolveStorageLocations } from "../../src/storage/locations";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { closeWorkflowDatabase, openWorkflowDatabase } from "../../src/workflows/db";
import { runWorkflowSteps } from "../../src/workflows/exec/run-workflow";
import { computePlanHash } from "../../src/workflows/ir/plan-hash";
import type { WorkflowPlanGraph } from "../../src/workflows/ir/schema";
import { startWorkflowRun } from "../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";
import { overrideSeam } from "../_helpers/seams";

/**
 * Frozen-plan contract (redesign addendum R1, migration 006):
 *
 *   - `workflow start` compiles the plan ONCE and persists `plan_json` +
 *     `plan_hash` on the run row, in the same transaction as the insert.
 *   - `workflow run` executes the FROZEN plan — the asset file is never
 *     re-read for an in-flight run, so a mid-run edit cannot change behavior.
 *   - A plan_json / plan_hash mismatch (journal tampering) fails loudly.
 *   - Legacy runs (NULL plan_json, created before migration 006) fall back to
 *     compile-from-asset with a warning and still run.
 */

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => storage.cleanup());

function writeWorkflow(name: string, instructions: string): string {
  const file = path.join(storage.stashDir, "workflows", `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = [
    "---",
    "description: Frozen-plan test workflow",
    "---",
    "",
    `# Workflow: ${name}`,
    "",
    "## Step: Only Step",
    "Step ID: only-step",
    "",
    "### Instructions",
    instructions,
    "",
  ].join("\n");
  fs.writeFileSync(file, content, "utf8");
  return file;
}

/** Direct-SQL escape hatch for simulating legacy rows / journal tampering. */
function execOnWorkflowDb(sql: string, ...params: Array<string | null>): void {
  const db = openWorkflowDatabase(resolveStorageLocations().workflowDb);
  try {
    db.prepare(sql).run(...params);
  } finally {
    closeWorkflowDatabase(db);
  }
}

describe("plan freezing at workflow start (migration 006)", () => {
  test("a fresh run persists plan_json + plan_hash, and the hash verifies the JSON", async () => {
    writeWorkflow("freeze-me", "Do the frozen thing.");
    const started = await startWorkflowRun("workflow:freeze-me", {});

    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    expect(row?.plan_json).toBeTruthy();
    expect(row?.plan_hash).toBeTruthy();

    const plan = JSON.parse(row?.plan_json ?? "") as WorkflowPlanGraph;
    expect(plan.steps.map((s) => s.stepId)).toEqual(["only-step"]);
    expect(plan.steps[0].root?.kind).toBe("agent");
    expect(computePlanHash(plan)).toBe(row?.plan_hash ?? "");

    // Lease columns exist on the row but are unset — enforcement is R2.
    expect(row?.engine_lease_until).toBeNull();
    expect(row?.engine_lease_holder).toBeNull();
  });

  test("workflow run executes the FROZEN plan even after the asset file is edited mid-run", async () => {
    const file = writeWorkflow("frozen-semantics", "Do the ORIGINAL thing.");
    const started = await startWorkflowRun("workflow:frozen-semantics", {});

    // Mid-run edit: the live asset now says something else entirely.
    writeWorkflow("frozen-semantics", "Do the EDITED thing.");
    expect(fs.readFileSync(file, "utf8")).toContain("EDITED");

    const prompts: string[] = [];
    const result = await runWorkflowSteps({
      target: started.run.id,
      dispatcher: async (req) => {
        prompts.push(req.prompt);
        return { ok: true, text: "done" };
      },
    });

    expect(result.done).toBe(true);
    expect(prompts).toHaveLength(1);
    // Old semantics: the frozen instructions dispatched, never the edited ones.
    expect(prompts[0]).toContain("Do the ORIGINAL thing.");
    expect(prompts[0]).not.toContain("Do the EDITED thing.");
  });

  test(`linear markdown instructions containing literal \${{ … }} pass through verbatim (stable contract)`, async () => {
    // Peer-review regression: classic markdown is a stable CLI contract — its
    // instructions are opaque data, never `${{ … }}` grammar. A literal
    // `${{ github.sha }}` (GitHub Actions syntax, or docs of the YAML format)
    // used to fail parseTemplate at execution and permanently fail the step.
    writeWorkflow(
      "gha-doc",
      `Deploy the build for commit \${{ github.sha }}. Do not resolve \${{ params.tag }} either.`,
    );
    const started = await startWorkflowRun("workflow:gha-doc", { tag: "v1" });

    const prompts: string[] = [];
    const result = await runWorkflowSteps({
      target: started.run.id,
      dispatcher: async (req) => {
        prompts.push(req.prompt);
        return { ok: true, text: "done" };
      },
    });

    expect(result.done).toBe(true);
    expect(prompts).toHaveLength(1);
    // Unknown roots are content, not a parse error …
    expect(prompts[0]).toContain(`\${{ github.sha }}`);
    // … and even a well-formed reference is NOT substituted on the markdown path.
    expect(prompts[0]).toContain(`\${{ params.tag }}`);
    expect(prompts[0]).not.toContain("v1.");
  });

  test("a plan_json / plan_hash mismatch is rejected with an error naming the run", async () => {
    writeWorkflow("tampered", "Do the honest thing.");
    const started = await startWorkflowRun("workflow:tampered", {});

    // Tamper with the journaled plan while leaving the hash in place.
    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    const tampered = (row?.plan_json ?? "").replace("Do the honest thing.", "Do something sneaky.");
    execOnWorkflowDb("UPDATE workflow_runs SET plan_json = ? WHERE id = ?", tampered, started.run.id);

    let dispatches = 0;
    await expect(
      runWorkflowSteps({
        target: started.run.id,
        dispatcher: async () => {
          dispatches++;
          return { ok: true, text: "must not run" };
        },
      }),
    ).rejects.toThrow(new RegExp(`${started.run.id}.*integrity check`));
    expect(dispatches).toBe(0);
  });

  test("corrupt plan_json (not valid JSON) is rejected with an error naming the run", async () => {
    writeWorkflow("corrupt", "Do the thing.");
    const started = await startWorkflowRun("workflow:corrupt", {});
    execOnWorkflowDb("UPDATE workflow_runs SET plan_json = ? WHERE id = ?", "{not json", started.run.id);

    await expect(
      runWorkflowSteps({
        target: started.run.id,
        dispatcher: async () => ({ ok: true, text: "must not run" }),
      }),
    ).rejects.toThrow(new RegExp(`${started.run.id}.*corrupt frozen plan`));
  });

  test("a legacy run (NULL plan_json) warns and falls back to compile-from-asset", async () => {
    writeWorkflow("legacy", "Do the legacy thing.");
    const started = await startWorkflowRun("workflow:legacy", {});

    // Simulate a run created before migration 006: no frozen plan on the row.
    execOnWorkflowDb("UPDATE workflow_runs SET plan_json = NULL, plan_hash = NULL WHERE id = ?", started.run.id);

    const warns: string[] = [];
    overrideSeam(_setWarnSinkForTests, (level, args) => {
      if (level === "warn") warns.push(args.map(String).join(" "));
    });

    const prompts: string[] = [];
    const result = await runWorkflowSteps({
      target: started.run.id,
      dispatcher: async (req) => {
        prompts.push(req.prompt);
        return { ok: true, text: "done" };
      },
    });

    expect(result.done).toBe(true);
    expect(prompts[0]).toContain("Do the legacy thing.");
    expect(warns.some((w) => w.includes(started.run.id) && w.includes("predates frozen plans"))).toBe(true);
  });
});
