/**
 * LLM-driven metadata enhancement for stash entries.
 *
 * Split out of `llm.ts` so the higher-level workflow (prompting the LLM to
 * improve descriptions/tags/searchHints) lives separately from the low-level
 * transport client in `client.ts`.
 */

import type { LlmConnectionConfig } from "../core/config";
import type { StashEntry } from "../indexer/metadata";
import { chatCompletion, parseJsonResponse } from "./client";

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
