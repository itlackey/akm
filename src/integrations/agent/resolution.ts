// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Where an execution runs: the one place a connection or harness, and the model on
 * it, are chosen.
 *
 *   target  the nearest layer that names a connection or harness; none (or one
 *           that is not configured, with a warning) means the default by name,
 *           chosen by the work: model work prefers the default connection and
 *           falls back to the default harness, agent work the reverse and falls
 *           back to akm's own runtime over the default connection.
 *   model   the nearest layer's `model`: an alias is looked up in the connection's
 *           (or harness's) `models`, anything else is the exact name; none means
 *           the first model configured.
 *   timeout the nearest layer's, else the connection's or harness's, else the one
 *           default: 600 s for a connection and for model work, none for an agent.
 *
 * Layers run farther to nearer, so the last one that says something wins.
 */

import path from "node:path";
import { type AkmConfig, defaultConnection, defaultHarness } from "../../core/config/config";
import type { ConnectionConfig, HarnessConfig } from "../../core/config/config-types";
import { deepMergeConfig } from "../../core/config/deep-merge";
import { ConfigError } from "../../core/errors";
import { inferenceWireFields, type LlmInference } from "../../core/llm-inference";
import { DURATION_UNITS, parseDuration } from "../../core/time";
import { warnOnce } from "../../core/warn";
import type { ExecutionJsonObject, ExecutionJsonValue } from "../../execution/json";
import { EXECUTION_MAX_TIMEOUT_MS } from "../../execution/limits";
import type { UnresolvedExecutionDefaults } from "../../execution/source";
import { getHarness, HARNESS_NATIVE_AGENT_IDS } from "../harnesses";
import { DEFAULT_AGENT_TIMEOUT_MS, DEFAULT_LLM_TIMEOUT_MS } from "./config";
import { getBuiltinAgentProfile } from "./profiles";
import type { ConnectionRunner, HarnessRunner, RunnerSpec } from "./runner";

export interface ResolveTargetInput {
  readonly config: AkmConfig;
  /** Unattended model work: calls go straight to a connection when there is one. */
  readonly modelWork?: boolean;
  readonly layers: readonly UnresolvedExecutionDefaults[];
}

/** The aliases every config understands; a connection or harness may add its own. */
const STANDARD_ALIASES = ["fast", "balanced", "reasoning"];

/** The keys of a connection that akm reads; every other key is a request field. */
const CONNECTION_OWNED_KEYS = new Set(["endpoint", "apiKey", "models", "contextLength", "timeoutMs", "concurrency"]);

type ModelEntry = string | { readonly model: string; readonly [field: string]: unknown };

function modelName(entry: ModelEntry): string {
  return typeof entry === "string" ? entry : entry.model;
}

function present(layer: UnresolvedExecutionDefaults, key: keyof UnresolvedExecutionDefaults): boolean {
  return layer[key] !== undefined;
}

/** The value of the nearest layer that sets `key`; a layer setting `null` ends the search with `null`. */
function nearest<K extends keyof UnresolvedExecutionDefaults>(
  layers: readonly UnresolvedExecutionDefaults[],
  key: K,
): UnresolvedExecutionDefaults[K] | undefined {
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    if (layer && present(layer, key)) return layer[key];
  }
  return undefined;
}

/** A timeout as milliseconds (or `null` for none): a whole number, or a duration such as `20m`. */
export function parseTimeout(value: unknown): number | null {
  if (value === null) return null;
  const milliseconds = typeof value === "string" ? parseDuration(value, DURATION_UNITS) : value;
  if (
    typeof milliseconds !== "number" ||
    !Number.isInteger(milliseconds) ||
    milliseconds < 0 ||
    milliseconds > EXECUTION_MAX_TIMEOUT_MS
  ) {
    throw new ConfigError(
      "Execution timeout must be null, a whole number of milliseconds, or a duration such as 20m.",
      "INVALID_CONFIG_FILE",
    );
  }
  return milliseconds;
}

// ── Inference ───────────────────────────────────────────────────────────────

/**
 * Reasoning effort has one word in a request: `reasoningEffort`, which is what
 * the LLM request body calls it. `effort` is the same setting as an asset's
 * `effort:` frontmatter spells it, and becomes `reasoningEffort` here, in the one
 * place every layer's inference is merged, so the nearest layer wins whichever
 * word it used. When one inference object has both, `reasoningEffort` wins.
 */
export function withReasoningEffort(inference: ExecutionJsonObject): ExecutionJsonObject {
  if (!Object.hasOwn(inference, "effort")) return inference;
  const { effort, ...rest } = inference;
  return Object.hasOwn(rest, "reasoningEffort") ? rest : { ...rest, reasoningEffort: effort as ExecutionJsonValue };
}

