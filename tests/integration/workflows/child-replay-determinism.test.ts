// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Replay determinism for a composing parent (spec docs/plans/specs/
 * p3b-child-executor.md §5.4, rows C-05…C-07), the single-process,
 * deterministic-state companion to
 * tests/integration/workflow-child-crash-windows.test.ts — mirroring
 * tests/integration/workflows/chaos.test.ts's own patterns exactly: a
 * dispatcher-call-count spy proves reuse, and a directly-seeded completed
 * journal row proves resume skips a completed composing unit.
 *
 * RED phase: the child executor is not wired yet (see the crash-windows
 * sibling file's header for the exact mechanism), so C-05/C-06 fail today —
 * not because reuse is broken, but because there is no child run for a
 * composing step to promote in the first place; the run never reaches the
 * shape these assertions describe. C-07 seeds a completed composing-unit row
 * directly — no live child needed — and pins that resume reuses it. This file
 * references only already-existing, already-typed APIs (`runWorkflowSteps`,
 * `startWorkflowRun`, `resumeWorkflowRun`, `getWorkflowStatus`,
 * `withWorkflowRunsRepo`'s `childRunsOf`/`getUnitsForStep`,
 * `computeStepWorkList`, `decodeWorkflowPlanV4`), so no `@ts-expect-error`
 * directive is needed anywhere in it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { openStateDatabase } from "../../../src/core/state-db";
import { akmIndex } from "../../../src/indexer/indexer";
import { resolveStorageLocations } from "../../../src/storage/locations";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import type { UnitDispatchRequest, UnitDispatchResult } from "../../../src/workflows/exec/native-executor";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import { computeStepWorkList } from "../../../src/workflows/exec/step-work";
import { decodeWorkflowPlanV4 } from "../../../src/workflows/ir/schema-v4";
import { getWorkflowStatus, resumeWorkflowRun, startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});

afterEach(() => storage.cleanup());

// ── Helpers ──────────────────────────────────────────────────────────────────

