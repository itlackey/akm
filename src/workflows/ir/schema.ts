// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import { UsageError } from "../../core/errors";
import type { LlmInvocationOverrides } from "../../integrations/agent/engine-resolution";
import { HARNESS_BY_ID } from "../../integrations/harnesses";
import { listReferences, parseTemplate } from "../program/expressions";
import { PROGRAM_PARAM_NAME_PATTERN, PROGRAM_RETRY_REASONS, PROGRAM_STEP_ID_PATTERN } from "../program/schema";
import {
  jsonBytes,
  WORKFLOW_MAX_ENGINES,
  WORKFLOW_MAX_EXTRA_PARAMS_BYTES,
  WORKFLOW_MAX_INSTRUCTION_BYTES,
  WORKFLOW_MAX_JSON_DEPTH,
  WORKFLOW_MAX_MAP_EXPANSION,
  WORKFLOW_MAX_PARAMS,
  WORKFLOW_MAX_PLAN_BYTES,
  WORKFLOW_MAX_ROUTE_BRANCHES,
  WORKFLOW_MAX_SCHEMA_BYTES,
  WORKFLOW_MAX_STEPS,
} from "../resource-limits";
import type { SourceRef } from "../schema";

/** The only executable persisted workflow plan format. */
export const WORKFLOW_IR_VERSION = 3;
export type IrOnError = "fail" | "continue";
export type IrIsolation = "none" | "worktree";
export type IrMapReducer = "collect" | "vote";
export type IrInstructionTemplating = "expressions" | "verbatim";
export type IrRuntimeKind = "llm" | "agent" | "sdk";
/** Legacy internal spelling retained for source-level test migration only. */
export type IrRunnerKind = IrRuntimeKind | "inherit";

export interface IrRetry {
  max: number;
  on: string[];
}

export interface FrozenCredential {
  names: [string, ...string[]];
  required: boolean;
}

export interface FrozenLlmEngine {
  name: string;
  kind: "llm";
  provider?: string;
  endpoint: string;
  /** Exact base model used by SDK fallbacks and inherited LLM invocations. */
  model: string;
  timeoutMs: number | null;
  credential?: FrozenCredential;
  temperature?: number;
  maxTokens?: number;
  concurrency: number;
  supportsJsonSchema?: boolean;
  extraParams?: Record<string, unknown>;
  contextLength?: number;
  enableThinking?: boolean;
}

export interface FrozenAgentEngine {
  name: string;
  kind: "agent";
  runnerKind: "agent" | "sdk";
  platform: string;
  bin: string;
  args: string[];
  workspace: string | null;
  envPassthrough: string[];
  commandBuilder: string;
  fallbackLlmEngine: string | null;
}

export type FrozenEngineSnapshot = FrozenLlmEngine | FrozenAgentEngine;

export interface IrInvocation {
  engine: string;
  /** Exact model resolved at start, never an alias. */
  model: string | null;
  timeoutMs: number | null;
  llm?: LlmInvocationOverrides;
}

export interface IrUnitNode {
  kind: "unit" | "agent";
  id: string;
  instructions: string;
  templating?: IrInstructionTemplating;
  invocation?: IrInvocation;
  /** @deprecated v2 in-memory compatibility; never accepted by the v3 decoder. */
  runner?: IrRunnerKind;
  /** @deprecated v2 in-memory compatibility; never accepted by the v3 decoder. */
  profile?: string;
  /** @deprecated v2 in-memory compatibility; never accepted by the v3 decoder. */
  model?: string;
  /** @deprecated v2 in-memory compatibility; never accepted by the v3 decoder. */
  timeoutMs?: number | null;
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
  template: IrUnitNode;
  concurrency?: number;
  reducer: IrMapReducer;
  source?: SourceRef;
}

export type IrExecNode = IrUnitNode | IrMapNode;

export interface IrGateNode {
  kind: "gate";
  id: string;
  stepId: string;
  criteria: string[];
  maxLoops?: number;
  required?: boolean;
  judge?: IrInvocation | null;
}

export interface IrRouteSpec {
  input: string;
  when: Record<string, string>;
  defaultStepId?: string;
}

export interface IrStepPlan {
  stepId: string;
  title: string;
  sequenceIndex: number;
  dependsOn?: string[];
  root?: IrExecNode;
  route?: IrRouteSpec;
  outputSchema?: Record<string, unknown>;
  gate: IrGateNode;
}

