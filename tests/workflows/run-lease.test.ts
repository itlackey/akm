// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resolveStorageLocations } from "../../src/storage/locations";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { closeWorkflowDatabase, openWorkflowDatabase } from "../../src/workflows/db";
import { reportWorkflowUnit } from "../../src/workflows/exec/report";
import { runWorkflowSteps } from "../../src/workflows/exec/run-workflow";
import type { WorkflowPlanGraph } from "../../src/workflows/ir/schema";
import {
  completeWorkflowStep,
  getNextWorkflowStep,
  getWorkflowStatus,
  startWorkflowRun,
} from "../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

/**
 * Run-lease enforcement (redesign addendum R2 — single-driver invariant):
 *
 *   - `workflow run` acquires the lease (random holder id, now+90s expiry)
 *     BEFORE any dispatch, renews it between steps, releases it in a finally.
 *   - A second engine invocation on a live-leased run refuses up front with
 *     a UsageError naming the holder + expiry — and dispatches nothing.
 *   - An EXPIRED lease is claimable (crash recovery).
 *   - Manual `workflow complete` is refused while a live engine lease is held
 *     (the engine owns the spine while driving) and allowed after release or
 *     expiry. Manual `workflow next` never takes a lease.
 *   - The lease is released on engine failure paths too (dispatcher throws,
 *     frozen-plan integrity failure).
 */

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => storage.cleanup());

function writeWorkflow(name: string, instructions = "Do the leased thing."): void {
  const file = path.join(storage.stashDir, "workflows", `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = [
    "---",
    "description: Run-lease test workflow",
    "---",
    "",
    `# Workflow: ${name}`,
    "",
    "## Step: Only Step",
    "Step ID: only-step",
    "",
    "### Instructions",
    instructions,
    "",
  ].join("\n");
  fs.writeFileSync(file, content, "utf8");
}

function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

async function readLease(runId: string): Promise<{ holder: string | null; until: string | null }> {
  return withWorkflowRunsRepo((repo) => {
    const row = repo.getRunById(runId);
    return { holder: row?.engine_lease_holder ?? null, until: row?.engine_lease_until ?? null };
  });
}

/** Plant a lease directly through the repository (simulates another engine). */
async function plantLease(runId: string, holder: string, until: string): Promise<void> {
  await withWorkflowRunsRepo((repo) => {
    expect(repo.acquireEngineLease(runId, holder, until, new Date().toISOString())).toBe(true);
  });
}

/** Direct-SQL escape hatch — tamper the frozen plan / run state a run row. */
function execOnWorkflowDb(sql: string, ...params: Array<string | number | null>): void {
  const db = openWorkflowDatabase(resolveStorageLocations().workflowDb);
  try {
    db.prepare(sql).run(...params);
  } finally {
    closeWorkflowDatabase(db);
  }
}

describe("repository lease primitives", () => {
  test("acquire is atomic: a live lease is not reclaimable, an expired one is; renew/release require the holder", async () => {
    writeWorkflow("lease-repo");
    const started = await startWorkflowRun("workflow:lease-repo", {});
    const runId = started.run.id;

    await withWorkflowRunsRepo((repo) => {
      const now = new Date().toISOString();
      // First claim wins.
      expect(repo.acquireEngineLease(runId, "engine-A", isoIn(90_000), now)).toBe(true);
      // Second claim on a live lease loses — including a duplicate holder id.
      expect(repo.acquireEngineLease(runId, "engine-B", isoIn(90_000), now)).toBe(false);
      expect(repo.acquireEngineLease(runId, "engine-A", isoIn(90_000), now)).toBe(false);

      // Renew only works for the holder.
      expect(repo.renewEngineLease(runId, "engine-B", isoIn(90_000))).toBe(false);
      expect(repo.renewEngineLease(runId, "engine-A", isoIn(120_000))).toBe(true);

      // Release by a non-holder is a no-op; the lease stays.
      repo.releaseEngineLease(runId, "engine-B");
      expect(repo.getRunById(runId)?.engine_lease_holder).toBe("engine-A");

      // Expire the lease → claimable by a new engine (crash recovery).
      expect(repo.renewEngineLease(runId, "engine-A", isoIn(-1_000))).toBe(true);
      expect(repo.acquireEngineLease(runId, "engine-B", isoIn(90_000), new Date().toISOString())).toBe(true);
      expect(repo.getRunById(runId)?.engine_lease_holder).toBe("engine-B");

      // Holder release clears both columns.
      repo.releaseEngineLease(runId, "engine-B");
      const row = repo.getRunById(runId);
      expect(row?.engine_lease_holder).toBeNull();
      expect(row?.engine_lease_until).toBeNull();
    });
  });
});

