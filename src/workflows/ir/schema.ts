// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { isContainedRelativePath, isRecord } from "../../core/common";
import { UsageError } from "../../core/errors";
import { parseReference } from "../program/expressions";
import { PROGRAM_PARAM_NAME_PATTERN, PROGRAM_RETRY_REASONS, PROGRAM_STEP_ID_PATTERN } from "../program/schema";
import {
  jsonBytes,
  utf8Bytes,
  WORKFLOW_ENV_VAR_NAME_PATTERN,
  WORKFLOW_MAX_CONCURRENCY,
  WORKFLOW_MAX_INSTRUCTION_BYTES,
  WORKFLOW_MAX_SCHEMA_BYTES,
  WORKFLOW_MAX_TIMEOUT_MS,
} from "../resource-limits";
import type { SourceRef } from "../schema";

export type IrOnError = "fail" | "continue";
export type IrIsolation = "none" | "worktree";
export type IrMapReducer = "collect" | "vote";
export type IrRuntimeKind = "llm" | "agent" | "sdk" | "exec";

/**
 * A frozen exec (shell) unit: the argv the engine spawns, where it spawns it,
 * and the wall-clock budget it gets.
 *
 * `command` is an ARGV ARRAY and there is deliberately no shell-string form —
 * the child is spawned directly, so shell metacharacters (`;`, `|`, `&&`,
 * `$(…)`, `>`) are inert literal argument bytes. An author who wants a
 * pipeline writes the interpreter explicitly (`["bash", "-lc", "a | b"]`),
 * which keeps that choice reviewable in the frontmatter diff.
 *
 * `cwd` is relative and contained (no absolute form, no `..`); the executor
 * re-checks containment against the RESOLVED base directory before spawning,
 * so neither a crafted plan nor a symlink can escape the unit's tree.
 *
 * `timeoutMs` is resolved once at freeze from the unit `timeout:` → document
 * `defaults.timeout` →
 * {@link DEFAULT_EXEC_TIMEOUT_MS}. `null` means the author wrote `timeout: none`.
 *
 * `passEnv` extends the child's default allowlist. Whole-process inheritance is
 * not part of the current plan format.
 */
export interface IrExecSpec {
  command: [string, ...string[]];
  cwd?: string;
  /** Extra parent-env NAMES on top of the default allowlist. Never empty when present. */
  passEnv?: string[];
  timeoutMs: number | null;
}

export interface IrRetry {
  max: number;
  on: string[];
}

export interface IrUnitNodeCore {
  kind: "unit" | "agent";
  id: string;
  instructions: string;
  /** Prior-step artifacts attached to this unit as structured context (reference strings). */
  inputs?: string[];
  schema?: Record<string, unknown>;
  retry?: IrRetry;
  onError: IrOnError;
  env?: string[];
  isolation?: IrIsolation;
  source?: SourceRef;
}

export interface IrMapNode {
  kind: "map";
  id: string;
  over: string;
  template: IrUnitNodeCore;
  concurrency?: number;
  reducer: IrMapReducer;
  source?: SourceRef;
}

export interface IrGateNodeCore {
  kind: "gate";
  id: string;
  stepId: string;
  criteria: string[];
  maxLoops?: number;
}

export interface IrRouteSpec {
  input: string;
  when: Record<string, string>;
  defaultStepId?: string;
}

export interface IrStepPlanCore {
  stepId: string;
  title: string;
  sequenceIndex: number;
  root?: IrUnitNodeCore | IrMapNode;
  route?: IrRouteSpec;
  outputSchema?: Record<string, unknown>;
  gate: IrGateNodeCore;
}

export interface IrBudget {
  maxTokens?: number;
  maxUnits?: number;
}

export interface WorkflowPlanStructure {
  irVersion: number;
  title: string;
  params?: string[];
  paramSchemas?: Record<string, Record<string, unknown>>;
  budget?: IrBudget;
  execution: { maxConcurrency: number };
  steps: IrStepPlanCore[];
}

