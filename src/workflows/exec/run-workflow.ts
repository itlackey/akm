// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Engine-driven workflow execution — the `akm workflow run` start/resume/
 * execute path. akm walks the frozen plan (read from `plan_json`, never live
 * source) and dispatches every unit itself; every step advances through
 * `completeWorkflowStep`; one O_EXCL lock file per run keeps a second driver
 * off (a dead holder's lock is reclaimed); gate loops are bounded; and the
 * SDK dispatch registry is drained on every exit so the process can exit.
 * See docs/architecture/decisions/0011-engine-run-loop-invariants.md.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TransientError, UsageError } from "../../core/errors";
import { type LockOwnership, releaseLock } from "../../core/file-lock";
import { formatLockHolderPid, tryAcquireRunLock } from "../../core/run-lock";
import type { LoweringNotice } from "../../execution/resolved-request";
import { disposeDispatchResources } from "../../integrations/agent/runner-dispatch";
import type { WorkflowRunStepState, WorkflowRunSummary } from "../../sources/types";
import { resolveStorageLocations } from "../../storage/locations";
import { withWorkflowRunsConnection, withWorkflowRunsRepo } from "../../storage/repositories/workflow-runs-repository";
import type { WorkflowParameterFlag } from "../ir/params";
import { computePlanHash } from "../ir/plan-hash";
import type { WorkflowPlan, WorkflowPlanStep } from "../plan";
import { decodeWorkflowPlan, readRunPlan } from "../runtime/run-plan";
import {
  abandonWorkflowRun,
  completeWorkflowStep,
  getNextWorkflowStep,
  resumeWorkflowRun,
  type WorkflowNextResult,
} from "../runtime/runs";
import { loadWorkflowAsset } from "../runtime/workflow-asset-loader";
import type { SummaryJudge } from "../validate-summary";
import { frozenSummaryJudge } from "./frozen-judge";
import { mergeLoweringNotices } from "./lowering-notices";
import {
  defaultUnitDispatcher,
  executeStepPlan,
  type StepExecutionResult,
  type UnitDispatcher,
} from "./native-executor";
// Shared step semantics — route evaluation + cascaded-skip bookkeeping,
// gate-evaluation journaling, and the whole step-completion path
// (`finalizeExecutedStep`) live in step-work.ts as ONE implementation, so the
// fresh-execution and resume paths cannot drift from each other.
import {
  activeGateLoop,
  blockStepForJudgeFailure,
  cascadeSkippedRouter,
  effectiveGateMaxLoops,
  finalizeExecutedStep,
  type GateFeedback,
  type RouteSkipInfo,
  recoverGateFeedback,
  referencedStepIds,
  seedJournaledRouteDecisions,
} from "./step-work";

export interface RunWorkflowOptions {
  /** Workflow run id or workflow ref (auto-starts a run). */
  target: string;
  /** Params for an auto-started run. */
  params?: Record<string, unknown>;
  /** Raw exact-name parameter flags, materialized against the plan at start. */
  parameterFlags?: readonly WorkflowParameterFlag[];
  /**
   * Start a fresh run even when `target` (a workflow ref) already has an
   * active run in scope, instead of silently resuming it (#919's `--new`).
   * Leaves the existing active run untouched. A usage error when `target`
   * is a run id rather than a ref — there is nothing to be "new" about.
   */
  newRun?: boolean;
  /** Stop after this many steps (default: run to completion/gate/failure). */
  maxSteps?: number;
  /** Retry a failed step this many additional times. */
  maxRetries?: number;
  signal?: AbortSignal;
  /** Test seam / backend override for unit dispatch. */
  dispatcher?: UnitDispatcher;
  /**
   * Test seam: asserts the injected plan is the run row's frozen plan. The
   * frozen `plan_json` row is always what executes.
   */
  loadPlan?: (workflowRef: string) => Promise<WorkflowPlan>;
  /** Test seam for the engine concurrency cap. */
  maxConcurrency?: number;
  /**
   * Completion-criteria judge override, threaded into `completeWorkflowStep`
   * for every engine-driven completion. `undefined` (absent) = build the
   * default judge from the frozen plan; `null` is valid only for an ungated
   * step. Injected primarily for tests.
   */
  summaryJudge?: SummaryJudge | null;
  /**
   * Drains cached `opencode serve` child processes on every exit path — a live
   * child keeps the event loop open and would hang the CLI. Defaults to
   * {@link disposeDispatchResources}; injected by tests.
   */
  disposeDispatchResources?: () => void | Promise<void>;
  /**
   * The task runner's provenance event source, stamped as `AKM_EVENT_SOURCE`
   * into every unit's and the gate judge's child environment (an authored
   * `env:` binding still wins). Undefined for `akm workflow run` itself.
   */
  eventSource?: string;
}