describe("engine run lease (single driver)", () => {
  test("a successful run holds the lease while driving and releases it on exit", async () => {
    writeWorkflow("lease-happy");
    const started = await startWorkflowRun("workflow:lease-happy", {});

    let leaseDuringDispatch: { holder: string | null; until: string | null } | undefined;
    const result = await runWorkflowSteps({
      target: started.run.id,
      dispatcher: async () => {
        leaseDuringDispatch = await readLease(started.run.id);
        return { ok: true, text: "done" };
      },
    });

    expect(result.done).toBe(true);
    // The lease was live while the unit dispatched (acquired BEFORE dispatch)…
    expect(leaseDuringDispatch?.holder).toBeTruthy();
    expect(leaseDuringDispatch?.until && leaseDuringDispatch.until > new Date().toISOString()).toBe(true);
    // …and the engine could still advance the spine (its holder id is passed
    // through completeWorkflowStep — a live lease refuses everyone else).
    expect((await readLease(started.run.id)).holder).toBeNull();
    expect((await readLease(started.run.id)).until).toBeNull();
  });

  test("a second run invocation on a live-leased run refuses up front, naming holder + expiry, dispatching nothing", async () => {
    writeWorkflow("lease-contended");
    const started = await startWorkflowRun("workflow:lease-contended", {});
    const until = isoIn(90_000);
    await plantLease(started.run.id, "engine-A", until);

    let dispatches = 0;
    await expect(
      runWorkflowSteps({
        target: started.run.id,
        dispatcher: async () => {
          dispatches++;
          return { ok: true, text: "must not run" };
        },
      }),
    ).rejects.toThrow(new RegExp(`engine-A.*${until.replace(/[.]/g, "\\.")}`));
    expect(dispatches).toBe(0);
    // The loser must not have clobbered or released the winner's lease.
    expect(await readLease(started.run.id)).toEqual({ holder: "engine-A", until });
  });

  test("an EXPIRED lease is claimable: the run proceeds and the stale holder is replaced", async () => {
    writeWorkflow("lease-expired");
    const started = await startWorkflowRun("workflow:lease-expired", {});
    await plantLease(started.run.id, "crashed-engine", isoIn(-5_000));

    let holderDuringDispatch: string | null = null;
    const result = await runWorkflowSteps({
      target: started.run.id,
      dispatcher: async () => {
        holderDuringDispatch = (await readLease(started.run.id)).holder;
        return { ok: true, text: "done" };
      },
    });

    expect(result.done).toBe(true);
    expect(holderDuringDispatch).toBeTruthy();
    expect(holderDuringDispatch).not.toBe("crashed-engine");
    expect((await readLease(started.run.id)).holder).toBeNull();
  });

  test("the lease is released when the dispatcher throws (engine failure path)", async () => {
    writeWorkflow("lease-crash");
    const started = await startWorkflowRun("workflow:lease-crash", {});

    const result = await runWorkflowSteps({
      target: started.run.id,
      dispatcher: async () => {
        throw new Error("harness exploded");
      },
    });

    // The dispatcher throw becomes a failed unit → failed step → failed run…
    expect(result.run.status).toBe("failed");
    expect(result.executed[0]?.ok).toBe(false);
    // …and the finally released the lease anyway.
    expect(await readLease(started.run.id)).toEqual({ holder: null, until: null });
  });

  test("the lease is released when the engine throws before dispatching (frozen-plan integrity failure)", async () => {
    writeWorkflow("lease-throw");
    const started = await startWorkflowRun("workflow:lease-throw", {});

    await expect(
      runWorkflowSteps({
        target: started.run.id,
        loadPlan: async () => {
          throw new Error("plan load failed");
        },
        dispatcher: async () => ({ ok: true, text: "must not run" }),
      }),
    ).rejects.toThrow("plan load failed");
    expect(await readLease(started.run.id)).toEqual({ holder: null, until: null });
  });
});

