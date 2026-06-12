// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Low-level OpenAI-compatible chat completions client and capability probing.
 *
 * Split out of `llm.ts` to keep the transport-layer concerns (HTTP request,
 * response parsing, JSON-fence stripping, capability probe, availability
 * check) separate from higher-level metadata-enhancement workflows.
 *
 * `llm.ts` re-exports everything from this module for backward compatibility.
 */

import { fetchWithTimeout } from "../core/common";
import { type LlmConnectionConfig, resolveSecret } from "../core/config/config";
import { escapeJsonStringControls, parseJsonResponse, stripCodeFences, stripThinkBlocks } from "../core/parse";
import { warnVerbose } from "../core/warn";
import { emitLlmUsage, extractUsageTokens, type RawUsage } from "./usage-telemetry";

// Re-export shared parse utilities so existing importers of `client.ts` continue
// to resolve `parseJsonResponse` and `parseEmbeddedJsonResponse` from this module.
export {
  escapeJsonStringControls,
  parseEmbeddedJsonResponse,
  parseJsonResponse,
  stripCodeFences,
  stripThinkBlocks,
} from "../core/parse";

/** Maximum length of an LLM error response body included in thrown errors. */
const ERROR_BODY_MAX_LEN = 200;

/**
 * Redact credential-shaped substrings from an upstream error body before
 * including it in a thrown Error. The body is also trimmed to a fixed length
 * so that a verbose provider response cannot leak large amounts of context.
 *
 * Targets:
 *  - `Bearer <token>` headers echoed back by the provider
 *  - `sk-…` / `sk_…` style API keys (OpenAI / Anthropic-shaped)
 *  - `key-…` / `key_…` shorthand keys
 *  - `"api_key": "…"` / `"apiKey": "…"` JSON fields
 */
export function redactErrorBody(input: string): string {
  if (!input) return "";
  let out = input
    // Bearer tokens (case-insensitive)
    .replace(/\bBearer\s+[A-Za-z0-9._\-+/=]+/gi, "Bearer [REDACTED]")
    // sk-/sk_ style keys
    .replace(/\bsk[-_][A-Za-z0-9._-]{6,}/g, "[REDACTED]")
    // key-/key_ shorthand keys
    .replace(/\bkey[-_][A-Za-z0-9._-]{6,}/g, "[REDACTED]")
    // JSON-style "api_key": "...", "apiKey": "...", "api-key": "..."
    .replace(/("(?:api[_-]?key|apiKey|authorization|token)"\s*:\s*")([^"]*)(")/gi, "$1[REDACTED]$3");
  if (out.length > ERROR_BODY_MAX_LEN) {
    out = `${out.slice(0, ERROR_BODY_MAX_LEN)}…`;
  }
  return out;
}

// ── Typed error class ───────────────────────────────────────────────────────

export type LlmCallErrorCode =
  | "rate_limited" // HTTP 429
  | "provider_error" // HTTP 5xx
  | "provider_html_error" // body is HTML (e.g. LM Studio web UI) instead of JSON
  | "network_error" // fetch failed / timeout
  | "parse_error" // response received but JSON parse failed
  | "timeout"; // request exceeded timeoutMs

/**
 * Detect a response body that is an HTML document rather than the expected
 * JSON. LM Studio (and similar local providers) can serve their web UI on
 * partial-load / startup failures, producing an HTML page where the OpenAI
 * API contract promises JSON.
 */
function isHtmlResponse(body: string): boolean {
  const lower = body.trimStart().toLowerCase();
  return lower.startsWith("<!doctype html") || lower.startsWith("<html");
}

/**
 * Produce a short plain-text excerpt of an HTML body for inclusion in error
 * messages: strip tags, collapse whitespace, and truncate.
 */
function htmlExcerpt(body: string): string {
  const text = body
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > ERROR_BODY_MAX_LEN ? `${text.slice(0, ERROR_BODY_MAX_LEN)}…` : text;
}

export class LlmCallError extends Error {
  constructor(
    message: string,
    public readonly code: LlmCallErrorCode,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "LlmCallError";
  }
}

// ── OpenAI-compatible chat completions ──────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionResponse {
  /** Model id echoed by the provider; may differ from the requested alias. */
  model?: string;
  choices: Array<{
    message: {
      content: string;
      reasoning_content?: string; // thinking models route output here
    };
    finish_reason?: string;
  }>;
  /** OpenAI-compatible token accounting. Best-effort: providers may omit it. */
  usage?: RawUsage;
}

