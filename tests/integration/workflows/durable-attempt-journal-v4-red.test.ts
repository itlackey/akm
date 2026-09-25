// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import {
  type WorkflowRunsRepository,
  withWorkflowRunsRepo,
} from "../../../src/storage/repositories/workflow-runs-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";
import { seedWorkflowRun } from "../../_helpers/workflow";

/**
 * RED checkpoint for durable-plan v4 attempt persistence.
 *
 * The old `workflow_run_units` row is a mutable projection: crash recovery
 * reuses `(run_id, unit_id)`, overwrites timestamps/outcomes, and increments an
 * `attempts` counter. That cannot prove which external dispatch produced which
 * event or usage charge. V4 therefore adds an append-only attempt journal.
 *
 * Exactly two local atomicity claims are made here:
 *
 *   1. reserving an attempt row and emitting `workflow_unit_started` commit in
 *      one IMMEDIATE transaction, before external work is invoked;
 *   2. committing its terminal redacted outcome/known usage and emitting
 *      `workflow_unit_finished` commit in one IMMEDIATE transaction.
 *
 * No test claims an external shell or LLM call is exactly-once. A process can
 * die after that external side effect but before local finish; reclaim then
 * invokes it again with the SAME stable dispatch id. A downstream backend may
 * use that id as an idempotency key, but AKM itself promises at-least-once.
 */

type AttemptPhase = "unit" | "gate";
type AttemptStatus = "running" | "completed" | "failed" | "skipped";

interface WorkflowRunUnitAttemptRowV4 {
  run_id: string;
  unit_id: string;
  attempt: number;
  dispatch_id: string;
  step_id: string;
  node_id: string;
  phase: AttemptPhase;
  runner: string | null;
  engine: string | null;
  model: string | null;
  input_hash: string;
  status: AttemptStatus;
  result_json: string | null;
  tokens: number | null;
  failure_reason: string | null;
  session_id: string | null;
  worktree_path: string | null;
  started_at: string;
  finished_at: string | null;
  claim_holder: string;
  claim_expires_at: string;
}

interface ReserveUnitAttemptV4Input {
  runId: string;
  unitId: string;
  stepId: string;
  nodeId: string;
  phase: AttemptPhase;
  runner: string | null;
  engine: string | null;
  model: string | null;
  inputHash: string;
  worktreePath?: string | null;
  now: string;
}

interface FinishUnitAttemptV4Input {
  runId: string;
  unitId: string;
  attempt: number;
  dispatchId: string;
  status: Exclude<AttemptStatus, "running">;
  resultJson: string | null;
  tokens: number | null;
  failureReason: string | null;
  sessionId?: string | null;
  finishedAt: string;
}

interface AttemptAccountingV4 {
  totalAttempts: number;
  totalTokens: number;
  dispatchAttempts: number;
  dispatchTokens: number;
  gateAttempts: number;
  gateTokens: number;
}

interface DurableAttemptRepositoryV4 {
  reserveUnitAttempt(input: ReserveUnitAttemptV4Input): {
    kind: "reserved" | "reclaimed";
    attempt: WorkflowRunUnitAttemptRowV4;
  };
  finishUnitAttempt(input: FinishUnitAttemptV4Input): boolean;
  getUnitAttempts(runId: string, unitId: string): WorkflowRunUnitAttemptRowV4[];
  getAttemptAccounting(runId: string): AttemptAccountingV4;
}

interface StoredEvent {
  id: number;
  event_type: string;
  ts: string;
  ref: string | null;
  metadata_json: string;
}

const RUN_ID = "77777777-7777-4777-8777-777777777777";
const WORKFLOW_REF = "workflows/durable-attempts";
const START = "2026-08-22T12:00:00.000Z";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  const db = openStateDatabase(getStateDbPath());
  try {
    seedWorkflowRun(db, {
      runId: RUN_ID,
      workflowRef: WORKFLOW_REF,
      steps: [{ stepId: "review", stepTitle: "Review" }],
    });
  } finally {
    db.close();
  }
});

afterEach(() => storage.cleanup());

function durableAttempts(repo: WorkflowRunsRepository): DurableAttemptRepositoryV4 {
  const candidate = repo as unknown as Partial<DurableAttemptRepositoryV4>;
  expect(typeof candidate.reserveUnitAttempt).toBe("function");
  expect(typeof candidate.finishUnitAttempt).toBe("function");
  expect(typeof candidate.getUnitAttempts).toBe("function");
  expect(typeof candidate.getAttemptAccounting).toBe("function");
  return candidate as DurableAttemptRepositoryV4;
}