describe("manual loop under the lease", () => {
  test("manual complete is refused during a live engine lease, allowed after release", async () => {
    writeWorkflow("lease-manual");
    const started = await startWorkflowRun("workflow:lease-manual", {});
    await plantLease(started.run.id, "engine-A", isoIn(90_000));

    // Refused while the engine drives — the error names the holder.
    await expect(
      completeWorkflowStep({
        runId: started.run.id,
        stepId: "only-step",
        status: "completed",
        summary: "Did the thing by hand.",
        summaryJudge: null,
      }),
    ).rejects.toThrow(/engine-A/);

    // Released → the manual path works again (no leaseHolder passed).
    await withWorkflowRunsRepo((repo) => {
      repo.releaseEngineLease(started.run.id, "engine-A");
    });
    const detail = await completeWorkflowStep({
      runId: started.run.id,
      stepId: "only-step",
      status: "completed",
      summary: "Did the thing by hand.",
      summaryJudge: null,
    });
    expect("run" in detail && detail.run.status).toBe("completed");
  });

  test("manual complete is allowed once the lease has EXPIRED (dead engine never wedges the run)", async () => {
    writeWorkflow("lease-manual-expired");
    const started = await startWorkflowRun("workflow:lease-manual-expired", {});
    await plantLease(started.run.id, "crashed-engine", isoIn(-5_000));

    const detail = await completeWorkflowStep({
      runId: started.run.id,
      stepId: "only-step",
      status: "completed",
      summary: "Did the thing by hand after the engine died.",
      summaryJudge: null,
    });
    expect("run" in detail && detail.run.status).toBe("completed");
  });

  test("manual `workflow next` takes no lease, and next/status surface engineLease while one is held", async () => {
    writeWorkflow("lease-surface");
    const started = await startWorkflowRun("workflow:lease-surface", {});

    // `next` on an unleased run: reads state, leaves the columns untouched.
    const before = await getNextWorkflowStep(started.run.id);
    expect(before.run.engineLease).toBeUndefined();
    expect(await readLease(started.run.id)).toEqual({ holder: null, until: null });

    const until = isoIn(90_000);
    await plantLease(started.run.id, "engine-A", until);
    const next = await getNextWorkflowStep(started.run.id);
    expect(next.run.engineLease).toEqual({ holder: "engine-A", until });
    const status = await getWorkflowStatus(started.run.id);
    expect(status.run.engineLease).toEqual({ holder: "engine-A", until });

    await withWorkflowRunsRepo((repo) => {
      repo.releaseEngineLease(started.run.id, "engine-A");
    });
    const after = await getWorkflowStatus(started.run.id);
    expect(after.run.engineLease).toBeUndefined();
  });
});

/**
 * Terminal-run no-op (engine early-exit contract): `workflow run` on a run that
 * is already completed or failed must refuse/return WITHOUT acquiring a lease
 * AND without loading or integrity-checking the frozen plan — nothing will ever
 * dispatch, so touching either would be a pure liability (a since-corrupted
 * plan_json throwing on an already-finished run, or a spurious lease write).
 */
