// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { UsageError } from "../../core/errors";
import type { LlmInvocationOverrides } from "../../integrations/agent/engine-resolution";
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

const MAX_STEPS = 256;
const MAX_ENGINES = 64;

/** Strictly decode persisted v3 data before it can drive a workflow. */
export function decodeWorkflowPlanV3(input: unknown): WorkflowPlanGraph {
  if (!isRecord(input) || input.irVersion !== WORKFLOW_IR_VERSION) fail("irVersion must be 3");
  assertJson(input);
  const plan = input as unknown as WorkflowPlanGraph;
  assertKeys(input, ["irVersion", "title", "params", "paramSchemas", "budget", "execution", "steps"], "plan");
  if (typeof plan.title !== "string" || !plan.title) fail("title must be a non-empty string");
  if (
    !isRecord(plan.execution) ||
    !Number.isInteger(plan.execution.maxConcurrency) ||
    (plan.execution.maxConcurrency as number) < 1 ||
    (plan.execution.maxConcurrency as number) > 64
  ) {
    fail("execution.maxConcurrency must be an integer from 1 through 64");
  }
  if (!isRecord(plan.execution.engines)) fail("execution.engines must be an object");
  const engines = plan.execution.engines as Record<string, FrozenEngineSnapshot>;
  if (Object.keys(engines).length > MAX_ENGINES) fail(`execution.engines exceeds ${MAX_ENGINES} entries`);
  const references = new Set<string>();
  for (const [key, engine] of Object.entries(engines)) validateEngine(key, engine, references);
  if (!Array.isArray(plan.steps) || plan.steps.length === 0 || plan.steps.length > MAX_STEPS)
    fail("steps must contain 1 through 256 entries");
  const stepIds = new Set<string>();
  const nodeIds = new Set<string>();
  for (let index = 0; index < plan.steps.length; index++) {
    const step = plan.steps[index];
    if (!isRecord(step) || typeof step.stepId !== "string" || !step.stepId || stepIds.has(step.stepId))
      fail("step ids must be unique non-empty strings");
    stepIds.add(step.stepId);
    if (step.sequenceIndex !== index) fail("step sequence indices must be contiguous and unique");
    if (typeof step.title !== "string" || !step.title) fail(`step ${step.stepId} has no title`);
    if (!!step.root === !!step.route) fail(`step ${step.stepId} must contain exactly one of root or route`);
    assertKeys(
      step,
      ["stepId", "title", "sequenceIndex", "dependsOn", "root", "route", "outputSchema", "gate"],
      `step ${step.stepId}`,
    );
    if (step.root) validateNode(step.root, references, nodeIds);
    if (step.route) validateRoute(step.route, step.stepId);
    validateGate(step.gate, step.stepId, references, nodeIds);
  }
  for (const step of plan.steps) {
    for (const target of step.route
      ? [...Object.values(step.route.when), ...(step.route.defaultStepId ? [step.route.defaultStepId] : [])]
      : []) {
      if (!stepIds.has(target)) fail(`route target ${target} does not name a step`);
    }
    for (const dependency of step.dependsOn ?? []) {
      if (!stepIds.has(dependency) || dependency === step.stepId) fail(`step ${step.stepId} has an invalid dependency`);
    }
  }
  for (const name of references) {
    if (!engines[name]) fail(`engine reference ${name} is not in execution.engines`);
  }
  for (const name of Object.keys(engines)) if (!references.has(name)) fail(`engine ${name} is not referenced`);
  for (const step of plan.steps) {
    if (step.root) assertUnitEngineCompatibility(step.root, engines);
    if (step.gate.judge) {
      const judge = engines[step.gate.judge.engine];
      if (!judge || judge.kind !== "llm") fail(`gate ${step.gate.id} must reference an LLM engine`);
    }
  }
  return plan;
}

