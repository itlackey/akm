// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import type { LlmConnectionConfig } from "../../core/config/config";
import { deepMergeConfig } from "../../core/config/deep-merge";
import { ConfigError } from "../../core/errors";
import { HARNESS_BY_ID } from "../harnesses";
import { resolveModel } from "./model-aliases";
import type { AgentProfile } from "./profiles";
import type { RunnerSpec } from "./runner";

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
  connection: Omit<LlmConnectionConfig, "apiKey" | "timeoutMs">;
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

function effectiveTimeout(engine: { timeoutMs?: number | null }, layers: readonly EngineUseConfig[]): number | null {
  for (let index = layers.length - 1; index >= 0; index--) {
    if (hasOwn(layers[index] ?? {}, "timeoutMs")) return layers[index]?.timeoutMs ?? null;
  }
  return engine.timeoutMs ?? null;
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
  return {
    engine: name,
    connection: connection as Omit<LlmConnectionConfig, "apiKey" | "timeoutMs">,
    credential: resolveCredential(name, engine, config),
    timeoutMs: effectiveTimeout(engine, layers),
  };
}

/** Read a resolved symbolic credential only at the runtime dispatch boundary. */
export function materializeLlmConnection(resolved: ResolvedLlmUse): LlmConnectionConfig {
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
    ...(resolved.timeoutMs !== null ? { timeoutMs: resolved.timeoutMs } : {}),
  } as LlmConnectionConfig;
}

function lowerAgentEngine(name: string, engine: AgentEngineConfig, config: EngineResolutionConfig): RunnerSpec {
  const harness = HARNESS_BY_ID.get(engine.platform);
  if (!harness?.capabilities.agentDispatch) {
    throw new ConfigError(
      `Engine "${name}" names a platform that cannot dispatch agents: ${engine.platform}.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const sdk = engine.platform === "opencode-sdk";
  const profile: AgentProfile = {
    name,
    platform: engine.platform,
    bin: engine.bin ?? (sdk ? "opencode" : engine.platform),
    args: engine.args ?? [],
    stdio: "captured",
    envPassthrough: [],
    parseOutput: "text",
    ...(engine.workspace ? { workspace: path.resolve(engine.workspace) } : {}),
    ...(engine.model
      ? { model: resolveModel(engine.model, engine.platform, engine.modelAliases, config.modelAliases) }
      : {}),
  };
  if (!sdk) return { kind: "agent", engine: name, profile, timeoutMs: engine.timeoutMs };
  const fallback = resolveLlmEngineUse(config, [{ engine: engine.llmEngine ?? config.defaults?.llmEngine }]);
  if (!fallback) throw new ConfigError(`SDK engine "${name}" has no fallback LLM engine.`, "LLM_NOT_CONFIGURED");
  return {
    kind: "sdk",
    engine: name,
    profile,
    fallbackConnection: materializeLlmConnection(fallback),
    timeoutMs: engine.timeoutMs,
  };
}

/** Lower a named engine through the canonical harness platform. */
export function resolveEngine(name: string, config: EngineResolutionConfig): RunnerSpec {
  const engine = resolveEngineConfig(name, config);
  if (engine.kind === "llm") {
    const resolved = resolveLlmEngineUse(config, [{ engine: name }]);
    if (!resolved) throw new ConfigError(`LLM engine "${name}" could not be resolved.`, "LLM_NOT_CONFIGURED");
    return { kind: "llm", engine: name, connection: materializeLlmConnection(resolved), timeoutMs: resolved.timeoutMs };
  }
  return lowerAgentEngine(name, engine, config);
}

export function resolveDefaultEngine(config: EngineResolutionConfig): RunnerSpec {
  const name = config.defaults?.engine;
  if (!name) throw new ConfigError("No default engine is configured.", "INVALID_CONFIG_FILE");
  return resolveEngine(name, config);
}