// Shared dispatch-significant bounds now live in `../resource-limits` so the
// parser, the published JSON Schema, and this decoder enforce identical
// values. Re-exported here for existing importers (e.g. `commands/workflow-cli.ts`).
export { WORKFLOW_MAX_CONCURRENCY, WORKFLOW_MAX_TIMEOUT_MS };

const MAX_LIST_ITEMS = 1024;
const MAX_STRING_LENGTH = 1_000_000;

export interface WorkflowPlanStructureDecodeOptions {
  readonly planExtraKeys?: readonly string[];
  readonly unitExtraKeys?: readonly string[];
  readonly gateExtraKeys?: readonly string[];
}
/**
 * Validate the durable execution graph's structure. `irVersion` is recorded
 * provenance, not a gate: any positive integer is accepted, and a plan whose
 * shape this decoder understands runs whichever release froze it.
 */
export function validateWorkflowPlanStructure(input: unknown, options: WorkflowPlanStructureDecodeOptions = {}): void {
  if (!isRecord(input) || !Number.isSafeInteger(input.irVersion) || (input.irVersion as number) < 1) {
    fail("irVersion must be a positive integer");
  }
  assertJson(input);
  const plan = input as unknown as WorkflowPlanStructure;
  assertKeys(
    input,
    ["irVersion", "title", "params", "paramSchemas", "budget", "execution", "steps", ...(options.planExtraKeys ?? [])],
    "plan",
  );
  assertString(plan.title, "title");
  validateParams(plan.params, plan.paramSchemas);
  validateBudget(plan.budget);
  if (
    !isRecord(plan.execution) ||
    !Number.isInteger(plan.execution.maxConcurrency) ||
    (plan.execution.maxConcurrency as number) < 1 ||
    (plan.execution.maxConcurrency as number) > WORKFLOW_MAX_CONCURRENCY
  ) {
    fail(`execution.maxConcurrency must be an integer from 1 through ${WORKFLOW_MAX_CONCURRENCY}`);
  }
  assertKeys(plan.execution, ["maxConcurrency"], "execution");
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) fail("steps must be a non-empty array");
  const stepIds = new Set<string>();
  const nodeIds = new Set<string>();
  for (let index = 0; index < plan.steps.length; index++) {
    const step = plan.steps[index];
    if (
      !isRecord(step) ||
      typeof step.stepId !== "string" ||
      !PROGRAM_STEP_ID_PATTERN.test(step.stepId) ||
      stepIds.has(step.stepId)
    )
      fail("step ids must be unique non-empty strings");
    stepIds.add(step.stepId);
    if (step.sequenceIndex !== index) fail("step sequence indices must be contiguous and unique");
    assertString(step.title, `step ${step.stepId} title`);
    if (!!step.root === !!step.route) fail(`step ${step.stepId} must contain exactly one of root or route`);
    assertKeys(
      step,
      ["stepId", "title", "sequenceIndex", "root", "route", "outputSchema", "gate"],
      `step ${step.stepId}`,
    );
    if (step.outputSchema !== undefined) validateSchema(step.outputSchema, `step ${step.stepId} outputSchema`);
    if (step.root) validateNode(step.root, step.stepId, nodeIds, options.unitExtraKeys ?? []);
    if (step.route) validateRoute(step.route, step.stepId);
    validateGate(step.gate, step.stepId, nodeIds, options.gateExtraKeys ?? []);
  }
  const stepIndex = new Map(plan.steps.map((step, index) => [step.stepId, index]));
  for (const [index, step] of plan.steps.entries()) {
    for (const target of step.route
      ? [...Object.values(step.route.when), ...(step.route.defaultStepId ? [step.route.defaultStepId] : [])]
      : []) {
      const targetIndex = stepIndex.get(target);
      if (targetIndex === undefined) fail(`route target ${target} does not name a step`);
      if (targetIndex <= index) fail(`route target ${target} must come after step ${step.stepId}`);
    }
    validateStepExpressions(step, index, stepIndex);
  }
}

