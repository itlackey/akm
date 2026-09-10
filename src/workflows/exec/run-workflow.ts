// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Engine-driven workflow execution — the `akm workflow run`
 * start/resume/execute path, and the single execution surface for a run: akm
 * walks the frozen plan and dispatches every unit itself. Every step
 * advances through `completeWorkflowStep` (never a direct step-row write),
 * the plan is read from its frozen `plan_json` row rather than live source,
 * a run lease enforces one driving engine invocation at a time, gate loops
 * are bounded, and the SDK dispatch registry is drained in a `finally` on
 * every exit path so no child process keeps the event loop open.
 *
 * See docs/architecture/decisions/0011-engine-run-loop-invariants.md for the
 * full design history behind each of these invariants.
 */

import { randomUUID } from "node:crypto";
import { TransientError, UsageError } from "../../core/errors";
import { withMaintenanceStartBarrierAsync } from "../../core/maintenance-barrier";
import type { LoweringNotice } from "../../execution/resolved-request";
import { disposeDispatchResources } from "../../integrations/agent/runner-dispatch";
import type { WorkflowRunStepState, WorkflowRunSummary } from "../../sources/types";
import { withWorkflowRunsConnection, withWorkflowRunsRepo } from "../../storage/repositories/workflow-runs-repository";
import { assertRunParamsSatisfyPlan, type WorkflowParameterFlag } from "../ir/params";
import { computePlanHash } from "../ir/plan-hash";
import { decodeWorkflowPlanV4, type IrStepPlanV4, type WorkflowPlanGraphV4 } from "../ir/schema-v4";
import { requireExecutableWorkflowPlan } from "../runtime/plan-classifier";
import { completeWorkflowStep, getNextWorkflowStep, resumeWorkflowRun, type WorkflowNextResult } from "../runtime/runs";
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
   * Test seam: plan loader. Default: the run row's FROZEN plan (`plan_json`
   * + `plan_hash` integrity check, migration 006).
   */
  loadPlan?: (workflowRef: string) => Promise<WorkflowPlanGraphV4>;
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
   * Test seam: schedules the lease-heartbeat's periodic renewal tick while a
   * step dispatches. Receives the (async) tick fn, returns a stop function
   * called in the `finally`. Defaults to a `setInterval` at
   * {@link HEARTBEAT_INTERVAL_MS} (unref'd so it never keeps the process
   * alive). Injected by tests to drive ticks deterministically.
   */
  heartbeatScheduler?: HeartbeatScheduler;
  /**
   * Process-lifecycle disposal seam (owner finding 4 — leaked dispatch
   * handles). The SDK dispatch path caches `opencode serve` CHILD PROCESSES in
   * a per-env registry for reuse across units; each live child is an OS handle
   * that keeps Bun's event loop open, and the registry's own teardown is wired
   * only to `process.once('exit')`, which NEVER fires while a child holds the
   * loop open (a deadlock that hangs the CLI after an otherwise-successful run).
   * The engine therefore DRAINS the registry in its `finally` — on EVERY exit
   * path (success, gate rejection, failure, abort) — so the process can exit
   * cleanly instead of waiting out the caller's tool timeout. Defaults to
   * {@link disposeDispatchResources} (a synchronous, idempotent close that is a
   * no-op when no SDK server was ever started, so the agent/llm paths pay
   * nothing). Injected by tests to assert the drain fires on each path.
   */
  disposeDispatchResources?: () => void | Promise<void>;
  /**
   * F-1 (spec docs/plans/specs/p1b-model-extraction.md §5.2 point 2): the
   * task runner's resolved provenance event source, threaded here instead of
   * the removed global `process.env.AKM_EVENT_SOURCE` stamp
   * (src/tasks/run/run-workflow-task.ts). Optional and undefined for every
   * non-task caller (`akm workflow run` and its tests), so their behavior is
   * byte-identical. When present, it reaches an exec unit's child env via
   * native-executor.ts's `StepExecutionContext.eventSource` ->
   * unit-dispatch.ts's `UnitDispatchRequest.eventSource` -> exec-unit.ts's
   * `childEnv` for a "script"/"shell" unit — applied to the allowlisted BASE
   * only, so an ambient value already present and an authored `env:` binding
   * both still win — and via the same `UnitDispatchRequest.eventSource` ->
   * `dispatchWorkflowExecution`'s `dispatchLoweredExecutionRequest`
   * `eventSource` option (execution-lowering.ts's single-key child-env
   * layering) for a "command" unit, so the agent/sdk arms observe it too —
   * gated the same way there (precedence fix, code review round 2; see
   * unit-dispatch.ts's `forwardedDispatchEventSource`): an authored `env:`
   * binding on the unit still wins, in agreement with the script/shell arm
   * above. Also threaded into the step's completion-criteria judge dispatch
   * (`workflowSummaryJudge` -> `frozen-judge.ts`'s `frozenSummaryJudge`, gap
   * closed — code review): the judge is a "command"-kind dispatch too, so
   * without this it was the one dispatch on a task-run's path that silently
   * kept losing the provenance stamp the pre-P1b global env mutation used to
   * give it. Typed as a bare `string` (not `UsageEventSource`) — like the native arm's own
   * `process.env.AKM_EVENT_SOURCE ?? provenance.eventSource`, this is an
   * unvalidated raw value destined straight for a child env var, not a value
   * checked against the `UsageEventSource` enum.
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
   * Present when a composed child workflow is `blocked` (P3b, spec
   * docs/plans/specs/p3b-child-executor.md §3.4). Like `judgeFailure`, no
   * gate loop was consumed; the step and run are left `blocked` — but the
   * child must be resumed FIRST (`resume`), then the parent
   * (`resumeParentCommand`), since re-driving the parent is what advances
   * the resumed child (row A-22: the child drive never calls
   * `resumeWorkflowRun` itself). Named `resumeParentCommand`, not `then`
   * (lint/style/noThenProperty — a `then` property risks being treated as
   * a thenable by `await`).
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
   * Non-fatal notices from creating the run in THIS invocation — currently the
   * implicit engine fallback announcement. Absent when the run already existed,
   * so a resume never re-announces it.
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
    if (result.run.status !== "failed" || result.aborted || result.gateRejection || remainingRetries <= 0) {
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
  // Version/canonical/hash validation precedes every executable mutation,
  // including lease acquisition. Historical rows remain inspectable/abandonable.
  if (!next.done) {
    await withWorkflowRunsRepo((repo) => {
      const row = repo.getRunById(next.run.id);
      if (!row) throw new UsageError(`Workflow run ${next.run.id} was not found.`);
      requireExecutableWorkflowPlan(row);
    });
  }

  // Refuse non-active runs BEFORE any dispatch — completeWorkflowStep would
  // reject the completion anyway, but only after the units already ran (and
  // cost money). Mirror its preflight up front.
  if (!next.done && next.run.status !== "active") {
    throw new UsageError(
      `Workflow run ${next.run.id} is ${next.run.status} and cannot be executed. ` +
        `Use \`akm workflow resume ${next.run.id}\` to reopen it first.`,
    );
  }

  // Run lease (R2 single-driver enforcement): claim the run BEFORE any
  // dispatch — a second `akm workflow run` on a live-leased run refuses up
  // front instead of racing the first engine's spine. An expired lease is
  // claimable (crash recovery). Released in the finally below; renewed
  // between steps inside the loop. A done run takes no lease: nothing will
  // dispatch, and the status re-read below must stay a pure no-op.
  const runId = next.run.id;
  const leaseHolder = randomUUID();
  const leased = !next.done;
  if (leased) {
    await acquireRunLease(runId, leaseHolder);
  }
  // Lease heartbeat (P1 fix): the lease TTL is renewed BETWEEN steps, but a
  // single unit's dispatch can outlive the TTL (the default unit timeout is 10
  // minutes, > the 90s lease). An unheartbeated lease would silently expire
  // mid-dispatch, letting a second `akm workflow run` claim the run and
  // re-dispatch the same units — the two engines clobber each other's journal
  // rows and double-run side effects. A timer INSIDE this invocation renews the
  // lease while dispatch is in flight; it is cleared in the `finally`, so it
  // dies with the process — exactly when the lease SHOULD become claimable
  // after TTL. A renewal that fails (the lease was genuinely stolen after an
  // expiry, e.g. the process was suspended) aborts dispatch and fails the run
  // loudly rather than keep double-driving.
  const heartbeat = leased
    ? new LeaseHeartbeat(runId, leaseHolder, options.heartbeatScheduler, options.signal)
    : undefined;
  heartbeat?.start();
  try {
    // Run-wide state.db connection scope: `executeStepPlan` already opens one
    // per STEP, so widening it to the whole drive loop additionally folds the
    // spine writes (`completeWorkflowStep`), the per-step lease renewals, the
    // journal reads, and `finalizeExecutedStep`'s gate-row journaling onto that
    // one handle — `openStateDatabase` costs a maintenance-activity lockfile
    // plus a read-only ledger preflight on EVERY call. Nesting is an idempotent
    // join (`core/state-db-scope.ts`): the inner per-step scope reuses this
    // handle and does not close it, and this scope's own `finally` closes on
    // every exit path (return, throw, abort), after which escaped async work
    // transparently falls back to opening its own connection.
    const result = await withWorkflowRunsConnection(() =>
      driveRun(options, next, leaseHolder, heartbeat, liveEvidence),
    );
    // Creation-time notices reach the caller only here: the run row has no
    // warnings column, and a later invocation of the same run must stay silent
    // about a decision it did not make. `driveRun` never sets `warnings` or
    // `resumed` — both are properties of THIS resolution of `target`, not of
    // the run row (#919).
    return {
      ...result,
      ...(next.resumed ? { resumed: true as const } : {}),
      ...(next.startWarnings?.length ? { warnings: next.startWarnings } : {}),
    };
  } finally {
    heartbeat?.stop();
    try {
      if (leased) {
        await withWorkflowRunsRepo((repo) => {
          repo.releaseEngineLease(runId, leaseHolder);
        });
      }
    } finally {
      // Process-lifecycle drain (owner finding 4): release any cached SDK server
      // child processes so a one-shot CLI invocation exits cleanly instead of
      // hanging on the leaked handle. Runs even if lease release itself fails;
      // a teardown-time repository error must not skip dispatch cleanup.
      try {
        await (options.disposeDispatchResources ?? disposeDispatchResources)();
      } catch {
        /* disposal is best-effort; never let cleanup mask the run outcome */
      }
    }
  }
}

