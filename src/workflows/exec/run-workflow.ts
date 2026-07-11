// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Engine-driven workflow execution — `akm workflow run` (orchestration plan
 * P1, owner decision 5). akm itself walks the plan and dispatches units; the
 * existing `next`/`complete` loop remains for manual/agent-driven advancement
 * of the same runs.
 *
 * Invariant (plan §*Never bypass the gate spine*): every step advances
 * through `completeWorkflowStep`, never by writing step rows directly, so the
 * summary-validation gate and run-state derivation stay authoritative. A gate
 * rejection (SummaryValidationFailure) STOPS the engine and surfaces the
 * corrective feedback — a gate is a gate, even for the engine.
 *
 * Artifact-judging gates (redesign addendum, R2): when a step declares
 * completion criteria, the engine hands the gate a summary BUILT FROM the
 * step's promoted artifact (canonical JSON, clipped, prefixed with a one-line
 * unit count — `buildArtifactSummary`) instead of the machine-prose execution
 * summary, so the judge evaluates real results. Each engine-driven judge call
 * is journaled as a unit row (`node_id "<stepId>.gate"`, `unit_id
 * "<stepId>.gate:l<loop>"`, runner "llm", result_json = the verdict) through
 * the writer queue — it is an LLM call like any other. Human approvals are
 * never cached: a blocked gate stays blocked.
 *
 * Bounded gate loops (`gate.max_loops`, addendum R2): a rejection on a step
 * with maxLoops > 1 re-executes the step subgraph with the judge's feedback +
 * missing[] threaded into every unit prompt (`gateFeedback` on
 * StepExecutionContext) — the feedback changes each unit's input hash, so the
 * loop re-dispatches naturally instead of reusing the rejected rows. After
 * maxLoops rejections the engine stops with the gate feedback, exactly like
 * the one-shot case. A typed-artifact schema mismatch feeds the same loop
 * (the validation errors are the feedback; no judge ran, so no gate unit is
 * journaled for that attempt) — only the FINAL loop's mismatch fails the run.
 *
 * Frozen plan (redesign addendum, R1): the plan graph is read from the run
 * row (`plan_json`, persisted by `startWorkflowRun` under migration 006) with
 * a `plan_hash` integrity check — the workflow asset file is NEVER re-read
 * for an in-flight run, so a mid-run asset edit cannot change behavior.
 * Legacy runs (created before migration 006, NULL plan_json) fall back to
 * compile-from-asset with a warning. Durable-row resume: re-invoking a
 * partially-executed run re-dispatches only work that never completed.
 *
 * Run lease (redesign addendum, R2): exactly one engine invocation drives a
 * run at a time. The lease (random holder id + 90s expiry on the run row) is
 * acquired before any dispatch, renewed between steps, and released in a
 * `finally`; a second `workflow run` on a live-leased run refuses up front,
 * and an expired lease is claimable (crash recovery). While the lease is
 * live, manual `workflow complete` is refused too — the engine owns the
 * spine while driving (enforced inside `completeWorkflowStep`).
 *
 * Process-lifecycle contract (owner finding 4 — no leaked handles): the SDK
 * dispatch path caches `opencode serve` CHILD PROCESSES in a per-env registry
 * for reuse across units. Each live child is an OS handle that keeps Bun's
 * event loop open; the registry's own teardown is wired only to
 * `process.once('exit')`, which never fires while a child holds the loop open.
 * That deadlock hangs a one-shot CLI (`akm workflow run` has no `process.exit`
 * on success — it relies on the loop draining). The engine therefore DRAINS
 * the dispatch registry ({@link disposeDispatchResources}) in its run `finally`,
 * on EVERY exit path, so the process exits cleanly the moment the run resolves.
 * The drain is synchronous, idempotent, and a no-op when no SDK server started.
 */

