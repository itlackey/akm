// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * How a request's inference reaches opencode. opencode takes sampling and
 * limits from its config, not from the command line, so a dispatch carries
 * them by injecting config through `OPENCODE_CONFIG_CONTENT`: the CLI builder
 * as the child's env, the SDK runner in its server config.
 *
 * What opencode 1.18.25 does with it, checked against a local OpenAI-compatible
 * stub and an opencode config that sets `options.reasoningEffort: "none"` on
 * the model:
 *   - `options.temperature` is sent as `temperature`, and `options.reasoningEffort`
 *     as `reasoning_effort` (camelCase; `options.reasoning_effort` is dropped).
 *     The model's `temperature: true` capability is not needed for them.
 *   - `options.chat_template_kwargs` and `options.enable_thinking` are sent as
 *     they are: the two forms the LLM transport sends for `enableThinking`.
 *   - `limit.output` is the request's `max_tokens` (32000 without it, which a
 *     small-context server rejects) and `limit.context` is the window opencode
 *     builds requests to fit. opencode refuses a `limit` that has only one of
 *     them ("Missing key"), and the entry is merged over the user's own for
 *     the same model, so a half would overwrite the other half of a limit the
 *     user declared. akm therefore declares `limit` only when it knows both.
 *   - `options` set on an agent apply to that agent's calls only and win over
 *     the model's. opencode also makes calls of its own on the same model (a
 *     title for the session), and options set on the model apply to those too.
 *     So the confined model-work agent, which akm defines and runs, carries
 *     the options and the title call keeps the model's defaults. It needs no
 *     model named: it runs whichever model opencode picks. Any other dispatch
 *     runs the user's own agent, which akm cannot name reliably
 *     (`default_agent` can change it), so its options go on the model, and
 *     need a `provider/model` to go on.
 *   - Injected config deep-merges over the user's config for the same
 *     provider, model and agent: what the request does not set stays as written.
 */

import type { ExecutionJsonObject } from "../../../execution/json";

/** What opencode can carry of a request's inference. */
export interface OpencodeInference {
  readonly temperature?: number;
  readonly reasoningEffort?: string;
  readonly enableThinking?: boolean;
  readonly limit?: { readonly context: number; readonly output: number };
}

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

/**
 * What opencode carries of `inference`, and the keys that covers. A key it
 * cannot carry is left out: one of the wrong type, or `maxTokens` or
 * `contextLength` without the other. An explicit `null` clears a field, so it
 * is carried as nothing.
 */
export function carriedInference(inference: ExecutionJsonObject | null | undefined): {
  readonly carried: OpencodeInference;
  readonly keys: readonly string[];
} {
  const carried: { -readonly [K in keyof OpencodeInference]: OpencodeInference[K] } = {};
  const { temperature, reasoningEffort, enableThinking, maxTokens, contextLength } = inference ?? {};
  if (typeof temperature === "number" && Number.isFinite(temperature)) carried.temperature = temperature;
  if (typeof reasoningEffort === "string" && reasoningEffort.length > 0) carried.reasoningEffort = reasoningEffort;
  if (typeof enableThinking === "boolean") carried.enableThinking = enableThinking;
  const limit = isPositiveInteger(maxTokens) && isPositiveInteger(contextLength);
  if (limit) carried.limit = { context: contextLength, output: maxTokens };
  const keys = (
    [
      ["temperature", carried.temperature !== undefined, temperature],
      ["reasoningEffort", carried.reasoningEffort !== undefined, reasoningEffort],
      ["enableThinking", carried.enableThinking !== undefined, enableThinking],
      ["maxTokens", limit, maxTokens],
      ["contextLength", limit, contextLength],
    ] as const
  )
    .filter(([, isCarried, value]) => isCarried || value === null)
    .map(([key]) => key);
  return { carried, keys };
}

/** opencode's own split of `provider/model`: at the first slash, so a model id may contain slashes. */
export function splitOpencodeModel(model: string): { providerID: string; modelID: string } | undefined {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

/**
 * The inference keys opencode carries for a dispatch. With a model to attach
 * them to (`attachable`) it carries all of them. Without one it carries only
 * what the model-work agent can, which is every option but the limit; any
 * other dispatch carries nothing.
 */
export function opencodeCarriedKeys(
  attachable: boolean,
  inference: ExecutionJsonObject | null | undefined,
  modelWork: boolean,
): readonly string[] {
  const { keys } = carriedInference(inference);
  if (attachable) return keys;
  return modelWork ? keys.filter((key) => key !== "maxTokens" && key !== "contextLength") : [];
}

/** Where a dispatch's inference goes: the model's entry, and for model work the confined agent's options. */
export interface OpencodeInferenceConfig {
  /** The model's entry under `provider.<id>.models.<id>`; empty when there is nothing to put on the model. */
  readonly entry: Record<string, unknown>;
  /** The options of the model-work agent, which runs the dispatch; only for model work. */
  readonly agentOptions?: Record<string, unknown>;
}

/** Split `inference` between the model and, for model work, the confined agent (see the module comment). */
export function opencodeInferenceConfig(
  inference: ExecutionJsonObject | null | undefined,
  modelWork: boolean,
): OpencodeInferenceConfig {
  const { carried } = carriedInference(inference);
  const options: Record<string, unknown> = {};
  if (carried.temperature !== undefined) options.temperature = carried.temperature;
  if (carried.reasoningEffort !== undefined) options.reasoningEffort = carried.reasoningEffort;
  if (carried.enableThinking !== undefined) {
    options.chat_template_kwargs = { enable_thinking: carried.enableThinking };
    options.enable_thinking = carried.enableThinking;
  }
  const hasOptions = Object.keys(options).length > 0;
  return {
    entry: {
      ...(hasOptions && !modelWork ? { options } : {}),
      ...(carried.limit ? { limit: { ...carried.limit } } : {}),
    },
    ...(hasOptions && modelWork ? { agentOptions: options } : {}),
  };
}

/** The config that gives `model` (`provider/model`) `entry`: undefined when the model cannot be split or `entry` is empty. */
export function opencodeModelConfig(
  model: string | undefined,
  entry: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const target = model === undefined ? undefined : splitOpencodeModel(model);
  if (!target || Object.keys(entry).length === 0) return undefined;
  return { provider: { [target.providerID]: { models: { [target.modelID]: entry } } } };
}