describe("terminal run no-op (no lease, no plan load, no dispatch)", () => {
  test("a COMPLETED run is a clean no-op even with a since-corrupted frozen plan, and leaves engine_lease_* untouched", async () => {
    writeWorkflow("term-completed");
    const started = await startWorkflowRun("workflow:term-completed", {});
    const runId = started.run.id;

    // Drive it to completion normally.
    const done = await runWorkflowSteps({
      target: runId,
      summaryJudge: null,
      dispatcher: async () => ({ ok: true, text: "done" }),
    });
    expect(done.done).toBe(true);
    expect(done.run.status).toBe("completed");

    // Plant a lease directly (as if a stale row lingered) and CORRUPT the frozen
    // plan_json. A no-op run must not read the plan (loadFrozenPlan would throw
    // "corrupt frozen plan") and must not disturb the planted lease columns.
    const until = isoIn(90_000);
    await plantLease(runId, "planted-holder", until);
    execOnWorkflowDb("UPDATE workflow_runs SET plan_json = ? WHERE id = ?", "{ this is not valid json", runId);

    let dispatches = 0;
    let planLoads = 0;
    const noop = await runWorkflowSteps({
      target: runId,
      summaryJudge: null,
      // A loadPlan seam proves the plan is not loaded even via the injectable
      // path — the guard returns BEFORE the loader is consulted.
      loadPlan: async () => {
        planLoads++;
        return {} as WorkflowPlanGraph;
      },
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "must not run" };
      },
    });

    expect(noop.done).toBe(true);
    expect(noop.run.status).toBe("completed");
    expect(dispatches).toBe(0);
    expect(planLoads).toBe(0);
    // The planted lease columns are byte-identical — the no-op never wrote them.
    expect(await readLease(runId)).toEqual({ holder: "planted-holder", until });
  });

  test("a FAILED run refuses up front WITHOUT loading the plan or touching the lease, dispatching nothing", async () => {
    writeWorkflow("term-failed");
    const started = await startWorkflowRun("workflow:term-failed", {});
    const runId = started.run.id;

    // Crash the run: the dispatcher throw → failed unit → failed step → failed run.
    const crashed = await runWorkflowSteps({
      target: runId,
      summaryJudge: null,
      dispatcher: async () => {
        throw new Error("boom");
      },
    });
    expect(crashed.run.status).toBe("failed");
    // The crash path released the lease.
    expect(await readLease(runId)).toEqual({ holder: null, until: null });

    // Plant a lease so we can prove the refused re-invocation leaves it untouched.
    const until = isoIn(90_000);
    await plantLease(runId, "planted-holder", until);

    let dispatches = 0;
    let planLoads = 0;
    await expect(
      runWorkflowSteps({
        target: runId,
        summaryJudge: null,
        loadPlan: async () => {
          planLoads++;
          return {} as WorkflowPlanGraph;
        },
        dispatcher: async () => {
          dispatches++;
          return { ok: true, text: "must not run" };
        },
      }),
    ).rejects.toThrow(/is failed and cannot be executed/);

    expect(dispatches).toBe(0);
    expect(planLoads).toBe(0);
    // The refusal happened before any lease write — the planted lease is intact.
    expect(await readLease(runId)).toEqual({ holder: "planted-holder", until });
  });
});

/**
 * Lease heartbeat (P1 fix — the lease must not expire while dispatch is in
 * flight). The between-step renewal cannot cover a single unit that runs longer
 * than the 90s TTL (the default unit timeout is 10 minutes). A timer INSIDE the
 * engine invocation renews the lease during long steps; a failed renewal (the
 * lease was genuinely stolen after an expiry) aborts dispatch and fails the run
 * loudly. The `heartbeatScheduler` seam drives ticks deterministically.
 */