export interface IrBudget {
  maxTokens?: number;
  maxUnits?: number;
}

export interface WorkflowPlanGraph {
  irVersion: number;
  title: string;
  params?: string[];
  paramSchemas?: Record<string, Record<string, unknown>>;
  budget?: IrBudget;
  execution?: { maxConcurrency: number; engines: Record<string, FrozenEngineSnapshot> };
  steps: IrStepPlan[];
}

export const WORKFLOW_MAX_CONCURRENCY = 64;
export const WORKFLOW_MAX_GATE_LOOPS = 100;
export const WORKFLOW_MAX_RETRIES = 100;
export const WORKFLOW_MAX_UNITS = WORKFLOW_MAX_MAP_EXPANSION;
export const WORKFLOW_MAX_TIMEOUT_MS = 2 ** 31 - 1;
const MAX_LIST_ITEMS = 1024;
const MAX_STRING_LENGTH = 1_000_000;
const ENGINE_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface WorkflowPlanValidationHooks {
  /** Optional shared config-policy hook. Structural and byte bounds remain owned here. */
  validateExtraParams?(value: Readonly<Record<string, unknown>>, location: string): string | undefined;
}

/** Strictly decode persisted v3 data before it can drive a workflow. */
export function decodeWorkflowPlanV3(input: unknown, hooks: WorkflowPlanValidationHooks = {}): WorkflowPlanGraph {
  if (!isRecord(input) || input.irVersion !== WORKFLOW_IR_VERSION) fail("irVersion must be 3");
  assertJson(input);
  if (jsonBytes(input) > WORKFLOW_MAX_PLAN_BYTES) fail("plan exceeds the 2 MiB resource limit");
  const plan = input as unknown as WorkflowPlanGraph;
  assertKeys(input, ["irVersion", "title", "params", "paramSchemas", "budget", "execution", "steps"], "plan");
  assertString(plan.title, "title");
  validateParams(plan.params, plan.paramSchemas);
  validateBudget(plan.budget);
  if (
    !isRecord(plan.execution) ||
    !Number.isInteger(plan.execution.maxConcurrency) ||
    (plan.execution.maxConcurrency as number) < 1 ||
    (plan.execution.maxConcurrency as number) > WORKFLOW_MAX_CONCURRENCY
  ) {
    fail("execution.maxConcurrency must be an integer from 1 through 64");
  }
  assertKeys(plan.execution, ["maxConcurrency", "engines"], "execution");
  if (!isRecord(plan.execution.engines)) fail("execution.engines must be an object");
  const engines = plan.execution.engines as Record<string, FrozenEngineSnapshot>;
  if (Object.keys(engines).length > WORKFLOW_MAX_ENGINES)
    fail(`execution.engines exceeds ${WORKFLOW_MAX_ENGINES} entries`);
  const references = new Set<string>();
  for (const [key, engine] of Object.entries(engines)) validateEngine(key, engine, references, hooks);
  if (!Array.isArray(plan.steps) || plan.steps.length === 0 || plan.steps.length > WORKFLOW_MAX_STEPS)
    fail("steps must contain 1 through 256 entries");
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
      ["stepId", "title", "sequenceIndex", "dependsOn", "root", "route", "outputSchema", "gate"],
      `step ${step.stepId}`,
    );
    validateStringArray(step.dependsOn, `step ${step.stepId} dependsOn`, WORKFLOW_MAX_STEPS, true);
    if (step.outputSchema !== undefined) validateSchema(step.outputSchema, `step ${step.stepId} outputSchema`);
    if (step.root) validateNode(step.root, step.stepId, references, nodeIds, hooks);
    if (step.route) validateRoute(step.route, step.stepId);
    validateGate(step.gate, step.stepId, references, nodeIds, hooks);
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
    const dependencies = new Set<string>();
    for (const dependency of step.dependsOn ?? []) {
      const dependencyIndex = stepIndex.get(dependency);
      if (dependencyIndex === undefined || dependencyIndex >= index || dependencies.has(dependency))
        fail(`step ${step.stepId} has an invalid dependency`);
      dependencies.add(dependency);
    }
    validateStepExpressions(step, index, stepIndex);
  }
  for (const name of references) {
    if (!engines[name]) fail(`engine reference ${name} is not in execution.engines`);
  }
  for (const name of Object.keys(engines)) if (!references.has(name)) fail(`engine ${name} is not referenced`);
  for (const engine of Object.values(engines)) {
    if (engine.kind !== "agent") continue;
    if (engine.fallbackLlmEngine !== null && engines[engine.fallbackLlmEngine]?.kind !== "llm")
      fail(`SDK engine ${engine.name} fallback must name an LLM engine`);
  }
  for (const step of plan.steps) {
    if (step.root) assertUnitEngineCompatibility(step.root, engines);
    if (step.gate.judge) {
      const judge = engines[step.gate.judge.engine];
      if (!judge || judge.kind !== "llm") fail(`gate ${step.gate.id} must reference an LLM engine`);
    }
  }
  return plan;
}