/** Lease lifetime: long enough to survive slow steps between renewals, short
 * enough that a crashed engine frees the run quickly. Renewed per step. */
const RUN_LEASE_TTL_MS = 90_000;

function leaseExpiry(): string {
  return new Date(Date.now() + RUN_LEASE_TTL_MS).toISOString();
}

/**
 * Atomically claim the run lease or refuse with a TransientError naming the
 * current holder + expiry (#948 addendum — moved off UsageError, exit 75).
 * The single-UPDATE claim in the repository is the arbiter — two racing
 * invocations cannot both win.
 */
async function acquireRunLease(runId: string, holder: string): Promise<void> {
  await withMaintenanceStartBarrierAsync(() =>
    withWorkflowRunsRepo((repo) => {
      if (repo.acquireEngineLease(runId, holder, leaseExpiry(), new Date().toISOString())) return;
      const row = repo.getRunById(runId);
      throw new TransientError(
        `Workflow run ${runId} is already being driven by engine ${row?.engine_lease_holder ?? "(unknown)"} ` +
          `(run lease expires ${row?.engine_lease_until ?? "(unknown)"}). A second \`akm workflow run\` would race it — ` +
          `wait for that invocation to finish or for the lease to expire.`,
        "RUN_LEASE_HELD",
      );
    }),
  );
}

