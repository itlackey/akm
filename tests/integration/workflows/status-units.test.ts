// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStateDatabase } from "../../../src/core/state-db";
import { formatWorkflowStatusPlain } from "../../../src/output/text/helpers";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import { getWorkflowStatus } from "../../../src/workflows/runtime/runs";

/**
 * `akm workflow status --units` (#22): the honest per-unit diagnostic surface.
 * The deterministic step-evidence graph keeps only `failure_reason` for a
 * failure, dropping any diagnostic text. This surface reads the unit journal
 * directly so a human can see failure_reason + the row's result/error text —
 * WITHOUT that text ever feeding an artifact or hash.
 */

let tmpDir = "";
let prevDataDir: string | undefined;

const RUN_ID = "44444444-4444-4444-8444-444444444444";

function seedRun(dbPath: string): void {
  const db = openStateDatabase(dbPath);
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
          params_json, current_step_id, created_at, updated_at)
       VALUES (?, 'workflow:demo', 'dir:v1:demo', NULL, 'Demo', 'active', '{}', 'work', ?, ?)`,
    ).run(RUN_ID, now, now);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-status-units-"));
  prevDataDir = process.env.AKM_DATA_DIR;
  process.env.AKM_DATA_DIR = tmpDir;
  seedRun(path.join(tmpDir, "state.db"));
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.AKM_DATA_DIR;
  else process.env.AKM_DATA_DIR = prevDataDir;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function seedTwoUnits(): Promise<void> {
  await withWorkflowRunsRepo((repo) => {
    const now = new Date().toISOString();
    // A completed free-text unit: result_json holds a bare JSON string.
    repo.insertUnit({
      runId: RUN_ID,
      unitId: "work:solo",
      stepId: "work",
      nodeId: "work.unit",
      parentUnitId: null,
      phase: null,
      runner: "agent",
      model: "deep",
      inputHash: "hash-ok",
      startedAt: now,
    });
    repo.finishUnit({
      runId: RUN_ID,
      unitId: "work:solo",
      status: "completed",
      resultJson: JSON.stringify("the answer is 42"),
      tokens: 10,
      failureReason: null,
      sessionId: null,
      finishedAt: now,
    });
    // A failed unit: failure_reason plus partial/error text in result_json.
    repo.insertUnit({
      runId: RUN_ID,
      unitId: "work:beef",
      stepId: "work",
      nodeId: "work.unit",
      parentUnitId: null,
      phase: null,
      runner: "agent",
      model: "deep",
      inputHash: "hash-bad",
      startedAt: now,
    });
    repo.finishUnit({
      runId: RUN_ID,
      unitId: "work:beef",
      status: "failed",
      resultJson: JSON.stringify("boom: connection refused at line 12"),
      tokens: 3,
      failureReason: "dispatch_error",
      sessionId: null,
      finishedAt: now,
    });
  });
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

  // ── Codex round-3 finding B — a `running` claim gone silent past the check-in
  //    window must surface as STALE on `status --units`, matching `brief`. Before
  //    the fix, status --units only mapped raw rows, so a dead driver's unit stayed
  //    a bare `running` diagnostic with no stale flag or claim info.
  async function seedStaleClaim(claimedAtMs: number): Promise<void> {
    await withWorkflowRunsRepo((repo) => {
      const claimedAt = new Date(claimedAtMs).toISOString();
      // A driver claimed this unit `running` and never heartbeated again.
      repo.insertUnit({
        runId: RUN_ID,
        unitId: "work:dead",
        stepId: "work",
        nodeId: "work.unit",
        parentUnitId: null,
        phase: null,
        runner: "agent",
        model: "deep",
        inputHash: "hash-claim",
        startedAt: claimedAt,
        claimHolder: "driver-ghost",
        claimExpiresAt: new Date(claimedAtMs + 90_000).toISOString(),
      });
    });
  }

  test("finding B: an expired `running` claim surfaces as stale with its claim holder", async () => {
    await seedTwoUnits();
    const claimedAtMs = Date.parse("2026-01-01T00:00:00.000Z");
    await seedStaleClaim(claimedAtMs);
    // Evaluate well past the 90s window (deterministic `now` injection).
    const now = claimedAtMs + 200_000;
    const detail = await getWorkflowStatus(RUN_ID, { includeUnits: true, now });
    const byId = new Map((detail.units ?? []).map((u) => [u.unitId, u]));

    const dead = byId.get("work:dead");
    expect(dead?.status).toBe("running");
    expect(dead?.stale).toBe(true);
    expect(dead?.claimHolder).toBe("driver-ghost");
    expect((dead?.staleIdleMs ?? 0) >= 90_000).toBe(true);

    // A terminal unit is never stale — the flag is scoped to live claims.
    expect(byId.get("work:solo")?.stale).toBe(false);

    // Plain-text formatter renders the stale line + holder.
    const text = formatWorkflowStatusPlain(detail as unknown as Record<string, unknown>) ?? "";
    expect(text).toContain("stale:");
    expect(text).toContain("claimed by driver-ghost");
  });

  test("finding B: a freshly-heartbeated claim is NOT stale (within the window)", async () => {
    const claimedAtMs = Date.parse("2026-01-01T00:00:00.000Z");
    await seedStaleClaim(claimedAtMs);
    // Evaluate 10s later — inside the 90s window.
    const detail = await getWorkflowStatus(RUN_ID, { includeUnits: true, now: claimedAtMs + 10_000 });
    const dead = (detail.units ?? []).find((u) => u.unitId === "work:dead");
    expect(dead?.stale).toBe(false);
    expect(dead?.claimHolder).toBe("driver-ghost");
  });

  test("large result_json is clipped on the diagnostic surface", async () => {
    await withWorkflowRunsRepo((repo) => {
      const now = new Date().toISOString();
      repo.insertUnit({
        runId: RUN_ID,
        unitId: "work:big",
        stepId: "work",
        nodeId: "work.unit",
        parentUnitId: null,
        phase: null,
        runner: "agent",
        model: "deep",
        inputHash: "hash-big",
        startedAt: now,
      });
      repo.finishUnit({
        runId: RUN_ID,
        unitId: "work:big",
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
