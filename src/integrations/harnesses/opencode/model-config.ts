// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * How a request's inference becomes opencode config where akm writes that
 * config itself: the options of the `akm-model-work` agent, and the model entry
 * of an `opencode-sdk` engine's `llmEngine` fallback (`akm-custom`). A dispatch
 * that runs through the user's own opencode config carries none; set it there.
 *
 * What opencode 1.18.25 does with it, checked against a local OpenAI-compatible
 * stub:
 *   - `options.temperature` is sent as `temperature`, and `options.reasoningEffort`
 *     as `reasoning_effort` (camelCase; `options.reasoning_effort` is dropped).
 *     `options.chat_template_kwargs` and `options.enable_thinking` are sent as
 *     they are: the two forms an LLM engine sends for `enableThinking`.
 *   - `limit.output` is the request's `max_tokens` and `limit.context` the window
 *     opencode builds requests to fit. opencode refuses a `limit` with only one
 *     of them, so akm declares `limit` only when it has both.
 *   - `options` set on an agent apply to that agent's calls only; set on a model
 *     they also apply to opencode's own calls on it (a title for the session).
 *     Model work therefore puts them on its agent, which needs no model named.
 */

import type { ExecutionJsonObject } from "../../../execution/json";

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

/**
 * Split `inference` into opencode config: `entry` for a model (its options, and
 * its limit), and for model work `agentOptions` for the confined agent in place
 * of the entry's options. A value of the wrong type is left out.
 */
export function opencodeInferenceConfig(
  inference: ExecutionJsonObject | null | undefined,
  modelWork: boolean,
): { readonly entry: Record<string, unknown>; readonly agentOptions?: Record<string, unknown> } {
  const { temperature, reasoningEffort, enableThinking, maxTokens, contextLength } = inference ?? {};
  const options: Record<string, unknown> = {};
  if (typeof temperature === "number" && Number.isFinite(temperature)) options.temperature = temperature;
  if (typeof reasoningEffort === "string" && reasoningEffort.length > 0) options.reasoningEffort = reasoningEffort;
  if (typeof enableThinking === "boolean") {
    options.chat_template_kwargs = { enable_thinking: enableThinking };
    options.enable_thinking = enableThinking;
  }
  const hasOptions = Object.keys(options).length > 0;
  return {
    entry: {
      ...(hasOptions && !modelWork ? { options } : {}),
      ...(isPositiveInteger(maxTokens) && isPositiveInteger(contextLength)
        ? { limit: { context: contextLength, output: maxTokens } }
        : {}),
    },
    ...(hasOptions && modelWork ? { agentOptions: options } : {}),
  };
}
