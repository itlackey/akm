import { fetchWithTimeout } from "./common";
import type { LlmConnectionConfig } from "./config";
import type { StashEntry } from "./metadata";

// ── OpenAI-compatible chat completions ──────────────────────────────────────

interface ChatMessage {
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
function stripJsonFences(raw: string): string {
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

// ── Metadata Enhancement ────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a metadata generator for a developer asset registry. Given a script/skill/command/agent entry, generate improved metadata. Respond with ONLY valid JSON, no markdown fencing.`;

/**
 * Use an LLM to enhance a stash entry's metadata: improve description,
 * generate searchHints, and suggest tags.
 */
export async function enhanceMetadata(
  config: LlmConnectionConfig,
  entry: StashEntry,
  fileContent?: string,
): Promise<{ description?: string; searchHints?: string[]; tags?: string[] }> {
  const contextParts = [`Name: ${entry.name}`, `Type: ${entry.type}`];
  if (entry.description) contextParts.push(`Current description: ${entry.description}`);
  if (entry.tags?.length) contextParts.push(`Current tags: ${entry.tags.join(", ")}`);
  if (fileContent) {
    // Limit content to first 2000 chars to stay within token limits
    const truncated = fileContent.length > 2000 ? `${fileContent.slice(0, 2000)}\n... (truncated)` : fileContent;
    contextParts.push(`File content:\n${truncated}`);
  }

  const userPrompt = `${contextParts.join("\n")}

Generate improved metadata for this ${entry.type}. Return JSON with these fields:
- "description": a clear, concise one-sentence description of what this does
- "searchHints": an array of 3-6 natural language task phrases an agent might use to find this (e.g. "deploy a docker container", "run database migrations")
- "tags": an array of 3-8 relevant keyword tags

Return ONLY the JSON object, no explanation.`;

  const raw = await chatCompletion(config, [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ]);

  const parsed = parseJsonResponse<Record<string, unknown>>(raw);
  if (!parsed) return {};

  const result: { description?: string; searchHints?: string[]; tags?: string[] } = {};

  if (typeof parsed.description === "string" && parsed.description) {
    result.description = parsed.description;
  }
  if (Array.isArray(parsed.searchHints)) {
    result.searchHints = parsed.searchHints
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .slice(0, 8);
  }
  if (Array.isArray(parsed.tags)) {
    result.tags = parsed.tags.filter((s): s is string => typeof s === "string" && s.trim().length > 0).slice(0, 10);
  }

  return result;
}

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
