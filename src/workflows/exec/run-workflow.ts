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
 * The plan graph is compiled fresh from the workflow asset each step
 * (durable-row resume: re-running a partially-executed run re-dispatches only
 * steps that never completed).
 */

import { UsageError } from "../../core/errors";
import type { WorkflowRunSummary } from "../../sources/types";
import { withWorkflowRunsRepo } from "../../storage/repositories/workflow-runs-repository";
import { compileWorkflowPlan } from "../ir/compile";
import type { WorkflowPlanGraph } from "../ir/schema";
import {
  completeWorkflowStep,
  getNextWorkflowStep,
  type SummaryValidationFailure,
  type WorkflowNextResult,
} from "../runtime/runs";
import { loadWorkflowAsset } from "../runtime/workflow-asset-loader";
import { executeStepPlan, type UnitDispatcher } from "./native-executor";

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
