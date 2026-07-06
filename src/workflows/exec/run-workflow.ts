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
 * The plan graph is compiled fresh from the workflow asset at the start of
 * each invocation (once per `runWorkflowSteps` call, not per step — the run's
 * step snapshot is fixed at start time, so a mid-invocation asset edit must
 * not change the plan under the loop). Durable-row resume: re-invoking a
 * partially-executed run re-dispatches only work that never completed.
 */

import { UsageError } from "../../core/errors";
import type { WorkflowRunSummary } from "../../sources/types";
import { withWorkflowRunsRepo } from "../../storage/repositories/workflow-runs-repository";
import { compileWorkflowPlan } from "../ir/compile";
import type { IrStepPlan, WorkflowPlanGraph } from "../ir/schema";
import {
  completeWorkflowStep,
  getNextWorkflowStep,
  type SummaryValidationFailure,
  type WorkflowNextResult,
} from "../runtime/runs";
import { loadWorkflowAsset } from "../runtime/workflow-asset-loader";
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
  /** Test seam: plan loader (defaults to loadWorkflowAsset + compile). */
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
  const loadPlan =
    options.loadPlan ??
    (async (workflowRef: string) => compileWorkflowPlan((await loadWorkflowAsset(workflowRef)).document));

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

  // Compile once per workflow ref; the asset snapshot is stable for a run.
  const plan = await loadPlan(next.run.workflowRef);

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

type RouteDecision = { ok: true; value: string; selected: string; targets: string[] } | { ok: false; error: string };

/**
 * Resolve a route's input value and pick the branch. Look-up order: the
 * routed step's own result (vote winner, else the single unit's structured
 * result field), then run params, then prior steps' evidence — own-property
 * checks throughout. Only primitive values route; the comparison is exact
 * string equality against the declared `when:` matches.
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
  const selected = route.branches.find((b) => b.match === valueString)?.stepId ?? route.defaultStepId;
  const targets = [...route.branches.map((b) => b.stepId), ...(route.defaultStepId ? [route.defaultStepId] : [])];
  if (!selected) {
    return {
      ok: false,
      error: `value "${valueString}" matched no "when:" branch and the route declares no default.`,
    };
  }
  return { ok: true, value: valueString, selected, targets };
}
