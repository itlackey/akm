// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * One driver per run: `akm workflow run` holds an O_EXCL lock file per run id
 * (`workflowRunLockPath`) while it drives. A second driver on the same run is
 * refused up front with `RUN_LEASE_HELD` (a TransientError — exit 75) naming
 * the holder pid, and dispatches nothing. A lock whose holder pid is dead is
 * reclaimed at once; nothing expires by age, nothing renews. Read surfaces
 * (`status`, `next`) never take the lock. Opens state.db (integration).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../../src/core/config/config";
import { TransientError } from "../../../src/core/errors";
import { openStateDatabase } from "../../../src/core/state-db";
import { resolveStorageLocations } from "../../../src/storage/locations";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import { runWorkflowSteps, workflowRunLockPath } from "../../../src/workflows/exec/run-workflow";
import {
  abandonWorkflowRun,
  getNextWorkflowStep,
  getWorkflowStatus,
  startWorkflowRun,
} from "../../../src/workflows/runtime/runs";
import { runCliCapture } from "../../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../../_helpers/sandbox";
import { plantRunLock } from "../../_helpers/workflow";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
  resetConfigCache();
});

afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

function writeWorkflow(name: string, steps: string[] = ["only-step"]): void {
  const file = path.join(storage.stashDir, "workflows", `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = ["---", "type: workflow", "steps:", ...steps.map((id) => `  - id: ${id}`), "---", ""];
  for (const id of steps) lines.push(`## ${id}`, "", `Do ${id}.`, "");
  fs.writeFileSync(file, lines.join("\n"), "utf8");
}

const locked = (runId: string): boolean => fs.existsSync(workflowRunLockPath(runId));

/** A dispatcher that parks until released, so a second driver can race the first. */
function parkedDispatcher() {
  let release: () => void = () => {};
  let started: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dispatching = new Promise<void>((resolve) => {
    started = resolve;
  });
  return {
    dispatching,
    release: () => release(),
    dispatcher: async () => {
      started();
      await released;
      return { ok: true as const, text: "done" };
    },
  };
}

describe("one driver per run", () => {
  test("two concurrent `workflow run` on one run: the second exits 75 (RUN_LEASE_HELD) naming the holder, dispatching nothing", async () => {
    writeWorkflow("lock-contended");
    const started = await startWorkflowRun("workflows/lock-contended", {});
    const runId = started.run.id;

    const first = parkedDispatcher();
    const driving = runWorkflowSteps({ target: runId, dispatcher: first.dispatcher });
    await first.dispatching;
    expect(locked(runId)).toBe(true);

    // A second in-process driver is refused before it dispatches anything…
    let dispatches = 0;
    const second = runWorkflowSteps({
      target: runId,
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "must not run" };
      },
    });
    const refusal = await second.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(TransientError);
    expect((refusal as TransientError).code).toBe("RUN_LEASE_HELD");
    expect((refusal as TransientError).message).toContain(`pid ${process.pid}`);
    expect(dispatches).toBe(0);

    // …and the CLI maps the same refusal to exit 75.
    const cli = await runCliCapture(["workflow", "run", runId]);
    expect(cli.code).toBe(75);
    const envelope = JSON.parse(cli.stderr.trim()) as { ok: boolean; code: string; error: string };
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("RUN_LEASE_HELD");

    // The first driver is untouched by either refusal and finishes the run.
    first.release();
    const result = await driving;
    expect(result.run.status).toBe("completed");
    expect(locked(runId)).toBe(false);
  });

  test("the lock is held while dispatching and released on an early --max-steps exit and on a failed run", async () => {
    writeWorkflow("lock-release", ["first", "second"]);
    const started = await startWorkflowRun("workflows/lock-release", {});
    const runId = started.run.id;

    let heldDuringDispatch = false;
    const partial = await runWorkflowSteps({
      target: runId,
      maxSteps: 1,
      dispatcher: async () => {
        heldDuringDispatch = locked(runId);
        return { ok: true, text: "done" };
      },
    });
    expect(heldDuringDispatch).toBe(true);
    expect(partial.run.status).toBe("active");
    expect(locked(runId)).toBe(false);

    const failed = await runWorkflowSteps({
      target: runId,
      dispatcher: async () => {
        throw new Error("harness exploded");
      },
    });
    expect(failed.run.status).toBe("failed");
    expect(locked(runId)).toBe(false);
  });

  test("a lock left by a dead process is reclaimed at once — nothing waits out a TTL", async () => {
    writeWorkflow("lock-dead-holder");
    const started = await startWorkflowRun("workflows/lock-dead-holder", {});
    plantRunLock(started.run.id, 999_999_999);

    const result = await runWorkflowSteps({
      target: started.run.id,
      dispatcher: async () => ({ ok: true, text: "done" }),
    });
    expect(result.run.status).toBe("completed");
    expect(locked(started.run.id)).toBe(false);
  });

  test("status and next never take the lock, even while another process holds it", async () => {
    writeWorkflow("lock-readers");
    const started = await startWorkflowRun("workflows/lock-readers", {});
    const release = plantRunLock(started.run.id);

    expect((await getNextWorkflowStep(started.run.id)).step?.id).toBe("only-step");
    expect((await getWorkflowStatus(started.run.id, { includeUnits: true })).run.status).toBe("active");
    expect(locked(started.run.id)).toBe(true);
    release();
  });
});

