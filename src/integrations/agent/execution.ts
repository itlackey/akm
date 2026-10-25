// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The execution pipeline, from the layers that speak for a call to a
 * dispatchable request:
 *
 *   resolveExecution(input)          config (or a journaled runner) + caller layers
 *                                    → { request, runner, provenance }
 *   buildExecution(request, runner)  the harness builder → prompt + argv inputs
 *                                    (harness, or the internal runtime) or chat
 *                                    messages (a connection doing model work)
 *   buildExecutionFromWire(wire)     resume: the same from a journaled
 *                                    { request, runner }, never reading config
 *   runExecution(built, options)     runner-dispatch.ts: credentials are read
 *                                    here, then spawn / runtime / chat
 *
 * Where the call runs, and with which model, is `resolveTarget`'s
 * (./resolution.ts); this module merges the rest of the layers (persona, agent,
 * inference, schema, workspace), nearest wins. Credentials stay symbolic in
 * everything returned.
 */

import type { AkmConfig } from "../../core/config/config-types";
import type { StandardAlias } from "../../core/config/model-aliases";
import { ConfigError } from "../../core/errors";
import { PORTABLE_INFERENCE_KEYS } from "../../core/llm-inference";
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
} from "../../execution/resolved-request";
import { isPortableExecutionAgentSelector, type UnresolvedExecutionDefaults } from "../../execution/source";
import type { ChatCompletionOptions, ChatMessage } from "../../llm/client";
import { getHarness } from "../harnesses";
import { runtimeLowerer } from "../harnesses/opencode/embedded/runtime-lowerer";
import { type AgentProfile, harnessProfile, runtimeProfile } from "./profiles";
import { lowerRequest, untranslated } from "./request-lowering";
import { mergeLayerInference, parseTimeout, resolveTarget, withReasoningEffort } from "./resolution";
import { decodeFrozenRunnerSpec, type RunnerSpec } from "./runner";
import type { RunAgentOptions } from "./spawn";

/** Which layer set one request field. */
export interface ExecutionFieldProvenance {
  readonly layer: string;
  readonly kind: "agent" | "command" | "invocation-defaults" | "current" | "installation";
  /** `default` marks a value no layer or configuration set, so the caller's own policy may replace it. */
  readonly via: "explicit" | "source" | "default";
}

/**
 * One layer of execution defaults: a shipped default, a persona's or a command's
 * frontmatter, a plan's defaults, a flag. A call's layers are listed farthest to
 * nearest and the nearest layer that sets a field wins.
 */
export interface ExecutionLayer {
  readonly id: string;
  readonly kind: ExecutionFieldProvenance["kind"];
  readonly values: UnresolvedExecutionDefaults;
}

/** The farthest layer of a call: the alias its kind of work asks for until something nearer names a model. */
export function shippedAlias(alias: StandardAlias): ExecutionLayer {
  return { id: "shipped-alias", kind: "installation", values: { model: alias } };
}

/** The layer for a call's own flags and arguments: nearer than every other. */
export function currentLayer(values: UnresolvedExecutionDefaults): ExecutionLayer {
  return { id: "current-invocation", kind: "current", values };
}

export interface ResolveExecutionInput {
  /** A rendered command. Omit it and pass `content` for an anonymous inline command. */
  readonly command?: ResolvedCommandContent;
  readonly content?: string;
  readonly argumentInput?: string;
  /** Resolve the target from this config… */
  readonly config?: AkmConfig;
  /** …or reuse an already-resolved runner (no config read, no model aliases). */
  readonly runner?: RunnerSpec;
  /** Ordered turns before the terminal user command. */
  readonly conversation?: readonly Readonly<ResolvedConversationMessage>[];
  readonly persona?: ResolvedPersonaContent | null;
  /** The layers that speak for the call, farthest to nearest. */
  readonly layers?: readonly ExecutionLayer[];
  /** Run as unattended model work: confined, and on a connection a direct call. */
  readonly modelWork?: boolean;
}

export interface ResolvedExecution {
  readonly request: ResolvedExecutionRequestV1;
  /** Where the request runs. Credentials are still symbolic. */
  readonly runner: RunnerSpec;
  /** The layer behind each request field, for `akm task explain` and `command run --dry-run`. */
  readonly provenance: Readonly<Record<string, ExecutionFieldProvenance>>;
}

/** A request built for its runner's transport. */
export interface BuiltExecution {
  readonly request: ResolvedExecutionRequestV1;
  readonly runner: RunnerSpec;
  /** The harness prompt (harness or runtime), or the terminal user message (chat). */
  readonly prompt: string;
  /** Spawn options: timeout, cwd, env, and the harness `dispatch` the argv is built from. */
  readonly options: Readonly<RunAgentOptions>;
  /** What the prompt is spawned or run as; absent for a direct chat. */
  readonly profile?: AgentProfile;
  /** Direct chat only. */
  readonly messages?: readonly ChatMessage[];
  readonly chatOptions?: Readonly<ChatCompletionOptions>;
  readonly notices: readonly Readonly<LoweringNotice>[];
}

