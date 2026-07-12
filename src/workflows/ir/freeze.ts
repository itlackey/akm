// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import type { AkmConfig } from "../../core/config/config";
import { deepMergeConfig } from "../../core/config/deep-merge";
import { ConfigError, UsageError } from "../../core/errors";
import { DEFAULT_AGENT_TIMEOUT_MS, DEFAULT_LLM_TIMEOUT_MS } from "../../integrations/agent/config";
import {
  type EngineConfig,
  type EngineUseConfig,
  resolveLlmEngineUse,
} from "../../integrations/agent/engine-resolution";
import { resolveModel } from "../../integrations/agent/model-aliases";
import { getBuiltinAgentProfile } from "../../integrations/agent/profiles";
import { HARNESS_BY_ID } from "../../integrations/harnesses";
import type { ProgramUnit } from "../program/schema";
import type { WorkflowAsset } from "../runtime/workflow-asset-loader";
import { compileWorkflowPlan, compileWorkflowProgram, type WorkflowProgramCompileResult } from "./compile";
import type {
  FrozenAgentEngine,
  FrozenEngineSnapshot,
  FrozenLlmEngine,
  IrGateNode,
  IrInvocation,
  IrStepPlan,
  IrUnitNode,
  WorkflowPlanGraph,
} from "./schema";
import { decodeWorkflowPlanV3, WORKFLOW_IR_VERSION } from "./schema";

export interface FrozenWorkflow {
  plan: WorkflowPlanGraph;
  warnings: import("../schema").WorkflowError[];
}

/**
 * The only source-to-runtime boundary. Source compilation remains pure; engine
 * selection and every dispatch-significant setting are resolved here once.
 */
export function compileResolveFreezeWorkflow(asset: WorkflowAsset, config: AkmConfig): FrozenWorkflow {
  const preliminary = asset.program ? compileProgram(asset) : compileMarkdown(asset);
  const engines: Record<string, FrozenEngineSnapshot> = {};
  const maxConcurrency = frozenConcurrency(config);
  const programDefaults = asset.program?.defaults;

  const freezeInvocation = (unit: ProgramUnit | undefined, fallbackEngine?: string): IrInvocation => {
    const layers: EngineUseConfig[] = [
      ...(programDefaults ? [programDefaults] : []),
      ...(unit ? [unit] : []),
      ...(fallbackEngine ? [{ engine: fallbackEngine }] : []),
    ];
    const name = selectedEngine(config, layers);
    if (!name)
      throw new ConfigError(
        "No workflow engine is selected. Set defaults.engine or workflow defaults.engine.",
        "INVALID_CONFIG_FILE",
      );
    const engine = engineDefinition(config, name);
    addSnapshot(config, name, engines);
    const model = exactModel(config, name, engine, layers);
    const timeoutMs = effectiveTimeout(config, engine, layers);
    const llm = engine.kind === "llm" ? mergedLlmOverrides(layers) : undefined;
    if (engine.kind !== "llm" && llm !== undefined) {
      throw new ConfigError(
        `Workflow engine "${name}" is an agent engine and cannot receive llm overrides.`,
        "INVALID_CONFIG_FILE",
      );
    }
    return { engine: name, model, timeoutMs, ...(llm ? { llm } : {}) };
  };

  const freezeUnit = (node: IrUnitNode, unit?: ProgramUnit): IrUnitNode => ({
    kind: "unit",
    id: node.id,
    instructions: node.instructions,
    templating: node.templating ?? "verbatim",
    invocation: freezeInvocation(unit, node.invocation?.engine),
    ...(node.schema ? { schema: node.schema } : {}),
    ...(node.retry ? { retry: node.retry } : {}),
    onError: node.onError,
    ...(node.env ? { env: node.env } : {}),
    isolation: node.isolation ?? "none",
    ...(node.source ? { source: node.source } : {}),
  });

  const steps: IrStepPlan[] = preliminary.steps.map((step, index) => {
    const sourceStep = asset.program?.steps[index];
    const sourceUnit = sourceStep?.unit ?? sourceStep?.map?.unit;
    const root = step.root
      ? step.root.kind === "map"
        ? {
            kind: "map" as const,
            id: step.root.id,
            over: step.root.over,
            template: freezeUnit(step.root.template, sourceUnit),
            concurrency: step.root.concurrency ?? 1,
            reducer: step.root.reducer,
            ...(step.root.source ? { source: step.root.source } : {}),
          }
        : freezeUnit(step.root, sourceUnit)
      : undefined;
    const criteria = step.gate.criteria;
    const judge = criteria.length === 0 ? null : freezeGateJudge(config, engines, step.gate.required === true);
    const gate: IrGateNode = {
      kind: "gate",
      id: `${step.stepId}.gate`,
      stepId: step.stepId,
      criteria,
      maxLoops: step.gate.maxLoops ?? 1,
      required: step.gate.required === true,
      judge,
    };
    return {
      stepId: step.stepId,
      title: step.title,
      sequenceIndex: step.sequenceIndex,
      ...(root ? { root } : {}),
      ...(step.route ? { route: step.route } : {}),
      ...(step.outputSchema ? { outputSchema: step.outputSchema } : {}),
      gate,
    };
  });

  const plan = decodeWorkflowPlanV3({
    irVersion: WORKFLOW_IR_VERSION,
    title: preliminary.title,
    ...(preliminary.params ? { params: preliminary.params } : {}),
    ...(preliminary.paramSchemas ? { paramSchemas: preliminary.paramSchemas } : {}),
    ...(preliminary.budget ? { budget: preliminary.budget } : {}),
    execution: { maxConcurrency, engines },
    steps,
  });
  return {
    warnings: asset.program ? preliminary.warnings : [],
    plan,
  };
}

