import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { loadConfig } from "./config";
import { closeDatabase, openDatabase } from "./db";
import { NotFoundError, UsageError } from "./errors";
import { resolveSourcesForOrigin } from "./origin-resolve";
import { getDbPath } from "./paths";
import { resolveStashSources } from "./search-source";
import { parseAssetRef } from "./stash-ref";
import { resolveAssetPath } from "./stash-resolve";
import type {
  WorkflowParameter,
  WorkflowRunStatus,
  WorkflowRunStepState,
  WorkflowRunStepStatus,
  WorkflowRunSummary,
  WorkflowStepDefinition,
} from "./stash-types";
import { closeWorkflowDatabase, openWorkflowDatabase } from "./workflow-db";
import { parseWorkflowMarkdown, WorkflowValidationError } from "./workflow-markdown";

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
  workflow_entry_id: number | null;
  workflow_title: string;
  status: WorkflowRunStatus;
  params_json: string;
  current_step_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
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
  step?: WorkflowRunStepState;
}

export interface CompleteWorkflowStepInput {
  runId: string;
  stepId: string;
  status: Exclude<WorkflowRunStepStatus, "pending">;
  notes?: string;
  evidence?: Record<string, unknown>;
}

export async function startWorkflowRun(ref: string, params: Record<string, unknown> = {}): Promise<WorkflowRunDetail> {
  const asset = await loadWorkflowAsset(ref);
  const workflowDb = openWorkflowDatabase();

  try {
    const now = new Date().toISOString();
    const runId = randomUUID();
    const currentStepId = asset.steps[0]?.id ?? null;
    const workflowEntryId = resolveWorkflowEntryId(asset.sourcePath, asset.ref);

    workflowDb
      .prepare(
        `INSERT INTO workflow_runs (
        id, workflow_ref, workflow_entry_id, workflow_title, status, params_json, current_step_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      )
      .run(runId, asset.ref, workflowEntryId, asset.title, JSON.stringify(params), currentStepId, now, now);

    const insertStep = workflowDb.prepare(
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

    return getWorkflowStatus(runId);
  } finally {
    closeWorkflowDatabase(workflowDb);
  }
}

export function getWorkflowStatus(runId: string): WorkflowRunDetail {
  const workflowDb = openWorkflowDatabase();
  try {
    const run = readWorkflowRun(workflowDb, runId);
    const steps = readWorkflowRunSteps(workflowDb, run.id);
    return buildWorkflowRunDetail(run, steps);
  } finally {
    closeWorkflowDatabase(workflowDb);
  }
}

export function listWorkflowRuns(input?: { workflowRef?: string; activeOnly?: boolean }): {
  runs: WorkflowRunSummary[];
} {
  const workflowDb = openWorkflowDatabase();
  try {
    const filters: string[] = [];
    const params: string[] = [];
    if (input?.workflowRef) {
      const parsed = parseAssetRef(input.workflowRef);
      if (parsed.type !== "workflow") {
        throw new UsageError(`Expected a workflow ref (workflow:<name>), got "${input.workflowRef}".`);
      }
      filters.push("workflow_ref = ?");
      params.push(`${parsed.origin ? `${parsed.origin}//` : ""}workflow:${parsed.name}`);
    }
    if (input?.activeOnly) {
      filters.push("status = 'active'");
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = workflowDb
      .prepare(`SELECT * FROM workflow_runs ${where} ORDER BY updated_at DESC, created_at DESC`)
      .all(...params) as WorkflowRunRow[];
    return { runs: rows.map(toWorkflowRunSummary) };
  } finally {
    closeWorkflowDatabase(workflowDb);
  }
}

export async function getNextWorkflowStep(specifier: string): Promise<WorkflowNextResult> {
  const workflowDb = openWorkflowDatabase();
  try {
    const run = await resolveRunSpecifier(workflowDb, specifier);
    const steps = readWorkflowRunSteps(workflowDb, run.id);
    const currentStep = resolveCurrentStep(run, steps);
    return {
      run: toWorkflowRunSummary(run),
      workflow: {
        ref: run.workflow_ref,
        title: run.workflow_title,
        steps: steps.map(toWorkflowRunStepState),
      },
      ...(currentStep ? { step: toWorkflowRunStepState(currentStep) } : {}),
    };
  } finally {
    closeWorkflowDatabase(workflowDb);
  }
}

export function completeWorkflowStep(input: CompleteWorkflowStepInput): WorkflowRunDetail {
  const workflowDb = openWorkflowDatabase();
  try {
    const run = readWorkflowRun(workflowDb, input.runId);
    if (run.status !== "active") {
      throw new UsageError(`Workflow run ${run.id} is ${run.status} and cannot be updated.`);
    }
    const existing = workflowDb
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
    workflowDb
      .prepare(
        `UPDATE workflow_run_steps
         SET status = ?, notes = ?, evidence_json = ?, completed_at = ?
         WHERE run_id = ? AND step_id = ?`,
      )
      .run(
        input.status,
        input.notes?.trim() || null,
        input.evidence ? JSON.stringify(input.evidence) : null,
        completedAt,
        run.id,
        input.stepId,
      );

    const refreshedSteps = readWorkflowRunSteps(workflowDb, run.id);
    const state = deriveRunState(refreshedSteps);
    workflowDb
      .prepare(
        `UPDATE workflow_runs
         SET status = ?, current_step_id = ?, updated_at = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(state.status, state.currentStepId, completedAt, state.completedAt, run.id);

    return buildWorkflowRunDetail(
      {
        ...run,
        status: state.status,
        current_step_id: state.currentStepId,
        updated_at: completedAt,
        completed_at: state.completedAt,
      },
      refreshedSteps,
    );
  } finally {
    closeWorkflowDatabase(workflowDb);
  }
}

async function resolveRunSpecifier(db: import("bun:sqlite").Database, specifier: string): Promise<WorkflowRunRow> {
  const explicitRun = db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(specifier) as
    | WorkflowRunRow
    | undefined;
  if (explicitRun) return explicitRun;

  const parsed = parseAssetRef(specifier);
  if (parsed.type !== "workflow") {
    throw new UsageError(`Expected a workflow ref or workflow run id, got "${specifier}".`);
  }
  const ref = `${parsed.origin ? `${parsed.origin}//` : ""}workflow:${parsed.name}`;
  const active = db
    .prepare(
      "SELECT * FROM workflow_runs WHERE workflow_ref = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1",
    )
    .get(ref) as WorkflowRunRow | undefined;
  if (active) return active;

  const started = await startWorkflowRun(ref);
  return readWorkflowRun(db, started.run.id);
}

async function loadWorkflowAsset(ref: string): Promise<WorkflowAsset> {
  const parsed = parseAssetRef(ref);
  if (parsed.type !== "workflow") {
    throw new UsageError(`Expected a workflow ref (workflow:<name>), got "${ref}".`);
  }

  const config = loadConfig();
  const allSources = resolveStashSources(undefined, config);
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

  const content = fs.readFileSync(assetPath, "utf8");
  const workflow = parseWorkflowDocument(content);
  return {
    ref: `${parsed.origin ? `${parsed.origin}//` : ""}workflow:${parsed.name}`,
    path: assetPath,
    sourcePath: sourcePath ?? loadConfig().stashDir ?? assetPath,
    title: workflow.title,
    ...(workflow.parameters ? { parameters: workflow.parameters } : {}),
    steps: workflow.steps,
  };
}

function resolveWorkflowEntryId(sourcePath: string, ref: string): number | null {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) return null;

  const db = openDatabase(dbPath);
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
    throw new NotFoundError(`Workflow run not found: ${runId}`);
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
    workflowEntryId: run.workflow_entry_id,
    workflowTitle: run.workflow_title,
    status: run.status,
    currentStepId: run.current_step_id,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    completedAt: run.completed_at,
    params: parseJsonObject(run.params_json),
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

function parseWorkflowDocument(content: string) {
  try {
    return parseWorkflowMarkdown(content);
  } catch (error) {
    if (error instanceof WorkflowValidationError) {
      throw new UsageError(error.message);
    }
    throw error;
  }
}
