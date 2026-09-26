// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Freeze-time context and step-value helpers shared by `freeze.ts` and every
 * `targets/*.ts` dispatcher. A leaf: it imports no sibling freeze module, so
 * the targets can depend on it without a cycle back through `freeze.ts`.
 */

import type { AkmConfig } from "../../core/config/config-types";
import {
  canonicalResolvedExecutionRequest,
  decodeResolvedExecutionRequest,
  type ResolvedExecutionRequestV1,
} from "../../execution/resolved-request";
import type { UnresolvedExecutionDefaults } from "../../execution/source";
import type { RunnerSpec } from "../../integrations/agent/runner";
import { defaultLlmEngineConcurrency } from "../concurrency-policy";
import type {
  FrozenWorkflowEnvironmentBinding,
  FrozenWorkflowTarget,
  SourceRef,
  WorkflowExec,
  WorkflowExecSpec,
  WorkflowPlan,
  WorkflowStepSpec,
  WorkflowUnitSettings,
} from "../plan";
import { DEFAULT_EXEC_TIMEOUT_MS } from "../resource-limits";
import type { WorkflowAsset } from "../runtime/workflow-asset-loader";

export interface OwnedAsset {
  readonly ref: string;
  readonly bundle: string;
  readonly adapter: string;
  readonly root: string;
  readonly file: string;
}

/** One authored step as freeze sees it: its spec plus its id. */
export type FreezeStep = WorkflowStepSpec & { readonly id: string };

/** The authored unit settings a target resolves from, plus the step's source span and argv. */
export type BaseUnit = WorkflowUnitSettings & { source: SourceRef; exec?: WorkflowExec };

/**
 * Freeze a child workflow. Injected by `freeze.ts` as a plain value so
 * `targets/child-workflow.ts` needs no import of `freeze.ts` (which imports it).
 */
export type ChildFreezeFn = (
  asset: WorkflowAsset,
  refPath: readonly string[],
) => Promise<{ readonly plan: WorkflowPlan }>;

export interface ResolutionContext {
  readonly asset: WorkflowAsset;
  readonly config: AkmConfig;
  /** The compiled (unfrozen) plan being frozen. */
  readonly plan: WorkflowPlan;
  /** Workflow (and composing task) refs from the root to this workflow, for cycle detection. */
  readonly refPath: readonly string[];
  readonly freezeChild: ChildFreezeFn;
}

export interface ResolvedDispatch {
  readonly target: FrozenWorkflowTarget;
  readonly environment: readonly FrozenWorkflowEnvironmentBinding[];
  readonly unit: BaseUnit;
  readonly instructions: string;
  readonly engineAnnouncement?: string;
}

/** The unit's authored settings plus its source span and argv, before any target resolution. */
export function baseUnitOf(source: FreezeStep): BaseUnit {
  return {
    ...(source.unit ? structuredClone(source.unit) : {}),
    source: { ...source.source },
    ...(source.exec ? { exec: { ...source.exec } } : {}),
  };
}

/** Resolve an exec's timeout: unit `timeout:` → document `defaults.timeout` → the default. */
export function freezeExecSpec(source: FreezeStep, exec: WorkflowExec, context: ResolutionContext): WorkflowExecSpec {
  const declared = Object.hasOwn(source.unit ?? {}, "timeoutMs")
    ? source.unit?.timeoutMs
    : context.plan.defaults && Object.hasOwn(context.plan.defaults, "timeoutMs")
      ? context.plan.defaults.timeoutMs
      : undefined;
  return {
    ...exec,
    command: exec.command as [string, ...string[]],
    timeoutMs: declared === undefined ? DEFAULT_EXEC_TIMEOUT_MS : declared,
  };
}

export function targetConcurrency(runner: RunnerSpec, config: AkmConfig): number | undefined {
  if (runner.kind === "llm") {
    const configured = typeof runner.engine === "string" ? config.engines?.[runner.engine] : undefined;
    return defaultLlmEngineConcurrency(
      runner.connection.endpoint,
      configured?.kind === "llm" ? configured.concurrency : undefined,
    );
  }
  if (runner.kind !== "sdk" || !runner.fallbackConnection) return undefined;
  const selected = typeof runner.engine === "string" ? config.engines?.[runner.engine] : undefined;
  const fallbackName = selected?.kind === "agent" ? (selected.llmEngine ?? config.defaults?.llmEngine) : undefined;
  const fallback = fallbackName ? config.engines?.[fallbackName] : undefined;
  return defaultLlmEngineConcurrency(
    runner.fallbackConnection.endpoint,
    fallback?.kind === "llm" ? fallback.concurrency : undefined,
  );
}

/** The request as it may be persisted: its live runtime environment removed. */
export function durableRequest(request: ResolvedExecutionRequestV1): ResolvedExecutionRequestV1 {
  const wire = JSON.parse(canonicalResolvedExecutionRequest(request)) as Record<string, unknown>;
  const runtime = { ...(wire.runtime as Record<string, unknown>) };
  delete runtime.environment;
  wire.runtime = runtime;
  return decodeResolvedExecutionRequest(wire);
}

export function executionUnitValues(
  unit: WorkflowUnitSettings | WorkflowPlan["defaults"],
  workspace: string,
): UnresolvedExecutionDefaults {
  return Object.freeze({
    ...(unit && Object.hasOwn(unit, "engine") ? { engine: unit.engine } : {}),
    ...(unit && Object.hasOwn(unit, "model") ? { model: unit.model } : {}),
    ...(unit && Object.hasOwn(unit, "llm") ? { inference: unit.llm } : {}),
    ...(unit && Object.hasOwn(unit, "timeoutMs") ? { timeout: unit.timeoutMs } : {}),
    ...(unit && "output" in unit && Object.hasOwn(unit, "output") ? { outputSchema: unit.output } : {}),
    workspace,
  }) as UnresolvedExecutionDefaults;
}

/** Step ids declared BEFORE `stepId` — the same ordering `map.over` and `inputs:` rely on. */
export function earlierStepIds(plan: WorkflowPlan, stepId: string): ReadonlySet<string> {
  const index = plan.steps.findIndex((step) => step.stepId === stepId);
  return new Set(index < 0 ? [] : plan.steps.slice(0, index).map((step) => step.stepId));
}

/** THIS workflow's own declared param names — never an outer composing task's. */
export function declaredParamNames(plan: WorkflowPlan): ReadonlySet<string> {
  return new Set(plan.paramSchemas ? Object.keys(plan.paramSchemas) : (plan.params ?? []));
}
