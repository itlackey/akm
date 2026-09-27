// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P3a Lane C TESTS — `publishChildWorkflowRun` and its accessors.
 *
 * Spec: docs/plans/specs/p3a-plan-v5-child-freeze.md §5.2-§5.5 (binding
 * design), §1.4(2-4) (Lane C design), §1.8 A-N12 (spawnedByUnitId naming).
 * Behavior-table rows covered: C-07…C-15 (§2.9). This lane owns ONLY this
 * file and tests/integration/state-migration-023.test.ts.
 *
 * RED phase: `WorkflowRunsRepository.publishChildWorkflowRun`, `childRunsOf`,
 * and `getRunByInvocationKey` do not exist yet. This file references them
 * ONLY through a locally-declared structural contract
 * (`ChildWorkflowRunsRepositoryV4`) intersected onto the real repository
 * instance, exactly the convention already established for this same
 * "repository gains a new method" situation by
 * tests/integration/workflows/v4-atomic-publication-red.test.ts
 * (`RepositoryWithV4Publisher`, `publishV4`) and
 * tests/integration/workflows/durable-attempt-journal-v4-red.test.ts
 * (`DurableAttemptRepositoryV4`, `durableAttempts`). `WorkflowRunsRepository &
 * Partial<ChildWorkflowRunsRepositoryV4>` is valid whether or not the class
 * already declares those members, so this produces no compile error to
 * suppress — no `@ts-expect-error` red-phase pin is needed anywhere in this
 * file. The RED signal is `expect(typeof candidate.X).toBe("function")`
 * failing at test time (the method is `undefined` today), exactly like the
 * two precedent files. `PublishChildWorkflowRunInput` and the three new
 * `workflow_runs` columns are likewise not imported — they are mirrored
 * locally (`PublishChildWorkflowRunInputContract`, `ChildWorkflowRunRow`) for
 * the same reason `PublishWorkflowRunV4InputContract` mirrors
 * `PublishWorkflowRunV4Input` in the sibling file above. Implement removes no
 * directive here (there is none) — it simply makes every `typeof` check, and
 * every behavioral assertion after it, true.
 *
 * The C-09 concurrency test spawns a real `node:worker_threads` Worker with
 * its OWN `bun:sqlite` connection against the SAME state.db file — the same
 * "genuinely separate connection/thread, real file, real locking" technique
 * tests/storage/state-db-migrations.test.ts already uses for its
 * writer-exclusion-window tests — so the partial unique index and SQLite's
 * own IMMEDIATE-transaction serialization are exercised for real, never a
 * mocked repository (§5.4).
 *
 * TEST-REVIEW FOLLOW-UP (round 3, finding 3): a file-polling handshake alone
 * (worker writes "ready", main notices it on its next ~5 ms poll tick) does
 * NOT force a genuine overlap — a synchronous, uncontended SQLite write on
 * an empty table is fast enough that the worker's whole
 * publishChildWorkflowRun call (BEGIN IMMEDIATE → SELECT → INSERT → COMMIT)
 * routinely finishes before main's poll even notices "ready", so main's own
 * call degenerates into an ordinary, uncontested SELECT-finds-a-committed-row
 * read — C-08's idempotency case again, just replayed across two
 * connections. An implementation that SELECTs outside its transaction, or
 * opens a DEFERRED transaction instead of an IMMEDIATE one, would still pass
 * that shape of test, because neither publisher's "not found yet" read is
 * ever forced to overlap with the other's write. C-09 now forces a REAL
 * overlap deterministically: the main connection takes a raw `BEGIN
 * IMMEDIATE` write lock BEFORE the worker is even spawned, so the worker's
 * own `BEGIN IMMEDIATE` (inside its publishChildWorkflowRun call) is
 * guaranteed to block against a real reserved lock; main then holds it for a
 * short, deterministic pause (the same 150 ms margin
 * tests/storage/state-db-migrations.test.ts's own writer-exclusion-window
 * tests use for the identical purpose) before releasing it and immediately
 * racing its OWN publishChildWorkflowRun call — issued on the very next
 * line, no I/O in between — against the worker's already-blocked,
 * busy_timeout-driven retry for that same freshly-released lock. Whichever
 * wins, the loser's own SELECT (which can only run once it has actually
 * acquired the write lock in turn) is now forced to run AFTER the winner's
 * commit, never before it — exercising the real loser path instead of a
 * pre-decided sequential read. A second, fully deterministic test below
 * (no worker, no timing) covers the complementary half of the same
 * contract: a winner row inserted by raw SQL — never through
 * publishChildWorkflowRun — must still be recognized by the SELECT-first
 * branch, with no second insert and no second workflow_started event.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import type { Database } from "../../../src/storage/database";