function validateEngine(
  key: string,
  engine: unknown,
  references: Set<string>,
  hooks: WorkflowPlanValidationHooks,
): void {
  if (
    !ENGINE_NAME_PATTERN.test(key) ||
    key.length > 63 ||
    !isRecord(engine) ||
    engine.name !== key ||
    (engine.kind !== "llm" && engine.kind !== "agent")
  )
    fail("catalog keys must equal a valid snapshot name");
  if (engine.kind === "llm") {
    assertKeys(
      engine,
      [
        "name",
        "kind",
        "provider",
        "endpoint",
        "model",
        "timeoutMs",
        "credential",
        "temperature",
        "maxTokens",
        "concurrency",
        "supportsJsonSchema",
        "extraParams",
        "contextLength",
        "enableThinking",
      ],
      `LLM engine ${key}`,
    );
    if (
      typeof engine.endpoint !== "string" ||
      !engine.endpoint ||
      typeof engine.model !== "string" ||
      !engine.model ||
      !(
        engine.timeoutMs === null ||
        (Number.isSafeInteger(engine.timeoutMs) &&
          (engine.timeoutMs as number) >= 1 &&
          (engine.timeoutMs as number) <= WORKFLOW_MAX_TIMEOUT_MS)
      ) ||
      !Number.isInteger(engine.concurrency) ||
      (engine.concurrency as number) < 1 ||
      (engine.concurrency as number) > WORKFLOW_MAX_CONCURRENCY
    )
      fail(`LLM engine ${key} is invalid`);
    if (engine.provider !== undefined) assertString(engine.provider, `LLM engine ${key} provider`);
    validateEndpoint(engine.endpoint, key);
    validateOptionalFiniteNumber(engine.temperature, `LLM engine ${key} temperature`);
    validateOptionalPositiveInteger(engine.maxTokens, `LLM engine ${key} maxTokens`);
    validateOptionalPositiveInteger(engine.contextLength, `LLM engine ${key} contextLength`);
    if (engine.supportsJsonSchema !== undefined && typeof engine.supportsJsonSchema !== "boolean")
      fail(`LLM engine ${key} supportsJsonSchema must be boolean`);
    if (engine.enableThinking !== undefined && typeof engine.enableThinking !== "boolean")
      fail(`LLM engine ${key} enableThinking must be boolean`);
    validateExtraParams(engine.extraParams, `LLM engine ${key} extraParams`, hooks);
    if (engine.credential !== undefined) {
      if (
        !isRecord(engine.credential) ||
        !Array.isArray(engine.credential.names) ||
        engine.credential.names.length === 0 ||
        engine.credential.names.length > 32 ||
        !engine.credential.names.every((n) => typeof n === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) ||
        new Set(engine.credential.names).size !== engine.credential.names.length ||
        typeof engine.credential.required !== "boolean"
      ) {
        fail(`LLM engine ${key} has an invalid credential descriptor`);
      }
      assertKeys(engine.credential, ["names", "required"], `LLM engine ${key} credential`);
    }
    return;
  }
  assertKeys(
    engine,
    [
      "name",
      "kind",
      "runnerKind",
      "platform",
      "bin",
      "args",
      "workspace",
      "envPassthrough",
      "commandBuilder",
      "fallbackLlmEngine",
    ],
    `agent engine ${key}`,
  );
  if (
    (engine.runnerKind !== "agent" && engine.runnerKind !== "sdk") ||
    typeof engine.platform !== "string" ||
    !engine.platform ||
    typeof engine.bin !== "string" ||
    !engine.bin ||
    !Array.isArray(engine.args) ||
    engine.args.length > MAX_LIST_ITEMS ||
    !engine.args.every((arg) => typeof arg === "string" && arg.length <= MAX_STRING_LENGTH) ||
    !(typeof engine.workspace === "string" || engine.workspace === null) ||
    !Array.isArray(engine.envPassthrough) ||
    engine.envPassthrough.length > MAX_LIST_ITEMS ||
    !engine.envPassthrough.every((name) => typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) ||
    new Set(engine.envPassthrough).size !== engine.envPassthrough.length ||
    typeof engine.commandBuilder !== "string" ||
    engine.commandBuilder !== engine.platform ||
    (engine.workspace !== null && !path.isAbsolute(engine.workspace)) ||
    !HARNESS_BY_ID.get(engine.platform)?.capabilities.agentDispatch
  )
    fail(`agent engine ${key} is invalid`);
  if ((engine.platform === "opencode-sdk") !== (engine.runnerKind === "sdk"))
    fail(`agent engine ${key} has incompatible platform and runnerKind`);
  if (engine.runnerKind === "agent" && engine.fallbackLlmEngine !== null)
    fail(`agent engine ${key} cannot have an SDK fallback`);
  if (engine.fallbackLlmEngine !== null) {
    if (typeof engine.fallbackLlmEngine !== "string" || !engine.fallbackLlmEngine)
      fail(`agent engine ${key} has an invalid fallback`);
    references.add(engine.fallbackLlmEngine);
  }
}

