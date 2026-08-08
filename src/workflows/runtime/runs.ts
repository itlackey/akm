// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { randomUUID } from "node:crypto";
import { parseBundleRef } from "../../core/asset/asset-ref";
import { loadConfig } from "../../core/config/config";
import { ConfigError, NotFoundError, UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { warn } from "../../core/warn";
import type {
  WorkflowRunStatus,
  WorkflowRunStepState,
  WorkflowRunStepStatus,
  WorkflowRunSummary,
} from "../../sources/types";
import { insertEventOnce } from "../../storage/repositories/events-repository";
import {
  type WorkflowRunRow,
  type WorkflowRunStepRow,
  type WorkflowRunsRepository,
  type WorkflowRunUnitRow,
  type WorkflowRunUnitStatus,
  withWorkflowRunsRepo,
} from "../../storage/repositories/workflow-runs-repository";
import { getCurrentWorkflowScopeKey } from "../authoring/scope-key";
import { frozenSummaryJudge } from "../exec/frozen-judge";
import { detectSecretShapedParams } from "../exec/param-secrets";
import { collectWorkflowWarnings } from "../ir/compile";
import { compileResolveFreezeWorkflow } from "../ir/freeze";
import { materializeWorkflowParameterFlags, validateWorkflowParams, type WorkflowParameterFlag } from "../ir/params";
import { canonicalPlanJson, computePlanHash } from "../ir/plan-hash";
import { decodeWorkflowPlanV3, type FrozenEngineSnapshot, WORKFLOW_IR_VERSION } from "../ir/schema";
import {
  utf8Bytes,
  WORKFLOW_EVIDENCE_TRUNCATION_PREVIEW_CHARS,
  WORKFLOW_MAX_EVIDENCE_JSON_BYTES,
} from "../resource-limits";
import { type SummaryJudge, validateStepSummary } from "../validate-summary";
import { resolveAgentIdentity } from "./agent-identity";
import { type CheckinDirective, evaluateCheckin } from "./checkin";
import {
  assertWorkflowSpineMatchesPlan,
  classifyWorkflowRunPlan,
  frozenStepRows,
  requireExecutableWorkflowPlan,
} from "./plan-classifier";
import { evaluateStaleUnits, type StaleUnit } from "./unit-checkin";
import { canonicalizeWorkflowRefInput, loadWorkflowAsset, resolveWorkflowEntryId } from "./workflow-asset-loader";

export interface WorkflowRunDetail {
  run: WorkflowRunSummary;
  workflow: {
    ref: string;
    title: string;
    steps: WorkflowRunStepState[];
  };
  /** Present when the run looks stalled — a strong `continue` directive (#506). */
  checkin?: CheckinDirective;
  /**
   * Best-effort advisories about the run (PR #714 review round 2, #13). At
   * `start` this carries secret-shaped-param warnings: params are declared
   * non-secret (they are hashed into every unit prompt and cannot be redacted),
   * so a credential-looking param value is flagged loudly here.
   */
  warnings?: string[];
  /**
   * Per-unit diagnostics for `akm workflow status --units` (PR #714 review
   * round 2, #22). Present only when the caller opts in. See
   * {@link WorkflowUnitDiagnostic}.
   */
  units?: WorkflowUnitDiagnostic[];
}

/**
 * A per-unit diagnostic row for `akm workflow status --units` (PR #714 review
 * round 2, #22).
 *
 * Step EVIDENCE stays deterministic by design: a failed unit contributes only
 * its `failureReason` (the durable, journaled failure vocabulary) to the
 * artifact graph the reducer promotes — the engine's raw dispatch diagnostic is
 * never mixed into a hashed artifact (see `buildEvidence` in
 * `exec/step-work.ts`). This is the SEPARATE, honest surface for the human-
 * facing diagnostics that graph deliberately drops: it reads the unit journal
 * directly and reports each row's `failure_reason` plus whatever result/error
 * text the row itself carries (`result_json`, clipped). It never feeds back
 * into any artifact, reducer, or input hash.
 */
export interface WorkflowUnitDiagnostic {
  unitId: string;
  nodeId: string;
  stepId: string | null;
  /** Non-null on gate-evaluation rows (`"gate"`), null on dispatch rows. */
  phase: string | null;
  status: WorkflowRunUnitStatus;
  attempts: number;
  tokens: number | null;
  /** Journaled failure vocabulary for a failed unit; null otherwise. */
  failureReason: string | null;
  sessionId: string | null;
  /**
   * The row's `result_json` rendered as text (a completed unit's result, or any
   * partial/error text a failed unit produced), clipped to
   * {@link UNIT_DIAGNOSTIC_CLIP} chars. Null when the row journaled no result.
   */
  diagnostic: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /**
   * True when this is a `running` claim that has gone silent past the check-in
   * window — the process that claimed the unit died without journaling a
   * terminal row (Codex round-3 finding B). `status --units` runs the pure
   * {@link evaluateStaleUnits} pass, so an abandoned claim is reported as stale
   * rather than as an indefinitely `running` unit.
   */
  stale: boolean;
  /** Idle ms since the last heartbeat / first claim when the row is stale; null otherwise. */
  staleIdleMs: number | null;
  /** The holder of a `running` claim (migration 009); null when unclaimed. */
  claimHolder: string | null;
  /** When the `running` claim expires; null when unclaimed. */
  claimExpiresAt: string | null;
  engine: string | null;
  /** Journaled resolved runtime kind for a frozen-engine unit. */
  runtimeKind: "llm" | "agent" | "sdk" | null;
  platform: string | null;
}

/** Clip bound for a unit's `result_json` on the `--units` diagnostic surface. */
const UNIT_DIAGNOSTIC_CLIP = 2000;

function toUnitDiagnostic(
  row: WorkflowRunUnitRow,
  stale?: StaleUnit,
  plannedEngine?: FrozenEngineSnapshot,
): WorkflowUnitDiagnostic {
  let diagnostic: string | null = null;
  if (row.result_json !== null) {
    // `result_json` is a JSON-encoded value: a bare JSON string for a free-text
    // unit, an object/array for a schema unit. Render the decoded string as-is
    // (no surrounding quotes) and other shapes as compact JSON, then clip so a
    // large artifact can't flood the diagnostic surface.
    let text = row.result_json;
    try {
      const parsed = JSON.parse(row.result_json);
      text = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
    } catch {
      /* leave the raw journaled text */
    }
    diagnostic = text.length > UNIT_DIAGNOSTIC_CLIP ? `${text.slice(0, UNIT_DIAGNOSTIC_CLIP)}…` : text;
  }
  return {
    unitId: row.unit_id,
    nodeId: row.node_id,
    stepId: row.step_id,
    phase: row.phase,
    status: row.status,
    attempts: row.attempts,
    tokens: row.tokens,
    failureReason: row.failure_reason,
    sessionId: row.session_id,
    diagnostic,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    stale: stale !== undefined,
    staleIdleMs: stale ? (Number.isFinite(stale.idleMs) ? stale.idleMs : null) : null,
    claimHolder: row.claim_holder,
    claimExpiresAt: row.claim_expires_at,
    engine: row.engine ?? null,
    runtimeKind:
      row.engine && (row.runner === "llm" || row.runner === "agent" || row.runner === "sdk") ? row.runner : null,
    platform: plannedEngine?.kind === "agent" ? plannedEngine.platform : null,
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
  /**
   * Non-fatal notices produced when THIS invocation created the run (e.g. the
   * implicit engine fallback). Only present on the auto-start path — a resume
   * never re-surfaces a decision it did not make.
   */
  startWarnings?: string[];
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
   * builds one from the judge frozen into the run plan.
   * Injected primarily for tests.
   */
  summaryJudge?: SummaryJudge | null;
  /** Internal cooperative cancellation checked before gate and state commits. */
  signal?: AbortSignal;
  /**
   * Internal (engine only): the run-lease holder id of the `akm workflow run`
   * invocation making this call. While a LIVE lease is held, only its holder
   * may advance the spine — the engine owns the run while driving it. The
   * Calls without this holder are refused until the lease is released or
   * expires (R2 single-driver enforcement).
   */
  leaseHolder?: string;
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
  options?: {
    force?: boolean;
    agentHarness?: string | null;
    agentSessionId?: string | null;
    parameterFlags?: readonly WorkflowParameterFlag[];
  },
): Promise<WorkflowRunDetail> {
  const asset = await loadWorkflowAsset(ref);
  // Frozen plan (redesign addendum, R1): compile the plan ONCE at start and
  // persist it on the run row in the same transaction as the insert. Every
  // later invocation executes this snapshot — the asset file is never re-read
  // for an in-flight run; re-planning is an explicit new run.
  const frozen = compileResolveFreezeWorkflow(asset, loadConfig());
  const plan = decodeWorkflowPlanV3(frozen.plan);
  if (options?.parameterFlags?.length && Object.keys(params).length > 0) {
    throw new UsageError("Workflow parameters must use either an object or per-parameter flags, not both.");
  }
  const effectiveParams = options?.parameterFlags?.length
    ? materializeWorkflowParameterFlags(plan, options.parameterFlags)
    : params;
  // Non-fatal WARNINGS: untyped-step and undeclared-param advisories surface
  // as `warn()` lines at start (stderr, consistent with the repo's other
  // author-facing warnings) without blocking the run.
  for (const w of collectWorkflowWarnings(asset.document)) {
    warn(`workflow run: ${asset.path}:${w.line} — ${w.message}`);
  }
  // Reviewer #12: validate supplied parameters against the frozen param
  // schemas BEFORE creating the run, so a type-mismatched param (e.g. a string
  // for a `{ type: array }` param) is rejected with actionable errors instead
  // of flowing silently into a unit prompt. Programs without declared param
  // schemas (and every Markdown workflow) validate trivially.
  const paramErrors = validateWorkflowParams(plan, effectiveParams);
  if (paramErrors.length > 0) {
    throw new UsageError(
      `Cannot start ${asset.ref}: the supplied parameters do not satisfy the workflow's declared schemas:\n` +
        paramErrors.map((e) => `  - ${e}`).join("\n"),
      "INVALID_JSON_ARGUMENT",
    );
  }
  const planJson = canonicalPlanJson(plan);
  const planHash = computePlanHash(plan);
  const workflowRefs = await workflowRunRefSet(asset.ref, ref);
  return withWorkflowRunsRepo(async (repo) => {
    const now = new Date().toISOString();
    const runId = randomUUID();
    const scopeKey = getCurrentWorkflowScopeKey();
    const currentStepId = plan.steps[0]?.stepId ?? null;
    const workflowEntryId = resolveWorkflowEntryId(asset.sourcePath, asset.ref, asset.adapterId);

    // Capture the agent harness + session driving this run. Explicit options
    // win; otherwise fall back to best-effort environment detection. This is
    // identity-only — no background thread or timer is started here.
    const detected = resolveAgentIdentity();
    const agentHarness = options?.agentHarness !== undefined ? options.agentHarness : detected.harness;
    const agentSessionId = options?.agentSessionId !== undefined ? options.agentSessionId : detected.sessionId;

    // Concurrency guard (#485): if an active run already exists in this
    // (workflow_ref, scope_key) pair, refuse to create a parallel run unless
    // `force: true` is set. Previously every call inserted unconditionally,
    // so two terminals starting the same workflow could leave two runs racing.
    // The
    // active-alias query and all inserts now share this immediate transaction.
    // #506: arm a file-signal check-in (a timestamp, NOT a background thread —
    // per the workflow-agent check-in ADR) so a stalled run can be
    // re-targeted with a `continue` directive. The agent harness + session id
    // are already resolved above (agentHarness/agentSessionId, from #501).

    repo.immediateTransaction(() => {
      if (!options?.force) {
        const existing = repo.findActiveRunForScope(workflowRefs, scopeKey);
        if (existing) {
          throw new UsageError(
            `Workflow ${asset.ref} already has an active run in this scope (id=${existing.id}, step=${existing.current_step_id ?? "—"}). ` +
              `Use 'akm workflow run ${asset.ref}' to resume it or 'akm workflow abandon ${existing.id}' to give up on it.`,
            "RESOURCE_ALREADY_EXISTS",
          );
        }
      }
      repo.insertRun({
        id: runId,
        workflowRef: asset.ref,
        scopeKey,
        workflowEntryId,
        workflowTitle: asset.title,
        paramsJson: JSON.stringify(effectiveParams),
        currentStepId,
        createdAt: now,
        updatedAt: now,
        agentHarness,
        agentSessionId,
        checkinArmedAt: now,
      });

      repo.insertSteps(
        frozenStepRows(plan).map((step) => ({
          runId,
          stepId: step.stepId,
          stepTitle: step.stepTitle,
          instructions: step.instructions,
          completionJson: step.completionJson,
          sequenceIndex: step.sequenceIndex,
        })),
      );

      // Same transaction as the insert: a run row never exists without its frozen plan.
      repo.setRunPlan(runId, planJson, planHash, WORKFLOW_IR_VERSION);
    });

    const result = await getWorkflowStatus(runId);
    // #13: params are declared non-secret (they are copied verbatim into every
    // unit prompt and hashed into the unit identity, so they cannot be redacted
    // without breaking replay determinism). Surface a loud, best-effort warning
    // when a param LOOKS like a credential so the author moves it to an env
    // binding. Advisory only — never blocks the start.
    const secretWarnings = detectSecretShapedParams(effectiveParams);
    if (secretWarnings.length > 0) result.warnings = [...(result.warnings ?? []), ...secretWarnings];
    // The implicit engine fallback is announced ONCE, here at run creation —
    // the frozen plan records the engine actually used, so a resume never
    // re-announces a decision it did not make.
    if (frozen.engineAnnouncement) result.warnings = [...(result.warnings ?? []), frozen.engineAnnouncement];
    // 07 P1-B: emit only the run id + status — NOT the raw workflowTitle (which
    // comes verbatim from the workflow asset's frontmatter and is therefore
    // attacker-influenceable). Keeping raw titles out of the events stream
    // shrinks the injectable footprint for any consumer that re-surfaces events
    // into agent context.
    appendEvent({
      eventType: "workflow_started",
      ref: asset.ref,
      metadata: { runId: result.run.id, status: result.run.status },
    });
    return result;
  });
}

export async function getWorkflowStatus(
  runId: string,
  opts?: { includeUnits?: boolean; now?: number },
): Promise<WorkflowRunDetail> {
  return withWorkflowRunsRepo((repo) => {
    const run = readWorkflowRun(repo, runId);
    const steps = readWorkflowRunSteps(repo, run.id);
    const detail = buildWorkflowRunDetail(run, steps);
    if (opts?.includeUnits) {
      // The honest diagnostic surface (#22): read the unit journal straight and
      // project each row, INCLUDING failures whose diagnostic text the
      // deterministic evidence graph drops. Read-only; never mutates the run.
      const rows = repo.getUnitsForRun(run.id);
      // Codex round-3 finding B: run the pure stale-claim evaluator (`now`
      // injected for deterministic tests) so a unit left `running` by a process
      // that died surfaces as stale here, not just as raw `running`.
      const staleById = new Map(evaluateStaleUnits(rows, opts.now ?? Date.now()).map((u) => [u.unitId, u]));
      const classified = classifyWorkflowRunPlan(run);
      const engines = classified.support === "supported" ? classified.plan.execution?.engines : undefined;
      detail.units = rows.map((row) =>
        toUnitDiagnostic(row, staleById.get(row.unit_id), row.engine ? engines?.[row.engine] : undefined),
      );
    }
    return detail;
  });
}

export async function hasWorkflowRun(runId: string): Promise<boolean> {
  return withWorkflowRunsRepo((repo) => repo.hasRun(runId));
}

export async function listWorkflowRuns(input?: { workflowRef?: string; activeOnly?: boolean }): Promise<{
  runs: WorkflowRunSummary[];
}> {
  const scopeKey = getCurrentWorkflowScopeKey();
  const activeOnly = input?.activeOnly === true;
  if (input?.workflowRef === undefined) {
    return withWorkflowRunsRepo((repo) => ({
      runs: repo.listRuns({ scopeKey, ...(activeOnly ? { activeOnly: true } : {}) }).map(toWorkflowRunSummary),
    }));
  }

  const exactRef = input.workflowRef.trim();
  if (!exactRef) {
    throw new UsageError("Workflow ref filter cannot be empty.", "INVALID_FLAG_VALUE");
  }
  const parsedExactRef = parseBundleRef(exactRef);
  if (parsedExactRef.fragment !== undefined) {
    throw new UsageError("Workflow ref filters do not accept fragments.", "INVALID_FLAG_VALUE");
  }
  let workflowRefs = [exactRef];
  try {
    const canonicalRef = await canonicalizeWorkflowSpecifier(exactRef);
    workflowRefs = await workflowRunRefSet(canonicalRef, exactRef);
  } catch (error) {
    if (parsedExactRef.bundle !== undefined) {
      const exactRows = await withWorkflowRunsRepo((repo) => repo.listRuns({ scopeKey, workflowRef: exactRef }));
      if (exactRows.length === 0) throw error;
      return {
        runs: exactRows.filter((row) => !activeOnly || row.status === "active").map(toWorkflowRunSummary),
      };
    }
    if (!(error instanceof NotFoundError)) throw error;
  }
  return withWorkflowRunsRepo((repo) => ({
    runs: repo
      .listRuns({ scopeKey, workflowRefs, ...(activeOnly ? { activeOnly: true } : {}) })
      .map(toWorkflowRunSummary),
  }));
}

export async function getNextWorkflowStep(
  specifier: string,
  params?: Record<string, unknown>,
  options?: { parameterFlags?: readonly WorkflowParameterFlag[] },
): Promise<WorkflowNextResult> {
  return withWorkflowRunsRepo(async (repo) => {
    const { run, autoStarted, startWarnings } = await resolveRunSpecifier(
      repo,
      specifier,
      params,
      options?.parameterFlags,
    );
    const steps = readWorkflowRunSteps(repo, run.id);
    const plan = requireExecutableWorkflowPlan(run);
    assertWorkflowSpineMatchesPlan(plan, run, steps);
    return {
      ...projectNextResult(run, steps),
      ...(autoStarted ? { autoStarted: true as const } : {}),
      ...(startWarnings?.length ? { startWarnings } : {}),
    };
  });
}

/**
 * Project a run row + its step rows into a {@link WorkflowNextResult}. The pure
 * read-shaping half of {@link getNextWorkflowStep}, extracted so the run
 * snapshot below reproduces the exact same projection without re-running the
 * auto-start-capable {@link resolveRunSpecifier}.
 */
function projectNextResult(run: WorkflowRunRow, steps: WorkflowRunStepRow[]): WorkflowNextResult {
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
    ...(checkin ? { checkin } : {}),
  };
}

export async function resumeWorkflowRun(runId: string): Promise<WorkflowRunDetail> {
  return withWorkflowRunsRepo((repo) => {
    const run = readWorkflowRun(repo, runId);
    const plan = requireExecutableWorkflowPlan(run);
    const steps = readWorkflowRunSteps(repo, run.id);
    assertWorkflowSpineMatchesPlan(plan, run, steps);
    if (run.status === "completed") {
      throw new UsageError(`Workflow run ${run.id} is already completed and cannot be resumed.`);
    }
    if (run.status === "active") {
      return buildWorkflowRunDetail(run, steps);
    }
    // blocked or failed → flip back to active and re-open the current step so
    // it can be reclassified (completed, failed, skipped) after resuming.
    const now = new Date().toISOString();
    repo.transaction(() => {
      if (run.current_step_id) {
        repo.reopenStepsForResume(run.id, run.current_step_id);
      }
      repo.markRunActive(run.id, now);
    });
    const updated: WorkflowRunRow = { ...run, status: "active", updated_at: now };
    const refreshedSteps = readWorkflowRunSteps(repo, run.id);
    return buildWorkflowRunDetail(updated, refreshedSteps);
  });
}

/**
 * Give up on a run (08-F6): flip it to `failed` so it stops counting as
 * active — the run-level verb the concurrency-guard message in
 * {@link startWorkflowRun} advertises. Terminal-state runs are refused;
 * {@link resumeWorkflowRun} can reopen an abandoned run if it was a mistake.
 */
export async function abandonWorkflowRun(runId: string): Promise<WorkflowRunDetail> {
  return withWorkflowRunsRepo((repo) => {
    const now = new Date().toISOString();
    const run = repo.immediateTransaction((db) => {
      const current = readWorkflowRun(repo, runId);
      if (current.status === "completed" || current.status === "failed") {
        throw new UsageError(`Workflow run ${current.id} is already ${current.status}.`);
      }
      if (!repo.markRunAbandoned(current.id, now)) {
        throw new UsageError(`Workflow run ${current.id} is ${current.status} and cannot be abandoned.`);
      }
      insertEventOnce(db, {
        eventType: "workflow_abandoned",
        ts: now,
        ref: current.workflow_ref,
        metadata: { runId: current.id },
        idempotencyKey: current.id,
        idempotencyMetadataKey: "runId",
      });
      return current;
    });
    const updated: WorkflowRunRow = {
      ...run,
      status: "failed",
      updated_at: now,
      completed_at: now,
      checkin_armed_at: now,
    };
    const steps = readWorkflowRunSteps(repo, run.id);
    const detail = buildWorkflowRunDetail(updated, steps);
    return detail;
  });
}

// ── Step-evidence persistence bound (issue C) ────────────────────────────────

/**
 * Marker key stamped on every value this module replaced because it did not fit
 * in `workflow_run_steps.evidence_json`. It is deliberately ugly and unique so a
 * truncated value can NEVER be mistaken for real workflow data by a downstream
 * `steps.<id>.output…` reference, by `akm workflow status`, or by a human
 * reading the row.
 */
export const WORKFLOW_EVIDENCE_TRUNCATED_MARKER = "__akm_evidence_truncated__";

/** The replacement value persisted in place of an over-cap evidence entry. */
export interface TruncatedEvidenceValue {
  readonly [WORKFLOW_EVIDENCE_TRUNCATED_MARKER]: true;
  /** Human-readable explanation, including that the full value is unrecoverable from this row. */
  readonly reason: string;
  /** Serialized size of the value that was dropped. */
  readonly originalBytes: number;
  /** The cap that was exceeded. */
  readonly limitBytes: number;
  /** Leading slice of the dropped value's JSON — evidence for debugging, NEVER usable as data. */
  readonly preview?: string;
}

function truncatedEvidenceValue(
  json: string,
  what: string,
  limitBytes: number,
  withPreview: boolean,
): TruncatedEvidenceValue {
  return {
    [WORKFLOW_EVIDENCE_TRUNCATED_MARKER]: true,
    reason:
      `${what} exceeded the ${limitBytes}-byte evidence_json persistence cap and was NOT stored. ` +
      `The complete value existed only in the live step result; it cannot be recovered from this row. ` +
      `Reduce the step's fan-out or have it emit a reference (path, id) instead of inline bulk data.`,
    originalBytes: utf8Bytes(json),
    limitBytes,
    ...(withPreview ? { preview: json.slice(0, WORKFLOW_EVIDENCE_TRUNCATION_PREVIEW_CHARS) } : {}),
  } as TruncatedEvidenceValue;
}

/**
 * Bound what a step's evidence costs in ONE SQLite row.
 *
 * `buildEvidence` (exec/step-work.ts) promotes `evidence.output` UNCLIPPED by
 * design: gates judge the full promoted artifact and the in-memory
 * {@link StepExecutionResult} carries it to the caller intact. Nothing bounded
 * the PERSISTED form, though — a `collect` reducer over a fan-out capped only by
 * `WORKFLOW_MAX_MAP_EXPANSION` (10 000 units) can serialize to hundreds of
 * megabytes. This is the write boundary, so the bound lives here rather than in
 * the shared step-semantics module.
 *
 * Over-cap values are REPLACED (largest top-level entry first, until the row
 * fits) with a {@link TruncatedEvidenceValue} envelope. Nothing is silently
 * shortened: a consumer either sees the real value or sees an object whose
 * marker key says the data is gone. `preview` is intentionally not shaped like
 * the original, so an expression reaching INTO a truncated artifact
 * (`steps.x.output.files`) fails loudly at resolution instead of quietly
 * resolving against a half-array.
 *
 * Returns the JSON to persist plus the keys that were replaced (empty in the
 * overwhelmingly common case, where nothing is copied or re-serialized twice).
 */
export function clipStepEvidenceForPersistence(
  evidence: Record<string, unknown> | undefined,
  limitBytes: number = WORKFLOW_MAX_EVIDENCE_JSON_BYTES,
): { json: string | null; truncatedKeys: string[] } {
  if (!evidence) return { json: null, truncatedKeys: [] };
  // Throws exactly as the previous inline `JSON.stringify` did on unserializable
  // evidence — that contract is unchanged. Every stringify below operates on a
  // subtree of a value already proven serializable here.
  let json = JSON.stringify(evidence);
  if (json === undefined) return { json: null, truncatedKeys: [] };
  if (utf8Bytes(json) <= limitBytes) return { json, truncatedKeys: [] };

  const clipped: Record<string, unknown> = { ...evidence };
  const truncatedKeys: string[] = [];
  const bySizeDesc = Object.keys(evidence)
    .map((key) => ({ key, json: JSON.stringify(evidence[key]) ?? "null" }))
    .sort((a, b) => b.json.length - a.json.length);
  for (const entry of bySizeDesc) {
    clipped[entry.key] = truncatedEvidenceValue(entry.json, `Step evidence "${entry.key}"`, limitBytes, true);
    truncatedKeys.push(entry.key);
    json = JSON.stringify(clipped);
    if (utf8Bytes(json) <= limitBytes) return { json, truncatedKeys };
  }
  // Pathological shape (so many keys that even the envelopes overflow): persist
  // ONE whole-object marker. Still unambiguous, still bounded.
  return {
    json: JSON.stringify(truncatedEvidenceValue(JSON.stringify(evidence), "Step evidence", limitBytes, false)),
    truncatedKeys: Object.keys(evidence),
  };
}

export async function completeWorkflowStep(
  input: CompleteWorkflowStepInput,
): Promise<WorkflowRunDetail | SummaryValidationFailure> {
  // Read the step (read-only) up front so the LLM validation gate runs OUTSIDE
  // the write transaction — a slow/hung LLM must never hold a db write lock.
  const preflight = await withWorkflowRunsRepo((repo) => {
    const run = readWorkflowRun(repo, input.runId);
    const plan = requireExecutableWorkflowPlan(run);
    const steps = readWorkflowRunSteps(repo, run.id);
    assertWorkflowSpineMatchesPlan(plan, run, steps);
    if (run.status !== "active") {
      throw new UsageError(`Workflow run ${run.id} is ${run.status} and cannot be updated.`);
    }
    assertLeaseAllowsSpineAdvance(run, input.leaseHolder);
    const existing = repo.getStep(run.id, input.stepId);
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
    const stepPlan = plan.steps.find((step) => step.stepId === input.stepId);
    if (!stepPlan) throw new NotFoundError(`Step "${input.stepId}" was not found in workflow run ${run.id}.`);
    return { existing, plan, stepPlan };
  });

  const summary = input.summary?.trim();

  // #506: completing a step requires a summary of the work done.
  if (input.status === "completed" && !summary) {
    throw new UsageError(
      `Completing step "${input.stepId}" requires a --summary describing the work done.`,
      "MISSING_REQUIRED_ARGUMENT",
    );
  }

  // #506: validation gate — a criteria-bearing step must have a frozen judge
  // and receive an affirmative verdict before it can advance.
  if (input.status === "completed" && summary) {
    const criteria = preflight.stepPlan.gate.criteria;
    if (input.signal?.aborted) throw interruptionReason(input.signal);
    const judge =
      input.summaryJudge === undefined
        ? frozenSummaryJudge(preflight.plan, preflight.stepPlan.gate.judge, input.signal)
        : input.summaryJudge;
    if (criteria.length > 0 && !judge) {
      throw new ConfigError(
        `Workflow run ${input.runId} has completion criteria for step "${input.stepId}" but its frozen plan has no judge. ` +
          "Set workflow.judgeEngine, abandon this run, and create a new one with `akm workflow run <ref>`.",
        "INVALID_CONFIG_FILE",
      );
    }
    const verdict = await validateStepSummary(
      { stepTitle: preflight.stepPlan.title, completionCriteria: criteria, summary },
      judge ?? undefined,
      input.signal,
    );
    if (!verdict.complete) {
      // Re-arm the check-in so a subsequent stall is still nudged, but leave the
      // step pending and return corrective feedback instead of completing.
      await withWorkflowRunsRepo((repo) => {
        repo.rearmCheckin(input.runId, new Date().toISOString());
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

  if (input.signal?.aborted) throw interruptionReason(input.signal);
  return withWorkflowRunsRepo((repo) => {
    let updatedRun: WorkflowRunRow | undefined;
    let refreshedSteps: WorkflowRunStepRow[] = [];

    repo.transaction(() => {
      const run = readWorkflowRun(repo, input.runId);
      const plan = requireExecutableWorkflowPlan(run);
      const spine = readWorkflowRunSteps(repo, run.id);
      assertWorkflowSpineMatchesPlan(plan, run, spine);
      if (run.status !== "active") {
        throw new UsageError(`Workflow run ${run.id} is ${run.status} and cannot be updated.`);
      }
      // Re-checked inside the write transaction (like every other preflight
      // condition): an engine may have claimed the run while the summary gate
      // above was awaiting its LLM judge.
      assertLeaseAllowsSpineAdvance(run, input.leaseHolder);
      const existing = repo.getStep(run.id, input.stepId);
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
      if (input.signal?.aborted) throw interruptionReason(input.signal);

      const completedAt = new Date().toISOString();
      // Bound the single-row cost of the promoted artifact (issue C). The
      // caller's in-memory evidence object is never mutated — a clipped COPY is
      // serialized — so the live step result, the gate's artifact judging, and
      // this invocation's downstream `steps.<id>.output` scope all keep the
      // complete value.
      const persistedEvidence = clipStepEvidenceForPersistence(input.evidence);
      if (persistedEvidence.truncatedKeys.length > 0) {
        warn(
          `Workflow run ${run.id} step "${input.stepId}": evidence exceeded the ` +
            `${WORKFLOW_MAX_EVIDENCE_JSON_BYTES}-byte persistence cap; ` +
            `${persistedEvidence.truncatedKeys.map((k) => `"${k}"`).join(", ")} ` +
            `${persistedEvidence.truncatedKeys.length === 1 ? "was" : "were"} stored as a truncation marker. ` +
            `Steps that reference this step's output on resume will fail loudly rather than read partial data.`,
        );
      }
      repo.updateStepCompletion({
        status: input.status,
        notes: input.notes?.trim() || null,
        evidenceJson: persistedEvidence.json,
        summary: summary || null,
        completedAt,
        runId: run.id,
        stepId: input.stepId,
      });

      refreshedSteps = readWorkflowRunSteps(repo, run.id);
      const state = deriveRunState(refreshedSteps);
      // Re-arm the check-in on every state change: a healthy, progressing run
      // keeps pushing the stall window forward so the directive never fires.
      repo.updateRunState({
        status: state.status,
        currentStepId: state.currentStepId,
        updatedAt: completedAt,
        completedAt: state.completedAt,
        checkinArmedAt: completedAt,
        runId: run.id,
      });

      updatedRun = {
        ...run,
        status: state.status,
        current_step_id: state.currentStepId,
        updated_at: completedAt,
        completed_at: state.completedAt,
        checkin_armed_at: completedAt,
      };
    });

    const detail = buildWorkflowRunDetail(updatedRun as WorkflowRunRow, refreshedSteps);
    // #11: emit `workflow_step_completed` ONLY for a genuine `completed`
    // transition; every other non-pending status (failed/skipped/blocked)
    // carries the honest `workflow_step_updated` name. The status is ALWAYS
    // in metadata so consumers never infer it from the event name. Raw `notes`
    // are workflow/model-authored content — an event-stream prompt-injection
    // surface — and never enter the events log; they live on the step row only.
    appendEvent({
      eventType: input.status === "completed" ? "workflow_step_completed" : "workflow_step_updated",
      ref: detail.run.workflowRef,
      metadata: { runId: input.runId, stepId: input.stepId, status: input.status },
    });
    if (detail.run.status === "completed") {
      appendEvent({ eventType: "workflow_finished", ref: detail.run.workflowRef, metadata: { runId: input.runId } });
    }
    return detail;
  });
}

async function resolveRunSpecifier(
  repo: WorkflowRunsRepository,
  specifier: string,
  params?: Record<string, unknown>,
  parameterFlags?: readonly WorkflowParameterFlag[],
): Promise<{ run: WorkflowRunRow; autoStarted: boolean; startWarnings?: string[] }> {
  const hasParameters = (params && Object.keys(params).length > 0) || (parameterFlags?.length ?? 0) > 0;
  const explicitRun = repo.getRunById(specifier);
  if (explicitRun) {
    if (hasParameters) {
      throw new UsageError(
        `Workflow parameter flags can only be used when starting a new run, not with existing run id "${specifier}".`,
      );
    }
    return { run: explicitRun, autoStarted: false };
  }

  const scopeKey = getCurrentWorkflowScopeKey();
  const exactRef = specifier.trim();
  const parsedExact = parseBundleRef(exactRef);
  const qualifiedExact = parsedExact.bundle !== undefined && parsedExact.fragment === undefined;
  const detached = qualifiedExact ? repo.getActiveRunRowForScope(exactRef, scopeKey) : undefined;

  let ref: string;
  try {
    ref = await canonicalizeWorkflowSpecifier(specifier);
  } catch (error) {
    if (detached) {
      if (hasParameters) {
        throw new UsageError(`Workflow parameter flags can only be set on a new run; ${specifier} is already active.`);
      }
      return { run: detached, autoStarted: false };
    }
    if (error instanceof NotFoundError && !specifier.includes(":") && !specifier.includes("/")) {
      throw new NotFoundError(`Workflow run or workflow "${specifier}" not found.`, "WORKFLOW_NOT_FOUND");
    }
    throw error;
  }
  const active = repo.getActiveRunRowForScope(await workflowRunRefSet(ref, exactRef), scopeKey);
  if (active) {
    if (hasParameters) {
      throw new UsageError(`Workflow parameter flags can only be set on a new run; ${ref} is already active.`);
    }
    return { run: active, autoStarted: false };
  }

  const started = await startWorkflowRun(ref, params ?? {}, {
    ...(parameterFlags !== undefined ? { parameterFlags } : {}),
  });
  return {
    run: readWorkflowRun(repo, started.run.id),
    autoStarted: true,
    ...(started.warnings?.length ? { startWarnings: started.warnings } : {}),
  };
}

function interruptionReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Workflow run interrupted.");
}

async function canonicalizeWorkflowSpecifier(specifier: string): Promise<string> {
  return canonicalizeWorkflowRefInput(specifier);
}

async function workflowRunRefSet(canonicalRef: string, exactRef: string): Promise<string[]> {
  const parsed = parseBundleRef(canonicalRef);
  const refs = new Set([canonicalRef, exactRef.trim()]);
  const exact = parseBundleRef(exactRef.trim());
  if (exact.bundle === undefined) {
    refs.add(parsed.conceptId);
  } else {
    try {
      if ((await canonicalizeWorkflowSpecifier(parsed.conceptId)) === canonicalRef) refs.add(parsed.conceptId);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
  }
  return [...refs];
}

function readWorkflowRun(repo: WorkflowRunsRepository, runId: string): WorkflowRunRow {
  const run = repo.getRunById(runId);
  if (!run) {
    throw new NotFoundError(`Workflow run "${runId}" not found.`, "WORKFLOW_NOT_FOUND");
  }
  return run;
}

function readWorkflowRunSteps(repo: WorkflowRunsRepository, runId: string): WorkflowRunStepRow[] {
  return repo.getStepsForRun(runId);
}

function buildWorkflowRunDetail(run: WorkflowRunRow, steps: WorkflowRunStepRow[]): WorkflowRunDetail {
  // Review M1: `workflow status` (and every other detail-shaped response) now
  // evaluates the check-in, not just `workflow run`. Pure timestamp check —
  // no background thread (see checkin.ts).
  const checkin = evaluateCheckin({
    status: run.status,
    updatedAt: run.updated_at,
    checkinArmedAt: run.checkin_armed_at,
    agentHarness: run.agent_harness,
    agentSessionId: run.agent_session_id,
  });
  return {
    run: toWorkflowRunSummary(run),
    workflow: {
      ref: run.workflow_ref,
      title: run.workflow_title,
      steps: steps.map(toWorkflowRunStepState),
    },
    ...(checkin ? { checkin } : {}),
  };
}

function toWorkflowRunSummary(run: WorkflowRunRow): WorkflowRunSummary {
  const plan = classifyWorkflowRunPlan(run);
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
    planIrVersion: plan.irVersion,
    executionSupport: plan.support,
    // Surface the engine lease (holder id + expiry — never workflow-authored
    // content) so `workflow run`/`status` show who is driving the run.
    ...(run.engine_lease_holder && run.engine_lease_until
      ? { engineLease: { holder: run.engine_lease_holder, until: run.engine_lease_until } }
      : {}),
  };
}

/**
 * Single-driver enforcement (R2 run lease): while a LIVE (unexpired) engine
 * lease is held, only the holding engine may advance the gate spine. Manual
 * A call with no `leaseHolder` — or a stale engine invocation
 * whose lease was claimed by another — is refused with the holder + expiry.
 * An EXPIRED lease never blocks: the engine that held it is presumed dead.
 */
function assertLeaseAllowsSpineAdvance(run: WorkflowRunRow, leaseHolder: string | undefined): void {
  if (!run.engine_lease_holder || !run.engine_lease_until) return;
  if (leaseHolder === run.engine_lease_holder) return;
  if (run.engine_lease_until < new Date().toISOString()) return; // expired ⇒ claimable, not live
  throw new UsageError(
    `Workflow run ${run.id} is being driven by engine ${run.engine_lease_holder} ` +
      `(run lease expires ${run.engine_lease_until}). The engine owns the step spine while it runs — ` +
      `wait for it to finish or for the lease to expire before advancing steps manually.`,
  );
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
  return withWorkflowRunsRepo((repo) => {
    const row = repo.findActiveOrBlockedRunForScope(scopeKey);
    if (!row) return null;
    return { runId: row.id, stepId: row.current_step_id, workflowRef: row.workflow_ref };
  }).catch(() => null); // fail-open: never crash show output due to DB error
}