function has(values: object | null | undefined, key: string): boolean {
  return (
    values !== null &&
    values !== undefined &&
    Object.hasOwn(values, key) &&
    (values as Record<string, unknown>)[key] !== undefined
  );
}

function nearest(
  layers: readonly ExecutionLayer[],
  key: keyof UnresolvedExecutionDefaults,
): ExecutionLayer | undefined {
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    if (layer && has(layer.values, key)) return layer;
  }
  return undefined;
}

function explicit(layer: ExecutionLayer): ExecutionFieldProvenance {
  return { layer: layer.id, kind: layer.kind, via: layer.kind === "installation" ? "default" : "explicit" };
}

/** Record which layer set each inference key, mirroring {@link mergeLayerInference}. */
function recordInferenceProvenance(
  layers: readonly ExecutionLayer[],
  provenance: Record<string, ExecutionFieldProvenance>,
): void {
  for (const layer of layers) {
    if (!has(layer.values, "inference")) continue;
    const source = explicit(layer);
    provenance["/inference"] = source;
    const inference = layer.values.inference ?? null;
    if (inference === null) {
      for (const key of Object.keys(provenance)) if (key.startsWith("/inference/")) delete provenance[key];
      continue;
    }
    for (const key of Object.keys(withReasoningEffort(inference))) {
      provenance[`/inference/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`] = source;
    }
  }
}

/** A journaled runner under this call's layers: the nearest layer's timeout and (exact) model replace its own. */
function applyLayers(runner: RunnerSpec, layers: readonly ExecutionLayer[]): RunnerSpec {
  const timeout = nearest(layers, "timeout")?.values.timeout;
  const model = nearest(layers, "model")?.values.model;
  return {
    ...runner,
    ...(timeout !== undefined ? { timeoutMs: parseTimeout(timeout) } : {}),
    ...(typeof model === "string" && model ? { model } : {}),
  };
}

/**
 * Resolve one execution: pick where it runs and the model (`resolveTarget`), merge
 * the caller's other layers (nearest wins), and build the request for that target.
 */
