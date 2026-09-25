// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { openStateDatabase } from "../../../src/core/state-db";
import { resolveStorageLocations } from "../../../src/storage/locations";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import { computePlanHash } from "../../../src/workflows/ir/plan-hash";
import type { WorkflowPlanGraphV4 } from "../../../src/workflows/ir/schema-v4";
import {
  abandonWorkflowRun,
  completeWorkflowStep,
  getNextWorkflowStep,
  getWorkflowStatus,
  listWorkflowRuns,
  resumeWorkflowRun,
  startWorkflowRun,
} from "../../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../../_helpers/sandbox";

/**
 * Frozen-plan contract:
 *
 *   - `workflow start` compiles the plan ONCE and persists `plan_json` +
 *     `plan_hash` on the run row, in the same transaction as the insert.
 *   - `workflow run` executes the FROZEN plan — a mid-run edit of the asset
 *     cannot change behavior (a resume only warns that the source changed).
 *   - `plan_ir_version` and `plan_hash` are informational: a stored plan that
 *     decodes runs, whatever they say.
 *   - A plan that cannot be decoded (or is missing) is never rebuilt from the
 *     mutable workflow asset: the run is abandoned with a message naming how
 *     to start afresh — a status change, not an exception.
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
    "type: workflow",
    "description: Frozen-plan test workflow",
    "steps:",
    "  - id: only-step",
    "---",
    "",
    "## only-step",
    "",
    instructions,
    "",
  ].join("\n");
  fs.writeFileSync(file, content, "utf8");
  return file;
}

/** Direct-SQL escape hatch for simulating legacy rows / journal tampering. */
function execOnWorkflowDb(sql: string, ...params: Array<string | number | null>): void {
  const db = openStateDatabase(resolveStorageLocations().stateDb);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

describe("plan freezing at workflow start (migration 006)", () => {
  test("a fresh run persists plan_json + plan_hash, and the hash verifies the JSON", async () => {
    writeWorkflow("freeze-me", "Do the frozen thing.");
    const started = await startWorkflowRun("workflows/freeze-me", {});

    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    expect(row?.plan_json).toBeTruthy();
    expect(row?.plan_hash).toBeTruthy();

    const plan = JSON.parse(row?.plan_json ?? "") as WorkflowPlanGraphV4;
    expect(plan.steps.map((s) => s.stepId)).toEqual(["only-step"]);
    expect(plan.irVersion).toBe(5);
    if (plan.irVersion !== 5) throw new Error("fresh starts must persist plan irVersion 5");
    expect(plan.steps[0]!.root?.kind).toBe("unit");
    expect(Object.hasOwn(plan.execution, "engines")).toBe(false);
    const root = plan.steps[0]!.root;
    if (!root || root.kind !== "unit") throw new Error("expected one current runtime unit");
    expect(root.frozenTarget.kind).toBe("command");
    if (root.frozenTarget.kind === "command") {
      expect(root.frozenTarget.request.engine.name).toBe("test-agent");
      expect(root.frozenTarget.runner.kind).toBe("sdk");
    }
    expect(computePlanHash(plan)).toBe(row?.plan_hash ?? "");
  });

  test("workflow run executes the FROZEN plan even after the asset file is edited mid-run", async () => {
    const file = writeWorkflow("frozen-semantics", "Do the ORIGINAL thing.");
    const started = await startWorkflowRun("workflows/frozen-semantics", {});

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
    expect(result.warnings?.some((w) => w.includes("has changed since this run was frozen"))).toBe(true);
  });

  test(`body instructions containing literal \${{ … }} pass through verbatim (stable contract)`, async () => {
    // Peer-review regression, preserved under the unified format: body prose is
    // opaque data, never scanned for `${{ … }}` grammar — only frontmatter
    // whole-value positions (map.over/route.input/inputs) carry the reference
    // grammar (spec §2.3). A literal `${{ github.sha }}` (GitHub Actions
    // syntax) in a step's instructions must dispatch byte-exact, never parsed
    // or substituted.
    writeWorkflow(
      "gha-doc",
      `Deploy the build for commit \${{ github.sha }}. Do not resolve \${{ params.tag }} either.`,
    );
    const started = await startWorkflowRun("workflows/gha-doc", { tag: "v1" });

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

  test("the stored plan_json is what runs — plan_hash does not gate it", async () => {
    writeWorkflow("edited-plan", "Do the honest thing.");
    const started = await startWorkflowRun("workflows/edited-plan", {});

    // Edit the journaled plan while leaving the (now mismatched) hash in place.
    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    const edited = (row?.plan_json ?? "").replaceAll("Do the honest thing.", "Do the stored thing.");
    execOnWorkflowDb("UPDATE workflow_runs SET plan_json = ? WHERE id = ?", edited, started.run.id);

    const prompts: string[] = [];
    const result = await runWorkflowSteps({
      target: started.run.id,
      dispatcher: async (req) => {
        prompts.push(req.prompt);
        return { ok: true, text: "done" };
      },
    });
    expect(result.run.status).toBe("completed");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Do the stored thing.");
  });

  test("an older plan runs: plan_ir_version and plan_hash are informational", async () => {
    writeWorkflow("older-plan", "Do work.");
    const started = await startWorkflowRun("workflows/older-plan", {});
    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    // An older release's row: a lower irVersion on the row AND in the plan
    // bytes, non-canonical JSON, and a hash that matches nothing.
    const older = JSON.stringify({ ...JSON.parse(row?.plan_json ?? "{}"), irVersion: 4 }, null, 2);
    execOnWorkflowDb(
      "UPDATE workflow_runs SET plan_json = ?, plan_hash = ?, plan_ir_version = 4 WHERE id = ?",
      older,
      "0".repeat(64),
      started.run.id,
    );

    expect((await getWorkflowStatus(started.run.id)).run.planIrVersion).toBe(4);
    expect((await listWorkflowRuns()).runs.find((run) => run.id === started.run.id)?.planIrVersion).toBe(4);
    expect((await getNextWorkflowStep(started.run.id)).step?.id).toBe("only-step");

    let dispatches = 0;
    const result = await runWorkflowSteps({
      target: started.run.id,
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "done" };
      },
    });
    expect(result.run.status).toBe("completed");
    expect(dispatches).toBe(1);
  });

  test("an undecodable plan is abandoned with a message naming how to start afresh", async () => {
    for (const [name, planJson] of [
      ["corrupt", "{not json"],
      ["retired-shape", '{"irVersion":2}'],
    ] as const) {
      writeWorkflow(name, "Do the thing.");
      const started = await startWorkflowRun(`workflows/${name}`, {});
      execOnWorkflowDb("UPDATE workflow_runs SET plan_json = ? WHERE id = ?", planJson, started.run.id);
      const stepsBefore = await withWorkflowRunsRepo((repo) => repo.getStepsForRun(started.run.id));

      let dispatches = 0;
      const result = await runWorkflowSteps({
        target: started.run.id,
        dispatcher: async () => {
          dispatches++;
          return { ok: true, text: "must not run" };
        },
      });

      expect(dispatches).toBe(0);
      expect(result.run.status).toBe("failed");
      expect(result.stepsProcessed).toBe(0);
      const message = result.warnings?.find((w) => w.includes("cannot decode"));
      expect(message).toContain(started.run.id);
      expect(message).toContain("The run was abandoned");
      expect(message).toContain(`akm workflow run ${started.run.workflowRef}`);
      // Read surfaces keep working, and the spine is untouched.
      expect((await getWorkflowStatus(started.run.id)).run.status).toBe("failed");
      expect(await withWorkflowRunsRepo((repo) => repo.getStepsForRun(started.run.id))).toEqual(stepsBefore);
    }
  });

  test("a run without a frozen plan is abandoned the same way, once", async () => {
    writeWorkflow("missing-plan", "Do the thing.");
    const started = await startWorkflowRun("workflows/missing-plan", {});

    execOnWorkflowDb(
      "UPDATE workflow_runs SET plan_json = NULL, plan_hash = NULL, plan_ir_version = NULL WHERE id = ?",
      started.run.id,
    );
    execOnWorkflowDb(
      `INSERT INTO workflow_run_units
         (run_id, unit_id, step_id, node_id, status, started_at)
       VALUES (?, 'unit-1', 'only-step', 'only-step', 'running', '2026-01-01T00:00:00.000Z')`,
      started.run.id,
    );
    const stepsBefore = await withWorkflowRunsRepo((repo) => repo.getStepsForRun(started.run.id));
    const unitsBefore = await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(started.run.id));

    let dispatches = 0;
    const result = await runWorkflowSteps({
      target: started.run.id,
      // Retries re-open a failed step; an abandoned run has none, so it is abandoned exactly once.
      maxRetries: 2,
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "must not run" };
      },
    });
    expect(dispatches).toBe(0);
    expect(result.run.status).toBe("failed");
    expect(result.warnings?.some((w) => w.includes(`${started.run.id} has no frozen workflow plan`))).toBe(true);
    await expect(abandonWorkflowRun(started.run.id)).rejects.toThrow(/already failed/);

    const db = openStateDatabase(resolveStorageLocations().stateDb);
    try {
      expect(
        db
          .prepare("SELECT metadata_json FROM events WHERE event_type = 'workflow_abandoned'")
          .all()
          .map((event) => JSON.parse((event as { metadata_json: string }).metadata_json)),
      ).toEqual([{ runId: started.run.id }]);
    } finally {
      db.close();
    }
    expect(await withWorkflowRunsRepo((repo) => repo.getStepsForRun(started.run.id))).toEqual(stepsBefore);
    expect(await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(started.run.id))).toEqual(unitsBefore);
  });

  test("a blocked run can be abandoned and resumed without corrupting its durable spine (#847)", async () => {
    writeWorkflow("blocked-abandon-resume", "Do recoverable work.");
    const started = await startWorkflowRun("workflows/blocked-abandon-resume", {});

    const blocked = await completeWorkflowStep({
      runId: started.run.id,
      stepId: "only-step",
      status: "blocked",
    });
    if (!("run" in blocked)) {
      throw new Error("blocking a step unexpectedly returned a summary validation failure");
    }
    expect(blocked.run.status).toBe("blocked");
    expect(blocked.workflow.steps[0]?.status).toBe("blocked");

    const abandoned = await abandonWorkflowRun(started.run.id);
    expect(abandoned.run.status).toBe("failed");
    expect(abandoned.workflow.steps[0]?.status).toBe("blocked");

    const resumed = await resumeWorkflowRun(started.run.id);
    expect(resumed.run.status).toBe("active");
    expect(resumed.workflow.steps[0]?.status).toBe("pending");
  });

  test("malformed and unsupported plans can be abandoned without touching their spine", async () => {
    const cases = [
      { name: "malformed-null", version: null, status: "blocked" },
      { name: "malformed-v2", version: 2, status: "active" },
      { name: "malformed-current", version: 5, status: "active" },
      { name: "malformed-v3", version: 3, status: "active" },
    ];
    for (const item of cases) {
      writeWorkflow(item.name, "Work.");
      const started = await startWorkflowRun(`workflows/${item.name}`, {});
      execOnWorkflowDb(
        "UPDATE workflow_runs SET plan_json = ?, plan_hash = NULL, plan_ir_version = ?, status = ? WHERE id = ?",
        "{malformed",
        item.version,
        item.status,
        started.run.id,
      );
      const beforeSteps = await withWorkflowRunsRepo((repo) => repo.getStepsForRun(started.run.id));
      expect((await abandonWorkflowRun(started.run.id)).run.status).toBe("failed");
      expect(await withWorkflowRunsRepo((repo) => repo.getStepsForRun(started.run.id))).toEqual(beforeSteps);
    }
  });

  test("a mismatched plan_hash does not gate a step completion", async () => {
    writeWorkflow("bad-hash", "Do immutable work.");
    const started = await startWorkflowRun("workflows/bad-hash", {});
    execOnWorkflowDb("UPDATE workflow_runs SET plan_hash = ? WHERE id = ?", "0".repeat(64), started.run.id);
    const detail = await completeWorkflowStep({ runId: started.run.id, stepId: "only-step", status: "blocked" });
    if (!("run" in detail)) throw new Error("expected a WorkflowRunDetail, not a validation failure");
    expect(detail.run.status).toBe("blocked");
  });

  test("a stale derived spine field does not block completion", async () => {
    writeWorkflow("drifted", "Do immutable work.");
    const started = await startWorkflowRun("workflows/drifted", {});

    execOnWorkflowDb(
      "UPDATE workflow_run_steps SET instructions = ? WHERE run_id = ? AND step_id = ?",
      "stale instructions",
      started.run.id,
      "only-step",
    );
    const detail = await completeWorkflowStep({ runId: started.run.id, stepId: "only-step", status: "blocked" });
    if (!("run" in detail)) throw new Error("expected a WorkflowRunDetail, not a validation failure");
    expect(detail.run.status).toBe("blocked");
    expect((await withWorkflowRunsRepo((repo) => repo.getStep(started.run.id, "only-step")))?.status).toBe("blocked");
  });
});
