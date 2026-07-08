// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatWorkflowNextPlain, formatWorkflowStatusPlain } from "../../src/output/text/helpers";
import { closeWorkflowDatabase, openWorkflowDatabase } from "../../src/workflows/db";
import { CHECKIN_STALL_MS } from "../../src/workflows/runtime/checkin";
import { getWorkflowStatus } from "../../src/workflows/runtime/runs";

/**
 * Check-in surfacing gaps from the check-in v2 design review:
 *  - C2: `formatWorkflowNextPlain` dropped the `checkin` directive, so plain
 *    (non-JSON) consumers never saw the CONTINUE nudge.
 *  - M1: `workflow status` never evaluated the check-in at all —
 *    `evaluateCheckin` was only called from `getNextWorkflowStep`.
 */

let tmpDir = "";
let prevDataDir: string | undefined;

const RUN_ID = "22222222-2222-4222-8222-222222222222";

function seedStalledRun(dbPath: string): void {
  const db = openWorkflowDatabase(dbPath);
  try {
    const stale = new Date(Date.now() - CHECKIN_STALL_MS * 3).toISOString();
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
          params_json, current_step_id, created_at, updated_at, checkin_armed_at,
          agent_harness, agent_session_id)
       VALUES (?, 'workflow:demo', 'dir:v1:demo', NULL, 'Demo', 'active', '{}', 'step-1', ?, ?, ?, 'claude-code', 'sess-9')`,
    ).run(RUN_ID, stale, stale, stale);
    db.prepare(
      `INSERT INTO workflow_run_steps
         (run_id, step_id, step_title, instructions, completion_json, sequence_index, status)
       VALUES (?, 'step-1', 'Do the thing', 'instructions', NULL, 0, 'pending')`,
    ).run(RUN_ID);
  } finally {
    closeWorkflowDatabase(db);
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-checkin-surfacing-"));
  prevDataDir = process.env.AKM_DATA_DIR;
  process.env.AKM_DATA_DIR = tmpDir;
  seedStalledRun(path.join(tmpDir, "workflow.db"));
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

describe("workflow status check-in evaluation (review M1)", () => {
  test("getWorkflowStatus surfaces a continue directive for a stalled active run", async () => {
    const detail = await getWorkflowStatus(RUN_ID);
    expect(detail.checkin).toBeDefined();
    expect(detail.checkin?.signal).toBe("continue");
    expect(detail.checkin?.directive).toContain("CONTINUE");
  });
});

describe("plain-text check-in surfacing (review C2)", () => {
  const checkin = {
    signal: "continue",
    directive: "CONTINUE: this workflow run has stalled with no progress. Resume immediately.",
    idleMs: 120_000,
  };
  const result = {
    run: { id: RUN_ID, status: "active", currentStepId: "step-1" },
    workflow: { ref: "workflow:demo", title: "Demo", steps: [] },
    step: { id: "step-1", title: "Do the thing", instructions: "instructions" },
    checkin,
  };

  test("formatWorkflowNextPlain includes the directive", () => {
    const text = formatWorkflowNextPlain(result as Record<string, unknown>);
    expect(text).toContain("CONTINUE:");
  });

  test("formatWorkflowStatusPlain includes the directive", () => {
    const text = formatWorkflowStatusPlain(result as Record<string, unknown>);
    expect(text).toContain("CONTINUE:");
  });

  test("formatters stay unchanged when no checkin is present", () => {
    const { checkin: _omit, ...healthy } = result;
    const text = formatWorkflowNextPlain(healthy as Record<string, unknown>);
    expect(text).not.toContain("CONTINUE:");
  });
});
