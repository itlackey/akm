// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The execution pipeline, config engine name to a dispatchable request:
 *
 *   resolveExecution(input)          config (or a journaled runner) + caller layers
 *                                    → { request, runner, provenance }
 *   buildExecution(request, runner)  the harness builder → prompt + argv inputs
 *                                    (agent/sdk) or chat messages (llm)
 *   buildExecutionFromWire(wire)     resume: the same from a journaled
 *                                    { request, runner }, never reading config
 *   runExecution(built, options)     runner-dispatch.ts: credentials are read
 *                                    here, then spawn / SDK / chat
 *
 * One merge, nearest wins: the selected engine's own defaults, then the
 * persona, command, invocation defaults and the current call. Credentials stay
 * symbolic in everything this module returns.
 */

import type { AkmConfig, EngineConfig } from "../../core/config/config-types";
import { deepMergeConfig } from "../../core/config/deep-merge";
import { ConfigError } from "../../core/errors";
import { DURATION_UNITS, parseDuration } from "../../core/time";
import type { ExecutionJsonObject } from "../../execution/json";
import { EXECUTION_MAX_TIMEOUT_MS } from "../../execution/limits";
import {
  createInlineResolvedCommand,
  createResolvedExecutionRequest,
  decodeResolvedExecutionRequest,
  type LoweringNotice,
  type ResolvedCommandContent,
  type ResolvedConversationMessage,
  type ResolvedExecutionRequestV1,
  type ResolvedModelSelection,
  type ResolvedPersonaContent,
  type ToolAuthorizationResult,
} from "../../execution/resolved-request";
import {
  cloneToolSelection,
  isPortableExecutionAgentSelector,
  type ToolSelection,
  type UnresolvedExecutionDefaults,
} from "../../execution/source";
import type { ChatCompletionOptions, ChatMessage } from "../../llm/client";
import { getHarness } from "../harnesses";
import { DEFAULT_AGENT_TIMEOUT_MS, DEFAULT_LLM_TIMEOUT_MS } from "./config";
import {
  FALLBACK_ENGINE_NAME,
  fallbackEngineConfig,
  NO_ENGINE_MESSAGE_SUFFIX,
  NO_ENGINE_REMEDY,
} from "./engine-fallback";
import { configuredEngine, resolveEngine } from "./engine-resolution";
import { engineModelAndInference, loadModelMap, type ResolvedModelMapV1, resolveModelMapAlias } from "./model-map";
import { extensionFields, hasToolSelection, untranslated } from "./request-lowering";
import { decodeFrozenRunnerSpec, type RunnerSpec } from "./runner";
import type { RunAgentOptions } from "./spawn";

/** One named layer of execution defaults, e.g. a persona's or a command's frontmatter. */
export interface ExecutionLayer {
  readonly id: string;
  readonly values: UnresolvedExecutionDefaults;
}

type LayerKind = "installation" | "engine" | "agent" | "command" | "invocation-defaults" | "current";

/** Which layer set one request field. */
export interface ExecutionFieldProvenance {
  readonly layer: string;
  readonly kind: LayerKind | "fallback" | "authorization";
  readonly via: "explicit" | "model-alias" | "fallback" | "source" | "policy";
}

export interface ResolveExecutionInput {
  /** A rendered command. Omit it and pass `content` for an anonymous inline command. */
  readonly command?: ResolvedCommandContent;
  readonly content?: string;
  readonly argumentInput?: string;
  /** Resolve the engine from this config… */
  readonly config?: AkmConfig;
  /** …or reuse an already-resolved runner (no config read, no model aliases). */
  readonly runner?: RunnerSpec;
  /** Ordered turns before the terminal user command. */
  readonly conversation?: readonly Readonly<ResolvedConversationMessage>[];
  readonly persona?: ResolvedPersonaContent | null;
  readonly agentLayer?: ExecutionLayer;
  readonly commandLayer?: ExecutionLayer;
  readonly invocationDefaults?: UnresolvedExecutionDefaults;
  readonly current?: UnresolvedExecutionDefaults;
  readonly modelMap?: ResolvedModelMapV1;
}

export interface ResolvedExecution {
  readonly request: ResolvedExecutionRequestV1;
  /** The selected engine's runner with the request applied. Credentials are still symbolic. */
  readonly runner: RunnerSpec;
  /** The layer behind each request field, for `akm task explain` and `command run --dry-run`. */
  readonly provenance: Readonly<Record<string, ExecutionFieldProvenance>>;
  /** Set when the implicit opencode-sdk fallback engine was selected. */
  readonly fallbackEngineName?: string;
}

