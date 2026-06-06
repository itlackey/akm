// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { parseAssetRef } from "../core/asset-ref";
import { loadConfig } from "../core/config";
import { NotFoundError, UsageError } from "../core/errors";
import { appendEvent } from "../core/events";
import { getDbPath } from "../core/paths";
import { closeDatabase, openExistingDatabase } from "../indexer/db";
import { resolveSourceEntries } from "../indexer/search-source";
import { resolveSourcesForOrigin } from "../registry/origin-resolve";
import { resolveAssetPath } from "../sources/resolve";
import type {
  WorkflowParameter,
  WorkflowRunStatus,
  WorkflowRunStepState,
  WorkflowRunStepStatus,
  WorkflowRunSummary,
  WorkflowStepDefinition,
} from "../sources/types";
import { resolveAgentIdentity } from "./agent-identity";
import { formatWorkflowErrors } from "./authoring";
import { type CheckinDirective, evaluateCheckin } from "./checkin";
import { closeWorkflowDatabase, openWorkflowDatabase } from "./db";
import { parseWorkflow } from "./parser";
import type { WorkflowDocument } from "./schema";
import { getCurrentWorkflowScopeKey } from "./scope-key";
import { type SummaryJudge, validateStepSummary } from "./validate-summary";

async function withWorkflowDb<T>(fn: (db: Database) => T | Promise<T>): Promise<T> {
  const db = openWorkflowDatabase();
  try {
    return await Promise.resolve(fn(db));
  } finally {
    closeWorkflowDatabase(db);
  }
}

type WorkflowAsset = {
  ref: string;
  path: string;
  sourcePath: string;
  title: string;
  parameters?: WorkflowParameter[];
  steps: WorkflowStepDefinition[];
};

