// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm workflow plan <ref>` — compile + freeze WITHOUT publishing. Zero
 * durable writes, zero usage/event rows: this module calls exactly the same
 * two functions `startWorkflowRun` does to reach a frozen plan
 * (`loadWorkflowAsset`, `freezeWorkflow`) and NOTHING else — never
 * `publishWorkflowRunV4`, `startWorkflowRun`, `appendEvent`, or `akmIndex`.
 *
 * SECRET-FREE, by construction (§4.6's closed print list): a step's
 * `orchestration` is the authored argv, cwd and env names plus the
 * bundle-qualified refs they resolve to (the projection `akm show` prints,
 * never a value or a path); a resolved reference VALUE is never printed (references resolve at pre-attempt, not
 * here); a `literal` **environment** binding's value is never printed (only
 * `environment[].kind`/`.name`, and an `env-ref`'s `.ref` — all NAMES);
 * `request.command.content`,
 * `request.persona`, `request.conversation`, `request.runtime.environment`,
 * and a script target's `bytesBase64` are never read at all.
 */

import { loadConfig } from "../../core/config/config";
import { NotFoundError } from "../../core/errors";
import type { TaskInputBinding } from "../../execution/input-contract";
import type { LoweringNotice } from "../../execution/resolved-request";
import { buildExecutionFromWire } from "../../integrations/agent/execution";
import type { WorkflowStepOrchestrationSummary } from "../../sources/types";
import { freezeWorkflow } from "../../workflows/freeze/freeze";
import { computePlanHash } from "../../workflows/ir/plan-hash";
import type {
  FrozenChildWorkflowTarget,
  FrozenWorkflowCommandTarget,
  FrozenWorkflowEnvironmentBinding,
  FrozenWorkflowTarget,
  WorkflowPlan,
  WorkflowPlanStep,
  WorkflowUnitNode,
} from "../../workflows/plan";
import { resolveOrchestrationRefs, summarizeStepOrchestration } from "../../workflows/renderer";
import { loadWorkflowAsset } from "../../workflows/runtime/workflow-asset-loader";

/** The step's dispatch unit — the map template for a fan-out, else the root unit. Undefined for a step not yet frozen. */
function stepUnit(step: WorkflowPlanStep): WorkflowUnitNode | undefined {
  const root = step.root;
  if (!root) return undefined;
  return root.kind === "map" ? root.template : root;
}

function projectEnvironmentBinding(binding: FrozenWorkflowEnvironmentBinding): Record<string, unknown> {
  if (binding.kind === "env-ref") {
    return { kind: binding.kind, ref: binding.ref };
  }
  // literal / pass-through: kind + name only — a literal's VALUE is never printed.
  return { kind: binding.kind, name: binding.name };
}

function projectInputBinding(binding: TaskInputBinding): Record<string, unknown> {
  return binding.kind === "literal"
    ? { name: binding.name, kind: "literal", value: binding.value }
    : { name: binding.name, kind: "reference", from: binding.from };
}

/** A `child-workflow` target's `expansion`. Recurses into the embedded plan's own steps in the identical shape. */
function childExpansion(target: FrozenChildWorkflowTarget): Record<string, unknown> {
  return {
    via: "child",
    childRef: target.ref,
    childPlanHash: target.planHash,
    steps: target.frozenPlan.steps.map((step, index) =>
      projectStep(step, index, stepOrchestration(step, target.frozenPlan)),
    ),
  };
}

/** The child expansion boundary for one step (§4.6). */
function stepExpansion(frozenTarget: FrozenWorkflowTarget | undefined): Record<string, unknown> {
  return frozenTarget?.kind === "child-workflow" ? childExpansion(frozenTarget) : { via: "direct" };
}

/**
 * The step's `show` orchestration projection plus the refs it resolves to.
 * `authored` is the compiled step (it keeps the spelling the author wrote);
 * a child plan's steps have only their frozen form.
 */
function stepOrchestration(
  step: WorkflowPlanStep,
  plan: Pick<WorkflowPlan, "defaults">,
): WorkflowStepOrchestrationSummary | undefined {
  const summary = summarizeStepOrchestration(step, plan.defaults);
  return summary && resolveOrchestrationRefs(summary);
}

function projectStep(
  step: WorkflowPlanStep,
  sequenceIndex: number,
  orchestration?: WorkflowStepOrchestrationSummary,
): Record<string, unknown> {
  const unit = stepUnit(step);
  const frozenTarget = unit?.frozenTarget;
  const kind = step.root?.kind === "map" ? "map" : "unit";
  const inputBindings = frozenTarget?.inputBindings;
  return {
    stepId: step.stepId,
    sequenceIndex,
    kind,
    targetKind: frozenTarget?.kind ?? null,
    ...(step.root?.kind === "map" ? { concurrency: step.root.concurrency } : {}),
    inputs: unit?.inputs ?? [],
    ...(orchestration ? { orchestration } : {}),
    environment: (unit?.environment ?? []).map(projectEnvironmentBinding),
    ...(inputBindings && inputBindings.length > 0 ? { inputBindings: inputBindings.map(projectInputBinding) } : {}),
    gate: {
      criteria: step.gate.criteria,
      maxLoops: step.gate.maxLoops,
      judgeEngine: step.gate.frozenJudge ? step.gate.frozenJudge.request.engine.name : null,
    },
    ...(step.outputSchema !== undefined ? { outputSchema: step.outputSchema } : {}),
    expansion: stepExpansion(frozenTarget),
  };
}

/**
 * Every `command`-kind frozen target's lowering notices, recomputed PURELY
 * from its own already-frozen `request` (the identical computation
 * `freeze/targets/command.ts`'s `commandResult` already performs at freeze
 * time and discards) — walked over the whole plan, including gate judges and
 * recursively into every embedded child plan. Read-only: `buildExecutionFromWire`
 * reads no config and dispatches nothing.
 */
function collectLoweringNotices(plan: WorkflowPlan, config: ReturnType<typeof loadConfig>): LoweringNotice[] {
  const notices: LoweringNotice[] = [];
  const lower = (target: FrozenWorkflowCommandTarget): void => {
    notices.push(...buildExecutionFromWire(target).notices);
  };
  for (const step of plan.steps) {
    const unit = stepUnit(step);
    if (unit) {
      if (unit.frozenTarget.kind === "command") lower(unit.frozenTarget);
      else if (unit.frozenTarget.kind === "child-workflow")
        notices.push(...collectLoweringNotices(unit.frozenTarget.frozenPlan, config));
    }
    if (step.gate.frozenJudge) lower(step.gate.frozenJudge);
  }
  return notices;
}

/** Every ref the steps' orchestration names that no bundle owns, as `ref (where of step "id")`. */
function unresolvedRefs(
  steps: readonly WorkflowPlanStep[],
  orchestrations: ReadonlyArray<WorkflowStepOrchestrationSummary | undefined>,
): string[] {
  return orchestrations.flatMap((orchestration, index) =>
    (orchestration?.unresolved ?? []).map(
      (missing) => `${missing.ref} (${missing.in} of step "${steps[index]?.stepId}")`,
    ),
  );
}

/** The unresolved refs of every embedded child plan, recursively, each prefixed with the child workflow it is in. */
function unresolvedInChildren(plan: WorkflowPlan): string[] {
  return plan.steps.flatMap((step) => {
    const target = stepUnit(step)?.frozenTarget;
    if (target?.kind !== "child-workflow") return [];
    const child = target.frozenPlan;
    const own = unresolvedRefs(
      child.steps,
      child.steps.map((childStep) => stepOrchestration(childStep, child)),
    );
    return [...own.map((entry) => `${entry} in child ${target.ref}`), ...unresolvedInChildren(child)];
  });
}

function failOnUnresolved(ref: string, unresolved: readonly string[]): void {
  if (unresolved.length === 0) return;
  throw new NotFoundError(
    `Workflow ${ref} names asset(s) that no bundle owns: ${unresolved.join(", ")}.`,
    "FILE_NOT_FOUND",
  );
}

/**
 * Compile + freeze `ref` and project the frozen plan into the read-only
 * `akm workflow plan` envelope. Never publishes, never writes, never warns.
 */
export async function akmWorkflowPlan(ref: string): Promise<Record<string, unknown>> {
  const asset = await loadWorkflowAsset(ref);
  // Resolve what the authored steps name before freezing: a `${ref}`, env ref or child workflow no bundle owns fails the plan.
  const orchestrations = asset.plan.steps.map((step) => stepOrchestration(step, asset.plan));
  failOnUnresolved(asset.ref, unresolvedRefs(asset.plan.steps, orchestrations));
  const config = loadConfig();
  const frozen = await freezeWorkflow(asset, config);
  const plan = frozen.plan;
  // A child workflow's steps exist only once frozen; they fail the plan exactly as the top level's do.
  failOnUnresolved(asset.ref, unresolvedInChildren(plan));

  return {
    ok: true,
    ref: asset.ref,
    title: asset.title,
    sourceFormat: "markdown",
    sourcePath: asset.path,
    irVersion: plan.irVersion,
    planHash: computePlanHash(plan),
    published: false as const,
    execution: plan.execution,
    ...(plan.budget ? { budget: plan.budget } : {}),
    ...(plan.params ? { params: plan.params } : {}),
    steps: plan.steps.map((step, index) => projectStep(step, index, orchestrations[index])),
    notices: collectLoweringNotices(plan, config),
    warnings: frozen.warnings.map((warning) => warning.message),
  };
}