/** A request built for its runner's transport. */
export interface BuiltExecution {
  readonly request: ResolvedExecutionRequestV1;
  readonly runner: RunnerSpec;
  /** The harness prompt (agent/sdk), or the terminal user message (llm). */
  readonly prompt: string;
  /** Spawn options: timeout, cwd, env, and the harness `dispatch` the argv is built from. */
  readonly options: Readonly<RunAgentOptions>;
  /** Direct-LLM transport only. */
  readonly messages?: readonly ChatMessage[];
  readonly chatOptions?: Readonly<ChatCompletionOptions>;
  readonly notices: readonly Readonly<LoweringNotice>[];
}

interface Layer {
  readonly id: string;
  readonly kind: LayerKind;
  readonly values: UnresolvedExecutionDefaults;
}

/** What the selected engine contributes before any caller layer. */
interface EngineDefaults {
  readonly kind: "llm" | "agent" | "sdk";
  readonly platform: string;
  /** The models.json column aliases resolve against. */
  readonly modelMapKey: string;
  readonly values: UnresolvedExecutionDefaults;
}

const LLM_INFERENCE_FIELDS = [
  "temperature",
  "maxTokens",
  "supportsJsonSchema",
  "extraParams",
  "contextLength",
  "enableThinking",
  "reasoningEffort",
] as const;

function has(values: object | null | undefined, key: string): boolean {
  return (
    values !== null &&
    values !== undefined &&
    Object.hasOwn(values, key) &&
    (values as Record<string, unknown>)[key] !== undefined
  );
}

function nearest(layers: readonly Layer[], key: keyof UnresolvedExecutionDefaults): Layer | undefined {
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    if (layer && has(layer.values, key)) return layer;
  }
  return undefined;
}

function explicit(layer: Layer, via: ExecutionFieldProvenance["via"] = "explicit"): ExecutionFieldProvenance {
  return { layer: layer.id, kind: layer.kind, via };
}

function inferenceOf(source: Readonly<Record<string, unknown>>): ExecutionJsonObject | undefined {
  const out: Record<string, unknown> = {};
  for (const key of LLM_INFERENCE_FIELDS) if (source[key] !== undefined) out[key] = source[key];
  return Object.keys(out).length > 0 ? (out as ExecutionJsonObject) : undefined;
}

/** A configured engine's model, inference, timeout and workspace, and where its aliases resolve. */
function engineDefaults(name: string, engine: EngineConfig, config: AkmConfig): EngineDefaults {
  const own = engineModelAndInference(engine);
  const values: Record<string, unknown> = {
    ...(own.model !== undefined ? { model: own.model } : {}),
    ...(own.inference !== undefined ? { inference: own.inference } : {}),
    ...(Object.hasOwn(engine, "timeoutMs") ? { timeout: engine.timeoutMs ?? null } : {}),
  };
  if (engine.kind === "llm") return { kind: "llm", platform: engine.provider ?? name, modelMapKey: name, values };
  if (engine.workspace !== undefined) values.workspace = engine.workspace;
  if (engine.platform !== "opencode-sdk") {
    return { kind: "agent", platform: engine.platform, modelMapKey: engine.platform, values };
  }
  // An SDK engine runs its LLM fallback's model/inference/timeout unless it sets its own.
  const fallbackName = engine.llmEngine ?? config.defaults?.llmEngine;
  const fallback =
    fallbackName && config.engines && Object.hasOwn(config.engines, fallbackName)
      ? config.engines[fallbackName]
      : undefined;
  if (fallback?.kind !== "llm" || !fallbackName) {
    return {
      kind: "sdk",
      platform: "opencode-sdk",
      modelMapKey: "opencode-sdk",
      values: {
        ...values,
        timeout: has(values, "timeout") ? (values.timeout as number | null) : DEFAULT_AGENT_TIMEOUT_MS,
      },
    };
  }
  const inherited = engineModelAndInference(fallback);
  return {
    kind: "sdk",
    platform: "opencode-sdk",
    modelMapKey: own.model === undefined ? fallbackName : "opencode-sdk",
    values: {
      ...(inherited.model !== undefined ? { model: inherited.model } : {}),
      ...(inherited.inference !== undefined ? { inference: inherited.inference } : {}),
      ...values,
      timeout: Object.hasOwn(engine, "timeoutMs")
        ? (engine.timeoutMs ?? null)
        : Object.hasOwn(fallback, "timeoutMs")
          ? (fallback.timeoutMs ?? null)
          : DEFAULT_LLM_TIMEOUT_MS,
    },
  };
}

