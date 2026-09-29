// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSecret } from "../../core/config/config";
import type { LlmConnectionConfig } from "../../core/config/config-types";
import { deepMergeConfig } from "../../core/config/deep-merge";
import { SECRET_STORE_REFERENCE_PATTERN } from "../../core/config/schema/primitives";
import { ConfigError } from "../../core/errors";
import { formatExtraParamsIssue, validateExtraParams } from "../../core/extra-params";
import { collectSensitiveValues } from "../../core/redaction";
import { warn } from "../../core/warn";
import { resolveSecretFromStore } from "../../sources/snapshot-fetchers/secret-seam";
import { getHarness } from "../harnesses";
import { DEFAULT_AGENT_TIMEOUT_MS, DEFAULT_LLM_TIMEOUT_MS } from "./config";
import { type AgentProfile, getBuiltinAgentProfile, OPENCODE_SDK_SERVER_BIN } from "./profiles";

// `./runner.ts` imports values from this module, so RunnerSpec is referenced
// through an erased type query instead of a top-level import (no cycle).
type RunnerSpec = import("./runner").RunnerSpec;

export interface LlmInvocationOverrides {
  temperature?: number;
  maxTokens?: number;
  supportsJsonSchema?: boolean;
  extraParams?: Record<string, unknown>;
  contextLength?: number;
  enableThinking?: boolean;
  reasoningEffort?: string;
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
  apiKeyFile?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number | null;
  concurrency?: number;
  supportsJsonSchema?: boolean;
  extraParams?: Record<string, unknown>;
  contextLength?: number;
  enableThinking?: boolean;
  reasoningEffort?: string;
}

export interface AgentEngineConfig {
  kind: "agent";
  platform: string;
  bin?: string;
  args?: string[];
  workspace?: string;
  model?: string;
  timeoutMs?: number | null;
  llmEngine?: string;
}

export type EngineConfig = LlmEngineConfig | AgentEngineConfig;

export interface EngineResolutionConfig {
  engines?: Record<string, EngineConfig>;
  defaults?: { engine?: string; llmEngine?: string };
}

export interface CredentialDescriptor {
  names: [string, ...string[]];
  required: boolean;
}

/**
 * One selected LLM engine with overlays applied. Credentials stay symbolic
 * here — an env descriptor, a file path (#905), or a `secret://` reference
 * (#953) — and are read only at dispatch by {@link resolveLlmCredentialValue}.
 */
export interface ResolvedLlmUse {
  engine: string;
  connection: LlmConnectionConfig;
  credential?: CredentialDescriptor;
  apiKeyFile?: string;
  apiKeySecretRef?: string;
  timeoutMs: number | null;
}

const LLM_CONNECTION_FIELDS = [
  "provider",
  "endpoint",
  "model",
  "temperature",
  "maxTokens",
  "supportsJsonSchema",
  "extraParams",
  "contextLength",
  "enableThinking",
  "reasoningEffort",
] as const;

function envName(reference: string): string | undefined {
  const match = /^\$(?:\{)?([A-Za-z_][A-Za-z0-9_]*)(?:\})?$/.exec(reference);
  return match?.[1];
}

function expandHomePath(filePath: string): string {
  return filePath.startsWith("~") ? path.join(os.homedir(), filePath.slice(1)) : filePath;
}

/** Trim exactly one trailing newline (`\n` or `\r\n`) — never interior whitespace. */
function trimTrailingNewline(raw: string): string {
  return raw.replace(/\r?\n$/, "");
}

/** Read a file-backed credential; errors name the engine and path, never the contents. */
function readApiKeyFile(engineName: string, filePath: string): string {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    const reason = code === "ENOENT" ? "does not exist" : "could not be read";
    throw new ConfigError(`Engine "${engineName}" apiKeyFile ${reason}: ${filePath}`, "INVALID_CONFIG_FILE");
  }
  const value = trimTrailingNewline(raw);
  if (value.length === 0) {
    throw new ConfigError(`Engine "${engineName}" apiKeyFile is empty: ${filePath}`, "INVALID_CONFIG_FILE");
  }
  return value;
}