describe("engine lease heartbeat (long-running steps)", () => {
  test("(a) the heartbeat renews the lease across a dispatch longer than the TTL, keeping it live and unclaimable", async () => {
    writeWorkflow("lease-heartbeat");
    const started = await startWorkflowRun("workflow:lease-heartbeat", {});
    const runId = started.run.id;

    let fireTick: (() => Promise<void>) | undefined;
    const result = await runWorkflowSteps({
      target: runId,
      heartbeatScheduler: (tick) => {
        fireTick = tick;
        return () => {};
      },
      dispatcher: async () => {
        // Simulate a step that outlives the 90s TTL: age the lease to expiry as
        // the wall clock would during a long unit. Without a heartbeat the run
        // would now be claimable by a second engine.
        const held = await readLease(runId);
        await withWorkflowRunsRepo((repo) => repo.renewEngineLease(runId, held.holder as string, isoIn(-1_000)));
        // The heartbeat fires and renews the lease back to a live window.
        await fireTick?.();
        const after = await readLease(runId);
        expect(after.holder).toBe(held.holder);
        expect(after.until && after.until > new Date().toISOString()).toBe(true);
        // A competing engine cannot claim it while the heartbeat keeps it live.
        const stolen = await withWorkflowRunsRepo((repo) =>
          repo.acquireEngineLease(runId, "engine-B", isoIn(90_000), new Date().toISOString()),
        );
        expect(stolen).toBe(false);
        return { ok: true, text: "done" };
      },
    });
    expect(result.done).toBe(true);
    // Released cleanly on exit.
    expect(await readLease(runId)).toEqual({ holder: null, until: null });
  });

  test("(b) the heartbeat timer is stopped when the run finishes AND when it fails", async () => {
    writeWorkflow("lease-hb-stop");

    // Success path: the run completes, the finally stops the heartbeat.
    const ok = await startWorkflowRun("workflow:lease-hb-stop", {});
    let stopsOk = 0;
    const okResult = await runWorkflowSteps({
      target: ok.run.id,
      heartbeatScheduler: () => () => {
        stopsOk++;
      },
      dispatcher: async () => ({ ok: true, text: "done" }),
    });
    expect(okResult.done).toBe(true);
    expect(stopsOk).toBe(1);

    // Failure path: the dispatcher throw becomes a failed run, and the finally
    // still stops the heartbeat exactly once.
    const bad = await startWorkflowRun("workflow:lease-hb-stop", {});
    let stopsBad = 0;
    const badResult = await runWorkflowSteps({
      target: bad.run.id,
      heartbeatScheduler: () => () => {
        stopsBad++;
      },
      dispatcher: async () => {
        throw new Error("harness exploded");
      },
    });
    expect(badResult.run.status).toBe("failed");
    expect(stopsBad).toBe(1);
  });

  test("(c) a failed renewal (lease stolen mid-step) aborts dispatch and fails the run loudly", async () => {
    writeWorkflow("lease-hb-stolen");
    const started = await startWorkflowRun("workflow:lease-hb-stolen", {});
    const runId = started.run.id;

    let fireTick: (() => Promise<void>) | undefined;
    let dispatches = 0;
    let signalAborted: boolean | undefined;
    await expect(
      runWorkflowSteps({
        target: runId,
        heartbeatScheduler: (tick) => {
          fireTick = tick;
          return () => {};
        },
        dispatcher: async (request) => {
          dispatches++;
          // Another engine steals the lease after ours "expired" mid-step.
          const ourHolder = (await readLease(runId)).holder as string;
          await withWorkflowRunsRepo((repo) => {
            repo.renewEngineLease(runId, ourHolder, isoIn(-1_000));
            repo.acquireEngineLease(runId, "thief", isoIn(90_000), new Date().toISOString());
          });
          // The heartbeat tick now fails to renew → aborts this dispatch.
          await fireTick?.();
          signalAborted = request.signal?.aborted;
          return { ok: true, text: "should be discarded" };
        },
      }),
    ).rejects.toThrow(/lost its run lease mid-dispatch/);
    // The unit was dispatched once; the loud stop prevents any further driving.
    expect(dispatches).toBe(1);
    // The dispatch signal was aborted the instant the lease was lost.
    expect(signalAborted).toBe(true);
    // The thief still owns the lease — the loser's holder-guarded release is a no-op.
    expect((await readLease(runId)).holder).toBe("thief");
  });

  test("(d) `workflow report` keeps refusing while the heartbeat holds the lease live through a long step", async () => {
    writeWorkflow("lease-hb-report");
    const started = await startWorkflowRun("workflow:lease-hb-report", {});
    const runId = started.run.id;

    let fireTick: (() => Promise<void>) | undefined;
    let reportRefused = false;
    const result = await runWorkflowSteps({
      target: runId,
      heartbeatScheduler: (tick) => {
        fireTick = tick;
        return () => {};
      },
      dispatcher: async () => {
        // Age the lease as a long step would, then heartbeat it live again.
        const held = await readLease(runId);
        await withWorkflowRunsRepo((repo) => repo.renewEngineLease(runId, held.holder as string, isoIn(-1_000)));
        await fireTick?.();
        // A racing `report` must STILL be refused — the lease reads live, so the
        // report cannot race the engine's spine (the R3 refusal stays correct).
        try {
          await reportWorkflowUnit({
            target: runId,
            unitId: "only-step:solo",
            status: "completed",
            resultRaw: "x",
            summaryJudge: null,
          });
        } catch (err) {
          reportRefused = /is refused while the engine lease is live/.test((err as Error).message);
        }
        return { ok: true, text: "done" };
      },
    });
    expect(result.done).toBe(true);
    expect(reportRefused).toBe(true);
  });
});