type WorkflowRunRow = {
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

type WorkflowRunStepRow = {
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

export interface WorkflowRunDetail {
  run: WorkflowRunSummary;
  workflow: {
    ref: string;
    title: string;
    steps: WorkflowRunStepState[];
  };
}

export interface WorkflowNextResult {
  run: WorkflowRunSummary;
  workflow: {
    ref: string;
    title: string;
    steps: WorkflowRunStepState[];
  };
  step: WorkflowRunStepState | null;
  done?: true;
  autoStarted?: true;
  /** Present when the run looks stalled — a strong `continue` directive (#506). */
  checkin?: CheckinDirective;
}

export interface CompleteWorkflowStepInput {
  runId: string;
  stepId: string;
  status: Exclude<WorkflowRunStepStatus, "pending">;
  notes?: string;
  evidence?: Record<string, unknown>;
  /**
   * Required when completing a step (`status === "completed"`): a summary of the
   * work done. Persisted on the step row and, for the final step, doubles as the
   * workflow summary. Validated against the step's completionCriteria (#506).
   */
  summary?: string;
  /**
   * Optional override for the summary-validation judge. When omitted the engine
   * builds one from the configured LLM (and skips validation when none is set).
   * Injected primarily for tests.
   */
  summaryJudge?: SummaryJudge | null;
}

/**
 * Structured corrective feedback returned when a completed step's summary fails
 * the completionCriteria validation gate. The step is left pending.
 */
export interface SummaryValidationFailure {
  ok: false;
  runId: string;
  stepId: string;
  missing: string[];
  feedback: string;
}

export async function startWorkflowRun(
  ref: string,
  params: Record<string, unknown> = {},
  options?: { force?: boolean; agentHarness?: string | null; agentSessionId?: string | null },
): Promise<WorkflowRunDetail> {
  const asset = await loadWorkflowAsset(ref);
  return withWorkflowDb(async (db) => {
    const now = new Date().toISOString();
    const runId = randomUUID();
    const scopeKey = getCurrentWorkflowScopeKey();
    const currentStepId = asset.steps[0]?.id ?? null;
    const workflowEntryId = resolveWorkflowEntryId(asset.sourcePath, asset.ref);

    // Capture the agent harness + session driving this run. Explicit options
    // win; otherwise fall back to best-effort environment detection. This is
    // identity-only — no background thread or timer is started here.
    const detected = resolveAgentIdentity();
    const agentHarness = options?.agentHarness !== undefined ? options.agentHarness : detected.harness;
    const agentSessionId = options?.agentSessionId !== undefined ? options.agentSessionId : detected.sessionId;

    // Concurrency guard (#485): if an active run already exists in this
    // (workflow_ref, scope_key) pair, refuse to create a parallel run unless
    // `force: true` is set. Previously every call inserted unconditionally,
    // so two terminals running `akm workflow start <ref>` left two runs
    // racing; `akm workflow next` then non-deterministically picked one.
    if (!options?.force) {
      const existing = db
        .prepare(
          "SELECT id, current_step_id FROM workflow_runs WHERE workflow_ref = ? AND scope_key = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1",
        )
        .get(asset.ref, scopeKey) as { id: string; current_step_id: string | null } | undefined;
      if (existing) {
        throw new UsageError(
          `Workflow ${asset.ref} already has an active run in this scope (id=${existing.id}, step=${existing.current_step_id ?? "—"}). ` +
            `Use 'akm workflow next ${asset.ref}' to resume it, 'akm workflow abandon ${existing.id}' to give up on it, or pass --force to start a parallel run.`,
          "RESOURCE_ALREADY_EXISTS",
        );
      }
    }

    // #506: arm a file-signal check-in (a timestamp, NOT a background thread —
    // see docs/technical/workflow-agent-checkin-adr.md) so a stalled run can be
    // re-targeted with a `continue` directive. The agent harness + session id
    // are already resolved above (agentHarness/agentSessionId, from #501).

    db.transaction(() => {
      db.prepare(
        `INSERT INTO workflow_runs (
          id, workflow_ref, scope_key, workflow_entry_id, workflow_title, status, params_json, current_step_id, created_at, updated_at,
          agent_harness, agent_session_id, checkin_armed_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        runId,
        asset.ref,
        scopeKey,
        workflowEntryId,
        asset.title,
        JSON.stringify(params),
        currentStepId,
        now,
        now,
        agentHarness,
        agentSessionId,
        now,
      );

      const insertStep = db.prepare(
        `INSERT INTO workflow_run_steps (
          run_id, step_id, step_title, instructions, completion_json, sequence_index, status
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      );
      for (const step of asset.steps) {
        insertStep.run(
          runId,
          step.id,
          step.title,
          step.instructions,
          step.completionCriteria ? JSON.stringify(step.completionCriteria) : null,
          step.sequenceIndex ?? 0,
        );
      }
    })();

    const result = await getWorkflowStatus(runId);
    appendEvent({
      eventType: "workflow_started",
      ref: ref,
      metadata: { runId: result.run.id, title: result.run.workflowTitle },
    });
    return result;
  });
}

export async function getWorkflowStatus(runId: string): Promise<WorkflowRunDetail> {
  return withWorkflowDb((db) => {
    const run = readWorkflowRun(db, runId);
    const steps = readWorkflowRunSteps(db, run.id);
    return buildWorkflowRunDetail(run, steps);
  });
}

export async function hasWorkflowRun(runId: string): Promise<boolean> {
  return withWorkflowDb((db) => {
    const row = db.prepare("SELECT 1 FROM workflow_runs WHERE id = ? LIMIT 1").get(runId) as { 1: number } | undefined;
    return !!row;
  });
}

export async function listWorkflowRuns(input?: { workflowRef?: string; activeOnly?: boolean }): Promise<{
  runs: WorkflowRunSummary[];
}> {
  return withWorkflowDb((db) => {
    const filters: string[] = [];
    const params: string[] = [];
    const scopeKey = getCurrentWorkflowScopeKey();
    filters.push("scope_key = ?");
    params.push(scopeKey);
    if (input?.workflowRef) {
      const parsed = parseAssetRef(input.workflowRef);
      if (parsed.type !== "workflow") {
        throw new UsageError(`Expected a workflow ref (workflow:<name>), got "${input.workflowRef}".`);
      }
      filters.push("workflow_ref = ?");
      params.push(`${parsed.origin ? `${parsed.origin}//` : ""}workflow:${parsed.name}`);
    }
    if (input?.activeOnly) {
      filters.push("status IN ('active', 'blocked')");
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = db
      .prepare(`SELECT * FROM workflow_runs ${where} ORDER BY updated_at DESC, created_at DESC`)
      .all(...params) as WorkflowRunRow[];
    return { runs: rows.map(toWorkflowRunSummary) };
  });
}

export async function getNextWorkflowStep(
  specifier: string,
  params?: Record<string, unknown>,
): Promise<WorkflowNextResult> {
  return withWorkflowDb(async (db) => {
    const { run, autoStarted } = await resolveRunSpecifier(db, specifier, params);
    const steps = readWorkflowRunSteps(db, run.id);
    const currentStep = resolveCurrentStep(run, steps);
    const done = run.status === "completed" ? (true as const) : undefined;
    // #506: surface a check-in directive through the normal command output when
    // the run looks stalled. Pure timestamp evaluation — no background thread.
    const checkin =
      evaluateCheckin({
        status: run.status,
        updatedAt: run.updated_at,
        checkinArmedAt: run.checkin_armed_at,
        agentHarness: run.agent_harness,
        agentSessionId: run.agent_session_id,
      }) ?? undefined;
    return {
      run: toWorkflowRunSummary(run),
      workflow: {
        ref: run.workflow_ref,
        title: run.workflow_title,
        steps: steps.map(toWorkflowRunStepState),
      },
      step: currentStep ? toWorkflowRunStepState(currentStep) : null,
      ...(done ? { done } : {}),
      ...(autoStarted ? { autoStarted } : {}),
      ...(checkin ? { checkin } : {}),
    };
  });
}

export async function resumeWorkflowRun(runId: string): Promise<WorkflowRunDetail> {
  return withWorkflowDb((db) => {
    const run = readWorkflowRun(db, runId);
    if (run.status === "completed") {
      throw new UsageError(`Workflow run ${run.id} is already completed and cannot be resumed.`);
    }
    if (run.status === "active") {
      const steps = readWorkflowRunSteps(db, run.id);
      return buildWorkflowRunDetail(run, steps);
    }
    // blocked or failed → flip back to active and re-open the current step so
    // it can be reclassified (completed, failed, skipped) after resuming.
    const now = new Date().toISOString();
    db.transaction(() => {
      if (run.current_step_id) {
        db.prepare(
          `UPDATE workflow_run_steps
             SET status = 'pending', notes = NULL, evidence_json = NULL, completed_at = NULL
             WHERE run_id = ? AND step_id = ? AND status IN ('blocked', 'failed')`,
        ).run(run.id, run.current_step_id);
      }
      db.prepare("UPDATE workflow_runs SET status = 'active', updated_at = ? WHERE id = ?").run(now, run.id);
    })();
    const updated: WorkflowRunRow = { ...run, status: "active", updated_at: now };
    const steps = readWorkflowRunSteps(db, run.id);
    return buildWorkflowRunDetail(updated, steps);
  });
}

export async function completeWorkflowStep(
  input: CompleteWorkflowStepInput,
): Promise<WorkflowRunDetail | SummaryValidationFailure> {
  // Read the step (read-only) up front so the LLM validation gate runs OUTSIDE
  // the write transaction — a slow/hung LLM must never hold a db write lock.
  const preflight = await withWorkflowDb((db) => {
    const run = readWorkflowRun(db, input.runId);
    if (run.status !== "active") {
      throw new UsageError(`Workflow run ${run.id} is ${run.status} and cannot be updated.`);
    }
    const existing = db
      .prepare("SELECT * FROM workflow_run_steps WHERE run_id = ? AND step_id = ?")
      .get(run.id, input.stepId) as WorkflowRunStepRow | undefined;
    if (!existing) {
      throw new NotFoundError(`Step "${input.stepId}" was not found in workflow run ${run.id}.`);
    }
    if (existing.status !== "pending") {
      throw new UsageError(`Step "${input.stepId}" is already ${existing.status} in workflow run ${run.id}.`);
    }
    if (run.current_step_id !== existing.step_id) {
      throw new UsageError(
        `Step "${input.stepId}" is not the current step for workflow run ${run.id}. Complete "${run.current_step_id}" first.`,
      );
    }
    return { existing };
  });

  const summary = input.summary?.trim();

  // #506: completing a step requires a summary of the work done.
  if (input.status === "completed" && !summary) {
    throw new UsageError(
      `Completing step "${input.stepId}" requires a --summary describing the work done.`,
      "MISSING_REQUIRED_ARGUMENT",
    );
  }

  // #506: validation gate — judge the summary against the step's
  // completionCriteria via the configured LLM. Fail-open when no criteria or no
  // judge. Only a well-formed `complete: false` blocks completion.
  if (input.status === "completed" && summary) {
    const criteria = parseJsonArray(preflight.existing.completion_json) ?? [];
    const judge = input.summaryJudge === undefined ? buildDefaultSummaryJudge() : input.summaryJudge;
    const verdict = await validateStepSummary(
      { stepTitle: preflight.existing.step_title, completionCriteria: criteria, summary },
      judge ?? undefined,
    );
    if (!verdict.complete) {
      // Re-arm the check-in so a subsequent stall is still nudged, but leave the
      // step pending and return corrective feedback instead of completing.
      await withWorkflowDb((db) => {
        db.prepare("UPDATE workflow_runs SET checkin_armed_at = ? WHERE id = ?").run(
          new Date().toISOString(),
          input.runId,
        );
      });
      return {
        ok: false,
        runId: input.runId,
        stepId: input.stepId,
        missing: verdict.missing,
        feedback: verdict.feedback ?? "The summary does not satisfy the step's completion criteria.",
      };
    }
  }

  return withWorkflowDb((db) => {
    let updatedRun: WorkflowRunRow | undefined;
    let refreshedSteps: WorkflowRunStepRow[] = [];

    db.transaction(() => {
      const run = readWorkflowRun(db, input.runId);
      if (run.status !== "active") {
        throw new UsageError(`Workflow run ${run.id} is ${run.status} and cannot be updated.`);
      }
      const existing = db
        .prepare("SELECT * FROM workflow_run_steps WHERE run_id = ? AND step_id = ?")
        .get(run.id, input.stepId) as WorkflowRunStepRow | undefined;
      if (!existing) {
        throw new NotFoundError(`Step "${input.stepId}" was not found in workflow run ${run.id}.`);
      }
      if (existing.status !== "pending") {
        throw new UsageError(`Step "${input.stepId}" is already ${existing.status} in workflow run ${run.id}.`);
      }
      if (run.current_step_id !== existing.step_id) {
        throw new UsageError(
          `Step "${input.stepId}" is not the current step for workflow run ${run.id}. Complete "${run.current_step_id}" first.`,
        );
      }

      const completedAt = new Date().toISOString();
      db.prepare(
        `UPDATE workflow_run_steps
           SET status = ?, notes = ?, evidence_json = ?, summary = ?, completed_at = ?
           WHERE run_id = ? AND step_id = ?`,
      ).run(
        input.status,
        input.notes?.trim() || null,
        input.evidence ? JSON.stringify(input.evidence) : null,
        summary || null,
        completedAt,
        run.id,
        input.stepId,
      );

      refreshedSteps = readWorkflowRunSteps(db, run.id);
      const state = deriveRunState(refreshedSteps);
      // Re-arm the check-in on every state change: a healthy, progressing run
      // keeps pushing the stall window forward so the directive never fires.
      db.prepare(
        `UPDATE workflow_runs
           SET status = ?, current_step_id = ?, updated_at = ?, completed_at = ?, checkin_armed_at = ?
           WHERE id = ?`,
      ).run(state.status, state.currentStepId, completedAt, state.completedAt, completedAt, run.id);

      updatedRun = {
        ...run,
        status: state.status,
        current_step_id: state.currentStepId,
        updated_at: completedAt,
        completed_at: state.completedAt,
        checkin_armed_at: completedAt,
      };
    })();

    const detail = buildWorkflowRunDetail(updatedRun as WorkflowRunRow, refreshedSteps);
    appendEvent({
      eventType: "workflow_step_completed",
      ref: detail.run.workflowRef,
      metadata: { runId: input.runId, stepId: input.stepId, notes: input.notes },
    });
    if (detail.run.status === "completed") {
      appendEvent({ eventType: "workflow_finished", ref: detail.run.workflowRef, metadata: { runId: input.runId } });
    }
    return detail;
  });
}

async function resolveRunSpecifier(
  db: import("bun:sqlite").Database,
  specifier: string,
  params?: Record<string, unknown>,
): Promise<{ run: WorkflowRunRow; autoStarted: boolean }> {
  const explicitRun = db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(specifier) as
    | WorkflowRunRow
    | undefined;
  if (explicitRun) {
    if (params && Object.keys(params).length > 0) {
      throw new UsageError(
        `--params can only be used when starting a new run from a workflow ref, not with an existing run id ("${specifier}")`,
      );
    }
    return { run: explicitRun, autoStarted: false };
  }

  if (!specifier.includes(":")) {
    throw new NotFoundError(`Workflow run "${specifier}" not found.`, "WORKFLOW_NOT_FOUND");
  }

  const parsed = parseAssetRef(specifier);
  if (parsed.type !== "workflow") {
    throw new UsageError(`Expected a workflow ref or workflow run id, got "${specifier}".`);
  }
  const ref = `${parsed.origin ? `${parsed.origin}//` : ""}workflow:${parsed.name}`;
  const scopeKey = getCurrentWorkflowScopeKey();
  const active = db
    .prepare(
      "SELECT * FROM workflow_runs WHERE workflow_ref = ? AND scope_key = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1",
    )
    .get(ref, scopeKey) as WorkflowRunRow | undefined;
  if (active) {
    if (params && Object.keys(params).length > 0) {
      throw new UsageError(`--params can only be set on a new run; ${ref} already has an active run`);
    }
    return { run: active, autoStarted: false };
  }

  const started = await startWorkflowRun(ref, params ?? {});
  return { run: readWorkflowRun(db, started.run.id), autoStarted: true };
}

async function loadWorkflowAsset(ref: string): Promise<WorkflowAsset> {
  const parsed = parseAssetRef(ref);
  if (parsed.type !== "workflow") {
    throw new UsageError(`Expected a workflow ref (workflow:<name>), got "${ref}".`);
  }

  const config = loadConfig();
  const allSources = resolveSourceEntries(undefined, config);
  const searchSources = resolveSourcesForOrigin(parsed.origin, allSources);
  let assetPath: string | undefined;
  let sourcePath: string | undefined;

  for (const source of searchSources) {
    try {
      assetPath = await resolveAssetPath(source.path, "workflow", parsed.name);
      sourcePath = source.path;
      break;
    } catch {
      /* continue */
    }
  }

  if (!assetPath) {
    throw new NotFoundError(`Workflow not found for ref: workflow:${parsed.name}`);
  }

  const resolvedSourcePath = sourcePath ?? config.stashDir ?? assetPath;
  const fullRef = `${parsed.origin ? `${parsed.origin}//` : ""}workflow:${parsed.name}`;

  const cached = readWorkflowDocumentFromIndex(resolvedSourcePath, fullRef);
  const document = cached ?? loadWorkflowDocumentFromDisk(assetPath);
  return projectAsset(document, fullRef, assetPath, resolvedSourcePath);
}

function loadWorkflowDocumentFromDisk(assetPath: string): WorkflowDocument {
  const content = fs.readFileSync(assetPath, "utf8");
  const result = parseWorkflow(content, { path: assetPath });
  if (!result.ok) {
    throw new UsageError(formatWorkflowErrors(assetPath, result.errors));
  }
  return result.document;
}

function readWorkflowDocumentFromIndex(sourcePath: string, ref: string): WorkflowDocument | null {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) return null;

  const db = openExistingDatabase(dbPath);
  try {
    const parsed = parseAssetRef(ref);
    const entryKey = `${sourcePath}:${parsed.type}:${parsed.name}`;
    const row = db
      .prepare(
        `SELECT wd.document_json AS document_json
           FROM workflow_documents wd
           JOIN entries e ON e.id = wd.entry_id
          WHERE e.entry_type = 'workflow' AND e.entry_key = ?
          LIMIT 1`,
      )
      .get(entryKey) as { document_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.document_json) as WorkflowDocument;
    } catch {
      return null;
    }
  } finally {
    closeDatabase(db);
  }
}

function projectAsset(doc: WorkflowDocument, ref: string, assetPath: string, sourcePath: string): WorkflowAsset {
  return {
    ref,
    path: assetPath,
    sourcePath,
    title: doc.title,
    ...(doc.parameters
      ? {
          parameters: doc.parameters.map((p) => ({
            name: p.name,
            ...(p.description ? { description: p.description } : {}),
          })),
        }
      : {}),
    steps: doc.steps.map((s) => ({
      id: s.id,
      title: s.title,
      instructions: s.instructions.text,
      ...(s.completionCriteria ? { completionCriteria: s.completionCriteria.map((c) => c.text) } : {}),
      sequenceIndex: s.sequenceIndex,
    })),
  };
}

function resolveWorkflowEntryId(sourcePath: string, ref: string): number | null {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) return null;

  const db = openExistingDatabase(dbPath);
  try {
    const parsed = parseAssetRef(ref);
    const entryKey = `${sourcePath}:${parsed.type}:${parsed.name}`;

    const row = db
      .prepare(
        `SELECT id
         FROM entries
         WHERE entry_type = 'workflow'
            AND entry_key = ?
          LIMIT 1`,
      )
      .get(entryKey) as { id: number } | undefined;
    return row?.id ?? null;
  } finally {
    closeDatabase(db);
  }
}

function readWorkflowRun(db: import("bun:sqlite").Database, runId: string): WorkflowRunRow {
  const run = db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(runId) as WorkflowRunRow | undefined;
  if (!run) {
    throw new NotFoundError(`Workflow run "${runId}" not found.`, "WORKFLOW_NOT_FOUND");
  }
  return run;
}

function readWorkflowRunSteps(db: import("bun:sqlite").Database, runId: string): WorkflowRunStepRow[] {
  return db
    .prepare("SELECT * FROM workflow_run_steps WHERE run_id = ? ORDER BY sequence_index ASC")
    .all(runId) as WorkflowRunStepRow[];
}

function buildWorkflowRunDetail(run: WorkflowRunRow, steps: WorkflowRunStepRow[]): WorkflowRunDetail {
  return {
    run: toWorkflowRunSummary(run),
    workflow: {
      ref: run.workflow_ref,
      title: run.workflow_title,
      steps: steps.map(toWorkflowRunStepState),
    },
  };
}

function toWorkflowRunSummary(run: WorkflowRunRow): WorkflowRunSummary {
  return {
    id: run.id,
    workflowRef: run.workflow_ref,
    scopeKey: run.scope_key,
    workflowEntryId: run.workflow_entry_id,
    workflowTitle: run.workflow_title,
    status: run.status,
    currentStepId: run.current_step_id,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    completedAt: run.completed_at,
    params: parseJsonObject(run.params_json),
    agentHarness: run.agent_harness ?? null,
    agentSessionId: run.agent_session_id ?? null,
  };
}

function toWorkflowRunStepState(step: WorkflowRunStepRow): WorkflowRunStepState {
  return {
    id: step.step_id,
    title: step.step_title,
    instructions: step.instructions,
    completionCriteria: parseJsonArray(step.completion_json),
    sequenceIndex: step.sequence_index,
    status: step.status,
    notes: step.notes ?? undefined,
    evidence: parseJsonObject(step.evidence_json),
    summary: step.summary ?? undefined,
    completedAt: step.completed_at,
  };
}

function resolveCurrentStep(run: WorkflowRunRow, steps: WorkflowRunStepRow[]): WorkflowRunStepRow | undefined {
  if (run.current_step_id) {
    return steps.find((step) => step.step_id === run.current_step_id);
  }
  return steps.find((step) => step.status === "pending");
}

function deriveRunState(steps: WorkflowRunStepRow[]): {
  status: WorkflowRunStatus;
  currentStepId: string | null;
  completedAt: string | null;
} {
  const unresolved = steps.find((step) => step.status === "failed" || step.status === "blocked");
  if (unresolved) {
    return {
      status: unresolved.status === "failed" ? "failed" : "blocked",
      currentStepId: unresolved.step_id,
      completedAt: null,
    };
  }

  const pending = steps.find((step) => step.status === "pending");
  if (pending) {
    return { status: "active", currentStepId: pending.step_id, completedAt: null };
  }

  const completedAt = steps
    .map((step) => step.completed_at)
    .filter((value): value is string => typeof value === "string")
    .sort()
    .at(-1);
  return { status: "completed", currentStepId: null, completedAt: completedAt ?? null };
}

/**
/**
 * Build the default summary-validation judge from the configured LLM, or return
 * `null` when no LLM is configured (gate is then skipped — fail-open). Lazily
 * imports the client/config so the workflow engine has no hard LLM dependency.
 */
function buildDefaultSummaryJudge(): SummaryJudge | null {
  let llm: import("../core/config").LlmConnectionConfig | undefined;
  try {
    const config = loadConfig();
    const { getDefaultLlmConfig } = require("../core/config") as typeof import("../core/config");
    llm = getDefaultLlmConfig(config);
  } catch {
    return null;
  }
  if (!llm) return null;
  const resolved = llm;
  return async ({ system, user }) => {
    const { chatCompletion } = require("../llm/client") as typeof import("../llm/client");
    return chatCompletion(resolved, [
      { role: "system", content: system },
      { role: "user", content: user },
    ]);
  };
}

function parseJsonObject(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* ignore corrupt data */
  }
  return undefined;
}

function parseJsonArray(value: string | null): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string");
    }
  } catch {
    /* ignore corrupt data */
  }
  return undefined;
}

export async function getActiveWorkflowRun(
  scopeKey = getCurrentWorkflowScopeKey(),
): Promise<{ runId: string; stepId: string | null; workflowRef: string } | null> {
  return withWorkflowDb((db) => {
    const row = db
      .query<{ id: string; current_step_id: string | null; workflow_ref: string }, [string]>(
        "SELECT id, current_step_id, workflow_ref FROM workflow_runs WHERE scope_key = ? AND status IN ('active', 'blocked') ORDER BY updated_at DESC LIMIT 1",
      )
      .get(scopeKey);
    if (!row) return null;
    return { runId: row.id, stepId: row.current_step_id, workflowRef: row.workflow_ref };
  }).catch(() => null); // fail-open: never crash show output due to DB error
}