import { randomUUID } from "node:crypto";
import { UsageError } from "../../core/errors";
import { disposeDispatchResources } from "../../integrations/agent/runner-dispatch";
import type { WorkflowRunSummary } from "../../sources/types";
import { withWorkflowRunsRepo } from "../../storage/repositories/workflow-runs-repository";
import { assertRunParamsSatisfyPlan } from "../ir/params";
import { computePlanHash } from "../ir/plan-hash";
import { decodeWorkflowPlanV3, type WorkflowPlanGraph } from "../ir/schema";
import { requireExecutableWorkflowPlan } from "../runtime/plan-classifier";
import { completeWorkflowStep, getNextWorkflowStep, type WorkflowNextResult } from "../runtime/runs";
import type { SummaryJudge } from "../validate-summary";
import { frozenSummaryJudge } from "./frozen-judge";
import { executeStepPlan, type StepExecutionResult, type UnitDispatcher } from "./native-executor";
// Shared step semantics — route evaluation + cascaded-skip bookkeeping,
// gate-evaluation journaling, and the whole step-completion path
// (`finalizeExecutedStep`) live in step-work.ts so the engine loop and the R3
// brief/report driver protocol share ONE implementation (no drift).
import {
  activeGateLoop,
  cascadeSkippedRouter,
  finalizeExecutedStep,
  GATE_EVALUATION_PHASE,
  type GateFeedback,
  type RouteSkipInfo,
  recoverGateFeedback,
  seedJournaledRouteDecisions,
} from "./step-work";

export interface RunWorkflowOptions {
  /** Workflow run id or workflow ref (auto-starts a run, like `workflow next`). */
  target: string;
  /** Params for an auto-started run. */
  params?: Record<string, unknown>;
  /** Stop after this many steps (default: run to completion/gate/failure). */
  maxSteps?: number;
  signal?: AbortSignal;
  /** Test seam / backend override for unit dispatch. */
  dispatcher?: UnitDispatcher;
  /**
   * Test seam: plan loader. Default: the run row's FROZEN plan (`plan_json`
   * + `plan_hash` integrity check, migration 006); legacy runs with NULL
   * plan_json fall back to loadWorkflowAsset + compile with a warning.
   */
  loadPlan?: (workflowRef: string) => Promise<WorkflowPlanGraph>;
  /** Test seam for the engine concurrency cap. */
  maxConcurrency?: number;
  /**
   * Completion-criteria judge override, threaded into `completeWorkflowStep`
   * for every engine-driven completion. `undefined` (absent) = build the
   * default judge from the configured LLM; `null` = no judge (the gate is
   * fail-open, matching offline behavior). Injected primarily for tests.
   */
  summaryJudge?: SummaryJudge | null;
  /**
   * Reviewer #18: `--require-gates` — treat every criteria-bearing completion
   * gate as required for this invocation, so a gate with no judge available
   * BLOCKS the step (for a human) instead of failing open. A per-step
   * `gate.required: true` in the frozen plan does the same on both surfaces; this
   * flag is the run-wide engine override on top of it.
   */
  requireGates?: boolean;
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
  disposeDispatchResources?: () => void;
}

export interface ExecutedStepReport {
  stepId: string;
  ok: boolean;
  unitCount: number;
  failedUnits: number;
  summary: string;
}

export interface RunWorkflowResult {
  run: WorkflowRunSummary;
  executed: ExecutedStepReport[];
  /** Present when the run reached completed state during this invocation. */
  done?: true;
  /** Present when a step summary was rejected by the completion-criteria gate. */
  gateRejection?: { stepId: string; missing: string[]; feedback: string };
}

