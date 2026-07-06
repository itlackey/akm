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
 * Frozen plan (redesign addendum, R1): the plan graph is read from the run
 * row (`plan_json`, persisted by `startWorkflowRun` under migration 006) with
 * a `plan_hash` integrity check — the workflow asset file is NEVER re-read
 * for an in-flight run, so a mid-run asset edit cannot change behavior.
 * Legacy runs (created before migration 006, NULL plan_json) fall back to
 * compile-from-asset with a warning. Durable-row resume: re-invoking a
 * partially-executed run re-dispatches only work that never completed.
 */

import { UsageError } from "../../core/errors";
import { warn } from "../../core/warn";
import type { WorkflowRunSummary } from "../../sources/types";
import { withWorkflowRunsRepo } from "../../storage/repositories/workflow-runs-repository";
import { computePlanHash } from "../ir/plan-hash";
import type { IrRouteSpec, WorkflowPlanGraph } from "../ir/schema";
import { type ExpressionScope, resolveWholeValue } from "../program/expressions";
import {
  completeWorkflowStep,
  getNextWorkflowStep,
  type SummaryValidationFailure,
  type WorkflowNextResult,
} from "../runtime/runs";
import { compileWorkflowAssetPlan, loadWorkflowAsset } from "../runtime/workflow-asset-loader";
import { executeStepPlan, projectStepOutput, type StepExecutionResult, type UnitDispatcher } from "./native-executor";

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
  let next: WorkflowNextResult = await getNextWorkflowStep(options.target, options.params);
  const executed: ExecutedStepReport[] = [];
  let gateRejection: RunWorkflowResult["gateRejection"];
  const maxSteps = options.maxSteps ?? Number.POSITIVE_INFINITY;

  // Refuse non-active runs BEFORE any dispatch — completeWorkflowStep would
  // reject the completion anyway, but only after the units already ran (and
  // cost money). Mirror its preflight up front.
  if (!next.done && next.run.status !== "active") {
    throw new UsageError(
      `Workflow run ${next.run.id} is ${next.run.status} and cannot be executed. ` +
        `Use \`akm workflow resume ${next.run.id}\` to reopen it first.`,
    );
  }

  // Seed the lifetime unit cap from the journal so it is truly per-RUN: a
  // resumed or re-invoked run must not restart the runaway backstop at zero.
  // Journal rows = past dispatch ATTEMPTS; the executor consumes the cap only
  // on new dispatches (durable-row reuses are free), so a large partially-
  // completed fan-out stays resumable.
  let unitsDispatched = await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(next.run.id).length);

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
      await completeWorkflowStep({ runId: next.run.id, stepId: step.id, status: "skipped", notes });
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
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
            ...(options.maxConcurrency !== undefined ? { maxConcurrency: options.maxConcurrency } : {}),
          });
    unitsDispatched = result.unitsDispatched;

    executed.push({
      stepId: step.id,
      ok: result.ok,
      unitCount: result.units.length,
      failedUnits: result.units.filter((u) => !u.ok).length,
      summary: result.summary,
    });

    if (!result.ok) {
      // Gate spine: record the failure through completeWorkflowStep so the
      // run flips to failed via the normal state derivation.
      await completeWorkflowStep({
        runId: next.run.id,
        stepId: step.id,
        status: "failed",
        notes: result.summary,
        evidence: result.evidence,
      });
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
        });
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

    const completion = await completeWorkflowStep({
      runId: next.run.id,
      stepId: step.id,
      status: "completed",
      summary: result.summary,
      evidence: result.evidence,
    });
    if ("ok" in completion && completion.ok === false) {
      const rejection = completion as SummaryValidationFailure;
      gateRejection = { stepId: step.id, missing: rejection.missing, feedback: rejection.feedback };
      break;
    }

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
    let plan: WorkflowPlanGraph;
    try {
      plan = JSON.parse(row.planJson) as WorkflowPlanGraph;
    } catch {
      throw new UsageError(
        `Workflow run ${runId} has a corrupt frozen plan (plan_json is not valid JSON). ` +
          `The journaled plan cannot be executed — start a new run.`,
      );
    }
    if (computePlanHash(plan) !== row.planHash) {
      throw new UsageError(
        `Workflow run ${runId} failed the frozen-plan integrity check: plan_json does not match plan_hash. ` +
          `The journaled plan was modified after the run started — refusing to execute it. Start a new run.`,
      );
    }
    return plan;
  }

  warn(
    `Workflow run ${runId} predates frozen plans (no plan_json on the run row); ` +
      `compiling the plan from the live asset ${workflowRef}. New runs freeze their plan at start.`,
  );
  return compileWorkflowAssetPlan(await loadWorkflowAsset(workflowRef));
}