function write(relative: string, content: string): void {
  const file = path.join(storage.stashDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

/** Direct-SQL escape hatch for planting/tampering journal rows (mirrors chaos.test.ts's own helper). */
function execOnWorkflowDb(sql: string, ...params: Array<string | number | null>): void {
  const db = openStateDatabase(resolveStorageLocations().stateDb);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

/** Insert a terminal unit row directly — mirrors chaos.test.ts's `seedUnitRow`, adapted for a solo (non-fanout) step. */
function seedCompletedUnitRow(input: {
  runId: string;
  unitId: string;
  stepId: string;
  inputHash: string;
  resultJson: string;
}): void {
  const now = new Date().toISOString();
  execOnWorkflowDb(
    `INSERT OR REPLACE INTO workflow_run_units
       (run_id, unit_id, step_id, node_id, parent_unit_id, phase, runner, model, status,
        input_hash, result_json, tokens, failure_reason, worktree_path, started_at, finished_at, last_checkin_at)
     VALUES (?, ?, ?, ?, NULL, NULL, 'sdk', NULL, 'completed', ?, ?, NULL, NULL, NULL, ?, ?, NULL)`,
    input.runId,
    input.unitId,
    input.stepId,
    input.stepId,
    input.inputHash,
    input.resultJson,
    now,
    now,
  );
}

/** A leaf child: one plain unit, no params, no further composition. */
function writeChildLeaf(name: string): void {
  write(
    `workflows/${name}.md`,
    ["---", "type: workflow", "steps:", "  - id: work", "---", "", "## work", "", "Do the child work.", ""].join("\n"),
  );
}

/** A distinctive command a v4 task can wrap, so a follow-up step's fake-dispatcher prompt is unambiguous to match. */
function writeFinishCommand(): void {
  write("commands/replay-finish.md", "Wrap up the replay test.\n");
}

/**
 * A GitHub-shaped composing parent with a SECOND, ordinary follow-up step
 * (`finish`, via a command) — giving `runWorkflowSteps` genuine incomplete
 * work to resume after a mid-run dispatcher failure, exactly like
 * chaos.test.ts's own `FANOUT_FAIL_WF` technique, just with a composing
 * FIRST step instead of a fan-out.
 */
function writeComposingParentWithFollowup(name: string, childRef: string): void {
  write(
    `workflows/${name}.yml`,
    [
      `name: ${name}`,
      "on:",
      "  workflow_dispatch:",
      "jobs:",
      "  main:",
      "    runs-on: [self-hosted]",
      "    steps:",
      "      - id: dispatch",
      `        uses: ${childRef}`,
      "      - id: finish",
      "        uses: commands/replay-finish",
      "",
    ].join("\n"),
  );
}

/** A GitHub-shaped composing parent with ONLY the composing step (for C-07's tamper target). */
function writeSoloComposingParent(name: string, childRef: string): void {
  write(
    `workflows/${name}.yml`,
    [
      `name: ${name}`,
      "on:",
      "  workflow_dispatch:",
      "jobs:",
      "  main:",
      "    runs-on: [self-hosted]",
      "    steps:",
      "      - id: dispatch",
      `        uses: ${childRef}`,
      "",
    ].join("\n"),
  );
}

// ── C-05, C-06: a resumed parent replays a completed composing step ────────
// ── without re-driving the child ────────────────────────────────────────────

describe("a resumed parent replays a completed composing step without re-driving the child (C-05, C-06)", () => {
  test("the composing unit is REUSED from the journal on resume — the child's own leaf unit is never re-dispatched, and the composing step's evidence is byte-identical", async () => {
    writeChildLeaf("replay-leaf");
    writeFinishCommand();
    writeComposingParentWithFollowup("replay-parent", "workflows/replay-leaf");
    await akmIndex({ stashDir: storage.stashDir, full: true });
    const started = await startWorkflowRun("workflows/replay-parent", {});
    const runId = started.run.id;

    // Invocation 1: every unit succeeds except "finish", which throws (a
    // harness blowing up mid-run) — so "dispatch" (the composing step,
    // including its child's own leaf unit) fully completes, while "finish"
    // fails and the whole run ends up `failed`.
    const dispatched1 = new Set<string>();
    const result1 = await runWorkflowSteps({
      target: runId,
      maxConcurrency: 1,
      summaryJudge: null,
      dispatcher: async (req: UnitDispatchRequest): Promise<UnitDispatchResult> => {
        dispatched1.add(req.unitId);
        if (req.prompt.includes("Wrap up the replay test")) throw new Error("harness exploded on finish");
        return { ok: true, text: `did ${req.unitId}` };
      },
    });
    expect(result1.run.status).toBe("failed");

    const midStatus = await getWorkflowStatus(runId);
    const dispatchStep = midStatus.workflow.steps.find((s) => s.id === "dispatch");
    expect(dispatchStep?.status).toBe("completed");
    expect(midStatus.workflow.steps.find((s) => s.id === "finish")?.status).not.toBe("completed");
    const dispatchEvidenceBefore = JSON.stringify(dispatchStep?.evidence);

    // A REAL child run was published and driven for the composing step — not
    // merely an opaque unit that happens to target a workflow. This is what
    // makes the reuse proven below a genuine test of row C-05 (no child ever
    // exists today, since nothing yet routes a `child-workflow` target away
    // from the plain unit dispatcher — spec §3.2 — so this line is the RED
    // signal for this test).
    const childrenAfterFirstRun = await withWorkflowRunsRepo((repo) => repo.childRunsOf(runId));
    expect(childrenAfterFirstRun).toHaveLength(1);
    const childRunId = childrenAfterFirstRun[0]!.id;
    expect((await withWorkflowRunsRepo((repo) => repo.getRunById(childRunId)))?.status).toBe("completed");

    // The "finish" step's own unit id — the ONLY one that should ever be
    // handed to the dispatcher again on resume.
    const finishUnits = await withWorkflowRunsRepo((repo) => repo.getUnitsForStep(runId, "finish"));
    const finishUnitId = finishUnits[0]?.unit_id;
    if (!finishUnitId) throw new Error("expected a journaled unit row for the finish step after invocation 1");
    expect(dispatched1.has(finishUnitId)).toBe(true);
    // At least one OTHER id was dispatched too — the child's own leaf unit,
    // forwarded through the SAME injected dispatcher (spec row A-33).
    expect(dispatched1.size).toBeGreaterThan(1);

    // The composing ("dispatch") unit's own journal row, snapshotted BEFORE
    // resume — pins C-05's reuse claim directly on the journal rather than
    // only inferring it from the dispatcher call-count spy below, which is
    // structurally blind to it: once the seam is wired, the composing unit
    // never reaches UnitDispatcher in either invocation (row A-01), and a
    // re-entered driveChildWorkflowUnit on an already-completed child
    // republishes idempotently and drives nothing anyway (§3.3 step 6's
    // completed arm is a documented no-op) — so an implementation with NO
    // journal reuse at all for composing units would still pass every
    // dispatcher-count assertion here.
    const dispatchUnits = await withWorkflowRunsRepo((repo) => repo.getUnitsForStep(runId, "dispatch"));
    const composingUnitId = dispatchUnits[0]?.unit_id;
    if (!composingUnitId) throw new Error("expected a journaled unit row for the dispatch step after invocation 1");
    const composingUnitBeforeResume = await withWorkflowRunsRepo((repo) => repo.getUnit(runId, composingUnitId));
    if (!composingUnitBeforeResume) {
      throw new Error("expected the composing unit's journal row to be readable before resume");
    }

    // Resume flips the failed step back to pending; the completed "dispatch"
    // step (and its child) survive untouched.
    await resumeWorkflowRun(runId);

    // Invocation 2: a healthy dispatcher. A dispatch-count spy proves the
    // composing unit — and therefore its child's own leaf unit — is REUSED
    // (never handed to the dispatcher again), exactly mirroring
    // chaos.test.ts's own crash/resume assertion technique.
    const dispatched2 = new Set<string>();
    const result2 = await runWorkflowSteps({
      target: runId,
      maxConcurrency: 1,
      summaryJudge: null,
      dispatcher: async (req: UnitDispatchRequest): Promise<UnitDispatchResult> => {
        dispatched2.add(req.unitId);
        return { ok: true, text: `did ${req.unitId}` };
      },
    });
    expect(result2.run.status).toBe("completed");

    // Only "finish" was retried; nothing dispatched during invocation 1
    // OTHER than "finish" appears again — proving driveChildWorkflowUnit was
    // never re-entered for the composing unit (C-05).
    expect(dispatched2.has(finishUnitId)).toBe(true);
    for (const id of dispatched1) {
      if (id === finishUnitId) continue;
      expect(dispatched2.has(id)).toBe(false);
    }

    // C-05, pinned directly on the composing unit's own journal row: a
    // re-drive re-reserves the attempt (bumping `attempts` and moving
    // `started_at`/`finished_at`), so a byte-identical row is proof the
    // composing unit was REUSED from the journal (classifyUnitReuse ->
    // reuse) rather than re-attempted — unlike the dispatcher-count spy
    // above, this is blind to nothing: it holds even if a re-attempt
    // dispatched nothing new (e.g. an idempotent republish-and-no-op).
    const composingUnitAfterResume = await withWorkflowRunsRepo((repo) => repo.getUnit(runId, composingUnitId));
    expect(composingUnitAfterResume?.attempts).toBe(composingUnitBeforeResume.attempts);
    expect(composingUnitAfterResume?.started_at).toBe(composingUnitBeforeResume.started_at);
    expect(composingUnitAfterResume?.finished_at).toBe(composingUnitBeforeResume.finished_at);

    // The composing step's promoted evidence is byte-identical across the
    // crash + resume (C-06) — the child's exported result was never
    // recomputed, just re-read from the journal.
    const finalStatus = await getWorkflowStatus(runId);
    const dispatchEvidenceAfter = JSON.stringify(finalStatus.workflow.steps.find((s) => s.id === "dispatch")?.evidence);
    expect(dispatchEvidenceAfter).toBe(dispatchEvidenceBefore);

    // No second child was ever published on resume — the SAME one, once.
    const childrenAfterResume = await withWorkflowRunsRepo((repo) => repo.childRunsOf(runId));
    expect(childrenAfterResume).toHaveLength(1);
    expect(childrenAfterResume[0]?.id).toBe(childRunId);
  });
});

// ── C-07: resume skips a completed composing unit ───────────────────────────

describe("resume skips a completed composing unit whatever input_hash it recorded (C-07)", () => {
  test("the journaled child result is reused; no child is published or driven", async () => {
    writeChildLeaf("tamper-leaf");
    writeSoloComposingParent("tamper-parent", "workflows/tamper-leaf");
    await akmIndex({ stashDir: storage.stashDir, full: true });
    const started = await startWorkflowRun("workflows/tamper-parent", {});
    const runId = started.run.id;

    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(runId));
    const plan = decodeWorkflowPlanV4(JSON.parse(row?.plan_json ?? "null"));
    const work = computeStepWorkList(plan.steps[0]!, { runId, params: {}, stepOutputs: {} });
    if (!work.ok) throw new Error(work.error);
    const composingUnitId = work.list.units[0]!.journalBaseId;

    // A completed composing-unit row whose input_hash no invocation would
    // compute today (an older release's row, a hand edit).
    seedCompletedUnitRow({
      runId,
      unitId: composingUnitId,
      stepId: "dispatch",
      inputHash: "deadbeefdeadbeef",
      resultJson: JSON.stringify({ runId: "earlier-child-run-id", status: "completed" }),
    });

    const dispatched = new Set<string>();
    const result = await runWorkflowSteps({
      target: runId,
      summaryJudge: null,
      dispatcher: async (req: UnitDispatchRequest): Promise<UnitDispatchResult> => {
        dispatched.add(req.unitId);
        return { ok: true, text: "fresh" };
      },
    });

    expect(result.run.status).toBe("completed");
    expect(result.executed[0]?.ok).toBe(true);
    // The completed row IS the unit's result: no child row is published and
    // nothing dispatches.
    const children = await withWorkflowRunsRepo((repo) => repo.childRunsOf(runId));
    expect(children).toEqual([]);
    expect(dispatched.size).toBe(0);
  });
});