export interface ChatCompletionOptions {
  /**
   * Override the config's max_tokens for this call. When absent AND
   * `config.maxTokens` is also absent, the field is omitted from the request
   * body entirely — the model/API uses its own default limit. Only set this
   * explicitly when you have a strong reason (e.g. capability probes).
   */
  maxTokens?: number;
  /** Override the config's temperature for this call. */
  temperature?: number;
  /** Override the config timeout for this call. */
  timeoutMs?: number;
  /** Optional external abort signal for caller-driven cancellation. */
  signal?: AbortSignal;
  /**
   * JSON Schema for structured output. When provided AND the connection has
   * `supportsJsonSchema: true`, sends `response_format: { type: "json_schema",
   * json_schema: { schema, strict: true } }`. Otherwise the schema is ignored
   * and callers rely on prompt-contract JSON.
   */
  responseSchema?: Record<string, unknown>;
  /** Override the config's enableThinking for this call. */
  enableThinking?: boolean;
  /**
   * Invoked exactly once when a retryable first failure triggers a single
   * bounded retry. Callers use this to bump their own `retryAttempts`
   * telemetry without touching `failureCount`. Fired regardless of whether
   * the retry ultimately succeeds or fails.
   */
  onRetryAttempt?: () => void;
}

// ── Single bounded retry for transient failures ─────────────────────────────

/** Lower bound of the jittered retry backoff (inclusive), in milliseconds. */
const RETRY_BACKOFF_MIN_MS = 200;
/** Upper bound of the jittered retry backoff (exclusive-ish), in milliseconds. */
const RETRY_BACKOFF_MAX_MS = 800;
/**
 * Fraction of the effective timeout budget that, once consumed by the first
 * attempt, causes the retry to be skipped — there is not enough budget left
 * for a meaningful second attempt.
 */
const RETRY_BUDGET_FRACTION = 0.9;

/**
 * Sleep for `ms` milliseconds. Extracted as a named helper so tests can stub
 * the backoff via the internal `sleep` option on {@link chatCompletion} and
 * avoid real delays.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Compute a uniform jittered backoff in the [200, 800)ms range. */
function retryBackoffMs(): number {
  return RETRY_BACKOFF_MIN_MS + Math.random() * (RETRY_BACKOFF_MAX_MS - RETRY_BACKOFF_MIN_MS);
}

/**
 * Detect whether an error message indicates a context-size-exceeded condition.
 * Mirrors the heuristic in `graph-extract.ts` — retrying a context overflow
 * cannot shrink the input, so it must not be retried.
 */
function looksLikeContextOverflow(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("context") &&
    (lower.includes("context size") ||
      lower.includes("context length") ||
      lower.includes("context_window") ||
      lower.includes("prompt too long") ||
      lower.includes("exceeds"))
  );
}

/**
 * Decide whether a first-attempt {@link LlmCallError} is eligible for a single
 * retry. Retryable: HTTP 5xx (`provider_error` with statusCode >= 500) and
 * `network_error` whose message looks like a transient connection reset
 * (ECONNRESET / EPIPE / "fetch failed"). NOT retryable: 4xx, `rate_limited`
 * (429), `timeout`, `parse_error`, and context-overflow-classified errors.
 */
function isRetryable(err: LlmCallError): boolean {
  if (looksLikeContextOverflow(err.message)) return false;
  if (err.code === "provider_error") {
    return typeof err.statusCode === "number" && err.statusCode >= 500;
  }
  if (err.code === "network_error") {
    const lower = err.message.toLowerCase();
    return lower.includes("econnreset") || lower.includes("epipe") || lower.includes("fetch failed");
  }
  return false;
}

/**
 * Internal options for {@link chatCompletion} not exposed on the public
 * {@link ChatCompletionOptions}. Tests inject a fast `sleep` so the retry
 * backoff does not actually delay the suite.
 */
interface ChatCompletionInternalOptions extends ChatCompletionOptions {
  /** Override the backoff sleep (defaults to the real {@link sleep}). */
  sleep?: (ms: number) => Promise<void>;
}

