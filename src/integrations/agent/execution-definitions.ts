// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AkmConfig, EngineConfig } from "../../core/config/config-types";
import { cloneExecutionJsonObject } from "../../execution/json";
import type { UnresolvedExecutionDefaults } from "../../execution/source";
import { DEFAULT_AGENT_TIMEOUT_MS, DEFAULT_LLM_TIMEOUT_MS } from "./config";
import type { ExecutionEngineDefinition } from "./execution-cascade";
import { engineModelAndInference } from "./model-map";
import { OPENCODE_SDK_SERVER_BIN } from "./profiles";
import type { RunnerSpec } from "./runner";

/**
 * Canonical engine-setting marker: an SDK without its own model selected the
 * fallback LLM model through the common cascade. The lowerer must project the
 * request-owned exact model/inference back onto symbolic fallback transport
 * material instead of consulting aliases again.
 */
export const SDK_FALLBACK_MODEL_FROM_REQUEST_SETTING = "sdkFallbackModelFromRequest" as const;

function own(value: object, key: PropertyKey): boolean {
  return Object.hasOwn(value, key);
}

function ownValue<T extends object, K extends keyof T>(value: T, key: K): T[K] | undefined {
  return own(value, key) ? value[key] : undefined;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function engineDefaults(engine: EngineConfig): UnresolvedExecutionDefaults {
  const defaults: Record<string, unknown> = {};
  const { model, inference } = engineModelAndInference(engine);
  if (model !== undefined) defaults.model = model;
  if (own(engine, "timeoutMs")) defaults.timeout = engine.timeoutMs;
  if (engine.kind === "agent" && own(engine, "workspace")) defaults.workspace = engine.workspace;
  if (inference !== undefined) defaults.inference = inference;
  return Object.freeze(defaults) as UnresolvedExecutionDefaults;
}

function configuredSdkFallback(
  engine: Extract<EngineConfig, { kind: "agent" }>,
  config: AkmConfig,
): readonly [name: string, engine: Extract<EngineConfig, { kind: "llm" }>] | undefined {
  if (engine.platform !== "opencode-sdk") return undefined;
  const fallbackName = ownValue(engine, "llmEngine") ?? ownValue(config.defaults ?? {}, "llmEngine");
  if (!fallbackName) return undefined;
  const fallback = ownValue(config.engines ?? {}, fallbackName);
  return fallback?.kind === "llm" ? [fallbackName, fallback] : undefined;
}

/** Project validated named-engine config into the pure common cascade registry. */
export function executionEngineDefinitionsFromConfig(
  config: AkmConfig,
): Readonly<Record<string, ExecutionEngineDefinition>> {
  const definitions: Record<string, ExecutionEngineDefinition> = Object.create(null);
  for (const [name, engine] of Object.entries(ownValue(config, "engines") ?? {})) {
    const platform = engine.kind === "agent" ? engine.platform : (ownValue(engine, "provider") ?? name);
    const sdkFallback = engine.kind === "agent" ? configuredSdkFallback(engine, config) : undefined;
    const usesSdkFallbackModel = engine.kind === "agent" && !own(engine, "model") && sdkFallback !== undefined;
    const fallbackName = sdkFallback?.[0];
    const fallbackEngine = sdkFallback?.[1];
    const settings =
      engine.kind === "agent"
        ? platform === "opencode-sdk"
          ? {
              bin: ownValue(engine, "bin") ?? OPENCODE_SDK_SERVER_BIN,
              args: ownValue(engine, "args") ?? [],
              ...(usesSdkFallbackModel ? { [SDK_FALLBACK_MODEL_FROM_REQUEST_SETTING]: true } : {}),
            }
          : withoutUndefined({
              bin: ownValue(engine, "bin"),
              args: ownValue(engine, "args"),
              workspace: ownValue(engine, "workspace"),
            })
        : withoutUndefined({ endpoint: engine.endpoint, provider: ownValue(engine, "provider") });
    // SDK fallback inference and timeout participate in the canonical
    // request even when the agent engine owns a distinct primary model. The
    // primary engine defaults are nearer and therefore replace only fields it
    // actually owns (notably model/timeout); fallback model identity remains
    // separate unless the SDK has no primary model at all.
    const fallbackTimeout = fallbackEngine
      ? own(fallbackEngine, "timeoutMs")
        ? (fallbackEngine.timeoutMs ?? null)
        : DEFAULT_LLM_TIMEOUT_MS
      : undefined;
    const inheritedDefaults = {
      ...(fallbackEngine ? engineDefaults(fallbackEngine) : {}),
      ...engineDefaults(engine),
    };
    const defaults =
      engine.kind === "agent" && platform === "opencode-sdk"
        ? Object.freeze({
            ...inheritedDefaults,
            timeout: own(engine, "timeoutMs")
              ? (engine.timeoutMs ?? null)
              : fallbackTimeout !== undefined
                ? fallbackTimeout
                : DEFAULT_AGENT_TIMEOUT_MS,
          })
        : Object.freeze(inheritedDefaults);
    const modelMapKey = usesSdkFallbackModel && fallbackName ? fallbackName : engine.kind === "agent" ? platform : name;
    definitions[name] = Object.freeze({
      selection: Object.freeze({
        name,
        kind: engine.kind === "llm" ? "llm" : engine.platform === "opencode-sdk" ? "sdk" : "agent",
        platform,
        ...(Object.keys(settings).length > 0
          ? { settings: cloneExecutionJsonObject(settings, `engines.${name}.settings`) }
          : {}),
      }),
      defaults,
      modelMapKey,
    });
  }
  return Object.freeze(definitions);
}

export interface RunnerExecutionEngineDefinition {
  readonly engineName: string;
  readonly runner: RunnerSpec;
  readonly definition: ExecutionEngineDefinition;
}

export interface RunnerExecutionEngineDefinitionOptions {
  /** Persisted ownership bit for config-free SDK preparation. */
  readonly sdkFallbackModelFromRequest?: boolean;
}

/**
 * Project already-resolved, symbolic runner material into the common cascade
 * without consulting config, aliases, environment variables, or credentials.
 */
export function executionEngineDefinitionFromRunner(
  input: RunnerSpec,
  options: RunnerExecutionEngineDefinitionOptions = {},
): RunnerExecutionEngineDefinition {
  const snapshot = cloneExecutionJsonObject(input, "frozen execution runner") as unknown as RunnerSpec;
  const engineName = snapshot.engine;
  if (!engineName) throw new TypeError("frozen execution runner requires a stable engine name");
  const runner = snapshot;
  if (runner.kind === "llm") {
    const inference = withoutUndefined({
      temperature: ownValue(runner.connection, "temperature"),
      maxTokens: ownValue(runner.connection, "maxTokens"),
      supportsJsonSchema: ownValue(runner.connection, "supportsJsonSchema"),
      extraParams: ownValue(runner.connection, "extraParams"),
      contextLength: ownValue(runner.connection, "contextLength"),
      enableThinking: ownValue(runner.connection, "enableThinking"),
      reasoningEffort: ownValue(runner.connection, "reasoningEffort"),
    });
    return Object.freeze({
      engineName,
      runner,
      definition: Object.freeze({
        selection: Object.freeze({
          name: engineName,
          kind: "llm" as const,
          platform: runner.connection.provider ?? engineName,
          settings: cloneExecutionJsonObject(
            withoutUndefined({
              endpoint: runner.connection.endpoint,
              provider: runner.connection.provider,
            }),
            "frozen execution runner settings",
          ),
        }),
        defaults: Object.freeze({
          model: runner.connection.model,
          ...(Object.keys(inference).length > 0
            ? { inference: cloneExecutionJsonObject(inference, "frozen execution runner inference") }
            : {}),
          ...(own(runner, "timeoutMs") ? { timeout: runner.timeoutMs } : {}),
        }),
        modelMapKey: engineName,
      }),
    });
  }

  const platform = runner.profile.platform ?? runner.profile.name;
  if (!platform) throw new TypeError("frozen agent runner requires a stable platform");
  const fallbackConnection = runner.kind === "sdk" ? runner.fallbackConnection : undefined;
  const usesSdkFallbackModel = own(options, "sdkFallbackModelFromRequest")
    ? options.sdkFallbackModelFromRequest === true
    : runner.kind === "sdk" && !own(runner.profile, "model") && fallbackConnection !== undefined;
  if (usesSdkFallbackModel && (runner.kind !== "sdk" || fallbackConnection === undefined)) {
    throw new TypeError("frozen SDK fallback model ownership requires fallback transport material");
  }
  const fallbackInference = fallbackConnection
    ? withoutUndefined({
        temperature: fallbackConnection.temperature,
        maxTokens: fallbackConnection.maxTokens,
        supportsJsonSchema: fallbackConnection.supportsJsonSchema,
        extraParams: fallbackConnection.extraParams,
        contextLength: fallbackConnection.contextLength,
        enableThinking: fallbackConnection.enableThinking,
        reasoningEffort: fallbackConnection.reasoningEffort,
      })
    : {};
  return Object.freeze({
    engineName,
    runner,
    definition: Object.freeze({
      selection: Object.freeze({
        name: engineName,
        kind: runner.kind,
        platform,
        settings: cloneExecutionJsonObject(
          {
            bin: runner.profile.bin,
            args: runner.profile.args,
            ...(usesSdkFallbackModel ? { [SDK_FALLBACK_MODEL_FROM_REQUEST_SETTING]: true } : {}),
          },
          "frozen execution runner settings",
        ),
      }),
      defaults: Object.freeze({
        ...(own(runner.profile, "model")
          ? { model: runner.profile.model }
          : usesSdkFallbackModel
            ? { model: fallbackConnection?.model }
            : {}),
        ...(Object.keys(fallbackInference).length > 0
          ? { inference: cloneExecutionJsonObject(fallbackInference, "frozen SDK fallback inference") }
          : {}),
        ...(own(runner, "timeoutMs") ? { timeout: runner.timeoutMs } : {}),
        ...(own(runner.profile, "workspace") ? { workspace: runner.profile.workspace } : {}),
      }),
      modelMapKey: platform,
    }),
  });
}