type RouteDecision = { ok: true; value: string; selected: string } | { ok: false; error: string };

/** `selected: null` = the router itself was skipped, so it selected nothing. */
type RouteSkipInfo = { router: string; selected: string | null };

/**
 * Cascade a SKIPPED router: it never evaluated its route, so every declared
 * target (branches + default) is marked skip-on-reach unless an earlier
 * router already claimed it. Protection for targets some completed router DID
 * select is applied at consumption time via `routeSelected`. Shared by the
 * live skip path and the journal replay so the two cannot drift.
 */
function cascadeSkippedRouter(route: IrRouteSpec, routerId: string, routeUnselected: Map<string, RouteSkipInfo>): void {
  const targets = [...Object.values(route.when), ...(route.defaultStepId ? [route.defaultStepId] : [])];
  for (const target of targets) {
    if (!routeUnselected.has(target)) {
      routeUnselected.set(target, { router: routerId, selected: null });
    }
  }
}

/**
 * Record one router's decision in the engine's skip bookkeeping: the selected
 * target is protected, every other declared target (branches + default) is
 * marked skip-on-reach unless an earlier router already claimed it. Shared by
 * the live evaluation path and the journal replay so the two cannot drift.
 */
function applyRouteDecision(
  route: IrRouteSpec,
  routerId: string,
  selected: string,
  routeSelected: Set<string>,
  routeUnselected: Map<string, RouteSkipInfo>,
): void {
  routeSelected.add(selected);
  const targets = [...Object.values(route.when), ...(route.defaultStepId ? [route.defaultStepId] : [])];
  for (const target of targets) {
    if (target !== selected && !routeUnselected.has(target)) {
      routeUnselected.set(target, { router: routerId, selected });
    }
  }
}

/**
 * Replay journaled route decisions into the skip bookkeeping (resume path).
 * For every COMPLETED route step of the frozen plan, in spine order:
 *
 *   1. the decision journaled on the step's evidence (`evidence.route.selected`,
 *      written by the engine when it completed the route) wins;
 *   2. a completed route step WITHOUT a journaled decision (e.g. advanced
 *      manually via `akm workflow complete`) is re-derived deterministically
 *      from the frozen plan + journaled step evidence — still a pure function
 *      of journaled results;
 *   3. if neither yields a decision, fail loudly: dispatching the unselected
 *      branch targets would run the wrong branch and spend money. The manual
 *      loop (`next`/`complete`) remains available.
 *
 * A route step that was itself SKIPPED (an unselected target of an earlier
 * router, or skipped manually) never decided anything: its declared targets
 * cascade into the skip set exactly as on the live path — otherwise a resumed
 * run would dispatch every branch of the skipped router (peer review R1).
 */