export async function chatCompletion(
  config: LlmConnectionConfig & { supportsJsonSchema?: boolean },
  messages: ChatMessage[],
  options?: ChatCompletionInternalOptions,
): Promise<string> {
  const effectiveTimeoutMs = options?.timeoutMs ?? config.timeoutMs ?? 120_000;

  const started = Date.now();
  try {
    return await chatCompletionAttempt(config, messages, options, effectiveTimeoutMs);
  } catch (err) {
    if (!(err instanceof LlmCallError) || !isRetryable(err)) throw err;

    // Timeout-budget guard: if the first attempt already burned most of the
    // budget, a second attempt cannot complete — skip the retry.
    const elapsed = Date.now() - started;
    const remaining = effectiveTimeoutMs - elapsed;
    if (elapsed >= effectiveTimeoutMs * RETRY_BUDGET_FRACTION || remaining <= 0) {
      throw err;
    }

    // Signal the caller so it can bump `retryAttempts` (NOT `failureCount`).
    options?.onRetryAttempt?.();
    // Log the first failure at debug (verbose-only) level; the retry outcome is
    // authoritative.
    warnVerbose(`[akm] LLM transient failure (${err.code}); retrying once: ${err.message}`);

    const wait = retryBackoffMs();
    await (options?.sleep ?? sleep)(wait);

    // The retry must not exceed the original budget.
    return await chatCompletionAttempt(config, messages, options, remaining);
  }
}

/**
 * A single chat-completion attempt: one HTTP request/response cycle with no
 * retry. {@link chatCompletion} wraps this with a single bounded retry for
 * transient failures.
 */
async function chatCompletionAttempt(
  config: LlmConnectionConfig & { supportsJsonSchema?: boolean },
  messages: ChatMessage[],
  options: ChatCompletionOptions | undefined,
  timeoutMs: number,
): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const resolvedKey = resolveSecret(config.apiKey);
  if (resolvedKey) {
    headers.Authorization = `Bearer ${resolvedKey}`;
  }

  // Only include max_tokens when explicitly set. The model/API knows its own
  // limits; a hardcoded default creates silent truncation failures when the
  // guess is wrong. Users who need a cap can set llm.maxTokens in config.
  const resolvedMaxTokens = options?.maxTokens ?? config.maxTokens;
  const responseFormat =
    options?.responseSchema && config.supportsJsonSchema
      ? { response_format: { type: "json_schema", json_schema: { schema: options.responseSchema, strict: true } } }
      : {};

  // Wall-clock start for per-call usage telemetry (#576). Captured here so the
  // emitted duration covers the full request/response/parse cycle of a single
  // attempt, not the retry-wrapping `chatCompletion`.
  const requestStartedAt = Date.now();

  let response: Response;
  try {
    response = await fetchWithTimeout(
      config.endpoint,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: options?.temperature ?? config.temperature ?? 0.3,
          ...(resolvedMaxTokens !== undefined ? { max_tokens: resolvedMaxTokens } : {}),
          ...responseFormat,
          ...(options?.enableThinking !== undefined
            ? { enable_thinking: options.enableThinking }
            : config.enableThinking !== undefined
              ? { enable_thinking: config.enableThinking }
              : {}),
          ...config.extraParams,
        }),
      },
      timeoutMs,
      options?.signal,
    );
  } catch (err) {
    // fetchWithTimeout throws a plain Error with a message containing
    // "timed out" for AbortController-driven timeouts, or "aborted" for
    // caller-driven cancellations. Map both to typed LlmCallError.
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new LlmCallError(`Request timed out after ${timeoutMs}ms`, "timeout");
    }
    if (msg.includes("timed out")) {
      throw new LlmCallError(`Request timed out after ${timeoutMs}ms`, "timeout");
    }
    throw new LlmCallError(`Network error: ${msg}`, "network_error");
  }

  if (!response.ok) {
    const rawBody = await response.text().catch(() => "");
    const safeBody = redactErrorBody(rawBody);
    const status = response.status;
    if (status === 429) {
      throw new LlmCallError(`LLM request rate limited (429) ${config.endpoint}: ${safeBody}`, "rate_limited", status);
    }
    if (status >= 500 && isHtmlResponse(rawBody)) {
      throw new LlmCallError(
        `LLM provider returned HTML instead of JSON (${status}) ${config.endpoint}: ${htmlExcerpt(rawBody)}`,
        "provider_html_error",
        status,
      );
    }
    if (status >= 500) {
      throw new LlmCallError(
        `LLM provider error (${status}) ${config.endpoint}: ${safeBody}`,
        "provider_error",
        status,
      );
    }
    throw new LlmCallError(`LLM request failed (${status}) ${config.endpoint}: ${safeBody}`, "provider_error", status);
  }

  // A 2xx response is still an error if the body is HTML where JSON was
  // expected (e.g. a provider serving its web UI). Read the raw body first so
  // we can categorize an HTML page distinctly from a malformed-JSON parse_error.
  const rawOkBody = await response.text();
  if (isHtmlResponse(rawOkBody)) {
    throw new LlmCallError(
      `LLM provider returned HTML instead of JSON (${response.status}) ${config.endpoint}: ${htmlExcerpt(rawOkBody)}`,
      "provider_html_error",
      response.status,
    );
  }
  let json: ChatCompletionResponse;
  try {
    json = JSON.parse(rawOkBody) as ChatCompletionResponse;
  } catch {
    throw new LlmCallError(
      `LLM response was not valid JSON ${config.endpoint}: ${redactErrorBody(rawOkBody)}`,
      "parse_error",
      response.status,
    );
  }
  // Per-call usage telemetry (#576). Best-effort and fully isolated: a missing
  // or garbled usage block still records duration + model, and a throwing sink
  // can never fail the call (emitLlmUsage swallows its own errors). The stage
  // is supplied ambiently by emitLlmUsage; no `stage` param is threaded here.
  emitLlmUsage({
    model: typeof json.model === "string" && json.model ? json.model : config.model,
    durationMs: Date.now() - requestStartedAt,
    finishReason: typeof json.choices?.[0]?.finish_reason === "string" ? json.choices[0].finish_reason : undefined,
    ...extractUsageTokens(json.usage),
  });

  const content = (json.choices?.[0]?.message?.content ?? "").trim();
  const reasoning = (json.choices?.[0]?.message?.reasoning_content ?? "").trim();
  return content || reasoning;
}