function validateNode(
  node: unknown,
  stepId: string,
  references: Set<string>,
  nodeIds: Set<string>,
  hooks: WorkflowPlanValidationHooks,
): void {
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
    validateNode(node.template, stepId, references, nodeIds, hooks);
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
      "templating",
      "invocation",
      "schema",
      "retry",
      "onError",
      "env",
      "isolation",
      "source",
    ],
    `unit ${node.id}`,
  );
  if (
    typeof node.instructions !== "string" ||
    !node.instructions ||
    (node.templating !== "expressions" && node.templating !== "verbatim") ||
    (node.onError !== "fail" && node.onError !== "continue") ||
    (node.isolation !== "none" && node.isolation !== "worktree")
  )
    fail(`unit ${node.id} is invalid`);
  if (node.id !== stepId && node.id !== `${stepId}.unit`) fail(`unit ${node.id} does not belong to step ${stepId}`);
  if (Buffer.byteLength(node.instructions, "utf8") > WORKFLOW_MAX_INSTRUCTION_BYTES)
    fail(`unit ${node.id} instructions exceed the 256 KiB resource limit`);
  if (node.schema !== undefined) validateSchema(node.schema, `unit ${node.id} schema`);
  validateRetry(node.retry, node.id);
  validateStringArray(node.env, `unit ${node.id} env`, MAX_LIST_ITEMS, true);
  validateSource(node.source, `unit ${node.id} source`);
  validateInvocation(node.invocation, references, hooks);
}

function validateGate(
  gate: unknown,
  stepId: string,
  references: Set<string>,
  nodeIds: Set<string>,
  hooks: WorkflowPlanValidationHooks,
): void {
  if (
    !isRecord(gate) ||
    gate.kind !== "gate" ||
    gate.id !== `${stepId}.gate` ||
    gate.stepId !== stepId ||
    !Array.isArray(gate.criteria) ||
    gate.criteria.length > MAX_LIST_ITEMS ||
    !gate.criteria.every((x) => typeof x === "string" && x.length > 0 && x.length <= MAX_STRING_LENGTH) ||
    !Number.isInteger(gate.maxLoops) ||
    (gate.maxLoops as number) < 1 ||
    (gate.maxLoops as number) > WORKFLOW_MAX_GATE_LOOPS ||
    typeof gate.required !== "boolean"
  )
    fail(`gate for step ${stepId} is invalid`);
  if (nodeIds.has(gate.id)) fail(`gate id ${gate.id} collides with a node`);
  assertKeys(gate, ["kind", "id", "stepId", "criteria", "maxLoops", "required", "judge"], `gate ${stepId}`);
  nodeIds.add(gate.id);
  if (gate.criteria.length === 0 && gate.judge !== null) fail(`gate ${gate.id} without criteria cannot have a judge`);
  if (gate.required && gate.criteria.length === 0) fail(`gate ${gate.id} cannot be required without criteria`);
  if (gate.judge !== null) validateInvocation(gate.judge, references, hooks);
}

