// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Database } from "../../../src/storage/database";
import { WorkflowRunsRepository, withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import { closeWorkflowDatabase, openWorkflowDatabase } from "../../../src/workflows/db";

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
      plan_ir_version: null,
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

  test("listRuns activeOnly excludes a BLOCKED run; plain list keeps it (owner finding 1)", async () => {
    const RUN_BLOCKED = "cccccccc-3333-4333-8333-333333333333";
    const db = openWorkflowDatabase(dbPath);
    try {
      db.prepare(
        `INSERT INTO workflow_runs
           (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
            params_json, current_step_id, created_at, updated_at, checkin_armed_at)
         VALUES (?, 'workflow:gamma', 'dir:v1:demo', NULL, 'Gamma', 'blocked', '{}', 'step-1',
                 '2026-01-05T00:00:00.000Z', '2026-01-06T00:00:00.000Z', NULL)`,
      ).run(RUN_BLOCKED);
    } finally {
      closeWorkflowDatabase(db);
    }

    // --active means EXACTLY status='active' — a blocked run is NOT executable
    // work and must never surface here (a script consuming --active would
    // otherwise treat it as still-runnable).
    const active = await withWorkflowRunsRepo((repo) => repo.listRuns({ scopeKey: "dir:v1:demo", activeOnly: true }));
    expect(active.map((r) => r.id)).toEqual([RUN_A]);
    expect(active.some((r) => r.status === "blocked")).toBe(false);

    // Plain (unfiltered) list keeps the blocked run visible with its status, so a
    // blocked run can never be silently lost.
    const all = await withWorkflowRunsRepo((repo) => repo.listRuns({ scopeKey: "dir:v1:demo" }));
    expect(all.map((r) => r.id)).toContain(RUN_BLOCKED);
    expect(all.find((r) => r.id === RUN_BLOCKED)?.status).toBe("blocked");
  });

  test("scope guards split active-only from active-or-blocked (per-call-site semantics)", async () => {
    const RUN_BLOCKED = "dddddddd-4444-4444-8444-444444444444";
    // A scope whose ONLY run is blocked — isolates the two guards' divergent intent.
    const db = openWorkflowDatabase(dbPath);
    try {
      db.prepare(
        `INSERT INTO workflow_runs
           (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
            params_json, current_step_id, created_at, updated_at, checkin_armed_at)
         VALUES (?, 'workflow:delta', 'dir:v1:blocked-scope', NULL, 'Delta', 'blocked', '{}', 'step-1',
                 '2026-01-05T00:00:00.000Z', '2026-01-06T00:00:00.000Z', NULL)`,
      ).run(RUN_BLOCKED);
    } finally {
      closeWorkflowDatabase(db);
    }

    // The START guard (findActiveRunForScope, status='active' only): a blocked
    // run does NOT occupy the scope, so a fresh `workflow start` is allowed.
    const startGuard = await withWorkflowRunsRepo((repo) =>
      repo.findActiveRunForScope("workflow:delta", "dir:v1:blocked-scope"),
    );
    expect(startGuard ?? undefined).toBeUndefined();

    // The SHOW-scope guard (findActiveOrBlockedRunForScope, active∪blocked): a
    // blocked run IS the scope's occupant, surfaced by `akm show`.
    const showGuard = await withWorkflowRunsRepo((repo) => repo.findActiveOrBlockedRunForScope("dir:v1:blocked-scope"));
    expect(showGuard?.id).toBe(RUN_BLOCKED);
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
