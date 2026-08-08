// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import type { AkmConfig } from "../../core/config/config";
import { deepMergeConfig } from "../../core/config/deep-merge";
import { ConfigError, UsageError } from "../../core/errors";
import { DEFAULT_AGENT_TIMEOUT_MS, DEFAULT_LLM_TIMEOUT_MS } from "../../integrations/agent/config";
import {
  FALLBACK_ANNOUNCEMENT,
  NO_ENGINE_MESSAGE_SUFFIX,
  NO_ENGINE_REMEDY,
  withEngineFallback,
} from "../../integrations/agent/engine-fallback";
import {
  type EngineConfig,
  type EngineUseConfig,
  resolveLlmEngineUse,
} from "../../integrations/agent/engine-resolution";
import { resolveLlmModel, resolveModel } from "../../integrations/agent/model-aliases";
import { getBuiltinAgentProfile } from "../../integrations/agent/profiles";
import { HARNESS_BY_ID } from "../../integrations/harnesses";
import { defaultLlmEngineConcurrency, defaultMapConcurrency, workflowMaxConcurrency } from "../concurrency-policy";
import type { ProgramUnit } from "../program/schema";
import { DEFAULT_EXEC_TIMEOUT_MS } from "../resource-limits";
import type { WorkflowAsset } from "../runtime/workflow-asset-loader";
import { compileWorkflowPlan, type WorkflowPlanDraft, type WorkflowUnitDraft } from "./compile";
import type {
  FrozenAgentEngine,
  FrozenEngineSnapshot,
  FrozenLlmEngine,
  IrExecSpec,
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
  /**
   * Set when the implicit `opencode-sdk` engine fallback supplied the engine
   * (`integrations/agent/engine-fallback.ts`). Surfaced once per run by the
   * caller — a silently-chosen model is exactly the thing that confuses a
   * reader of the resulting bill or artifact.
   */
  engineAnnouncement?: string;
}

export interface FreezeOptions {
  /**
   * Test seam for the compile pass. Production always leaves this unset and
   * gets {@link compilePlan} (→ `compileWorkflowPlan`). It exists so a test can
   * hand this boundary a draft step list that is REORDERED or FILTERED relative
   * to `asset.document.steps` and prove that override attribution still follows
   * `stepId` rather than array position — the invariant the positional lookup
   * used to depend on without ever stating it.
   */
  compile?: (asset: WorkflowAsset) => WorkflowPlanDraft & { warnings: import("../schema").WorkflowError[] };
}

/**
 * The only source-to-runtime boundary. Source compilation remains pure; engine
 * selection and every dispatch-significant setting are resolved here once.
 */
