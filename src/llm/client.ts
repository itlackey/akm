// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Low-level OpenAI-compatible chat completions client and capability probing.
 *
 * Keeps transport-layer concerns (HTTP request, response parsing, capability
 * probing, and availability checks) separate from higher-level workflows.
 */

import { fetchWithTimeout, readBodyWithByteCap } from "../core/common";
import { type LlmConnectionConfig, resolveSecret } from "../core/config/config";
import { isApiKeyReference } from "../core/config/schema/primitives";
import { formatExtraParamsIssue, validateExtraParams } from "../core/extra-params";
import { redactErrorBody, redactSensitiveText } from "../core/redaction";
import { warn, warnVerbose } from "../core/warn";
import { DEFAULT_LLM_TIMEOUT_MS } from "../integrations/agent/config";
import { resolveSecretFromStore } from "../sources/snapshot-fetchers/secret-seam";
import {
  emitLlmUsage,
  extractUsageTokens,
  type LlmUsageErrorCode,
  type LlmUsageRecord,
  type RawUsage,
} from "./usage-telemetry";

/** Maximum length of an upstream response excerpt included in thrown errors. */
const ERROR_BODY_MAX_LEN = 200;

/** Stable OpenAI-compatible response-schema name used for every structured call. */
const JSON_SCHEMA_RESPONSE_NAME = "akm_response";

/**
 * Re-exported from src/core/redaction.ts, where it now lives so every HTTP
 * transport can apply the same hardening — the embeddings client needs it too.
 */
export { redactErrorBody } from "../core/redaction";

// ── Typed error class ───────────────────────────────────────────────────────

export type LlmCallErrorCode = Exclude<LlmUsageErrorCode, "unknown_error">;

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

/** Connection fields consumed by the chat transport. */
export type ChatCompletionConfig = LlmConnectionConfig & { supportsJsonSchema?: boolean };

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
  timeoutMs?: number | null;
  /** Optional external abort signal for caller-driven cancellation. */
  signal?: AbortSignal;
  /**
   * JSON Schema for structured output. When provided (and the connection's
   * `supportsJsonSchema` is not explicitly `false`), sends
   * `response_format: { type: "json_schema", json_schema: { name:
   * "akm_response", schema, strict: true } }` on the first attempt. If the
   * provider 4xx's, falls back once to the plain request without it, and
   * remembers that in-memory for the rest of this process — see
   * {@link isJsonSchemaKnownUnsupported}.
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

async function waitForRetry(ms: number, wait: (ms: number) => Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return wait(ms);
  if (signal.aborted) throw new LlmCallError("LLM request aborted", "aborted");
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(new LlmCallError("LLM request aborted", "aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    wait(ms)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Compute a uniform jittered backoff in the [200, 800)ms range. */
function retryBackoffMs(): number {
  return RETRY_BACKOFF_MIN_MS + Math.random() * (RETRY_BACKOFF_MAX_MS - RETRY_BACKOFF_MIN_MS);
}

/**
 * Detect whether an error message indicates a context size exceeded condition.
 * Covers common patterns from OpenAI-compatible APIs (LM Studio, Ollama, etc).
 *
 * Requires BOTH a context keyword AND token-count/overflow evidence so that
 * model prose merely mentioning "context size" / "context length" (e.g. gemma
 * narrating about a document) does not get misclassified as a provider
 * context-limit error (#496).
 *
 * Canonical home: `graph-extract.ts` re-exports this so the index-pass
 * graph extractor and the retry classifier (`isRetryable`) share one
 * definition — retrying a context overflow cannot shrink the input, so it
 * must never be retried.
 */
export function isContextSizeError(message: string): boolean {
  const lower = message.toLowerCase();
  const contextKw = /context (size|length|window)|prompt too long|exceeds.*context/.test(lower);
  if (!contextKw) {
    return false;
  }
  const evidence =
    /\b\d+\s*(token|tokens|tk)\b/.test(lower) ||
    /max(imum)?\s+(context|token|input)/.test(lower) ||
    /exceeded|over.*limit|too.*long/.test(lower);
  return evidence;
}

