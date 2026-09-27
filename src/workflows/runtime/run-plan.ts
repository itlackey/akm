// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Reading a run row's frozen plan: the ONE plan decoder and its tolerant
 * row-level wrapper.
 *
 * {@link decodeWorkflowPlan} accepts every plan shape a release has stored —
 * irVersion 4 and 5 (with their `sourceReadSet` and host-identity fields) as
 * well as the current one — and keeps keys it does not know rather than
 * refusing them. It rejects only a plan it cannot run: no steps, a unit with
 * no frozen target, a request that does not decode. `plan_ir_version` and
 * `plan_hash` are informational columns: neither gates execution. A plan that
 * cannot be decoded comes back from {@link readRunPlan} as a `problem`
 * sentence and the caller decides the remedy (the engine abandons such a run
 * instead of throwing) — except for a plan a NEWER akm froze, which is `newer`
 * and whose problem names upgrading akm as the remedy.
 */

import { UsageError } from "../../core/errors";
import { warnOnce } from "../../core/warn";
import type { TaskInputBinding } from "../../execution/input-contract";
import { decodeResolvedExecutionRequest, type ResolvedExecutionRequestV1 } from "../../execution/resolved-request";
import { decodeFrozenRunnerSpec, type RunnerSpec } from "../../integrations/agent/runner";
import type { WorkflowRunRow } from "../../storage/repositories/workflow-runs-repository";
import {
  type FrozenWorkflowCommandTarget,
  type FrozenWorkflowDirectoryIdentity,
  type FrozenWorkflowEnvironmentBinding,
  type FrozenWorkflowEnvironmentOwner,
  type FrozenWorkflowTarget,
  WORKFLOW_PLAN_VERSION,
  type WorkflowExecNode,
  type WorkflowExecSpec,
  type WorkflowGateNode,
  type WorkflowMapNode,
  type WorkflowPlan,
  type WorkflowPlanStep,
  type WorkflowRoute,
  type WorkflowUnitNode,
} from "../plan";

export type RunPlanRead = { ok: true; plan: WorkflowPlan } | { ok: false; problem: string; newer: boolean };

export function readRunPlan(
  row: Pick<WorkflowRunRow, "id" | "plan_json" | "plan_ir_version"> & { workflow_ref?: string },
): RunPlanRead {
  if (!row.plan_json)
    return { ok: false, newer: false, problem: `Workflow run ${row.id} has no frozen workflow plan.` };
  const version = row.plan_ir_version ?? null;
  try {
    const plan = decodeWorkflowPlan(JSON.parse(row.plan_json), {
      ...(row.workflow_ref ? { workflowRef: row.workflow_ref } : {}),
    });
    if (version !== null && version !== WORKFLOW_PLAN_VERSION) {
      warnOnce(
        `workflow-plan-version:${row.id}`,
        `Workflow run ${row.id} was frozen as plan irVersion ${version}; running it with the current engine ` +
          `(irVersion ${WORKFLOW_PLAN_VERSION}).`,
      );
    }
    return { ok: true, plan };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    if (version !== null && version > WORKFLOW_PLAN_VERSION) {
      return {
        ok: false,
        newer: true,
        problem:
          `Workflow run ${row.id} was frozen by a newer akm (plan irVersion ${version}) and this akm cannot decode it: ` +
          `${detail}. Upgrade akm to continue this run.`,
      };
    }
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
      : routeInstructions(step.route as WorkflowRoute),
    completionJson: step.gate.criteria.length > 0 ? JSON.stringify(step.gate.criteria) : null,
    sequenceIndex: step.sequenceIndex,
  }));
}

function routeInstructions(route: WorkflowRoute): string {
  const branches = Object.entries(route.when)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([match, stepId]) => `"${match}" -> ${stepId}`);
  if (route.defaultStepId !== undefined) branches.push(`default -> ${route.defaultStepId}`);
  return `Route on ${route.input}: ${branches.join(", ")}.`;
}

export interface DecodeWorkflowPlanOptions {
  /** The run's workflow ref: lets an older plan's read set supply `sourceHash`. */
  readonly workflowRef?: string;
}

/** Decode a stored plan (any release's) into the one plan type. */
export function decodeWorkflowPlan(input: unknown, options: DecodeWorkflowPlanOptions = {}): WorkflowPlan {
  const raw = record(input, "plan");
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) fail("steps must be a non-empty array");
  const steps = raw.steps.map((value, index) => decodeStep(value, index));
  if (raw.outputs !== undefined) {
    for (const [name, entry] of Object.entries(record(raw.outputs, "outputs"))) {
      string(record(entry, `outputs.${name}`).from, `outputs.${name}.from`);
    }
  }
  const sourceHash =
    typeof raw.sourceHash === "string" ? raw.sourceHash : legacySourceHash(raw.sourceReadSet, options.workflowRef);
  return {
    ...raw,
    irVersion: typeof raw.irVersion === "number" ? raw.irVersion : WORKFLOW_PLAN_VERSION,
    title: typeof raw.title === "string" ? raw.title : "",
    ...(sourceHash ? { sourceHash } : {}),
    steps,
  } as WorkflowPlan;
}

