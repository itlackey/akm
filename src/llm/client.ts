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
import type { LlmConnectionConfig } from "../core/config";
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
  | "network_error" // fetch failed / timeout
  | "parse_error" // response received but JSON parse failed
  | "timeout"; // request exceeded timeoutMs

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
}

export async function chatCompletion(
  config: LlmConnectionConfig & { supportsJsonSchema?: boolean },
  messages: ChatMessage[],
  options?: ChatCompletionOptions,
): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? config.timeoutMs ?? 120_000;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
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
    if (status >= 500) {
      throw new LlmCallError(
        `LLM provider error (${status}) ${config.endpoint}: ${safeBody}`,
        "provider_error",
        status,
      );
    }
    throw new LlmCallError(`LLM request failed (${status}) ${config.endpoint}: ${safeBody}`, "provider_error", status);
  }

  const json = (await response.json()) as ChatCompletionResponse;
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