import { readStateEvents } from "../../../src/storage/repositories/events-repository";
import {
  type InsertRunInput,
  type InsertStepInput,
  type WorkflowRunRow,
  WorkflowRunsRepository,
} from "../../../src/storage/repositories/workflow-runs-repository";
import { canonicalPlanJson, computePlanHash } from "../../../src/workflows/ir/plan-hash";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";
import { seedWorkflowRun } from "../../_helpers/workflow";

// ── §5.2/§5.3 mirrored locally (see file header) ────────────────────────────

interface PublishChildWorkflowRunInputContract {
  readonly parentRunId: string;
  /** Stored in workflow_runs.parent_unit_id — A-N12 naming. */
  readonly spawnedByUnitId: string;
  readonly invocationKey: string;
  readonly run: InsertRunInput;
  readonly steps: InsertStepInput[];
  /** Canonical JSON of the embedded frozen child plan. Never re-derived from source. */
  readonly planJson: string;
  readonly planHash: string;
}

interface ChildWorkflowRunRow extends WorkflowRunRow {
  parent_run_id: string | null;
  parent_unit_id: string | null;
  invocation_key: string | null;
}

interface ChildWorkflowRunsRepositoryV4 {
  publishChildWorkflowRun(input: PublishChildWorkflowRunInputContract): ChildWorkflowRunRow;
  childRunsOf(parentRunId: string): ChildWorkflowRunRow[];
  getRunByInvocationKey(parentRunId: string, key: string): ChildWorkflowRunRow | undefined;
}

/** Duck-types the not-yet-implemented methods onto a real repository instance (see file header). */
function childPublication(repo: WorkflowRunsRepository): ChildWorkflowRunsRepositoryV4 {
  const candidate = repo as unknown as Partial<ChildWorkflowRunsRepositoryV4>;
  expect(typeof candidate.publishChildWorkflowRun).toBe("function");
  expect(typeof candidate.childRunsOf).toBe("function");
  expect(typeof candidate.getRunByInvocationKey).toBe("function");
  return candidate as ChildWorkflowRunsRepositoryV4;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = "2026-08-26T12:00:00.000Z";
const PARENT_RUN_ID = "11111111-1111-4111-8111-111111111111";
const PARENT_WORKFLOW_REF = "workflows/parent";
const PARENT_SCOPE_KEY = "dir:v1:parent";
const SPAWNING_UNIT_ID = "spawn.unit";

/** A structurally-arbitrary "frozen child plan" — publishChildWorkflowRun stores it opaquely (C-11). */
function childPlanFixture(marker = "default"): { planJson: string; planHash: string } {
  const fakePlan = { irVersion: 5, title: "child", steps: [{ stepId: "spawn", title: "spawn" }], marker };
  return { planJson: canonicalPlanJson(fakePlan), planHash: computePlanHash(fakePlan) };
}

function publicationInput(options: {
  parentRunId: string;
  spawnedByUnitId?: string;
  invocationKey: string;
  runId: string;
  workflowRef?: string;
  scopeKey?: string;
  planMarker?: string;
  createdAt?: string;
}): PublishChildWorkflowRunInputContract {
  const { planJson, planHash } = childPlanFixture(options.planMarker ?? options.runId);
  const workflowRef = options.workflowRef ?? "workflows/child";
  const createdAt = options.createdAt ?? NOW;
  const run: InsertRunInput = {
    id: options.runId,
    workflowRef,
    scopeKey: options.scopeKey ?? PARENT_SCOPE_KEY,
    workflowEntryId: null,
    workflowTitle: "child",
    paramsJson: "{}",
    currentStepId: "spawn",
    createdAt,
    updatedAt: createdAt,
    agentHarness: null,
    agentSessionId: null,
  };
  const steps: InsertStepInput[] = [
    {
      runId: options.runId,
      stepId: "spawn",
      stepTitle: "spawn",
      instructions: "Do the child work.",
      completionJson: null,
      sequenceIndex: 0,
    },
  ];
  return {
    parentRunId: options.parentRunId,
    spawnedByUnitId: options.spawnedByUnitId ?? SPAWNING_UNIT_ID,
    invocationKey: options.invocationKey,
    run,
    steps,
    planJson,
    planHash,
  };
}

/**
 * Inserts a COMPLETE child run row directly via raw SQL — never through
 * publishChildWorkflowRun — so the deterministic loser-path test below
 * (test-review round 3, finding 3) can prove the SELECT-first branch
 * recognizes ANY existing (parent_run_id, invocation_key) match, not merely
 * a row it inserted itself. Column list mirrors workflow_runs' full schema
 * (migrations.ts:882-902) plus migration 023's three additive columns
 * (§5.1). Like every other reference to those three columns in this file,
 * this only ever executes once Implement lands the migration alongside
 * publishChildWorkflowRun — every caller reaches it through
 * childPublication(repo) first, which fails the same "not implemented" way
 * as every other test in this file (see file header) before this helper's
 * INSERT would ever run against today's pre-migration-023 schema.
 */
function rawInsertChildRun(db: Database, input: PublishChildWorkflowRunInputContract): void {
  db.prepare(
    `INSERT INTO workflow_runs (
      id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status, params_json, current_step_id,
      created_at, updated_at, agent_harness, agent_session_id,
      plan_json, plan_hash, plan_ir_version, parent_run_id, parent_unit_id, invocation_key
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, 5, ?, ?, ?)`,
  ).run(
    input.run.id,
    input.run.workflowRef,
    input.run.scopeKey,
    input.run.workflowEntryId,
    input.run.workflowTitle,
    input.run.paramsJson,
    input.run.currentStepId,
    input.run.createdAt,
    input.run.updatedAt,
    input.run.agentHarness,
    input.run.agentSessionId,
    input.planJson,
    input.planHash,
    input.parentRunId,
    input.spawnedByUnitId,
    input.invocationKey,
  );
}

function seedParentRun(db: Database, runId = PARENT_RUN_ID): void {
  seedWorkflowRun(db, {
    runId,
    workflowRef: PARENT_WORKFLOW_REF,
    scopeKey: PARENT_SCOPE_KEY,
    steps: ["spawn"],
  });
}

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => storage.cleanup());

