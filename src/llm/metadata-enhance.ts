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
import type { IndexDocument } from "../indexer/passes/metadata";
import { parseJsonResponse } from "./client";
import { callStructured } from "./structured-call";

const SYSTEM_PROMPT = metadataEnhanceSystemPrompt;

export type EnhancedMetadata = { description?: string; searchHints?: string[]; tags?: string[] };

/**
 * Outcome of an enrichment attempt. Distinguishes the three cases the caller
 * MUST treat differently (see `enhanceStashWithLlm`):
 *   - `enriched`: a real LLM response was received and processed. `metadata`
 *     MAY be empty (`{}`) — an empty-but-successful response still counts as
 *     enriched so the caller caches it and avoids re-paying for a known no-op.
 *   - `skipped`: the feature gate was closed — the LLM call never ran.
 *   - `failed`: the call ran and errored (network / provider / timeout).
 * Only `enriched` may mark the entry `quality: "enriched"` and write the LLM
 * cache; `skipped`/`failed` must NOT, so a gated-off or failed call can never
 * poison the cache into a permanent enrichment skip.
 */
export type EnhanceMetadataOutcome =
  | { status: "enriched"; metadata: EnhancedMetadata }
  | { status: "skipped" }
  | { status: "failed"; error?: string };

/**
 * Use an LLM to enhance a stash entry's metadata: improve description,
 * generate searchHints, and suggest tags.
 *
 * When `akmConfig` is provided, routes through
 * `tryLlmFeature("metadata_enhance", ...)` so the feature gate is honoured: a
 * closed gate yields `{ status: "skipped" }` and a thrown/timed-out call yields
 * `{ status: "failed" }` — neither is reported as an enrichment. When
 * `akmConfig` is `undefined` the gate is bypassed entirely — the LLM call runs
 * unconditionally and errors propagate to the caller (pre-gate behaviour, used
 * by direct callers such as tests).
 */
export async function enhanceMetadata(
  config: LlmConnectionConfig,
  entry: IndexDocument,
  fileContent?: string,
  signal?: AbortSignal,
  akmConfig?: AkmConfig,
): Promise<EnhanceMetadataOutcome> {
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

  // `parse` owns the raw response: the `!raw`/unparseable case ⇒ empty metadata
  // (still a genuine success), plus the description/searchHints/tags shaping.
  // `enhanceMetadata` never warns and never bumps telemetry — `onError` (gated
  // path only) reports `failed` WITHOUT warning, carrying the message so the
  // caller can surface it. The ungated path (akmConfig === undefined) propagates
  // errors via callStructured.
  let timedOut = false;
  const outcome = await callStructured<EnhanceMetadataOutcome>({
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
      const metadata: EnhancedMetadata = {};

      if (parsed) {
        if (typeof parsed.description === "string" && parsed.description) {
          metadata.description = parsed.description;
        }
        if (Array.isArray(parsed.searchHints)) {
          metadata.searchHints = parsed.searchHints
            .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
            .slice(0, 8);
        }
        if (Array.isArray(parsed.tags)) {
          metadata.tags = parsed.tags
            .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
            .slice(0, 10);
        }
      }

      return { status: "enriched", metadata };
    },
    onError: (_cls, err) => ({ status: "failed", error: err instanceof Error ? err.message : String(err) }),
    fallback: { status: "skipped" },
    // The seam returns the `skipped` fallback for a closed gate AND for a
    // wrapper-level timeout. Record the timeout so we can reclassify it below —
    // a timed-out call is a failure, not a silent skip.
    onFallback: (event) => {
      if (event.reason === "timeout") timedOut = true;
    },
  });

  if (outcome.status === "skipped" && timedOut) {
    return { status: "failed", error: "metadata_enhance timed out" };
  }
  return outcome;
}
