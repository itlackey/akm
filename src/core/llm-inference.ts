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
import { isPlainObject } from "./config/deep-merge";
import type { LlmInvocationOverridesSchema } from "./config/schema/primitives";

export type LlmInference = z.infer<typeof LlmInvocationOverridesSchema>;

/**
 * The portable settings a request's inference may carry and an endpoint's
 * request translates: `temperature`, `maxTokens`, `reasoningEffort` (an asset's
 * `effort:` is the same setting) and `enableThinking`, plus `extraParams`, whose
 * entries are inlined as request fields. `contextLength` is a connection's own
 * key, not a per-call setting.
 */
export const PORTABLE_INFERENCE_KEYS = [
  "temperature",
  "maxTokens",
  "reasoningEffort",
  "enableThinking",
  "extraParams",
] as const;

/** Whether a request's fields turn thinking on or off, in either of the two spellings an endpoint reads; `undefined` when they say nothing. */
export function thinkingSetting(request: Readonly<Record<string, unknown>>): boolean | undefined {
  const kwargs = request.chat_template_kwargs;
  const nested =
    typeof kwargs === "object" && kwargs !== null ? (kwargs as Record<string, unknown>).enable_thinking : undefined;
  const value = request.enable_thinking ?? nested;
  return typeof value === "boolean" ? value : undefined;
}

/** The wire fields for `inference`, in the order the request lists them. */
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

/**
 * `over` laid on `base`, one level deep: a field that is an object on both sides
 * (`chat_template_kwargs`) is merged key by key, so a call's `enableThinking`
 * does not erase the `thinking_budget` beside it; any other field of `over` wins.
 */
export function mergeRequestFields(
  base: Readonly<Record<string, unknown>>,
  over: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const was = merged[key];
    merged[key] = isPlainObject(was) && isPlainObject(value) ? { ...was, ...value } : value;
  }
  return merged;
}

/**
 * The fields a request carries: `request` as written, with the translation of
 * `inference` laid on it. The one place portable settings meet an endpoint's own
 * spelling.
 */
export function effectiveRequestFields(
  request: Readonly<Record<string, unknown>> | undefined,
  inference: LlmInference | null | undefined,
): Record<string, unknown> {
  return mergeRequestFields(request ?? {}, inferenceWireFields(inference ?? undefined));
}