function seedJournaledRouteDecisions(
  plan: WorkflowPlanGraph,
  state: WorkflowNextResult,
  routeSelected: Set<string>,
  routeUnselected: Map<string, RouteSkipInfo>,
): void {
  const evidence: Record<string, Record<string, unknown> | undefined> = {};
  for (const s of state.workflow.steps) evidence[s.id] = s.evidence;

  for (const stepPlan of plan.steps) {
    if (!stepPlan.route) continue;
    const stepState = state.workflow.steps.find((s) => s.id === stepPlan.stepId);
    if (!stepState) continue;
    if (stepState.status === "skipped") {
      cascadeSkippedRouter(stepPlan.route, stepPlan.stepId, routeUnselected);
      continue;
    }
    if (stepState.status !== "completed") continue;

    let selected = journaledRouteSelection(stepState.evidence);
    if (selected === undefined) {
      const scope: ExpressionScope = {
        params: state.run.params ?? {},
        stepOutputs: routeStepOutputs(evidence, stepPlan.stepId, stepState.evidence ?? {}),
      };
      const decision = evaluateRoute(stepPlan.route, scope);
      if (decision.ok) selected = decision.selected;
    }
    if (selected === undefined) {
      throw new UsageError(
        `Workflow run ${state.run.id} has a completed route step "${stepPlan.stepId}" with no journaled route ` +
          `decision, and the decision cannot be re-derived from the journaled evidence. Refusing to guess which ` +
          `branch was selected — advance the remaining steps manually with \`akm workflow complete\`.`,
      );
    }
    applyRouteDecision(stepPlan.route, stepPlan.stepId, selected, routeSelected, routeUnselected);
  }
}

/** The `selected` target journaled on a route step's evidence, if well-formed. */
function journaledRouteSelection(evidence: Record<string, unknown> | undefined): string | undefined {
  const route = evidence?.route;
  if (typeof route !== "object" || route === null || Array.isArray(route)) return undefined;
  const selected = (route as Record<string, unknown>).selected;
  return typeof selected === "string" && selected !== "" ? selected : undefined;
}

/**
 * The `stepOutputs` scope a route resolves against: every prior step's
 * recorded evidence plus the just-finished step's fresh evidence (which has
 * not been persisted yet when the route is evaluated) — each projected
 * through {@link projectStepOutput}, so `steps.<id>.output` addresses the
 * promoted step artifact for engine-executed steps and the raw recorded
 * evidence for manually-completed ones. Same projection as unit templates
 * (native-executor), so the two scopes cannot drift.
 */
function routeStepOutputs(
  evidence: Record<string, Record<string, unknown> | undefined>,
  currentStepId: string,
  currentEvidence: Record<string, unknown>,
): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  for (const [stepId, stepEvidence] of Object.entries(evidence)) {
    if (stepEvidence !== undefined) outputs[stepId] = projectStepOutput(stepEvidence);
  }
  outputs[currentStepId] = projectStepOutput(currentEvidence);
  return outputs;
}

/**
 * Resolve a route's input (a single whole-value `${{ … }}` reference — the
 * IR v2 shape) and pick the branch. No ambient key search: the reference
 * names its producer explicitly. Only primitive values route; the comparison
 * is exact string equality against the declared `when:` matches.
 */
function evaluateRoute(route: IrRouteSpec, scope: ExpressionScope): RouteDecision {
  const resolved = resolveWholeValue(route.input, scope);
  if (!resolved.ok) {
    return {
      ok: false,
      error: `route input ${route.input} failed to resolve: ${resolved.error.message}`,
    };
  }
  const value = resolved.value;
  if (typeof value === "object" && value !== null) {
    return {
      ok: false,
      error: `route input ${route.input} resolved to a non-primitive value; branches match on strings/numbers/booleans.`,
    };
  }

  const valueString = typeof value === "string" ? value : String(value);
  // Own-property check: `when` is author-controlled, and a value such as
  // "constructor" must not resolve through Object.prototype.
  const selected = Object.hasOwn(route.when, valueString) ? route.when[valueString] : route.defaultStepId;
  if (!selected) {
    return {
      ok: false,
      error: `value "${valueString}" matched no "when:" branch and the route declares no default.`,
    };
  }
  return { ok: true, value: valueString, selected };
}