function validateEngine(key: string, engine: unknown, references: Set<string>): void {
  if (!isRecord(engine) || engine.name !== key || (engine.kind !== "llm" && engine.kind !== "agent"))
    fail("catalog keys must equal a valid snapshot name");
  if (engine.kind === "llm") {
    assertKeys(
      engine,
      [
        "name",
        "kind",
        "provider",
        "endpoint",
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
      !Number.isInteger(engine.concurrency) ||
      (engine.concurrency as number) < 1
    )
      fail(`LLM engine ${key} is invalid`);
    if (engine.credential !== undefined) {
      if (
        !isRecord(engine.credential) ||
        !Array.isArray(engine.credential.names) ||
        engine.credential.names.length === 0 ||
        !engine.credential.names.every((n) => typeof n === "string" && n)
      ) {
        fail(`LLM engine ${key} has an invalid credential descriptor`);
      }
    }
    return;
  }
  assertKeys(
    engine,
    ["name", "kind", "runnerKind", "platform", "bin", "args", "workspace", "envPassthrough", "fallbackLlmEngine"],
    `agent engine ${key}`,
  );
  if (
    (engine.runnerKind !== "agent" && engine.runnerKind !== "sdk") ||
    typeof engine.platform !== "string" ||
    !engine.platform ||
    typeof engine.bin !== "string" ||
    !engine.bin ||
    !Array.isArray(engine.args) ||
    !engine.args.every((arg) => typeof arg === "string") ||
    !Array.isArray(engine.envPassthrough)
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

function validateNode(node: unknown, references: Set<string>, nodeIds: Set<string>): void {
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
      (node.reducer !== "collect" && node.reducer !== "vote")
    )
      fail(`map ${node.id} is invalid`);
    validateNode(node.template, references, nodeIds);
    if (!isRecord(node.template) || node.template.kind !== "unit") fail(`map ${node.id} template must be a unit`);
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
  validateInvocation(node.invocation, references);
}

function validateGate(gate: unknown, stepId: string, references: Set<string>, nodeIds: Set<string>): void {
  if (
    !isRecord(gate) ||
    gate.kind !== "gate" ||
    gate.id !== `${stepId}.gate` ||
    gate.stepId !== stepId ||
    !Array.isArray(gate.criteria) ||
    !gate.criteria.every((x) => typeof x === "string") ||
    !Number.isInteger(gate.maxLoops) ||
    (gate.maxLoops as number) < 1 ||
    typeof gate.required !== "boolean"
  )
    fail(`gate for step ${stepId} is invalid`);
  if (nodeIds.has(gate.id)) fail(`gate id ${gate.id} collides with a node`);
  assertKeys(gate, ["kind", "id", "stepId", "criteria", "maxLoops", "required", "judge"], `gate ${stepId}`);
  nodeIds.add(gate.id);
  if (gate.judge !== null) validateInvocation(gate.judge, references);
}

function validateInvocation(invocation: unknown, references: Set<string>): void {
  if (
    !isRecord(invocation) ||
    typeof invocation.engine !== "string" ||
    !invocation.engine ||
    !(typeof invocation.model === "string" || invocation.model === null) ||
    !(typeof invocation.timeoutMs === "number" || invocation.timeoutMs === null)
  )
    fail("invocation is invalid");
  references.add(invocation.engine);
  assertKeys(invocation, ["engine", "model", "timeoutMs", "llm"], "invocation");
}

function validateRoute(route: unknown, stepId: string): void {
  if (
    !isRecord(route) ||
    typeof route.input !== "string" ||
    !route.input ||
    !isRecord(route.when) ||
    Object.keys(route.when).length === 0 ||
    !Object.values(route.when).every((target) => typeof target === "string" && target)
  )
    fail(`route for step ${stepId} is invalid`);
}

function assertUnitEngineCompatibility(node: IrExecNode, engines: Record<string, FrozenEngineSnapshot>): void {
  const unit = node.kind === "map" ? node.template : node;
  const engine = unit.invocation ? engines[unit.invocation.engine] : undefined;
  if (!engine) return;
  if (engine.kind === "llm" && ((unit.env?.length ?? 0) > 0 || unit.isolation === "worktree")) {
    fail(`LLM unit ${unit.id} cannot use env injection or worktree isolation`);
  }
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label} contains unknown key ${key}`);
}

function assertJson(value: unknown, depth = 0): void {
  if (depth > 64) fail("plan exceeds JSON depth limit");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new UsageError(`Invalid frozen workflow plan: ${message}.`);
}

/** Removed v2 type name retained only as a TypeScript migration aid. */
export type IrAgentNode = IrUnitNode;
