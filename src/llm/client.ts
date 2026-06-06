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
import { type LlmConnectionConfig, resolveSecret } from "../core/config";
import { escapeJsonStringControls, parseJsonResponse, stripCodeFences, stripThinkBlocks } from "../core/parse";

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
  choices: Array<{
    message: {
      content: string;
      reasoning_content?: string; // thinking models route output here
    };
  }>;
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
}

export async function chatCompletion(
  config: LlmConnectionConfig & { supportsJsonSchema?: boolean },
  messages: ChatMessage[],
  options?: ChatCompletionOptions,
): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? config.timeoutMs ?? 120_000;
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
