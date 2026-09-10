// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { randomUUID } from "node:crypto";
import { parseBundleRef } from "../../core/asset/asset-ref";
import { loadConfig } from "../../core/config/config";
import { ConfigError, NotFoundError, TransientError, UsageError } from "../../core/errors";
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
import { compileResolveFreezeWorkflowV4 } from "../ir/freeze-v4";
import { materializeWorkflowParameterFlags, validateWorkflowParams, type WorkflowParameterFlag } from "../ir/params";
import { canonicalPlanJson, computePlanHash } from "../ir/plan-hash";
import type { IrRuntimeKind } from "../ir/schema";
import { clip, WORKFLOW_UNIT_DIAGNOSTIC_CLIP } from "../resource-limits";
import { type SummaryJudge, validateStepSummary } from "../validate-summary";
import { resolveAgentIdentity } from "./agent-identity";
import { type CheckinDirective, evaluateCheckin } from "./checkin";
import {
  assertRunStatusMatchesSpine,
  classifyWorkflowRunPlan,
  frozenStepRows,
  reconcileWorkflowSpineWithPlan,
  requireExecutableWorkflowPlan,
} from "./plan-classifier";
import { resolveWorkflowRunOutputs } from "./run-outputs";
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
  /**
   * The parent-child status tree (P3b, spec §4.5). Absent, never `[]`, when
   * this run has no children — so a childless run's envelope stays
   * byte-identical to pre-P3b (Stable tier, row B-33).
   */
  children?: WorkflowChildRunNode[];
}

/** One node of the parent-child status tree (P3b, spec §4.5, rows B-34…B-37). */
export interface WorkflowChildRunNode {
  runId: string;
  workflowRef: string;
  workflowTitle: string;
  status: WorkflowRunStatus;
  /** `workflow_runs.parent_unit_id` — the parent unit that spawned it. */
  spawnedByUnitId: string;
  /** The parent STEP that unit belongs to; `null` when its unit row is gone. */
  stepId: string | null;
  currentStepId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Present only when `status === "blocked"`. */
  resume?: { command: string; then: string };
  /** This child's own children. Absent, never `[]`, when it has none. */
  children?: WorkflowChildRunNode[];
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
   * The row's `result_json` rendered as text, clipped to
   * {@link WORKFLOW_UNIT_DIAGNOSTIC_CLIP} chars — the same bound the dispatch
   * path clips with before journaling. Re-clipped here regardless because the
   * database is an untrusted persistence boundary. Null when the row journaled
   * nothing.
   *
   * For a COMPLETED unit that is its result. For a FAILED unit it is the
   * dispatch diagnostic the journal kept — already scrubbed by the dispatch
   * redaction contract before it was written. For an `exec` unit that is where
   * a failing command's stderr lands, and it is frequently the ONLY explanation
   * of the failure: `failure_reason: non_zero_exit` says a command failed, and a
   * command that explains itself on stderr with empty stdout would otherwise say
   * nothing at all here.
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
  runtimeKind: IrRuntimeKind | null;
  platform: string | null;
}

/**
 * Membership test for the journaled `runner` column, which is an untyped string.
 * The `Record<IrRuntimeKind, …>` is exhaustiveness-checked, so a new runtime
 * kind cannot be added to the union without being accepted here too.
 */
const IR_RUNTIME_KINDS: Record<IrRuntimeKind, true> = { llm: true, agent: true, sdk: true, exec: true };

function runtimeKindOf(runner: string | null): IrRuntimeKind | null {
  return runner !== null && Object.hasOwn(IR_RUNTIME_KINDS, runner) ? (runner as IrRuntimeKind) : null;
}