/** Best-effort, non-throwing read of a file-backed credential for redaction and health. */
export function lookupApiKeyFileValue(filePath: string): string | undefined {
  try {
    const value = trimTrailingNewline(fs.readFileSync(filePath, "utf8"));
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort, non-throwing read of a secret-store credential for redaction and health. */
export function lookupApiKeySecretRefValue(ref: string): string | undefined {
  try {
    return resolveSecret(ref, resolveSecretFromStore);
  } catch {
    return undefined;
  }
}

function selectedEngineName(
  config: EngineResolutionConfig,
  layers: readonly EngineUseConfig[],
  llmOnly: boolean,
): string | undefined {
  for (let index = layers.length - 1; index >= 0; index--) {
    const engine = layers[index]?.engine;
    if (engine !== undefined) return engine;
  }
  return llmOnly ? config.defaults?.llmEngine : config.defaults?.engine;
}

/** The configured engine of this name; an unconfigured name is an error. */
export function configuredEngine<E = EngineConfig>(name: string, config: { readonly engines?: Record<string, E> }): E {
  const engine = config.engines && Object.hasOwn(config.engines, name) ? config.engines[name] : undefined;
  if (!engine) throw new ConfigError(`Engine "${name}" is not configured.`, "INVALID_CONFIG_FILE");
  return engine;
}

function resolveCredential(
  name: string,
  engine: LlmEngineConfig,
  config: EngineResolutionConfig,
): CredentialDescriptor | undefined {
  if (engine.apiKey !== undefined) {
    const explicit = envName(engine.apiKey);
    if (explicit) return { names: [explicit], required: true };
    // A secret-store reference is carried as `apiKeySecretRef` instead.
    if (SECRET_STORE_REFERENCE_PATTERN.test(engine.apiKey)) return undefined;
    throw new ConfigError(`Engine "${name}" has an invalid symbolic apiKey reference.`, "INVALID_CONFIG_FILE");
  }
  // An explicit apiKeyFile is its own credential source; it does not also
  // fall through to the implicit AKM_ENGINE_<NAME>_API_KEY convention.
  if (engine.apiKeyFile !== undefined) return undefined;
  const specific = `AKM_ENGINE_${name.toUpperCase().replaceAll("-", "_")}_API_KEY`;
  return config.defaults?.llmEngine === name
    ? { names: [specific, "AKM_LLM_API_KEY"], required: false }
    : { names: [specific], required: false };
}

/** Lookup-only credential projection used by redaction inventories. */
export function lookupCredentialFromEnv(
  credential: CredentialDescriptor | undefined,
  envSource: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const name of credential?.names ?? []) {
    const candidate = envSource[name]?.trim();
    if (candidate) return candidate;
  }
  return undefined;
}

/** The enforcing env-credential lookup; a missing required descriptor names its primary variable. */
export function resolveCredentialFromEnv(
  credential: CredentialDescriptor | undefined,
  envSource: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = lookupCredentialFromEnv(credential, envSource);
  if (value) return value;
  if (credential?.required) {
    throw new ConfigError(`Required engine credential ${credential.names[0]} is not set.`, "INVALID_CONFIG_FILE");
  }
  return undefined;
}

/**
 * Resolve one LLM credential value at the dispatch boundary: the env
 * descriptor first, then the file-backed value, then the secret-store
 * reference. Nothing before dispatch reads any of them.
 */
export function resolveLlmCredentialValue(
  engine: string,
  credential: CredentialDescriptor | undefined,
  apiKeyFile: string | undefined,
  apiKeySecretRef: string | undefined,
  envSource: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const envValue = resolveCredentialFromEnv(credential, envSource);
  if (envValue !== undefined) return envValue;
  if (apiKeyFile !== undefined) return readApiKeyFile(engine, apiKeyFile);
  return apiKeySecretRef !== undefined ? resolveSecret(apiKeySecretRef, resolveSecretFromStore) : undefined;
}

/** Non-throwing credential-presence result: available, or unavailable with the unresolved reference named. */
export type LlmCredentialAvailability = { available: true } | { available: false; reference: string; reason: string };

/**
 * Non-throwing credential-presence check for `akm health` and improve's
 * strategy probe. Names WHICH env var / file / secret reference is missing,
 * never its value; a broken source is reported by the real dispatch.
 */
export function describeLlmCredentialAvailability(
  resolved: Pick<ResolvedLlmUse, "credential" | "apiKeyFile" | "apiKeySecretRef">,
  env: NodeJS.ProcessEnv = process.env,
): LlmCredentialAvailability {
  if (resolved.credential?.required) {
    if (resolved.credential.names.some((name) => Boolean(env[name]?.trim()))) return { available: true };
    const reference = `$${resolved.credential.names[0]}`;
    return { available: false, reference, reason: `${reference} is not set in this environment` };
  }
  if (resolved.apiKeyFile !== undefined) {
    if (lookupApiKeyFileValue(resolved.apiKeyFile) !== undefined) return { available: true };
    return {
      available: false,
      reference: resolved.apiKeyFile,
      reason: `apiKeyFile ${resolved.apiKeyFile} is missing or empty`,
    };
  }
  if (resolved.apiKeySecretRef !== undefined) {
    if (lookupApiKeySecretRefValue(resolved.apiKeySecretRef) !== undefined) return { available: true };
    return {
      available: false,
      reference: resolved.apiKeySecretRef,
      reason: `${resolved.apiKeySecretRef} did not resolve from the secret store`,
    };
  }
  return { available: true };
}

export function isLlmCredentialAvailable(
  resolved: Pick<ResolvedLlmUse, "credential" | "apiKeyFile" | "apiKeySecretRef">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return describeLlmCredentialAvailability(resolved, env).available;
}

/** Collect every configured engine's current credential value for output and persistence redaction. */
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
    // File and secret-store lookups are best-effort so one broken engine never
    // stops redaction from collecting every other engine's value.
    if (engine.apiKeyFile !== undefined) {
      const value = lookupApiKeyFileValue(expandHomePath(engine.apiKeyFile));
      if (value) values.add(value);
    }
    if (engine.apiKey !== undefined && SECRET_STORE_REFERENCE_PATTERN.test(engine.apiKey)) {
      const value = lookupApiKeySecretRefValue(engine.apiKey);
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
    const layer = layers[index];
    if (layer && Object.hasOwn(layer, "timeoutMs")) return layer.timeoutMs ?? null;
  }
  return Object.hasOwn(engine, "timeoutMs") ? (engine.timeoutMs ?? null) : fallback;
}

