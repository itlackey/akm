// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
// LlmConnectionConfig / AkmConfig come from the dependency-free config-types.ts
// leaf, NOT `../../core/config/config` (WI-9.8 KILL 3, D.3 edge A): config.ts
// used to import `materializeLlmConnection`/`resolveLlmEngineUse` from this
// file for its `requireLlmConfig`/`getDefaultLlmConfig` wrappers, while this
// file imported `LlmConnectionConfig` back from config.ts — a direct 2-file
// cycle that also dragged config.ts into the harness/agent-runtime SCC.
// `requireLlmConfig`/`getDefaultLlmConfig` moved here (see bottom of file) so
// config.ts no longer needs to import this module at all.
import type { AkmConfig, LlmConnectionConfig } from "../../core/config/config-types";
import { deepMergeConfig } from "../../core/config/deep-merge";
import { ConfigError } from "../../core/errors";
import { formatExtraParamsIssue, validateExtraParams } from "../../core/extra-params";
import { collectSensitiveValues } from "../../core/redaction";
import { getHarness } from "../harnesses";
import { DEFAULT_AGENT_TIMEOUT_MS, DEFAULT_LLM_TIMEOUT_MS } from "./config";
import { resolveLlmModel, resolveModel } from "./model-aliases";
import { type AgentProfile, getBuiltinAgentProfile } from "./profiles";

// RunnerSpec referenced via an inline `import("./runner")` TYPE QUERY (WI-9.8
// KILL 3) rather than a top-level `import type`: `./runner.ts` imports real
// VALUES from this module (resolveEngine, resolveLlmEngineUse,
// materializeLlmConnection), so a top-level type import here would close a
// 2-file cycle (this file needs RunnerSpec only as a return-type annotation,
// never a value). Same pattern as `builder-shared.ts`'s `AgentRunResult`
// query — erased at compile time, invisible to the static import graph.
type RunnerSpec = import("./runner").RunnerSpec;

export interface LlmInvocationOverrides {
  temperature?: number;
  maxTokens?: number;
  supportsJsonSchema?: boolean;
  extraParams?: Record<string, unknown>;
  contextLength?: number;
  enableThinking?: boolean;
}

export interface EngineUseConfig {
  engine?: string;
  model?: string;
  timeoutMs?: number | null;
  llm?: LlmInvocationOverrides;
}

export interface LlmEngineConfig {
  kind: "llm";
  provider?: string;
  endpoint: string;
  model: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number | null;
  concurrency?: number;
  supportsJsonSchema?: boolean;
  extraParams?: Record<string, unknown>;
  contextLength?: number;
  enableThinking?: boolean;
}

export interface AgentEngineConfig {
  kind: "agent";
  platform: string;
  bin?: string;
  args?: string[];
  workspace?: string;
  model?: string;
  timeoutMs?: number | null;
  modelAliases?: Record<string, string>;
  llmEngine?: string;
}

export type EngineConfig = LlmEngineConfig | AgentEngineConfig;

export interface EngineResolutionConfig {
  engines?: Record<string, EngineConfig>;
  defaults?: { engine?: string; llmEngine?: string };
  modelAliases?: Record<string, Record<string, string>>;
}

export interface CredentialDescriptor {
  names: [string, ...string[]];
  required: boolean;
}

export interface ResolvedLlmUse {
  engine: string;
  /** Frozen connection fields only; resolution never places apiKey or timeoutMs here. */
  connection: LlmConnectionConfig;
  credential?: CredentialDescriptor;
  timeoutMs: number | null;
}

