// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Database } from "bun:sqlite";
import type { WorkflowRunStatus, WorkflowRunStepStatus } from "../../sources/types";
import { closeWorkflowDatabase, openWorkflowDatabase } from "../../workflows/db";
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
    return this.db
      .query<{ id: string; current_step_id: string | null; workflow_ref: string }, [string]>(
        "SELECT id, current_step_id, workflow_ref FROM workflow_runs WHERE scope_key = ? AND status IN ('active', 'blocked') ORDER BY updated_at DESC LIMIT 1",
      )
      .get(scopeKey);
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