function rawLlmConnection(engine: LlmEngineConfig): Record<string, unknown> {
  const connection: Record<string, unknown> = {};
  for (const key of LLM_CONNECTION_FIELDS) {
    if (engine[key] !== undefined) connection[key] = engine[key];
  }
  return connection;
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
  const engine = configuredEngine(name, config);
  if (engine.kind !== "llm") {
    const fallbackName = engine.llmEngine ?? config.defaults?.llmEngine;
    const fallbackEngine = fallbackName ? configuredEngine(fallbackName, config) : undefined;
    if (!fallbackEngine || fallbackEngine.kind !== "llm") {
      if (options.optional) return undefined;
      throw new ConfigError(
        fallbackName
          ? `Engine "${name}" is not an LLM engine, and its llmEngine fallback "${fallbackName}" is not one either.`
          : `Engine "${name}" is not an LLM engine, and has no llmEngine fallback configured.`,
        "INVALID_CONFIG_FILE",
      );
    }
    warn(
      `[akm] Engine "${name}" is an agent engine, not an LLM engine; using its llmEngine "${fallbackName}" instead.`,
    );
    return options.optional
      ? resolveLlmEngineUse(config, [{ engine: fallbackName }], { optional: true })
      : resolveLlmEngineUse(config, [{ engine: fallbackName }]);
  }

  let connection = rawLlmConnection(engine);
  for (const layer of layers) {
    if (layer.llm) connection = deepMergeConfig(connection, layer.llm as Record<string, unknown>);
    if (layer.model !== undefined) connection.model = layer.model;
  }
  for (const key of Object.keys(connection)) {
    if (connection[key] === undefined) delete connection[key];
  }
  const apiKeySecretRef =
    engine.apiKey !== undefined && SECRET_STORE_REFERENCE_PATTERN.test(engine.apiKey) ? engine.apiKey : undefined;
  return {
    engine: name,
    connection: connection as LlmConnectionConfig,
    credential: resolveCredential(name, engine, config),
    ...(engine.apiKeyFile !== undefined ? { apiKeyFile: expandHomePath(engine.apiKeyFile) } : {}),
    ...(apiKeySecretRef !== undefined ? { apiKeySecretRef } : {}),
    timeoutMs: effectiveTimeout(engine, layers, DEFAULT_LLM_TIMEOUT_MS),
  };
}