/**
 * Renew the lease between steps. Losing the lease mid-run (it expired during
 * a long step and another engine claimed it) is a hard stop: the new owner
 * drives the spine now, and continuing would race it.
 */
async function renewRunLease(runId: string, holder: string): Promise<void> {
  await withWorkflowRunsRepo((repo) => {
    if (repo.renewEngineLease(runId, holder, leaseExpiry())) return;
    const row = repo.getRunById(runId);
    throw new UsageError(
      `Workflow run ${runId} lost its run lease (now held by ${row?.engine_lease_holder ?? "(nobody)"}). ` +
        `Another engine invocation claimed the run after this one's lease expired — stopping to avoid racing it.`,
    );
  });
}

/** Renew mid-dispatch this often. Well under the TTL so a slow/skipped tick
 * still leaves ample margin before the lease would expire. */
const HEARTBEAT_INTERVAL_MS = RUN_LEASE_TTL_MS / 3;

/**
 * Schedules the heartbeat's periodic renewal tick; returns a stop function.
 * The tick is async (a repository renewal); the default wrapper fires it and
 * ignores the returned promise (setInterval semantics).
 */
export type HeartbeatScheduler = (tick: () => Promise<void>) => () => void;

/** Real timer: an unref'd interval so a live heartbeat never keeps the process alive. */
function defaultHeartbeatScheduler(tick: () => Promise<void>): () => void {
  const id = setInterval(() => void tick(), HEARTBEAT_INTERVAL_MS);
  (id as unknown as { unref?: () => void }).unref?.();
  return () => clearInterval(id);
}

