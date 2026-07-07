// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { WorkflowRunStatus, WorkflowRunStepStatus } from "../../sources/types";
import { closeWorkflowDatabase, openWorkflowDatabase } from "../../workflows/db";
import type { Database } from "../database";
import { resolveStorageLocations } from "../locations";

/**
 * Row shapes for the `workflow_runs` / `workflow_run_steps` tables.
 *
 * These mirror the on-disk columns exactly and were lifted verbatim from
 * {@link ../../workflows/runs} when the raw SQL was consolidated behind this
 * repository (WS5). The repository owns ALL SQL that touches these two tables.
 */
export type WorkflowRunRow = {
  id: string;
  workflow_ref: string;
  scope_key: string | null;
  workflow_entry_id: number | null;
  workflow_title: string;
  status: WorkflowRunStatus;
  params_json: string;
  current_step_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  agent_harness: string | null;
  agent_session_id: string | null;
  checkin_armed_at: string | null;
  /** Frozen compiled plan — canonical plan JSON (migration 006, redesign addendum R1). NULL on legacy runs. */
  plan_json: string | null;
  /** sha256 (hex) of the canonical plan JSON; integrity-checked on every load. */
  plan_hash: string | null;
  /** Run-lease expiry (ISO-8601 UTC; migration 006, enforced since R2). NULL when no engine holds the run. */
  engine_lease_until: string | null;
  /** Random holder id of the engine invocation driving the run. NULL when unleased. */
  engine_lease_holder: string | null;
};

export type WorkflowRunStepRow = {
  run_id: string;
  step_id: string;
  step_title: string;
  instructions: string;
  completion_json: string | null;
  sequence_index: number;
  status: WorkflowRunStepStatus;
  notes: string | null;
  evidence_json: string | null;
  completed_at: string | null;
  summary: string | null;
};

/** Lifecycle states for one dispatched unit (migration 004). */
export type WorkflowRunUnitStatus = "pending" | "running" | "completed" | "failed" | "skipped";

/** Row shape of `workflow_run_units` — per-unit state under the gated step spine. */
export type WorkflowRunUnitRow = {
  run_id: string;
  unit_id: string;
  step_id: string | null;
  node_id: string;
  parent_unit_id: string | null;
  phase: string | null;
  runner: string | null;
  model: string | null;
  status: WorkflowRunUnitStatus;
  input_hash: string | null;
  result_json: string | null;
  tokens: number | null;
  failure_reason: string | null;
  /** Harness-native session id revealed by the unit's result extractor (migration 005, plan P2). */
  session_id: string | null;
  worktree_path: string | null;
  started_at: string | null;
  finished_at: string | null;
  /**
   * Most recent unit-level check-in heartbeat (migration 007, R3 driver
   * protocol): a driver claiming/heartbeating a `running` unit via
   * `akm workflow report --status running` stamps this. Distinct from
   * `started_at` (the first claim); the stale-unit evaluator
   * (`runtime/unit-checkin.ts`) reads it. NULL on engine-dispatched rows and
   * on never-heartbeated units.
   */
  last_checkin_at: string | null;
  /**
   * Dispatch-attempt counter (migration 008). Starts at 1 on the first insert
   * and is incremented by {@link WorkflowRunsRepository.insertUnit} every time
   * it REPLACES an existing row for the same (run_id, unit_id) — i.e. a
   * crash/resume re-dispatch of a content-derived unit whose prior attempt
   * never reached a terminal status. Budget/lifetime accounting sums this
   * column (not the row count) so a re-dispatched unit is charged for every
   * attempt. Gate-evaluation rows (`phase = "gate"`) carry it too but are
   * excluded from budget seeding, so their value is inert.
   */
  attempts: number;
};

/** Input row for {@link WorkflowRunsRepository.insertUnit}. Inserted as `running`. */
export interface InsertUnitInput {
  runId: string;
  unitId: string;
  stepId: string | null;
  nodeId: string;
  parentUnitId: string | null;
  phase: string | null;
  runner: string | null;
  model: string | null;
  inputHash: string | null;
  /**
   * Isolation worktree path for `isolation: worktree` units (migration 004
   * column, R2 enforcement): journaled at dispatch so a dirty-retained
   * worktree can always be located from the unit row. Omitted ⇒ NULL.
   */
  worktreePath?: string | null;
  startedAt: string;
}