/** The layers' portable inference merged, nearest wins; a layer that sets `null` clears what is farther. */
export function mergeLayerInference(
  layers: readonly UnresolvedExecutionDefaults[],
): ExecutionJsonObject | null | undefined {
  let merged: ExecutionJsonObject | null | undefined;
  for (const layer of layers) {
    if (layer.inference === undefined) continue;
    merged =
      layer.inference === null
        ? null
        : (deepMergeConfig(merged ?? {}, withReasoningEffort(layer.inference)) as ExecutionJsonObject);
  }
  return merged;
}

// ── Target ──────────────────────────────────────────────────────────────────

type Target =
  | { readonly kind: "connection"; readonly name: string; readonly connection: ConnectionConfig }
  | { readonly kind: "harness"; readonly name: string; readonly harness: HarnessConfig };

/** The name the nearest layer that names anything gives, and the kind it gave it as. */
function namedByLayers(
  config: AkmConfig,
  layers: readonly UnresolvedExecutionDefaults[],
  modelWork: boolean,
): { kind: "connection" | "harness"; name: string } | undefined {
  const order = modelWork ? (["connection", "harness"] as const) : (["harness", "connection"] as const);
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    if (!layer) continue;
    for (const kind of order) {
      const name = layer[kind];
      if (typeof name === "string" && name) return { kind, name };
    }
    // `engine` is the retired spelling (and the name `--engine` takes): a connection by that name, else a harness.
    const engine = layer.engine;
    if (typeof engine === "string" && engine) {
      return {
        kind: config.harnesses?.[engine] && !config.connections?.[engine] ? "harness" : "connection",
        name: engine,
      };
    }
  }
  return undefined;
}

/** The connection or harness the default-by-name rule picks for this work, if either is configured. */
function defaultTarget(config: AkmConfig, modelWork: boolean): Target | undefined {
  const connection = defaultConnection(config);
  const harness = defaultHarness(config);
  const asConnection = connection && ({ kind: "connection", ...connection } as const);
  const asHarness = harness && ({ kind: "harness", ...harness } as const);
  return modelWork ? (asConnection ?? asHarness) : (asHarness ?? asConnection);
}

function selectTarget(input: ResolveTargetInput): Target {
  const modelWork = input.modelWork === true;
  const named = namedByLayers(input.config, input.layers, modelWork);
  if (named) {
    const connection = named.kind === "connection" ? input.config.connections?.[named.name] : undefined;
    const harness = named.kind === "harness" ? input.config.harnesses?.[named.name] : undefined;
    if (connection) return { kind: "connection", name: named.name, connection };
    if (harness) return { kind: "harness", name: named.name, harness };
    warnOnce(
      `resolution:unconfigured:${named.kind}:${named.name}`,
      `${named.kind === "connection" ? "Connection" : "Harness"} "${named.name}" is not configured; using the default.`,
    );
  }
  const target = defaultTarget(input.config, modelWork);
  if (target) return target;
  throw new ConfigError(
    modelWork
      ? "No connection or harness is configured, so there is nothing to run model work on."
      : "No harness or connection is configured, so there is nothing to run agent work on.",
    modelWork ? "LLM_NOT_CONFIGURED" : "AGENT_NOT_CONFIGURED",
  );
}

// ── Model ───────────────────────────────────────────────────────────────────

/** Every alias this config knows: the standard ones and any a connection or harness maps. */
function knownAliases(config: AkmConfig): ReadonlySet<string> {
  const aliases = new Set(STANDARD_ALIASES);
  for (const entry of [...Object.values(config.connections ?? {}), ...Object.values(config.harnesses ?? {})]) {
    for (const alias of Object.keys(entry.models ?? {})) aliases.add(alias);
  }
  return aliases;
}

/**
 * The entry a requested model names in `models`: the alias's entry; the exact name
 * when it is not an alias; the first entry otherwise (no request, or an alias this
 * map does not carry).
 */
function modelEntry(
  models: Readonly<Record<string, ModelEntry>>,
  requested: string | undefined,
  aliases: ReadonlySet<string>,
): ModelEntry | undefined {
  if (requested !== undefined && Object.hasOwn(models, requested)) return models[requested];
  if (requested !== undefined && !aliases.has(requested)) return requested;
  return Object.values(models)[0];
}

// ── Runners ─────────────────────────────────────────────────────────────────

/** The first timeout that is set; `null` is a timeout (none), so it ends the search. */
function firstTimeout(...timeouts: readonly (number | null | undefined)[]): number | null {
  return timeouts.find((timeout) => timeout !== undefined) ?? null;
}