/**
 * Keeps the run lease alive while a step dispatches (P1 fix — the between-step
 * renewal cannot cover a unit that runs longer than the TTL). A timer inside
 * the engine invocation renews the lease through the holder-guarded
 * {@link renewEngineLease}; the heartbeat owns an {@link AbortController}
 * (chained onto the caller's signal) that becomes the effective DISPATCH
 * signal, so a lost lease aborts in-flight dispatch PROMPTLY. After the abort,
 * {@link assertAlive} throws a loud UsageError, so the engine stops instead of
 * continuing to drive a run another engine now owns. No background daemon: the
 * timer is cleared in the caller's `finally` and dies with the process.
 */
class LeaseHeartbeat {
  private readonly controller = new AbortController();
  private readonly detachUpstream: (() => void) | undefined;
  private readonly schedule: HeartbeatScheduler;
  private cancel: (() => void) | undefined;
  private renewing = false;
  /** Set once a renewal failed — the lease was stolen after a genuine expiry. */
  private lost = false;
  /** The holder that stole the lease, captured for the loud error. */
  private stolenBy: string | null = null;

  constructor(
    private readonly runId: string,
    private readonly holder: string,
    scheduler: HeartbeatScheduler | undefined,
    upstream: AbortSignal | undefined,
  ) {
    this.schedule = scheduler ?? defaultHeartbeatScheduler;
    // A caller abort (Ctrl-C, budget) must abort dispatch too; chain it into
    // the effective signal. Distinct from a lost lease: a caller abort does
    // NOT set `lost`, so `assertAlive` stays quiet and the existing graceful
    // break on `options.signal` handles it.
    if (upstream) {
      if (upstream.aborted) {
        this.controller.abort();
      } else {
        const onAbort = () => this.controller.abort();
        upstream.addEventListener("abort", onAbort, { once: true });
        this.detachUpstream = () => upstream.removeEventListener("abort", onAbort);
      }
    }
  }

  /** The effective dispatch signal: aborts on a lost lease OR a caller abort. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  start(): void {
    this.cancel ??= this.schedule(() => this.tick());
  }

  /** One renewal attempt. A failure marks the lease lost and aborts dispatch. */
  private async tick(): Promise<void> {
    if (this.lost || this.renewing || this.controller.signal.aborted) return;
    this.renewing = true;
    try {
      const renewed = await withWorkflowRunsRepo((repo) =>
        repo.renewEngineLease(this.runId, this.holder, leaseExpiry()),
      );
      if (!renewed) {
        this.stolenBy = await withWorkflowRunsRepo((repo) => repo.getRunById(this.runId)?.engine_lease_holder ?? null);
        this.loseLease();
      }
    } catch {
      // A renewal that THREW (a DB error / connection failure, or the follow-up
      // getRunById itself throwing) is treated exactly like a stolen lease: we
      // can no longer PROVE we still hold it, so abort in-flight dispatch and let
      // `assertAlive` stop the engine loudly. Swallowing the error here is what
      // keeps the fire-and-forget `void tick()` in the default scheduler from
      // leaking an unhandled promise rejection.
      this.loseLease();
    } finally {
      this.renewing = false;
    }
  }

  /** Mark the lease lost, stop the timer, and abort in-flight dispatch — the new
   * owner drives the spine now (or, on a renewal error, we can no longer prove we
   * do). Idempotent: repeated calls are harmless. */
  private loseLease(): void {
    this.lost = true;
    this.stop();
    this.controller.abort();
  }

