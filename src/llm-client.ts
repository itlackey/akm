/**
 * Low-level OpenAI-compatible chat completions client and capability probing.
 *
 * Split out of `llm.ts` to keep the transport-layer concerns (HTTP request,
 * response parsing, JSON-fence stripping, capability probe, availability
 * check) separate from higher-level metadata-enhancement workflows.
 *
 * `llm.ts` re-exports everything from this module for backward compatibility.
 */

import { fetchWithTimeout } from "./common";
import type { LlmConnectionConfig } from "./config";

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

  const response = await fetchWithTimeout(config.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: options?.temperature ?? config.temperature ?? 0.3,
      max_tokens: options?.maxTokens ?? config.maxTokens ?? 512,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`LLM request failed (${response.status}): ${body}`);
  }

  const json = (await response.json()) as ChatCompletionResponse;
  return json.choices?.[0]?.message?.content?.trim() ?? "";
}

/** Strip leading/trailing markdown code fences from an LLM response. */
export function stripJsonFences(raw: string): string {
  return raw
    .trim()
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