export function resolveExecution(input: ResolveExecutionInput): ResolvedExecution {
  const command =
    input.command ??
    createInlineResolvedCommand({
      template: input.content ?? "",
      ...(input.argumentInput !== undefined ? { argumentInput: input.argumentInput } : {}),
      content: input.content ?? "",
    });
  const layers = input.layers ?? [];
  const modelWork = input.modelWork === true;

  let runner: RunnerSpec;
  if (input.runner) runner = applyLayers(input.runner, layers);
  else if (input.config) {
    runner = resolveTarget({ config: input.config, modelWork, layers: layers.map((layer) => layer.values) });
  } else throw new TypeError("resolveExecution needs a config or a runner");

  const provenance: Record<string, ExecutionFieldProvenance> = {};
  const targetLayer = [...layers]
    .reverse()
    .find((layer) => has(layer.values, "connection") || has(layer.values, "harness") || has(layer.values, "engine"));
  provenance.target = targetLayer
    ? explicit(targetLayer)
    : { layer: "installation-defaults", kind: "installation", via: "explicit" };
  provenance.command = { layer: command.source?.ref ?? "inline", kind: "command", via: "source" };

  let persona = input.persona;
  // The harness's own `agent` is only a default for a request that names none: it never replaces a
  // persona, and model work keeps its confined agent.
  let agent: string | null | undefined;
  const agentLayer = nearest(layers, "agent");
  if (agentLayer) {
    agent = agentLayer.values.agent;
    provenance.agent = explicit(agentLayer);
    // A native selector (or an explicit null) replaces any persona.
    if (typeof agent !== "string" || !isPortableExecutionAgentSelector(agent)) persona = null;
  } else if (runner.kind === "harness" && runner.agent !== undefined && !persona && !modelWork) {
    agent = runner.agent;
    provenance.agent = { layer: runner.name, kind: "installation", via: "explicit" };
  }
  if (persona) provenance.persona = { layer: persona.source.ref, kind: "agent", via: "source" };

  const modelLayer = nearest(layers, "model");
  if (modelLayer) provenance.model = explicit(modelLayer);
  const requested = modelLayer?.values.model;
  let model: ResolvedModelSelection | undefined;
  if (runner.model !== undefined) {
    model = {
      model: runner.model,
      ...(typeof requested === "string" && requested !== runner.model ? { alias: requested } : {}),
    };
  }

  const inference = mergeLayerInference(layers.map((layer) => layer.values));
  recordInferenceProvenance(layers, provenance);

  const select = (key: keyof UnresolvedExecutionDefaults, field: string): ExecutionLayer | undefined => {
    const layer = nearest(layers, key);
    if (layer) provenance[field] = explicit(layer);
    return layer;
  };
  const schemaLayer = select("outputSchema", "outputSchema");
  const timeoutLayer = select("timeout", "runtime.timeoutMs");
  const workspaceLayer = select("workspace", "runtime.workspace");
  const environmentLayer = select("environment", "runtime.environment");
  const workspace = workspaceLayer
    ? (workspaceLayer.values.workspace ?? null)
    : runner.kind === "harness"
      ? runner.workspace
      : undefined;
  if (!timeoutLayer) {
    const targets = runner.kind === "connection" ? input.config?.connections : input.config?.harnesses;
    const configured = input.config === undefined || Object.hasOwn(targets?.[runner.name] ?? {}, "timeoutMs");
    provenance["runtime.timeoutMs"] = {
      layer: runner.name,
      kind: "installation",
      via: configured ? "explicit" : "default",
    };
  }

  const request = createResolvedExecutionRequest({
    command,
    ...(input.conversation !== undefined ? { conversation: input.conversation } : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(persona !== undefined ? { persona } : {}),
    target: {
      name: runner.name,
      kind: runner.kind,
      ...(runner.kind === "harness" ? { platform: runner.platform } : {}),
    },
    ...(model ? { model } : {}),
    ...(inference !== undefined ? { inference } : {}),
    ...(schemaLayer ? { outputSchema: schemaLayer.values.outputSchema ?? null } : {}),
    modelWork,
    runtime: {
      timeoutMs: runner.timeoutMs,
      ...(workspace !== undefined ? { workspace } : {}),
      ...(environmentLayer ? { environment: environmentLayer.values.environment ?? null } : {}),
    },
  });
  const sorted = Object.fromEntries(Object.entries(provenance).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { request, runner, provenance: sorted };
}

function nonEmpty(value: object | null | undefined): boolean {
  return value !== null && value !== undefined && Object.keys(value).length > 0;
}

function buildChat(
  request: ResolvedExecutionRequestV1,
  runner: Extract<RunnerSpec, { kind: "connection" }>,
  options: RunAgentOptions,
): BuiltExecution {
  if (typeof request.agent === "string" && request.persona === null) {
    throw new ConfigError(
      `A direct model call cannot consume native agent selector ${JSON.stringify(request.agent)}.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const notices: Readonly<LoweringNotice>[] = [];
  const skip = (field: string): void => {
    notices.push(untranslated("connection", field));
  };
  for (const key of Object.keys(request.inference ?? {}).sort()) {
    if (!(PORTABLE_INFERENCE_KEYS as readonly string[]).includes(key)) skip(`inference.${key}`);
  }
  const chatOptions: ChatCompletionOptions = {};
  // Sent unless the call opts out; chatCompletion drops it once if the provider rejects it.
  if (request.outputSchema) chatOptions.responseSchema = request.outputSchema;
  if (request.runtime.workspace) skip("runtime.workspace");
  if (nonEmpty(request.runtime.environment)) skip("runtime.environment");
  const messages: ChatMessage[] = [
    ...(request.persona ? [{ role: "system" as const, content: request.persona.content }] : []),
    ...(request.conversation ?? []).map((message) => ({ role: message.role, content: message.content })),
    { role: "user", content: request.command.content },
  ];
  return { request, runner, prompt: request.command.content, options, messages, chatOptions, notices };
}

/**
 * Build a request for its runner's transport: chat messages for model work on a
 * connection; otherwise the harness's own builder, which for agent work on a
 * connection is akm's internal runtime.
 */
export function buildExecution(request: ResolvedExecutionRequestV1, runner: RunnerSpec): BuiltExecution {
  const environment = request.runtime.environment;
  const workspace = request.runtime.workspace;
  const options: RunAgentOptions = {
    stdio: "captured",
    ...(request.runtime.timeoutMs !== undefined ? { timeoutMs: request.runtime.timeoutMs } : {}),
    ...(typeof workspace === "string" ? { cwd: workspace } : {}),
    ...(environment ? { env: { ...environment } } : {}),
  };
  if (runner.kind === "connection" && request.modelWork) return buildChat(request, runner, options);

  // Agent work on a connection runs on akm's own runtime, which is no harness and has its own lowering target.
  const profile = runner.kind === "harness" ? harnessProfile(runner) : runtimeProfile(runner);
  const target = runner.kind === "connection" ? runtimeLowerer : getHarness(runner.platform);
  if (!target) {
    throw new ConfigError(
      `Agent platform ${JSON.stringify(profile.platform)} has no registered request builder.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const built = lowerRequest(target, request);
  return {
    request,
    runner,
    prompt: built.prompt,
    options: { ...options, dispatch: built.dispatch },
    profile,
    notices: built.notices,
  };
}

/**
 * Resume: build a journaled `{ request, runner }` exactly as frozen. Never
 * reads config or credentials, so a config edit after the freeze cannot change
 * what a resumed unit runs.
 */
export function buildExecutionFromWire(wire: { readonly request: unknown; readonly runner: unknown }): BuiltExecution {
  return buildExecution(decodeResolvedExecutionRequest(wire.request), decodeFrozenRunnerSpec(wire.runner));
}
