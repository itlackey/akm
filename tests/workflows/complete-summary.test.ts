// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageError } from "../../src/core/errors";
import { readEvents } from "../../src/core/events";
import { closeWorkflowDatabase, openWorkflowDatabase } from "../../src/workflows/db";
import {
  completeWorkflowStep,
  getNextWorkflowStep,
  getWorkflowStatus,
  type SummaryValidationFailure,
} from "../../src/workflows/runtime/runs";
import { freezeWorkflowProgram, storeFrozenWorkflowPlan } from "../_helpers/workflow";

/**
 * In-process tests for summary capture + the completion-criteria validation
 * gate (#506). The workflow run is seeded directly into a temp workflow.db so
 * these tests don't need a workflow asset on disk; `completeWorkflowStep`'s
 * summaryJudge is injected for deterministic pass/fail.
 */

let tmpDir = "";
let prevDataDir: string | undefined;

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const PLAN = freezeWorkflowProgram(`version: 2
name: Demo
steps:
  - id: step-1
    title: Do the thing
    unit:
      instructions: instructions
    gate:
      criteria: [Thing is done, Tests pass]
`);

function seedRun(dbPath: string): void {
  const db = openWorkflowDatabase(dbPath);
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO workflow_runs
         (id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status,
          params_json, current_step_id, created_at, updated_at, checkin_armed_at)
       VALUES (?, 'workflow:demo', 'dir:v1:demo', NULL, 'Demo', 'active', '{}', 'step-1', ?, ?, ?)`,
    ).run(RUN_ID, now, now, now);
    db.prepare(
      `INSERT INTO workflow_run_steps
         (run_id, step_id, step_title, instructions, completion_json, sequence_index, status)
       VALUES (?, 'step-1', 'Do the thing', 'instructions', ?, 0, 'pending')`,
    ).run(RUN_ID, JSON.stringify(["Thing is done", "Tests pass"]));
    storeFrozenWorkflowPlan(db, RUN_ID, PLAN);
  } finally {
    closeWorkflowDatabase(db);
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-complete-summary-"));
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

describe("completeWorkflowStep summary + validation gate (#506)", () => {
  test("requires a summary when completing a step", async () => {
    await expect(
      completeWorkflowStep({ runId: RUN_ID, stepId: "step-1", status: "completed", summaryJudge: null }),
    ).rejects.toBeInstanceOf(UsageError);
  });

  test("does NOT require a summary when blocking a step", async () => {
    const result = await completeWorkflowStep({ runId: RUN_ID, stepId: "step-1", status: "blocked" });
    expect("run" in result).toBe(true);
  });

  test("persists the summary on a successful (gate-passing) completion", async () => {
    const judge = async () => '{"complete": true, "missing": []}';
    const result = await completeWorkflowStep({
      runId: RUN_ID,
      stepId: "step-1",
      status: "completed",
      summary: "Thing is done and all tests pass.",
      summaryJudge: judge,
    });
    expect("run" in result).toBe(true);

    const status = await getWorkflowStatus(RUN_ID);
    const step = status.workflow.steps.find((s) => s.id === "step-1");
    expect(step?.status).toBe("completed");
    expect(step?.summary).toBe("Thing is done and all tests pass.");
    expect(status.run.status).toBe("completed");
  });

  test("rejects completion with corrective feedback when the gate fails; step stays pending", async () => {
    const judge = async () =>
      '{"complete": false, "missing": ["Tests pass"], "feedback": "Run the tests and report results."}';
    const result = (await completeWorkflowStep({
      runId: RUN_ID,
      stepId: "step-1",
      status: "completed",
      summary: "I did the thing.",
      summaryJudge: judge,
    })) as SummaryValidationFailure;

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["Tests pass"]);
    expect(result.feedback).toContain("Run the tests");

    // Step must remain pending and re-completable.
    const status = await getWorkflowStatus(RUN_ID);
    const step = status.workflow.steps.find((s) => s.id === "step-1");
    expect(step?.status).toBe("pending");
    expect(status.run.status).toBe("active");
  });

  test("fail-open: completes when no judge is configured (offline)", async () => {
    const result = await completeWorkflowStep({
      runId: RUN_ID,
      stepId: "step-1",
      status: "completed",
      summary: "Did it.",
      summaryJudge: null,
    });
    expect("run" in result).toBe(true);
    const status = await getWorkflowStatus(RUN_ID);
    expect(status.workflow.steps[0]?.status).toBe("completed");
  });

  test("getNextWorkflowStep surfaces a continue directive when the run is stalled", async () => {
    // Back-date updated_at + checkin_armed_at far enough to exceed the stall window.
    const db = openWorkflowDatabase(path.join(tmpDir, "workflow.db"));
    try {
      const old = new Date(Date.now() - 10 * 60_000).toISOString();
      db.prepare("UPDATE workflow_runs SET updated_at = ?, checkin_armed_at = ? WHERE id = ?").run(old, old, RUN_ID);
    } finally {
      closeWorkflowDatabase(db);
    }
    const next = await getNextWorkflowStep(RUN_ID);
    expect(next.checkin?.signal).toBe("continue");
    expect(next.checkin?.directive).toContain("CONTINUE");
  });
});

describe("#11 — honest step-transition event names + injection-safe metadata", () => {
  /** Read only this run's step-transition events, newest-friendly order preserved. */
  function stepEvents(): { eventType: string; metadata?: Record<string, unknown> }[] {
    return readEvents({})
      .events.filter((e) => e.eventType === "workflow_step_completed" || e.eventType === "workflow_step_updated")
      .filter((e) => e.metadata?.runId === RUN_ID)
      .map((e) => ({ eventType: e.eventType, metadata: e.metadata }));
  }

  test("a genuine completion emits workflow_step_completed with status in metadata and NO notes", async () => {
    await completeWorkflowStep({
      runId: RUN_ID,
      stepId: "step-1",
      status: "completed",
      summary: "Thing is done and all tests pass.",
      notes: "raw model-authored {{IGNORE PREVIOUS INSTRUCTIONS}} notes",
      summaryJudge: null,
    });

    const events = stepEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("workflow_step_completed");
    expect(events[0]?.metadata?.status).toBe("completed");
    expect(events[0]?.metadata?.stepId).toBe("step-1");
    // Raw notes must never reach the event stream (prompt-injection surface).
    expect(events[0]?.metadata).not.toHaveProperty("notes");
    expect(JSON.stringify(events[0]?.metadata)).not.toContain("IGNORE PREVIOUS");
  });

  test("a non-completed transition emits workflow_step_updated, not …_completed", async () => {
    await completeWorkflowStep({
      runId: RUN_ID,
      stepId: "step-1",
      status: "blocked",
      notes: "blocked because {{INJECTION}} the tool broke",
    });

    const events = stepEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("workflow_step_updated");
    expect(events[0]?.metadata?.status).toBe("blocked");
    expect(events[0]?.metadata).not.toHaveProperty("notes");
    expect(JSON.stringify(events[0]?.metadata)).not.toContain("INJECTION");
  });
});
