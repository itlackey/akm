// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Where an execution runs: the one place a connection or harness, and the model on
 * it, are chosen.
 *
 *   target  the nearest layer that names a connection or harness, which must be
 *           configured: a name that is not is an error, never a reason to use the
 *           default. None named means the default by name, chosen by the work:
 *           model work prefers the default connection and falls back to the
 *           default harness, agent work the reverse and falls back to akm's own
 *           runtime over the default connection.
 *   model   the nearest layer's `model`: an alias is looked up in the connection's
 *           (or harness's) `models`, anything else is the exact name; none means
 *           the first model configured.
 *   timeout the nearest layer's, else the connection's or harness's, else the one
 *           default: 600 s for a connection and for model work, none for an agent.
 *
 * Layers run farther to nearer, so the last one that says something wins.
 */

import path from "node:path";
import { closestMatch } from "../../core/closest-match";
import {
  type AkmConfig,
  ambiguousDefaultAdvice,
  defaultConnection,
  defaultHarness,
  retiredEngineTargets,
  unusableEntryAt,
} from "../../core/config/config";
import type { ConnectionConfig, HarnessConfig } from "../../core/config/config-types";
import { apiKeyReference } from "../../core/config/credentials";
import { deepMergeConfig } from "../../core/config/deep-merge";
import { type ModelEntry, STANDARD_ALIASES } from "../../core/config/model-aliases";
import { ConfigError } from "../../core/errors";
import { type LlmInference, mergeRequestFields } from "../../core/llm-inference";
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

/** The keys of a connection that akm reads; every other key is a request field. */
const CONNECTION_OWNED_KEYS = new Set([
  "endpoint",
  "apiKey",
  "apiKeyFile",
  "models",
  "contextLength",
  "timeoutMs",
  "concurrency",
]);

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

/**
 * What the retired `engine` spelling names. While the config file is still in the `engines` form, the connection
 * or harness that engine became (it may have been renamed); otherwise a connection by that name, else a harness.
 */
export function retiredEngineSelection(
  config: AkmConfig,
  name: string,
): { kind: "connection" | "harness"; name: string } {
  const became = retiredEngineTargets()[name];
  if (became)
    return "harness" in became
      ? { kind: "harness", name: became.harness }
      : { kind: "connection", name: became.connection };
  return { kind: config.harnesses?.[name] && !config.connections?.[name] ? "harness" : "connection", name };
}

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
    const engine = layer.engine;
    if (typeof engine === "string" && engine) return retiredEngineSelection(config, engine);
  }
  return undefined;
}

/**
 * The connection or harness the default-by-name rule picks for this work, if either is configured. Model work
 * skips a harness that is set not to do it (`modelWork: false`); a call that names the harness still runs on it.
 */
function defaultTarget(config: AkmConfig, modelWork: boolean): Target | undefined {
  const connection = defaultConnection(config);
  const found = defaultHarness(config);
  const harness = found && !(modelWork && found.harness.modelWork === false) ? found : undefined;
  const asConnection = connection && ({ kind: "connection", ...connection } as const);
  const asHarness = harness && ({ kind: "harness", ...harness } as const);
  return modelWork ? (asConnection ?? asHarness) : (asHarness ?? asConnection);
}

/** The error for a connection or harness that was named and is not configured: what was named, what is configured, and the nearest name. */
export function selectionNotConfigured(config: AkmConfig, kind: "connection" | "harness", name: string): ConfigError {
  const label = kind === "connection" ? "Connection" : "Harness";
  const plural = kind === "connection" ? "connections" : "harnesses";
  const configured = Object.keys((kind === "connection" ? config.connections : config.harnesses) ?? {});
  const near = closestMatch(name, configured, Math.max(1, Math.floor(name.length / 3)));
  const unusable = unusableEntryAt(`${kind === "connection" ? "connections" : "harnesses"}.${name}`);
  return new ConfigError(
    [
      `${label} "${name}" is not configured.`,
      unusable
        ? `config.json has a ${kind} by that name that akm ignores, because ${unusable.why}.`
        : configured.length > 0
          ? `Configured ${plural}: ${configured.join(", ")}.`
          : `No ${plural} are configured.`,
      near ? `Did you mean "${near}"?` : undefined,
    ]
      .filter((sentence) => sentence !== undefined)
      .join(" "),
    "SELECTION_NOT_CONFIGURED",
  );
}

function selectTarget(input: ResolveTargetInput): Target {
  const modelWork = input.modelWork === true;
  const named = namedByLayers(input.config, input.layers, modelWork);
  if (named) {
    const connection = named.kind === "connection" ? input.config.connections?.[named.name] : undefined;
    const harness = named.kind === "harness" ? input.config.harnesses?.[named.name] : undefined;
    if (connection) return { kind: "connection", name: named.name, connection };
    if (harness) return { kind: "harness", name: named.name, harness };
    // A target that was asked for by name is never replaced by the default: that could send a private call to a remote
    // service, or a call that must not touch files to an agent that can. Defaults apply only when nothing was named.
    throw selectionNotConfigured(input.config, named.kind, named.name);
  }
  const target = defaultTarget(input.config, modelWork);
  if (target) return target;
  const ambiguous = ambiguousDefaultAdvice(input.config);
  const declined = modelWork ? defaultHarness(input.config) : undefined;
  throw new ConfigError(
    (ambiguous ? `${ambiguous}.` : undefined) ??
      (declined?.harness.modelWork === false
        ? `No connection is configured, and harness "${declined.name}" is set not to run akm's model calls (modelWork: false), so there is nothing to run model work on. Add a connection with \`akm setup --endpoint URL\`.`
        : modelWork
          ? "No connection or harness is configured, so there is nothing to run model work on."
          : "No harness or connection is configured, so there is nothing to run agent work on."),
    modelWork ? "LLM_NOT_CONFIGURED" : "AGENT_NOT_CONFIGURED",
  );
}