/** Input for {@link WorkflowRunsRepository.finishUnit}. */
export interface FinishUnitInput {
  runId: string;
  unitId: string;
  status: Exclude<WorkflowRunUnitStatus, "pending" | "running">;
  resultJson: string | null;
  tokens: number | null;
  failureReason: string | null;
  /**
   * Harness-native session id revealed by the unit's dispatch (result
   * extractor / SDK), stored opportunistically for resume (plan §"Session,
   * MCP, and identity across harnesses"). Optional and additive: omitted ⇒
   * NULL.
   */
  sessionId?: string | null;
  finishedAt: string;
}

/** Input row for {@link WorkflowRunsRepository.insertRun}. */
export interface InsertRunInput {
  id: string;
  workflowRef: string;
  scopeKey: string | null;
  workflowEntryId: number | null;
  workflowTitle: string;
  paramsJson: string;
  currentStepId: string | null;
  createdAt: string;
  updatedAt: string;
  agentHarness: string | null;
  agentSessionId: string | null;
  checkinArmedAt: string | null;
}

/** Input row for {@link WorkflowRunsRepository.insertStep}. */
export interface InsertStepInput {
  runId: string;
  stepId: string;
  stepTitle: string;
  instructions: string;
  completionJson: string | null;
  sequenceIndex: number;
}

/** Filter object for {@link WorkflowRunsRepository.listRuns}. */
export interface ListRunsFilter {
  scopeKey: string;
  workflowRef?: string;
  activeOnly?: boolean;
}

/**
 * Repository owning every raw SQL statement against `workflow_runs` and
 * `workflow_run_steps`. It is DB-location-agnostic: the lifecycle helper
 * {@link withWorkflowRunsRepo} binds it to {@link StorageLocations.workflowDb}
 * so a future storage move (#489) changes only `locations.ts`.
 *
 * ## Connection-lifetime contract (WS5)
 *
 * Every read method fully materialises its result set (`.all()` / `.get()` into
 * plain values/arrays) before returning. The repository NEVER hands a live
 * statement iterator or cursor back across the {@link withWorkflowRunsRepo}
 * scope boundary, so the connection can be closed immediately after `fn`
 * resolves without truncating lazy iteration.
 */
export class WorkflowRunsRepository {
  constructor(private readonly db: Database) {}

