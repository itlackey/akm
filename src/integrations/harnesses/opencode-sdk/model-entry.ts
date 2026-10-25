// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * How a request's inference becomes the OpenCode model entry akm declares for a
 * provider it supplies. A model the user's own OpenCode config provides carries
 * none: set it there.
 *
 * OpenCode 2 reads inference only from the model entry: agent `options` are
 * moved into a request body nothing reads (#1244 review, item 8).
 *   - `options.temperature` is sent as `temperature`, `options.reasoningEffort`
 *     as `reasoning_effort`; `chat_template_kwargs` and `enable_thinking` are
 *     sent as they are (the two forms an LLM engine sends for `enableThinking`).
 *   - `limit.output` is the request's `max_tokens` and `limit.context` the
 *     window OpenCode builds requests to fit. OpenCode refuses a `limit` with
 *     only one of them, so akm declares it only when it has both.
 */

import type { ExecutionJsonObject } from "../../../execution/json";

/** The inference keys the OpenCode SDK harness translates. */
export const OPENCODE_INFERENCE = ["temperature", "reasoningEffort", "enableThinking", "maxTokens"] as const;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

/** The model entry for `inference`. A value of the wrong type is left out. */
export function opencodeModelEntry(inference: ExecutionJsonObject | null | undefined): Record<string, unknown> {
  const { temperature, reasoningEffort, enableThinking, maxTokens, contextLength } = inference ?? {};
  const options: Record<string, unknown> = {};
  if (typeof temperature === "number" && Number.isFinite(temperature)) options.temperature = temperature;
  if (typeof reasoningEffort === "string" && reasoningEffort.length > 0) options.reasoningEffort = reasoningEffort;
  if (typeof enableThinking === "boolean") {
    options.chat_template_kwargs = { enable_thinking: enableThinking };
    options.enable_thinking = enableThinking;
  }
  return {
    ...(Object.keys(options).length > 0 ? { options } : {}),
    ...(isPositiveInteger(maxTokens) && isPositiveInteger(contextLength)
      ? { limit: { context: contextLength, output: maxTokens } }
      : {}),
  };
}