function toUnitDiagnostic(row: WorkflowRunUnitRow, stale?: StaleUnit): WorkflowUnitDiagnostic {
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
    diagnostic = clip(text, WORKFLOW_UNIT_DIAGNOSTIC_CLIP);
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
    runtimeKind: runtimeKindOf(row.runner),
    platform: null,
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
   * Present when a workflow REF (not a run id) resolved to an existing
   * active run instead of starting a new one (#919's silent-resume report):
   * the #485 concurrency guard's ref-to-active-run attach is unchanged, this
   * just makes it visible. Never set together with `autoStarted`.
   */
  resumed?: true;
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
  const frozen = await compileResolveFreezeWorkflowV4(asset, loadConfig());
  const plan = frozen.plan;
  if (options?.parameterFlags?.length && Object.keys(params).length > 0) {
    throw new UsageError("Workflow parameters must use either an object or per-parameter flags, not both.");
  }
  const effectiveParams = options?.parameterFlags?.length
    ? materializeWorkflowParameterFlags(plan, options.parameterFlags)
    : params;
  // Non-fatal WARNINGS: untyped-step and undeclared-param advisories surface
  // as `warn()` lines at start (stderr, consistent with the repo's other
  // author-facing warnings) without blocking the run.
  for (const w of collectWorkflowWarnings(asset.sourceIr)) {
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

    // Capture the invoking harness/session identity for this run. Explicit options
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

    // #942: an active run of this ref may already exist in a DIFFERENT
    // scope — the incident this issue reports (a scheduled task's cwd and a
    // human's shell hash to different scope keys, so each believed it held
    // no active run and each started one). The scope-local uniqueness guard
    // stays scope-local (a documented, deliberate per-project partition —
    // see storage-locations.md); this only warns, once, so the operator can
    // resume or abandon the other run instead of silently accumulating a
    // second one. `findActiveRunOutsideScope` excludes the caller's own
    // scope IN SQL (never merely post-filtered) so the caller's own active
    // run can never sort first under `LIMIT 1` and mask a genuinely different
    // scope's run — the failure mode a same-scope-inclusive query plus a
    // post-filter has with `--new`/`--force`.
    const crossScopeActive = repo.findActiveRunOutsideScope(workflowRefs, scopeKey);
    const crossScopeWarning = crossScopeActive
      ? `Workflow ${asset.ref} already has an active run in another scope ` +
        `(id ${crossScopeActive.id}, started ${crossScopeActive.created_at}, scope ${crossScopeActive.scope_key ?? "unknown"}); ` +
        `starting a separate run here. Resume it from anywhere with "akm workflow run ${crossScopeActive.id}" ` +
        `or free it with "akm workflow abandon ${crossScopeActive.id}".`
      : undefined;

    repo.publishWorkflowRunV4({
      workflowRefs,
      ...(options?.force ? { force: true } : {}),
      run: {
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
      },
      steps: frozenStepRows(plan).map((step) => ({
        runId,
        stepId: step.stepId,
        stepTitle: step.stepTitle,
        instructions: step.instructions,
        completionJson: step.completionJson,
        sequenceIndex: step.sequenceIndex,
      })),
      planJson,
      planHash,
      revalidateSources: () => frozen.sourceCollector.revalidate(),
    });

    const result = await getWorkflowStatus(runId);
    if (crossScopeWarning) result.warnings = [...(result.warnings ?? []), crossScopeWarning];
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
    const detail = buildWorkflowRunDetail(repo, run, steps);
    if (opts?.includeUnits) {
      // The honest diagnostic surface (#22): read the unit journal straight and
      // project each row, INCLUDING failures whose diagnostic text the
      // deterministic evidence graph drops. Read-only; never mutates the run.
      const rows = repo.getUnitsForRun(run.id);
      // Codex round-3 finding B: run the pure stale-claim evaluator (`now`
      // injected for deterministic tests) so a unit left `running` by a process
      // that died surfaces as stale here, not just as raw `running`.
      const staleById = new Map(evaluateStaleUnits(rows, opts.now ?? Date.now()).map((u) => [u.unitId, u]));
      detail.units = rows.map((row) => toUnitDiagnostic(row, staleById.get(row.unit_id)));
    }
    return detail;
  });
}