// ── C-07: one-transaction publication ───────────────────────────────────────

describe("publishChildWorkflowRun — atomic publication (C-07)", () => {
  test("inserts the child run row, its step, and one workflow_started event, and returns the inserted row", () => {
    const db = openStateDatabase(getStateDbPath());
    try {
      seedParentRun(db);
      const repo = new WorkflowRunsRepository(db);
      const childRunId = "22222222-2222-4222-8222-222222222222";
      const input = publicationInput({ parentRunId: PARENT_RUN_ID, invocationKey: "key-atomic", runId: childRunId });

      const row = childPublication(repo).publishChildWorkflowRun(input);

      expect(row.id).toBe(childRunId);
      expect(row.workflow_ref).toBe(input.run.workflowRef);
      expect(row.status).toBe("active");
      expect(row.plan_json).toBe(input.planJson);
      expect(row.plan_hash).toBe(input.planHash);
      expect(row.plan_ir_version).toBe(6);
      expect(row.parent_run_id).toBe(PARENT_RUN_ID);
      // C-15 / A-N12: the input field is spawnedByUnitId; it lands in parent_unit_id.
      expect(row.parent_unit_id).toBe(SPAWNING_UNIT_ID);
      expect(row.invocation_key).toBe("key-atomic");

      const persisted = repo.getRunById(childRunId) as ChildWorkflowRunRow | undefined;
      expect(persisted).toEqual(row);

      const steps = repo.getStepsForRun(childRunId);
      expect(steps.map((step) => step.step_id)).toEqual(["spawn"]);
      expect(steps[0]?.status).toBe("pending");

      const events = readStateEvents(db, { type: "workflow_started", ref: input.run.workflowRef }).events;
      expect(events).toHaveLength(1);
      expect(events[0]?.metadata).toEqual({ runId: childRunId, status: "active" });

      // The parent run itself is untouched by a child publication.
      const parent = repo.getRunById(PARENT_RUN_ID);
      expect(parent?.status).toBe("active");
      expect(parent?.plan_json).toBeNull();
    } finally {
      db.close();
    }
  });

  const ATOMICITY_CHILD_RUN_ID = "33333333-3333-4333-8333-333333333333";

  test.each([
    [
      "child run insert",
      `CREATE TRIGGER child_pub_fail_run AFTER INSERT ON workflow_runs WHEN NEW.id = '${ATOMICITY_CHILD_RUN_ID}' BEGIN SELECT RAISE(ABORT, 'child-pub-fail-run'); END`,
    ],
    [
      "child step insert",
      `CREATE TRIGGER child_pub_fail_steps AFTER INSERT ON workflow_run_steps WHEN NEW.run_id = '${ATOMICITY_CHILD_RUN_ID}' BEGIN SELECT RAISE(ABORT, 'child-pub-fail-steps'); END`,
    ],
    [
      "plan attachment",
      `CREATE TRIGGER child_pub_fail_plan AFTER UPDATE OF plan_json ON workflow_runs WHEN NEW.id = '${ATOMICITY_CHILD_RUN_ID}' AND NEW.plan_ir_version = 6 BEGIN SELECT RAISE(ABORT, 'child-pub-fail-plan'); END`,
    ],
    [
      "workflow_started event insert",
      "CREATE TRIGGER child_pub_fail_event AFTER INSERT ON events WHEN NEW.event_type = 'workflow_started' BEGIN SELECT RAISE(ABORT, 'child-pub-fail-event'); END",
    ],
  ] as const)("rolls back the child run, its steps, and its event together when %s fails", (_label, triggerSql) => {
    const db = openStateDatabase(getStateDbPath());
    try {
      seedParentRun(db);
      db.exec(triggerSql);
      const repo = new WorkflowRunsRepository(db);
      const input = publicationInput({
        parentRunId: PARENT_RUN_ID,
        invocationKey: "key-fail",
        runId: ATOMICITY_CHILD_RUN_ID,
      });

      // childPublication(repo) is resolved OUTSIDE the toThrow wrapper so a
      // not-yet-implemented method fails this test directly and clearly,
      // rather than being masked as "yes, something threw" by the wrapper.
      const child = childPublication(repo);
      expect(() => child.publishChildWorkflowRun(input)).toThrow();

      expect(repo.getRunById(ATOMICITY_CHILD_RUN_ID)).toBeUndefined();
      expect(repo.getStepsForRun(ATOMICITY_CHILD_RUN_ID)).toEqual([]);
      expect(readStateEvents(db, { type: "workflow_started", ref: input.run.workflowRef }).events).toEqual([]);
      // A failed child publication must not corrupt or touch the parent run.
      expect(repo.getRunById(PARENT_RUN_ID)?.status).toBe("active");
    } finally {
      db.close();
    }
  });
});