function validateNode(node: unknown, stepId: string, nodeIds: Set<string>, unitExtraKeys: readonly string[]): void {
  if (
    !isRecord(node) ||
    (node.kind !== "unit" && node.kind !== "map") ||
    typeof node.id !== "string" ||
    !node.id ||
    nodeIds.has(node.id)
  )
    fail("node ids must be unique non-empty strings");
  nodeIds.add(node.id);
  if (node.kind === "map") {
    assertKeys(node, ["kind", "id", "over", "template", "concurrency", "reducer", "source"], `map ${node.id}`);
    if (
      typeof node.over !== "string" ||
      !node.over ||
      !Number.isInteger(node.concurrency) ||
      (node.concurrency as number) < 1 ||
      (node.concurrency as number) > WORKFLOW_MAX_CONCURRENCY ||
      (node.reducer !== "collect" && node.reducer !== "vote")
    )
      fail(`map ${node.id} is invalid`);
    if (node.id !== `${stepId}.map`) fail(`map ${node.id} does not match step ${stepId}`);
    validateSource(node.source, `map ${node.id} source`);
    validateNode(node.template, stepId, nodeIds, unitExtraKeys);
    if (!isRecord(node.template) || node.template.kind !== "unit") fail(`map ${node.id} template must be a unit`);
    if (node.template.id !== `${stepId}.unit`) fail(`map ${node.id} template id is invalid`);
    return;
  }
  assertKeys(
    node,
    [
      "kind",
      "id",
      "instructions",
      "inputs",
      "schema",
      "retry",
      "onError",
      "env",
      "isolation",
      "source",
      ...unitExtraKeys,
    ],
    `unit ${node.id}`,
  );
  if (
    typeof node.instructions !== "string" ||
    !node.instructions ||
    (node.onError !== "fail" && node.onError !== "continue") ||
    (node.isolation !== "none" && node.isolation !== "worktree")
  )
    fail(`unit ${node.id} is invalid`);
  if (node.id !== stepId && node.id !== `${stepId}.unit`) fail(`unit ${node.id} does not belong to step ${stepId}`);
  if (utf8Bytes(node.instructions) > WORKFLOW_MAX_INSTRUCTION_BYTES)
    fail(`unit ${node.id} instructions exceed the 256 KiB resource limit`);
  if (node.schema !== undefined) validateSchema(node.schema, `unit ${node.id} schema`);
  validateRetry(node.retry, node.id);
  validateStringArray(node.env, `unit ${node.id} env`, MAX_LIST_ITEMS, true);
  validateStringArray(node.inputs, `unit ${node.id} inputs`, Infinity, true);
  validateSource(node.source, `unit ${node.id} source`);
}

/**
 * Strictly decode a frozen {@link IrExecSpec}. This is the corruption gate for
 * a persisted plan: the argv bounds, the relative-and-contained `cwd`, and the
 * timeout range are all re-checked here, because `plan_json` may have been
 * hand-edited between freeze and dispatch.
 */
function validateExecSpec(value: unknown, label: string): void {
  if (!isRecord(value)) fail(`${label} must be an object`);
  assertKeys(value, ["command", "cwd", "passEnv", "timeoutMs"], label);
  validateExecEnvScope(value, label);
  const command = value.command;
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((arg) => typeof arg === "string" && arg.length > 0)
  ) {
    fail(`${label}.command must be an argv array of non-empty strings`);
  }
  if (value.cwd !== undefined) {
    if (typeof value.cwd !== "string" || value.cwd.length === 0 || !isContainedRelativePath(value.cwd)) {
      fail(`${label}.cwd must be a relative path contained in the unit working directory`);
    }
  }
  if (
    !(
      value.timeoutMs === null ||
      (Number.isSafeInteger(value.timeoutMs) &&
        (value.timeoutMs as number) >= 1 &&
        (value.timeoutMs as number) <= WORKFLOW_MAX_TIMEOUT_MS)
    )
  ) {
    fail(`${label}.timeoutMs must be null or an integer from 1 through ${WORKFLOW_MAX_TIMEOUT_MS}`);
  }
}