export async function listWorkflowRuns(input?: {
  workflowRef?: string;
  activeOnly?: boolean;
  /** Include child workflow runs (P3b, B-N10). Default `false`. */
  includeChildren?: boolean;
  /**
   * Search every scope instead of only the caller's current one (#942,
   * `akm workflow list/status --all-scopes`). Default `false`: byte-identical
   * to pre-#942 behavior.
   */
  allScopes?: boolean;
}): Promise<{
  runs: WorkflowRunSummary[];
  /**
   * The scope this call filtered on, or `null` when `allScopes` was passed
   * (#942). Lets an empty `runs: []` be told apart from "nothing anywhere" —
   * the operator confusion the underlying incident hit.
   */
  scopeKey: string | null;
}> {
  const scopeKey = input?.allScopes === true ? null : getCurrentWorkflowScopeKey();
  const activeOnly = input?.activeOnly === true;
  const includeChildren = input?.includeChildren === true;
  if (input?.workflowRef === undefined) {
    return withWorkflowRunsRepo((repo) => ({
      runs: repo
        .listRuns({
          scopeKey,
          ...(activeOnly ? { activeOnly: true } : {}),
          ...(includeChildren ? { includeChildren: true } : {}),
        })
        .map(toWorkflowRunSummary),
      scopeKey,
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
      const exactRows = await withWorkflowRunsRepo((repo) =>
        repo.listRuns({ scopeKey, workflowRef: exactRef, ...(includeChildren ? { includeChildren: true } : {}) }),
      );
      if (exactRows.length === 0) throw error;
      return {
        runs: exactRows.filter((row) => !activeOnly || row.status === "active").map(toWorkflowRunSummary),
        scopeKey,
      };
    }
    if (!(error instanceof NotFoundError)) throw error;
  }
  return withWorkflowRunsRepo((repo) => ({
    runs: repo
      .listRuns({
        scopeKey,
        workflowRefs,
        ...(activeOnly ? { activeOnly: true } : {}),
        ...(includeChildren ? { includeChildren: true } : {}),
      })
      .map(toWorkflowRunSummary),
    scopeKey,
  }));
}

export async function getNextWorkflowStep(
  specifier: string,
  params?: Record<string, unknown>,
  options?: { parameterFlags?: readonly WorkflowParameterFlag[]; newRun?: boolean },
): Promise<WorkflowNextResult> {
  return withWorkflowRunsRepo(async (repo) => {
    const { run, autoStarted, resumed, startWarnings } = await resolveRunSpecifier(
      repo,
      specifier,
      params,
      options?.parameterFlags,
      options?.newRun,
    );
    const steps = readWorkflowRunSteps(repo, run.id);
    const plan = requireExecutableWorkflowPlan(run);
    reconcileWorkflowSpineWithPlan(plan, run, steps);
    assertRunStatusMatchesSpine(run, steps);
    return {
      ...projectNextResult(run, steps),
      ...(autoStarted ? { autoStarted: true as const } : {}),
      ...(resumed ? { resumed: true as const } : {}),
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
    const run = readWorkflowRunOrPrefix(repo, runId);
    const storedPlan = requireExecutableWorkflowPlan(run);
    const steps = readWorkflowRunSteps(repo, run.id);
    reconcileWorkflowSpineWithPlan(storedPlan, run, steps);
    if (run.status === "completed") {
      throw new UsageError(`Workflow run ${run.id} is already completed and cannot be resumed.`);
    }
    if (run.status === "active") {
      assertRunStatusMatchesSpine(run, steps);
      return buildWorkflowRunDetail(repo, run, steps);
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
    assertRunStatusMatchesSpine(updated, refreshedSteps);
    return buildWorkflowRunDetail(repo, updated, refreshedSteps);
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
      const current = readWorkflowRunOrPrefix(repo, runId);
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
    const detail = buildWorkflowRunDetail(repo, updated, steps);
    return detail;
  });
}

export async function completeWorkflowStep(
  input: CompleteWorkflowStepInput,
): Promise<WorkflowRunDetail | SummaryValidationFailure> {
  // Read the step (read-only) up front so the LLM validation gate runs OUTSIDE
  // the write transaction — a slow/hung LLM must never hold a db write lock.
  const preflight = await withWorkflowRunsRepo((repo) => {
    const run = readWorkflowRun(repo, input.runId);
    const storedPlan = requireExecutableWorkflowPlan(run);
    const steps = readWorkflowRunSteps(repo, run.id);
    reconcileWorkflowSpineWithPlan(storedPlan, run, steps);
    assertRunStatusMatchesSpine(run, steps);
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
    const stepPlan = storedPlan.steps.find((step) => step.stepId === input.stepId);
    if (!stepPlan) throw new NotFoundError(`Step "${input.stepId}" was not found in workflow run ${run.id}.`);
    return { existing, plan: storedPlan, stepPlan };
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
        ? // Manual completion journals no gate row, so there is no `<stepId>.gate:l<loop>`
          // identity to agree with — but the dispatch still names the REAL run and
          // step (frozen-judge falls back to the gate node id for the unit id).
          frozenSummaryJudge(preflight.stepPlan.gate.frozenJudge, input.signal, undefined, {
            runId: input.runId,
            stepId: input.stepId,
          })
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
    let outputWarnings: string[] | undefined;

    repo.transaction(() => {
      const run = readWorkflowRun(repo, input.runId);
      const plan = requireExecutableWorkflowPlan(run);
      const spine = readWorkflowRunSteps(repo, run.id);
      reconcileWorkflowSpineWithPlan(plan, run, spine);
      assertRunStatusMatchesSpine(run, spine);
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
      // The promoted artifact is persisted WHOLE, unclipped (issue C): a
      // step artifact that does not fit some cap used to be replaced by a
      // truncation marker at this exact write, and the run looked fine right
      // up until a LATER invocation (a resume, or any downstream step
      // referencing it) found the marker instead of the value and failed
      // permanently, with every prior paid step now unrecoverable. Persisting
      // the real value here is what makes it readable again on resume.
      const evidenceJson = input.evidence ? JSON.stringify(input.evidence) : null;
      repo.updateStepCompletion({
        status: input.status,
        notes: input.notes?.trim() || null,
        evidenceJson,
        summary: summary || null,
        completedAt,
        runId: run.id,
        stepId: input.stepId,
      });

      refreshedSteps = readWorkflowRunSteps(repo, run.id);
      const state = deriveRunState(refreshedSteps);

      // P3b (spec §4.3, B-N13): resolve + persist declared outputs INSIDE
      // this same transaction, immediately after the run is known to have
      // COMPLETED. A resolution failure throws here, and the transaction
      // rolls back whole — the step completion included — so the observable
      // outcome is fail-before-mutation: the step stays pending, the run
      // stays active, and (since appendEvent runs outside this transaction)
      // no event is appended.
      let outputsJson: string | null | undefined; // undefined = untouched, keep the row's existing value
      if (state.status === "completed" && plan.outputs) {
        const resolved = resolveWorkflowRunOutputs(plan, refreshedSteps);
        outputsJson = JSON.stringify(resolved.outputs);
        repo.setRunOutputs(run.id, outputsJson);
        outputWarnings = resolved.errors;
      }

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
        ...(outputsJson !== undefined ? { outputs_json: outputsJson } : {}),
      };
    });

    const detail = buildWorkflowRunDetail(repo, updatedRun as WorkflowRunRow, refreshedSteps);
    if (outputWarnings?.length) {
      const messages = outputWarnings.map((e) => `Workflow run ${input.runId} declared ${e}`);
      for (const message of messages) warn(message);
      detail.warnings = [...(detail.warnings ?? []), ...messages];
    }
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
  forceNew?: boolean,
): Promise<{ run: WorkflowRunRow; autoStarted: boolean; resumed?: true; startWarnings?: string[] }> {
  const hasParameters = (params && Object.keys(params).length > 0) || (parameterFlags?.length ?? 0) > 0;
  const explicitRun = findRunByIdOrPrefix(repo, specifier);
  if (explicitRun) {
    // `--new` starts a fresh run FROM A REF; it never makes sense against a
    // run id (or an id prefix), which already names the run to act on (#919).
    if (forceNew) {
      throw new UsageError(
        `--new starts a fresh run from a workflow ref; "${specifier}" already names a run id.`,
        "INVALID_FLAG_VALUE",
      );
    }
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
  const detached = qualifiedExact && !forceNew ? repo.getActiveRunRowForScope(exactRef, scopeKey) : undefined;

  let ref: string;
  try {
    ref = await canonicalizeWorkflowSpecifier(specifier);
  } catch (error) {
    if (detached) {
      if (hasParameters) {
        throw new UsageError(
          `Workflow parameter flags can only be set on a new run; ${specifier} is already active ` +
            `(id ${detached.id}, scope ${scopeKey}).`,
          "INVALID_FLAG_VALUE",
          `Pass --new to start a separate run, or run "akm workflow abandon ${detached.id}" to free up ${specifier} first.`,
        );
      }
      return { run: detached, autoStarted: false, resumed: true };
    }
    if (error instanceof NotFoundError && !specifier.includes(":") && !specifier.includes("/")) {
      throw new NotFoundError(`Workflow run or workflow "${specifier}" not found.`, "WORKFLOW_NOT_FOUND");
    }
    throw error;
  }
  const active = forceNew ? undefined : repo.getActiveRunRowForScope(await workflowRunRefSet(ref, exactRef), scopeKey);
  if (active) {
    if (hasParameters) {
      throw new UsageError(
        `Workflow parameter flags can only be set on a new run; ${ref} is already active ` +
          `(id ${active.id}, scope ${scopeKey}).`,
        "INVALID_FLAG_VALUE",
        `Pass --new to start a separate run, or run "akm workflow abandon ${active.id}" to free up ${ref} first.`,
      );
    }
    return { run: active, autoStarted: false, resumed: true };
  }

  // `force` (#485's own escape hatch) is what lets `--new` create a second
  // active run for this (ref, scope) pair instead of the concurrency guard
  // refusing it — the caller explicitly asked for a fresh run, so the guard
  // that exists to catch an ACCIDENTAL second run does not apply (#919).
  const started = await startWorkflowRun(ref, params ?? {}, {
    ...(parameterFlags !== undefined ? { parameterFlags } : {}),
    ...(forceNew ? { force: true } : {}),
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

/**
 * A workflow run id (or an accepted prefix of one, #919) is hex digits and
 * hyphens, 8+ characters. A workflow ref always contains at least one
 * character outside that set (a `/` path segment, at minimum), so this
 * never mistakes a ref for an id — matching input is ALWAYS resolved as an
 * id/prefix, never falls through to ref resolution.
 */
const RUN_ID_PREFIX_PATTERN = /^[0-9a-f-]{8,}$/;

/** The run `specifier` names: by exact id, or by unique id prefix (#919) when it is id-shaped; `undefined` for a workflow ref. */
function findRunByIdOrPrefix(repo: WorkflowRunsRepository, specifier: string): WorkflowRunRow | undefined {
  const exact = repo.getRunById(specifier);
  if (exact || !RUN_ID_PREFIX_PATTERN.test(specifier)) return exact;
  return repo.getRunById(repo.resolveRunIdPrefix(specifier));
}

/** For verbs that take a run id/prefix OR a workflow ref (`status`): the run id, or `undefined` to fall through to ref resolution. */
export async function resolveWorkflowRunTarget(specifier: string): Promise<string | undefined> {
  return withWorkflowRunsRepo((repo) => findRunByIdOrPrefix(repo, specifier)?.id);
}

/** User-facing read: accepts an id prefix. Internal reads use {@link readWorkflowRun} with an exact id. */
function readWorkflowRunOrPrefix(repo: WorkflowRunsRepository, specifier: string): WorkflowRunRow {
  const run = findRunByIdOrPrefix(repo, specifier);
  if (!run) throw new NotFoundError(`Workflow run "${specifier}" not found.`, "WORKFLOW_NOT_FOUND");
  return reclaimOrphanedEngineLease(repo, run);
}

function readWorkflowRun(repo: WorkflowRunsRepository, runId: string): WorkflowRunRow {
  const run = repo.getRunById(runId);
  if (!run) {
    throw new NotFoundError(`Workflow run "${runId}" not found.`, "WORKFLOW_NOT_FOUND");
  }
  return reclaimOrphanedEngineLease(repo, run);
}

/**
 * Self-heal a run's engine lease once it has expired — the orphaned-lease
 * case where an engine crashed without releasing it — mirroring the
 * maintenance barrier's self-reclaim of a wedged sentinel, applied at the
 * points a caller actually asks "what is this run's state". Never touches a
 * live lease: {@link WorkflowRunsRepository.reclaimExpiredEngineLease} is a
 * compare-and-swap on the exact (holder, until) this call observed, so a
 * lease renewed or re-acquired between the read and this write is left alone.
 */
function reclaimOrphanedEngineLease(repo: WorkflowRunsRepository, run: WorkflowRunRow): WorkflowRunRow {
  const { engine_lease_holder: holder, engine_lease_until: until } = run;
  if (!holder || !until) return run;
  const now = new Date().toISOString();
  if (until >= now) return run;
  repo.reclaimExpiredEngineLease(run.id, holder, until, now);
  return { ...run, engine_lease_holder: null, engine_lease_until: null };
}

function readWorkflowRunSteps(repo: WorkflowRunsRepository, runId: string): WorkflowRunStepRow[] {
  return repo.getStepsForRun(runId);
}

function buildWorkflowRunDetail(
  repo: WorkflowRunsRepository,
  run: WorkflowRunRow,
  steps: WorkflowRunStepRow[],
): WorkflowRunDetail {
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
  const children = childRunTree(repo, run.id, run.id);
  return {
    run: toWorkflowRunSummary(run),
    workflow: {
      ref: run.workflow_ref,
      title: run.workflow_title,
      steps: steps.map(toWorkflowRunStepState),
    },
    ...(checkin ? { checkin } : {}),
    ...(children ? { children } : {}),
  };
}

/**
 * Build the parent-child status tree rooted at `rootRunId`, recursively, for
 * whatever run's children are being listed (`forRunId`) — P3b, spec §4.5.
 * `rootRunId` is threaded unchanged through the recursion, so every blocked
 * node's `resume.then` names the SAME top-of-query run regardless of nesting
 * depth: `akm workflow resume <rootRunId> && akm workflow run <rootRunId>` —
 * never each node's own immediate parent, which the tree's caller has no
 * command for.
 *
 * That command is sufficient to clear a block exactly ONE level deep (the
 * root's own composing step blocked directly on this node) but NOT deeper
 * (code-review round 4, finding 6 / Review log R6 — corrects a false claim
 * this comment used to make here). Re-driving the root does **not** cascade
 * back down through every intermediate composing step: `driveChildWorkflowUnit`
 * (child-workflow.ts) never re-drives a child whose OWN status is `blocked`
 * (row A-22) — no lease is even taken — so a re-drive just RE-OBSERVES the
 * still-blocked status and re-propagates the block upward (an intermediate
 * run is always blocked when a descendant is, row A-21, applied
 * recursively), never reaching the deepest blocked node. Clearing a
 * depth-2-or-deeper block requires resuming EVERY blocked run in the chain,
 * deepest first, then re-running only the root — see "Recovering a blocked
 * child" in docs/guides/run-workflows.md and "Blocked-child recovery" in
 * docs/reference/workflow-schema.md for the worked multi-level sequence.
 * `resume.then` is deliberately not widened to enumerate that chain (no
 * envelope change, no new field) — the docs carry the multi-level sequence
 * instead.
 *
 * Absent, never `[]`, when `forRunId` has no children (P3a's `childRunsOf`
 * order: `created_at, id`).
 */
function childRunTree(
  repo: WorkflowRunsRepository,
  rootRunId: string,
  forRunId: string,
): WorkflowChildRunNode[] | undefined {
  const rows = repo.childRunsOf(forRunId);
  if (rows.length === 0) return undefined;
  return rows.map((row) => toChildRunNode(repo, rootRunId, row));
}

function toChildRunNode(repo: WorkflowRunsRepository, rootRunId: string, row: WorkflowRunRow): WorkflowChildRunNode {
  const spawnedByUnitId = row.parent_unit_id ?? "";
  // B-36: the parent STEP that spawned it, resolved via the real journaled
  // unit row — null when that unit row is gone.
  const stepId =
    row.parent_run_id && row.parent_unit_id
      ? (repo.getUnit(row.parent_run_id, row.parent_unit_id)?.step_id ?? null)
      : null;
  const children = childRunTree(repo, rootRunId, row.id);
  return {
    runId: row.id,
    workflowRef: row.workflow_ref,
    workflowTitle: row.workflow_title,
    status: row.status,
    spawnedByUnitId,
    stepId,
    currentStepId: row.current_step_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.status === "blocked"
      ? {
          resume: {
            command: `akm workflow resume ${row.id}`,
            // biome-ignore lint/suspicious/noThenProperty: mirrors spec §4.5's real WorkflowChildRunNode.resume.then field name
            then: `akm workflow resume ${rootRunId} && akm workflow run ${rootRunId}`,
          },
        }
      : {}),
    ...(children ? { children } : {}),
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
    // content) so `workflow run`/`status` show which native execution
    // invocation currently holds the run lease. Gated on `until` still being
    // in the future: a crashed engine's lease self-expires, and a run
    // whose holder is provably gone must stop reading as engine-driven the
    // instant that happens, not just once something next attempts to acquire
    // it (`readWorkflowRun`/`readWorkflowRunOrPrefix` also reclaim the DB
    // columns outright on the same condition).
    ...(run.engine_lease_holder && run.engine_lease_until && run.engine_lease_until >= new Date().toISOString()
      ? { engineLease: { holder: run.engine_lease_holder, until: run.engine_lease_until } }
      : {}),
    // P3b (spec §4.5): all three optional and conditionally spread, so every
    // pre-existing (non-child, no-outputs-declared) run's envelope is
    // byte-identical (Stable tier, rows B-27, B-45).
    ...(run.outputs_json ? { outputs: parseJsonObject(run.outputs_json) ?? {} } : {}),
    ...(run.parent_run_id ? { parentRunId: run.parent_run_id } : {}),
    ...(run.parent_unit_id ? { spawnedByUnitId: run.parent_unit_id } : {}),
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
  // #948 addendum: moved off UsageError (exit 75, not exit 2) — a held lease
  // is ordinary contention, not a bad command line.
  throw new TransientError(
    `Workflow run ${run.id} is being driven by engine ${run.engine_lease_holder} ` +
      `(run lease expires ${run.engine_lease_until}). The engine owns the step spine while it runs — ` +
      `wait for it to finish or for the lease to expire before advancing steps manually.`,
    "RUN_LEASE_HELD",
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
