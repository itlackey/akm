// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The portable model settings (`temperature`, `maxTokens`, `reasoningEffort`,
 * `enableThinking`, ...) an asset, a process or a flag may set, and the one place
 * they become the request fields an OpenAI-compatible endpoint takes. One asset
 * lands on different endpoints, so it says what it wants in akm's words and the
 * endpoint's own spelling is chosen here. Whatever a connection or model entry
 * writes in the endpoint's spelling is sent as written (`request`), under these.
 */
import type { z } from "zod";
import type { LlmInvocationOverridesSchema } from "./config/schema/primitives";

export type LlmInference = z.infer<typeof LlmInvocationOverridesSchema>;

/** Whether a request's fields turn thinking on or off, in either of the two spellings an endpoint reads; `undefined` when they say nothing. */
export function thinkingSetting(request: Readonly<Record<string, unknown>>): boolean | undefined {
  const kwargs = request.chat_template_kwargs;
  const nested =
    typeof kwargs === "object" && kwargs !== null ? (kwargs as Record<string, unknown>).enable_thinking : undefined;
  const value = request.enable_thinking ?? nested;
  return typeof value === "boolean" ? value : undefined;
}

/** The wire fields for `inference`, in the order the request lists them. `contextLength` and `supportsJsonSchema` are not request fields. */
export function inferenceWireFields(inference: LlmInference | undefined): Record<string, unknown> {
  if (!inference) return {};
  return {
    ...(inference.temperature !== undefined ? { temperature: inference.temperature } : {}),
    ...(inference.maxTokens !== undefined ? { max_tokens: inference.maxTokens } : {}),
    ...inference.extraParams,
    // Which of the two thinking fields an endpoint honors is a fact about it (and any gateway in
    // front of it), not about akm's wording: send both whenever thinking is set.
    ...(inference.enableThinking !== undefined
      ? {
          chat_template_kwargs: { enable_thinking: inference.enableThinking },
          enable_thinking: inference.enableThinking,
        }
      : {}),
    ...(inference.reasoningEffort !== undefined ? { reasoning_effort: inference.reasoningEffort } : {}),
  };
}
