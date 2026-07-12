// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../../src/core/errors";
import { resolveStorageLocations } from "../../src/storage/locations";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { closeWorkflowDatabase, openWorkflowDatabase } from "../../src/workflows/db";
import { buildWorkflowBrief } from "../../src/workflows/exec/brief";
import { reportWorkflowUnit, settleWorkflowSpine } from "../../src/workflows/exec/report";
import { runWorkflowSteps } from "../../src/workflows/exec/run-workflow";
import { watchWorkflowRun } from "../../src/workflows/exec/watch";
import { computePlanHash } from "../../src/workflows/ir/plan-hash";
import type { WorkflowPlanGraph } from "../../src/workflows/ir/schema";
import {
  abandonWorkflowRun,
  completeWorkflowStep,
  getNextWorkflowStep,
  getWorkflowStatus,
  listWorkflowRuns,
  resumeWorkflowRun,
  startWorkflowRun,
} from "../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";

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
  writeWorkflowTestConfig();
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
function execOnWorkflowDb(sql: string, ...params: Array<string | number | null>): void {
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
    expect(plan.irVersion).toBe(3);
    expect(plan.steps[0].root?.kind).toBe("unit");
    expect(plan.execution?.engines["test-agent"]?.kind).toBe("agent");
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

  test("a legacy run (NULL plan_json) is inspection-only and points to abandon", async () => {
    writeWorkflow("legacy", "Do the legacy thing.");
    const started = await startWorkflowRun("workflow:legacy", {});

    // Simulate a run created before migration 006: no frozen plan on the row.
    execOnWorkflowDb(
      "UPDATE workflow_runs SET plan_json = NULL, plan_hash = NULL, plan_ir_version = NULL WHERE id = ?",
      started.run.id,
    );

    let dispatches = 0;
    await expect(
      runWorkflowSteps({
        target: started.run.id,
        dispatcher: async () => {
          dispatches++;
          return { ok: true, text: "must not run" };
        },
      }),
    ).rejects.toThrow(new RegExp(`${started.run.id}.*inspection-only.*workflow abandon`, "s"));
    expect(dispatches).toBe(0);
  });

  test("historical IR command matrix is inspection/abandon only with the exact unsupported code", async () => {
    writeWorkflow("old-matrix", "Do old work.");
    const started = await startWorkflowRun("workflow:old-matrix", {});
    execOnWorkflowDb(
      "UPDATE workflow_runs SET plan_json = ?, plan_hash = NULL, plan_ir_version = 2 WHERE id = ?",
      '{"irVersion":2}',
      started.run.id,
    );

    const status = await getWorkflowStatus(started.run.id);
    expect(status.run.executionSupport).toBe("unsupported-version");
    expect((await getWorkflowStatus(started.run.id, { includeUnits: true })).units).toEqual([]);
    expect((await listWorkflowRuns()).runs.find((run) => run.id === started.run.id)?.executionSupport).toBe(
      "unsupported-version",
    );
    expect((await watchWorkflowRun({ runId: started.run.id })).status).toBe("active");

    const expectUnsupported = async (operation: Promise<unknown>): Promise<void> => {
      try {
        await operation;
        throw new Error("expected unsupported workflow IR rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(UsageError);
        expect((error as UsageError).code).toBe("WORKFLOW_IR_VERSION_UNSUPPORTED");
      }
    };
    await expectUnsupported(getNextWorkflowStep(started.run.id));
    await expectUnsupported(buildWorkflowBrief(started.run.id));
    await expectUnsupported(
      reportWorkflowUnit({ target: started.run.id, unitId: "only-step:solo", status: "running" }),
    );
    await expectUnsupported(settleWorkflowSpine({ target: started.run.id, summaryJudge: null }));
    await expectUnsupported(completeWorkflowStep({ runId: started.run.id, stepId: "only-step", status: "blocked" }));
    await expectUnsupported(resumeWorkflowRun(started.run.id));
    await expectUnsupported(runWorkflowSteps({ target: started.run.id, summaryJudge: null }));

    const abandoned = await abandonWorkflowRun(started.run.id);
    expect(abandoned.run.status).toBe("failed");
  });

  test("malformed historical rows with null, v2, or future attribution can abandon; attributable v3 cannot", async () => {
    const cases = [
      { name: "malformed-null", version: null },
      { name: "malformed-v2", version: 2 },
      { name: "malformed-future", version: 4 },
    ];
    for (const item of cases) {
      writeWorkflow(item.name, "Historical work.");
      const started = await startWorkflowRun(`workflow:${item.name}`, {});
      execOnWorkflowDb(
        "UPDATE workflow_runs SET plan_json = ?, plan_hash = NULL, plan_ir_version = ? WHERE id = ?",
        "{malformed",
        item.version,
        started.run.id,
      );
      expect((await abandonWorkflowRun(started.run.id)).run.status).toBe("failed");
    }

    writeWorkflow("malformed-v3", "Protected work.");
    const v3 = await startWorkflowRun("workflow:malformed-v3", {});
    execOnWorkflowDb(
      "UPDATE workflow_runs SET plan_json = ?, plan_hash = NULL, plan_ir_version = 3 WHERE id = ?",
      "{malformed",
      v3.run.id,
    );
    await expect(abandonWorkflowRun(v3.run.id)).rejects.toThrow(/corrupt frozen plan/);
    expect((await getWorkflowStatus(v3.run.id)).run.status).toBe("active");
  });

  test("bad hash and spine mismatch are rejected before any workflow mutation", async () => {
    writeWorkflow("preflight", "Do immutable work.");
    const started = await startWorkflowRun("workflow:preflight", {});
    const beforeRun = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    const beforeSteps = await withWorkflowRunsRepo((repo) => repo.getStepsForRun(started.run.id));

    execOnWorkflowDb("UPDATE workflow_runs SET plan_hash = ? WHERE id = ?", "0".repeat(64), started.run.id);
    await expect(
      completeWorkflowStep({ runId: started.run.id, stepId: "only-step", status: "blocked" }),
    ).rejects.toThrow(/integrity check failed/);
    await expect(abandonWorkflowRun(started.run.id)).rejects.toThrow(/integrity check failed/);

    const afterBadHashRun = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    const afterBadHashSteps = await withWorkflowRunsRepo((repo) => repo.getStepsForRun(started.run.id));
    expect(afterBadHashRun?.status).toBe(beforeRun?.status);
    expect(afterBadHashRun?.updated_at).toBe(beforeRun?.updated_at);
    expect(afterBadHashSteps).toEqual(beforeSteps);

    const valid = beforeRun;
    if (!valid?.plan_hash) throw new Error("fixture requires a plan hash");
    execOnWorkflowDb("UPDATE workflow_runs SET plan_hash = ? WHERE id = ?", valid.plan_hash, started.run.id);
    execOnWorkflowDb(
      "UPDATE workflow_run_steps SET instructions = ? WHERE run_id = ? AND step_id = ?",
      "tampered instructions",
      started.run.id,
      "only-step",
    );
    await expect(
      completeWorkflowStep({ runId: started.run.id, stepId: "only-step", status: "blocked" }),
    ).rejects.toThrow(/corrupt durable step spine/);
    expect((await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id)))?.status).toBe("active");
    expect((await withWorkflowRunsRepo((repo) => repo.getStep(started.run.id, "only-step")))?.status).toBe("pending");
  });
});
