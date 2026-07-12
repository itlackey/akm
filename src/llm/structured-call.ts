// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `callStructured<T>()` — the shared LLM-call-and-classify seam.
 *
 * Centralizes the scaffold replicated across ~20 in-tree LLM call sites:
 *
 *   tryLlmFeature(feature, akmConfig, …)
 *     -> chatCompletion(config, messages, requestOptions)
 *     -> classify(error) into one of EXACTLY three buckets
 *          (context_limit | html | other)
 *     -> parse(raw) / onError(cls, err)
 *     -> fallback
 *
 * What this seam OWNS (the dedup):
 *   - the `tryLlmFeature` wrap (gated path) and the gated-vs-ungated branch
 *   - the single `chatCompletion` call + request-option marshalling
 *   - the try/catch and the ONE classify ladder, computed ONCE via the
 *     EXISTING `isContextSizeError` + `LlmCallError.code === "provider_html_error"`
 *
 * What stays per-caller (passed in):
 *   - `parse(raw)`  — owns the `!raw` case, JSON extraction, validation, the
 *     success-path warns/telemetry, and returns the caller's fallback itself
 *     on bad/empty data.
 *   - `onError(cls, err)` — owns the per-caller error→fallback mapping
 *     (the warn() variants and telemetry bumps for each error class).
 *
 * Gating:
 *   - `akmConfig` present  → GATED: run through `tryLlmFeature`; a throw inside
 *     is classified and routed to `onError`, and the wrapper returns the
 *     caller's fallback on disablement/timeout.
 *   - `akmConfig === undefined` → UNGATED: run the chat+parse directly with no
 *     error funnel — errors PROPAGATE to the caller (pre-gate behaviour used by
 *     direct callers such as `enhanceMetadata`).
 */

import type { AkmConfig, LlmProfileConfig } from "../core/config/config";
import { type ChatMessage, chatCompletion, isContextSizeError, LlmCallError } from "./client";
import { type LlmFeatureKey, type TryLlmFeatureFallbackEvent, tryLlmFeature } from "./feature-gate";

/**
 * The three — and only three — error classes the centralized ladder produces.
 * Matches exactly what `classifyLlmError` returns; no speculative 4th variant.
 */
export type LlmErrorClass = "context_limit" | "html" | "other";

/**
 * Classify a thrown LLM error into one of the three buckets. This is the single
 * home for the `isContextSizeError -> html -> other` ladder that was previously
 * inlined at every call site.
 */
export function classifyLlmError(err: unknown): LlmErrorClass {
  const message = err instanceof Error ? err.message : String(err);
  if (isContextSizeError(message)) return "context_limit";
  if (err instanceof LlmCallError && err.code === "provider_html_error") return "html";
  return "other";
}

/**
 * Per-call request shape. Mirrors the subset of {@link ChatCompletionOptions}
 * the structured callers actually use, plus an injectable `chat` seam so tests
 * can replace the transport without a network call. When `chat` is omitted the
 * real {@link chatCompletion} is used.
 */
export interface CallStructuredRequest {
  temperature?: number;
  timeoutMs?: number | null;
  signal?: AbortSignal;
  responseSchema?: Record<string, unknown>;
  onRetryAttempt?: () => void;
  /**
   * Transport override. Defaults to {@link chatCompletion}. Tests inject a fake
   * so no real request is made; production callers leave it unset.
   */
  chat?: (
    config: LlmProfileConfig,
    messages: ChatMessage[],
    options?: {
      temperature?: number;
      timeoutMs?: number | null;
      signal?: AbortSignal;
      responseSchema?: Record<string, unknown>;
      onRetryAttempt?: () => void;
    },
  ) => Promise<string>;
}

export interface CallStructuredOptions<T> {
  /** Feature-gate key, passed straight to `tryLlmFeature` on the gated path. */
  feature: LlmFeatureKey;
  /**
   * When present, the call is GATED through `tryLlmFeature`. When `undefined`
   * the gate is bypassed and errors propagate to the caller.
   */
  akmConfig?: AkmConfig;
  /** LLM connection/profile config forwarded to `chatCompletion`. */
  config: LlmProfileConfig;
  /** The chat messages to send. */
  messages: ChatMessage[];
  /** Per-call request options (temperature/timeout/signal/schema/retry/chat). */
  request?: CallStructuredRequest;
  /**
   * Owns the raw response: the `!raw` case, JSON extraction, validation, the
   * success-path warns/telemetry, and returns the caller's fallback itself on
   * bad/empty data.
   */
  parse: (raw: string | undefined) => T;
  /**
   * Owns the per-caller error→fallback mapping. Called ONLY on the gated path,
   * with the centralized error class computed once.
   */
  onError: (cls: LlmErrorClass, err: unknown) => T;
  /** Value handed to `tryLlmFeature` as its fallback (disabled/timeout path). */
  fallback: T;
  /** Forwarded to `tryLlmFeature` so callers keep their fallback telemetry. */
  onFallback?: (event: TryLlmFeatureFallbackEvent) => void;
}

export async function callStructured<T>(opts: CallStructuredOptions<T>): Promise<T> {
  const { feature, akmConfig, config, messages, request, parse, onError, fallback, onFallback } = opts;

  const chat = request?.chat ?? chatCompletion;
  const chatOptions = {
    temperature: request?.temperature,
    timeoutMs: request?.timeoutMs,
    signal: request?.signal,
    responseSchema: request?.responseSchema,
    onRetryAttempt: request?.onRetryAttempt,
  };

  // UNGATED: run the chat+parse directly. Errors propagate — no `onError`
  // funnel — matching the pre-gate behaviour of direct callers.
  if (akmConfig === undefined) {
    const raw = await chat(config, messages, chatOptions);
    return parse(raw);
  }

  // GATED: run through `tryLlmFeature`. A throw inside is classified ONCE and
  // routed to `onError`; `tryLlmFeature` returns `fallback` on disablement/timeout.
  return tryLlmFeature(
    feature,
    akmConfig,
    async () => {
      try {
        const raw = await chat(config, messages, chatOptions);
        return parse(raw);
      } catch (err) {
        return onError(classifyLlmError(err), err);
      }
    },
    fallback,
    {
      timeoutMs: request?.timeoutMs,
      onFallback,
    },
  );
}