function compileProgram(asset: WorkflowAsset): WorkflowPlanGraph & { warnings: import("../schema").WorkflowError[] } {
  if (!asset.program) throw new UsageError(`Workflow asset ${asset.ref} has no YAML program.`);
  const compiled: WorkflowProgramCompileResult = compileWorkflowProgram(asset.program);
  if (!compiled.ok)
    throw new UsageError(compiled.errors.map((error) => `${asset.path}:${error.line}: ${error.message}`).join("\n"));
  return { ...compiled.plan, warnings: compiled.warnings };
}

function compileMarkdown(asset: WorkflowAsset): WorkflowPlanGraph & { warnings: import("../schema").WorkflowError[] } {
  if (!asset.document) throw new UsageError(`Workflow asset ${asset.ref} has no source document.`);
  return { ...compileWorkflowPlan(asset.document), warnings: [] };
}

function selectedEngine(config: AkmConfig, layers: readonly EngineUseConfig[]): string | undefined {
  for (let index = layers.length - 1; index >= 0; index--)
    if (layers[index]?.engine !== undefined) return layers[index]?.engine;
  return config.defaults?.engine;
}

function engineDefinition(config: AkmConfig, name: string): EngineConfig {
  const engine = config.engines?.[name] as EngineConfig | undefined;
  if (!engine) throw new ConfigError(`Engine "${name}" is not configured.`, "INVALID_CONFIG_FILE");
  return engine;
}

function exactModel(
  config: AkmConfig,
  name: string,
  engine: EngineConfig,
  layers: readonly EngineUseConfig[],
): string | null {
  let selected: string | undefined;
  for (const layer of layers) if (layer.model !== undefined) selected = layer.model;
  selected ??= engine.model;
  if (!selected) {
    if (engine.kind === "llm") throw new ConfigError(`LLM engine "${name}" has no model.`, "INVALID_CONFIG_FILE");
    return null;
  }
  if (engine.kind === "llm") return resolveModel(selected, name, undefined, config.modelAliases);
  return resolveModel(selected, engine.platform, engine.modelAliases, config.modelAliases);
}

function effectiveTimeout(config: AkmConfig, engine: EngineConfig, layers: readonly EngineUseConfig[]): number | null {
  for (let index = layers.length - 1; index >= 0; index--) {
    if (Object.hasOwn(layers[index] ?? {}, "timeoutMs")) return layers[index]?.timeoutMs ?? null;
  }
  if (Object.hasOwn(engine, "timeoutMs")) return engine.timeoutMs ?? null;
  if (engine.kind === "llm") return DEFAULT_LLM_TIMEOUT_MS;
  if (engine.platform === "opencode-sdk") {
    const fallbackName = engine.llmEngine ?? config.defaults?.llmEngine;
    if (fallbackName) {
      const fallback = engineDefinition(config, fallbackName);
      if (fallback.kind === "llm") {
        return Object.hasOwn(fallback, "timeoutMs") ? (fallback.timeoutMs ?? null) : DEFAULT_LLM_TIMEOUT_MS;
      }
    }
  }
  return DEFAULT_AGENT_TIMEOUT_MS;
}

