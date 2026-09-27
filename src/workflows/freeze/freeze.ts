// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Freeze a compiled workflow plan into the plan a run executes. Every step's
 * authored spec resolves through the shared command/task authorities into a
 * frozen `root` (engine, model, timeout, concurrency, dispatch target and
 * environment descriptors); gates get their judge; the compile-only fields are
 * dropped; the source file's sha256 is recorded. Nothing is published here.
 */

import { createHash } from "node:crypto";
import type { AkmConfig } from "../../core/config/config";
import { ConfigError, UsageError } from "../../core/errors";
import { warn } from "../../core/warn";
import { NO_ENGINE_MESSAGE_SUFFIX } from "../../integrations/agent/engine-fallback";
import { resolveExecution } from "../../integrations/agent/execution";
import { checkWorkflowPlan } from "../compile";
import { defaultMapConcurrency, workflowMaxConcurrency } from "../concurrency-policy";
import { canonicalJson } from "../ir/plan-hash";
import {
  type FrozenWorkflowCommandTarget,
  WORKFLOW_PLAN_VERSION,
  type WorkflowError,
  type WorkflowExecNode,
  type WorkflowPlan,
  type WorkflowPlanStep,
  type WorkflowUnitNode,
} from "../plan";
import type { WorkflowAsset } from "../runtime/workflow-asset-loader";
import { classifyWorkflowStepUses } from "../source-semantics";
import { assertChildOutputReferences } from "./child-output-references";
import { qualifyRef } from "./environment";
import { baseUnitOf, type FreezeStep, type ResolutionContext, type ResolvedDispatch } from "./step-values";
import { childWorkflowDispatch } from "./targets/child-workflow";
import { commandDispatch, commandResult } from "./targets/command";
import { directScript } from "./targets/script";
import { directShell } from "./targets/shell";
import { taskDispatch } from "./targets/task";

export interface FrozenWorkflow {
  readonly plan: WorkflowPlan;
  /** Non-fatal advisories from `checkWorkflowPlan`. */
  readonly warnings: WorkflowError[];
  /** The implicit engine fallback, announced once at run creation. */
  readonly engineAnnouncement?: string;
}

/** Resolve and freeze one workflow (and, recursively, every child it composes). */
export async function freezeWorkflow(
  asset: WorkflowAsset,
  config: AkmConfig,
  refPath: readonly string[] = [asset.ref],
): Promise<FrozenWorkflow> {
  const compiled = asset.plan;
  const checked = checkWorkflowPlan(compiled);
  if (!checked.ok) {
    throw new UsageError(
      checked.errors.map((error) => `${asset.path}:${error.line}: ${error.message}`).join("\n"),
      "WORKFLOW_SOURCE_INVALID",
    );
  }
  const context: ResolutionContext = {
    asset,
    config,
    plan: compiled,
    refPath,
    freezeChild: (child, childRefPath) => freezeWorkflow(child, config, childRefPath),
  };
  let engineAnnouncement: string | undefined;
  const steps: WorkflowPlanStep[] = [];
  for (const step of compiled.steps) {
    const { spec, ...frozenStep } = step;
    const source: FreezeStep = { ...(spec ?? { source: { path: asset.path, start: 1, end: 1 } }), id: step.stepId };
    let root: WorkflowExecNode | undefined;
    if (!step.route) {
      const resolved = await resolveStep(source, context);
      engineAnnouncement ??= resolved.engineAnnouncement;
      root = frozenRoot(step.stepId, source, resolved, compiled, config);
    }
    let frozenJudge: FrozenWorkflowCommandTarget | null = null;
    if (step.gate.criteria.length > 0) {
      const judge = resolveJudge(source, step.gate.criteria[0] ?? "", context);
      if (judge) {
        frozenJudge = judge.target as FrozenWorkflowCommandTarget;
        engineAnnouncement ??= judge.engineAnnouncement;
      } else {
        warn(
          `Workflow step "${step.stepId}" has completion criteria but no verification engine is available ` +
            "(set workflow.judgeEngine, defaults.engine, or install an opencode-sdk binary). The step will block " +
            "for `akm workflow resume` once it is reached.",
        );
      }
    }
    steps.push({ ...frozenStep, ...(root ? { root } : {}), gate: { ...step.gate, frozenJudge } });
  }
  assertChildOutputReferences(steps);
  const plan: WorkflowPlan = {
    irVersion: WORKFLOW_PLAN_VERSION,
    title: asset.title,
    ...(compiled.params ? { params: compiled.params } : {}),
    ...(compiled.paramSchemas ? { paramSchemas: compiled.paramSchemas } : {}),
    ...(compiled.budget ? { budget: compiled.budget } : {}),
    ...(compiled.outputs ? { outputs: compiled.outputs } : {}),
    execution: { maxConcurrency: workflowMaxConcurrency(config.workflow?.maxConcurrency) },
    sourceHash: asset.sourceHash,
    steps,
  };
  return { plan, warnings: checked.warnings, ...(engineAnnouncement ? { engineAnnouncement } : {}) };
}