export function compileResolveFreezeWorkflow(
  asset: WorkflowAsset,
  inputConfig: AkmConfig,
  options: FreezeOptions = {},
): FrozenWorkflow {
  // Applied ONCE, before any resolution: every engine lookup below (selection,
  // snapshots, the gate judge) then sees one config and needs no fallback
  // awareness of its own.
  const { config, fallbackEngineName } = withEngineFallback(inputConfig);
  // Announce only if the fallback candidate is what a unit actually froze to:
  // `defaults.engine` is the lowest-precedence selector, so a document- or
  // unit-level `engine:` still wins and must not be reported as opencode's.
  let usedFallbackEngine = false;
  const preliminary = (options.compile ?? compilePlan)(asset);
  const engines: Record<string, FrozenEngineSnapshot> = {};
  const maxConcurrency = frozenConcurrency(config);
  const mapDefaultConcurrency = frozenMapDefaultConcurrency(config);
  const documentDefaults = asset.document.defaults;
  // Keyed by stepId, NOT by array position. Compile is 1:1 and order-preserving
  // today, so `asset.document.steps[index]` happened to line up with
  // `preliminary.steps[index]` — but nothing enforces that, and a compile pass
  // that ever filtered or reordered steps would silently attribute one step's
  // engine/model/timeout overrides to a different step. Every draft step
  // already carries its `stepId`, so look the source up by it.
  const sourceStepsById = new Map(asset.document.steps.map((step) => [step.id, step]));

  const freezeInvocation = (unit: ProgramUnit | undefined, stepId: string): IrInvocation => {
    const layers: EngineUseConfig[] = [...(documentDefaults ? [documentDefaults] : []), ...(unit ? [unit] : [])];
    const name = selectedEngine(config, layers);
    if (!name)
      throw new ConfigError(
        // Reached only when the implicit opencode-sdk fallback did not apply
        // either, so the remedy names both routes.
        `This workflow ${NO_ENGINE_MESSAGE_SUFFIX} Set defaults.engine or workflow defaults.engine.`,
        "INVALID_CONFIG_FILE",
        NO_ENGINE_REMEDY,
      );
    if (name === fallbackEngineName) usedFallbackEngine = true;
    const engine = engineDefinition(config, name);
    addSnapshot(config, name, engines);
    const model = exactModel(config, name, engine, layers);
    const timeoutMs = effectiveTimeout(config, engine, layers);
    // Merge llm overrides REGARDLESS of engine kind so a non-llm engine with
    // overrides anywhere in its layer stack (unit `llm:` or document
    // `defaults.llm`) is detected instead of silently dropped. SDK engines'
    // legitimate LLM *fallback* (`llmEngine`) is a separate mechanism — it
    // never contributes to `layers`, so it cannot false-positive here.
    const llm = mergedLlmOverrides(layers);
    if (engine.kind !== "llm" && llm !== undefined) {
      throw new ConfigError(
        `Workflow step "${stepId}" uses engine "${name}", which is an agent engine and cannot receive llm: ` +
          `overrides — llm: tuning (from the step's unit or defaults.llm) applies only to engines of kind "llm". ` +
          `Remove the llm: block or select an LLM engine for this step.`,
        "INVALID_CONFIG_FILE",
      );
    }
    return { engine: name, model, timeoutMs, ...(llm ? { llm } : {}) };
  };

  /**
   * Resolve an exec unit's wall-clock budget at the single freeze boundary:
   * unit `timeout:` → document `defaults.timeout` → {@link DEFAULT_EXEC_TIMEOUT_MS}.
   * There is no engine layer to consult — an exec unit names no engine — and
   * `null` (the author's `timeout: none`) is honored as genuinely unbounded,
   * exactly like `effectiveTimeout`'s null.
   */
  const freezeExec = (exec: NonNullable<WorkflowUnitDraft["exec"]>, unit: ProgramUnit | undefined): IrExecSpec => {
    const layers = [...(documentDefaults ? [documentDefaults] : []), ...(unit ? [unit] : [])];
    let timeoutMs: number | null = DEFAULT_EXEC_TIMEOUT_MS;
    for (let index = layers.length - 1; index >= 0; index--) {
      if (Object.hasOwn(layers[index] ?? {}, "timeoutMs")) {
        timeoutMs = layers[index]?.timeoutMs ?? null;
        break;
      }
    }
    return {
      command: [...exec.command] as [string, ...string[]],
      ...(exec.cwd ? { cwd: exec.cwd } : {}),
      // Env-scope keys are frozen structurally (the draft already dropped an
      // empty `passEnv` and a false `inheritEnv`), so the default allowlist
      // stays the ABSENCE of both keys — one encoding per state, which is what
      // keeps the canonical hash preimage stable.
      ...(exec.passEnv && exec.passEnv.length > 0 ? { passEnv: [...exec.passEnv] } : {}),
      ...(exec.inheritEnv ? { inheritEnv: true as const } : {}),
      timeoutMs,
    };
  };

  const freezeUnit = (node: WorkflowUnitDraft, stepId: string, unit?: ProgramUnit): IrUnitNode => ({
    kind: "unit",
    id: node.id,
    instructions: node.instructions,
    templating: node.templating ?? "verbatim",
    ...(node.inputs && node.inputs.length > 0 ? { inputs: node.inputs } : {}),
    // An exec unit dispatches a child process, so it freezes an exec spec and
    // NO invocation — engine selection is skipped entirely, which is why an
    // exec-only workflow runs on an install with no engines configured at all.
    ...(node.exec ? { exec: freezeExec(node.exec, unit) } : { invocation: freezeInvocation(unit, stepId) }),
    ...(node.schema ? { schema: node.schema } : {}),
    ...(node.retry ? { retry: node.retry } : {}),
    onError: node.onError,
    ...(node.env ? { env: node.env } : {}),
    isolation: node.isolation ?? "none",
    ...(node.source ? { source: node.source } : {}),
  });

  const steps: IrStepPlan[] = preliminary.steps.map((step) => {
    const sourceStep = sourceStepsById.get(step.stepId);
    const sourceUnit = sourceStep?.map ? sourceStep.map.unit : sourceStep?.unit;
    const root = step.root
      ? step.root.kind === "map"
        ? {
            kind: "map" as const,
            id: step.root.id,
            over: step.root.over,
            template: freezeUnit(step.root.template, step.stepId, sourceUnit),
            // `?? ` — not `||` — keeps an authored `concurrency: 1` (explicit
            // opt-out, serial) distinguishable from an unset one (the default).
            concurrency: step.root.concurrency ?? mapDefaultConcurrency,
            reducer: step.root.reducer,
            ...(step.root.source ? { source: step.root.source } : {}),
          }
        : freezeUnit(step.root, step.stepId, sourceUnit)
      : undefined;
    const criteria = step.gate.criteria;
    const judge = criteria.length === 0 ? null : freezeGateJudge(config, engines);
    const gate: IrGateNode = {
      kind: "gate",
      id: `${step.stepId}.gate`,
      stepId: step.stepId,
      criteria,
      maxLoops: step.gate.maxLoops ?? 1,
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
  // `usedFallbackEngine` IS the candidate-won predicate, so use the constant
  // directly rather than re-asking a helper to compare a name with itself.
  const engineAnnouncement = usedFallbackEngine ? FALLBACK_ANNOUNCEMENT : undefined;
  return {
    warnings: preliminary.warnings,
    ...(engineAnnouncement ? { engineAnnouncement } : {}),
    plan,
  };
}

function compilePlan(asset: WorkflowAsset): WorkflowPlanDraft & { warnings: import("../schema").WorkflowError[] } {
  const compiled = compileWorkflowPlan(asset.document, asset.title);
  if (!compiled.ok)
    throw new UsageError(compiled.errors.map((error) => `${asset.path}:${error.line}: ${error.message}`).join("\n"));
  return { ...compiled.plan, warnings: compiled.warnings };
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
    if (engine.platform === "opencode-sdk") {
      const fallbackName = engine.llmEngine ?? config.defaults?.llmEngine;
      if (fallbackName) {
        const fallback = engineDefinition(config, fallbackName);
        if (fallback.kind !== "llm") {
          throw new ConfigError(
            `SDK engine "${name}" fallback "${fallbackName}" is not an LLM engine.`,
            "INVALID_CONFIG_FILE",
          );
        }
        return exactModel(config, fallbackName, fallback, []);
      }
    }
    return null;
  }
  if (engine.kind === "llm") return resolveLlmModel(selected, name, config.modelAliases);
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
      concurrency: defaultLlmEngineConcurrency(engine.endpoint, engine.concurrency),
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
    commandBuilder: engine.platform,
    fallbackLlmEngine: fallback,
  };
  target[name] = snapshot;
}

function freezeGateJudge(config: AkmConfig, engines: Record<string, FrozenEngineSnapshot>): IrInvocation {
  const name = config.workflow?.judgeEngine;
  if (!name) {
    throw new ConfigError(
      "This workflow declares completion criteria but no verification engine is configured. Set workflow.judgeEngine to a named LLM or agent engine.",
      "INVALID_CONFIG_FILE",
    );
  }
  const engine = engineDefinition(config, name);
  addSnapshot(config, name, engines);
  return {
    engine: name,
    model: exactModel(config, name, engine, []),
    timeoutMs: effectiveTimeout(config, engine, []),
  };
}

function frozenConcurrency(config: AkmConfig): number {
  const configured = config.workflow?.maxConcurrency;
  return workflowMaxConcurrency(typeof configured === "number" && Number.isFinite(configured) ? configured : undefined);
}

/**
 * Width to freeze into a `map` node that declared no `concurrency:`. Resolved
 * HERE, at the single freeze boundary, so the number lands in `plan_json` and
 * an in-flight run keeps the width it started with even if this default (or
 * the config key) changes underneath it.
 */
function frozenMapDefaultConcurrency(config: AkmConfig): number {
  const configured = config.workflow?.defaultMapConcurrency;
  return defaultMapConcurrency(typeof configured === "number" ? configured : undefined);
}
