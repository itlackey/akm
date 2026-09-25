// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `callStructured<T>()` — the shared LLM-call-and-classify seam.
 *
 * Centralizes the scaffold replicated across ~20 in-tree LLM call sites:
 *
 *   tryLlmFeature(feature, akmConfig, …)
 *     -> resolved request -> engine lowering -> direct LLM dispatch
 *     -> classify(error) into one of EXACTLY three buckets
 *          (context_limit | html | other)
 *     -> parse(raw) / onError(cls, err)
 *     -> fallback
 *
 * What this seam OWNS (the dedup):
 *   - the `tryLlmFeature` wrap (gated path) and the gated-vs-ungated branch
 *   - the single resolved/lowered dispatch + request-option marshalling
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

import type { AkmConfig } from "../core/config/config";
import { ConfigError } from "../core/errors";
import type { LoweringNotice, ResolvedConversationMessage } from "../execution/resolved-request";
import type { UnresolvedExecutionDefaults } from "../execution/source";
import { buildExecution, resolveExecution } from "../integrations/agent/execution";
import type { RunnerSpec } from "../integrations/agent/runner";
import { runExecution } from "../integrations/agent/runner-dispatch";
import { type ChatCompletionConfig, type ChatMessage, isContextSizeError, LlmCallError } from "./client";
import {
  isLlmFeatureEnabled,
  type LlmFeatureKey,
  type TryLlmFeatureFallbackEvent,
  tryLlmFeature,
} from "./feature-gate";

/**
 * The three — and only three — error classes the centralized ladder produces.
 * Matches exactly what `classifyLlmError` returns; no speculative 4th variant.
 */
export type LlmErrorClass = "context_limit" | "html" | "other";

export type StructuredLlmRunner = Extract<RunnerSpec, { kind: "llm" }>;

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
 * Per-call request shape. Mirrors the subset of direct-LLM options the
 * structured callers actually use, plus an injectable `chat` seam so tests can
 * replace the transport without a network call. Production transport selection
 * stays inside the engine-owned lowered dispatch seam.
 *
 * KEY-PRESENCE SEMANTICS (`timeoutMs`): both the feature-gate wrapper and the
 * transport are tri-state — an ABSENT `timeoutMs` key means "use the default"
 * (600 s wrapper / config-derived transport timeout), while a PRESENT key set
 * to `undefined`/`null` means "timeout explicitly disabled". `callStructured`
 * therefore forwards each option key only when it is present on `request`
 * (`Object.hasOwn`), so callers that omit the key keep the defaults and
 * callers that set it — even to `undefined` — keep the explicit override.
 */
