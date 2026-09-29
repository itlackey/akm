// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * MULTI-PROCESS run-lock chaos (single-driver invariant) — the cross-process
 * counterpart to the in-process scenarios in run-lock.test.ts. Two GENUINE
 * `bun` processes drive the SAME run against ONE shared state.db:
 *
 *   1. Exactly one process drives. A winner takes the run's lock file and
 *      blocks mid-dispatch; a second process spawned against the same run is
 *      refused UP FRONT with exit 75, its stderr naming the winner's pid, and
 *      it dispatches nothing (proven by per-unit dispatch marker files
 *      carrying only the winner's pid).
 *   2. The winner is SIGKILLed mid-run (no `finally` runs — the lock file is
 *      left behind). Its pid is dead, so a fresh process reclaims the lock at
 *      once and drives the run to completion, REUSING the units the winner
 *      already completed (their marker files stay at one dispatch) and
 *      re-dispatching only the interrupted + never-started units.
 *
 * Synchronization is on marker files + journal polling with generous timeouts,
 * never a bare sleep; dispatch + gate judging are fake env-driven seams, so no
 * real agent binary or LLM is ever invoked.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import { workflowRunLockPath } from "../../../src/workflows/exec/run-workflow";
import { getWorkflowStatus, startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";
import {
  allDispatchPids,
  bunAvailable,
  dispatchCount,
  dispatchPids,
  holdStartExists,
  pollUntil,
  spawnRunner,
  unitIds,
  writeProgram,
} from "../_helpers/workflow-crossproc";

const BUN = bunAvailable();

let storage: IsolatedAkmStorage;
let markerDir: string;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({
    configVersion: "0.9.0",
    engines: { "test-agent": { kind: "agent", platform: "opencode-sdk" } },
    defaults: { engine: "test-agent" },
  });
  markerDir = path.join(storage.root, "markers");
  fs.mkdirSync(markerDir, { recursive: true });
});

afterEach(() => storage.cleanup());

const FANOUT_WF = [
  "---",
  "type: workflow",
  "defaults: { engine: test-agent }",
  "params:",
  "  files: { type: array, items: { type: string } }",
  "steps:",
  "  - id: review",
  "    map:",
  "      over: params.files",
  "---",
  "",
  "## review",
  "",
  "Review the assigned item now.",
  "",
].join("\n");

describe.skipIf(!BUN)("multi-process run lock (single driver + crash reclaim)", () => {
  test("one process drives while a second exits 75 naming the holder; a SIGKILLed winner's run is reclaimed and its completed units are reused", async () => {
    writeProgram(storage.stashDir, "lease-xproc", FANOUT_WF);
    const params = { files: ["a.ts", "b.ts", "c.ts", "d.ts"] };
    const started = await startWorkflowRun("workflows/lease-xproc", params);
    expect(started.run.planIrVersion).toBe(6);
    const runId = started.run.id;
    const [ua, ub, uc, ud] = await unitIds(runId, params);

    // ── Winner: concurrency 1 makes fan-out order deterministic. It completes
    //    a.ts + b.ts, then BLOCKS forever mid-dispatch of c.ts (no release
    //    file), holding the run lock.
    const winner = spawnRunner({
      CHAOS_RUN_ID: runId,
      CHAOS_MARKER_DIR: markerDir,
      CHAOS_MAX_CONCURRENCY: "1",
      // Instructions are never interpolated (spec §2.3): the item reaches the
      // unit as attached JSON context, not spliced into the prose. Concurrency
      // 1 with `files: [a,b,c,d]` makes fan-out order deterministic, so c.ts
      // is always index 2 — match its own Item block, not a resolved phrase.
      CHAOS_HOLD_MATCH: "## Item (index 2)",
    });

    // Wait until the winner has journaled a.ts + b.ts completed AND is parked
    // in c.ts's dispatch — the lock is now provably held.
    await pollUntil(
      async () => {
        const rows = await withWorkflowRunsRepo((repo) => repo.getUnitsForStep(runId, "review"));
        const done = new Set(rows.filter((r) => r.status === "completed").map((r) => r.unit_id));
        return done.has(ua!) && done.has(ub!) && holdStartExists(markerDir, uc!);
      },
      { label: "winner completes a,b and holds c" },
    );
    expect(dispatchCount(markerDir, ua!)).toBe(1);
    expect(dispatchCount(markerDir, ub!)).toBe(1);

    expect(fs.existsSync(workflowRunLockPath(runId))).toBe(true);

    // ── Loser: a second process on the same locked run. It must refuse up
    //    front with exit 75, naming the holder pid, and dispatch nothing.
    const loser = spawnRunner({
      CHAOS_RUN_ID: runId,
      CHAOS_MARKER_DIR: markerDir,
      CHAOS_MAX_CONCURRENCY: "1",
    });
    const loserCode = await loser.done();
    expect(loserCode).toBe(75);
    expect(loser.stderr()).toContain(`pid ${winner.pid}`);
    expect(loser.stderr()).toContain("already being driven by another akm process");
    // The loser never reached the dispatcher — no marker line carries its pid.
    expect(allDispatchPids(markerDir).has(loser.pid)).toBe(false);
    // Still exactly one dispatch of a,b (the loser added nothing).
    expect(dispatchCount(markerDir, ua!)).toBe(1);
    expect(dispatchCount(markerDir, ub!)).toBe(1);

    // ── Crash: SIGKILL the winner mid-hold. No finally runs → the lock file
    //    stays on disk, naming a pid that is now dead.
    winner.kill("SIGKILL");
    await winner.done();

    // ── Fresh process: reclaims the dead holder's lock at once and drives to
    //    completion, reusing a.ts + b.ts and re-dispatching only c.ts + d.ts.
    const fresh = spawnRunner({
      CHAOS_RUN_ID: runId,
      CHAOS_MARKER_DIR: markerDir,
      CHAOS_MAX_CONCURRENCY: "1",
    });
    const freshCode = await fresh.done();
    expect(freshCode).toBe(0);

    const status = await getWorkflowStatus(runId);
    expect(status.run.status).toBe("completed");
    expect(status.workflow.steps[0]!.evidence?.output).toHaveLength(4);

    // No duplicate side effects: the completed units were dispatched ONCE
    // (winner only); the interrupted unit twice (winner + fresh); the
    // never-started unit once (fresh only).
    expect(dispatchCount(markerDir, ua!)).toBe(1);
    expect(dispatchCount(markerDir, ub!)).toBe(1);
    expect(dispatchCount(markerDir, uc!)).toBe(2);
    expect(dispatchCount(markerDir, ud!)).toBe(1);
    // a,b were the winner's; d was the fresh process's; c has one of each.
    expect(dispatchPids(markerDir, ua!)).toEqual([winner.pid]);
    expect(dispatchPids(markerDir, ud!)).toEqual([fresh.pid]);
    expect(new Set(dispatchPids(markerDir, uc!))).toEqual(new Set([winner.pid, fresh.pid]));

    // The lock is released after the fresh process exits cleanly.
    expect(fs.existsSync(workflowRunLockPath(runId))).toBe(false);
  }, 30_000);
});
