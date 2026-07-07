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
 */

import { randomUUID } from "node:crypto";
import { UsageError } from "../../core/errors";
import { warn } from "../../core/warn";
import type { WorkflowRunSummary } from "../../sources/types";
import { withWorkflowRunsRepo } from "../../storage/repositories/workflow-runs-repository";
import type { WorkflowPlanGraph } from "../ir/schema";
import type { ExpressionScope } from "../program/expressions";
import {
  buildDefaultSummaryJudge,
  completeWorkflowStep,
  getNextWorkflowStep,
  type SummaryValidationFailure,
  type WorkflowNextResult,
} from "../runtime/runs";
import { compileWorkflowAssetPlan, loadWorkflowAsset } from "../runtime/workflow-asset-loader";
import type { SummaryJudge } from "../validate-summary";
import { executeStepPlan, type StepExecutionResult, type UnitDispatcher } from "./native-executor";
// Shared step semantics — route evaluation + cascaded-skip bookkeeping and
// gate-evaluation journaling live in step-work.ts so the engine loop and the
// R3 brief/report driver protocol share ONE implementation (no drift).
import {
  applyRouteDecision,
  buildArtifactSummary,
  cascadeSkippedRouter,
  evaluateRoute,
  GATE_EVALUATION_PHASE,
  type GateFeedback,
  type GateUnitRef,
  journalGateEvaluationFinish,
  journalGateEvaluationStart,
  parseFrozenPlan,
  type RouteSkipInfo,
  routeStepOutputs,
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
  try {
    return await driveRun(options, next, leaseHolder);
  } finally {
    if (leased) {
      await withWorkflowRunsRepo((repo) => {
        repo.releaseEngineLease(runId, leaseHolder);
      });
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

/** The engine loop proper — runs under the lease held by `runWorkflowSteps`. */
async function driveRun(
  options: RunWorkflowOptions,
  initial: WorkflowNextResult,
  leaseHolder: string,
): Promise<RunWorkflowResult> {
  let next = initial;
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
  const journaledUnits = await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(next.run.id));
  const journaledDispatches = journaledUnits.filter((row) => row.phase !== GATE_EVALUATION_PHASE);
  let unitsDispatched = journaledDispatches.length;
  let tokensUsed = journaledDispatches.reduce((sum, row) => sum + (row.tokens ?? 0), 0);

  // One plan per invocation: the test seam receives the workflow ref; the
  // default reads the run's frozen plan and never touches the asset file.
  const plan = options.loadPlan
    ? await options.loadPlan(next.run.workflowRef)
    : await loadFrozenPlan(next.run.id, next.run.workflowRef);

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
    let gateFeedback: GateFeedback | undefined;
    let advanced = false;
    let stopEngine = false;

    for (let gateLoop = 1; gateLoop <= maxLoops; gateLoop++) {
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
              gateLoop,
              ...(gateFeedback ? { gateFeedback } : {}),
              ...(options.signal ? { signal: options.signal } : {}),
              ...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
              ...(options.maxConcurrency !== undefined ? { maxConcurrency: options.maxConcurrency } : {}),
            });
      unitsDispatched = result.unitsDispatched;
      if (result.tokensUsed !== undefined) tokensUsed = result.tokensUsed;

      executed.push({
        stepId: step.id,
        ok: result.ok,
        unitCount: result.units.length,
        failedUnits: result.units.filter((u) => !u.ok).length,
        summary: result.summary,
      });

      if (!result.ok) {
        // Typed-artifact schema mismatch (addendum R2): the ONE retryable
        // failure class — "fail-fast; gate loops can re-run it". With loop
        // budget left, the validation errors become gate feedback for the
        // next attempt (regenerate-with-errors, exactly what max_loops is
        // for) instead of failing the run. No judge ran, so no gate unit is
        // journaled for this attempt; the re-execution journals under
        // ~l<loop> as usual. Everything else (dispatch failures, replay
        // divergence, cap) — and the FINAL loop's mismatch — stays a hard
        // stop through completeWorkflowStep below.
        if (result.artifactSchemaFailure && gateLoop < maxLoops) {
          gateFeedback = { feedback: result.summary, missing: [] };
          continue;
        }
        // Gate spine: record the failure through completeWorkflowStep so the
        // run flips to failed via the normal state derivation.
        await completeWorkflowStep({
          runId: next.run.id,
          stepId: step.id,
          status: "failed",
          notes: result.summary,
          evidence: result.evidence,
          leaseHolder,
        });
        stopEngine = true;
        break;
      }

      // Evaluate the route BEFORE completing the step: an unroutable value is
      // an authoring/config failure and must fail the step deterministically
      // rather than letting every branch run sequentially. The route input is
      // an explicit `${{ … }}` reference resolved against run params and step
      // outputs — INCLUDING the just-finished step's own evidence.
      if (stepPlan.route) {
        const scope: ExpressionScope = {
          params: next.run.params ?? {},
          stepOutputs: routeStepOutputs(evidence, step.id, result.evidence),
        };
        const decision = evaluateRoute(stepPlan.route, scope);
        if (!decision.ok) {
          const notes = `Step "${step.id}" route failed: ${decision.error}`;
          executed[executed.length - 1] = { ...executed[executed.length - 1], ok: false, summary: notes };
          await completeWorkflowStep({
            runId: next.run.id,
            stepId: step.id,
            status: "failed",
            notes,
            evidence: result.evidence,
            leaseHolder,
          });
          stopEngine = true;
          break;
        }
        applyRouteDecision(stepPlan.route, step.id, decision.selected, routeSelected, routeUnselected);
        // Journal the decision on the step evidence: resume replays it via
        // seedJournaledRouteDecisions, so the skip set survives re-invocation.
        result.evidence.route = { input: stepPlan.route.input, value: decision.value, selected: decision.selected };
        // A route-only step's summary IS its decision (deterministic).
        if (!stepPlan.root) {
          result.summary = `Step "${step.id}" routed on ${stepPlan.route.input}: value "${decision.value}" selected step "${decision.selected}".`;
          executed[executed.length - 1] = { ...executed[executed.length - 1], summary: result.summary };
        }
      }

      // Artifact-judging gate (addendum R2): when the step declares
      // completion criteria, the judged summary is BUILT FROM the promoted
      // step artifact — real results, not engine prose. Steps without
      // criteria keep the machine summary (no judge runs on them anyway).
      const criteria = step.completionCriteria ?? [];
      const summary =
        stepPlan.root && criteria.length > 0
          ? buildArtifactSummary(step.id, result.units, result.evidence)
          : result.summary;

      // Wrap the judge so engine-driven gate evaluations are journaled as
      // unit rows (they are LLM calls). `invoked` stays false when the gate
      // is fail-open (no criteria / no judge) — nothing is journaled then,
      // and human approvals are never cached.
      const gateUnit: GateUnitRef = {
        runId: next.run.id,
        workflowRef: next.run.workflowRef,
        stepId: step.id,
        loop: gateLoop,
      };
      const judgeState = { invoked: false, errored: false };
      const innerJudge = options.summaryJudge === undefined ? buildDefaultSummaryJudge() : options.summaryJudge;
      const summaryJudge: SummaryJudge | null = innerJudge
        ? async (prompt) => {
            judgeState.invoked = true;
            await journalGateEvaluationStart(gateUnit);
            try {
              return await innerJudge(prompt);
            } catch (err) {
              judgeState.errored = true;
              throw err;
            }
          }
        : null;

      const completion = await completeWorkflowStep({
        runId: next.run.id,
        stepId: step.id,
        status: "completed",
        summary,
        evidence: result.evidence,
        summaryJudge,
        leaseHolder,
      });
      const rejection =
        "ok" in completion && completion.ok === false ? (completion as SummaryValidationFailure) : undefined;

      if (judgeState.invoked) {
        await journalGateEvaluationFinish(gateUnit, judgeState.errored, rejection);
      }

      if (!rejection) {
        advanced = true;
        break;
      }
      if (gateLoop < maxLoops) {
        // Feed the rejection back into the next loop's unit prompts — the
        // changed prompt changes each unit's input hash, so the re-run
        // dispatches fresh work instead of reusing the rejected rows.
        gateFeedback = { feedback: rejection.feedback, missing: rejection.missing };
        continue;
      }
      gateRejection = { stepId: step.id, missing: rejection.missing, feedback: rejection.feedback };
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
 *   - `plan_json` NULL → the run predates frozen plans (created before
 *     migration 006). Warn and fall back to compiling from the live asset,
 *     preserving pre-006 behavior for in-flight legacy runs.
 */
async function loadFrozenPlan(runId: string, workflowRef: string): Promise<WorkflowPlanGraph> {
  const row = await withWorkflowRunsRepo((repo) => {
    const run = repo.getRunById(runId);
    return run ? { planJson: run.plan_json, planHash: run.plan_hash } : undefined;
  });

  if (row?.planJson) {
    return parseFrozenPlan(runId, row.planJson, row.planHash);
  }

  warn(
    `Workflow run ${runId} predates frozen plans (no plan_json on the run row); ` +
      `compiling the plan from the live asset ${workflowRef}. New runs freeze their plan at start.`,
  );
  return compileWorkflowAssetPlan(await loadWorkflowAsset(workflowRef));
}