export interface ExecutedStepReport {
  stepId: string;
  ok: boolean;
  unitCount: number;
  failedUnits: number;
  summary: string;
  /** Safe diagnostics observed while this live step attempt lowered work. */
  notices?: readonly Readonly<LoweringNotice>[];
}

export interface RunWorkflowResult {
  run: WorkflowRunSummary;
  executed: ExecutedStepReport[];
  /**
   * Distinct spine steps that FINISHED processing (completed, failed, or
   * gate-exhausted) across this call. This — not `executed.length`, which
   * gains one entry per gate-loop iteration and per route-skip — is what
   * `maxSteps` bounds: gate loops of one step count once, and route-skipped
   * steps consume nothing.
   */
  stepsProcessed: number;
  /** Present when the run reached completed state during this invocation. */
  done?: true;
  /** Present when a step summary was rejected by the completion-criteria gate. */
  gateRejection?: { stepId: string; missing: string[]; feedback: string };
  /**
   * Present when the verification judge FAILED (missing/unresolvable judge,
   * thrown judge call, or malformed verdict) — infrastructure, not a verdict.
   * No gate loop was consumed; the step and run are left `blocked`, and
   * `akm workflow resume` retries the gate over the journaled units.
   */
  judgeFailure?: { stepId: string; message: string };
  /**
   * Present when a composed child workflow is `blocked`: no gate loop was
   * consumed; resume the child first (`resume`), then re-drive the parent
   * (`resumeParentCommand`).
   */
  childBlocked?: { stepId: string; childRunId: string; childRef: string; resume: string; resumeParentCommand: string };
  /** Present when cooperative cancellation stopped before advancing the step. */
  aborted?: true;
  /**
   * Present when `target` (a workflow ref) resolved to an existing active
   * run instead of starting a new one (#919) — the #485 concurrency guard's
   * silent-resume behaviour, now visible. Absent when the run was freshly
   * started (including via `newRun`) or `target` was already a run id.
   */
  resumed?: true;
  /** Deduped safe diagnostics from work lowered during this invocation only. */
  notices?: readonly Readonly<LoweringNotice>[];
  /**
   * Non-fatal notices from THIS invocation: creating the run (the implicit
   * engine fallback announcement — never re-surfaced on a resume), resuming a
   * run whose authored source changed since it was frozen (the run continues
   * on the frozen plan), or abandoning a run whose frozen plan this akm can
   * no longer decode (the message names the recovery).
   */
  warnings?: string[];
}

export async function runWorkflowSteps(options: RunWorkflowOptions): Promise<RunWorkflowResult> {
  let target = options.target;
  let params = options.params;
  let parameterFlags = options.parameterFlags;
  // `--new` only applies to the FIRST resolution of `target` (a ref); every
  // retry re-targets the run id `startWorkflowRun` already created, so it is
  // cleared alongside `params`/`parameterFlags` below (#919).
  let newRun = options.newRun;
  let remainingRetries = options.maxRetries ?? 0;
  let remainingSteps = options.maxSteps;
  const executed: ExecutedStepReport[] = [];
  let stepsProcessed = 0;
  // Spans the retry loop: a retry re-opens only the ONE failed step, so every
  // step this call already completed keeps handing its complete artifact
  // downstream instead of falling back to the (possibly clipped) row. See the
  // {@link driveRun} declaration.
  const liveEvidence = new Map<string, Record<string, unknown>>();

  for (;;) {
    const result = await runWorkflowAttempt(
      {
        ...options,
        target,
        ...(params !== undefined ? { params } : { params: undefined }),
        ...(parameterFlags !== undefined ? { parameterFlags } : { parameterFlags: undefined }),
        newRun,
        ...(remainingSteps !== undefined ? { maxSteps: remainingSteps } : { maxSteps: undefined }),
      },
      liveEvidence,
    );
    executed.push(...result.executed);
    stepsProcessed += result.stepsProcessed;
    const notices = mergeLoweringNotices(...executed.map((step) => step.notices));
    const aggregate = { ...result, executed, stepsProcessed, ...(notices ? { notices } : {}) };
    // An attempt that executed nothing (an abandoned, undecodable plan) has no
    // failed step for a retry to re-open.
    if (
      result.run.status !== "failed" ||
      result.aborted ||
      result.gateRejection ||
      result.executed.length === 0 ||
      remainingRetries <= 0
    ) {
      return aggregate;
    }
    if (remainingSteps !== undefined) {
      // The step budget is DISTINCT PROCESSED STEPS, not `executed` entries:
      // gate loops of one step and route-skips must not shrink a retry's
      // remaining budget (they never counted against maxSteps either).
      remainingSteps -= result.stepsProcessed;
      if (remainingSteps <= 0) return aggregate;
    }
    await resumeWorkflowRun(result.run.id);
    target = result.run.id;
    params = undefined;
    parameterFlags = undefined;
    newRun = undefined;
    remainingRetries -= 1;
  }
}

