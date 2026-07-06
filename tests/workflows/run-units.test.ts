// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { closeWorkflowDatabase, openWorkflowDatabase } from "../../src/workflows/db";
import { enqueueUnitWrite } from "../../src/workflows/exec/unit-writer";

/**
 * Migration 004 — `workflow_run_units` (per-unit persistence for the native
 * executor, orchestration plan P1) + the serialized writer queue that keeps N
 * concurrent unit completions from contending on SQLite's single writer.
 */

let tmpDir = "";
let prevDataDir: string | undefined;

const RUN_ID = "33333333-3333-4333-8333-333333333333";

function seedRun(dbPath: string): void {
  const db = openWorkflowDatabase(dbPath);
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
          params_json, current_step_id, created_at, updated_at)
       VALUES (?, 'workflow:demo', 'dir:v1:demo', NULL, 'Demo', 'active', '{}', 'step-1', ?, ?)`,
    ).run(RUN_ID, now, now);
  } finally {
    closeWorkflowDatabase(db);
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-run-units-"));
  prevDataDir = process.env.AKM_DATA_DIR;
  process.env.AKM_DATA_DIR = tmpDir;
  seedRun(path.join(tmpDir, "workflow.db"));
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
    const db = openWorkflowDatabase(path.join(tmpDir, "workflow.db"));
    try {
      db.prepare("DELETE FROM workflow_runs WHERE id = ?").run(RUN_ID);
      const rows = db.prepare("SELECT * FROM workflow_run_units WHERE run_id = ?").all(RUN_ID);
      expect(rows).toHaveLength(0);
    } finally {
      closeWorkflowDatabase(db);
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