/** Decode one current frozen exec spec. */
export function decodeWorkflowExecSpec(value: unknown, label: string): IrExecSpec {
  validateExecSpec(value, label);
  return value as IrExecSpec;
}

/**
 * The child's ENVIRONMENT SCOPE half of a frozen exec spec. Split out so
 * {@link validateExecSpec} keeps its shape (and the src-fn-size ratchet stays
 * shrink-only).
 *
 * `passEnv` is canonical-form-only and may only be a non-empty deduplicated
 * name list. A persisted `[]` means exactly what absence means, and admitting a
 * second spelling of the default would give the same unit two different input
 * hashes.
 */
function validateExecEnvScope(value: Record<string, unknown>, label: string): void {
  if (value.passEnv === undefined) return;
  const passEnv = value.passEnv;
  if (
    !Array.isArray(passEnv) ||
    passEnv.length === 0 ||
    !passEnv.every((name) => typeof name === "string" && WORKFLOW_ENV_VAR_NAME_PATTERN.test(name)) ||
    new Set(passEnv).size !== passEnv.length
  ) {
    fail(
      `${label}.passEnv must be a non-empty list of distinct environment variable names matching ` +
        `${WORKFLOW_ENV_VAR_NAME_PATTERN.source}`,
    );
  }
}

function validateGate(gate: unknown, stepId: string, nodeIds: Set<string>, gateExtraKeys: readonly string[]): void {
  if (
    !isRecord(gate) ||
    gate.kind !== "gate" ||
    gate.id !== `${stepId}.gate` ||
    gate.stepId !== stepId ||
    !Array.isArray(gate.criteria) ||
    gate.criteria.length > MAX_LIST_ITEMS ||
    !gate.criteria.every((x) => typeof x === "string" && x.length > 0 && x.length <= MAX_STRING_LENGTH) ||
    !Number.isInteger(gate.maxLoops) ||
    (gate.maxLoops as number) < 1
  )
    fail(`gate for step ${stepId} is invalid`);
  if (nodeIds.has(gate.id)) fail(`gate id ${gate.id} collides with a node`);
  assertKeys(gate, ["kind", "id", "stepId", "criteria", "maxLoops", ...gateExtraKeys], `gate ${stepId}`);
  nodeIds.add(gate.id);
}