async function resolveStep(source: FreezeStep, context: ResolutionContext): Promise<ResolvedDispatch> {
  const baseUnit = baseUnitOf(source);
  if (source.exec) return directShell(source, baseUnit, context);
  if (!source.uses) throw new Error(`workflow step ${source.id} has neither exec nor uses`);
  const target = classifyWorkflowStepUses(source.uses);
  if (target.kind === "task") return taskDispatch(source, baseUnit, target.ref, context);
  if (target.kind === "workflow") {
    return childWorkflowDispatch({
      source,
      baseUnit,
      childRefInput: target.ref,
      context,
      via: "direct",
      authoredInputs: { kind: "with", value: source.with },
    });
  }
  // `commands/<ref>` and `scripts/<ref>` are not binding surfaces; `akm/command`'s
  // `with:` is its own argument bag.
  if (target.kind !== "builtin-command" && source.with !== undefined) {
    const family = target.kind === "command" ? "commands" : "scripts";
    throw new UsageError(
      `Workflow step ${source.id} cannot pass with: to ${family} target ${target.ref}; a ${target.kind} ref is not a binding surface.`,
      "COMPOSITION_INVALID",
    );
  }
  if (target.kind === "script") return directScript(source, baseUnit, target.ref, context);
  const action =
    target.kind === "builtin-command"
      ? source.with
      : { ref: qualifyRef(target.ref, "commands", context.asset, context.config) };
  return commandDispatch(source, baseUnit, action, context);
}

/** The gate judge's frozen command target, or undefined when no engine is available and none is configured. */
function resolveJudge(source: FreezeStep, rubric: string, context: ResolutionContext): ResolvedDispatch | undefined {
  const configuredEngine = context.config.workflow?.judgeEngine;
  try {
    const prepared = resolveExecution({
      content: rubric.trim() || "Judge workflow completion.",
      config: context.config,
      ...(configuredEngine ? { current: { engine: configuredEngine } } : {}),
    });
    return commandResult(source, { onError: "fail", source: source.source }, prepared, context);
  } catch (err) {
    if (configuredEngine || !(err instanceof ConfigError && err.message.includes(NO_ENGINE_MESSAGE_SUFFIX))) throw err;
    return undefined;
  }
}

function frozenRoot(
  stepId: string,
  source: FreezeStep,
  resolved: ResolvedDispatch,
  plan: WorkflowPlan,
  config: AkmConfig,
): WorkflowExecNode {
  const unit = resolved.unit;
  const target =
    resolved.target.kind === "shell"
      ? {
          ...resolved.target,
          contentHash: createHash("sha256")
            .update("akm.workflow.shell.v1\0")
            .update(
              canonicalJson({
                exec: resolved.target.exec,
                environment: resolved.environment,
                cwdIdentity: resolved.target.cwdIdentity,
              }),
            )
            .digest("hex"),
        }
      : resolved.target;
  const node: WorkflowUnitNode = {
    kind: "unit",
    id: source.map ? `${stepId}.unit` : stepId,
    instructions: resolved.instructions,
    ...(source.inputs && source.inputs.length > 0 ? { inputs: [...source.inputs] } : {}),
    ...(unit.output !== undefined ? { schema: unit.output } : {}),
    ...(unit.retry ? { retry: { max: unit.retry.max, on: [...unit.retry.on] } } : {}),
    onError: unit.onError ?? plan.defaults?.onError ?? "fail",
    ...(unit.env ? { env: [...unit.env] } : {}),
    isolation: unit.isolation ?? "none",
    source: { ...source.source },
    frozenTarget: target,
    environment: [...resolved.environment],
  };
  if (!source.map) return node;
  return {
    kind: "map",
    id: `${stepId}.map`,
    over: source.map.over,
    template: node,
    concurrency: source.map.concurrency ?? defaultMapConcurrency(config.workflow?.defaultMapConcurrency),
    reducer: source.map.reducer ?? "collect",
    source: { ...source.source },
  };
}
