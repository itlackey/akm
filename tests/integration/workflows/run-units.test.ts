// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStateDatabase } from "../../../src/core/state-db";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import { enqueueUnitWrite } from "../../../src/workflows/exec/unit-writer";

/**
 * Migration 004 — `workflow_run_units` (per-unit persistence for the native
 * executor, orchestration plan P1) + the serialized writer queue that keeps N
 * concurrent unit completions from contending on SQLite's single writer.
 */

let tmpDir = "";
let prevDataDir: string | undefined;

const RUN_ID = "33333333-3333-4333-8333-333333333333";

function seedRun(dbPath: string): void {
  const db = openStateDatabase(dbPath);
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
          params_json, current_step_id, created_at, updated_at)
       VALUES (?, 'workflow:demo', 'dir:v1:demo', NULL, 'Demo', 'active', '{}', 'step-1', ?, ?)`,
    ).run(RUN_ID, now, now);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-run-units-"));
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

describe("workflow_run_units persistence (migration 004)", () => {
  test("insert → running → completed round-trip", async () => {
    await withWorkflowRunsRepo((repo) => {
      repo.insertUnit({
        runId: RUN_ID,
        unitId: "review[0]",
        stepId: "step-1",
        nodeId: "review.unit",
        parentUnitId: "review.map",
        phase: null,
        runner: "sdk",
        model: "deep",
        inputHash: "abc123",
        startedAt: new Date().toISOString(),
      });
      repo.finishUnit({
        runId: RUN_ID,
        unitId: "review[0]",
        status: "completed",
        resultJson: JSON.stringify({ file: "a.ts" }),
        tokens: 42,
        failureReason: null,
        sessionId: "codex-sess-abc",
        finishedAt: new Date().toISOString(),
      });
      const units = repo.getUnitsForRun(RUN_ID);
      expect(units).toHaveLength(1);
      expect(units[0].status).toBe("completed");
      expect(units[0].tokens).toBe(42);
      expect(JSON.parse(units[0].result_json ?? "{}")).toEqual({ file: "a.ts" });
      // Harness-native session id journaled opportunistically (migration 005).
      expect(units[0].session_id).toBe("codex-sess-abc");
    });
  });

  test("attempts starts at 1 and increments on every re-dispatch (crash/resume), resetting value columns (migration 008)", async () => {
    await withWorkflowRunsRepo((repo) => {
      const insert = (startedAt: string) =>
        repo.insertUnit({
          runId: RUN_ID,
          unitId: "review:solo",
          stepId: "step-1",
          nodeId: "review.unit",
          parentUnitId: null,
          phase: null,
          runner: "sdk",
          model: "deep",
          inputHash: "hash-1",
          startedAt,
        });

      // First dispatch: fresh row, attempts defaults to 1.
      insert("2026-01-01T00:00:00.000Z");
      expect(repo.getUnit(RUN_ID, "review:solo")?.attempts).toBe(1);

      // The unit reaches a terminal state with usage + a session id …
      repo.finishUnit({
        runId: RUN_ID,
        unitId: "review:solo",
        status: "failed",
        resultJson: JSON.stringify("partial"),
        tokens: 17,
        failureReason: "timeout",
        sessionId: "sess-1",
        finishedAt: "2026-01-01T00:00:05.000Z",
      });

      // … then a crash/resume re-dispatches the SAME content-derived unit_id.
      // The single row is REPLACED: value columns reset to NULL exactly as the
      // old INSERT OR REPLACE did, but attempts is INCREMENTED, not reset.
      insert("2026-01-01T00:01:00.000Z");
      const afterSecond = repo.getUnit(RUN_ID, "review:solo");
      expect(afterSecond?.attempts).toBe(2);
      expect(afterSecond?.status).toBe("running");
      expect(afterSecond?.result_json).toBeNull();
      expect(afterSecond?.tokens).toBeNull();
      expect(afterSecond?.failure_reason).toBeNull();
      expect(afterSecond?.session_id).toBeNull();
      expect(afterSecond?.finished_at).toBeNull();
      expect(afterSecond?.started_at).toBe("2026-01-01T00:01:00.000Z");

      // A third re-dispatch keeps accumulating; still exactly one row.
      insert("2026-01-01T00:02:00.000Z");
      expect(repo.getUnit(RUN_ID, "review:solo")?.attempts).toBe(3);
      expect(repo.getUnitsForRun(RUN_ID)).toHaveLength(1);
    });
  });

  test("finishUnit fails loudly when no row matches (a finish against a missing unit is never a silent no-op)", async () => {
    await withWorkflowRunsRepo((repo) => {
      // No unit was ever inserted for this (run_id, unit_id): the UPDATE matches
      // zero rows. finishUnit must THROW rather than silently no-op — a lost
      // finish would leave the unit stuck `running` and wedge resume.
      expect(() =>
        repo.finishUnit({
          runId: RUN_ID,
          unitId: "ghost:solo",
          status: "completed",
          resultJson: JSON.stringify("done"),
          tokens: null,
          failureReason: null,
          finishedAt: new Date().toISOString(),
        }),
      ).toThrow(/finishUnit updated no row.*ghost:solo/s);

      // A mismatched RUN id is caught the same way (row exists under a different run).
      repo.insertUnit({
        runId: RUN_ID,
        unitId: "real:solo",
        stepId: "step-1",
        nodeId: "n1",
        parentUnitId: null,
        phase: null,
        runner: "sdk",
        model: null,
        inputHash: "h",
        startedAt: new Date().toISOString(),
      });
      expect(() =>
        repo.finishUnit({
          runId: "00000000-0000-4000-8000-000000000000",
          unitId: "real:solo",
          status: "completed",
          resultJson: null,
          tokens: null,
          failureReason: null,
          finishedAt: new Date().toISOString(),
        }),
      ).toThrow(/finishUnit updated no row/);

      // The happy path (row present) still finishes exactly one row.
      repo.finishUnit({
        runId: RUN_ID,
        unitId: "real:solo",
        status: "completed",
        resultJson: null,
        tokens: null,
        failureReason: null,
        finishedAt: new Date().toISOString(),
      });
      expect(repo.getUnit(RUN_ID, "real:solo")?.status).toBe("completed");
    });
  });

  test("failed unit records the failure reason", async () => {
    await withWorkflowRunsRepo((repo) => {
      repo.insertUnit({
        runId: RUN_ID,
        unitId: "u1",
        stepId: "step-1",
        nodeId: "n1",
        parentUnitId: null,
        phase: null,
        runner: "agent",
        model: null,
        inputHash: null,
        startedAt: new Date().toISOString(),
      });
      repo.finishUnit({
        runId: RUN_ID,
        unitId: "u1",
        status: "failed",
        resultJson: null,
        tokens: null,
        failureReason: "timeout",
        finishedAt: new Date().toISOString(),
      });
      const units = repo.getUnitsForStep(RUN_ID, "step-1");
      expect(units[0].status).toBe("failed");
      expect(units[0].failure_reason).toBe("timeout");
      // sessionId omitted on finishUnit (optional, additive) ⇒ NULL column.
      expect(units[0].session_id).toBeNull();
    });
  });

  test("units cascade-delete with their run", async () => {
    await withWorkflowRunsRepo((repo) => {
      repo.insertUnit({
        runId: RUN_ID,
        unitId: "u1",
        stepId: null,
        nodeId: "n1",
        parentUnitId: null,
        phase: null,
        runner: null,
        model: null,
        inputHash: null,
        startedAt: new Date().toISOString(),
      });
    });
    const db = openStateDatabase(path.join(tmpDir, "state.db"));
    try {
      db.prepare("DELETE FROM workflow_runs WHERE id = ?").run(RUN_ID);
      const rows = db.prepare("SELECT * FROM workflow_run_units WHERE run_id = ?").all(RUN_ID);
      expect(rows).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

describe("serialized unit writer queue", () => {
  test("writes are strictly ordered and all persisted under concurrency", async () => {
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        enqueueUnitWrite(async () => {
          order.push(i);
          await withWorkflowRunsRepo((repo) => {
            repo.insertUnit({
              runId: RUN_ID,
              unitId: `u${i}`,
              stepId: null,
              nodeId: `n${i}`,
              parentUnitId: null,
              phase: null,
              runner: null,
              model: null,
              inputHash: null,
              startedAt: new Date().toISOString(),
            });
          });
        }),
      ),
    );
    expect(order).toEqual(Array.from({ length: 20 }, (_, i) => i));
    await withWorkflowRunsRepo((repo) => {
      expect(repo.getUnitsForRun(RUN_ID)).toHaveLength(20);
    });
  });

  test("a failing write does not wedge the queue", async () => {
    await expect(
      enqueueUnitWrite(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const result = await enqueueUnitWrite(async () => "still alive");
    expect(result).toBe("still alive");
  });
});
