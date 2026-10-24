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
 * SECRET-FREE, by construction (§4.6's closed print list): a resolved
 * reference VALUE is never printed (references resolve at pre-attempt, not
 * here); a `literal` **environment** binding's value is never printed (only
 * `environment[].kind`/`.name`, and an `env-ref`'s `.ref`/`.keys`/
 * `.secretNames` — all NAMES); `request.command.content`,
 * `request.persona`, `request.conversation`, `request.runtime.environment`,
 * and a script target's `bytesBase64` are never read at all.
 */

import path from "node:path";
import { loadConfig } from "../../core/config/config";
import type { TaskInputBinding } from "../../execution/input-contract";
import type { LoweringNotice } from "../../execution/resolved-request";
import { buildExecutionFromWire } from "../../integrations/agent/execution";
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
import { loadWorkflowAsset } from "../../workflows/runtime/workflow-asset-loader";

/** The step's dispatch unit — the map template for a fan-out, else the root unit. Undefined for a route step. */
function stepUnit(step: WorkflowPlanStep): WorkflowUnitNode | undefined {
  const root = step.root;
  if (!root) return undefined;
  return root.kind === "map" ? root.template : root;
}

function projectEnvironmentBinding(binding: FrozenWorkflowEnvironmentBinding): Record<string, unknown> {
  if (binding.kind === "env-ref") {
    return { kind: binding.kind, ref: binding.ref, keys: binding.keys, secretNames: binding.secretNames };
  }
  // literal / pass-through: kind + name only — a literal's VALUE is never printed.
  return { kind: binding.kind, name: binding.name };
}

function projectInputBinding(binding: TaskInputBinding): Record<string, unknown> {
  return binding.kind === "literal"
    ? { name: binding.name, kind: "literal", value: binding.value }
    : { name: binding.name, kind: "reference", from: binding.from };
}

function childExportedOutputNames(frozenPlan: WorkflowPlan): readonly string[] {
  return frozenPlan.outputs ? Object.keys(frozenPlan.outputs) : ["runId", "status"];
}

/**
 * A `child-workflow` target's `expansion`. Recurses into the embedded
 * plan's own steps in the identical shape — `usesById` is
 * omitted for the recursive call because a nested child's own authored
 * source is not available here (only its already-frozen plan is), so a
 * task-wrapped step nested inside a child conservatively reports `via:
 * "direct"` rather than guessing at its authoring surface.
 */
function childExpansion(target: FrozenChildWorkflowTarget): Record<string, unknown> {
  return {
    via: "child",
    childRef: target.ref,
    childPlanHash: target.planHash,
    childVia: target.via,
    ...(target.taskRef !== undefined ? { childTaskRef: target.taskRef } : {}),
    childOutputs: childExportedOutputNames(target.frozenPlan),
    steps: target.frozenPlan.steps.map((step, index) => projectStep(step, index, undefined)),
  };
}

/** The task/child expansion boundary for one step (§4.6). */
function stepExpansion(
  step: WorkflowPlanStep,
  frozenTarget: FrozenWorkflowTarget | undefined,
  usesById: ReadonlyMap<string, string | undefined> | undefined,
): Record<string, unknown> {
  if (frozenTarget?.kind === "child-workflow") return childExpansion(frozenTarget);
  const uses = usesById?.get(step.stepId);
  if (uses?.startsWith("tasks/")) return { via: "task", taskRef: uses };
  return { via: "direct" };
}

function projectStep(
  step: WorkflowPlanStep,
  sequenceIndex: number,
  usesById: ReadonlyMap<string, string | undefined> | undefined,
): Record<string, unknown> {
  const unit = stepUnit(step);
  const frozenTarget = unit?.frozenTarget;
  const kind = step.route ? "route" : step.root?.kind === "map" ? "map" : "unit";
  const inputBindings = frozenTarget?.inputBindings;
  return {
    stepId: step.stepId,
    sequenceIndex,
    kind,
    targetKind: frozenTarget?.kind ?? null,
    ...(step.root?.kind === "map" ? { concurrency: step.root.concurrency } : {}),
    inputs: unit?.inputs ?? [],
    environment: (unit?.environment ?? []).map(projectEnvironmentBinding),
    ...(inputBindings && inputBindings.length > 0 ? { inputBindings: inputBindings.map(projectInputBinding) } : {}),
    gate: {
      criteria: step.gate.criteria,
      maxLoops: step.gate.maxLoops,
      judgeEngine: step.gate.frozenJudge ? step.gate.frozenJudge.request.engine.name : null,
    },
    ...(step.outputSchema !== undefined ? { outputSchema: step.outputSchema } : {}),
    expansion: stepExpansion(step, frozenTarget, usesById),
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

/**
 * Compile + freeze `ref` and project the frozen plan into the read-only
 * `akm workflow plan` envelope. Never publishes, never writes, never warns.
 */
export async function akmWorkflowPlan(ref: string): Promise<Record<string, unknown>> {
  const asset = await loadWorkflowAsset(ref);
  const config = loadConfig();
  const frozen = await freezeWorkflow(asset, config);
  const plan = frozen.plan;

  const usesById = new Map(asset.plan.steps.map((step) => [step.stepId, step.spec?.uses] as const));
  const sourceFormat = path.extname(asset.path).toLowerCase() === ".md" ? "markdown" : "github-yaml";

  return {
    ok: true,
    ref: asset.ref,
    title: asset.title,
    sourceFormat,
    sourcePath: asset.path,
    irVersion: plan.irVersion,
    planHash: computePlanHash(plan),
    published: false as const,
    execution: plan.execution,
    ...(plan.budget ? { budget: plan.budget } : {}),
    ...(plan.params ? { params: plan.params } : {}),
    ...(plan.outputs ? { outputs: plan.outputs } : {}),
    steps: plan.steps.map((step, index) => projectStep(step, index, usesById)),
    notices: collectLoweringNotices(plan, config),
    warnings: frozen.warnings.map((warning) => warning.message),
  };
}
