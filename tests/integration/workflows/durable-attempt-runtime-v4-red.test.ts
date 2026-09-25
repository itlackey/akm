// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import type { UnitDispatchRequest, UnitDispatchResult } from "../../../src/workflows/exec/native-executor";
import { runWorkflowSteps, workflowRunLockPath } from "../../../src/workflows/exec/run-workflow";
import { startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../../_helpers/sandbox";

/**
 * Runtime crash-window RED tests for durable plan v4.
 *
 * These exercise the real start → run lock → native executor path. They
 * assert local journal exactness while deliberately demonstrating that
 * external work is at-least-once: if driver A dies after an external side
 * effect and driver B reclaims its still-running reservation, both calls
 * receive the same stable `dispatchId`. Only the first terminal write persists
 * outcome/usage/event data.
 */

interface AttemptRow {
  run_id: string;
  unit_id: string;
  attempt: number;
  dispatch_id: string;
  phase: "unit" | "gate";
  status: "running" | "completed" | "failed" | "skipped";
  result_json: string | null;
  tokens: number | null;
  failure_reason: string | null;
  claim_holder: string;
  claim_expires_at: string;
}

interface EventRow {
  event_type: string;
  metadata_json: string;
}

interface DispatchRequestV4 extends UnitDispatchRequest {
  /** Durable v4 idempotency/correlation key; stable across crash reclaim. */
  dispatchId: string;
  /** 1-based durable attempt ordinal for `(runId, content-derived unitId)`. */
  attempt: number;
}

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});

afterEach(() => storage.cleanup());

