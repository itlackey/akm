// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { randomUUID } from "node:crypto";
import { parseAssetRef } from "../../core/asset/asset-ref";
import { canonicalizeWorkflowName } from "../../core/asset/asset-spec";
import { getDefaultLlmConfig, loadConfig } from "../../core/config/config";
import { NotFoundError, UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { warn } from "../../core/warn";
import type {
  WorkflowRunStatus,
  WorkflowRunStepState,
  WorkflowRunStepStatus,
  WorkflowRunSummary,
} from "../../sources/types";
import {
  type WorkflowRunRow,
  type WorkflowRunStepRow,
  type WorkflowRunsRepository,
  type WorkflowRunUnitRow,
  type WorkflowRunUnitStatus,
  withWorkflowRunsRepo,
} from "../../storage/repositories/workflow-runs-repository";
import { getCurrentWorkflowScopeKey } from "../authoring/scope-key";
import { detectSecretShapedParams } from "../exec/param-secrets";
import { collectProgramWarnings } from "../ir/compile";
import { compileResolveFreezeWorkflow } from "../ir/freeze";
import { validateWorkflowParams } from "../ir/params";
import { canonicalPlanJson, computePlanHash } from "../ir/plan-hash";
import { type SummaryJudge, validateStepSummary } from "../validate-summary";
import { resolveAgentIdentity } from "./agent-identity";
import { type CheckinDirective, evaluateCheckin } from "./checkin";
import { classifyWorkflowRunPlan, requireExecutableWorkflowPlan } from "./plan-classifier";
import { evaluateStaleUnits, type StaleUnit } from "./unit-checkin";
import { loadWorkflowAsset, resolveWorkflowEntryId } from "./workflow-asset-loader";

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
   * so a credential-looking param value is flagged loudly here and in `brief`.
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
   * window — a driver that claimed the unit with `report --status running` and
   * then died (Codex round-3 finding B). `status --units` runs the SAME pure
   * {@link evaluateStaleUnits} pass `brief` uses so the two surfaces agree.
   */
  stale: boolean;
  /** Idle ms since the last heartbeat / first claim when the row is stale; null otherwise. */
  staleIdleMs: number | null;
  /** The driver holding a `running` claim (migration 009); null when unclaimed. */
  claimHolder: string | null;
  /** When the `running` claim expires; null when unclaimed. */
  claimExpiresAt: string | null;
  engine: string | null;
  /** Planned resolved runtime kind on v3 rows, never inferred for history. */
  runtimeKind: "llm" | "agent" | "sdk" | null;
  legacyRunnerSelector?: string | null;
}

/** Clip bound for a unit's `result_json` on the `--units` diagnostic surface. */
const UNIT_DIAGNOSTIC_CLIP = 2000;

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
    ...(!row.engine && row.runner ? { legacyRunnerSelector: row.runner } : {}),
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
  /**
   * Internal (engine only): the run-lease holder id of the `akm workflow run`
   * invocation making this call. While a LIVE lease is held, only its holder
   * may advance the spine — the engine owns the run while driving it. The
   * manual CLI path never sets this, so `akm workflow complete` is refused
   * until the lease is released or expires (R2 single-driver enforcement).
   */
  leaseHolder?: string;
  /**
   * Engine/report finalize only (Codex round-3 finding A): this completion's gate
   * is REQUIRED. A required gate whose judge cannot produce a verdict (throws /
   * unreachable / unparseable) must NOT fail open — {@link validateStepSummary}
   * flags it `errored` and the returned {@link SummaryValidationFailure} carries
   * `errored: true`, so `finalizeExecutedStep` BLOCKS the step instead of
   * advancing. The manual `akm workflow complete` path never sets this, so its
   * fail-open behavior is unchanged.
   */
  requireGate?: boolean;
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
  /**
   * Set when a REQUIRED gate could not be judged (Codex round-3 finding A): the
   * judge threw / was unreachable / returned an unparseable verdict. The caller
   * (`finalizeExecutedStep`) BLOCKS the step rather than treating this as a
   * normal (retryable) gate rejection.
   */
  errored?: true;
}