function validateInvocation(invocation: unknown, references: Set<string>, hooks: WorkflowPlanValidationHooks): void {
  if (
    !isRecord(invocation) ||
    typeof invocation.engine !== "string" ||
    !invocation.engine ||
    !((typeof invocation.model === "string" && invocation.model.length > 0) || invocation.model === null) ||
    !(
      invocation.timeoutMs === null ||
      (Number.isSafeInteger(invocation.timeoutMs) &&
        (invocation.timeoutMs as number) >= 1 &&
        (invocation.timeoutMs as number) <= WORKFLOW_MAX_TIMEOUT_MS)
    )
  )
    fail("invocation is invalid");
  references.add(invocation.engine);
  assertKeys(invocation, ["engine", "model", "timeoutMs", "llm"], "invocation");
  validateLlmOverrides(invocation.llm, hooks);
}

function validateRoute(route: unknown, stepId: string): void {
  if (
    !isRecord(route) ||
    typeof route.input !== "string" ||
    !route.input ||
    !isRecord(route.when) ||
    Object.keys(route.when).length === 0 ||
    Object.keys(route.when).length > WORKFLOW_MAX_ROUTE_BRANCHES ||
    !Object.keys(route.when).every((match) => match.length > 0 && match.length <= MAX_STRING_LENGTH) ||
    !Object.values(route.when).every((target) => typeof target === "string" && target)
  )
    fail(`route for step ${stepId} is invalid`);
  assertKeys(route, ["input", "when", "defaultStepId"], `route ${stepId}`);
  if (route.defaultStepId !== undefined && (typeof route.defaultStepId !== "string" || !route.defaultStepId))
    fail(`route for step ${stepId} has an invalid default target`);
}

function assertUnitEngineCompatibility(node: IrExecNode, engines: Record<string, FrozenEngineSnapshot>): void {
  const unit = node.kind === "map" ? node.template : node;
  const engine = unit.invocation ? engines[unit.invocation.engine] : undefined;
  if (!engine) return;
  if (engine.kind === "llm" && unit.invocation?.model === null) fail(`LLM unit ${unit.id} has no exact model`);
  if (engine.kind === "agent" && unit.invocation?.llm !== undefined)
    fail(`agent unit ${unit.id} cannot carry LLM invocation settings`);
  if (engine.kind === "llm" && ((unit.env?.length ?? 0) > 0 || unit.isolation === "worktree")) {
    fail(`LLM unit ${unit.id} cannot use env injection or worktree isolation`);
  }
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label} contains unknown key ${key}`);
}

function assertJson(value: unknown, depth = 0): void {
  if (depth > WORKFLOW_MAX_JSON_DEPTH) fail("plan exceeds JSON depth limit of 64");
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
    for (const item of value) assertJson(item, depth + 1);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) assertJson(item, depth + 1);
    return;
  }
  fail("plan contains a non-JSON value");
}

function validateParams(
  params: string[] | undefined,
  schemas: Record<string, Record<string, unknown>> | undefined,
): void {
  validateStringArray(params, "params", WORKFLOW_MAX_PARAMS, true);
  if (params?.some((name) => !PROGRAM_PARAM_NAME_PATTERN.test(name))) fail("params contains an invalid name");
  if (schemas !== undefined) {
    if (!isRecord(schemas) || Object.keys(schemas).length > WORKFLOW_MAX_PARAMS)
      fail("paramSchemas must be a bounded object");
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
  if (
    maxUnits !== undefined &&
    (!Number.isSafeInteger(maxUnits) || (maxUnits as number) < 1 || (maxUnits as number) > WORKFLOW_MAX_UNITS)
  )
    fail(`budget.maxUnits must be an integer from 1 through ${WORKFLOW_MAX_UNITS}`);
}

function validateRetry(retry: unknown, nodeId: string): void {
  if (retry === undefined) return;
  if (!isRecord(retry)) fail(`unit ${nodeId} retry must be an object`);
  assertKeys(retry, ["max", "on"], `unit ${nodeId} retry`);
  if (!Number.isSafeInteger(retry.max) || (retry.max as number) < 0 || (retry.max as number) > WORKFLOW_MAX_RETRIES)
    fail(`unit ${nodeId} retry.max is invalid`);
  validateStringArray(retry.on, `unit ${nodeId} retry.on`, PROGRAM_RETRY_REASONS.length, true);
  if (
    retry.on === undefined ||
    retry.on.length === 0 ||
    retry.on.some((reason) => !PROGRAM_RETRY_REASONS.includes(reason as never))
  )
    fail(`unit ${nodeId} retry.on is invalid`);
}

function validateLlmOverrides(value: unknown, hooks: WorkflowPlanValidationHooks): void {
  if (value === undefined) return;
  if (!isRecord(value)) fail("invocation.llm must be an object");
  assertKeys(
    value,
    ["temperature", "maxTokens", "supportsJsonSchema", "extraParams", "contextLength", "enableThinking"],
    "invocation.llm",
  );
  validateOptionalFiniteNumber(value.temperature, "invocation.llm.temperature");
  validateOptionalPositiveInteger(value.maxTokens, "invocation.llm.maxTokens");
  validateOptionalPositiveInteger(value.contextLength, "invocation.llm.contextLength");
  if (value.supportsJsonSchema !== undefined && typeof value.supportsJsonSchema !== "boolean")
    fail("invocation.llm.supportsJsonSchema must be boolean");
  if (value.enableThinking !== undefined && typeof value.enableThinking !== "boolean")
    fail("invocation.llm.enableThinking must be boolean");
  validateExtraParams(value.extraParams, "invocation.llm.extraParams", hooks);
}

function validateSchema(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} must be an object`);
  if (jsonBytes(value) > WORKFLOW_MAX_SCHEMA_BYTES) fail(`${label} exceeds the 256 KiB resource limit`);
}