function writeWorkflow(name: string): void {
  const file = path.join(storage.stashDir, "workflows", `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      "---",
      "type: workflow",
      `description: ${name}`,
      "steps:",
      "  - id: work",
      "---",
      "",
      "## work",
      "",
      "Perform the frozen work.",
      "",
    ].join("\n"),
    "utf8",
  );
}

function attemptRows(runId: string): AttemptRow[] {
  const db = openStateDatabase(getStateDbPath());
  try {
    return db
      .prepare(
        `SELECT run_id, unit_id, attempt, dispatch_id, phase, status, result_json,
                tokens, failure_reason, claim_holder, claim_expires_at
           FROM workflow_run_unit_attempts
          WHERE run_id = ?
          ORDER BY unit_id, attempt`,
      )
      .all(runId) as AttemptRow[];
  } finally {
    db.close();
  }
}

function lifecycleEvents(runId: string): Array<EventRow & { metadata: Record<string, unknown> }> {
  const db = openStateDatabase(getStateDbPath());
  try {
    const rows = db
      .prepare(
        `SELECT event_type, metadata_json
           FROM events
          WHERE event_type IN ('workflow_unit_started', 'workflow_unit_finished')
            AND json_extract(metadata_json, '$.runId') = ?
          ORDER BY id`,
      )
      .all(runId) as EventRow[];
    return rows.map((row) => ({ ...row, metadata: JSON.parse(row.metadata_json) as Record<string, unknown> }));
  } finally {
    db.close();
  }
}

/** Simulate driver A dying: its run lock goes away, as a dead pid's lock is reclaimed on the next acquire. */
function expireDriver(runId: string): void {
  fs.rmSync(workflowRunLockPath(runId), { force: true });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("durable v4 runtime attempt protocol", () => {
  test("normal dispatch transports attempt/dispatchId and journals one exactly-paired terminal attempt", async () => {
    writeWorkflow("attempt-normal");
    const started = await startWorkflowRun("workflows/attempt-normal", {});
    const seen: DispatchRequestV4[] = [];

    const result = await runWorkflowSteps({
      target: started.run.id,
      dispatcher: async (request): Promise<UnitDispatchResult> => {
        seen.push(request as DispatchRequestV4);
        return {
          ok: true,
          text: "finished",
          usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 5 },
        };
      },
    });

    expect(result.done).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.attempt).toBe(1);
    expect(seen[0]?.dispatchId).toMatch(/^[0-9a-f-]{16,}$/i);

    const rows = attemptRows(started.run.id);
    expect(rows).toEqual([
      expect.objectContaining({
        attempt: 1,
        dispatch_id: seen[0]?.dispatchId,
        phase: "unit",
        status: "completed",
        result_json: JSON.stringify("finished"),
        tokens: 10,
        failure_reason: null,
      }),
    ]);
    expect(lifecycleEvents(started.run.id).map((event) => event.metadata)).toEqual([
      expect.objectContaining({ attempt: 1, dispatchId: seen[0]?.dispatchId, phase: "unit", status: "running" }),
      expect.objectContaining({
        attempt: 1,
        dispatchId: seen[0]?.dispatchId,
        phase: "unit",
        status: "completed",
        tokens: 10,
      }),
    ]);
  });

  test("crash after external effect reclaims the same dispatchId; late finish cannot overwrite or double-account", async () => {
    writeWorkflow("attempt-crash");
    const started = await startWorkflowRun("workflows/attempt-crash", {});
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<UnitDispatchResult>();
    const externalCalls: Array<{ driver: "a" | "b"; dispatchId: string; attempt: number }> = [];

    const firstRun = runWorkflowSteps({
      target: started.run.id,
      dispatcher: async (request) => {
        const durable = request as DispatchRequestV4;
        // Represents an external shell/LLM side effect that happened before
        // this process died. No terminal DB write has happened yet.
        externalCalls.push({ driver: "a", dispatchId: durable.dispatchId, attempt: durable.attempt });
        firstEntered.resolve();
        return releaseFirst.promise;
      },
    });

    await firstEntered.promise;
    try {
      const reserved = attemptRows(started.run.id);
      expect(reserved).toEqual([
        expect.objectContaining({ attempt: 1, status: "running", tokens: null, result_json: null }),
      ]);
      expect(lifecycleEvents(started.run.id).map((event) => event.event_type)).toEqual(["workflow_unit_started"]);

      // Simulate process A dying. Process B is allowed to
      // re-invoke externally (at-least-once) but MUST reuse attempt 1's stable
      // dispatchId so an idempotent downstream can deduplicate it.
      expireDriver(started.run.id);
      const secondRun = await runWorkflowSteps({
        target: started.run.id,
        dispatcher: async (request) => {
          const durable = request as DispatchRequestV4;
          externalCalls.push({ driver: "b", dispatchId: durable.dispatchId, attempt: durable.attempt });
          return { ok: true, text: "driver-b-wins", usage: { inputTokens: 3, outputTokens: 4 } };
        },
      });
      expect(secondRun.done).toBe(true);
      expect(externalCalls).toHaveLength(2);
      expect(externalCalls[0]?.dispatchId).toBeTruthy();
      const firstCall = externalCalls[0];
      if (!firstCall) throw new Error("expected driver A's external call");
      const stableDispatchId = firstCall.dispatchId;
      expect(externalCalls[1]).toEqual({
        driver: "b",
        dispatchId: stableDispatchId,
        attempt: 1,
      });

      // Driver A returns after B committed. Its late finish cannot overwrite
      // B's terminal outcome or add 101 more tokens/a second finished event.
      releaseFirst.resolve({
        ok: true,
        text: "stale-driver-a-result",
        usage: { inputTokens: 100, outputTokens: 1 },
      });
      await firstRun.catch(() => undefined);

      expect(attemptRows(started.run.id)).toEqual([
        expect.objectContaining({
          attempt: 1,
          dispatch_id: stableDispatchId,
          status: "completed",
          result_json: JSON.stringify("driver-b-wins"),
          tokens: 7,
        }),
      ]);
      const events = lifecycleEvents(started.run.id);
      expect(events.map((event) => event.event_type)).toEqual(["workflow_unit_started", "workflow_unit_finished"]);
      expect(events[0]?.metadata.dispatchId).toBe(stableDispatchId);
      expect(events[1]?.metadata).toEqual(
        expect.objectContaining({
          attempt: 1,
          dispatchId: stableDispatchId,
          status: "completed",
          tokens: 7,
        }),
      );
      await withWorkflowRunsRepo((repo) => {
        const accounting = (
          repo as unknown as {
            getAttemptAccounting(runId: string): {
              totalAttempts: number;
              totalTokens: number;
              dispatchAttempts: number;
              dispatchTokens: number;
              gateAttempts: number;
              gateTokens: number;
            };
          }
        ).getAttemptAccounting(started.run.id);
        expect(accounting).toEqual({
          totalAttempts: 1,
          totalTokens: 7,
          dispatchAttempts: 1,
          dispatchTokens: 7,
          gateAttempts: 0,
          gateTokens: 0,
        });
      });
    } finally {
      // The RED baseline fails before the reclaim path because migration/API
      // are absent. Always release and observe the first invocation so the test
      // leaves no unresolved promise or open workflow connection behind.
      releaseFirst.resolve({ ok: false, text: "", failureReason: "aborted", error: "test cleanup" });
      await firstRun.catch(() => undefined);
    }
  }, 30_000);
});