  /** Escape hatch for the transaction-bounded write paths still orchestrated
   * in runs.ts. The repository owns the SQL; the caller owns the transaction
   * boundary (unchanged from the pre-extraction `db.transaction(() => …)`). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ── reads (fully materialised) ─────────────────────────────────────────────

  findActiveRunForScope(
    workflowRef: string,
    scopeKey: string | null,
  ): { id: string; current_step_id: string | null } | undefined {
    return this.db
      .prepare(
        "SELECT id, current_step_id FROM workflow_runs WHERE workflow_ref = ? AND scope_key = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1",
      )
      .get(workflowRef, scopeKey) as { id: string; current_step_id: string | null } | undefined;
  }

  getRunById(runId: string): WorkflowRunRow | undefined {
    return this.db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(runId) as WorkflowRunRow | undefined;
  }

  getActiveRunRowForScope(workflowRef: string, scopeKey: string | null): WorkflowRunRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM workflow_runs WHERE workflow_ref = ? AND scope_key = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1",
      )
      .get(workflowRef, scopeKey) as WorkflowRunRow | undefined;
  }

  hasRun(runId: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM workflow_runs WHERE id = ? LIMIT 1").get(runId) as
      | { 1: number }
      | undefined;
    return !!row;
  }

  listRuns(filter: ListRunsFilter): WorkflowRunRow[] {
    const filters: string[] = [];
    const params: string[] = [];
    filters.push("scope_key = ?");
    params.push(filter.scopeKey);
    if (filter.workflowRef) {
      filters.push("workflow_ref = ?");
      params.push(filter.workflowRef);
    }
    if (filter.activeOnly) {
      filters.push("status IN ('active', 'blocked')");
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT * FROM workflow_runs ${where} ORDER BY updated_at DESC, created_at DESC`)
      .all(...params) as WorkflowRunRow[];
  }

  getStepsForRun(runId: string): WorkflowRunStepRow[] {
    return this.db
      .prepare("SELECT * FROM workflow_run_steps WHERE run_id = ? ORDER BY sequence_index ASC")
      .all(runId) as WorkflowRunStepRow[];
  }

  getStep(runId: string, stepId: string): WorkflowRunStepRow | undefined {
    return this.db.prepare("SELECT * FROM workflow_run_steps WHERE run_id = ? AND step_id = ?").get(runId, stepId) as
      | WorkflowRunStepRow
      | undefined;
  }

  findActiveOrBlockedRunForScope(
    scopeKey: string,
  ): { id: string; current_step_id: string | null; workflow_ref: string } | null {
    return (
      this.db
        .prepare<{ id: string; current_step_id: string | null; workflow_ref: string }>(
          "SELECT id, current_step_id, workflow_ref FROM workflow_runs WHERE scope_key = ? AND status IN ('active', 'blocked') ORDER BY updated_at DESC LIMIT 1",
        )
        .get(scopeKey) ?? null
    );
  }

  // ── writes ─────────────────────────────────────────────────────────────────

  insertRun(input: InsertRunInput): void {
    this.db
      .prepare(
        `INSERT INTO workflow_runs (
          id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status, params_json, current_step_id, created_at, updated_at,
          agent_harness, agent_session_id, checkin_armed_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.workflowRef,
        input.scopeKey,
        input.workflowEntryId,
        input.workflowTitle,
        input.paramsJson,
        input.currentStepId,
        input.createdAt,
        input.updatedAt,
        input.agentHarness,
        input.agentSessionId,
        input.checkinArmedAt,
      );
  }

  insertSteps(steps: InsertStepInput[]): void {
    const insertStep = this.db.prepare(
      `INSERT INTO workflow_run_steps (
          run_id, step_id, step_title, instructions, completion_json, sequence_index, status
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    );
    for (const step of steps) {
      insertStep.run(
        step.runId,
        step.stepId,
        step.stepTitle,
        step.instructions,
        step.completionJson,
        step.sequenceIndex,
      );
    }
  }

  reopenStepsForResume(runId: string, currentStepId: string): void {
    this.db
      .prepare(
        `UPDATE workflow_run_steps
             SET status = 'pending', notes = NULL, evidence_json = NULL, completed_at = NULL
             WHERE run_id = ? AND step_id = ? AND status IN ('blocked', 'failed')`,
      )
      .run(runId, currentStepId);
  }

  markRunActive(runId: string, updatedAt: string): void {
    this.db.prepare("UPDATE workflow_runs SET status = 'active', updated_at = ? WHERE id = ?").run(updatedAt, runId);
  }

  updateStepCompletion(input: {
    status: WorkflowRunStepStatus;
    notes: string | null;
    evidenceJson: string | null;
    summary: string | null;
    completedAt: string;
    runId: string;
    stepId: string;
  }): void {
    this.db
      .prepare(
        `UPDATE workflow_run_steps
           SET status = ?, notes = ?, evidence_json = ?, summary = ?, completed_at = ?
           WHERE run_id = ? AND step_id = ?`,
      )
      .run(input.status, input.notes, input.evidenceJson, input.summary, input.completedAt, input.runId, input.stepId);
  }

  updateRunState(input: {
    status: WorkflowRunStatus;
    currentStepId: string | null;
    updatedAt: string;
    completedAt: string | null;
    checkinArmedAt: string;
    runId: string;
  }): void {
    this.db
      .prepare(
        `UPDATE workflow_runs
           SET status = ?, current_step_id = ?, updated_at = ?, completed_at = ?, checkin_armed_at = ?
           WHERE id = ?`,
      )
      .run(input.status, input.currentStepId, input.updatedAt, input.completedAt, input.checkinArmedAt, input.runId);
  }

  rearmCheckin(runId: string, checkinArmedAt: string): void {
    this.db.prepare("UPDATE workflow_runs SET checkin_armed_at = ? WHERE id = ?").run(checkinArmedAt, runId);
  }

  /**
   * Freeze the compiled plan on the run row (migration 006, redesign addendum
   * R1): `planJson` is the CANONICAL plan JSON (`ir/plan-hash.ts`), `planHash`
   * its sha256. Called by `startWorkflowRun` inside the same transaction as
   * `insertRun`, so a run row never exists without its frozen plan. Read back
   * via {@link getRunById} (`plan_json` / `plan_hash` on the row).
   */
  setRunPlan(runId: string, planJson: string, planHash: string): void {
    this.db
      .prepare("UPDATE workflow_runs SET plan_json = ?, plan_hash = ? WHERE id = ?")
      .run(planJson, planHash, runId);
  }

