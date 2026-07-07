// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * MULTI-PROCESS crash-window resume — a real `bun` driver is SIGKILLed at a
 * precise durable window, and a fresh process converges the run exactly once.
 * The single-process, deterministic-state versions live in
 * tests/workflows/chaos.test.ts; these prove the SAME contracts survive a real
 * OS kill (no `finally`, orphaned lease, half-written journal) against shared
 * storage.
 *
 *   Window A — "unit row inserted running, before finish": the dispatcher
 *   writes its marker (the row is journaled `running`) then blocks; the parent
 *   kills it there. Resume re-dispatches that ONE unit exactly once and
 *   completes; a further invocation is a no-op (exactly-once convergence).
 *
 *   Window B — "units complete, before the step completes": the dispatcher
 *   finishes the unit, then the completion-gate judge blocks (the gate row is
 *   already journaled `running`); the parent kills it there. Resume REUSES the
 *   completed unit (no re-dispatch), replaces the dangling gate row, and
 *   finalizes the step — exactly one gate row, promoted once.
 *
 * Synchronization is on marker files + journal polling; dispatch + judging are
 * fake env-driven seams (no agent binary, no LLM).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { getWorkflowStatus, startWorkflowRun } from "../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";
import {
  bunAvailable,
  dispatchCount,
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
  markerDir = path.join(storage.root, "markers");
  fs.mkdirSync(markerDir, { recursive: true });
});

afterEach(() => storage.cleanup());

const SOLO_WF = `version: 1
name: crash-solo
steps:
  - id: work
    title: Work
    unit:
      instructions: Do the work now.
`;

const GATE_WF = `version: 1
name: crash-gate
steps:
  - id: work
    title: Work
    unit:
      instructions: Do the work now.
    gate:
      criteria: [the work is thorough]
`;

describe.skipIf(!BUN)("multi-process crash windows", () => {
  test(
    "Window A: SIGKILL after the unit row is running but before finish → resume re-dispatches it exactly once and completes",
    async () => {
      writeProgram(storage.stashDir, "crash-solo", SOLO_WF);
      const started = await startWorkflowRun("workflow:crash-solo", {});
      const runId = started.run.id;
      const [unit] = await unitIds(runId, {});

      // Driver dispatches the unit (row journaled `running`, marker written) and
      // blocks there — the parent kills it inside the dispatch window.
      const crasher = spawnRunner({
        CHAOS_RUN_ID: runId,
        CHAOS_MARKER_DIR: markerDir,
        CHAOS_HOLD_MATCH: "Do the work now",
      });
      await pollUntil(() => holdStartExists(markerDir, unit), { label: "unit is dispatching" });
      // The durable state at the kill point: exactly the running window.
      const midRow = await withWorkflowRunsRepo((repo) => repo.getUnit(runId, unit));
      expect(midRow?.status).toBe("running");
      expect(dispatchCount(markerDir, unit)).toBe(1);

      crasher.kill("SIGKILL");
      await crasher.done();
      await expireLease(runId);

      // Resume: a fresh process re-dispatches the interrupted unit — once.
      const resume = spawnRunner({ CHAOS_RUN_ID: runId, CHAOS_MARKER_DIR: markerDir });
      expect(await resume.done()).toBe(0);

      const status = await getWorkflowStatus(runId);
      expect(status.run.status).toBe("completed");
      // Dispatched twice total (killed attempt + the single resume attempt); the
      // journal's attempts counter agrees — no third dispatch.
      expect(dispatchCount(markerDir, unit)).toBe(2);
      const finalRow = await withWorkflowRunsRepo((repo) => repo.getUnit(runId, unit));
      expect(finalRow?.status).toBe("completed");
      expect(finalRow?.attempts).toBe(2);

      // A further invocation is a pure no-op — the completed run dispatches nothing.
      const noop = spawnRunner({ CHAOS_RUN_ID: runId, CHAOS_MARKER_DIR: markerDir });
      expect(await noop.done()).toBe(0);
      expect(dispatchCount(markerDir, unit)).toBe(2);
    },
    30_000,
  );

  test(
    "Window B: SIGKILL after the unit completes but before the step does → resume reuses the unit, replaces the dangling gate row, finalizes once",
    async () => {
      writeProgram(storage.stashDir, "crash-gate", GATE_WF);
      const started = await startWorkflowRun("workflow:crash-gate", {});
      const runId = started.run.id;
      const [unit] = await unitIds(runId, {});

      // Driver completes the unit, then the gate judge blocks — the gate row is
      // journaled `running` before the (held) judge runs, so the kill lands in
      // the "units done, step not finalized" window with a dangling gate row.
      const crasher = spawnRunner({
        CHAOS_RUN_ID: runId,
        CHAOS_MARKER_DIR: markerDir,
        CHAOS_JUDGE: "hold",
      });
      await pollUntil(() => fs.existsSync(path.join(markerDir, "judgestart")), { label: "gate judge is running" });

      // Durable state at the kill point: unit completed, a dangling running gate
      // row, step still pending.
      const rowsMid = await withWorkflowRunsRepo((repo) => repo.getUnitsForStep(runId, "work"));
      expect(rowsMid.find((r) => r.unit_id === unit)?.status).toBe("completed");
      const gateMid = rowsMid.filter((r) => r.node_id === "work.gate");
      expect(gateMid).toHaveLength(1);
      expect(gateMid[0].status).toBe("running");
      expect(dispatchCount(markerDir, unit)).toBe(1);

      crasher.kill("SIGKILL");
      await crasher.done();
      await expireLease(runId);

      // Resume with an accepting judge: the unit is REUSED (no re-dispatch), the
      // dangling gate row is replaced, and the step finalizes exactly once.
      const resume = spawnRunner({ CHAOS_RUN_ID: runId, CHAOS_MARKER_DIR: markerDir, CHAOS_JUDGE: "accept" });
      expect(await resume.done()).toBe(0);

      const status = await getWorkflowStatus(runId);
      expect(status.run.status).toBe("completed");
      // The completed unit was reused, never re-dispatched.
      expect(dispatchCount(markerDir, unit)).toBe(1);
      // Exactly one gate row, now completed — INSERT OR REPLACE took the dangling
      // row over, no duplicate.
      const gateRows = (await withWorkflowRunsRepo((repo) => repo.getUnitsForStep(runId, "work"))).filter(
        (r) => r.node_id === "work.gate",
      );
      expect(gateRows).toHaveLength(1);
      expect(gateRows[0].status).toBe("completed");
    },
    30_000,
  );
});
