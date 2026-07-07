// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { runWorkflowSteps } from "../../src/workflows/exec/run-workflow";
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