/** Inject an already-resolved credential value into a connection; reads nothing itself. */
export function materializeLlmConnectionWithCredential(
  resolved: ResolvedLlmUse,
  credentialValue: string | undefined,
): LlmConnectionConfig {
  const extraParams = resolved.connection.extraParams;
  if (extraParams !== undefined) {
    const issue = validateExtraParams(extraParams)[0];
    if (issue) {
      throw new ConfigError(
        formatExtraParamsIssue(`Engine "${resolved.engine}" extraParams`, issue),
        "INVALID_CONFIG_FILE",
      );
    }
  }
  return {
    ...resolved.connection,
    ...(credentialValue ? { apiKey: credentialValue } : {}),
    timeoutMs: resolved.timeoutMs,
  } as LlmConnectionConfig;
}

/** Read and inject one resolved credential at the runtime boundary. */
export function materializeLlmConnection(
  resolved: ResolvedLlmUse,
  envSource: NodeJS.ProcessEnv = process.env,
): LlmConnectionConfig {
  return materializeLlmConnectionWithCredential(
    resolved,
    resolveLlmCredentialValue(
      resolved.engine,
      resolved.credential,
      resolved.apiKeyFile,
      resolved.apiKeySecretRef,
      envSource,
    ),
  );
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
    personaChannel: sdk ? "native" : (harness.agentBuilder?.personaChannel ?? "prompt"),
    bin: engine.bin ?? builtin?.bin ?? (sdk ? OPENCODE_SDK_SERVER_BIN : platform),
    args: engine.args ?? builtin?.args ?? [],
    stdio: "captured",
    ...(builtin?.env ? { env: builtin.env } : {}),
    envPassthrough: builtin?.envPassthrough ?? [],
    parseOutput: "text",
    ...(engine.workspace ? { workspace: path.resolve(engine.workspace) } : {}),
    ...(engine.model ? { model: engine.model } : {}),
  };
  const ownTimeout = Object.hasOwn(engine, "timeoutMs") ? (engine.timeoutMs ?? null) : undefined;
  if (!sdk) {
    return {
      kind: "agent",
      engine: name,
      profile,
      timeoutMs: ownTimeout !== undefined ? ownTimeout : DEFAULT_AGENT_TIMEOUT_MS,
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
          ...(fallback.apiKeyFile ? { fallbackApiKeyFile: fallback.apiKeyFile } : {}),
          ...(fallback.apiKeySecretRef ? { fallbackApiKeySecretRef: fallback.apiKeySecretRef } : {}),
          fallbackTimeoutMs: fallback.timeoutMs,
        }
      : {}),
    timeoutMs: ownTimeout !== undefined ? ownTimeout : (fallback?.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS),
  };
}

/** Resolve a configured engine name to its runner: an LLM connection, a spawned agent, or the SDK. */
export function resolveEngine(
  name: string,
  config: EngineResolutionConfig,
  engine: EngineConfig = configuredEngine(name, config),
): RunnerSpec {
  if (engine.kind !== "llm") return lowerAgentEngine(name, engine, config);
  const resolved = resolveLlmEngineUse(config, [{ engine: name }]);
  return {
    kind: "llm",
    engine: name,
    connection: resolved.connection,
    ...(resolved.credential ? { credential: resolved.credential } : {}),
    ...(resolved.apiKeyFile ? { apiKeyFile: resolved.apiKeyFile } : {}),
    ...(resolved.apiKeySecretRef ? { apiKeySecretRef: resolved.apiKeySecretRef } : {}),
    timeoutMs: resolved.timeoutMs,
  };
}