export async function runWorkflowSteps(options: RunWorkflowOptions): Promise<RunWorkflowResult> {
  const next: WorkflowNextResult = await getNextWorkflowStep(options.target, options.params);
  // Version/canonical/hash validation precedes every executable mutation,
  // including lease acquisition. Historical rows remain inspectable/abandonable.
  if (!next.done && !options.loadPlan) {
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
    return await driveRun(options, next, leaseHolder, heartbeat);
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
        (options.disposeDispatchResources ?? disposeDispatchResources)();
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
 * Atomically claim the run lease or refuse with a UsageError naming the
 * current holder + expiry. The single-UPDATE claim in the repository is the
 * arbiter — two racing invocations cannot both win.
 */
async function acquireRunLease(runId: string, holder: string): Promise<void> {
  await withWorkflowRunsRepo((repo) => {
    if (repo.acquireEngineLease(runId, holder, leaseExpiry(), new Date().toISOString())) return;
    const row = repo.getRunById(runId);
    throw new UsageError(
      `Workflow run ${runId} is already being driven by engine ${row?.engine_lease_holder ?? "(unknown)"} ` +
        `(run lease expires ${row?.engine_lease_until ?? "(unknown)"}). A second \`akm workflow run\` would race it — ` +
        `wait for that invocation to finish or for the lease to expire.`,
    );
  });
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

/** The engine loop proper — runs under the lease held by `runWorkflowSteps`. */
async function driveRun(
  options: RunWorkflowOptions,
  initial: WorkflowNextResult,
  leaseHolder: string,
  heartbeat: LeaseHeartbeat | undefined,
): Promise<RunWorkflowResult> {
  let next = initial;

  // A terminal (completed) run is a PURE no-op. `runWorkflowSteps` already
  // skipped lease acquisition for a done run (`leased = !next.done`), and this
  // path must ALSO refuse to read the journal or load/integrity-check the
  // frozen plan: a run that finished cleanly, then had its `plan_json` corrupted
  // or tampered afterwards, must still report `done` here rather than throwing a
  // frozen-plan integrity error (loadFrozenPlan would). Nothing will dispatch
  // and the engine_lease_* columns stay exactly as they were, so return the
  // fresh run state immediately.
  if (initial.done) {
    const doneState = await getNextWorkflowStep(initial.run.id);
    return {
      run: doneState.run,
      executed: [],
      ...(doneState.run.status === "completed" ? { done: true as const } : {}),
    };
  }

  // The effective dispatch signal: the heartbeat's controller (a lost lease or
  // a caller abort aborts it) while leased, else the raw caller signal.
  const dispatchSignal = heartbeat?.signal ?? options.signal;
  const executed: ExecutedStepReport[] = [];
  let gateRejection: RunWorkflowResult["gateRejection"];
  const maxSteps = options.maxSteps ?? Number.POSITIVE_INFINITY;

  // Seed the lifetime unit cap AND the budget ceilings from the journal so
  // both are truly per-RUN: a resumed or re-invoked run must not restart the
  // runaway backstop — or a declared `budget` — at zero. Journal rows = past
  // dispatch ATTEMPTS (counted against `budget.max_units`); their summed
  // `tokens` column is the run's spend so far (counted against
  // `budget.max_tokens`). The executor consumes both only on new dispatches
  // (durable-row reuses are free), so a large partially-completed fan-out
  // stays resumable.
  //
  // Gate-evaluation rows (`phase = "gate"`, journaled by the completion-gate
  // judge below) are EXCLUDED from the seed: the live path never consumes
  // DispatchBudget for a judge call, so counting its journal row on resume
  // would make an interrupted run hit `max_units` (and the lifetime cap)
  // earlier than the identical uninterrupted run — a spurious hard failure
  // that `on_error` cannot soften. The seed must reproduce exactly what live
  // accounting would have accumulated.
  //
  // The seed sums each dispatch row's `attempts` (migration 008), NOT the row
  // COUNT: a crash between a unit's dispatch and its finish leaves a `running`
  // row that resume re-dispatches under the SAME content-derived unit_id, and
  // `insertUnit` REPLACES that one row while bumping `attempts`. Counting rows
  // would erase every prior crash-retried dispatch from budget/lifetime
  // accounting, letting the run spend past its declared ceiling; summing
  // `attempts` charges each dispatch exactly once.
  const journaledUnits = await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(next.run.id));
  const journaledDispatches = journaledUnits.filter((row) => row.phase !== GATE_EVALUATION_PHASE);
  let unitsDispatched = journaledDispatches.reduce((sum, row) => sum + row.attempts, 0);
  let tokensUsed = journaledDispatches.reduce((sum, row) => sum + (row.tokens ?? 0), 0);

  // The decoded/hash-verified row plan is the sole execution authority. The
  // loader seam may assert an expected plan in tests, but can never replace it.
  const plan = await loadFrozenPlan(next.run.id, next.run.workflowRef);
  if (options.loadPlan) {
    const expected = decodeWorkflowPlanV3(await options.loadPlan(next.run.workflowRef));
    if (computePlanHash(expected) !== computePlanHash(plan))
      throw new UsageError(`Injected workflow plan for run ${next.run.id} differs from its frozen plan.`);
  }

  // Reviewer #12: the journaled params row must still satisfy the frozen param
  // schemas before the engine resolves any unit prompt from it. Applied on ALL
  // THREE driver surfaces (engine here, brief, report) so schema-violating
  // params — post-start corruption — fail loudly and IDENTICALLY, preserving
  // cross-surface parity (start already validated the params it stored).
  assertRunParamsSatisfyPlan(next.run.id, plan, next.run.params ?? {});

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
  // nothing will dispatch, so an unrecoverable historical decision must not
  // block the no-op status return below.
  if (!next.done) {
    seedJournaledRouteDecisions(plan, next, routeSelected, routeUnselected);
  }

  while (!next.done && next.step && next.run.status === "active" && executed.length < maxSteps) {
    // A LOST lease (the heartbeat's renewal failed mid-step) is a loud stop —
    // another engine owns the spine now. A caller abort (options.signal) is a
    // graceful break, distinct from a lost lease.
    heartbeat?.assertAlive();
    if (options.signal?.aborted) break;
    // Renew the run lease between steps (a fresh 90s window per iteration).
    // Losing it (expired mid-step + claimed by another engine) throws — the
    // new owner drives the spine now.
    await renewRunLease(next.run.id, leaseHolder);
    const step = next.step;
    const stepPlan = plan.steps.find((s) => s.stepId === step.id);
    if (!stepPlan) {
      throw new UsageError(
        `Step "${step.id}" of run ${next.run.id} is not present in the current workflow asset (${next.run.workflowRef}). ` +
          `The source file changed since the run started — advance this step manually with \`akm workflow complete\`.`,
      );
    }

    // A branch target no completed router selected → auto-skip, no dispatch.
    const skipInfo = routeUnselected.get(step.id);
    if (skipInfo && !routeSelected.has(step.id)) {
      // Cascade (peer review R1): a skipped step that is ITSELF a router
      // never evaluates its route, so none of its declared targets were
      // selected — mark them all skip-on-reach too (a target another
      // completed router selects stays protected via routeSelected). Without
      // this, every branch of the skipped router would run unconditionally.
      if (stepPlan.route) {
        cascadeSkippedRouter(stepPlan.route, step.id, routeUnselected);
      }
      const notes =
        skipInfo.selected === null
          ? `Skipped by route: step "${skipInfo.router}" was itself skipped, so none of its branch targets run.`
          : `Skipped by route: step "${skipInfo.router}" selected "${skipInfo.selected}".`;
      executed.push({ stepId: step.id, ok: true, unitCount: 0, failedUnits: 0, summary: notes });
      await completeWorkflowStep({ runId: next.run.id, stepId: step.id, status: "skipped", notes, leaseHolder });
      next = await getNextWorkflowStep(next.run.id);
      continue;
    }

    // `dependsOn` edges (reserved in IR v2 — no frontend emits them today,
    // but a frozen plan may carry them) are a declared ordering contract:
    // every dependency must already be resolved before this step dispatches.
    // Execution is sequential (spine order), so a violation means the plan
    // ordered steps inconsistently with its declared edges — fail fast,
    // before spending.
    for (const dep of stepPlan.dependsOn ?? []) {
      const depState = next.workflow.steps.find((s) => s.id === dep);
      if (!depState || (depState.status !== "completed" && depState.status !== "skipped")) {
        throw new UsageError(
          `Step "${step.id}" depends on step "${dep}", which is ${depState?.status ?? "missing"}. ` +
            `Reorder the workflow so dependencies come first (execution is sequential in step order).`,
        );
      }
    }

    const evidence: Record<string, Record<string, unknown> | undefined> = {};
    for (const s of next.workflow.steps) evidence[s.id] = s.evidence;

    // Bounded gate loop (addendum R2, `gate.max_loops`): loop 1 is the normal
    // execution; a gate rejection with attempts left re-executes the subgraph
    // with the judge's feedback threaded into unit prompts. `advanced` = the
    // step completed and the spine may move on; `stopEngine` = failure or
    // final rejection — this invocation is done.
    const maxLoops = Math.max(1, stepPlan.gate.maxLoops ?? 1);

    // Crash-resume gate state (Codex P1): SEED the starting gate loop from the
    // journal exactly as the brief/report surfaces do — the SAME shared helpers,
    // no fork. A run interrupted after a rejected gate was journaled
    // (`<step>.gate:l<n>`, complete:false) must resume at loop n+1 with the
    // stored corrective feedback threaded into the unit prompts; without this
    // the engine restarts at loop 1, reuses the rejected loop-1 rows, overwrites
    // `<step>.gate:l1`, and re-judges the stale artifact — breaking journaled
    // replay and diverging from what brief computes for the same run. The rows
    // are re-read here (NOT the once-at-start `journaledUnits` budget seed) so a
    // step reached later within THIS same invocation still starts fresh at loop 1.
    const stepJournal = await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(next.run.id));
    const startLoop = activeGateLoop(stepJournal, step.id);
    const seededFeedback = recoverGateFeedback(stepJournal, step.id, startLoop);

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

    let gateFeedback: GateFeedback | undefined = seededFeedback;
    let advanced = false;
    let stopEngine = false;

    for (let gateLoop = startLoop; gateLoop <= maxLoops; gateLoop++) {
      // A loop re-execution dispatches a fresh round of units — renew the
      // lease so a long evaluator-optimizer cycle cannot outlive the TTL.
      if (gateLoop > 1) await renewRunLease(next.run.id, leaseHolder);

      // Route-only steps (YAML `route:` — no execution subgraph) dispatch no
      // units; they only decide the spine's path below. Everything else
      // executes its subgraph through the native executor.
      const result: StepExecutionResult =
        !stepPlan.root && stepPlan.route
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
              // Budget ceilings ride the FROZEN plan (addendum R2): a mid-run
              // asset edit can never loosen or tighten a run's budget.
              ...(plan.budget ? { budget: plan.budget } : {}),
              ...(plan.execution ? { engines: plan.execution.engines } : {}),
              gateLoop,
              ...(gateFeedback ? { gateFeedback } : {}),
              // The heartbeat's signal is the effective dispatch signal: a lost
              // lease (or a caller abort) aborts in-flight units promptly.
              ...(dispatchSignal ? { signal: dispatchSignal } : {}),
              ...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
              maxConcurrency: Math.min(
                options.maxConcurrency ?? Number.POSITIVE_INFINITY,
                plan.execution?.maxConcurrency ?? 1,
              ),
            });
      // If the heartbeat lost the lease WHILE this step dispatched, another
      // engine now owns the run — stop loudly BEFORE finalizing the step
      // (completeWorkflowStep would race the new owner's spine).
      heartbeat?.assertAlive();
      unitsDispatched = result.unitsDispatched;
      if (result.tokensUsed !== undefined) tokensUsed = result.tokensUsed;

      executed.push({
        stepId: step.id,
        ok: result.ok,
        unitCount: result.units.length,
        failedUnits: result.units.filter((u) => !u.ok).length,
        summary: result.summary,
      });

      // Route evaluation + artifact-judged completion gate + gate-row
      // journaling + the bounded-loop rejection contract are the SHARED
      // completion path (`finalizeExecutedStep`): the R3 report surface drives
      // the identical sequence, so an engine-driven and a report-driven run of
      // the same frozen plan promote the same artifact and advance (or reject)
      // the spine identically. The engine owns only the loop control the result
      // maps onto (retry re-executes; advanced moves on; failure/exhaustion
      // stops this invocation).
      const finalize = await finalizeExecutedStep({
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
        summaryJudge:
          options.summaryJudge === undefined ? frozenSummaryJudge(plan, stepPlan.gate.judge) : options.summaryJudge,
        ...(options.requireGates ? { requireGates: true } : {}),
        leaseHolder,
      });

      if (finalize.kind === "retry") {
        // Re-execute the subgraph with the judge/validation feedback threaded
        // into unit prompts — the changed prompt changes each unit's input
        // hash, so the re-run dispatches fresh work instead of reusing rows.
        gateFeedback = finalize.gateFeedback;
        continue;
      }
      if (finalize.kind === "advanced") {
        // A route-only step's summary IS its decision (finalize surfaces it).
        if (finalize.summaryOverride !== undefined) {
          executed[executed.length - 1] = { ...executed[executed.length - 1], summary: finalize.summaryOverride };
        }
        advanced = true;
        break;
      }
      if (finalize.kind === "failed") {
        // A route-failure was pushed as ok:true (the units succeeded); reflect
        // the deterministic route failure in the executed report.
        if (finalize.routeFailure) {
          executed[executed.length - 1] = { ...executed[executed.length - 1], ok: false, summary: finalize.summary };
        }
        stopEngine = true;
        break;
      }
      if (finalize.kind === "blocked") {
        // Reviewer #18: a required gate with no judge available — the step is
        // BLOCKED (not failed) for a human. The units succeeded, so overwrite the
        // report's ok/summary to reflect the block, then stop this invocation.
        executed[executed.length - 1] = { ...executed[executed.length - 1], ok: false, summary: finalize.summary };
        stopEngine = true;
        break;
      }
      // gate-exhausted: rejected with no loop budget left — stop with feedback.
      gateRejection = finalize.gateRejection;
      stopEngine = true;
    }

    if (stopEngine || !advanced) break;

    next = await getNextWorkflowStep(next.run.id);
  }

  // Re-read for the freshest run state (the loop may have exited on maxSteps).
  const finalState = await getNextWorkflowStep(next.run.id);
  return {
    run: finalState.run,
    executed,
    ...(finalState.run.status === "completed" ? { done: true as const } : {}),
    ...(gateRejection ? { gateRejection } : {}),
  };
}

/**
 * Load the plan a run executes (frozen-plan contract, migration 006):
 *
 *   - `plan_json` present → parse it and verify `plan_hash` (sha256 of the
 *     canonical JSON). A mismatch means the journaled plan was tampered with
 *     or corrupted — fail loudly, never silently recompile. The workflow
 *     asset file is NEVER touched on this path.
 * Historical v2/null rows are inspection-only in the engine cutover. They are
 * never recompiled from a mutable source asset.
 */
async function loadFrozenPlan(runId: string, _workflowRef: string): Promise<WorkflowPlanGraph> {
  const row = await withWorkflowRunsRepo((repo) => {
    const run = repo.getRunById(runId);
    return run;
  });
  if (!row) throw new UsageError(`Workflow run ${runId} was not found.`);
  return requireExecutableWorkflowPlan(row);
}