  /**
   * Throw loudly if a heartbeat renewal failed. Called at dispatch boundaries:
   * a lost lease means another engine claimed the run mid-step, so continuing
   * (completing steps, dispatching more units) would double-drive it.
   */
  assertAlive(): void {
    if (!this.lost) return;
    throw new UsageError(
      `Workflow run ${this.runId} lost its run lease mid-dispatch (heartbeat renewal failed; lease now held by ` +
        `${this.stolenBy ?? "(nobody)"}). Another engine invocation claimed the run after this one's lease expired — ` +
        `aborting to avoid double-driving it.`,
    );
  }

  stop(): void {
    this.cancel?.();
    this.cancel = undefined;
    this.detachUpstream?.();
  }
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
  stepPlan: IrStepPlanV4,
  signal: AbortSignal | undefined,
  owner: { runId: string; stepId: string },
): SummaryJudge | null {
  if (options.summaryJudge !== undefined) return options.summaryJudge;
  // The judge dispatches under the REAL run/step identity; the per-loop gate row
  // identity is threaded in per call by the completion path that journals it.
  // eventSource (gap closed, code review): the judge's dispatch is a "command"
  // request like any other exec/agent/sdk unit, so it goes through the same
  // provenance thread `executeStepSubgraph` uses below — undefined for every
  // non-task caller, byte-identical.
  return frozenSummaryJudge(
    stepPlan.gate.frozenJudge,
    signal,
    options.dispatcher ?? defaultUnitDispatcher,
    owner,
    options.eventSource,
  );
}

/**
 * Seed the declared budget ceilings from the journal so they are truly
 * per-RUN: a resumed or re-invoked run must not restart a declared `budget`
 * at zero. The append-only attempt journal is authoritative: dispatch
 * attempts count against `budget.max_units`, and their known tokens count
 * against `budget.max_tokens`. Durable result reuse is free.
 *
 * Gate-evaluation rows (`phase = "gate"`, journaled by the completion-gate
 * judge) are EXCLUDED from the seed: the live path never consumes
 * DispatchBudget for a judge call, so counting its journal row on resume
 * would make an interrupted run hit `max_units` (and the lifetime cap)
 * earlier than the identical uninterrupted run — a spurious hard failure
 * that `on_error` cannot soften. The seed must reproduce exactly what live
 * accounting would have accumulated.
 *
 * Attempt rows are append-only, so retries cannot collapse or erase prior
 * dispatch accounting.
 */
async function seedRunAccountingFromJournal(runId: string): Promise<{ unitsDispatched: number; tokensUsed: number }> {
  const accounting = await withWorkflowRunsRepo((repo) => repo.getAttemptAccounting(runId));
  return {
    unitsDispatched: accounting.dispatchAttempts,
    tokensUsed: accounting.dispatchTokens,
  };
}

/**
 * The decoded/hash-verified row plan is the sole execution authority. The
 * loader seam may assert an expected plan in tests, but can never replace it.
 *
 * Reviewer #12: the journaled params row must still satisfy the frozen param
 * schemas before the engine resolves any unit prompt from it, so
 * schema-violating params — post-start corruption — fail loudly BEFORE any
 * unit is dispatched (start already validated the params it stored).
 */
async function loadAuthoritativeRunPlan(
  options: RunWorkflowOptions,
  next: WorkflowNextResult,
): Promise<WorkflowPlanGraphV4> {
  const stored = await loadStoredPlan(next.run.id);
  if (options.loadPlan) {
    const expected = decodeWorkflowPlanV4(await options.loadPlan(next.run.workflowRef));
    if (computePlanHash(expected) !== computePlanHash(stored))
      throw new UsageError(`Injected workflow plan for run ${next.run.id} differs from its frozen plan.`);
  }
  assertRunParamsSatisfyPlan(next.run.id, stored, next.run.params ?? {});
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
  stepPlan: IrStepPlanV4;
  skipInfo: RouteSkipInfo;
  routeUnselected: Map<string, RouteSkipInfo>;
  executed: ExecutedStepReport[];
  leaseHolder: string;
}): Promise<WorkflowNextResult> {
  const { runId, stepId, stepPlan, skipInfo, routeUnselected, executed, leaseHolder } = input;
  // Cascade (peer review R1): a skipped step that is ITSELF a router
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
  await completeWorkflowStep({ runId, stepId, status: "skipped", notes, leaseHolder });
  return getNextWorkflowStep(runId);
}

