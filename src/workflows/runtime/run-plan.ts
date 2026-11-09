// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Reading a run row's frozen plan: the ONE plan decoder and its tolerant
 * row-level wrapper.
 *
 * Only the current irVersion decodes. A plan frozen by an older release comes
 * back from {@link readRunPlan} as a `problem` sentence and the caller decides
 * the remedy (the engine abandons such a run, and `akm workflow run <ref>`
 * starts it afresh). So does a plan that does not decode: no steps, a unit with
 * no frozen target, a request that does not decode. Keys the decoder does not
 * know are kept: the unit `input_hash` and the child invocation key derive from
 * the whole target. A plan a NEWER akm froze (`plan_ir_version` above this
 * release's) is refused unread as `newer` with a problem that names upgrading
 * akm as the remedy.
 */

import { UsageError } from "../../core/errors";
import { warnOnce } from "../../core/warn";
import type { TaskInputBinding } from "../../execution/input-contract";
import { decodeResolvedExecutionRequest, type ResolvedExecutionRequestV1 } from "../../execution/resolved-request";
import { decodeFrozenRunnerSpec, type RunnerSpec } from "../../integrations/agent/runner";
import type { WorkflowRunRow } from "../../storage/repositories/workflow-runs-repository";
import {
  type FrozenLegacyField,
  type FrozenWorkflowCommandTarget,
  type FrozenWorkflowEnvironmentBinding,
  type FrozenWorkflowTarget,
  WORKFLOW_PLAN_VERSION,
  type WorkflowExecNode,
  type WorkflowExecSpec,
  type WorkflowGateNode,
  type WorkflowMapNode,
  type WorkflowPlan,
  type WorkflowPlanStep,
  type WorkflowUnitNode,
} from "../plan";

export type RunPlanRead = { ok: true; plan: WorkflowPlan } | { ok: false; problem: string; newer: boolean };

export function readRunPlan(row: Pick<WorkflowRunRow, "id" | "plan_json" | "plan_ir_version">): RunPlanRead {
  if (!row.plan_json)
    return { ok: false, newer: false, problem: `Workflow run ${row.id} has no frozen workflow plan.` };
  const version = row.plan_ir_version ?? null;
  if (version !== null && version > WORKFLOW_PLAN_VERSION) {
    return {
      ok: false,
      newer: true,
      problem:
        `Workflow run ${row.id} was frozen by a newer akm (plan irVersion ${version}) and this akm ` +
        `(irVersion ${WORKFLOW_PLAN_VERSION}) will not run it. Upgrade akm to continue this run.`,
    };
  }
  if (version !== null && version < WORKFLOW_PLAN_VERSION) {
    return {
      ok: false,
      newer: false,
      problem:
        `Workflow run ${row.id} was frozen as plan irVersion ${version} and this akm (irVersion ` +
        `${WORKFLOW_PLAN_VERSION}) does not run it.`,
    };
  }
  try {
    return { ok: true, plan: decodeWorkflowPlan(JSON.parse(row.plan_json)) };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const frozenAs = version === null ? "" : ` (frozen as plan irVersion ${version})`;
    return {
      ok: false,
      newer: false,
      problem: `Workflow run ${row.id} has a frozen plan this akm cannot decode${frozenAs}: ${detail}.`,
    };
  }
}

export interface FrozenStepRowDefinition {
  stepId: string;
  stepTitle: string;
  instructions: string;
  completionJson: string | null;
  sequenceIndex: number;
}

/** Project persisted spine rows from the plan at publication time. */
export function frozenStepRows(plan: WorkflowPlan): FrozenStepRowDefinition[] {
  return plan.steps.map((step) => ({
    stepId: step.stepId,
    stepTitle: step.title,
    instructions: step.root
      ? step.root.kind === "map"
        ? step.root.template.instructions
        : step.root.instructions
      : "",
    completionJson: step.gate.criteria.length > 0 ? JSON.stringify(step.gate.criteria) : null,
    sequenceIndex: step.sequenceIndex,
  }));
}

/** Decode a stored plan into the one plan type. */
export function decodeWorkflowPlan(input: unknown): WorkflowPlan {
  const raw = record(input, "plan");
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) fail("steps must be a non-empty array");
  const steps = raw.steps.map((value, index) => decodeStep(value, index));
  return {
    ...raw,
    irVersion: typeof raw.irVersion === "number" ? raw.irVersion : WORKFLOW_PLAN_VERSION,
    title: typeof raw.title === "string" ? raw.title : "",
    steps,
  } as WorkflowPlan;
}

function decodeStep(value: unknown, index: number): WorkflowPlanStep {
  const step = record(value, `step ${index}`);
  const stepId = string(step.stepId, `step ${index} stepId`);
  if (step.root === undefined) fail(`step ${stepId} has no frozen root`);
  const root = decodeNode(step.root, stepId);
  return {
    ...step,
    stepId,
    title: typeof step.title === "string" ? step.title : stepId,
    sequenceIndex: index,
    root,
    gate: decodeGate(step.gate, stepId),
  } as WorkflowPlanStep;
}

function decodeNode(value: unknown, stepId: string): WorkflowExecNode {
  const node = record(value, `step ${stepId} root`);
  if (node.kind !== "map") return decodeUnit(node, stepId);
  string(node.over, `step ${stepId} map.over`);
  return {
    ...node,
    concurrency: positiveInteger(node.concurrency) ?? 1,
    reducer: node.reducer === "vote" ? "vote" : "collect",
    template: decodeUnit(record(node.template, `step ${stepId} map template`), stepId),
  } as WorkflowMapNode;
}