function validateRoute(route: unknown, stepId: string): void {
  if (
    !isRecord(route) ||
    typeof route.input !== "string" ||
    !route.input ||
    !isRecord(route.when) ||
    Object.keys(route.when).length === 0 ||
    !Object.keys(route.when).every((match) => match.length > 0 && match.length <= MAX_STRING_LENGTH) ||
    !Object.values(route.when).every((target) => typeof target === "string" && target)
  )
    fail(`route for step ${stepId} is invalid`);
  assertKeys(route, ["input", "when", "defaultStepId"], `route ${stepId}`);
  if (route.defaultStepId !== undefined && (typeof route.defaultStepId !== "string" || !route.defaultStepId))
    fail(`route for step ${stepId} has an invalid default target`);
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label} contains unknown key ${key}`);
}

function assertJson(value: unknown): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) fail("plan contains an oversized string");
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("plan contains a non-finite number");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJson(item);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) assertJson(item);
    return;
  }
  fail("plan contains a non-JSON value");
}

function validateParams(
  params: string[] | undefined,
  schemas: Record<string, Record<string, unknown>> | undefined,
): void {
  validateStringArray(params, "params", Infinity, true);
  if (params?.some((name) => !PROGRAM_PARAM_NAME_PATTERN.test(name))) fail("params contains an invalid name");
  if (schemas !== undefined) {
    if (!isRecord(schemas)) fail("paramSchemas must be an object");
    for (const [name, schema] of Object.entries(schemas)) {
      if (!PROGRAM_PARAM_NAME_PATTERN.test(name)) fail(`paramSchemas.${name} is invalid`);
      validateSchema(schema, `paramSchemas.${name}`);
    }
  }
  const names = params ?? [];
  if (schemas && (names.length !== Object.keys(schemas).length || names.some((name) => !Object.hasOwn(schemas, name))))
    fail("params and paramSchemas must name the same parameters");
  if (!schemas && names.length > 0) {
    // Markdown workflows have named parameters but no schemas, which is valid.
    return;
  }
}

function validateBudget(budget: IrBudget | undefined): void {
  if (budget === undefined) return;
  if (!isRecord(budget)) fail("budget must be an object");
  assertKeys(budget, ["maxTokens", "maxUnits"], "budget");
  if (budget.maxTokens === undefined && budget.maxUnits === undefined) fail("budget must declare a ceiling");
  validateOptionalPositiveInteger(budget.maxTokens, "budget.maxTokens");
  const maxUnits = budget.maxUnits;
  if (maxUnits !== undefined && (!Number.isSafeInteger(maxUnits) || (maxUnits as number) < 1))
    fail("budget.maxUnits must be a positive integer");
}

function validateRetry(retry: unknown, nodeId: string): void {
  if (retry === undefined) return;
  if (!isRecord(retry)) fail(`unit ${nodeId} retry must be an object`);
  assertKeys(retry, ["max", "on"], `unit ${nodeId} retry`);
  if (!Number.isSafeInteger(retry.max) || (retry.max as number) < 0) fail(`unit ${nodeId} retry.max is invalid`);
  validateStringArray(retry.on, `unit ${nodeId} retry.on`, PROGRAM_RETRY_REASONS.length, true);
  if (
    retry.on === undefined ||
    retry.on.length === 0 ||
    retry.on.some((reason) => !PROGRAM_RETRY_REASONS.includes(reason as never))
  )
    fail(`unit ${nodeId} retry.on is invalid`);
}

function validateSchema(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} must be an object`);
  if (jsonBytes(value) > WORKFLOW_MAX_SCHEMA_BYTES) fail(`${label} exceeds the 256 KiB resource limit`);
}

function validateStepExpressions(step: IrStepPlanCore, index: number, steps: Map<string, number>): void {
  const validateReference = (text: string, label: string, paramsAllowed: boolean): void => {
    const parsed = parseReference(text);
    if (!parsed.ok) fail(`${label} contains an invalid reference`);
    if (parsed.expr.kind === "param" && !paramsAllowed) fail(`${label} must reference a step output`);
    if (parsed.expr.kind === "stepOutput") {
      const referenced = steps.get(parsed.expr.stepId);
      if (referenced === undefined || referenced >= index) fail(`${label} references a non-earlier step`);
    }
  };
  if (step.root) {
    const unit = step.root.kind === "map" ? step.root.template : step.root;
    if (step.root.kind === "map") validateReference(step.root.over, `map ${step.root.id} over`, true);
    for (const reference of unit.inputs ?? []) validateReference(reference, `unit ${unit.id} inputs`, false);
  }
  if (step.route) validateReference(step.route.input, `route ${step.stepId} input`, true);
}

function validateSource(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) fail(`${label} must be an object`);
  assertKeys(value, ["path", "start", "end"], label);
  if (
    typeof value.path !== "string" ||
    !value.path ||
    !Number.isSafeInteger(value.start) ||
    !Number.isSafeInteger(value.end) ||
    (value.start as number) < 1 ||
    (value.end as number) < (value.start as number)
  )
    fail(`${label} is invalid`);
}

function validateStringArray(
  value: unknown,
  label: string,
  max: number,
  unique: boolean,
): asserts value is string[] | undefined {
  if (value === undefined) return;
  if (
    !Array.isArray(value) ||
    value.length > max ||
    !value.every((item) => typeof item === "string" && item.length > 0 && item.length <= MAX_STRING_LENGTH) ||
    (unique && new Set(value).size !== value.length)
  )
    fail(`${label} is invalid`);
}

function validateOptionalPositiveInteger(value: unknown, label: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 1))
    fail(`${label} must be a positive safe integer`);
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_STRING_LENGTH)
    fail(`${label} must be a non-empty bounded string`);
}

function fail(message: string): never {
  throw new UsageError(`Invalid frozen workflow plan: ${message}.`);
}