export async function startWorkflowRun(
  ref: string,
  params: Record<string, unknown> = {},
  options?: { force?: boolean; agentHarness?: string | null; agentSessionId?: string | null },
): Promise<WorkflowRunDetail> {
  const asset = await loadWorkflowAsset(ref);
  // Frozen plan (redesign addendum, R1): compile the plan ONCE at start and
  // persist it on the run row in the same transaction as the insert. Every
  // later invocation executes this snapshot — the asset file is never re-read
  // for an in-flight run; re-planning is an explicit new run.
  const plan = compileResolveFreezeWorkflow(asset, loadConfig()).plan;
  // Non-fatal WARNINGS (redesign addendum): a YAML program's untyped-step and
  // undeclared-param advisories surface as `warn()` lines at start (stderr,
  // consistent with the repo's other author-facing warnings) without blocking
  // the run. Markdown workflows carry no `program` and warn about nothing.
  if (asset.program) {
    for (const w of collectProgramWarnings(asset.program)) {
      warn(`workflow start: ${asset.path}:${w.line} — ${w.message}`);
    }
  }
  // Reviewer #12: validate supplied `--params` against the frozen param
  // schemas BEFORE creating the run, so a type-mismatched param (e.g. a string
  // for a `{ type: array }` param) is rejected with actionable errors instead
  // of flowing silently into a unit prompt. Programs without declared param
  // schemas (and every Markdown workflow) validate trivially.
  const paramErrors = validateWorkflowParams(plan, params);
  if (paramErrors.length > 0) {
    throw new UsageError(
      `Cannot start ${asset.ref}: the supplied --params do not satisfy the workflow's declared parameter schemas:\n` +
        paramErrors.map((e) => `  - ${e}`).join("\n"),
      "INVALID_JSON_ARGUMENT",
    );
  }
  const planJson = canonicalPlanJson(plan);
  const planHash = computePlanHash(plan);
  return withWorkflowRunsRepo(async (repo) => {
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
      const existing = repo.findActiveRunForScope(asset.ref, scopeKey);
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

    repo.transaction(() => {
      repo.insertRun({
        id: runId,
        workflowRef: asset.ref,
        scopeKey,
        workflowEntryId,
        workflowTitle: asset.title,
        paramsJson: JSON.stringify(params),
        currentStepId,
        createdAt: now,
        updatedAt: now,
        agentHarness,
        agentSessionId,
        checkinArmedAt: now,
      });

      repo.insertSteps(
        asset.steps.map((step) => ({
          runId,
          stepId: step.id,
          stepTitle: step.title,
          instructions: step.instructions,
          completionJson: step.completionCriteria ? JSON.stringify(step.completionCriteria) : null,
          sequenceIndex: step.sequenceIndex ?? 0,
        })),
      );

      // Same transaction as the insert: a run row never exists without its
      // frozen plan (rows with NULL plan_json are pre-006 legacy runs).
      repo.setRunPlan(runId, planJson, planHash, 3);
    });

    const result = await getWorkflowStatus(runId);
    // #13: params are declared non-secret (they are copied verbatim into every
    // unit prompt and hashed into the unit identity, so they cannot be redacted
    // without breaking the driver protocol). Surface a loud, best-effort warning
    // when a param LOOKS like a credential so the author moves it to an env
    // binding. Advisory only — never blocks the start.
    const secretWarnings = detectSecretShapedParams(params);
    if (secretWarnings.length > 0) result.warnings = [...(result.warnings ?? []), ...secretWarnings];
    // 07 P1-B: emit only the run id + status — NOT the raw workflowTitle (which
    // comes verbatim from the workflow asset's frontmatter and is therefore
    // attacker-influenceable). Keeping raw titles out of the events stream
    // shrinks the injectable footprint for any consumer that re-surfaces events
    // into agent context.
    appendEvent({
      eventType: "workflow_started",
      ref: ref,
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
      // Codex round-3 finding B: run the SAME pure stale-claim evaluator `brief`
      // uses (`now` injected for deterministic tests) so a dead driver's claimed
      // `running` unit surfaces as stale here too, not just as raw `running`.
      const staleById = new Map(evaluateStaleUnits(rows, opts.now ?? Date.now()).map((u) => [u.unitId, u]));
      detail.units = rows.map((row) => toUnitDiagnostic(row, staleById.get(row.unit_id)));
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
  return withWorkflowRunsRepo((repo) => {
    const scopeKey = getCurrentWorkflowScopeKey();
    let workflowRef: string | undefined;
    if (input?.workflowRef) {
      const parsed = parseAssetRef(input.workflowRef);
      if (parsed.type !== "workflow") {
        throw new UsageError(`Expected a workflow ref (workflow:<name>), got "${input.workflowRef}".`);
      }
      workflowRef = `${parsed.origin ? `${parsed.origin}//` : ""}workflow:${canonicalizeWorkflowName(parsed.name)}`;
    }
    const rows = repo.listRuns({
      scopeKey,
      ...(workflowRef ? { workflowRef } : {}),
      ...(input?.activeOnly ? { activeOnly: true } : {}),
    });
    return { runs: rows.map(toWorkflowRunSummary) };
  });
}

export async function getNextWorkflowStep(
  specifier: string,
  params?: Record<string, unknown>,
): Promise<WorkflowNextResult> {
  return withWorkflowRunsRepo(async (repo) => {
    const { run, autoStarted } = await resolveRunSpecifier(repo, specifier, params);
    requireExecutableWorkflowPlan(run);
    const steps = readWorkflowRunSteps(repo, run.id);
    return { ...projectNextResult(run, steps), ...(autoStarted ? { autoStarted: true as const } : {}) };
  });
}

/**
 * Project a run row + its step rows into a {@link WorkflowNextResult}. The pure
 * read-shaping half of {@link getNextWorkflowStep}, extracted so the driver
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

/**
 * A consistent point-in-time snapshot of a run for the harness-neutral driver
 * protocol (PR #714 review round 2, #14). `brief`/`report` previously read the
 * spine (`getNextWorkflowStep`) and then, in a SEPARATE connection, the run row
 * + unit journal — so a concurrent `report`/`run`/manual completion could change
 * the active step BETWEEN the two reads, leaving the described work-list
 * inconsistent with the run row it was stamped against. This reads the run row,
 * its steps, AND its unit rows inside ONE transaction (one connection, one
 * snapshot) so all three agree. It never auto-starts — `runId` must already
 * resolve to a concrete run — because the driver protocol never mutates on read.
 */
export async function snapshotRunForDriver(runId: string): Promise<{
  next: WorkflowNextResult;
  run: WorkflowRunRow;
  units: WorkflowRunUnitRow[];
}> {
  return withWorkflowRunsRepo((repo) =>
    repo.transaction(() => {
      const run = readWorkflowRun(repo, runId);
      const steps = readWorkflowRunSteps(repo, run.id);
      const units = repo.getUnitsForRun(run.id);
      return { next: projectNextResult(run, steps), run, units };
    }),
  );
}

export async function resumeWorkflowRun(runId: string): Promise<WorkflowRunDetail> {
  return withWorkflowRunsRepo((repo) => {
    const run = readWorkflowRun(repo, runId);
    requireExecutableWorkflowPlan(run);
    if (run.status === "completed") {
      throw new UsageError(`Workflow run ${run.id} is already completed and cannot be resumed.`);
    }
    if (run.status === "active") {
      const steps = readWorkflowRunSteps(repo, run.id);
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
    const steps = readWorkflowRunSteps(repo, run.id);
    return buildWorkflowRunDetail(updated, steps);
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
    const run = readWorkflowRun(repo, runId);
    if (run.status === "completed" || run.status === "failed") {
      throw new UsageError(`Workflow run ${run.id} is already ${run.status}.`);
    }
    const now = new Date().toISOString();
    repo.updateRunState({
      status: "failed",
      currentStepId: run.current_step_id,
      updatedAt: now,
      completedAt: now,
      checkinArmedAt: now,
      runId: run.id,
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
    // Same injectable-footprint rule as workflow_started (07 P1-B): ids and
    // status only, never the frontmatter-derived title.
    appendEvent({ eventType: "workflow_abandoned", ref: run.workflow_ref, metadata: { runId: run.id } });
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
    requireExecutableWorkflowPlan(run);
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
      { required: input.requireGate === true },
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
        // A REQUIRED gate that could not be judged (finding A): the caller BLOCKS
        // rather than treating this as a normal, retryable gate rejection.
        ...(verdict.errored ? { errored: true as const } : {}),
      };
    }
  }

  return withWorkflowRunsRepo((repo) => {
    let updatedRun: WorkflowRunRow | undefined;
    let refreshedSteps: WorkflowRunStepRow[] = [];

    repo.transaction(() => {
      const run = readWorkflowRun(repo, input.runId);
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

      const completedAt = new Date().toISOString();
      repo.updateStepCompletion({
        status: input.status,
        notes: input.notes?.trim() || null,
        evidenceJson: input.evidence ? JSON.stringify(input.evidence) : null,
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
): Promise<{ run: WorkflowRunRow; autoStarted: boolean }> {
  const explicitRun = repo.getRunById(specifier);
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
  const ref = `${parsed.origin ? `${parsed.origin}//` : ""}workflow:${canonicalizeWorkflowName(parsed.name)}`;
  const scopeKey = getCurrentWorkflowScopeKey();
  const active = repo.getActiveRunRowForScope(ref, scopeKey);
  if (active) {
    if (params && Object.keys(params).length > 0) {
      throw new UsageError(`--params can only be set on a new run; ${ref} already has an active run`);
    }
    return { run: active, autoStarted: false };
  }

  const started = await startWorkflowRun(ref, params ?? {});
  return { run: readWorkflowRun(repo, started.run.id), autoStarted: true };
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
  // evaluates the check-in, not just `workflow next`. Pure timestamp check —
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
    // content) so `workflow next`/`status` show who is driving the run.
    ...(run.engine_lease_holder && run.engine_lease_until
      ? { engineLease: { holder: run.engine_lease_holder, until: run.engine_lease_until } }
      : {}),
  };
}

/**
 * Single-driver enforcement (R2 run lease): while a LIVE (unexpired) engine
 * lease is held, only the holding engine may advance the gate spine. Manual
 * `akm workflow complete` (no `leaseHolder`) — or a stale engine invocation
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

/**
 * Build the default summary-validation judge from the configured LLM, or return
 * `null` when no LLM is configured (gate is then skipped — fail-open). Lazily
 * imports the client/config so the workflow engine has no hard LLM dependency.
 *
 * Exported for the engine loop (`exec/run-workflow.ts`), which wraps the judge
 * to journal engine-driven gate evaluations as unit rows (addendum R2).
 */
export function buildDefaultSummaryJudge(): SummaryJudge | null {
  let llm: import("../../core/config/config").LlmConnectionConfig | undefined;
  try {
    const config = loadConfig();
    llm = getDefaultLlmConfig(config);
  } catch {
    return null;
  }
  if (!llm) return null;
  const resolved = llm;
  return async ({ system, user }) => {
    const { chatCompletion } = await import("../../llm/client");
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
  return withWorkflowRunsRepo((repo) => {
    const row = repo.findActiveOrBlockedRunForScope(scopeKey);
    if (!row) return null;
    return { runId: row.id, stepId: row.current_step_id, workflowRef: row.workflow_ref };
  }).catch(() => null); // fail-open: never crash show output due to DB error
}