/**
 * Crash-resume gate state (Codex P1): SEED the starting gate loop from the
 * journal through the SAME shared helpers the first pass used — no fork.
 * A run interrupted after a rejected gate was journaled
 * (`<step>.gate:l<n>`, complete:false) must resume at loop n+1 with the
 * stored corrective feedback threaded into the unit prompts; without this
 * the engine restarts at loop 1, reuses the rejected loop-1 rows, overwrites
 * `<step>.gate:l1`, and re-judges the stale artifact — breaking journaled
 * replay and making the resumed run diverge from the interrupted one. The rows
 * are re-read per step (NOT the once-at-start budget seed) so a step reached
 * later within THIS same invocation still starts fresh at loop 1.
 *
 * Only the STEP's rows are read (index-backed on `(run_id, step_id)`): both
 * helpers already discard every row carrying a different `step_id`, and gate
 * rows are journaled under the step's own id, so the narrow query returns a
 * superset of what they read. Re-reading the whole run journal here would
 * re-materialize every earlier step's `result_json` — synchronously, blocking
 * the event loop the lease heartbeat and abort handling share — once per step.
 */
async function recoverGateLoopState(
  runId: string,
  stepPlan: IrStepPlanV4,
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
  plan: WorkflowPlanGraphV4;
  stepPlan: IrStepPlanV4;
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
  leaseHolder: string;
  heartbeat: LeaseHeartbeat | undefined;
  /** The effective dispatch signal: the heartbeat's controller while leased, else the caller signal. */
  dispatchSignal: AbortSignal | undefined;
}

/**
 * Loop-control + accounting outcome of one step's bounded gate loop. `kind` is
 * the SINGLE discriminator every consumer derives from — whether the engine
 * keeps walking the spine (only `"advanced"` does) and whether the step consumed
 * its one `maxSteps` allowance ({@link STEP_FINISHED_KINDS}). A new exit point
 * must name its kind, so it cannot silently skew the remaining-steps accounting
 * the way a forgotten boolean could.
 */
interface StepGateLoopOutcome {
  kind: "advanced" | "failed" | "gate-exhausted" | "judge-failed" | "child-blocked" | "aborted";
  gateRejection?: RunWorkflowResult["gateRejection"];
  judgeFailure?: RunWorkflowResult["judgeFailure"];
  /**
   * P3b §3.4: a composed child workflow is blocked. Like `judgeFailure`, this
   * consumes no gate loop — see {@link STEP_FINISHED_KINDS}.
   */
  childBlocked?: RunWorkflowResult["childBlocked"];
  /** Running per-run dispatch/token totals, threaded back into the engine loop. */
  unitsDispatched: number;
  tokensUsed: number;
}

/**
 * The kinds that FINISHED the step (completed / failed / gate-exhausted) — the
 * ONE `maxSteps` consumption for its whole gate loop. An abort and a judge
 * outage leave the step unfinished and consume nothing: the next invocation
 * still owes the work. A blocked child is the SAME shape as a judge outage
 * (P3b §3.4) — a gate is a gate for a child workflow too, so it is likewise
 * NOT in this set: `akm workflow resume` is what clears it, never an
 * automatic in-step re-dispatch.
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
  const { options, next, plan, stepPlan, step, evidence, leaseHolder, dispatchSignal } = ctx;
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
        leaseHolder,
        workflowRef: next.run.workflowRef,
        params: next.run.params ?? {},
        evidence,
        unitsDispatched,
        tokensUsed,
        // Budget ceilings ride the FROZEN plan (addendum R2): a mid-run
        // asset edit can never loosen or tighten a run's budget.
        ...(plan.budget ? { budget: plan.budget } : {}),
        gateLoop,
        ...(gateFeedback ? { gateFeedback } : {}),
        // F-1 (spec §5.2 point 2): threaded to an exec unit's child env;
        // undefined for every non-task caller (byte-identical, RunWorkflowOptions doc).
        ...(options.eventSource !== undefined ? { eventSource: options.eventSource } : {}),
        // The heartbeat's signal is the effective dispatch signal: a lost
        // lease (or a caller abort) aborts in-flight units promptly.
        ...(dispatchSignal ? { signal: dispatchSignal } : {}),
        ...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
        maxConcurrency: Math.min(
          options.maxConcurrency ?? Number.POSITIVE_INFINITY,
          plan.execution?.maxConcurrency ?? 1,
        ),
      });
}

/**
 * Drive ONE step's bounded gate loop (addendum R2, `gate.max_loops`): loop 1 is
 * the normal execution; a gate rejection with attempts left re-executes the
 * subgraph with the judge's feedback threaded into unit prompts.
 *
 * The engine owns only the loop control the shared completion path
 * (`finalizeExecutedStep`) maps onto — retry re-executes; advanced moves on;
 * failure/judge-failure/exhaustion stops this invocation — and returns that
 * decision plus the running budget totals to {@link driveRun}. `ctx.executed`
 * is appended in place (one report per iteration); everything else the caller
 * must observe travels back through {@link StepGateLoopOutcome}.
 */
