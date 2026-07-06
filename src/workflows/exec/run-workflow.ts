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
import type { IrStepPlan, WorkflowPlanGraph } from "../ir/schema";
import {
  completeWorkflowStep,
  getNextWorkflowStep,
  type SummaryValidationFailure,
  type WorkflowNextResult,
} from "../runtime/runs";
import { compileWorkflowAssetPlan, loadWorkflowAsset } from "../runtime/workflow-asset-loader";
import { executeStepPlan, type StepExecutionResult, type UnitDispatcher } from "./native-executor";

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
  let unitsDispatched = await withWorkflowRunsRepo((repo) => repo.getUnitsForRun(next.run.id).length);

  // One plan per invocation: the test seam receives the workflow ref; the
  // default reads the run's frozen plan and never touches the asset file.
  const plan = options.loadPlan
    ? await options.loadPlan(next.run.workflowRef)
    : await loadFrozenPlan(next.run.id, next.run.workflowRef);

  // Route bookkeeping (### Route): targets a completed router did NOT select
  // are skipped when the spine reaches them; a target ANY router selected is
  // protected (two routers may share a target).
  const routeSelected = new Set<string>();
  const routeUnselected = new Map<string, { router: string; selected: string }>();

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
      const notes = `Skipped by route: step "${skipInfo.router}" selected "${skipInfo.selected}".`;
      executed.push({ stepId: step.id, ok: true, unitCount: 0, failedUnits: 0, summary: notes });
      await completeWorkflowStep({ runId: next.run.id, stepId: step.id, status: "skipped", notes });
      next = await getNextWorkflowStep(next.run.id);
      continue;
    }

    // `### Depends On` is a declared ordering contract: every dependency must
    // already be resolved before this step dispatches. Execution is sequential
    // (spine order), so a violation means the author ordered steps
    // inconsistently with their declared edges — fail fast, before spending.
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

    const result = await executeStepPlan(stepPlan, {
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

    // Evaluate `### Route` BEFORE completing the step: an unroutable value is
    // an authoring/config failure and must fail the step deterministically
    // rather than letting every branch run sequentially.
    if (stepPlan.route) {
      const decision = evaluateRoute(stepPlan.route, result, next);
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
      routeSelected.add(decision.selected);
      for (const target of decision.targets) {
        if (target !== decision.selected && !routeUnselected.has(target)) {
          routeUnselected.set(target, { router: step.id, selected: decision.selected });
        }
      }
      result.evidence.route = { input: stepPlan.route.input, value: decision.value, selected: decision.selected };
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

type RouteDecision = { ok: true; value: string; selected: string; targets: string[] } | { ok: false; error: string };

/**
 * Resolve a route's input value and pick the branch. Look-up order: the
 * routed step's own result (vote winner, else the single unit's structured
 * result field), then run params, then prior steps' evidence — own-property
 * checks throughout. Only primitive values route; the comparison is exact
 * string equality against the declared `when:` matches.
 *
 * TODO(R1-cutover): this bare-key lookup serves the transitional P1 markdown
 * grammar only. YAML-program routes carry a `${{ … }}` expression in `input`;
 * the executor cutover task resolves those through program/expressions
 * against the journaled step artifacts.
 */
function evaluateRoute(
  route: NonNullable<IrStepPlan["route"]>,
  result: StepExecutionResult,
  next: WorkflowNextResult,
): RouteDecision {
  const candidates: unknown[] = [];

  const vote = result.evidence.vote;
  if (vote && typeof vote === "object" && Object.hasOwn(vote, "winner")) {
    candidates.push((vote as { winner: unknown }).winner);
  }
  if (result.units.length === 1 && result.units[0].result !== undefined) {
    candidates.push(result.units[0].result);
  }

  let value: unknown;
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && Object.hasOwn(candidate, route.input)) {
      value = (candidate as Record<string, unknown>)[route.input];
      break;
    }
  }
  if (value === undefined) {
    const params = next.run.params ?? {};
    if (Object.hasOwn(params, route.input)) {
      value = params[route.input];
    } else {
      for (const s of next.workflow.steps) {
        if (s.evidence && Object.hasOwn(s.evidence, route.input)) {
          value = s.evidence[route.input];
          break;
        }
      }
    }
  }

  if (value === undefined) {
    return {
      ok: false,
      error: `route input "${route.input}" was not found in the step result, run params, or prior evidence.`,
    };
  }
  if (value !== null && typeof value === "object") {
    return {
      ok: false,
      error: `route input "${route.input}" resolved to a non-primitive value; branches match on strings/numbers/booleans.`,
    };
  }

  const valueString = typeof value === "string" ? value : String(value);
  // Own-property check: `when` is author-controlled, and a value such as
  // "constructor" must not resolve through Object.prototype.
  const selected = Object.hasOwn(route.when, valueString) ? route.when[valueString] : route.defaultStepId;
  const targets = [...Object.values(route.when), ...(route.defaultStepId ? [route.defaultStepId] : [])];
  if (!selected) {
    return {
      ok: false,
      error: `value "${valueString}" matched no "when:" branch and the route declares no default.`,
    };
  }
  return { ok: true, value: valueString, selected, targets };
}