function validateExtraParams(value: unknown, label: string, hooks: WorkflowPlanValidationHooks): void {
  if (value === undefined) return;
  if (!isRecord(value)) fail(`${label} must be an object`);
  if (jsonBytes(value) > WORKFLOW_MAX_EXTRA_PARAMS_BYTES) fail(`${label} exceeds the 64 KiB resource limit`);
  const policyError = hooks.validateExtraParams?.(value, label);
  if (policyError) fail(`${label}: ${policyError}`);
}

function validateStepExpressions(step: IrStepPlan, index: number, steps: Map<string, number>): void {
  const validateReferences = (text: string, label: string, itemAllowed: boolean, wholeValue: boolean): void => {
    const parsed = parseTemplate(text);
    if (!parsed.ok) fail(`${label} contains an invalid expression`);
    if (wholeValue && (parsed.segments.length !== 1 || parsed.segments[0]?.kind !== "reference"))
      fail(`${label} must be one whole-value expression`);
    for (const reference of listReferences(parsed.segments)) {
      if ((reference.kind === "item" || reference.kind === "itemIndex") && !itemAllowed)
        fail(`${label} uses item outside a map unit`);
      if (reference.kind === "stepOutput") {
        const referenced = steps.get(reference.stepId);
        if (referenced === undefined || referenced >= index) fail(`${label} references a non-earlier step`);
      }
    }
  };
  if (step.root) {
    const unit = step.root.kind === "map" ? step.root.template : step.root;
    if (step.root.kind === "map") validateReferences(step.root.over, `map ${step.root.id} over`, false, true);
    if (unit.templating === "expressions")
      validateReferences(unit.instructions, `unit ${unit.id} instructions`, step.root.kind === "map", false);
  }
  if (step.route) validateReferences(step.route.input, `route ${step.stepId} input`, false, true);
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

function validateOptionalFiniteNumber(value: unknown, label: string): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) fail(`${label} must be finite`);
}

function validateOptionalPositiveInteger(value: unknown, label: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 1))
    fail(`${label} must be a positive safe integer`);
}

function validateEndpoint(value: string, engine: string): void {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith("/chat/completions")
    )
      fail(`LLM engine ${engine} endpoint is not canonical`);
  } catch {
    fail(`LLM engine ${engine} endpoint is invalid`);
  }
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_STRING_LENGTH)
    fail(`${label} must be a non-empty bounded string`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new UsageError(`Invalid frozen workflow plan: ${message}.`);
}

/** Removed v2 type name retained only as a TypeScript migration aid. */
export type IrAgentNode = IrUnitNode;