/** Plans frozen before irVersion 6 recorded the source hash inside `sourceReadSet`. */
function legacySourceHash(readSet: unknown, workflowRef: string | undefined): string | undefined {
  if (!workflowRef || !Array.isArray(readSet)) return undefined;
  for (const entry of readSet) {
    const identity = (entry as { identity?: { ref?: unknown; hash?: unknown } } | null)?.identity;
    if (identity?.ref === workflowRef && typeof identity.hash === "string") return identity.hash;
  }
  return undefined;
}

function decodeStep(value: unknown, index: number): WorkflowPlanStep {
  const step = record(value, `step ${index}`);
  const stepId = string(step.stepId, `step ${index} stepId`);
  const route = step.route === undefined ? undefined : decodeRoute(step.route, stepId);
  const root = step.root === undefined ? undefined : decodeNode(step.root, stepId);
  if (!root && !route) fail(`step ${stepId} has neither a frozen root nor a route`);
  return {
    ...step,
    stepId,
    title: typeof step.title === "string" ? step.title : stepId,
    sequenceIndex: index,
    ...(root ? { root } : {}),
    ...(route ? { route } : {}),
    gate: decodeGate(step.gate, stepId),
  } as WorkflowPlanStep;
}

function decodeRoute(value: unknown, stepId: string): WorkflowRoute {
  const route = record(value, `step ${stepId} route`);
  string(route.input, `step ${stepId} route.input`);
  const when = record(route.when, `step ${stepId} route.when`);
  for (const target of Object.values(when)) string(target, `step ${stepId} route target`);
  return route as unknown as WorkflowRoute;
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
    isolation: node.isolation === "worktree" ? "worktree" : "none",
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
  const gitCommitOid = typeof target.gitCommitOid === "string" ? target.gitCommitOid : undefined;
  const optional = {
    ...(gitCommitOid ? { gitCommitOid } : {}),
    ...(inputBindings ? { inputBindings } : {}),
  };
  switch (target.kind) {
    case "command":
      return decodeCommandTarget(target, label);
    case "shell":
      return {
        kind: "shell",
        contentHash: string(target.contentHash, `${label} contentHash`),
        exec: decodeExec(target.exec, label),
        cwdIdentity: record(target.cwdIdentity, `${label} cwdIdentity`) as unknown as FrozenWorkflowDirectoryIdentity,
        ...optional,
      };
    case "script":
      return {
        kind: "script",
        ref: string(target.ref, `${label} script ref`),
        contentHash: string(target.contentHash, `${label} contentHash`),
        exec: decodeExec(target.exec, label),
        interpreter: string(target.interpreter, `${label} interpreter`),
        extension: string(target.extension, `${label} extension`),
        bytesBase64: typeof target.bytesBase64 === "string" ? target.bytesBase64 : fail(`${label} has no script bytes`),
        byteLength: typeof target.byteLength === "number" ? target.byteLength : 0,
        cwdIdentity: record(target.cwdIdentity, `${label} cwdIdentity`) as unknown as FrozenWorkflowDirectoryIdentity,
        materialization: "ephemeral-0700-delete",
        ...optional,
      };
    case "child-workflow":
      return {
        kind: "child-workflow",
        ref: string(target.ref, `${label} child ref`),
        planHash: string(target.planHash, `${label} planHash`),
        frozenPlan: decodeWorkflowPlan(target.frozenPlan),
        contentHash: string(target.contentHash, `${label} contentHash`),
        via: target.via === "task" ? "task" : "direct",
        ...(typeof target.taskRef === "string" ? { taskRef: target.taskRef } : {}),
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
    ...(target.cwdIdentity && typeof target.cwdIdentity === "object"
      ? { cwdIdentity: target.cwdIdentity as FrozenWorkflowDirectoryIdentity }
      : {}),
    ...(typeof target.gitCommitOid === "string" ? { gitCommitOid: target.gitCommitOid } : {}),
    ...(inputBindings ? { inputBindings } : {}),
  };
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
  const strings = (items: unknown): string[] =>
    Array.isArray(items) ? items.filter((item): item is string => typeof item === "string") : [];
  return {
    kind: "env-ref",
    ref: string(binding.ref, `${label} ref`),
    owner: record(binding.owner, `${label} owner`) as unknown as FrozenWorkflowEnvironmentOwner,
    keys: strings(binding.keys),
    secretNames: strings(binding.secretNames),
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