// ── Model ───────────────────────────────────────────────────────────────────

/** Every alias this config knows: the standard ones and any a connection or harness maps. */
function knownAliases(config: AkmConfig): ReadonlySet<string> {
  const aliases = new Set<string>(STANDARD_ALIASES);
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

/** What bounds a run when nothing sets a timeout, on a connection or a harness alike: agent work runs until it finishes, a model call stops at the model-call default. */
function defaultTimeout(modelWork: boolean): number | null {
  return modelWork ? DEFAULT_LLM_TIMEOUT_MS : DEFAULT_AGENT_TIMEOUT_MS;
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
  modelWork: boolean,
): ConnectionRunner {
  const entry = modelEntry(connection.models ?? {}, requested, aliases);
  if (entry === undefined) {
    throw new ConfigError(
      `Connection "${name}" lists no models, so no model can be chosen. Name one with \`akm models set fast <model> --connection ${name}\`, or run \`akm setup\`.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const { model, ...entryFields } = typeof entry === "string" ? { model: entry } : entry;
  const connectionFields = Object.fromEntries(
    Object.entries(connection).filter(([key]) => !CONNECTION_OWNED_KEYS.has(key)),
  );
  const inference = mergeLayerInference(layers) as LlmInference | null | undefined;
  return {
    kind: "connection",
    name,
    endpoint: connection.endpoint,
    model,
    request: mergeRequestFields(connectionFields, entryFields),
    ...(inference && Object.keys(inference).length > 0 ? { inference } : {}),
    ...(apiKeyReference(connection.apiKey) !== undefined ? { apiKey: connection.apiKey } : {}),
    ...(connection.contextLength !== undefined ? { contextLength: connection.contextLength } : {}),
    ...(connection.concurrency !== undefined ? { concurrency: connection.concurrency } : {}),
    timeoutMs: firstTimeout(layerTimeout(layers), connection.timeoutMs, defaultTimeout(modelWork)),
  };
}

/** The model name a harness alias holds. A harness is passed the name only, so an entry's request fields (a connection's) are ignored, with a word. */
function harnessAliasModel(name: string, alias: string, entry: NonNullable<HarnessConfig["models"]>[string]): string {
  if (typeof entry === "string") return entry;
  if (Object.keys(entry).length > 1) {
    warnOnce(
      `resolution:alias-fields:${name}:${alias}`,
      `Harness "${name}" is passed only the model name of "${alias}"; the other fields of that entry are ignored.`,
    );
  }
  return entry.model;
}

/**
 * The harness model a request names, or `undefined` when the harness is left to pick
 * its own: a layer that sets `model: null` asks for exactly that.
 */
function harnessModel(
  name: string,
  platform: string,
  harness: HarnessConfig,
  requested: string | null | undefined,
  aliases: ReadonlySet<string>,
): string | undefined {
  if (requested === null) return undefined;
  const own = harness.models ?? {};
  const shipped = getHarness(platform)?.models ?? {};
  const [first] = Object.entries(own);
  if (requested === undefined) return first ? harnessAliasModel(name, first[0], first[1]) : undefined;
  const entry = Object.hasOwn(own, requested) ? own[requested] : undefined;
  if (entry !== undefined) return harnessAliasModel(name, requested, entry);
  if (Object.hasOwn(shipped, requested)) return shipped[requested];
  if (!aliases.has(requested)) return requested;
  // A harness with no map at all picks its own model whatever is asked; only one that maps others is worth a word.
  if (Object.keys(own).length > 0 || Object.keys(shipped).length > 0) {
    warnOnce(
      `resolution:no-model:${name}:${requested}`,
      `Harness "${name}" has no model for "${requested}", so it uses its own default. Map one under harnesses.${name}.models.`,
    );
  }
  return undefined;
}

function harnessRunner(
  name: string,
  harness: HarnessConfig,
  requested: string | null | undefined,
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
  return {
    kind: "harness",
    name,
    platform,
    bin: harness.bin ?? builtin?.bin ?? platform,
    args: harness.args ?? builtin?.args ?? [],
    ...(harness.workspace !== undefined ? { workspace: path.resolve(harness.workspace) } : {}),
    ...(harness.agent !== undefined && HARNESS_NATIVE_AGENT_IDS.has(platform) ? { agent: harness.agent } : {}),
    ...(model !== undefined ? { model } : {}),
    timeoutMs: firstTimeout(layerTimeout(layers), harness.timeoutMs, defaultTimeout(modelWork)),
  };
}

/** Where this execution runs and with which model, from the config and the layers that speak for it. */
export function resolveTarget(input: ResolveTargetInput): RunnerSpec {
  const target = selectTarget(input);
  const requestedModel = nearest(input.layers, "model");
  const requested = typeof requestedModel === "string" && requestedModel ? requestedModel : undefined;
  const aliases = knownAliases(input.config);
  const modelWork = input.modelWork === true;
  return target.kind === "connection"
    ? connectionRunner(target.name, target.connection, requested, aliases, input.layers, modelWork)
    : harnessRunner(
        target.name,
        target.harness,
        requestedModel === null ? null : requested,
        aliases,
        input.layers,
        modelWork,
      );
}