/** The same defaults read back from an already-resolved runner. */
function runnerDefaults(runner: RunnerSpec): EngineDefaults {
  const timeout = Object.hasOwn(runner, "timeoutMs") ? { timeout: runner.timeoutMs ?? null } : {};
  if (runner.kind === "llm") {
    const inference = inferenceOf(runner.connection as Record<string, unknown>);
    return {
      kind: "llm",
      platform: runner.connection.provider ?? runner.engine,
      modelMapKey: runner.engine,
      values: {
        ...(runner.connection.model !== undefined ? { model: runner.connection.model } : {}),
        ...(inference ? { inference } : {}),
        ...timeout,
      },
    };
  }
  const platform = runner.profile.platform ?? runner.profile.name;
  const fallback = runner.kind === "sdk" ? runner.fallbackConnection : undefined;
  const model = runner.profile.model ?? fallback?.model;
  const inference = fallback ? inferenceOf(fallback as Record<string, unknown>) : undefined;
  return {
    kind: runner.kind,
    platform,
    modelMapKey: platform,
    values: {
      ...(model !== undefined ? { model } : {}),
      ...(inference ? { inference } : {}),
      ...timeout,
      ...(runner.profile.workspace !== undefined ? { workspace: runner.profile.workspace } : {}),
    },
  };
}

/**
 * The engine, from an ordered list: the nearest layer that names one, then
 * `defaults.engine`, then the implicit opencode-sdk fallback when its binary
 * is present. A named engine that is not configured is an error, never rescued.
 */
function selectEngine(
  config: AkmConfig,
  layers: readonly Layer[],
): { name: string; engine: EngineConfig; provenance: ExecutionFieldProvenance; fallback: boolean } {
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    const name = layer?.values.engine;
    if (layer && typeof name === "string" && name.length > 0) {
      return { name, engine: configuredEngine(name, config), provenance: explicit(layer), fallback: false };
    }
  }
  const installed = config.defaults?.engine;
  if (installed) {
    return {
      name: installed,
      engine: configuredEngine(installed, config),
      provenance: { layer: "installation-defaults", kind: "installation", via: "explicit" },
      fallback: false,
    };
  }
  const fallback = fallbackEngineConfig(config);
  if (fallback) {
    return {
      name: FALLBACK_ENGINE_NAME,
      engine: fallback,
      provenance: { layer: FALLBACK_ENGINE_NAME, kind: "fallback", via: "fallback" },
      fallback: true,
    };
  }
  throw new ConfigError(`Execution ${NO_ENGINE_MESSAGE_SUFFIX}`, "INVALID_CONFIG_FILE", NO_ENGINE_REMEDY);
}