async function runStepGateLoop(
  ctx: StepDriveContext,
  gate: { startLoop: number; maxLoops: number; seededFeedback: GateFeedback | undefined },
  totals: { unitsDispatched: number; tokensUsed: number },
): Promise<StepGateLoopOutcome> {
  const { options, next, stepPlan, step, evidence, executed, routeSelected, routeUnselected } = ctx;
  const { summaryJudge, leaseHolder, heartbeat } = ctx;
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
    // A loop re-execution dispatches a fresh round of units — renew the
    // lease so a long evaluator-optimizer cycle cannot outlive the TTL.
    if (gateLoop > 1) await renewRunLease(next.run.id, leaseHolder);

    const result = await executeStepSubgraph(ctx, { gateLoop, gateFeedback, unitsDispatched, tokensUsed });
    // If the heartbeat lost the lease WHILE this step dispatched, another
    // engine now owns the run — stop loudly BEFORE finalizing the step
    // (completeWorkflowStep would race the new owner's spine).
    heartbeat?.assertAlive();
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

    // Route evaluation + artifact-judged completion gate + gate-row
    // journaling + the bounded-loop rejection contract are the SHARED
    // completion path (`finalizeExecutedStep`): every step advances through
    // that one sequence, whether its units were just dispatched or rehydrated
    // from the journal on resume, so the same frozen plan always promotes the
    // same artifact and advances (or rejects) the spine identically.
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
        // The judge runs under the DISPATCH signal, so the completion path must
        // see it too: an abort delivered there (a lost lease, a caller Ctrl-C)
        // is an interruption, not a verifier outage.
        ...(ctx.dispatchSignal ? { dispatchSignal: ctx.dispatchSignal } : {}),
        leaseHolder,
      });
    } catch (error) {
      heartbeat?.assertAlive();
      if (options.signal?.aborted) return outcome({ kind: "aborted" });
      throw error;
    }
    heartbeat?.assertAlive();

    if (finalize.kind === "retry") {
      // Re-execute the subgraph with the judge/validation feedback threaded
      // into unit prompts — the changed prompt changes each unit's input
      // hash, so the re-run dispatches fresh work instead of reusing rows.
      gateFeedback = finalize.gateFeedback;
      continue;
    }
    if (finalize.kind === "advanced") {
      // Hand the rest of this invocation the COMPLETE artifact — but only when
      // some LATER step's frozen references can actually read it (set-time
      // retention, see `referencedStepIds`). `finalize` has already journaled
      // the step (and stamped any route decision onto `result.evidence`), and
      // the persisted row may carry a truncation envelope in place of an
      // over-cap value — the row bound must not change what the very next step
      // reads.
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
      // P3b §3.4: a composed child workflow is blocked. Like judge-failed,
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

/** The engine loop proper — runs under the lease held by `runWorkflowSteps`. */
async function driveRun(
  options: RunWorkflowOptions,
  initial: WorkflowNextResult,
  leaseHolder: string,
  heartbeat: LeaseHeartbeat | undefined,
  /**
   * The COMPLETE in-memory evidence of every step THIS call has completed,
   * keyed by step id, preferred over the re-read row when the downstream scope
   * is rebuilt below — avoiding a re-parse of a row this same invocation just
   * wrote (step artifacts are persisted whole, so the two values agree; this
   * is purely an avoided round trip, not a correctness dependency). A LATER
   * `akm workflow run` starts with an empty map and reads the rows directly.
   *
   * Only steps some OTHER step's references NAME are stored (`referencedStepIds`
   * — the set-time filter): a step nothing downstream reads has no consumer to
   * keep it complete for, so retaining it would buy nothing and cost its bytes
   * for the rest of the invocation.
   */
  liveEvidence: Map<string, Record<string, unknown>>,
): Promise<RunWorkflowResult> {
  let next = initial;
  if (initial.done) return completedRunResult(initial.run.id);

  // The effective dispatch signal: the heartbeat's controller (a lost lease or
  // a caller abort aborts it) while leased, else the raw caller signal.
  const dispatchSignal = heartbeat?.signal ?? options.signal;
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

  const plan = await loadAuthoritativeRunPlan(options, next);

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

  // Resume contract: route decisions are journaled in the route step's
  // evidence (`evidence.route.selected`) and must be REPLAYED into the
  // bookkeeping before the spine advances — a re-invoked run (crash, Ctrl-C,
  // maxSteps, gate rejection after the route completed) would otherwise reach
  // the unselected targets with empty in-memory state and execute the wrong
  // branch. Decisions stay pure functions of (frozen plan, params, journaled
  // results) — the addendum determinism bar. A done run skips the seeding:
  // nothing will dispatch, so an unrecoverable prior decision must not
  // block the no-op status return below.
  if (!next.done) {
    seedJournaledRouteDecisions(plan, next, routeSelected, routeUnselected);
  }

  while (!next.done && next.step && next.run.status === "active" && stepsProcessed < maxSteps) {
    // A LOST lease (the heartbeat's renewal failed mid-step) is a loud stop —
    // another engine owns the spine now. A caller abort (options.signal) is a
    // graceful break, distinct from a lost lease.
    heartbeat?.assertAlive();
    if (options.signal?.aborted) {
      aborted = true;
      break;
    }
    // Renew the run lease between steps (a fresh 90s window per iteration).
    // Losing it (expired mid-step + claimed by another engine) throws — the
    // new owner drives the spine now.
    await renewRunLease(next.run.id, leaseHolder);
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
        leaseHolder,
      });
      continue;
    }

    const evidence: Record<string, Record<string, unknown> | undefined> = {};
    for (const s of next.workflow.steps) evidence[s.id] = liveEvidence.get(s.id) ?? s.evidence;

    // Bounded gate loop (addendum R2, `gate.max_loops`): loop 1 is the normal
    // execution; a gate rejection with attempts left re-executes the subgraph
    // with the judge's feedback threaded into unit prompts. The bound comes
    // from the shared derivation, which holds an exec step to a single
    // execution — its argv cannot answer feedback (see effectiveGateMaxLoops).
    const maxLoops = effectiveGateMaxLoops(stepPlan);

    const { startLoop, seededFeedback } = await recoverGateLoopState(next.run.id, stepPlan);

    // Resume AFTER the FINAL rejection (`startLoop` past the loop bound): the
    // gate was already exhausted before the crash, so there is NO fresh loop to
    // run — reproduce the documented gateRejection outcome from the stored
    // final-loop feedback instead of re-dispatching a spurious extra loop. The
    // l1..l<maxLoops> rows stay untouched and the step stays active, exactly as
    // when the engine first exhausted the gate.
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
      summaryJudge = workflowSummaryJudge(options, stepPlan, dispatchSignal, {
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
        leaseHolder,
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
        leaseHolder,
        heartbeat,
        dispatchSignal,
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

/**
 * Load the plan a run executes (frozen-plan contract, migration 006):
 *
 *   - `plan_json` present → parse it and verify `plan_hash` (sha256 of the
 *     canonical JSON). A mismatch means the journaled plan was tampered with
 *     or corrupted — fail loudly, never silently recompile. The workflow
 *     asset file is NEVER touched on this path.
 * Missing and non-current plans fail validation and are never rebuilt from a
 * mutable source asset.
 */
async function loadStoredPlan(runId: string): Promise<WorkflowPlanGraphV4> {
  const row = await withWorkflowRunsRepo((repo) => {
    const run = repo.getRunById(runId);
    return run;
  });
  if (!row) throw new UsageError(`Workflow run ${runId} was not found.`);
  return requireExecutableWorkflowPlan(row);
}