async function runWorkflowAttempt(
  options: RunWorkflowOptions,
  liveEvidence: Map<string, Record<string, unknown>>,
): Promise<RunWorkflowResult> {
  const next: WorkflowNextResult = await getNextWorkflowStep(options.target, options.params, {
    parameterFlags: options.parameterFlags,
    newRun: options.newRun,
  });

  // Refuse non-active runs BEFORE any dispatch — completeWorkflowStep would
  // reject the completion anyway, but only after the units already ran (and
  // cost money). Mirror its preflight up front.
  if (!next.done && next.run.status !== "active") {
    throw new UsageError(
      `Workflow run ${next.run.id} is ${next.run.status} and cannot be executed. ` +
        `Use \`akm workflow resume ${next.run.id}\` to reopen it first.`,
    );
  }

  // One driver per run: the per-run lock file is taken BEFORE the plan is
  // read or anything dispatches, so a second `akm workflow run` on a run
  // another process is driving refuses up front (exit 75) instead of racing
  // its spine. A done run takes no lock: nothing will dispatch.
  const runId = next.run.id;
  const lock = next.done ? undefined : acquireWorkflowRunLock(runId);
  try {
    let plan: WorkflowPlan | undefined;
    const warnings: string[] = [...(next.startWarnings ?? [])];
    if (!next.done) {
      const row = await withWorkflowRunsRepo((repo) => repo.getRunById(runId));
      if (!row) throw new UsageError(`Workflow run ${runId} was not found.`);
      const read = readRunPlan(row);
      if (!read.ok) {
        // A newer akm's run is left untouched for that akm.
        if (read.newer) throw new UsageError(read.problem);
        // Otherwise a frozen plan this akm cannot decode is a status change,
        // not an exception: the run is abandoned and the message names how to
        // start afresh.
        const abandoned = await abandonWorkflowRun(runId);
        const message = `${read.problem} The run was abandoned; start a new run with 'akm workflow run ${row.workflow_ref}'.`;
        return {
          run: abandoned.run,
          executed: [],
          stepsProcessed: 0,
          warnings: [...warnings, message],
          ...(next.resumed ? { resumed: true as const } : {}),
        };
      }
      plan = read.plan;
      if (!next.autoStarted) {
        const drift = await workflowSourceDriftWarning(runId, row.workflow_ref, plan);
        if (drift) warnings.push(drift);
      }
    }
    // One state.db connection scope for the whole drive loop (the per-step
    // scopes nest into it); each `openStateDatabase` is not free.
    const result = await withWorkflowRunsConnection(() => driveRun(options, next, plan, liveEvidence));
    // Creation/resume-time notices reach the caller only here: the run row
    // has no warnings column, and a later invocation of the same run must
    // stay silent about a decision it did not make. `driveRun` never sets
    // `warnings` or `resumed` — both are properties of THIS resolution of
    // `target`, not of the run row (#919).
    return {
      ...result,
      ...(next.resumed ? { resumed: true as const } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } finally {
    try {
      if (lock) releaseLock(lock);
    } finally {
      // Process-lifecycle drain (owner finding 4): release any cached SDK server
      // child processes so a one-shot CLI invocation exits cleanly instead of
      // hanging on the leaked handle. Runs even if the lock release itself
      // fails; a teardown-time error must not skip dispatch cleanup.
      try {
        await (options.disposeDispatchResources ?? disposeDispatchResources)();
      } catch {
        /* disposal is best-effort; never let cleanup mask the run outcome */
      }
    }
  }
}

/** The per-run lock file: `<data dir>/workflow-run-locks/<run id>.lock`, next to `state.db`. */
export function workflowRunLockPath(runId: string): string {
  return path.join(path.dirname(resolveStorageLocations().stateDb), "workflow-run-locks", `${runId}.lock`);
}

/**
 * Take the run's O_EXCL lock file, or refuse with `RUN_LEASE_HELD` (exit 75)
 * naming the live holder. A lock whose holder pid is dead is reclaimed by
 * `tryAcquireRunLock` before this refuses, so a crashed engine never wedges
 * a run; nothing here expires by age.
 */
function acquireWorkflowRunLock(runId: string): LockOwnership {
  const result = tryAcquireRunLock(workflowRunLockPath(runId), { label: `workflow run ${runId}` });
  if (result.state === "acquired") return result.ownership;
  const since = result.holder.startedAt ? `, since ${result.holder.startedAt}` : "";
  throw new TransientError(
    `Workflow run ${runId} is already being driven by another akm process ` +
      `(pid ${formatLockHolderPid(result.holder)}${since}). A second \`akm workflow run\` would race it — ` +
      "wait for that invocation to finish.",
    "RUN_LEASE_HELD",
  );
}

/**
 * Resume re-reads the authored workflow source and says so, once, when it no
 * longer matches the bytes the plan was frozen from. The run keeps executing
 * the frozen plan either way — that is the whole safety the freeze buys — and
 * the warning tells the operator a fresh run is what picks up the edit.
 */
async function workflowSourceDriftWarning(
  runId: string,
  workflowRef: string,
  plan: WorkflowPlan,
): Promise<string | undefined> {
  if (!plan.sourceHash) return undefined;
  let sourcePath: string;
  try {
    sourcePath = (await loadWorkflowAsset(workflowRef)).path;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return (
      `Workflow run ${runId}: the authored source ${workflowRef} could not be re-read (${detail}); ` +
      "continuing with the frozen plan."
    );
  }
  let current: string;
  try {
    current = createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
  } catch {
    return `Workflow run ${runId}: ${sourcePath} is no longer readable; continuing with the frozen plan.`;
  }
  if (current === plan.sourceHash) return undefined;
  return (
    `Workflow run ${runId}: ${workflowRef} (${sourcePath}) has changed since this run was frozen; ` +
    `continuing with the frozen plan. Start a new run with 'akm workflow run ${workflowRef} --new' to pick up the edit.`
  );
}

/**
 * A terminal run is a pure no-op: do not load or integrity-check its frozen
 * plan, because post-completion plan corruption cannot change finished work.
 */
async function completedRunResult(runId: string): Promise<RunWorkflowResult> {
  const doneState = await getNextWorkflowStep(runId);
  return {
    run: doneState.run,
    executed: [],
    stepsProcessed: 0,
    ...(doneState.run.status === "completed" ? { done: true as const } : {}),
  };
}

function workflowSummaryJudge(
  options: RunWorkflowOptions,
  stepPlan: WorkflowPlanStep,
  signal: AbortSignal | undefined,
  owner: { runId: string; stepId: string },
): SummaryJudge | null {
  if (options.summaryJudge !== undefined) return options.summaryJudge;
  // The judge dispatches under the real run/step identity and the same event source as units.
  return frozenSummaryJudge(
    stepPlan.gate.frozenJudge,
    signal,
    options.dispatcher ?? defaultUnitDispatcher,
    owner,
    options.eventSource,
  );
}

/**
 * Seed the run's budget from the append-only attempt journal so a resumed run
 * does not restart it at zero: dispatch attempts count against `max_units`,
 * their tokens against `max_tokens`. Gate-evaluation rows are excluded, as the
 * live path never charges a judge call.
 */
async function seedRunAccountingFromJournal(runId: string): Promise<{ unitsDispatched: number; tokensUsed: number }> {
  const accounting = await withWorkflowRunsRepo((repo) => repo.getAttemptAccounting(runId));
  return {
    unitsDispatched: accounting.dispatchAttempts,
    tokensUsed: accounting.dispatchTokens,
  };
}

/**
 * The row plan is the sole execution authority. The loader seam may assert an
 * expected plan in tests, but can never replace it.
 */
async function loadAuthoritativeRunPlan(
  options: RunWorkflowOptions,
  next: WorkflowNextResult,
  stored: WorkflowPlan,
): Promise<WorkflowPlan> {
  if (options.loadPlan) {
    const expected = decodeWorkflowPlan(await options.loadPlan(next.run.workflowRef));
    if (computePlanHash(expected) !== computePlanHash(stored))
      throw new UsageError(`Injected workflow plan for run ${next.run.id} differs from its frozen plan.`);
  }
  return stored;
}

/**
 * Complete a branch target no completed router selected as `skipped` — no
 * dispatch, no gate loop, and (per the `maxSteps` contract) no step consumed.
 * Returns the re-read spine state so the caller can continue its walk.
 */
async function skipUnselectedRouteTarget(input: {
  runId: string;
  stepId: string;
  stepPlan: WorkflowPlanStep;
  skipInfo: RouteSkipInfo;
  routeUnselected: Map<string, RouteSkipInfo>;
  executed: ExecutedStepReport[];
}): Promise<WorkflowNextResult> {
  const { runId, stepId, stepPlan, skipInfo, routeUnselected, executed } = input;
  // Cascade: a skipped step that is ITSELF a router
  // never evaluates its route, so none of its declared targets were
  // selected — mark them all skip-on-reach too (a target another
  // completed router selects stays protected via routeSelected). Without
  // this, every branch of the skipped router would run unconditionally.
  if (stepPlan.route) {
    cascadeSkippedRouter(stepPlan.route, stepId, routeUnselected);
  }
  const notes =
    skipInfo.selected === null
      ? `Skipped by route: step "${skipInfo.router}" was itself skipped, so none of its branch targets run.`
      : `Skipped by route: step "${skipInfo.router}" selected "${skipInfo.selected}".`;
  executed.push({ stepId, ok: true, unitCount: 0, failedUnits: 0, summary: notes });
  await completeWorkflowStep({ runId, stepId, status: "skipped", notes });
  return getNextWorkflowStep(runId);
}

/**
 * Seed a step's starting gate loop and feedback from its journaled gate rows,
 * so a run interrupted after a rejection resumes at the next loop with the
 * stored feedback instead of re-judging loop 1. Reads only this step's rows.
 */
async function recoverGateLoopState(
  runId: string,
  stepPlan: WorkflowPlanStep,
): Promise<{ startLoop: number; seededFeedback: GateFeedback | undefined }> {
  // A step with no effective completion criteria never reaches a judge
  // (`validateStepSummary` short-circuits before the gate-journaling wrapper),
  // so it can have no gate rows and needs no query at all.
  if (!stepPlan.gate.criteria.some((criterion) => criterion.trim().length > 0)) {
    return { startLoop: 1, seededFeedback: undefined };
  }
  const stepId = stepPlan.stepId;
  const stepJournal = await withWorkflowRunsRepo((repo) => repo.getUnitsForStep(runId, stepId));
  const startLoop = activeGateLoop(stepJournal, stepId);
  return { startLoop, seededFeedback: recoverGateFeedback(stepJournal, stepId, startLoop) };
}

/** Everything the bounded gate loop needs about the ONE step it is driving. */
interface StepDriveContext {
  options: RunWorkflowOptions;
  next: WorkflowNextResult;
  plan: WorkflowPlan;
  stepPlan: WorkflowPlanStep;
  step: WorkflowRunStepState;
  /** Every prior step's evidence, keyed by step id (live values preferred over rows). */
  evidence: Record<string, Record<string, unknown> | undefined>;
  /**
   * The COMPLETE in-memory evidence of every step THIS call completed AND some
   * later step can still read, keyed by step id — written here as each step
   * advances and preferred over the re-read row when {@link driveRun} rebuilds
   * the downstream scope. See `driveRun`'s parameter docs for why the row alone
   * is not enough.
   */
  liveEvidence: Map<string, Record<string, unknown>>;
  /** Step ids some other step's `inputs[]` / `map.over` / `route.input` names. */
  liveEvidenceConsumers: ReadonlySet<string>;
  /** The run-wide report list — appended in place, one entry per loop iteration. */
  executed: ExecutedStepReport[];
  routeSelected: Set<string>;
  routeUnselected: Map<string, RouteSkipInfo>;
  summaryJudge: SummaryJudge | null;
}

/**
 * Outcome of one step's bounded gate loop. `kind` alone decides whether the
 * engine keeps walking (only `"advanced"`) and whether the step consumed its
 * `maxSteps` allowance ({@link STEP_FINISHED_KINDS}).
 */
interface StepGateLoopOutcome {
  kind: "advanced" | "failed" | "gate-exhausted" | "judge-failed" | "child-blocked" | "aborted";
  gateRejection?: RunWorkflowResult["gateRejection"];
  judgeFailure?: RunWorkflowResult["judgeFailure"];
  /**
   * a composed child workflow is blocked. Like `judgeFailure`, this
   * consumes no gate loop — see {@link STEP_FINISHED_KINDS}.
   */
  childBlocked?: RunWorkflowResult["childBlocked"];
  /** Running per-run dispatch/token totals, threaded back into the engine loop. */
  unitsDispatched: number;
  tokensUsed: number;
}

/**
 * The kinds that finished the step — its one `maxSteps` consumption. An abort,
 * a judge outage, and a blocked child consume nothing: the work is still owed.
 */
const STEP_FINISHED_KINDS: ReadonlySet<StepGateLoopOutcome["kind"]> = new Set(["advanced", "failed", "gate-exhausted"]);

/**
 * One attempt at a step's work. Route-only steps (YAML `route:` — no execution
 * subgraph) dispatch no units; they only decide the spine's path in
 * `finalizeExecutedStep`. Everything else executes its subgraph through the
 * native executor.
 */
async function executeStepSubgraph(
  ctx: StepDriveContext,
  loop: { gateLoop: number; gateFeedback: GateFeedback | undefined; unitsDispatched: number; tokensUsed: number },
): Promise<StepExecutionResult> {
  const { options, next, plan, stepPlan, step, evidence } = ctx;
  const { gateLoop, gateFeedback, unitsDispatched, tokensUsed } = loop;
  return !stepPlan.root && stepPlan.route
    ? {
        ok: true,
        units: [],
        evidence: {},
        summary: `Step "${step.id}" is a route step — no units dispatched.`,
        unitsDispatched,
      }
    : await executeStepPlan(stepPlan, {
        runId: next.run.id,
        workflowRef: next.run.workflowRef,
        params: next.run.params ?? {},
        evidence,
        unitsDispatched,
        tokensUsed,
        // Budget ceilings ride the FROZEN plan: a mid-run
        // asset edit can never loosen or tighten a run's budget.
        ...(plan.budget ? { budget: plan.budget } : {}),
        gateLoop,
        ...(gateFeedback ? { gateFeedback } : {}),
        // F-1: threaded to an exec unit's child env;
        // undefined for every non-task caller (byte-identical, RunWorkflowOptions doc).
        ...(options.eventSource !== undefined ? { eventSource: options.eventSource } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
        maxConcurrency: Math.min(
          options.maxConcurrency ?? Number.POSITIVE_INFINITY,
          plan.execution?.maxConcurrency ?? 1,
        ),
      });
}

/**
 * Drive one step's bounded gate loop: a rejection with loops left re-executes
 * the subgraph with the judge's feedback in the unit prompts. Returns the loop
 * decision and running budget totals; `ctx.executed` is appended in place.
 */
async function runStepGateLoop(
  ctx: StepDriveContext,
  gate: { startLoop: number; maxLoops: number; seededFeedback: GateFeedback | undefined },
  totals: { unitsDispatched: number; tokensUsed: number },
): Promise<StepGateLoopOutcome> {
  const { options, next, stepPlan, step, evidence, executed, routeSelected, routeUnselected } = ctx;
  const { summaryJudge } = ctx;
  const { startLoop, maxLoops } = gate;
  let { unitsDispatched, tokensUsed } = totals;
  let gateFeedback: GateFeedback | undefined = gate.seededFeedback;
  // Every exit carries the running totals back to the engine loop; naming the
  // kind is the whole decision an exit point has to make.
  const outcome = (rest: Omit<StepGateLoopOutcome, "unitsDispatched" | "tokensUsed">): StepGateLoopOutcome => ({
    ...rest,
    unitsDispatched,
    tokensUsed,
  });

  for (let gateLoop = startLoop; gateLoop <= maxLoops; gateLoop++) {
    const result = await executeStepSubgraph(ctx, { gateLoop, gateFeedback, unitsDispatched, tokensUsed });
    unitsDispatched = result.unitsDispatched;
    if (result.tokensUsed !== undefined) tokensUsed = result.tokensUsed;
    if (options.signal?.aborted) return outcome({ kind: "aborted" });

    executed.push({
      stepId: step.id,
      ok: result.ok,
      unitCount: result.units.length,
      failedUnits: result.units.filter((u) => !u.ok).length,
      summary: result.summary,
      ...(result.notices ? { notices: result.notices } : {}),
    });

    // Route, gate, and advance: the shared completion path, live or resumed.
    let finalize: Awaited<ReturnType<typeof finalizeExecutedStep>>;
    try {
      finalize = await finalizeExecutedStep({
        runId: next.run.id,
        workflowRef: next.run.workflowRef,
        stepId: step.id,
        stepPlan,
        completionCriteria: stepPlan.gate.criteria,
        gateLoop,
        loopsRemaining: gateLoop < maxLoops,
        result,
        priorEvidence: evidence,
        params: next.run.params ?? {},
        routeSelected,
        routeUnselected,
        summaryJudge,
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) return outcome({ kind: "aborted" });
      throw error;
    }

    if (finalize.kind === "retry") {
      // Re-execute the subgraph with the judge/validation feedback threaded
      // into unit prompts — the changed prompt changes each unit's input
      // hash, so the re-run dispatches fresh work instead of reusing rows.
      gateFeedback = finalize.gateFeedback;
      continue;
    }
    if (finalize.kind === "advanced") {
      // Keep the complete artifact for later steps of this invocation, but only
      // when some later reference can read it (`referencedStepIds`).
      if (ctx.liveEvidenceConsumers.has(step.id)) ctx.liveEvidence.set(step.id, result.evidence);
      // A route-only step's summary IS its decision (finalize surfaces it).
      if (finalize.summaryOverride !== undefined) {
        executed[executed.length - 1] = { ...executed[executed.length - 1]!, summary: finalize.summaryOverride };
      }
      return outcome({ kind: "advanced" });
    }
    if (finalize.kind === "judge-failed") {
      // Verifier infrastructure failure (thrown judge / malformed verdict /
      // missing judge): the step is blocked for resume, NO gate loop was
      // consumed, and the step does not count against maxSteps. Surface the
      // resume instruction in the step report so every output mode shows it.
      executed[executed.length - 1] = { ...executed[executed.length - 1]!, summary: finalize.summary };
      return outcome({ kind: "judge-failed", judgeFailure: { stepId: step.id, message: finalize.summary } });
    }
    if (finalize.kind === "child-blocked") {
      // a composed child workflow is blocked. Like judge-failed,
      // NO gate loop was consumed and the step does not count against
      // maxSteps. `result.childBlocked` (set by reduceStepOutcomes off the
      // failed unit's live-only childRun field) carries the identity
      // finalizeExecutedStep's own return value deliberately omits.
      executed[executed.length - 1] = { ...executed[executed.length - 1]!, summary: finalize.summary };
      const child = result.childBlocked;
      return outcome({
        kind: "child-blocked",
        ...(child
          ? {
              childBlocked: {
                stepId: step.id,
                childRunId: child.childRunId,
                childRef: child.childRef,
                resume: `akm workflow resume ${child.childRunId}`,
                resumeParentCommand: `akm workflow resume ${next.run.id} && akm workflow run ${next.run.id}`,
              },
            }
          : {}),
      });
    }
    if (finalize.kind === "failed") {
      // A route-failure was pushed as ok:true (the units succeeded); reflect
      // the deterministic route failure in the executed report.
      if (finalize.routeFailure) {
        executed[executed.length - 1] = { ...executed[executed.length - 1]!, ok: false, summary: finalize.summary };
      }
      return outcome({ kind: "failed" });
    }
    // gate-exhausted: rejected with no loop budget left — stop with feedback.
    return outcome({ kind: "gate-exhausted", gateRejection: finalize.gateRejection });
  }

  // Unreachable: `retry` is the ONLY path that continues the loop, and
  // `finalizeExecutedStep` returns it exclusively while `gateLoop < maxLoops`,
  // so the final iteration always exits through a terminal kind. Falling out
  // here would mean those two bounds disagree — a bug, not a run outcome.
  throw new Error(
    `Workflow run ${next.run.id} step "${step.id}" left its gate loop with no terminal outcome (loop bounds disagree).`,
  );
}

/** The engine loop proper — runs under the per-run lock `runWorkflowAttempt` holds. */
async function driveRun(
  options: RunWorkflowOptions,
  initial: WorkflowNextResult,
  /** The run row's decoded frozen plan; undefined only for a done run, which drives nothing. */
  storedPlan: WorkflowPlan | undefined,
  /**
   * In-memory evidence of steps this call completed that a later step reads,
   * preferred over re-parsing their rows (the values agree).
   */
  liveEvidence: Map<string, Record<string, unknown>>,
): Promise<RunWorkflowResult> {
  let next = initial;
  if (initial.done || !storedPlan) return completedRunResult(initial.run.id);

  const executed: ExecutedStepReport[] = [];
  let gateRejection: RunWorkflowResult["gateRejection"];
  let judgeFailure: RunWorkflowResult["judgeFailure"];
  let childBlocked: RunWorkflowResult["childBlocked"];
  let aborted = false;
  const maxSteps = options.maxSteps ?? Number.POSITIVE_INFINITY;
  // The `maxSteps` budget counts DISTINCT spine steps that finished processing
  // — never `executed.length`, which grows once per gate-loop iteration and
  // once per route-skip. A step's whole bounded gate loop consumes ONE step;
  // a route-skipped step consumes NOTHING (no work was dispatched for it).
  let stepsProcessed = 0;

  let { unitsDispatched, tokensUsed } = await seedRunAccountingFromJournal(next.run.id);

  const plan = await loadAuthoritativeRunPlan(options, next, storedPlan);

  // Live-evidence retention is decided at SET time, from the frozen plan alone:
  // a completed step's complete artifact is held only while some other step's
  // references can still read it. An exec unit's promoted stdout can be 8 MiB,
  // and holding every step's for the whole invocation is pure ballast when
  // nothing downstream names it.
  const liveEvidenceConsumers = referencedStepIds(plan);

  // Route bookkeeping: targets a completed router did NOT select are skipped
  // when the spine reaches them; a target ANY router selected is protected
  // (two routers may share a target).
  const routeSelected = new Set<string>();
  const routeUnselected = new Map<string, RouteSkipInfo>();

  // Replay journaled route decisions before the spine advances, so a
  // re-invoked run skips the unselected branches. A done run skips this.
  if (!next.done) {
    seedJournaledRouteDecisions(plan, next, routeSelected, routeUnselected);
  }

  while (!next.done && next.step && next.run.status === "active" && stepsProcessed < maxSteps) {
    // A caller abort (options.signal) is a graceful break.
    if (options.signal?.aborted) {
      aborted = true;
      break;
    }
    const step = next.step;
    const stepPlan = plan.steps.find((s) => s.stepId === step.id);
    if (!stepPlan) {
      throw new UsageError(
        `Step "${step.id}" of run ${next.run.id} is not present in its frozen workflow plan (${next.run.workflowRef}). ` +
          "The run journal is inconsistent; abandon this run and start a new one.",
      );
    }

    // A branch target no completed router selected → auto-skip, no dispatch.
    const skipInfo = routeUnselected.get(step.id);
    if (skipInfo && !routeSelected.has(step.id)) {
      next = await skipUnselectedRouteTarget({
        runId: next.run.id,
        stepId: step.id,
        stepPlan,
        skipInfo,
        routeUnselected,
        executed,
      });
      continue;
    }

    const evidence: Record<string, Record<string, unknown> | undefined> = {};
    for (const s of next.workflow.steps) evidence[s.id] = liveEvidence.get(s.id) ?? s.evidence;

    // Bounded gate loop: loop 1 is the normal
    // execution; a gate rejection with attempts left re-executes the subgraph
    // with the judge's feedback threaded into unit prompts. The bound comes
    // from the shared derivation, which holds an exec step to a single
    // execution — its argv cannot answer feedback (see effectiveGateMaxLoops).
    const maxLoops = effectiveGateMaxLoops(stepPlan);

    const { startLoop, seededFeedback } = await recoverGateLoopState(next.run.id, stepPlan);

    // Resumed after the final rejection: reproduce the gate-exhausted outcome
    // from the stored feedback instead of running an extra loop.
    if (startLoop > maxLoops) {
      gateRejection = {
        stepId: step.id,
        missing: seededFeedback?.missing ?? [],
        feedback: seededFeedback?.feedback ?? "",
      };
      break;
    }

    // Judge-outage contract: resolve the step's frozen completion judge BEFORE
    // any dispatch. An unresolvable judge (missing frozen engine, no dispatcher
    // for an agent judge) is verifier INFRASTRUCTURE failure — block the step
    // for `akm workflow resume` instead of spending on units the gate can never
    // verify. No gate loop is consumed and nothing is dispatched.
    let summaryJudge: SummaryJudge | null;
    try {
      summaryJudge = workflowSummaryJudge(options, stepPlan, options.signal, {
        runId: next.run.id,
        stepId: step.id,
      });
    } catch (error) {
      const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
      // Nothing was dispatched, so there is no evidence to preserve — the same
      // blocked write the post-execution path uses, minus the results it does
      // not have.
      const notes = await blockStepForJudgeFailure({
        runId: next.run.id,
        stepId: step.id,
        cause: `the verification judge could not be resolved from the frozen plan${detail}`,
      });
      executed.push({ stepId: step.id, ok: false, unitCount: 0, failedUnits: 0, summary: notes });
      judgeFailure = { stepId: step.id, message: notes };
      break;
    }

    const outcome = await runStepGateLoop(
      {
        options,
        next,
        plan,
        stepPlan,
        step,
        evidence,
        liveEvidence,
        liveEvidenceConsumers,
        executed,
        routeSelected,
        routeUnselected,
        summaryJudge,
      },
      { startLoop, maxLoops, seededFeedback },
      { unitsDispatched, tokensUsed },
    );
    unitsDispatched = outcome.unitsDispatched;
    tokensUsed = outcome.tokensUsed;
    if (outcome.kind === "aborted") aborted = true;
    if (outcome.gateRejection) gateRejection = outcome.gateRejection;
    if (outcome.judgeFailure) judgeFailure = outcome.judgeFailure;
    if (outcome.childBlocked) childBlocked = outcome.childBlocked;

    if (STEP_FINISHED_KINDS.has(outcome.kind)) stepsProcessed += 1;
    // Only an advance leaves the spine walkable; every other kind ends this
    // invocation (failure, exhausted gate, judge outage, blocked child, abort).
    if (outcome.kind !== "advanced") break;

    next = await getNextWorkflowStep(next.run.id);
  }

  // Re-read for the freshest run state (the loop may have exited on maxSteps).
  const finalState = await getNextWorkflowStep(next.run.id);
  const notices = mergeLoweringNotices(...executed.map((step) => step.notices));
  return {
    run: finalState.run,
    executed,
    stepsProcessed,
    ...(notices ? { notices } : {}),
    ...(finalState.run.status === "completed" ? { done: true as const } : {}),
    ...(gateRejection ? { gateRejection } : {}),
    ...(judgeFailure ? { judgeFailure } : {}),
    ...(childBlocked ? { childBlocked } : {}),
    ...(aborted ? { aborted: true as const } : {}),
  };
}
