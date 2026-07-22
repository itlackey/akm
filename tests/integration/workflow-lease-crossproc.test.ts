// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * MULTI-PROCESS run-lease chaos (redesign addendum R2, single-driver invariant)
 * — the cross-process counterpart to the single-process, in-memory contention
 * scenarios in tests/workflows/chaos.test.ts + run-lease.test.ts. Two GENUINE
 * `bun` processes drive the SAME run against ONE shared workflow.db:
 *
 *   1. Exactly one process drives. A winner claims the lease and blocks
 *      mid-dispatch (its lease stays live via the real heartbeat); a second
 *      process spawned against the same run is refused UP FRONT, its stderr
 *      naming the live holder, and it dispatches nothing (proven by per-unit
 *      dispatch marker files carrying only the winner's pid).
 *   2. The winner is SIGKILLed mid-run (no `finally` runs — the lease is
 *      orphaned live). Once the lease TTL lapses a fresh process reclaims the
 *      run and drives it to completion, REUSING the units the winner already
 *      completed (their marker files stay at one dispatch) and re-dispatching
 *      only the interrupted + never-started units. No duplicate side effects.
 *
 * Synchronization is on marker files + journal polling with generous timeouts,
 * never a bare sleep; dispatch + gate judging are fake env-driven seams, so no
 * real agent binary or LLM is ever invoked.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { getWorkflowStatus, startWorkflowRun } from "../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";
import {
  allDispatchPids,
  bunAvailable,
  dispatchCount,
  dispatchPids,
  expireLease,
  holdStartExists,
  pollUntil,
  spawnRunner,
  unitIds,
  writeProgram,
} from "./_helpers/workflow-crossproc";

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

const FANOUT_WF = `version: 2
name: lease-xproc
defaults: { engine: test-agent }
params:
  files: { type: array, items: { type: string } }
steps:
  - id: review
    title: Review
    map:
      over: \${{ params.files }}
      reducer: collect
      unit:
        instructions: Review \${{ item }} now.
`;

describe.skipIf(!BUN)("multi-process run lease (single driver + crash reclaim)", () => {
  test("one process drives while a second is refused naming the holder; a SIGKILLed winner's run is reclaimed and its completed units are reused", async () => {
    writeProgram(storage.stashDir, "lease-xproc", FANOUT_WF);
    const params = { files: ["a.ts", "b.ts", "c.ts", "d.ts"] };
    const started = await startWorkflowRun("workflows/lease-xproc", params);
    expect(started.run.planIrVersion).toBe(3);
    const runId = started.run.id;
    const [ua, ub, uc, ud] = await unitIds(runId, params);

    // ── Winner: concurrency 1 makes fan-out order deterministic. It completes
    //    a.ts + b.ts, then BLOCKS forever mid-dispatch of c.ts (no release
    //    file), holding the lease live via the real heartbeat.
    const winner = spawnRunner({
      CHAOS_RUN_ID: runId,
      CHAOS_MARKER_DIR: markerDir,
      CHAOS_MAX_CONCURRENCY: "1",
      CHAOS_HOLD_MATCH: "Review c.ts now",
    });

    // Wait until the winner has journaled a.ts + b.ts completed AND is parked
    // in c.ts's dispatch — the lease is now provably live.
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

    const holder = await withWorkflowRunsRepo((repo) => repo.getRunById(runId));
    expect(holder?.engine_lease_holder).toBeTruthy();

    // ── Loser: a second process on the same live-leased run. It must refuse up
    //    front, naming the holder, and dispatch nothing.
    const loser = spawnRunner({
      CHAOS_RUN_ID: runId,
      CHAOS_MARKER_DIR: markerDir,
      CHAOS_MAX_CONCURRENCY: "1",
    });
    const loserCode = await loser.done();
    expect(loserCode).toBe(3);
    expect(loser.stderr()).toContain(holder?.engine_lease_holder ?? "<none>");
    expect(loser.stderr()).toMatch(/being driven by engine|run lease/);
    // The loser never reached the dispatcher — no marker line carries its pid.
    expect(allDispatchPids(markerDir).has(loser.pid)).toBe(false);
    // Still exactly one dispatch of a,b (the loser added nothing).
    expect(dispatchCount(markerDir, ua!)).toBe(1);
    expect(dispatchCount(markerDir, ub!)).toBe(1);

    // ── Crash: SIGKILL the winner mid-hold. No finally runs → the lease is
    //    orphaned live. Simulate the TTL lapsing so the run is reclaimable.
    winner.kill("SIGKILL");
    await winner.done();
    await expireLease(runId);

    // ── Fresh process: reclaims the expired lease and drives to completion,
    //    reusing a.ts + b.ts and re-dispatching only c.ts + d.ts.
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

    // The lease is released after the fresh process exits cleanly.
    const finalRow = await withWorkflowRunsRepo((repo) => repo.getRunById(runId));
    expect(finalRow?.engine_lease_holder).toBeNull();
  }, 30_000);
});