/**
 * Decide whether a first-attempt {@link LlmCallError} is eligible for a single
 * retry. Retryable: HTTP 5xx (`provider_error` with statusCode >= 500) and
 * `network_error` whose message looks like a transient connection drop.
 * NOT retryable: 4xx, `rate_limited` (429), `timeout`, `parse_error`, and
 * context-overflow-classified errors.
 *
 * The connection-drop heuristic covers the substrings emitted across runtimes
 * for a mid-flight socket close:
 *  - `ECONNRESET` / `EPIPE` — Node/libuv socket reset codes
 *  - `fetch failed` — undici's generic wrapper message
 *  - `socket connection was closed` — Bun's message for a dropped connection
 *    (e.g. "The socket connection was closed unexpectedly.")
 *  - `terminated` / `other side closed` — undici's phrasings for the same
 *
 * These all describe a transient transport failure where a second attempt can
 * legitimately succeed, which is exactly the case a single bounded retry is
 * meant to absorb. Before this list was widened, Bun's "socket connection was
 * closed unexpectedly" fell through unretried and surfaced as a recurring
 * failure in the improve/reflect and capability-probe flows.
 */
function isRetryable(err: LlmCallError): boolean {
  if (isContextSizeError(err.message)) return false;
  if (err.code === "provider_error") {
    return typeof err.statusCode === "number" && err.statusCode >= 500;
  }
  if (err.code === "network_error") {
    const lower = err.message.toLowerCase();
    return (
      lower.includes("econnreset") ||
      lower.includes("epipe") ||
      lower.includes("fetch failed") ||
      lower.includes("socket connection was closed") ||
      lower.includes("terminated") ||
      lower.includes("other side closed")
    );
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

// ── Test seam ────────────────────────────────────────────────────────────────
// Swap-and-restore override. Inert in production; only tests call the setter.
let chatCompletionOverride: typeof chatCompletionReal | undefined;

/** TEST-ONLY. Swap the implementation of `chatCompletion`; pass undefined to restore. */
export function _setChatCompletionForTests(fake?: typeof chatCompletionReal): void {
  chatCompletionOverride = fake;
}

export async function chatCompletion(
  config: ChatCompletionConfig,
  messages: ChatMessage[],
  options?: ChatCompletionInternalOptions,
): Promise<string> {
  if (chatCompletionOverride) return chatCompletionOverride(config, messages, options);
  return chatCompletionReal(config, messages, options);
}

async function chatCompletionReal(
  config: ChatCompletionConfig,
  messages: ChatMessage[],
  options?: ChatCompletionInternalOptions,
): Promise<string> {
  const effectiveTimeoutMs =
    options && Object.hasOwn(options, "timeoutMs")
      ? (options.timeoutMs ?? null)
      : Object.hasOwn(config, "timeoutMs")
        ? (config.timeoutMs ?? null)
        : DEFAULT_LLM_TIMEOUT_MS;

  const started = Date.now();
  try {
    return await chatCompletionAttempt(config, messages, options, effectiveTimeoutMs);
  } catch (err) {
    if (!(err instanceof LlmCallError) || !isRetryable(err)) throw err;

    // Timeout-budget guard: if the first attempt already burned most of the
    // budget, a second attempt cannot complete — skip the retry.
    const elapsed = Date.now() - started;
    const remaining = effectiveTimeoutMs === null ? null : effectiveTimeoutMs - elapsed;
    if (
      effectiveTimeoutMs !== null &&
      (elapsed >= effectiveTimeoutMs * RETRY_BUDGET_FRACTION || (remaining !== null && remaining <= 0))
    ) {
      throw err;
    }

    // Signal the caller so it can bump `retryAttempts` (NOT `failureCount`).
    options?.onRetryAttempt?.();
    // Log the first failure at debug (verbose-only) level; the retry outcome is
    // authoritative.
    warnVerbose(`[akm] LLM transient failure (${err.code}); retrying once: ${err.message}`);

    const wait = retryBackoffMs();
    await waitForRetry(wait, options?.sleep ?? sleep, options?.signal);

    // The retry must not exceed the original budget.
    return await chatCompletionAttempt(config, messages, options, remaining);
  }
}

// ── Structured-output attempt-then-fallback ─────────────────────────────────

/**
 * Connections that have already demonstrated (via a real 4xx response, not a
 * probe) that they reject `response_format: json_schema`. In-memory only,
 * per process, never persisted — the replacement for the old
 * `capabilities.structuredOutput` config cache that `akm setup` wrote once
 * and nothing ever invalidated on a later `akm config set`. Populated the
 * first time a real call proves it, forgotten on the next process start, so
 * a config/endpoint change can never leave a stale verdict in place.
 */
const jsonSchemaUnsupportedConnections = new Set<string>();

function connectionKey(config: LlmConnectionConfig): string {
  return `${config.endpoint}|${config.model}`;
}

/** TEST-ONLY. Clear the in-memory json-schema-support tracker between tests. */
export function _resetJsonSchemaSupportTrackerForTests(): void {
  jsonSchemaUnsupportedConnections.clear();
}

/**
 * Whether this connection has already been proven, this process, not to
 * support `response_format: json_schema`. Callers choosing a prompt-framing
 * strategy up front (e.g. `improve/reflect.ts`'s `outputMode`) can consult
 * this instead of a persisted config flag — it reflects only what a real
 * call this run actually observed.
 */
export function isJsonSchemaKnownUnsupported(config: LlmConnectionConfig): boolean {
  return jsonSchemaUnsupportedConnections.has(connectionKey(config));
}

/**
 * A single chat-completion attempt: one HTTP request/response cycle, with an
 * inline fallback-once when a schema was requested and the provider 4xx's
 * (never retried by the transient-failure policy below, by design — 4xx is
 * a same-request-will-always-fail signal EXCEPT for this one specific,
 * request-shape-dependent case). No cached verdict gates the first attempt:
 * `config.supportsJsonSchema === false` is the only thing that skips it,
 * and that is a value a human (or workflow author) set explicitly, not one
 * a probe wrote automatically.
 */
async function chatCompletionAttempt(
  config: ChatCompletionConfig,
  messages: ChatMessage[],
  options: ChatCompletionOptions | undefined,
  timeoutMs: number | null,
): Promise<string> {
  const wantsSchema =
    Boolean(options?.responseSchema) && config.supportsJsonSchema !== false && !isJsonSchemaKnownUnsupported(config);
  try {
    return await chatCompletionAttemptOnce(config, messages, options, timeoutMs, wantsSchema);
  } catch (err) {
    if (
      !wantsSchema ||
      !(err instanceof LlmCallError) ||
      err.code !== "provider_error" ||
      typeof err.statusCode !== "number" ||
      err.statusCode < 400 ||
      err.statusCode >= 500 ||
      err.statusCode === 429
    ) {
      throw err;
    }
    warnVerbose(
      `[akm] LLM rejected response_format:json_schema (${err.statusCode}); retrying once without it: ${err.message}`,
    );
    const fallback = await chatCompletionAttemptOnce(config, messages, options, timeoutMs, false);
    jsonSchemaUnsupportedConnections.add(connectionKey(config));
    return fallback;
  }
}

async function chatCompletionAttemptOnce(
  config: ChatCompletionConfig,
  messages: ChatMessage[],
  options: ChatCompletionOptions | undefined,
  timeoutMs: number | null,
  includeSchema: boolean,
): Promise<string> {
  if (config.extraParams !== undefined) {
    const issue = validateExtraParams(config.extraParams)[0];
    if (issue) throw new Error(formatExtraParamsIssue("LLM extraParams", issue));
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // Resolve ONLY a whole-string reference ($VAR/${VAR} or secret://<name>).
  // The execution boundary normally hands us a materialized credential after
  // resolving the reference upstream, so re-running the substitution over a
  // literal key mangled any credential containing `$` — `sk-live$ecret` lost
  // everything from the `$` onward, and the request failed with an opaque
  // 401. The narrow check keeps the symbolic form working for any direct
  // caller that still passes one.
  const resolvedKey = isApiKeyReference(config.apiKey ?? "")
    ? resolveSecret(config.apiKey, resolveSecretFromStore)
    : config.apiKey;
  if (resolvedKey) {
    headers.Authorization = `Bearer ${resolvedKey}`;
  }

  // Only include max_tokens when explicitly set. The model/API knows its own
  // limits; a hardcoded default creates silent truncation failures when the
  // guess is wrong. Users who need a cap can set llm.maxTokens in config.
  const resolvedMaxTokens = options?.maxTokens ?? config.maxTokens;
  const responseFormat =
    includeSchema && options?.responseSchema
      ? {
          response_format: {
            type: "json_schema",
            json_schema: { name: JSON_SCHEMA_RESPONSE_NAME, schema: options.responseSchema, strict: true },
          },
        }
      : {};
  // #949: which of these two wire forms a backend honors is a fact about the
  // backend (and any gateway in front of it), not about akm's own `provider`
  // label — a llama.cpp build honors chat_template_kwargs, a bare
  // `enable_thinking` is honored by nothing observed, and a gateway
  // (freellmapi, Bifrost) can drop either one depending on how it was built.
  // Send both whenever thinking is explicitly resolved so the same engine
  // block keeps working across a direct vhost or any gateway in front of it.
  const resolvedEnableThinking = options?.enableThinking ?? config.enableThinking;
  const thinkingParams =
    resolvedEnableThinking === undefined
      ? {}
      : { chat_template_kwargs: { enable_thinking: resolvedEnableThinking }, enable_thinking: resolvedEnableThinking };
  const reasoningEffortParams =
    config.reasoningEffort === undefined ? {} : { reasoning_effort: config.reasoningEffort };

  const requestBody = JSON.stringify({
    model: config.model,
    messages,
    temperature: options?.temperature ?? config.temperature ?? 0.3,
    ...(resolvedMaxTokens !== undefined ? { max_tokens: resolvedMaxTokens } : {}),
    ...config.extraParams,
    ...responseFormat,
    ...thinkingParams,
    ...reasoningEffortParams,
  });

  // Wall-clock start for per-attempt usage telemetry (#576). Captured here so the
  // emitted duration covers the full request/response/parse cycle of a single
  // attempt, not the retry-wrapping `chatCompletion`.
  const requestStartedAt = Date.now();
  const requestDeadlineAt = timeoutMs === null ? null : requestStartedAt + timeoutMs;
  const remainingAttemptMs = (): number | undefined =>
    requestDeadlineAt === null ? undefined : Math.max(0, requestDeadlineAt - Date.now());
  let terminalFields: Pick<
    LlmUsageRecord,
    "model" | "modelSource" | "finishReason" | "promptTokens" | "completionTokens" | "totalTokens" | "reasoningTokens"
  > = {
    model: config.model,
    modelSource: "configured",
  };
  try {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        config.endpoint,
        {
          method: "POST",
          headers,
          body: requestBody,
        },
        timeoutMs,
        options?.signal,
      );
    } catch (err) {
      // fetchWithTimeout throws a plain Error with a message containing
      // "timed out" for AbortController-driven timeouts, or "aborted" for
      // caller-driven cancellations. Map both to typed LlmCallError.
      const msg = err instanceof Error ? err.message : String(err);
      if (options?.signal?.aborted || msg.includes("Request aborted")) {
        throw new LlmCallError("LLM request aborted", "aborted");
      }
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new LlmCallError(`Request timed out${timeoutMs === null ? "" : ` after ${timeoutMs}ms`}`, "timeout");
      }
      if (msg.includes("timed out")) {
        throw new LlmCallError(`Request timed out${timeoutMs === null ? "" : ` after ${timeoutMs}ms`}`, "timeout");
      }
      throw new LlmCallError(`Network error: ${msg}`, "network_error");
    }

    if (!response.ok) {
      const rawBody = await readBodyWithByteCap(response, undefined, {
        ...(requestDeadlineAt === null ? {} : { bodyTimeoutMs: remainingAttemptMs() }),
        signal: options?.signal,
      }).catch((err) => {
        if (options?.signal?.aborted) throw new LlmCallError("LLM response read aborted", "aborted");
        if (err instanceof Error && err.name === "BodyReadTimeoutError") {
          throw new LlmCallError("LLM response body read timed out", "timeout");
        }
        return "";
      });
      const safeBody = redactSensitiveText(redactErrorBody(rawBody), resolvedKey ? [resolvedKey] : []);
      const status = response.status;
      if (status === 429) {
        throw new LlmCallError(
          `LLM request rate limited (429) ${config.endpoint}: ${safeBody}`,
          "rate_limited",
          status,
        );
      }
      if (status >= 500 && isHtmlResponse(rawBody)) {
        throw new LlmCallError(
          `LLM provider returned HTML instead of JSON (${status}) ${config.endpoint}: ${redactSensitiveText(htmlExcerpt(rawBody), resolvedKey ? [resolvedKey] : [])}`,
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
      throw new LlmCallError(
        `LLM request failed (${status}) ${config.endpoint}: ${safeBody}`,
        "provider_error",
        status,
      );
    }

    // A 2xx response is still an error if the body is HTML where JSON was
    // expected (e.g. a provider serving its web UI). Read the raw body first so
    // we can categorize an HTML page distinctly from a malformed-JSON parse_error.
    let rawOkBody: string;
    try {
      rawOkBody = await readBodyWithByteCap(response, undefined, {
        ...(requestDeadlineAt === null ? {} : { bodyTimeoutMs: remainingAttemptMs() }),
        signal: options?.signal,
      });
    } catch (err) {
      if (options?.signal?.aborted) throw new LlmCallError("LLM response read aborted", "aborted");
      if (err instanceof Error && err.name === "BodyReadTimeoutError") {
        throw new LlmCallError("LLM response body read timed out", "timeout");
      }
      throw err;
    }
    if (isHtmlResponse(rawOkBody)) {
      throw new LlmCallError(
        `LLM provider returned HTML instead of JSON (${response.status}) ${config.endpoint}: ${redactSensitiveText(htmlExcerpt(rawOkBody), resolvedKey ? [resolvedKey] : [])}`,
        "provider_html_error",
        response.status,
      );
    }
    let json: ChatCompletionResponse;
    try {
      json = JSON.parse(rawOkBody) as ChatCompletionResponse;
    } catch {
      throw new LlmCallError(
        `LLM response was not valid JSON ${config.endpoint}: ${redactSensitiveText(redactErrorBody(rawOkBody), resolvedKey ? [resolvedKey] : [])}`,
        "parse_error",
        response.status,
      );
    }

    const responseModel = typeof json.model === "string" && json.model.trim().length > 0 ? json.model : undefined;
    terminalFields = {
      model: responseModel ?? config.model,
      modelSource: responseModel === undefined ? "configured" : "response",
      finishReason: typeof json.choices?.[0]?.finish_reason === "string" ? json.choices[0].finish_reason : undefined,
      ...extractUsageTokens(json.usage),
    };
    if (resolvedEnableThinking === false && (terminalFields.reasoningTokens ?? 0) > 0) {
      warn(
        `[akm] LLM returned ${terminalFields.reasoningTokens} reasoning tokens despite enableThinking: false; ` +
          'the provider may not honor that control. Configure reasoningEffort: "none" when the provider supports it.',
      );
    }
    const content = (json.choices?.[0]?.message?.content ?? "").trim();
    const reasoning = (json.choices?.[0]?.message?.reasoning_content ?? "").trim();
    const result = redactSensitiveText(content || reasoning, resolvedKey ? [resolvedKey] : []);
    emitLlmUsage({
      ...terminalFields,
      outcome: "success",
      durationMs: Date.now() - requestStartedAt,
    });
    return result;
  } catch (err) {
    emitLlmUsage({
      ...terminalFields,
      outcome: "error",
      durationMs: Date.now() - requestStartedAt,
      errorCode: err instanceof LlmCallError ? err.code : "unknown_error",
    });
    throw err;
  }
}

// ── Availability check ──────────────────────────────────────────────────────

// ── Reachability probe ──────────────────────────────────────────────────────

/**
 * Best-effort reachability check with an error message, for setup's optional
 * `--probe` connectivity verification. Deliberately does NOT probe or cache
 * `response_format: json_schema` support: that used to be persisted as
 * `capabilities.structuredOutput` and consulted on every later call, so a
 * config edit that changed the endpoint/model left a stale verdict in place
 * with no invalidation, and a stale `true` sent an unsupported request that
 * the retry policy explicitly does not retry (4xx). `chatCompletion` now
 * attempts the schema request fresh every time and falls back once per call
 * on a 4xx — see the in-memory tracker below.
 */
export async function probeLlmReachable(config: LlmConnectionConfig): Promise<{ reachable: boolean; error?: string }> {
  try {
    const raw = await chatCompletion(config, [{ role: "user", content: "Respond with just the word: ok" }], {
      maxTokens: 16,
      temperature: 0,
    });
    return raw.length > 0 ? { reachable: true } : { reachable: false, error: "empty response" };
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Reachability probe for `akm health` (#914): one GET against the
 * OpenAI-compatible `/models` route, bounded by `timeoutMs`. Any HTTP
 * response counts as reachable — the question is whether the endpoint
 * answers, not whether the route exists or the credential is right — so a
 * cold local server is never asked to load a model just to be checked.
 */
export async function probeLlmEndpoint(
  config: LlmConnectionConfig,
  timeoutMs = 3_000,
): Promise<{ reachable: boolean; error?: string }> {
  try {
    await fetch(`${config.endpoint.replace(/\/+$/, "")}/models`, { signal: AbortSignal.timeout(timeoutMs) });
    return { reachable: true };
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Endpoint-keyed probe memoization (#957): every caller that probes several
 * engine connections in one pass (`akm health`'s engine checks, `akm
 * improve --require-engines`) shares one in-flight probe per distinct
 * endpoint (trailing slashes normalized) instead of firing a duplicate probe
 * when two engines point at the same server. `cache` must be scoped to one
 * invocation and never shared across calls — a stale "reachable" surviving
 * past the run that produced it is the failure mode this exists to avoid.
 */
export function probeEndpointOnce<T>(
  connection: LlmConnectionConfig,
  cache: Map<string, Promise<T>>,
  probe: (connection: LlmConnectionConfig) => Promise<T>,
): Promise<T> {
  const key = connection.endpoint.replace(/\/+$/, "");
  let pending = cache.get(key);
  if (!pending) {
    pending = probe(connection);
    cache.set(key, pending);
  }
  return pending;
}