function hasOwn(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

function envName(reference: string): string | undefined {
  const match = /^\$(?:\{)?([A-Za-z_][A-Za-z0-9_]*)(?:\})?$/.exec(reference);
  return match?.[1];
}

function selectedEngineName(
  config: EngineResolutionConfig,
  layers: readonly EngineUseConfig[],
  llmOnly: boolean,
): string | undefined {
  for (let index = layers.length - 1; index >= 0; index--) {
    if (layers[index]?.engine !== undefined) return layers[index]?.engine;
  }
  return llmOnly ? config.defaults?.llmEngine : config.defaults?.engine;
}

function resolveEngineConfig(name: string, config: EngineResolutionConfig): EngineConfig {
  const engine = config.engines?.[name];
  if (!engine) {
    throw new ConfigError(`Engine "${name}" is not configured.`, "INVALID_CONFIG_FILE");
  }
  return engine;
}

function resolveCredential(
  name: string,
  engine: LlmEngineConfig,
  config: EngineResolutionConfig,
): CredentialDescriptor | undefined {
  if (engine.apiKey !== undefined) {
    const explicit = envName(engine.apiKey);
    if (!explicit)
      throw new ConfigError(`Engine "${name}" has an invalid symbolic apiKey reference.`, "INVALID_CONFIG_FILE");
    return { names: [explicit], required: true };
  }
  const specific = `AKM_ENGINE_${name.toUpperCase().replaceAll("-", "_")}_API_KEY`;
  return config.defaults?.llmEngine === name
    ? { names: [specific, "AKM_LLM_API_KEY"], required: false }
    : { names: [specific], required: false };
}

/** Collect materialized engine credentials for output and persistence redaction. */
export function collectEngineCredentialValues(
  config: EngineResolutionConfig,
  envSource: NodeJS.ProcessEnv = process.env,
): string[] {
  const values = new Set<string>();
  for (const [name, engine] of Object.entries(config.engines ?? {})) {
    if (engine.kind !== "llm") continue;
    for (const envVar of resolveCredential(name, engine, config)?.names ?? []) {
      const value = envSource[envVar]?.trim();
      if (value) values.add(value);
    }
  }
  return collectSensitiveValues(values);
}

function effectiveTimeout(
  engine: { timeoutMs?: number | null },
  layers: readonly EngineUseConfig[],
  fallback: number,
): number | null {
  for (let index = layers.length - 1; index >= 0; index--) {
    if (hasOwn(layers[index] ?? {}, "timeoutMs")) return layers[index]?.timeoutMs ?? null;
  }
  return hasOwn(engine, "timeoutMs") ? (engine.timeoutMs ?? null) : fallback;
}

/** Resolve one selected LLM engine and overlays without materializing credentials. */
export function resolveLlmEngineUse(
  config: EngineResolutionConfig,
  layers: readonly EngineUseConfig[],
  options: { optional: true },
): ResolvedLlmUse | undefined;
export function resolveLlmEngineUse(
  config: EngineResolutionConfig,
  layers: readonly EngineUseConfig[],
  options?: { optional?: false },
): ResolvedLlmUse;
export function resolveLlmEngineUse(
  config: EngineResolutionConfig,
  layers: readonly EngineUseConfig[],
  options: { optional?: boolean } = {},
): ResolvedLlmUse | undefined {
  const name = selectedEngineName(config, layers, true);
  if (!name) {
    if (options.optional) return undefined;
    throw new ConfigError("No LLM engine is selected. Set defaults.llmEngine or specify engine.", "LLM_NOT_CONFIGURED");
  }
  const engine = resolveEngineConfig(name, config);
  if (engine.kind !== "llm") {
    throw new ConfigError(`Engine "${name}" is not an LLM engine.`, "INVALID_CONFIG_FILE");
  }

  let connection: Record<string, unknown> = {
    provider: engine.provider,
    endpoint: engine.endpoint,
    model: engine.model,
    temperature: engine.temperature,
    maxTokens: engine.maxTokens,
    supportsJsonSchema: engine.supportsJsonSchema,
    extraParams: engine.extraParams,
    contextLength: engine.contextLength,
    enableThinking: engine.enableThinking,
  };
  for (const layer of layers) {
    if (layer.llm) connection = deepMergeConfig(connection, layer.llm as Record<string, unknown>);
    if (layer.model !== undefined) connection.model = layer.model;
  }
  for (const key of Object.keys(connection)) {
    if (connection[key] === undefined) delete connection[key];
  }
  connection.model = resolveLlmModel(connection.model as string, name, config.modelAliases);
  return {
    engine: name,
    connection: connection as LlmConnectionConfig,
    credential: resolveCredential(name, engine, config),
    timeoutMs: effectiveTimeout(engine, layers, DEFAULT_LLM_TIMEOUT_MS),
  };
}

/** Read a resolved symbolic credential only at the runtime dispatch boundary. */
export function materializeLlmConnection(resolved: ResolvedLlmUse): LlmConnectionConfig {
  if (resolved.connection.extraParams !== undefined) {
    const issue = validateExtraParams(resolved.connection.extraParams)[0];
    if (issue) {
      throw new ConfigError(
        formatExtraParamsIssue(`Engine "${resolved.engine}" extraParams`, issue),
        "INVALID_CONFIG_FILE",
      );
    }
  }
  let apiKey: string | undefined;
  for (const name of resolved.credential?.names ?? []) {
    const candidate = process.env[name]?.trim();
    if (candidate) {
      apiKey = candidate;
      break;
    }
  }
  if (resolved.credential?.required && !apiKey) {
    throw new ConfigError(
      `Required engine credential ${resolved.credential.names[0]} is not set.`,
      "INVALID_CONFIG_FILE",
    );
  }
  return {
    ...resolved.connection,
    ...(apiKey ? { apiKey } : {}),
    timeoutMs: resolved.timeoutMs,
  } as LlmConnectionConfig;
}

function lowerAgentEngine(name: string, engine: AgentEngineConfig, config: EngineResolutionConfig): RunnerSpec {
  const harness = getHarness(engine.platform);
  if (!harness?.capabilities.agentDispatch) {
    throw new ConfigError(
      `Engine "${name}" names a platform that cannot dispatch agents: ${engine.platform}.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const platform = harness.id;
  const sdk = platform === "opencode-sdk";
  const builtin = getBuiltinAgentProfile(platform);
  const profile: AgentProfile = {
    name,
    platform,
    bin: engine.bin ?? builtin?.bin ?? (sdk ? "opencode" : platform),
    args: engine.args ?? builtin?.args ?? [],
    stdio: "captured",
    ...(builtin?.env ? { env: builtin.env } : {}),
    envPassthrough: builtin?.envPassthrough ?? [],
    parseOutput: "text",
    ...(engine.workspace ? { workspace: path.resolve(engine.workspace) } : {}),
    ...(engine.model
      ? {
          model: resolveModel(engine.model, platform, engine.modelAliases, config.modelAliases),
          modelIsExact: true,
        }
      : {}),
    ...(engine.modelAliases ? { modelAliases: engine.modelAliases } : {}),
    ...(config.modelAliases ? { globalModelAliases: config.modelAliases } : {}),
  };
  if (!sdk) {
    return {
      kind: "agent",
      engine: name,
      profile,
      timeoutMs: hasOwn(engine, "timeoutMs") ? (engine.timeoutMs ?? null) : DEFAULT_AGENT_TIMEOUT_MS,
    };
  }
  const fallbackName = engine.llmEngine ?? config.defaults?.llmEngine;
  const fallback = fallbackName
    ? resolveLlmEngineUse(config, [{ engine: fallbackName }], { optional: true })
    : undefined;
  return {
    kind: "sdk",
    engine: name,
    profile,
    ...(fallback
      ? {
          fallbackConnection: fallback.connection,
          ...(fallback.credential ? { fallbackCredential: fallback.credential } : {}),
          fallbackTimeoutMs: fallback.timeoutMs,
        }
      : {}),
    timeoutMs: hasOwn(engine, "timeoutMs")
      ? (engine.timeoutMs ?? null)
      : (fallback?.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS),
  };
}

/** Lower a named engine through the canonical harness platform. */
export function resolveEngine(name: string, config: EngineResolutionConfig): RunnerSpec {
  const engine = resolveEngineConfig(name, config);
  if (engine.kind === "llm") {
    const resolved = resolveLlmEngineUse(config, [{ engine: name }]);
    if (!resolved) throw new ConfigError(`LLM engine "${name}" could not be resolved.`, "LLM_NOT_CONFIGURED");
    return {
      kind: "llm",
      engine: name,
      connection: resolved.connection,
      ...(resolved.credential ? { credential: resolved.credential } : {}),
      timeoutMs: resolved.timeoutMs,
    };
  }
  return lowerAgentEngine(name, engine, config);
}

export function resolveDefaultEngine(config: EngineResolutionConfig): RunnerSpec {
  const name = config.defaults?.engine;
  if (!name) throw new ConfigError("No default engine is configured.", "INVALID_CONFIG_FILE");
  return resolveEngine(name, config);
}

// ── AkmConfig convenience wrappers (moved from core/config/config.ts, WI-9.8
// KILL 3, D.3 edge A) ────────────────────────────────────────────────────────
//
// Moved verbatim: `config.ts` previously called `materializeLlmConnection` +
// `resolveLlmEngineUse` directly for these two wrappers, which is what made
// config.ts import this module — and this module imported `LlmConnectionConfig`
// back from config.ts, closing a 2-file cycle. config.ts CANNOT re-export
// these (a re-export is still a graph edge to this file), so the small number
// of call sites that used to import them from "core/config/config" now import
// them from here instead (see D.3 edge A "callers compose instead").

/** Resolve and materialize the configured default LLM engine at dispatch time. */
export function requireLlmConfig(config: AkmConfig): LlmConnectionConfig {
  return materializeLlmConnection(resolveLlmEngineUse(config, []));
}

/**
 * Like {@link requireLlmConfig} but returns `undefined` instead of throwing
 * when no LLM is configured. Use in code paths where the LLM is optional.
 */
export function getDefaultLlmConfig(config: AkmConfig): LlmConnectionConfig | undefined {
  const resolved = resolveLlmEngineUse(config, [], { optional: true });
  return resolved ? materializeLlmConnection(resolved) : undefined;
}