function parseTimeout(value: unknown): number | null {
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

/** Tool names a selection asks for; `undefined` when a structured policy cannot be reduced to names. */
function requestedToolNames(tools: Exclude<ToolSelection, null>): readonly string[] | undefined {
  if (typeof tools === "string") {
    return tools
      .split(",")
      .map((tool) => tool.trim())
      .filter(Boolean);
  }
  if (Array.isArray(tools)) return tools.map((tool) => tool.trim()).filter(Boolean);
  const policy = tools as ExecutionJsonObject;
  if (Object.values(policy).some((value) => typeof value !== "boolean")) return undefined;
  return Object.keys(policy).filter((tool) => policy[tool] === true);
}

/** Assets may only narrow the host's `execution.allowedTools`; without a config nothing is allowed. */
function authorizeTools(tools: ToolSelection | undefined, config: AkmConfig | undefined): ToolAuthorizationResult {
  if (!hasToolSelection(tools)) return { status: "not-required" };
  if (!config) {
    return {
      status: "denied",
      reason: "Selected tools require an explicit machine/user authorization policy.",
      policy: { id: "unconfigured" },
    };
  }
  const allowed = new Set(config.execution?.allowedTools ?? []);
  const names = requestedToolNames(tools);
  const permitted = allowed.has("*") || names?.every((tool) => allowed.has(tool)) === true;
  return permitted
    ? {
        status: "allowed",
        reason: "Selected tools were authorized by operator policy.",
        policy: { id: "config-execution-allowed-tools" },
      }
    : {
        status: "denied",
        reason: "Selected tools are not authorized by operator policy.",
        policy: { id: "config-execution-allowed-tools" },
      };
}

function withInference(connection: Record<string, unknown>, inference: ExecutionJsonObject | null | undefined) {
  const out: Record<string, unknown> = { ...connection };
  for (const key of LLM_INFERENCE_FIELDS) delete out[key];
  if (inference) for (const key of LLM_INFERENCE_FIELDS) if (inference[key] !== undefined) out[key] = inference[key];
  return out;
}

/** Apply a request's model, inference, timeout and workspace to its runner. Idempotent. */
function applyRequest(base: RunnerSpec, request: ResolvedExecutionRequestV1): RunnerSpec {
  const timeout = Object.hasOwn(request.runtime, "timeoutMs")
    ? { timeoutMs: request.runtime.timeoutMs ?? null }
    : Object.hasOwn(base, "timeoutMs")
      ? { timeoutMs: base.timeoutMs }
      : {};
  const model = request.model?.resolved;
  if (base.kind === "llm") {
    const { model: _model, ...connection } = base.connection;
    return {
      ...base,
      connection: withInference(
        { ...connection, ...(model !== undefined ? { model } : {}) },
        request.inference,
      ) as typeof base.connection,
      ...timeout,
    };
  }
  const { model: _model, workspace: _workspace, ...profile } = base.profile;
  const workspace = request.runtime.workspace;
  const next = {
    ...base,
    profile: {
      ...profile,
      ...(model !== undefined ? { model } : {}),
      ...(typeof workspace === "string" ? { workspace } : {}),
    },
    ...timeout,
  };
  if (next.kind === "sdk" && next.fallbackConnection) {
    let fallback: Record<string, unknown> = { ...next.fallbackConnection };
    if (request.model === null) delete fallback.model;
    if (Object.hasOwn(request, "inference")) fallback = withInference(fallback, request.inference);
    next.fallbackConnection = fallback as typeof next.fallbackConnection;
  }
  return next as RunnerSpec;
}

function mergeInference(
  current: ExecutionJsonObject | null | undefined,
  next: ExecutionJsonObject | null,
  source: ExecutionFieldProvenance,
  provenance: Record<string, ExecutionFieldProvenance>,
): ExecutionJsonObject | null {
  provenance["/inference"] = source;
  if (next === null) {
    for (const key of Object.keys(provenance)) if (key.startsWith("/inference/")) delete provenance[key];
    return null;
  }
  for (const key of Object.keys(next)) {
    provenance[`/inference/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`] = source;
  }
  return deepMergeConfig(current ?? {}, next as Record<string, unknown>) as ExecutionJsonObject;
}

/**
 * Resolve one execution: select the engine, merge its defaults with the
 * caller's layers (nearest wins), expand a model alias, authorize tools, and
 * apply the result to the engine's runner.
 */
export function resolveExecution(input: ResolveExecutionInput): ResolvedExecution {
  const command =
    input.command ??
    createInlineResolvedCommand({
      template: input.content ?? "",
      ...(input.argumentInput !== undefined ? { argumentInput: input.argumentInput } : {}),
      content: input.content ?? "",
    });
  const callerLayers: Layer[] = [
    ...(input.agentLayer ? [{ ...input.agentLayer, kind: "agent" as const }] : []),
    {
      id: input.commandLayer?.id ?? "inline-command",
      kind: "command",
      values: input.commandLayer?.values ?? {},
    },
    ...(input.invocationDefaults
      ? [{ id: "invocation-defaults", kind: "invocation-defaults" as const, values: input.invocationDefaults }]
      : []),
    ...(input.current ? [{ id: "current-invocation", kind: "current" as const, values: input.current }] : []),
  ];

  const provenance: Record<string, ExecutionFieldProvenance> = {};
  let name: string;
  let defaults: EngineDefaults;
  let base: RunnerSpec;
  let fallback = false;
  if (input.runner) {
    name = input.runner.engine;
    defaults = runnerDefaults(input.runner);
    base = input.runner;
    provenance.engine = { layer: "installation-defaults", kind: "installation", via: "explicit" };
  } else {
    if (!input.config) throw new TypeError("resolveExecution needs a config or a runner");
    const selected = selectEngine(input.config, callerLayers);
    name = selected.name;
    fallback = selected.fallback;
    defaults = engineDefaults(name, selected.engine, input.config);
    base = resolveEngine(name, input.config, selected.engine);
    provenance.engine = selected.provenance;
  }
  const layers: Layer[] = [{ id: name, kind: "engine", values: defaults.values }, ...callerLayers];

  provenance.command = { layer: command.source?.ref ?? "inline", kind: "command", via: "source" };
  let persona = input.persona;
  const agentLayer = nearest(layers, "agent");
  const agent = agentLayer?.values.agent;
  if (agentLayer) {
    provenance.agent = explicit(agentLayer);
    // A native selector (or an explicit null) replaces any persona.
    if (typeof agent !== "string" || !isPortableExecutionAgentSelector(agent)) persona = null;
  }
  if (persona) provenance.persona = { layer: persona.source.ref, kind: "agent", via: "source" };

  const modelLayer = nearest(layers, "model");
  let model: ResolvedModelSelection | null | undefined;
  let aliasInference: ExecutionJsonObject | null | undefined;
  if (modelLayer) {
    provenance.model = explicit(modelLayer);
    const value = modelLayer.values.model;
    if (value === null) model = null;
    else if (typeof value === "string" && value.length > 0) {
      const map = input.modelMap ?? (input.config ? loadModelMap({ engines: input.config.engines }).map : undefined);
      const selection = map
        ? resolveModelMapAlias(value, defaults.modelMapKey, map)
        : { input: value, interpretation: "exact" as const, model: value };
      model = { input: selection.input, interpretation: selection.interpretation, resolved: selection.model };
      if ("inference" in selection && selection.inference !== undefined) aliasInference = selection.inference;
    } else {
      throw new ConfigError("Resolved model must be null or a non-empty string.", "INVALID_CONFIG_FILE");
    }
  }

  // An alias's inference applies at the layer that chose the alias, under that layer's own inference.
  let inference: ExecutionJsonObject | null | undefined;
  for (const layer of layers) {
    if (layer === modelLayer && aliasInference !== undefined) {
      inference = mergeInference(inference, aliasInference, explicit(layer, "model-alias"), provenance);
    }
    if (has(layer.values, "inference")) {
      inference = mergeInference(inference, layer.values.inference ?? null, explicit(layer), provenance);
    }
  }

  const select = (key: keyof UnresolvedExecutionDefaults, field: string): Layer | undefined => {
    const layer = nearest(layers, key);
    if (layer) provenance[field] = explicit(layer);
    return layer;
  };
  const schemaLayer = select("outputSchema", "outputSchema");
  const toolsLayer = select("tools", "tools");
  const timeoutLayer = select("timeout", "runtime.timeoutMs");
  const workspaceLayer = select("workspace", "runtime.workspace");
  const environmentLayer = select("environment", "runtime.environment");
  const settingsLayer = select("runtime", "runtime.settings");
  const tools = toolsLayer ? cloneToolSelection(toolsLayer.values.tools ?? null, "tools") : undefined;
  const authorization = authorizeTools(tools, input.runner ? undefined : input.config);
  provenance.authorization = {
    layer: typeof authorization.policy?.id === "string" ? authorization.policy.id : "not-required",
    kind: "authorization",
    via: "policy",
  };

  const request = createResolvedExecutionRequest({
    command,
    ...(input.conversation !== undefined ? { conversation: input.conversation } : {}),
    ...(agentLayer ? { agent: agent as string | null } : {}),
    ...(persona !== undefined ? { persona } : {}),
    engine: { name, kind: defaults.kind, platform: defaults.platform },
    ...(modelLayer ? { model: model ?? null } : {}),
    ...(inference !== undefined ? { inference } : {}),
    ...(schemaLayer ? { outputSchema: schemaLayer.values.outputSchema ?? null } : {}),
    ...(toolsLayer ? { tools } : {}),
    authorization,
    runtime: {
      ...(timeoutLayer ? { timeoutMs: parseTimeout(timeoutLayer.values.timeout ?? null) } : {}),
      ...(workspaceLayer ? { workspace: workspaceLayer.values.workspace ?? null } : {}),
      ...(environmentLayer ? { environment: environmentLayer.values.environment ?? null } : {}),
      ...(settingsLayer ? { settings: settingsLayer.values.runtime ?? null } : {}),
    },
    notices: [],
  });
  const sorted = Object.fromEntries(Object.entries(provenance).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return {
    request,
    runner: applyRequest(base, request),
    provenance: sorted,
    ...(fallback ? { fallbackEngineName: name } : {}),
  };
}

function nonEmpty(value: object | null | undefined): boolean {
  return value !== null && value !== undefined && Object.keys(value).length > 0;
}

function buildLlm(
  request: ResolvedExecutionRequestV1,
  runner: Extract<RunnerSpec, { kind: "llm" }>,
  options: RunAgentOptions,
): BuiltExecution {
  if (typeof request.agent === "string" && request.persona === null) {
    throw new ConfigError(
      `The direct LLM transport cannot consume native agent selector ${JSON.stringify(request.agent)}.`,
      "INVALID_CONFIG_FILE",
    );
  }
  if (hasToolSelection(request.tools)) {
    throw new ConfigError("The direct LLM transport cannot enforce the resolved tool policy.", "INVALID_CONFIG_FILE");
  }
  const notices: Readonly<LoweringNotice>[] = [...request.notices];
  const skip = (field: string): void => {
    notices.push(untranslated("llm", field));
  };
  for (const key of Object.keys(request.inference ?? {}).sort()) {
    if (!(LLM_INFERENCE_FIELDS as readonly string[]).includes(key)) skip(`inference.${key}`);
  }
  const chatOptions: ChatCompletionOptions = {};
  if (request.outputSchema) {
    if (runner.connection.supportsJsonSchema === true) chatOptions.responseSchema = request.outputSchema;
    else skip("outputSchema");
  }
  if (request.runtime.workspace) skip("runtime.workspace");
  if (nonEmpty(request.runtime.environment)) skip("runtime.environment");
  if (nonEmpty(request.runtime.settings)) skip("runtime.settings");
  for (const field of extensionFields(request)) skip(field);
  const messages: ChatMessage[] = [
    ...(request.persona ? [{ role: "system" as const, content: request.persona.content }] : []),
    ...(request.conversation ?? []).map((message) => ({ role: message.role, content: message.content })),
    { role: "user", content: request.command.content },
  ];
  return { request, runner, prompt: request.command.content, options, messages, chatOptions, notices };
}

/**
 * Build a request for its runner's transport: the harness's own builder for
 * agent/SDK engines, chat messages for a direct LLM. A request whose tools
 * were denied by `execution.allowedTools` stops here.
 */
export function buildExecution(request: ResolvedExecutionRequestV1, runner: RunnerSpec): BuiltExecution {
  if (request.authorization.status === "denied") {
    throw new ConfigError(
      request.authorization.reason ?? "Resolved execution is not authorized by operator policy.",
      "EXECUTION_NOT_AUTHORIZED",
    );
  }
  const applied = applyRequest(runner, request);
  const environment = request.runtime.environment;
  const options: RunAgentOptions = {
    stdio: "captured",
    parseOutput: "text",
    ...(applied.timeoutMs !== undefined ? { timeoutMs: applied.timeoutMs } : {}),
    ...(applied.kind !== "llm" && applied.profile.workspace ? { cwd: applied.profile.workspace } : {}),
    ...(environment ? { env: { ...environment } } : {}),
  };
  if (applied.kind === "llm") return buildLlm(request, applied, options);

  const platform = applied.profile.platform ?? applied.profile.name;
  const harness = getHarness(platform);
  const lower = harness?.agentBuilder?.lower ?? harness?.executionLowerer?.lower;
  if (!lower) {
    throw new ConfigError(
      `Agent platform ${JSON.stringify(platform)} has no registered request builder.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const built = lower(applied.profile, request);
  return {
    request,
    runner: applied,
    prompt: built.prompt,
    options: { ...options, dispatch: built.dispatch },
    notices: [...request.notices, ...built.notices],
  };
}

/**
 * Resume: build a journaled `{ request, runner }` exactly as frozen. Never
 * reads config, models.json or credentials, so a config edit after the freeze
 * cannot change what a resumed unit runs.
 */
export function buildExecutionFromWire(wire: { readonly request: unknown; readonly runner: unknown }): BuiltExecution {
  return buildExecution(decodeResolvedExecutionRequest(wire.request), decodeFrozenRunnerSpec(wire.runner));
}

/** Each configured engine's own model selection and models.json column, for `akm health`. */
export function executionEngineDefinitionsFromConfig(config: AkmConfig): Readonly<
  Record<
    string,
    {
      readonly selection: { readonly name: string; readonly kind: "llm" | "agent" | "sdk"; readonly platform: string };
      readonly defaults: UnresolvedExecutionDefaults;
      readonly modelMapKey: string;
    }
  >
> {
  return Object.fromEntries(
    Object.entries(config.engines ?? {}).map(([name, engine]) => {
      const defaults = engineDefaults(name, engine, config);
      return [
        name,
        {
          selection: { name, kind: defaults.kind, platform: defaults.platform },
          defaults: defaults.values,
          modelMapKey: defaults.modelMapKey,
        },
      ];
    }),
  );
}
