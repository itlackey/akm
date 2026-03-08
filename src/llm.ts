import type { LlmConnectionConfig } from "./config"
import type { StashEntry } from "./metadata"

// ── OpenAI-compatible chat completions ──────────────────────────────────────

interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

interface ChatCompletionResponse {
  choices: Array<{ message: { content: string } }>
}

async function chatCompletion(
  config: LlmConnectionConfig,
  messages: ChatMessage[],
): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`
  }

  const response = await fetch(config.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: config.temperature ?? 0.3,
      max_tokens: config.maxTokens ?? 512,
    }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`LLM request failed (${response.status}): ${body}`)
  }

  const json = (await response.json()) as ChatCompletionResponse
  return json.choices?.[0]?.message?.content?.trim() ?? ""
}

// ── Metadata Enhancement ────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a metadata generator for a developer tool registry. Given a tool/skill/command/agent entry, generate improved metadata. Respond with ONLY valid JSON, no markdown fencing.`

/**
 * Use an LLM to enhance a stash entry's metadata: improve description,
 * generate intents, and suggest tags.
 */
export async function enhanceMetadata(
  config: LlmConnectionConfig,
  entry: StashEntry,
  fileContent?: string,
): Promise<{ description?: string; intents?: string[]; tags?: string[] }> {
  const contextParts = [
    `Name: ${entry.name}`,
    `Type: ${entry.type}`,
  ]
  if (entry.description) contextParts.push(`Current description: ${entry.description}`)
  if (entry.tags?.length) contextParts.push(`Current tags: ${entry.tags.join(", ")}`)
  if (fileContent) {
    // Limit content to first 2000 chars to stay within token limits
    const truncated = fileContent.length > 2000
      ? fileContent.slice(0, 2000) + "\n... (truncated)"
      : fileContent
    contextParts.push(`File content:\n${truncated}`)
  }

  const userPrompt = `${contextParts.join("\n")}

Generate improved metadata for this ${entry.type}. Return JSON with these fields:
- "description": a clear, concise one-sentence description of what this does
- "intents": an array of 3-6 natural language task phrases an agent might use to find this (e.g. "deploy a docker container", "run database migrations")
- "tags": an array of 3-8 relevant keyword tags

Return ONLY the JSON object, no explanation.`

  const raw = await chatCompletion(config, [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ])

  try {
    // Strip markdown code fences if present
    const cleaned = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "")
    const parsed = JSON.parse(cleaned) as Record<string, unknown>
    const result: { description?: string; intents?: string[]; tags?: string[] } = {}

    if (typeof parsed.description === "string" && parsed.description) {
      result.description = parsed.description
    }
    if (Array.isArray(parsed.intents)) {
      result.intents = parsed.intents.filter(
        (s): s is string => typeof s === "string" && s.trim().length > 0,
      ).slice(0, 8)
    }
    if (Array.isArray(parsed.tags)) {
      result.tags = parsed.tags.filter(
        (s): s is string => typeof s === "string" && s.trim().length > 0,
      ).slice(0, 10)
    }

    return result
  } catch {
    // LLM returned unparseable output, return empty
    return {}
  }
}

/**
 * Check if the LLM endpoint is reachable.
 */
export async function isLlmAvailable(config: LlmConnectionConfig): Promise<boolean> {
  try {
    const result = await chatCompletion(config, [
      { role: "user", content: "Respond with just the word: ok" },
    ])
    return result.length > 0
  } catch {
    return false
  }
}
