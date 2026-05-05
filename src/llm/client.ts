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

// ── OpenAI-compatible chat completions ──────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionResponse {
  choices: Array<{ message: { content: string } }>;
}

export interface ChatCompletionOptions {
  /** Override the config's max_tokens for this call (used by ingest/lint which need longer outputs). */
  maxTokens?: number;
  /** Override the config's temperature for this call. */
  temperature?: number;
  /** Optional external abort signal for caller-driven cancellation. */
  signal?: AbortSignal;
}

export async function chatCompletion(
  config: LlmConnectionConfig,
  messages: ChatMessage[],
  options?: ChatCompletionOptions,
): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  const response = await fetchWithTimeout(
    config.endpoint,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: options?.temperature ?? config.temperature ?? 0.3,
        max_tokens: options?.maxTokens ?? config.maxTokens ?? 512,
        ...config.extraParams,
      }),
    },
    30_000,
    options?.signal,
  );

  if (!response.ok) {
    const rawBody = await response.text().catch(() => "");
    const safeBody = redactErrorBody(rawBody);
    throw new Error(`LLM request failed (${response.status}) ${config.endpoint}: ${safeBody}`);
  }

  const json = (await response.json()) as ChatCompletionResponse;
  return json.choices?.[0]?.message?.content?.trim() ?? "";
}

/** Strip leading/trailing markdown code fences from an LLM response. */
export function stripJsonFences(raw: string): string {
  return raw
    .trim()
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
}

/** Parse a possibly-fenced JSON response. Returns undefined if invalid. */
export function parseJsonResponse<T = unknown>(raw: string): T | undefined {
  try {
    return JSON.parse(stripJsonFences(raw)) as T;
  } catch {
    return undefined;
  }
}

/**
 * Best-effort recovery for providers that wrap JSON in extra prose or fenced
 * blocks. Extracts the first balanced top-level object/array and parses it.
 */
export function parseEmbeddedJsonResponse<T = unknown>(raw: string): T | undefined {
  const direct = parseJsonResponse<T>(raw);
  if (direct !== undefined) return direct;

  const text = stripJsonFences(raw);
  let arrayFallback: T | undefined;
  for (let start = 0; start < text.length; start++) {
    const opener = text[start];
    if (opener !== "{" && opener !== "[") continue;

    const closer = opener === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === opener) depth += 1;
      if (ch === closer) {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, i + 1)) as T;
            if (!Array.isArray(parsed)) {
              return parsed;
            }
            arrayFallback ??= parsed;
            break;
          } catch {
            break;
          }
        }
      }
    }
  }
  return arrayFallback;
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