export interface CallStructuredRequest {
  temperature?: number;
  timeoutMs?: number | null;
  signal?: AbortSignal;
  responseSchema?: Record<string, unknown>;
  /** Hard output-token cap forwarded to the transport as `max_tokens`. */
  maxTokens?: number;
  /** Override the connection's `enableThinking` for this call. */
  enableThinking?: boolean;
  onRetryAttempt?: () => void;
  /**
   * Transport override for tests. Production callers leave it unset.
   */
  chat?: (
    config: ChatCompletionConfig,
    messages: ChatMessage[],
    options?: {
      temperature?: number;
      timeoutMs?: number | null;
      signal?: AbortSignal;
      responseSchema?: Record<string, unknown>;
      maxTokens?: number;
      enableThinking?: boolean;
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
  /**
   * Enablement already resolved by the owning command, forwarded to
   * `tryLlmFeature`. REQUIRED for gated features without a `FEATURE_LOCATION`
   * resolver (`distill`, `memory_consolidation`,
   * `memory_contradiction_detection`, the quality gates): for those keys
   * `isLlmFeatureEnabled` returns `false` unless this override is passed, so
   * omitting it hard-disables the feature. Ignored on the ungated path.
   */
  enabled?: boolean;
  /**
   * Already-resolved symbolic runner. Production callers use this path so
   * authorization precedes credential lookup and aliases are never re-run.
   */
  runner?: StructuredLlmRunner;
  /** Additional exact invocation fields for the current call. */
  current?: UnresolvedExecutionDefaults;
  /** Receives the stable, secret-free notices emitted by the selected lowerer. */
  onNotices?: (notices: readonly Readonly<LoweringNotice>[]) => void;
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

function own(value: object | undefined, key: PropertyKey): boolean {
  return value !== undefined && Object.hasOwn(value, key);
}

/** @internal Exact request-to-cascade projection, exported for presence-semantics contracts. */
export function resolveStructuredCurrent(
  current: UnresolvedExecutionDefaults | undefined,
  request: CallStructuredRequest | undefined,
): UnresolvedExecutionDefaults | undefined {
  const out: Record<string, unknown> = current ? { ...current } : {};
  const requestHasInference =
    own(request, "temperature") || own(request, "maxTokens") || own(request, "enableThinking");
  const baseInference =
    current?.inference && typeof current.inference === "object" && !Array.isArray(current.inference)
      ? { ...current.inference }
      : {};
  const inference: Record<string, unknown> = { ...baseInference };
  if (own(request, "temperature") && request?.temperature !== undefined) inference.temperature = request.temperature;
  if (own(request, "maxTokens") && request?.maxTokens !== undefined) inference.maxTokens = request.maxTokens;
  if (own(request, "enableThinking") && request?.enableThinking !== undefined) {
    inference.enableThinking = request.enableThinking;
  }
  if (Object.keys(inference).length > 0 || requestHasInference) out.inference = inference;
  else if (current?.inference === null) out.inference = null;
  if (own(request, "responseSchema") && request?.responseSchema !== undefined) {
    out.outputSchema = request.responseSchema;
  }
  if (own(request, "timeoutMs")) out.timeout = request?.timeoutMs ?? null;
  return Object.keys(out).length > 0 ? (out as UnresolvedExecutionDefaults) : undefined;
}

function requireTerminalUserMessage(messages: readonly ChatMessage[]): {
  content: string;
  conversation: readonly Readonly<ResolvedConversationMessage>[];
} {
  const terminal = messages.at(-1);
  if (!terminal || terminal.role !== "user") {
    throw new TypeError("callStructured messages must end with the terminal user command");
  }
  return {
    content: terminal.content,
    conversation: messages.slice(0, -1).map((message) => ({ role: message.role, content: message.content })),
  };
}

function dispatchFailure(result: Awaited<ReturnType<typeof runExecution>>): Error {
  const message = result.error ?? result.stderr ?? result.reason ?? "LLM dispatch failed";
  return result.llmErrorCode ? new LlmCallError(message, result.llmErrorCode) : new Error(message);
}

export async function callStructured<T>(opts: CallStructuredOptions<T>): Promise<T> {
  const { feature, akmConfig, enabled, messages, request, parse, onError, fallback, onFallback } = opts;

  // A disabled feature owns a true no-work path: it does not need a runner,
  // messages, authorization, lowering, or provider state. Some commands keep
  // their runner optional precisely because a disabled feature must fall back
  // before execution planning begins.
  if (akmConfig !== undefined && !isLlmFeatureEnabled(akmConfig, feature, enabled)) {
    return tryLlmFeature(feature, akmConfig, async () => fallback, fallback, {
      ...(own(request, "timeoutMs") ? { timeoutMs: request?.timeoutMs } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      onFallback,
    });
  }

  const runner = opts.runner;
  if (!runner) throw new TypeError("callStructured requires a resolved LLM runner");
  const terminal = requireTerminalUserMessage(messages);

  const prepareInvocation = (): (() => Promise<T>) => {
    const current = resolveStructuredCurrent(opts.current, request);
    const prepared = resolveExecution({
      content: terminal.content,
      conversation: terminal.conversation,
      runner,
      ...(current ? { current } : {}),
    });
    const lowered = buildExecution(prepared.request, prepared.runner);
    opts.onNotices?.(lowered.notices);
    return async () => {
      const result = await runExecution(lowered, {
        ...(request?.chat ? { chat: request.chat } : {}),
        ...(request?.onRetryAttempt ? { onRetryAttempt: request.onRetryAttempt } : {}),
        ...(own(request, "signal") ? { runOptions: { signal: request?.signal } } : {}),
      });
      if (!result.ok) throw dispatchFailure(result);
      return parse(result.stdout);
    };
  };

  // UNGATED: run the chat+parse directly. Errors propagate — no `onError`
  // funnel — matching the pre-gate behaviour of direct callers.
  if (akmConfig === undefined) {
    return prepareInvocation()();
  }

  // On an enabled path, preparation/lowering happen OUTSIDE tryLlmFeature so
  // authorization and invalid-config failures remain hard failures instead of
  // being mistaken for provider fallbacks.
  const invoke = prepareInvocation();

  // GATED: run through `tryLlmFeature`. A throw inside is classified ONCE and
  // routed to `onError`; `tryLlmFeature` returns `fallback` on disablement/timeout.
  const outcome = await tryLlmFeature<{ kind: "value"; value: T } | { kind: "config-error"; error: ConfigError }>(
    feature,
    akmConfig,
    async () => {
      try {
        return { kind: "value", value: await invoke() };
      } catch (err) {
        // Credential materialization remains dispatch-owned, so a missing
        // required symbolic credential can surface here. Preserve config
        // failures as hard pre-provider errors instead of sending them through
        // a leaf's provider/runtime fallback policy.
        if (err instanceof ConfigError) return { kind: "config-error", error: err };
        return { kind: "value", value: onError(classifyLlmError(err), err) };
      }
    },
    { kind: "value", value: fallback },
    {
      ...(own(request, "timeoutMs") ? { timeoutMs: request?.timeoutMs } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      onFallback,
    },
  );
  if (outcome.kind === "config-error") throw outcome.error;
  return outcome.value;
}