/** The timeout the nearest layer sets, if any. */
function layerTimeout(layers: readonly UnresolvedExecutionDefaults[]): number | null | undefined {
  const value = nearest(layers, "timeout");
  return value === undefined ? undefined : parseTimeout(value);
}

function connectionRunner(
  name: string,
  connection: ConnectionConfig,
  requested: string | undefined,
  aliases: ReadonlySet<string>,
  layers: readonly UnresolvedExecutionDefaults[],
): ConnectionRunner {
  const entry = modelEntry(connection.models ?? {}, requested, aliases);
  if (entry === undefined) {
    throw new ConfigError(
      `Connection "${name}" lists no models, so no model can be chosen. Add some under connections.${name}.models, or run \`akm setup\`.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const { model, ...entryFields } = typeof entry === "string" ? { model: entry } : entry;
  const connectionFields = Object.fromEntries(
    Object.entries(connection).filter(([key]) => !CONNECTION_OWNED_KEYS.has(key)),
  );
  const inference = mergeLayerInference(layers) as LlmInference | null | undefined;
  const contextLength = inference?.contextLength ?? connection.contextLength;
  return {
    kind: "connection",
    name,
    endpoint: connection.endpoint,
    model,
    request: { ...connectionFields, ...entryFields, ...inferenceWireFields(inference ?? undefined) },
    ...(connection.apiKey !== undefined ? { apiKey: connection.apiKey } : {}),
    ...(contextLength !== undefined ? { contextLength } : {}),
    ...(connection.concurrency !== undefined ? { concurrency: connection.concurrency } : {}),
    timeoutMs: firstTimeout(layerTimeout(layers), connection.timeoutMs, DEFAULT_LLM_TIMEOUT_MS),
  };
}

/** The harness model a request names, or `undefined` when the harness is left to pick its own. */
function harnessModel(
  name: string,
  platform: string,
  harness: HarnessConfig,
  requested: string | undefined,
  aliases: ReadonlySet<string>,
): string | undefined {
  const own: Readonly<Record<string, ModelEntry>> = harness.models ?? {};
  const shipped = getHarness(platform)?.models ?? {};
  if (requested === undefined) {
    const first = Object.values(own)[0];
    return first === undefined ? undefined : modelName(first);
  }
  if (Object.hasOwn(own, requested)) return modelName(own[requested] as ModelEntry);
  if (Object.hasOwn(shipped, requested)) return shipped[requested];
  if (!aliases.has(requested)) return requested;
  warnOnce(
    `resolution:no-model:${name}:${requested}`,
    `Harness "${name}" has no model for "${requested}", so it uses its own default. Map one under harnesses.${name}.models.`,
  );
  return undefined;
}

function harnessRunner(
  name: string,
  harness: HarnessConfig,
  requested: string | undefined,
  aliases: ReadonlySet<string>,
  layers: readonly UnresolvedExecutionDefaults[],
  modelWork: boolean,
): HarnessRunner {
  const platform = harness.platform ?? name;
  const builtin = getBuiltinAgentProfile(platform);
  if (harness.agent !== undefined && !HARNESS_NATIVE_AGENT_IDS.has(platform)) {
    warnOnce(
      `resolution:agent:${name}`,
      `Harness "${name}" (${platform}) has no native agents; its agent setting is ignored.`,
    );
  }
  const model = harnessModel(name, platform, harness, requested, aliases);
  const defaultTimeout = modelWork ? DEFAULT_LLM_TIMEOUT_MS : DEFAULT_AGENT_TIMEOUT_MS;
  return {
    kind: "harness",
    name,
    platform,
    bin: harness.bin ?? builtin?.bin ?? platform,
    args: harness.args ?? builtin?.args ?? [],
    ...(harness.workspace !== undefined ? { workspace: path.resolve(harness.workspace) } : {}),
    ...(harness.agent !== undefined && HARNESS_NATIVE_AGENT_IDS.has(platform) ? { agent: harness.agent } : {}),
    ...(model !== undefined ? { model } : {}),
    timeoutMs: firstTimeout(layerTimeout(layers), harness.timeoutMs, defaultTimeout),
  };
}

/** Where this execution runs and with which model, from the config and the layers that speak for it. */
export function resolveTarget(input: ResolveTargetInput): RunnerSpec {
  const target = selectTarget(input);
  const requestedModel = nearest(input.layers, "model");
  const requested = typeof requestedModel === "string" && requestedModel ? requestedModel : undefined;
  const aliases = knownAliases(input.config);
  return target.kind === "connection"
    ? connectionRunner(target.name, target.connection, requested, aliases, input.layers)
    : harnessRunner(target.name, target.harness, requested, aliases, input.layers, input.modelWork === true);
}
