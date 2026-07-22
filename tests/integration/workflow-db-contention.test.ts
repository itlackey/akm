// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * MULTI-PROCESS workflow.db contention + writer-queue resilience.
 *
 *   1. Cross-process reader vs writer: a real `bun` process drives a wide
 *      fan-out (many `workflow_run_units` writes through the serialized writer
 *      queue) while THIS process concurrently hammers status/journal reads
 *      against the same SQLite file. No corruption: every read that returns is
 *      internally consistent, any contention (SQLITE_BUSY) surfaces as a clean
 *      thrown Error (never a partial/garbled row), and the FINAL journal has
 *      every unit present and terminal with the run completed + queryable.
 *
 *   2. Writer-failure mid fan-out: a single journal write is fault-injected to
 *      throw on the shared writer queue. It rejects its OWN caller, but the
 *      queue is never wedged — every subsequent enqueued write still drains and
 *      lands durably (the {@link enqueueUnitWrite} contract).
 *
 * Dispatch is a fake env-driven seam — no agent binary, no LLM. Reads are
 * synchronized against the driver's real process lifetime, never a bare sleep.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { enqueueUnitWrite } from "../../src/workflows/exec/unit-writer";
import { getWorkflowStatus, startWorkflowRun } from "../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";
import { bunAvailable, spawnRunner, unitIds, writeProgram } from "./_helpers/workflow-crossproc";

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

const WIDE_FANOUT_WF = `version: 2
name: db-contention
defaults: { engine: test-agent }
params:
  files: { type: array, items: { type: string } }
steps:
  - id: review
    title: Review
    map:
      over: \${{ params.files }}
      concurrency: 8
      reducer: collect
      unit:
        instructions: Review \${{ item }} now.
`;

describe.skipIf(!BUN)("cross-process reader vs fan-out writer", () => {
  test("concurrent status/journal reads during a wide fan-out never observe corruption; the final journal is complete + terminal", async () => {
    const files = Array.from({ length: 40 }, (_, i) => `f${i}.ts`);
    writeProgram(storage.stashDir, "db-contention", WIDE_FANOUT_WF);
    const started = await startWorkflowRun("workflows/db-contention", { files });
    expect(started.run.planIrVersion).toBe(3);
    const runId = started.run.id;

    const driver = spawnRunner({ CHAOS_RUN_ID: runId, CHAOS_MARKER_DIR: markerDir });

    // Reader loop (a SEPARATE process from the driver) polling the shared DB
    // while the writer fan-out is in flight. Record clean failures separately
    // from any structural inconsistency.
    let reads = 0;
    let maxUnitsSeen = 0;
    const cleanErrors: string[] = [];
    let corruption = false;
    const reader = (async () => {
      // do/while so at least one read always races the writer, even if the
      // driver is unusually fast — reads > 0 stays deterministic.
      do {
        try {
          const status = await getWorkflowStatus(runId);
          const rows = await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(runId));
          reads++;
          maxUnitsSeen = Math.max(maxUnitsSeen, rows.length);
          // Every row a read returns must be a well-formed row (never a
          // half-written / garbled record): valid status + a unit id.
          for (const r of rows) {
            if (!r.unit_id || !["running", "completed", "failed", "skipped", "pending"].includes(r.status)) {
              corruption = true;
            }
          }
          if (!["active", "completed", "failed", "blocked"].includes(status.run.status)) corruption = true;
        } catch (err) {
          // A busy DB is a clean, catchable failure — not corruption.
          cleanErrors.push(err instanceof Error ? err.message : String(err));
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
      } while (!driver.exited);
    })();

    const code = await driver.done();
    await reader;
    expect(driver.stderr()).toBe("");
    expect(code).toBe(0);

    // Reads genuinely raced the writer and never saw a malformed row/state.
    expect(reads).toBeGreaterThan(0);
    expect(corruption).toBe(false);
    // Any errors that DID occur were clean Error messages, not silent garbage.
    for (const msg of cleanErrors) expect(msg.length).toBeGreaterThan(0);

    // Final durable state: complete, all 40 units terminal, DB queryable.
    const finalStatus = await getWorkflowStatus(runId);
    expect(finalStatus.run.status).toBe("completed");
    const rows = await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(runId));
    const dispatchRows = rows.filter((r) => r.phase !== "gate");
    expect(dispatchRows).toHaveLength(40);
    expect(dispatchRows.every((r) => r.status === "completed")).toBe(true);
    expect(finalStatus.workflow.steps[0]!.evidence?.output).toHaveLength(40);
  }, 30_000);
});

describe("writer queue resilience (fault-injected write failure)", () => {
  test("one failed unit write rejects its caller but the queue keeps draining subsequent writes", async () => {
    // A real run so insertUnit has a valid parent run/step to attach to.
    writeProgram(storage.stashDir, "db-contention", WIDE_FANOUT_WF);
    const files = ["a.ts", "b.ts", "c.ts"];
    const started = await startWorkflowRun("workflows/db-contention", { files });
    expect(started.run.planIrVersion).toBe(3);
    const runId = started.run.id;
    const [ua, ub, uc] = await unitIds(runId, { files });

    const now = new Date().toISOString();
    const insert = (unitId: string) =>
      enqueueUnitWrite(() =>
        withWorkflowRunsRepo((repo) =>
          repo.insertUnit({
            runId,
            unitId,
            stepId: "review",
            nodeId: "review.unit",
            parentUnitId: "review.map",
            phase: null,
            runner: "sdk",
            model: null,
            inputHash: `hash-${unitId}`,
            startedAt: now,
          }),
        ),
      );

    // Interleave on the ONE shared queue: a real write, a fault-injected
    // throwing write (a mid-fan-out journal failure — disk error / constraint),
    // then two more real writes.
    const results = await Promise.allSettled([
      insert(ua!),
      enqueueUnitWrite(async () => {
        throw new Error("simulated journal write failure");
      }),
      insert(ub!),
      insert(uc!),
    ]);

    // The failing write rejected its own caller…
    expect(results[1].status).toBe("rejected");
    // …but every other write on the queue resolved (the chain was not wedged).
    expect(results[0].status).toBe("fulfilled");
    expect(results[2].status).toBe("fulfilled");
    expect(results[3].status).toBe("fulfilled");

    // …and all three real writes landed durably.
    const rows = await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(runId));
    expect(rows.map((r) => r.unit_id).sort()).toEqual([ua!, ub!, uc!].sort());
    expect(rows.every((r) => r.status === "running")).toBe(true);
  });
});