function decodeUnit(node: Record<string, unknown>, stepId: string): WorkflowUnitNode {
  const id = string(node.id, `step ${stepId} unit id`);
  const label = `unit ${id}`;
  if (node.frozenTarget === undefined) fail(`${label} has no frozen target`);
  return {
    ...node,
    kind: "unit",
    id,
    instructions: typeof node.instructions === "string" ? node.instructions : "",
    onError: node.onError === "continue" ? "continue" : "fail",
    frozenTarget: decodeTarget(node.frozenTarget, label),
    environment: Array.isArray(node.environment)
      ? node.environment.map((binding, index) => decodeEnvironmentBinding(binding, `${label} environment[${index}]`))
      : [],
  } as WorkflowUnitNode;
}

function decodeGate(value: unknown, stepId: string): WorkflowGateNode {
  const gate = value === undefined ? {} : record(value, `step ${stepId} gate`);
  const criteria = Array.isArray(gate.criteria)
    ? gate.criteria.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  return {
    kind: "gate",
    id: typeof gate.id === "string" ? gate.id : `${stepId}.gate`,
    stepId,
    criteria,
    maxLoops: positiveInteger(gate.maxLoops) ?? 1,
    frozenJudge:
      criteria.length > 0 && gate.frozenJudge !== null && gate.frozenJudge !== undefined
        ? decodeCommandTarget(record(gate.frozenJudge, `gate ${stepId} judge`), `gate ${stepId} judge`)
        : null,
  };
}

function decodeTarget(value: unknown, label: string): FrozenWorkflowTarget {
  const target = record(value, `${label} frozenTarget`);
  const inputBindings = decodeInputBindings(target.inputBindings, label);
  const optional = inputBindings ? { inputBindings } : {};
  switch (target.kind) {
    case "command":
      return decodeCommandTarget(target, label);
    case "shell":
      return {
        kind: "shell",
        contentHash: string(target.contentHash, `${label} contentHash`),
        exec: decodeExec(target.exec, label),
        ...optional,
      };
    case "child-workflow":
      return {
        kind: "child-workflow",
        ref: string(target.ref, `${label} child ref`),
        planHash: string(target.planHash, `${label} planHash`),
        frozenPlan: decodeWorkflowPlan(target.frozenPlan),
        contentHash: string(target.contentHash, `${label} contentHash`),
        ...(inputBindings ? { inputBindings } : {}),
      };
    default:
      return fail(`${label} has an unsupported frozen target kind ${JSON.stringify(target.kind)}`);
  }
}

function decodeCommandTarget(target: Record<string, unknown>, label: string): FrozenWorkflowCommandTarget {
  let request: ResolvedExecutionRequestV1;
  let runner: RunnerSpec;
  try {
    request = decodeResolvedExecutionRequest(target.request);
    runner = decodeFrozenRunnerSpec(target.runner);
  } catch (cause) {
    fail(`${label} request: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const inputBindings = decodeInputBindings(target.inputBindings, label);
  const concurrency = positiveInteger(target.concurrency);
  return {
    kind: "command",
    ref: typeof target.ref === "string" ? target.ref : null,
    contentHash: typeof target.contentHash === "string" ? target.contentHash : "",
    request,
    runner,
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...legacyField(target, "cwdIdentity"),
    ...(inputBindings ? { inputBindings } : {}),
  };
}

/** The `cwdIdentity` a command target froze, kept as stored (see {@link FrozenLegacyField}). */
function legacyField(source: Record<string, unknown>, key: string): { [key: string]: FrozenLegacyField } {
  const value = source[key];
  return value && typeof value === "object" ? { [key]: value as FrozenLegacyField } : {};
}

function decodeExec(value: unknown, label: string): WorkflowExecSpec {
  const exec = record(value, `${label} exec`);
  const command = exec.command;
  if (!Array.isArray(command) || command.length === 0 || !command.every((arg) => typeof arg === "string")) {
    fail(`${label} exec.command must be a non-empty argv`);
  }
  const timeoutMs = exec.timeoutMs;
  if (timeoutMs !== null && typeof timeoutMs !== "number") fail(`${label} exec.timeoutMs must be a number or null`);
  return exec as unknown as WorkflowExecSpec;
}

function decodeInputBindings(value: unknown, label: string): readonly TaskInputBinding[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.map((raw, index) => {
    const binding = record(raw, `${label} inputBindings[${index}]`);
    const name = string(binding.name, `${label} inputBindings[${index}].name`);
    if (binding.kind === "reference") {
      return {
        kind: "reference",
        name,
        from: string(binding.from, `${label} inputBindings[${index}].from`),
        schema: (binding.schema ?? {}) as Record<string, unknown>,
      };
    }
    return { kind: "literal", name, value: binding.value };
  });
}

function decodeEnvironmentBinding(value: unknown, label: string): FrozenWorkflowEnvironmentBinding {
  const binding = record(value, label);
  if (binding.kind === "literal") {
    return { kind: "literal", name: string(binding.name, label), value: String(binding.value ?? "") };
  }
  if (binding.kind === "pass-through") return { kind: "pass-through", name: string(binding.name, label) };
  if (binding.kind !== "env-ref") fail(`${label} has an unsupported kind`);
  return {
    kind: "env-ref",
    ref: string(binding.ref, `${label} ref`),
    precedence: typeof binding.precedence === "number" ? binding.precedence : 0,
  };
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 1 ? (value as number) : undefined;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function fail(message: string): never {
  throw new UsageError(`Invalid frozen workflow plan: ${message}.`, "INVALID_JSON_ARGUMENT");
}