function mergedLlmOverrides(layers: readonly EngineUseConfig[]): Record<string, unknown> | undefined {
  let merged: Record<string, unknown> | undefined;
  for (const layer of layers)
    if (layer.llm) merged = deepMergeConfig(merged ?? {}, layer.llm as Record<string, unknown>);
  return merged;
}

function addSnapshot(config: AkmConfig, name: string, target: Record<string, FrozenEngineSnapshot>): void {
  if (target[name]) return;
  const engine = engineDefinition(config, name);
  if (engine.kind === "llm") {
    const resolved = resolveLlmEngineUse(config, [{ engine: name }]);
    const snapshot: FrozenLlmEngine = {
      name,
      kind: "llm",
      endpoint: engine.endpoint,
      model: exactModel(config, name, engine, []) as string,
      timeoutMs: resolved.timeoutMs,
      concurrency: engine.concurrency ?? 1,
      ...(engine.provider ? { provider: engine.provider } : {}),
      ...(resolved.credential ? { credential: resolved.credential } : {}),
      ...(engine.temperature !== undefined ? { temperature: engine.temperature } : {}),
      ...(engine.maxTokens !== undefined ? { maxTokens: engine.maxTokens } : {}),
      ...(engine.supportsJsonSchema !== undefined ? { supportsJsonSchema: engine.supportsJsonSchema } : {}),
      ...(engine.extraParams ? { extraParams: engine.extraParams } : {}),
      ...(engine.contextLength !== undefined ? { contextLength: engine.contextLength } : {}),
      ...(engine.enableThinking !== undefined ? { enableThinking: engine.enableThinking } : {}),
    };
    target[name] = snapshot;
    return;
  }
  const harness = HARNESS_BY_ID.get(engine.platform);
  if (!harness?.capabilities.agentDispatch)
    throw new ConfigError(`Engine "${name}" cannot dispatch platform ${engine.platform}.`, "INVALID_CONFIG_FILE");
  const sdk = engine.platform === "opencode-sdk";
  const builtin = getBuiltinAgentProfile(engine.platform);
  const fallback = sdk ? (engine.llmEngine ?? config.defaults?.llmEngine ?? null) : null;
  if (fallback) addSnapshot(config, fallback, target);
  const snapshot: FrozenAgentEngine = {
    name,
    kind: "agent",
    runnerKind: sdk ? "sdk" : "agent",
    platform: engine.platform,
    bin: engine.bin ?? builtin?.bin ?? (sdk ? "opencode" : engine.platform),
    args: [...(engine.args ?? builtin?.args ?? [])],
    workspace: engine.workspace ? path.resolve(engine.workspace) : null,
    envPassthrough: [...(builtin?.envPassthrough ?? [])],
    commandBuilder: builtin?.commandBuilder ?? engine.platform,
    fallbackLlmEngine: fallback,
  };
  target[name] = snapshot;
}

function freezeGateJudge(
  config: AkmConfig,
  engines: Record<string, FrozenEngineSnapshot>,
  required: boolean,
): IrInvocation | null {
  const resolved = resolveLlmEngineUse(config, [], { optional: true });
  if (!resolved) {
    if (required)
      throw new ConfigError("A required workflow gate needs defaults.llmEngine at start.", "LLM_NOT_CONFIGURED");
    return null;
  }
  addSnapshot(config, resolved.engine, engines);
  return {
    engine: resolved.engine,
    model: exactModel(config, resolved.engine, engineDefinition(config, resolved.engine), []),
    timeoutMs: resolved.timeoutMs,
  };
}

function frozenConcurrency(config: AkmConfig): number {
  const configured = config.workflow?.maxConcurrency;
  if (typeof configured === "number" && Number.isFinite(configured))
    return Math.min(64, Math.max(1, Math.floor(configured)));
  return 1;
}