  // ── engine run lease (migration 006 columns, R2 enforcement) ──────────────
  //
  // Single-driver invariant: at most one `akm workflow run` invocation drives
  // a run at a time. The lease is (holder id, expiry); all timestamps are
  // ISO-8601 UTC strings, which compare correctly with SQL `<` (lexicographic
  // order matches chronological order for a fixed-format UTC ISO string).

  /**
   * Atomically claim the run lease: succeeds when the run is unleased OR the
   * existing lease has expired (`engine_lease_until < now` — crash recovery).
   * A live lease held by anyone (including a stale copy of the same holder)
   * is NOT reclaimable through this method; the single UPDATE is the whole
   * claim, so two racing invocations cannot both win.
   */
  acquireEngineLease(runId: string, holder: string, until: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE workflow_runs
           SET engine_lease_holder = ?, engine_lease_until = ?
           WHERE id = ? AND (engine_lease_holder IS NULL OR engine_lease_until IS NULL OR engine_lease_until < ?)`,
      )
      .run(holder, until, runId, now);
    return Number(result.changes) > 0;
  }

  /**
   * Extend the lease expiry — only while `holder` still owns it. Returns
   * false when the lease was lost (expired and claimed by another engine),
   * so the caller can stop driving instead of racing the new owner.
   */
  renewEngineLease(runId: string, holder: string, until: string): boolean {
    const result = this.db
      .prepare("UPDATE workflow_runs SET engine_lease_until = ? WHERE id = ? AND engine_lease_holder = ?")
      .run(until, runId, holder);
    return Number(result.changes) > 0;
  }

  /**
   * Clear the lease — only while `holder` still owns it, so a crashed-then-
   * recovered invocation can never release a lease another engine has since
   * claimed. Releasing an already-lost lease is a harmless no-op.
   */
  releaseEngineLease(runId: string, holder: string): void {
    this.db
      .prepare(
        "UPDATE workflow_runs SET engine_lease_holder = NULL, engine_lease_until = NULL WHERE id = ? AND engine_lease_holder = ?",
      )
      .run(runId, holder);
  }

  // ── unit rows (migration 004) ──────────────────────────────────────────────
  //
  // Writes to `workflow_run_units` should go through the serialized writer
  // queue (`src/workflows/exec/unit-writer.ts`) when N units may complete
  // concurrently — SQLite has a single writer and `withWorkflowRunsRepo`
  // opens a fresh connection per call.

  getUnitsForRun(runId: string): WorkflowRunUnitRow[] {
    return this.db
      .prepare("SELECT * FROM workflow_run_units WHERE run_id = ? ORDER BY started_at ASC, unit_id ASC")
      .all(runId) as WorkflowRunUnitRow[];
  }

  getUnitsForStep(runId: string, stepId: string): WorkflowRunUnitRow[] {
    return this.db
      .prepare("SELECT * FROM workflow_run_units WHERE run_id = ? AND step_id = ? ORDER BY started_at ASC, unit_id ASC")
      .all(runId, stepId) as WorkflowRunUnitRow[];
  }

  /** One unit row by primary key, or undefined. Used by the R3 report path's
   * guarded read-then-write (idempotency / replay-divergence / claim checks). */
  getUnit(runId: string, unitId: string): WorkflowRunUnitRow | undefined {
    return this.db.prepare("SELECT * FROM workflow_run_units WHERE run_id = ? AND unit_id = ?").get(runId, unitId) as
      | WorkflowRunUnitRow
      | undefined;
  }

  /**
   * Stamp a unit-level check-in heartbeat (migration 007, R3 driver protocol):
   * a driver executing a unit calls `report --status running` to claim (first
   * call) or heartbeat (subsequent) it. Sets `status = 'running'` and
   * `last_checkin_at`; NEVER touches `started_at` (the first-claim marker set by
   * {@link insertUnit}) so the heartbeat window advances without resetting the
   * claim time. The caller guards against re-claiming a terminal unit inside its
   * transaction.
   */
  updateUnitCheckin(runId: string, unitId: string, lastCheckinAt: string): void {
    this.db
      .prepare("UPDATE workflow_run_units SET status = 'running', last_checkin_at = ? WHERE run_id = ? AND unit_id = ?")
      .run(lastCheckinAt, runId, unitId);
  }

  /**
   * Insert a unit row in `running` state (a dispatch is starting now).
   *
   * Upsert on the (run_id, unit_id) primary key: durable-row resume
   * re-dispatches units whose previous attempt never reached a terminal status
   * (a crash mid-step leaves `running` rows). The fresh dispatch REPLACES the
   * stale row — value columns (`result_json`/`tokens`/`failure_reason`/
   * `session_id`/`finished_at`/`last_checkin_at`) are reset exactly as the old
   * `INSERT OR REPLACE` reset them, and the dispatch metadata is overwritten —
   * but `attempts` is INCREMENTED rather than reset (migration 008). A first
   * insert lands `attempts = 1` (column default); each re-dispatch bumps it, so
   * budget/lifetime seeds that sum `attempts` charge every crash-retried
   * dispatch instead of collapsing them into one row. Using `ON CONFLICT DO
   * UPDATE` (not `INSERT OR REPLACE`, which deletes+reinserts) is what lets the
   * increment read the prior row's counter.
   */
  insertUnit(input: InsertUnitInput): void {
    this.db
      .prepare(
        `INSERT INTO workflow_run_units (
          run_id, unit_id, step_id, node_id, parent_unit_id, phase, runner, model,
          status, input_hash, worktree_path, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)
        ON CONFLICT(run_id, unit_id) DO UPDATE SET
          step_id         = excluded.step_id,
          node_id         = excluded.node_id,
          parent_unit_id  = excluded.parent_unit_id,
          phase           = excluded.phase,
          runner          = excluded.runner,
          model           = excluded.model,
          status          = excluded.status,
          input_hash      = excluded.input_hash,
          worktree_path   = excluded.worktree_path,
          started_at      = excluded.started_at,
          result_json     = NULL,
          tokens          = NULL,
          failure_reason  = NULL,
          session_id      = NULL,
          finished_at     = NULL,
          last_checkin_at = NULL,
          attempts        = workflow_run_units.attempts + 1`,
      )
      .run(
        input.runId,
        input.unitId,
        input.stepId,
        input.nodeId,
        input.parentUnitId,
        input.phase,
        input.runner,
        input.model,
        input.inputHash,
        input.worktreePath ?? null,
        input.startedAt,
      );
  }

  /**
   * Record a unit's terminal state (completed / failed / skipped).
   *
   * ## Loud contract (must update exactly one row)
   *
   * A finish ALWAYS targets a row a prior dispatch/claim inserted: every caller
   * ({@link insertUnit} in the executor and the report path,
   * {@link journalGateEvaluationStart} for gate rows) writes the `running` row
   * before finishing it, inside the same writer-queue task or SQLite
   * transaction. If the UPDATE matches NO `(run_id, unit_id)` row the journal is
   * inconsistent — a finish against a missing or mismatched unit id — and the
   * unit's terminal state would silently vanish (the row stays `running`, or no
   * row exists at all). That is a journaling BUG, so we throw loudly at the
   * source instead of no-oping: a stuck-`running` unit would wedge resume
   * (durable-row reuse never matches it) or corrupt budget/gate accounting.
   */
  finishUnit(input: FinishUnitInput): void {
    const result = this.db
      .prepare(
        `UPDATE workflow_run_units
           SET status = ?, result_json = ?, tokens = ?, failure_reason = ?, session_id = ?, finished_at = ?
           WHERE run_id = ? AND unit_id = ?`,
      )
      .run(
        input.status,
        input.resultJson,
        input.tokens,
        input.failureReason,
        input.sessionId ?? null,
        input.finishedAt,
        input.runId,
        input.unitId,
      );
    if (Number(result.changes) === 0) {
      throw new Error(
        `finishUnit updated no row: no unit "${input.unitId}" exists for run "${input.runId}". ` +
          `A unit must be inserted (dispatched or claimed) before it can be finished — a finish that ` +
          `matches no row indicates a journaling bug (mismatched unit id or a lost dispatch row), not a ` +
          `recoverable state.`,
      );
    }
  }
}

/**
 * Open the workflow database (bound to {@link StorageLocations.workflowDb}),
 * run `fn` against a {@link WorkflowRunsRepository}, and close the connection
 * exactly once when `fn` settles.
 *
 * Generalises the former `withWorkflowDb` loan pattern in runs.ts. Repository
 * read methods fully materialise their results, so closing here never truncates
 * lazy iteration (WS5 connection-lifetime rule).
 */
export async function withWorkflowRunsRepo<T>(fn: (repo: WorkflowRunsRepository) => T | Promise<T>): Promise<T> {
  const db = openWorkflowDatabase(resolveStorageLocations().workflowDb);
  try {
    return await Promise.resolve(fn(new WorkflowRunsRepository(db)));
  } finally {
    closeWorkflowDatabase(db);
  }
}
