// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * LLM-driven metadata enhancement for stash entries.
 *
 * Split out of `llm.ts` so the higher-level workflow (prompting the LLM to
 * improve descriptions/tags/searchHints) lives separately from the low-level
 * transport client in `client.ts`.
 */

import metadataEnhanceSystemPrompt from "../assets/prompts/metadata-enhance-system.md" with { type: "text" };
import type { AkmConfig, LlmConnectionConfig } from "../core/config/config";
import type { StashEntry } from "../indexer/passes/metadata";
import { parseJsonResponse } from "./client";
import { callStructured } from "./structured-call";

const SYSTEM_PROMPT = metadataEnhanceSystemPrompt;

export type EnhancedMetadata = { description?: string; searchHints?: string[]; tags?: string[] };

/**
 * Use an LLM to enhance a stash entry's metadata: improve description,
 * generate searchHints, and suggest tags.
 *
 * When `akmConfig` is provided, routes through
 * `tryLlmFeature("metadata_enhance", ...)` so the feature gate is honoured and
 * errors are swallowed to `{}`. When `akmConfig` is `undefined` the gate is
 * bypassed entirely — the LLM call runs unconditionally and errors propagate to
 * the caller (pre-gate behaviour, used by direct callers such as tests).
 */
export async function enhanceMetadata(
  config: LlmConnectionConfig,
  entry: StashEntry,
  fileContent?: string,
  signal?: AbortSignal,
  akmConfig?: AkmConfig,
): Promise<EnhancedMetadata> {
  const contextParts = [`Name: ${entry.name}`, `Type: ${entry.type}`];
  if (entry.description) contextParts.push(`Current description: ${entry.description}`);
  if (entry.tags?.length) contextParts.push(`Current tags: ${entry.tags.join(", ")}`);
  if (fileContent) {
    // Limit content to first 4000 chars to stay within token limits (matches other modules)
    const truncated = fileContent.length > 4000 ? `${fileContent.slice(0, 4000)}\n... (truncated)` : fileContent;
    contextParts.push(`File content:\n${truncated}`);
  }

  const userPrompt = `${contextParts.join("\n")}

Generate improved metadata for this ${entry.type}. Return JSON with these fields:
- "description": a clear, concise one-sentence description of what this does
- "searchHints": an array of 3-6 natural language task phrases an agent might use to find this (e.g. "deploy a docker container", "run database migrations")
- "tags": an array of 3-8 relevant keyword tags

Return ONLY the JSON object, no explanation.`;

  // `parse` owns the raw response: the `!raw`/unparseable case ⇒ `{}`, plus the
  // description/searchHints/tags shaping. `enhanceMetadata` never warns and
  // never bumps telemetry, so `onError` (gated path only) just swallows to `{}`
  // — identical to the surrounding control flow's pre-migration behaviour. The
  // ungated path (akmConfig === undefined) propagates errors via callStructured.
  return callStructured<EnhancedMetadata>({
    feature: "metadata_enhance",
    akmConfig,
    config,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    request: { signal, timeoutMs: config.timeoutMs },
    parse: (raw) => {
      const parsed = raw ? parseJsonResponse<Record<string, unknown>>(raw) : undefined;
      if (!parsed) return {};

      const result: EnhancedMetadata = {};

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
    },
    onError: () => ({}),
    fallback: {},
  });
}