describe("runs that will not dispatch take no lock", () => {
  test("a completed run returns without taking the lock or reading its plan", async () => {
    writeWorkflow("lock-completed");
    const started = await startWorkflowRun("workflows/lock-completed", {});
    const done = await runWorkflowSteps({ target: started.run.id, dispatcher: async () => ({ ok: true, text: "x" }) });
    expect(done.run.status).toBe("completed");

    const release = plantRunLock(started.run.id);
    const db = openStateDatabase(resolveStorageLocations().stateDb);
    try {
      db.prepare("UPDATE workflow_runs SET plan_json = ? WHERE id = ?").run("{ not json", started.run.id);
    } finally {
      db.close();
    }
    const again = await runWorkflowSteps({
      target: started.run.id,
      dispatcher: async () => ({ ok: true, text: "must not run" }),
    });
    expect(again.done).toBe(true);
    expect(again.executed).toEqual([]);
    release();
  });

  test("a failed run refuses up front, before the lock", async () => {
    writeWorkflow("lock-failed");
    const started = await startWorkflowRun("workflows/lock-failed", {});
    const crashed = await runWorkflowSteps({
      target: started.run.id,
      dispatcher: async () => {
        throw new Error("boom");
      },
    });
    expect(crashed.run.status).toBe("failed");

    const release = plantRunLock(started.run.id);
    await expect(
      runWorkflowSteps({ target: started.run.id, dispatcher: async () => ({ ok: true, text: "must not run" }) }),
    ).rejects.toThrow(/is failed and cannot be executed/);
    release();
  });
});

describe("abandoning a run mid-dispatch", () => {
  test("the unit's result is still journaled, the spine never advances, and the engine stops", async () => {
    writeWorkflow("lock-abandoned-in-flight");
    const started = await startWorkflowRun("workflows/lock-abandoned-in-flight", {});
    const parked = parkedDispatcher();
    const running = runWorkflowSteps({ target: started.run.id, dispatcher: parked.dispatcher });
    await parked.dispatching;

    await abandonWorkflowRun(started.run.id);
    parked.release();
    await expect(running).rejects.toThrow(/is failed and cannot be updated/);
    expect(locked(started.run.id)).toBe(false);

    expect((await getWorkflowStatus(started.run.id)).run.status).toBe("failed");
    // Leaving the unit `running` would make a resume re-dispatch work that
    // already ran; abandoning bars advancing the spine, not recording what a
    // unit actually did.
    const units = await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(started.run.id));
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ status: "completed", result_json: JSON.stringify("done") });
    const steps = await withWorkflowRunsRepo((repo) => repo.getStepsForRun(started.run.id));
    expect(steps[0]?.status).toBe("pending");
  });
});