/**
 * Strip `<think>` blocks, code fences, and escape control characters in JSON
 * strings. Thin wrapper kept for backward compatibility with call sites that
 * import `stripJsonFences` from this module. New code should prefer the
 * granular helpers from `../core/parse`.
 */
export function stripJsonFences(raw: string): string {
  return escapeJsonStringControls(stripCodeFences(stripThinkBlocks(raw)));
}

// ── Availability check ──────────────────────────────────────────────────────

/**
 * Check if the LLM endpoint is reachable.
 */
export async function isLlmAvailable(config: LlmConnectionConfig): Promise<boolean> {
  try {
    const result = await chatCompletion(config, [{ role: "user", content: "Respond with just the word: ok" }]);
    return result.length > 0;
  } catch {
    return false;
  }
}

// ── Capability probe ────────────────────────────────────────────────────────

/**
 * Ask the model to emit a strict JSON object so we know whether the knowledge
 * wiki ingest/lint flows can rely on structured output. Failure is non-fatal —
 * the caller can fall back to assist-only mode.
 */
export async function probeLlmCapabilities(
  config: LlmConnectionConfig,
): Promise<{ reachable: boolean; structuredOutput: boolean; error?: string }> {
  try {
    const raw = await chatCompletion(
      config,
      [
        {
          role: "system",
          content: "You return only valid JSON. No prose, no markdown fences.",
        },
        {
          role: "user",
          content: 'Return exactly this JSON object and nothing else: {"ok": true, "ingest": true, "lint": true}',
        },
      ],
      { maxTokens: 64, temperature: 0 },
    );
    if (!raw) return { reachable: false, structuredOutput: false, error: "empty response" };
    const parsed = parseJsonResponse<{ ok?: unknown }>(raw);
    return {
      reachable: true,
      structuredOutput: Boolean(parsed && parsed.ok === true),
    };
  } catch (err) {
    return { reachable: false, structuredOutput: false, error: err instanceof Error ? err.message : String(err) };
  }
}