// ── C-08: idempotent second call ────────────────────────────────────────────

describe("publishChildWorkflowRun — idempotent second call (C-08)", () => {
  test("a second call with the same (parentRunId, invocationKey) returns the SAME child row — no second insert, event, or step set", () => {
    const db = openStateDatabase(getStateDbPath());
    try {
      seedParentRun(db);
      const repo = new WorkflowRunsRepository(db);
      const firstRunId = "44444444-4444-4444-8444-444444444444";
      const secondCandidateRunId = "55555555-5555-4555-8555-555555555555";
      const invocationKey = "key-idempotent";

      const first = childPublication(repo).publishChildWorkflowRun(
        publicationInput({ parentRunId: PARENT_RUN_ID, invocationKey, runId: firstRunId, planMarker: "first" }),
      );

      // The second call carries a DIFFERENT candidate run id, plan, and steps —
      // proving the SELECT-first branch returns early without even looking at
      // them, not merely that an upsert happened to agree on shared values.
      const second = childPublication(repo).publishChildWorkflowRun(
        publicationInput({
          parentRunId: PARENT_RUN_ID,
          invocationKey,
          runId: secondCandidateRunId,
          planMarker: "second",
        }),
      );

      expect(second).toEqual(first);
      expect(second.id).toBe(firstRunId);
      expect(repo.getRunById(secondCandidateRunId)).toBeUndefined();
      expect(repo.getStepsForRun(secondCandidateRunId)).toEqual([]);

      const children = childPublication(repo).childRunsOf(PARENT_RUN_ID);
      expect(children.map((child) => child.id)).toEqual([firstRunId]);

      const events = readStateEvents(db, { type: "workflow_started", ref: "workflows/child" }).events;
      expect(events).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

// ── C-09: two concurrent publishers ─────────────────────────────────────────

function waitForFile(file: string, timeoutMs = 8_000): void {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  if (!fs.existsSync(file)) throw new Error(`Timed out waiting for ${file}`);
}

function buildConcurrentPublisherWorkerScript(options: {
  databaseModulePath: string;
  repositoryModulePath: string;
  dbPath: string;
  readyFile: string;
  resultFile: string;
  input: PublishChildWorkflowRunInputContract;
}): string {
  return `
import { openDatabase } from ${JSON.stringify(options.databaseModulePath)};
import { WorkflowRunsRepository } from ${JSON.stringify(options.repositoryModulePath)};
import { writeFileSync } from "node:fs";

const db = openDatabase(${JSON.stringify(options.dbPath)});
try {
  // Mirror openStateDatabase's own busy_timeout so a genuinely concurrent
  // BEGIN IMMEDIATE blocks and retries instead of failing outright — see the
  // file header and src/storage/sqlite-pragmas.ts.
  db.exec("PRAGMA busy_timeout = 30000");
  const repo = new WorkflowRunsRepository(db);
  writeFileSync(${JSON.stringify(options.readyFile)}, "ready");
  const publish = repo.publishChildWorkflowRun;
  if (typeof publish !== "function") {
    writeFileSync(
      ${JSON.stringify(options.resultFile)},
      JSON.stringify({ ok: false, error: "publishChildWorkflowRun is not implemented" }),
    );
  } else {
    const row = publish.call(repo, ${JSON.stringify(options.input)});
    writeFileSync(${JSON.stringify(options.resultFile)}, JSON.stringify({ ok: true, id: row.id }));
  }
} catch (error) {
  writeFileSync(
    ${JSON.stringify(options.resultFile)},
    JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
} finally {
  db.close();
}
`;
}

describe("publishChildWorkflowRun — two concurrent publishers (C-09)", () => {
  test("the loser reads the winner's row — never a duplicate row, never a thrown conflict", async () => {
    const dbPath = getStateDbPath();
    const db = openStateDatabase(dbPath);
    try {
      seedParentRun(db);
      const repo = new WorkflowRunsRepository(db);

      const invocationKey = "key-race";
      const mainRunId = "66666666-6666-4666-8666-666666666666";
      const workerRunId = "77777777-7777-4777-8777-777777777777";
      const mainInput = publicationInput({
        parentRunId: PARENT_RUN_ID,
        invocationKey,
        runId: mainRunId,
        planMarker: "main",
      });
      const workerInput = publicationInput({
        parentRunId: PARENT_RUN_ID,
        invocationKey,
        runId: workerRunId,
        planMarker: "worker",
      });

      const readyFile = path.join(storage.root, "child-race-ready");
      const resultFile = path.join(storage.root, "child-race-result.json");
      const workerScript = path.join(storage.root, "child-race-worker.mts");
      fs.writeFileSync(
        workerScript,
        buildConcurrentPublisherWorkerScript({
          databaseModulePath: path.resolve(import.meta.dir, "../../../src/storage/database.ts"),
          repositoryModulePath: path.resolve(
            import.meta.dir,
            "../../../src/storage/repositories/workflow-runs-repository.ts",
          ),
          dbPath,
          readyFile,
          resultFile,
          input: workerInput,
        }),
        "utf8",
      );

      // Take the write lock BEFORE the worker can possibly attempt its own
      // publish call, via a raw transaction on THIS connection — not through
      // publishChildWorkflowRun, which is atomic and would finish before the
      // test could hold anything open. This guarantees the worker's own
      // BEGIN IMMEDIATE (inside its publishChildWorkflowRun call, below)
      // blocks against a real reserved lock rather than racing on file-poll
      // timing alone (file header, test-review round 3).
      db.exec("BEGIN IMMEDIATE");

      const worker = new Worker(pathToFileURL(workerScript));
      let workerError = "";
      const workerExit = new Promise<number>((resolve) => {
        worker.once("exit", (code) => resolve(code));
        worker.once("error", (error) => {
          workerError = error.message;
        });
      });

      // Confirm the worker's own connection is open and it has reached (or
      // is immediately about to reach) its own publish call, which must now
      // be blocked against the lock just taken above.
      waitForFile(readyFile);
      // Deterministic pause: give the worker's blocked BEGIN IMMEDIATE time
      // to actually register against the held lock before releasing it —
      // same technique and margin as
      // tests/storage/state-db-migrations.test.ts's own
      // writer-exclusion-window tests.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);

      // Release, then immediately race main's OWN publish attempt — issued
      // on the very next line, no I/O in between — against the worker's
      // already-blocked, busy_timeout-driven retry for the SAME
      // freshly-released write lock. This is the genuine overlap C-09
      // requires (§5.4): whichever wins, the loser's own SELECT can only run
      // once it has acquired the lock in turn, i.e. strictly after the
      // winner's commit — never before it.
      db.exec("COMMIT");

      let mainThrew: unknown;
      let mainRow: ChildWorkflowRunRow | undefined;
      try {
        mainRow = childPublication(repo).publishChildWorkflowRun(mainInput);
      } catch (error) {
        mainThrew = error;
      }

      const exitCode = await Promise.race([
        workerExit,
        new Promise<number>((_resolve, reject) =>
          setTimeout(() => reject(new Error("concurrent child publisher timed out")), 15_000),
        ),
      ]);
      expect(workerError).toBe("");
      expect(exitCode).toBe(0);
      const workerResult = JSON.parse(fs.readFileSync(resultFile, "utf8")) as {
        ok: boolean;
        id?: string;
        error?: string;
      };

      expect(mainThrew).toBeUndefined();
      expect(workerResult.ok).toBe(true);
      if (!mainRow) throw new Error("expected the main publisher to return a row");

      // Both publishers agree on exactly one winner, whichever run id it is.
      expect([mainRunId, workerRunId]).toContain(mainRow.id);
      expect(workerResult.id).toBe(mainRow.id);

      const children = childPublication(repo).childRunsOf(PARENT_RUN_ID);
      expect(children).toHaveLength(1);
      expect(children[0]?.id).toBe(mainRow.id);

      const events = readStateEvents(db, { type: "workflow_started", ref: "workflows/child" }).events;
      expect(events).toHaveLength(1);
    } finally {
      db.close();
    }
  }, 20_000);
});

// ── C-09 (deterministic loser path): a raw-SQL pre-inserted winner ─────────
//
// Test-review round 3, finding 3. The worker-thread test above exercises a
// GENUINE race for the write lock; this test isolates the other half of
// §5.4's contract fully deterministically, with no concurrency, no timing,
// and no worker at all: the SELECT-first branch must recognize an existing
// (parent_run_id, invocation_key) row regardless of WHO inserted it — even
// a row publishChildWorkflowRun never itself wrote — and must perform no
// second insert and no second workflow_started event when it finds one.

describe("publishChildWorkflowRun — deterministic loser path via a pre-inserted winner (C-09)", () => {
  test("recognizes a winner row it did not insert itself — no second insert, no second event", () => {
    const db = openStateDatabase(getStateDbPath());
    try {
      seedParentRun(db);
      const repo = new WorkflowRunsRepository(db);
      // Resolved FIRST, before the raw SQL below ever touches migration
      // 023's columns — a not-yet-implemented method fails this test
      // directly and clearly here, exactly like every other test in this
      // file, rather than surfacing as an unrelated "no such column" error
      // out of rawInsertChildRun (same convention as the C-07 atomicity
      // table's own `const child = childPublication(repo);` above).
      const child = childPublication(repo);

      const invocationKey = "key-preinserted-winner";
      const winnerRunId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const loserCandidateRunId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

      const winnerInput = publicationInput({
        parentRunId: PARENT_RUN_ID,
        invocationKey,
        runId: winnerRunId,
        planMarker: "winner",
      });
      rawInsertChildRun(db, winnerInput);
      const winnerRow = repo.getRunById(winnerRunId) as ChildWorkflowRunRow | undefined;
      if (!winnerRow) throw new Error("expected the raw-inserted winner row to exist");

      // No event exists yet — the winner row was written by raw SQL, never
      // through publishChildWorkflowRun.
      expect(readStateEvents(db, { type: "workflow_started", ref: "workflows/child" }).events).toHaveLength(0);

      // A DIFFERENT candidate run id, plan, and steps under the SAME key —
      // proving the SELECT-first branch returns early without ever writing
      // them, not merely that an upsert happened to agree on shared values.
      const loserInput = publicationInput({
        parentRunId: PARENT_RUN_ID,
        invocationKey,
        runId: loserCandidateRunId,
        planMarker: "loser-candidate",
      });

      const returned = child.publishChildWorkflowRun(loserInput);

      expect(returned).toEqual(winnerRow);
      expect(returned.id).toBe(winnerRunId);
      // No second insert: the candidate's own run id and steps were never written.
      expect(repo.getRunById(loserCandidateRunId)).toBeUndefined();
      expect(repo.getStepsForRun(loserCandidateRunId)).toEqual([]);
      // Still exactly one child row under this key.
      const children = child.childRunsOf(PARENT_RUN_ID);
      expect(children.map((row) => row.id)).toEqual([winnerRunId]);
      // No second workflow_started event.
      expect(readStateEvents(db, { type: "workflow_started", ref: "workflows/child" }).events).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

// ── C-11: never reads child source ──────────────────────────────────────────

describe("publishChildWorkflowRun — no child source access (C-11)", () => {
  test("succeeds with no workflow source file on disk, and never calls fs.readFileSync under the stash dir", () => {
    const db = openStateDatabase(getStateDbPath());
    try {
      seedParentRun(db);
      // No workflow/task source file is ever written anywhere in this test —
      // the child's "workflows" directory does not even exist.
      expect(fs.existsSync(path.join(storage.stashDir, "workflows"))).toBe(false);

      const repo = new WorkflowRunsRepository(db);
      const readFileSyncSpy = spyOn(fs, "readFileSync");
      let row: ChildWorkflowRunRow;
      try {
        row = childPublication(repo).publishChildWorkflowRun(
          publicationInput({
            parentRunId: PARENT_RUN_ID,
            invocationKey: "key-no-source",
            runId: "88888888-8888-4888-8888-888888888888",
          }),
        );
      } finally {
        readFileSyncSpy.mockRestore();
      }

      expect(row.id).toBe("88888888-8888-4888-8888-888888888888");
      for (const call of readFileSyncSpy.mock.calls) {
        const target = String(call[0]);
        expect(target.startsWith(storage.stashDir)).toBe(false);
      }
      expect(fs.existsSync(path.join(storage.stashDir, "workflows"))).toBe(false);
    } finally {
      db.close();
    }
  });
});

// ── C-10: top-level scope-conflict rules do not apply ───────────────────────

describe("publishChildWorkflowRun — top-level scope-conflict rules do not apply (C-10)", () => {
  test("succeeds even when an active top-level run occupies the same (workflow_ref, scope_key) publishWorkflowRunV4 would reject", () => {
    const db = openStateDatabase(getStateDbPath());
    try {
      seedParentRun(db);
      const repo = new WorkflowRunsRepository(db);

      // An unrelated, already-active top-level run for the EXACT (workflow_ref,
      // scope_key) the child below publishes under. publishWorkflowRunV4 would
      // reject this with RESOURCE_ALREADY_EXISTS via findActiveRunForScope;
      // publishChildWorkflowRun must never consult that guard.
      seedWorkflowRun(db, {
        runId: "occupying-run",
        workflowRef: "workflows/child",
        scopeKey: PARENT_SCOPE_KEY,
        steps: ["work"],
      });
      expect(repo.findActiveRunForScope(["workflows/child"], PARENT_SCOPE_KEY)?.id).toBe("occupying-run");

      const input = publicationInput({
        parentRunId: PARENT_RUN_ID,
        invocationKey: "key-scope-irrelevant",
        runId: "99999999-9999-4999-8999-999999999999",
        workflowRef: "workflows/child",
        scopeKey: PARENT_SCOPE_KEY,
      });

      const row = childPublication(repo).publishChildWorkflowRun(input);

      expect(row.id).toBe("99999999-9999-4999-8999-999999999999");
      // The occupying run is unaffected — no conflict was raised against it.
      expect(repo.getRunById("occupying-run")?.status).toBe("active");
    } finally {
      db.close();
    }
  });
});

// ── C-13, C-14: accessors ────────────────────────────────────────────────────

describe("publishChildWorkflowRun accessors — childRunsOf, getRunByInvocationKey (C-13, C-14)", () => {
  test("childRunsOf returns [] for a childless parent, then every child in created_at, id order", () => {
    const db = openStateDatabase(getStateDbPath());
    try {
      seedParentRun(db);
      const repo = new WorkflowRunsRepository(db);
      expect(childPublication(repo).childRunsOf(PARENT_RUN_ID)).toEqual([]);

      const first = childPublication(repo).publishChildWorkflowRun(
        publicationInput({
          parentRunId: PARENT_RUN_ID,
          invocationKey: "key-1",
          runId: "a0000000-0000-4000-8000-000000000001",
          createdAt: "2026-08-26T12:00:00.000Z",
        }),
      );
      const second = childPublication(repo).publishChildWorkflowRun(
        publicationInput({
          parentRunId: PARENT_RUN_ID,
          invocationKey: "key-2",
          runId: "a0000000-0000-4000-8000-000000000002",
          createdAt: "2026-08-26T12:00:01.000Z",
        }),
      );

      const children = childPublication(repo).childRunsOf(PARENT_RUN_ID);
      expect(children.map((child) => child.id)).toEqual([first.id, second.id]);
      for (const child of children) {
        expect(child.parent_run_id).toBe(PARENT_RUN_ID);
      }
    } finally {
      db.close();
    }
  });

  test("getRunByInvocationKey returns the matching child row, or undefined for an unmatched (parentRunId, key) pair", () => {
    const db = openStateDatabase(getStateDbPath());
    try {
      seedParentRun(db);
      const repo = new WorkflowRunsRepository(db);
      expect(childPublication(repo).getRunByInvocationKey(PARENT_RUN_ID, "unknown-key")).toBeUndefined();

      const published = childPublication(repo).publishChildWorkflowRun(
        publicationInput({
          parentRunId: PARENT_RUN_ID,
          invocationKey: "key-lookup",
          runId: "b0000000-0000-4000-8000-000000000001",
        }),
      );

      expect(childPublication(repo).getRunByInvocationKey(PARENT_RUN_ID, "key-lookup")).toEqual(published);
      expect(childPublication(repo).getRunByInvocationKey(PARENT_RUN_ID, "unknown-key")).toBeUndefined();
      expect(childPublication(repo).getRunByInvocationKey("some-other-parent-id", "key-lookup")).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

// ── The outermost-transaction precondition (Review log R10) ────────────────
//
// publishChildWorkflowRun's method doc names an explicit precondition: its
// SELECT-else-INSERT atomicity guarantee holds ONLY when it is the OUTERMOST
// transaction on the connection, because `withImmediateTransaction`'s
// re-entrancy guard (src/core/state-db.ts) SILENTLY JOINS an already-open
// transaction instead of issuing its own `BEGIN IMMEDIATE` — a caller that
// wires this call inside `WorkflowRunsRepository.transaction()` or another
// `immediateTransaction` loses the guarantee with no error at the call site.
//
// A genuine two-connection race that PROVES the corruption this precondition
// guards against (two nested callers both missing each other's SELECT and
// hitting a raw UNIQUE-constraint SQLiteError instead of C-09's graceful
// "loser reads the winner's row") would need to inject an artificial delay
// between this method's own SELECT and INSERT — which means calling a
// hand-rolled stand-in for the method's SQL, not the real method, undermining
// the "real call path" this is meant to prove. What CAN be proven against the
// real method, deterministically, with no timing and no second connection: it
// opens its own `BEGIN IMMEDIATE`/`COMMIT` when nothing else has a transaction
// open on the connection (the safe case every other describe block above
// exercises), and — the precondition's exact failure mode — executes NOT ONE
// exec() of its own when a transaction is already open, silently forfeiting
// the isolation boundary the SELECT-else-INSERT sequence depends on. This
// pins the exact mechanism by which nesting silently defeats the guarantee,
// through the real, unmodified `publishChildWorkflowRun`.
describe("publishChildWorkflowRun — the outermost-transaction precondition (Review log R10)", () => {
  test("issues its own BEGIN IMMEDIATE/COMMIT when it is the outermost transaction", () => {
    const db = openStateDatabase(getStateDbPath());
    try {
      seedParentRun(db);
      const repo = new WorkflowRunsRepository(db);
      const originalExec = db.exec.bind(db);
      const execCalls: string[] = [];
      const spy = spyOn(db, "exec").mockImplementation((sql: string) => {
        execCalls.push(sql);
        return originalExec(sql);
      });
      try {
        childPublication(repo).publishChildWorkflowRun(
          publicationInput({
            parentRunId: PARENT_RUN_ID,
            invocationKey: "key-outermost",
            runId: "c0000000-0000-4000-8000-0000000000c1",
          }),
        );
      } finally {
        spy.mockRestore();
      }

      expect(execCalls).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
    } finally {
      db.close();
    }
  });

  test("a caller that already has a transaction open on the connection makes publishChildWorkflowRun silently JOIN it — no BEGIN IMMEDIATE, no COMMIT, no isolation boundary of its own", () => {
    const db = openStateDatabase(getStateDbPath());
    try {
      seedParentRun(db);
      const repo = new WorkflowRunsRepository(db);

      // Simulate exactly the risk the method doc names: a caller (e.g. a
      // future `resumeWorkflowRun`/`completeWorkflowStep` refactor) already
      // has a transaction open on this SAME connection before reaching
      // publishChildWorkflowRun.
      db.exec("BEGIN");
      try {
        const originalExec = db.exec.bind(db);
        const execCalls: string[] = [];
        const spy = spyOn(db, "exec").mockImplementation((sql: string) => {
          execCalls.push(sql);
          return originalExec(sql);
        });
        let row: ChildWorkflowRunRow;
        try {
          row = childPublication(repo).publishChildWorkflowRun(
            publicationInput({
              parentRunId: PARENT_RUN_ID,
              invocationKey: "key-nested",
              runId: "c0000000-0000-4000-8000-0000000000c2",
            }),
          );
        } finally {
          spy.mockRestore();
        }

        // The row is still written correctly — nesting does not corrupt a
        // SOLO call. What's lost is the ISOLATION boundary: no exec() of its
        // own ran, so nothing here would stop a second, concurrent nested
        // caller from reading the same "not found yet" snapshot this one did.
        expect(row.invocation_key).toBe("key-nested");
        expect(execCalls).toEqual([]);
      } finally {
        db.exec("COMMIT");
      }
    } finally {
      db.close();
    }
  });
});
