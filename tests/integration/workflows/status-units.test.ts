// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { openStateDatabase } from "../../../src/core/state-db";
import { formatWorkflowStatusPlain } from "../../../src/output/text/helpers";
import {
  type WorkflowRunsRepository,
  withWorkflowRunsRepo,
} from "../../../src/storage/repositories/workflow-runs-repository";
import { getWorkflowStatus } from "../../../src/workflows/runtime/runs";
import { type Cleanup, sandboxEnvDir } from "../../_helpers/sandbox";

/**
 * `akm workflow status --units` (#22): the honest per-unit diagnostic surface.
 * The deterministic step-evidence graph keeps only `failure_reason` for a
 * failure, dropping any diagnostic text. This surface reads the unit journal
 * directly so a human can see failure_reason + the row's result/error text —
 * WITHOUT that text ever feeding an artifact or hash.
 */

let tmpDir = "";
let cleanup: Cleanup;

const RUN_ID = "44444444-4444-4444-8444-444444444444";

function seedRun(dbPath: string): void {
  const db = openStateDatabase(dbPath);
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
          params_json, current_step_id, created_at, updated_at)
       VALUES (?, 'workflows/demo', 'dir:v1:demo', NULL, 'Demo', 'active', '{}', 'work', ?, ?)`,
    ).run(RUN_ID, now, now);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  const sandboxed = sandboxEnvDir("akm-status-units-", "AKM_DATA_DIR");
  tmpDir = sandboxed.dir;
  cleanup = sandboxed.cleanup;
  seedRun(path.join(tmpDir, "state.db"));
});

afterEach(() => {
  cleanup();
});

async function seedTwoUnits(): Promise<void> {
  await withWorkflowRunsRepo((repo) => {
    const now = new Date().toISOString();
    // A completed free-text unit: result_json holds a bare JSON string.
    const completed = reserveUnit(repo, "work:solo", "hash-ok", now);
    repo.finishUnitAttempt({
      runId: completed.run_id,
      unitId: completed.unit_id,
      attempt: completed.attempt,
      dispatchId: completed.dispatch_id,
      status: "completed",
      resultJson: JSON.stringify("the answer is 42"),
      tokens: 10,
      failureReason: null,
      sessionId: null,
      finishedAt: now,
    });
    // A failed unit: failure_reason plus partial/error text in result_json.
    const failed = reserveUnit(repo, "work:beef", "hash-bad", now);
    repo.finishUnitAttempt({
      runId: failed.run_id,
      unitId: failed.unit_id,
      attempt: failed.attempt,
      dispatchId: failed.dispatch_id,
      status: "failed",
      resultJson: JSON.stringify("boom: connection refused at line 12"),
      tokens: 3,
      failureReason: "dispatch_error",
      sessionId: null,
      finishedAt: now,
    });
  });
}

function reserveUnit(repo: WorkflowRunsRepository, unitId: string, inputHash: string, now: string) {
  return repo.reserveUnitAttempt({
    runId: RUN_ID,
    unitId,
    stepId: "work",
    nodeId: "work.unit",
    parentUnitId: null,
    phase: "unit",
    runner: "agent",
    engine: null,
    model: "deep",
    inputHash,
    now,
  }).attempt;
}

describe("workflow status --units diagnostic surface (#22)", () => {
  test("default status omits the units surface entirely", async () => {
    await seedTwoUnits();
    const detail = await getWorkflowStatus(RUN_ID);
    expect(detail.units).toBeUndefined();
  });

  test("includeUnits surfaces failure_reason and the row's diagnostic text", async () => {
    await seedTwoUnits();
    const detail = await getWorkflowStatus(RUN_ID, { includeUnits: true });
    expect(detail.units).toBeDefined();
    const byId = new Map((detail.units ?? []).map((u) => [u.unitId, u]));

    const ok = byId.get("work:solo");
    expect(ok?.status).toBe("completed");
    expect(ok?.failureReason).toBeNull();
    // A free-text result decodes to the bare string (no surrounding quotes).
    expect(ok?.diagnostic).toBe("the answer is 42");

    const bad = byId.get("work:beef");
    expect(bad?.status).toBe("failed");
    expect(bad?.failureReason).toBe("dispatch_error");
    expect(bad?.diagnostic).toBe("boom: connection refused at line 12");
  });

  test("plain-text status renders a units section with failure_reason + diagnostic", async () => {
    await seedTwoUnits();
    const detail = await getWorkflowStatus(RUN_ID, { includeUnits: true });
    const text = formatWorkflowStatusPlain(detail as unknown as Record<string, unknown>) ?? "";
    expect(text).toContain("units:");
    expect(text).toContain("work:beef");
    expect(text).toContain("failure_reason: dispatch_error");
    expect(text).toContain("diagnostic: boom: connection refused at line 12");
  });

  test("large result_json is clipped on the diagnostic surface", async () => {
    await withWorkflowRunsRepo((repo) => {
      const now = new Date().toISOString();
      const reserved = reserveUnit(repo, "work:big", "hash-big", now);
      repo.finishUnitAttempt({
        runId: reserved.run_id,
        unitId: reserved.unit_id,
        attempt: reserved.attempt,
        dispatchId: reserved.dispatch_id,
        status: "completed",
        resultJson: JSON.stringify("x".repeat(5000)),
        tokens: null,
        failureReason: null,
        sessionId: null,
        finishedAt: now,
      });
    });
    const detail = await getWorkflowStatus(RUN_ID, { includeUnits: true });
    const big = (detail.units ?? []).find((u) => u.unitId === "work:big");
    expect(big?.diagnostic?.length).toBe(2001); // 2000 chars + ellipsis
    expect(big?.diagnostic?.endsWith("…")).toBe(true);
  });
});