function reserveInput(unitId: string, overrides: Partial<ReserveUnitAttemptV4Input> = {}): ReserveUnitAttemptV4Input {
  return {
    runId: RUN_ID,
    unitId,
    stepId: "review",
    nodeId: "review.unit",
    phase: "unit",
    runner: "llm",
    engine: "test-llm",
    model: "exact-model",
    inputHash: `hash:${unitId}`,
    now: START,
    ...overrides,
  };
}

function eventRows(type?: "workflow_unit_started" | "workflow_unit_finished"): StoredEvent[] {
  const db = openStateDatabase(getStateDbPath());
  try {
    return (
      type
        ? db
            .prepare("SELECT id, event_type, ts, ref, metadata_json FROM events WHERE event_type = ? ORDER BY id")
            .all(type)
        : db
            .prepare(
              "SELECT id, event_type, ts, ref, metadata_json FROM events WHERE event_type LIKE 'workflow_unit_%' ORDER BY id",
            )
            .all()
    ) as StoredEvent[];
  } finally {
    db.close();
  }
}

function metadata(row: StoredEvent): Record<string, unknown> {
  return JSON.parse(row.metadata_json) as Record<string, unknown>;
}

function requiredEvent(row: StoredEvent | undefined): StoredEvent {
  if (!row) throw new Error("expected a workflow lifecycle event row");
  return row;
}

function finishInput(
  attempt: WorkflowRunUnitAttemptRowV4,
  overrides: Partial<FinishUnitAttemptV4Input> = {},
): FinishUnitAttemptV4Input {
  return {
    runId: attempt.run_id,
    unitId: attempt.unit_id,
    attempt: attempt.attempt,
    dispatchId: attempt.dispatch_id,
    status: "completed",
    resultJson: JSON.stringify({ message: "safe result" }),
    tokens: 7,
    failureReason: null,
    sessionId: "session-safe",
    finishedAt: "2026-08-22T12:00:03.000Z",
    ...overrides,
  };
}

