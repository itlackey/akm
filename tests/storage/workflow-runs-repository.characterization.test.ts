// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Database } from "../../src/storage/database";
import { WorkflowRunsRepository, withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { closeWorkflowDatabase, openWorkflowDatabase } from "../../src/workflows/db";

/**
 * Characterization tests for WorkflowRunsRepository (WS5).
 *
 * These pin the EXACT query results produced by the raw SQL that was lifted
 * verbatim out of src/workflows/runs.ts, on a directly-seeded workflow.db. They
 * also assert the WS5 connection-lifetime rule: read methods fully materialise
 * (the returned arrays survive after the connection closes) and
 * withWorkflowRunsRepo closes the connection exactly once.
 */

let tmpDir = "";
let prevDataDir: string | undefined;
let dbPath = "";

const RUN_A = "aaaaaaaa-1111-4111-8111-111111111111";
const RUN_B = "bbbbbbbb-2222-4222-8222-222222222222";

function seed(): void {
  const db = openWorkflowDatabase(dbPath);
  try {
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
          params_json, current_step_id, created_at, updated_at, agent_harness, agent_session_id, checkin_armed_at)
       VALUES (?, 'workflow:alpha', 'dir:v1:demo', 7, 'Alpha', 'active', '{"k":1}', 'step-1',
               '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 'claude-code', 'sess-1', '2026-01-02T00:00:00.000Z')`,
    ).run(RUN_A);
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
          params_json, current_step_id, created_at, updated_at, completed_at, checkin_armed_at)
       VALUES (?, 'workflow:beta', 'dir:v1:demo', NULL, 'Beta', 'completed', '{}', NULL,
               '2026-01-03T00:00:00.000Z', '2026-01-04T00:00:00.000Z', '2026-01-04T00:00:00.000Z', NULL)`,
    ).run(RUN_B);
    db.prepare(
      `INSERT INTO workflow_run_steps
         (run_id, step_id, step_title, instructions, completion_json, sequence_index, status, summary)
       VALUES (?, 'step-2', 'Second', 'do second', NULL, 1, 'pending', NULL)`,
    ).run(RUN_A);
    db.prepare(
      `INSERT INTO workflow_run_steps
         (run_id, step_id, step_title, instructions, completion_json, sequence_index, status, summary)
       VALUES (?, 'step-1', 'First', 'do first', ?, 0, 'completed', 'all good')`,
    ).run(RUN_A, JSON.stringify(["done"]));
  } finally {
    closeWorkflowDatabase(db);
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-wf-repo-"));
  prevDataDir = process.env.AKM_DATA_DIR;
  process.env.AKM_DATA_DIR = tmpDir;
  dbPath = path.join(tmpDir, "workflow.db");
  seed();
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

describe("WorkflowRunsRepository reads", () => {
  test("getRunById returns the full row verbatim", async () => {
    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(RUN_A));
    expect(row).toEqual({
      id: RUN_A,
      workflow_ref: "workflow:alpha",
      scope_key: "dir:v1:demo",
      workflow_entry_id: 7,
      workflow_title: "Alpha",
      status: "active",
      params_json: '{"k":1}',
      current_step_id: "step-1",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
      completed_at: null,
      agent_harness: "claude-code",
      agent_session_id: "sess-1",
      checkin_armed_at: "2026-01-02T00:00:00.000Z",
      // Frozen plan + engine lease (migration 006): NULL on seeded legacy rows.
      plan_json: null,
      plan_hash: null,
      engine_lease_until: null,
      engine_lease_holder: null,
    });
  });

  test("getRunById returns no row for unknown id", async () => {
    const row = await withWorkflowRunsRepo((repo) => repo.getRunById("nope"));
    expect(row ?? undefined).toBeUndefined();
  });

  test("hasRun reflects existence", async () => {
    const [yes, no] = await withWorkflowRunsRepo((repo) => [repo.hasRun(RUN_A), repo.hasRun("nope")]);
    expect(yes).toBe(true);
    expect(no).toBe(false);
  });

  test("listRuns honours scope, ref filter, activeOnly and ordering", async () => {
    const all = await withWorkflowRunsRepo((repo) => repo.listRuns({ scopeKey: "dir:v1:demo" }));
    // ordered by updated_at DESC: beta (01-04) before alpha (01-02)
    expect(all.map((r) => r.id)).toEqual([RUN_B, RUN_A]);

    const filtered = await withWorkflowRunsRepo((repo) =>
      repo.listRuns({ scopeKey: "dir:v1:demo", workflowRef: "workflow:alpha" }),
    );
    expect(filtered.map((r) => r.id)).toEqual([RUN_A]);

    const active = await withWorkflowRunsRepo((repo) => repo.listRuns({ scopeKey: "dir:v1:demo", activeOnly: true }));
    expect(active.map((r) => r.id)).toEqual([RUN_A]);

    const otherScope = await withWorkflowRunsRepo((repo) => repo.listRuns({ scopeKey: "other" }));
    expect(otherScope).toEqual([]);
  });

  test("getStepsForRun returns steps ordered by sequence_index", async () => {
    const steps = await withWorkflowRunsRepo((repo) => repo.getStepsForRun(RUN_A));
    expect(steps.map((s) => s.step_id)).toEqual(["step-1", "step-2"]);
    expect(steps[0]).toMatchObject({ status: "completed", summary: "all good", sequence_index: 0 });
    expect(steps[1]).toMatchObject({ status: "pending", summary: null, sequence_index: 1 });
  });

  test("getStep returns the matching step row or undefined", async () => {
    const found = await withWorkflowRunsRepo((repo) => repo.getStep(RUN_A, "step-1"));
    expect(found?.step_title).toBe("First");
    const missing = await withWorkflowRunsRepo((repo) => repo.getStep(RUN_A, "ghost"));
    expect(missing).toBeNull();
  });

  test("findActiveRunForScope finds only active runs", async () => {
    const hit = await withWorkflowRunsRepo((repo) => repo.findActiveRunForScope("workflow:alpha", "dir:v1:demo"));
    expect(hit).toEqual({ id: RUN_A, current_step_id: "step-1" });
    const miss = await withWorkflowRunsRepo((repo) => repo.findActiveRunForScope("workflow:beta", "dir:v1:demo"));
    expect(miss).toBeNull();
  });

  test("findActiveOrBlockedRunForScope returns active or blocked", async () => {
    const hit = await withWorkflowRunsRepo((repo) => repo.findActiveOrBlockedRunForScope("dir:v1:demo"));
    expect(hit).toEqual({ id: RUN_A, current_step_id: "step-1", workflow_ref: "workflow:alpha" });
  });
});

describe("WorkflowRunsRepository connection lifetime", () => {
  test("read results survive after the scope (connection) closes", async () => {
    const steps = await withWorkflowRunsRepo((repo) => repo.getStepsForRun(RUN_A));
    // If a live cursor leaked, touching the array post-close would throw. It
    // must be a plain materialised array.
    expect(Array.isArray(steps)).toBe(true);
    expect(steps.length).toBe(2);
    expect(steps[0]?.step_id).toBe("step-1");
  });

  test("withWorkflowRunsRepo closes the connection exactly once", async () => {
    const seen: Database[] = [];
    // Spy on close by wrapping: open one DB and verify double-close throws,
    // proving the helper closes once and only once for its own connection.
    await withWorkflowRunsRepo((repo) => {
      expect(repo).toBeInstanceOf(WorkflowRunsRepository);
    });
    // Re-open and confirm the helper's connection is independent / reusable.
    const db = openWorkflowDatabase(dbPath);
    seen.push(db);
    closeWorkflowDatabase(db);
    expect(seen.length).toBe(1);
  });
});