describe("migration 022 — append-only workflow unit attempts", () => {
  test("creates the attempt table with a composite run/unit/attempt key and unique dispatch ids", () => {
    const db = openStateDatabase(getStateDbPath());
    try {
      const columns = db.prepare("PRAGMA table_info(workflow_run_unit_attempts)").all() as Array<{
        name: string;
        pk: number;
      }>;
      const names = new Set(columns.map((column) => column.name));
      for (const required of [
        "run_id",
        "unit_id",
        "attempt",
        "dispatch_id",
        "step_id",
        "node_id",
        "phase",
        "runner",
        "engine",
        "model",
        "input_hash",
        "status",
        "result_json",
        "tokens",
        "failure_reason",
        "session_id",
        "worktree_path",
        "started_at",
        "finished_at",
        "claim_holder",
        "claim_expires_at",
      ]) {
        expect(names.has(required)).toBe(true);
      }
      expect(
        columns
          .filter((column) => column.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map((column) => column.name),
      ).toEqual(["run_id", "unit_id", "attempt"]);

      const indexes = db.prepare("PRAGMA index_list(workflow_run_unit_attempts)").all() as Array<{
        name: string;
        unique: number;
      }>;
      const uniqueDispatchIndex = indexes.find((index) => {
        if (index.unique !== 1) return false;
        const indexed = db.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as Array<{ name: string }>;
        return indexed.map((column) => column.name).join(",") === "dispatch_id";
      });
      expect(uniqueDispatchIndex).toBeDefined();

      const migration = db.prepare("SELECT id FROM schema_migrations WHERE id = '022-workflow-unit-attempts'").get() as
        | { id: string }
        | undefined;
      expect(migration?.id).toBe("022-workflow-unit-attempts");
    } finally {
      db.close();
    }
  });
});

describe("attempt reservation + workflow_unit_started transaction", () => {
  test("reserves attempt 1 and emits exactly one directly-paired started event before dispatch", async () => {
    await withWorkflowRunsRepo((repo) => {
      const result = durableAttempts(repo).reserveUnitAttempt(reserveInput("review.unit:one"));
      expect(result.kind).toBe("reserved");
      expect(result.attempt).toMatchObject({
        run_id: RUN_ID,
        unit_id: "review.unit:one",
        attempt: 1,
        step_id: "review",
        node_id: "review.unit",
        phase: "unit",
        status: "running",
        input_hash: "hash:review.unit:one",
      });
      expect(result.attempt.dispatch_id).toMatch(/^[0-9a-f-]{16,}$/i);
      expect(durableAttempts(repo).getUnitAttempts(RUN_ID, "review.unit:one")).toEqual([result.attempt]);

      const started = eventRows("workflow_unit_started");
      expect(started).toHaveLength(1);
      expect(started[0]?.ref).toBe(WORKFLOW_REF);
      expect(metadata(requiredEvent(started[0]))).toEqual({
        runId: RUN_ID,
        stepId: "review",
        unitId: "review.unit:one",
        attempt: 1,
        dispatchId: result.attempt.dispatch_id,
        phase: "unit",
        status: "running",
      });
      expect(eventRows("workflow_unit_finished")).toHaveLength(0);
    });
  });

  test("rolls the attempt row back when its started event cannot be inserted", async () => {
    const db = openStateDatabase(getStateDbPath());
    try {
      db.exec(`
        CREATE TRIGGER fail_attempt_started_event
        BEFORE INSERT ON events
        WHEN NEW.event_type = 'workflow_unit_started'
        BEGIN
          SELECT RAISE(ABORT, 'injected started-event failure');
        END;
      `);
    } finally {
      db.close();
    }

    await withWorkflowRunsRepo((repo) => {
      const attempts = durableAttempts(repo);
      expect(() => attempts.reserveUnitAttempt(reserveInput("review.unit:rollback"))).toThrow(
        /injected started-event failure/,
      );
      expect(attempts.getUnitAttempts(RUN_ID, "review.unit:rollback")).toEqual([]);
      expect(eventRows()).toEqual([]);
    });
  });

  test("re-reserving a still-running attempt hands back the same attempt and dispatch id, with one event", async () => {
    await withWorkflowRunsRepo((repo) => {
      const attempts = durableAttempts(repo);
      const first = attempts.reserveUnitAttempt(reserveInput("review.unit:idempotent"));
      const duplicate = attempts.reserveUnitAttempt(reserveInput("review.unit:idempotent"));
      expect(duplicate.kind).toBe("reclaimed");
      expect(duplicate.attempt.attempt).toBe(first.attempt.attempt);
      expect(duplicate.attempt.dispatch_id).toBe(first.attempt.dispatch_id);
      expect(attempts.getUnitAttempts(RUN_ID, "review.unit:idempotent")).toHaveLength(1);
      expect(eventRows("workflow_unit_started")).toHaveLength(1);
    });
  });

  test("refuses reservations after the owning run becomes terminal", async () => {
    const db = openStateDatabase(getStateDbPath());
    try {
      db.prepare("UPDATE workflow_runs SET status = 'failed' WHERE id = ?").run(RUN_ID);
    } finally {
      db.close();
    }
    await withWorkflowRunsRepo((repo) => {
      const attempts = durableAttempts(repo);
      expect(() => attempts.reserveUnitAttempt(reserveInput("review.unit:terminal-run"))).toThrow(/active/i);
      expect(attempts.getUnitAttempts(RUN_ID, "review.unit:terminal-run")).toEqual([]);
      expect(eventRows()).toEqual([]);
    });
  });
});

describe("attempt finish + workflow_unit_finished transaction", () => {
  test("commits terminal outcome, known usage, and its directly-paired finished event once", async () => {
    await withWorkflowRunsRepo((repo) => {
      const attempts = durableAttempts(repo);
      const reserved = attempts.reserveUnitAttempt(reserveInput("review.unit:finish")).attempt;
      expect(attempts.finishUnitAttempt(finishInput(reserved))).toBe(true);

      const [finished] = attempts.getUnitAttempts(RUN_ID, reserved.unit_id);
      expect(finished).toMatchObject({
        attempt: 1,
        dispatch_id: reserved.dispatch_id,
        status: "completed",
        result_json: JSON.stringify({ message: "safe result" }),
        tokens: 7,
        failure_reason: null,
        session_id: "session-safe",
        finished_at: "2026-08-22T12:00:03.000Z",
      });

      const events = eventRows();
      expect(events.map((row) => row.event_type)).toEqual(["workflow_unit_started", "workflow_unit_finished"]);
      expect(metadata(requiredEvent(events[1]))).toEqual({
        runId: RUN_ID,
        stepId: "review",
        unitId: reserved.unit_id,
        attempt: 1,
        dispatchId: reserved.dispatch_id,
        phase: "unit",
        status: "completed",
        tokens: 7,
      });
      expect(events[1]?.metadata_json).not.toContain("safe result");
      expect(events[1]?.metadata_json).not.toContain("session-safe");

      // A duplicate/late terminal callback cannot add usage or another event.
      expect(attempts.finishUnitAttempt(finishInput(reserved, { tokens: 999 }))).toBe(false);
      expect(attempts.getUnitAttempts(RUN_ID, reserved.unit_id)[0]?.tokens).toBe(7);
      expect(eventRows("workflow_unit_finished")).toHaveLength(1);
    });
  });

  test("rolls terminal columns back when the finished event cannot be inserted", async () => {
    await withWorkflowRunsRepo((repo) => {
      const attempts = durableAttempts(repo);
      const reserved = attempts.reserveUnitAttempt(reserveInput("review.unit:finish-rollback")).attempt;
      const db = openStateDatabase(getStateDbPath());
      try {
        db.exec(`
          CREATE TRIGGER fail_attempt_finished_event
          BEFORE INSERT ON events
          WHEN NEW.event_type = 'workflow_unit_finished'
          BEGIN
            SELECT RAISE(ABORT, 'injected finished-event failure');
          END;
        `);
      } finally {
        db.close();
      }

      expect(() => attempts.finishUnitAttempt(finishInput(reserved))).toThrow(/injected finished-event failure/);
      expect(attempts.getUnitAttempts(RUN_ID, reserved.unit_id)[0]).toMatchObject({
        status: "running",
        result_json: null,
        tokens: null,
        failure_reason: null,
        finished_at: null,
      });
      expect(eventRows("workflow_unit_finished")).toHaveLength(0);
    });
  });

  test("records timeout and cancellation as terminal failures without invented usage", async () => {
    await withWorkflowRunsRepo((repo) => {
      const attempts = durableAttempts(repo);
      const timeout = attempts.reserveUnitAttempt(reserveInput("review.unit:timeout")).attempt;
      const cancelled = attempts.reserveUnitAttempt(reserveInput("review.unit:cancelled")).attempt;
      expect(
        attempts.finishUnitAttempt(
          finishInput(timeout, {
            status: "failed",
            resultJson: JSON.stringify("timed out"),
            tokens: null,
            failureReason: "timeout",
          }),
        ),
      ).toBe(true);
      expect(
        attempts.finishUnitAttempt(
          finishInput(cancelled, {
            status: "failed",
            resultJson: JSON.stringify("cancelled"),
            tokens: null,
            failureReason: "aborted",
          }),
        ),
      ).toBe(true);

      expect(attempts.getUnitAttempts(RUN_ID, timeout.unit_id)[0]).toMatchObject({
        status: "failed",
        tokens: null,
        failure_reason: "timeout",
      });
      expect(attempts.getUnitAttempts(RUN_ID, cancelled.unit_id)[0]).toMatchObject({
        status: "failed",
        tokens: null,
        failure_reason: "aborted",
      });
      expect(eventRows("workflow_unit_finished").map(metadata)).toEqual([
        {
          runId: RUN_ID,
          stepId: "review",
          unitId: timeout.unit_id,
          attempt: 1,
          dispatchId: timeout.dispatch_id,
          phase: "unit",
          status: "failed",
          failureReason: "timeout",
        },
        {
          runId: RUN_ID,
          stepId: "review",
          unitId: cancelled.unit_id,
          attempt: 1,
          dispatchId: cancelled.dispatch_id,
          phase: "unit",
          status: "failed",
          failureReason: "aborted",
        },
      ]);
    });
  });
});

describe("append-only retry, reclaim, late finish, and accounting", () => {
  test("a policy retry appends attempt 2 with a new dispatch id and preserves attempt 1", async () => {
    await withWorkflowRunsRepo((repo) => {
      const attempts = durableAttempts(repo);
      const first = attempts.reserveUnitAttempt(reserveInput("review.unit:retry")).attempt;
      expect(
        attempts.finishUnitAttempt(
          finishInput(first, {
            status: "failed",
            resultJson: JSON.stringify("rate limited"),
            tokens: 3,
            failureReason: "llm_rate_limit",
          }),
        ),
      ).toBe(true);
      const second = attempts.reserveUnitAttempt(
        reserveInput("review.unit:retry", { now: "2026-08-22T12:00:10.000Z" }),
      );
      expect(second.kind).toBe("reserved");
      expect(second.attempt.attempt).toBe(2);
      expect(second.attempt.dispatch_id).not.toBe(first.dispatch_id);

      expect(attempts.getUnitAttempts(RUN_ID, first.unit_id)).toEqual([
        expect.objectContaining({
          attempt: 1,
          dispatch_id: first.dispatch_id,
          status: "failed",
          tokens: 3,
          failure_reason: "llm_rate_limit",
        }),
        expect.objectContaining({
          attempt: 2,
          dispatch_id: second.attempt.dispatch_id,
          status: "running",
          tokens: null,
        }),
      ]);
      expect(eventRows("workflow_unit_started").map((row) => metadata(row).attempt)).toEqual([1, 2]);
    });
  });

  test("reclaims a crashed driver's running reservation in place with the stable dispatch id; the first finish wins", async () => {
    await withWorkflowRunsRepo((repo) => {
      const attempts = durableAttempts(repo);
      const first = attempts.reserveUnitAttempt(
        reserveInput("review.unit:crash", { now: "2026-08-22T11:59:00.000Z" }),
      ).attempt;
      const reclaimed = attempts.reserveUnitAttempt(reserveInput("review.unit:crash", { now: START }));
      expect(reclaimed.kind).toBe("reclaimed");
      expect(reclaimed.attempt.attempt).toBe(1);
      expect(reclaimed.attempt.dispatch_id).toBe(first.dispatch_id);
      expect(eventRows("workflow_unit_started")).toHaveLength(1);

      // The re-dispatch finishes first; the crashed driver's late callback for
      // the same attempt cannot overwrite it or charge 101 more tokens.
      expect(
        attempts.finishUnitAttempt(finishInput(reclaimed.attempt, { resultJson: JSON.stringify("winner"), tokens: 5 })),
      ).toBe(true);
      expect(attempts.finishUnitAttempt(finishInput(first, { tokens: 101 }))).toBe(false);
      expect(attempts.getUnitAttempts(RUN_ID, first.unit_id)).toEqual([
        expect.objectContaining({
          attempt: 1,
          dispatch_id: first.dispatch_id,
          status: "completed",
          result_json: JSON.stringify("winner"),
          tokens: 5,
        }),
      ]);
      expect(eventRows("workflow_unit_finished")).toHaveLength(1);
      expect(attempts.getAttemptAccounting(RUN_ID)).toEqual({
        totalAttempts: 1,
        totalTokens: 5,
        dispatchAttempts: 1,
        dispatchTokens: 5,
        gateAttempts: 0,
        gateTokens: 0,
      });
    });
  });

  test("gate attempts use the same row/event transactions; usage is retained but excluded only from unit budget totals", async () => {
    await withWorkflowRunsRepo((repo) => {
      const attempts = durableAttempts(repo);
      const unit = attempts.reserveUnitAttempt(reserveInput("review.unit:accounted")).attempt;
      expect(attempts.finishUnitAttempt(finishInput(unit, { tokens: 7 }))).toBe(true);

      const gate = attempts.reserveUnitAttempt(
        reserveInput("review.gate:l1", {
          nodeId: "review.gate",
          phase: "gate",
          runner: "llm",
          inputHash: "hash:review-gate-l1",
        }),
      ).attempt;
      expect(
        attempts.finishUnitAttempt(
          finishInput(gate, {
            resultJson: JSON.stringify({ complete: true, missing: [] }),
            tokens: 5,
          }),
        ),
      ).toBe(true);

      expect(attempts.getUnitAttempts(RUN_ID, gate.unit_id)).toEqual([
        expect.objectContaining({ phase: "gate", status: "completed", tokens: 5 }),
      ]);
      expect(attempts.getAttemptAccounting(RUN_ID)).toEqual({
        totalAttempts: 2,
        totalTokens: 12,
        dispatchAttempts: 1,
        dispatchTokens: 7,
        gateAttempts: 1,
        gateTokens: 5,
      });
      expect(eventRows("workflow_unit_started").map(metadata)).toEqual([
        expect.objectContaining({ attempt: 1, dispatchId: unit.dispatch_id, phase: "unit" }),
        expect.objectContaining({ attempt: 1, dispatchId: gate.dispatch_id, phase: "gate" }),
      ]);
      expect(eventRows("workflow_unit_finished").map(metadata)).toEqual([
        expect.objectContaining({ attempt: 1, dispatchId: unit.dispatch_id, phase: "unit", tokens: 7 }),
        expect.objectContaining({ attempt: 1, dispatchId: gate.dispatch_id, phase: "gate", tokens: 5 }),
      ]);
    });
  });
});
