// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * LLM helper for the `akm index` memory-inference pass (#201).
 *
 * Compresses a single memory body into one higher-signal derived memory. The
 * pass itself (in `src/indexer/memory-inference.ts`) is responsible for
 * deciding which memories are pending, persisting the derived memory with the
 * correct frontmatter (`inferred: true`, `source: <parent-ref>`), and marking
 * the parent as processed for idempotency.
 *
 * This module is intentionally tiny and stateless so tests can stub it via
 * `mock.module("../src/llm/memory-infer", ...)` without hitting a network.
 *
 * Locked v1 contract (#208): the LLM connection always comes from the
 * selected named LLM engine. Callers obtain
 * the connection via `resolveIndexPassLLM("memory", config)` and pass it
 * straight through.
 */

import memoryInferSystemPrompt from "../assets/prompts/memory-infer-system.md" with { type: "text" };
import memoryInferUserPrompt from "../assets/prompts/memory-infer-user.md" with { type: "text" };
import { toErrorMessage } from "../core/common";
import type { AkmConfig, LlmConnectionConfig, LlmProfileConfig } from "../core/config/config";
import { warn } from "../core/warn";
import { parseEmbeddedJsonResponse } from "./client";
import type { TryLlmFeatureFallbackEvent } from "./feature-gate";
import { callStructured } from "./structured-call";

/** Hard cap on body chars sent to the model — pragmatic and matches `runLlmEnrich`. */
const MAX_BODY_CHARS = 4000;

const SYSTEM_PROMPT = memoryInferSystemPrompt;

const USER_PROMPT_PREFIX = memoryInferUserPrompt;

export interface DerivedMemoryDraft {
  title: string;
  description: string;
  tags: string[];
  searchHints: string[];
  content: string;
}

/**
 * Mutable telemetry sink for the memory-inference pass. `compressMemoryToDerivedMemory`
 * does not carry a telemetry struct of its own, so the caller passes a small
 * sink that the helper bumps when it categorizes a distinct failure class
 * (currently: a provider returning HTML where JSON was expected).
 */
export interface MemoryInferTelemetry {
  /** Calls where the provider returned an HTML body instead of JSON. */
  htmlErrorCount?: number;
}

/**
 * Strict JSON Schema for the derived-memory payload. Sent to providers that
 * opt in via `LlmConnectionConfig.supportsJsonSchema = true`; the client
 * silently drops the schema for providers that don't.
 *
 * Extends the responseSchema lift (PR 1, asset-writers-investigation §5) to
 * the memory-inference path. Mirrors the validation gate below
 * (title/description/content + non-empty tags/searchHints) so a
 * schema-compliant response is guaranteed to pass the downstream check
 * — no more "incomplete derived memory payload from LLM; skipping memory"
 * for shape-only failures.
 */
const DERIVED_MEMORY_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    content: { type: "string", minLength: 1 },
    tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 },
    searchHints: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6 },
  },
  required: ["title", "description", "content", "tags", "searchHints"],
  additionalProperties: false,
} as const;

/**
 * Compress a single memory body into one derived memory via the configured LLM.
 *
 * Returns `undefined` on any failure (timeout, invalid JSON, empty response).
 * Errors are logged via `warn()` but never thrown — a failed split for one memory
 * must not abort the rest of the index pass.
 *
 * Routes through `callStructured({ feature: "memory_inference", ... })` so the
 * feature gate, error classification, and onFallback hook are honoured uniformly
 * (Fix C5).
 */
export async function compressMemoryToDerivedMemory(
  llmConfig: LlmConnectionConfig,
  body: string,
  signal?: AbortSignal,
  akmConfig?: AkmConfig,
  onFallback?: (evt: TryLlmFeatureFallbackEvent) => void,
  telemetry?: MemoryInferTelemetry,
  onRetryAttempt?: () => void,
): Promise<DerivedMemoryDraft | undefined> {
  const trimmedBody = body.trim();
  if (!trimmedBody) return undefined;

  const userPrompt = `${USER_PROMPT_PREFIX}${trimmedBody.slice(0, MAX_BODY_CHARS)}`;

  // Memory-inference is ALWAYS gated: no `akmConfig` ⇒ gate closed (no chat,
  // `disabled` fallback), never the seam's ungated/propagate path (which is for
  // direct callers like `enhanceMetadata`). This is the gate-closed branch
  // `tryLlmFeature(_, undefined, _)` took before the migration.
  if (!akmConfig) {
    onFallback?.({ feature: "memory_inference", reason: "disabled" });
    return undefined;
  }

  return callStructured<DerivedMemoryDraft | undefined>({
    feature: "memory_inference",
    akmConfig,
    config: llmConfig as unknown as LlmProfileConfig,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    request: {
      temperature: 0.1,
      timeoutMs: llmConfig.timeoutMs,
      signal,
      responseSchema: DERIVED_MEMORY_JSON_SCHEMA as unknown as Record<string, unknown>,
      onRetryAttempt,
    },
    parse: (raw) => {
      if (!raw) return undefined;
      const parsed = parseEmbeddedJsonResponse<Record<string, unknown>>(raw);
      if (!parsed) {
        warn("memory inference: invalid JSON response from LLM; skipping memory.");
        return undefined;
      }
      const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
      const description = typeof parsed.description === "string" ? parsed.description.trim() : "";
      const content = typeof parsed.content === "string" ? parsed.content.trim() : "";
      const tags = Array.isArray(parsed.tags)
        ? parsed.tags
            .filter((t): t is string => typeof t === "string")
            .map((t) => t.trim())
            .filter(Boolean)
            .slice(0, 8)
        : [];
      const searchHints = Array.isArray(parsed.searchHints)
        ? parsed.searchHints
            .filter((h): h is string => typeof h === "string")
            .map((h) => h.trim())
            .filter(Boolean)
            .slice(0, 6)
        : [];
      if (!title || !description || !content || tags.length === 0 || searchHints.length === 0) {
        warn("memory inference: incomplete derived memory payload from LLM; skipping memory.");
        return undefined;
      }
      return { title, description, tags, searchHints, content };
    },
    onError: (cls, err) => {
      if (cls === "html") {
        if (telemetry) telemetry.htmlErrorCount = (telemetry.htmlErrorCount ?? 0) + 1;
        warn(`memory inference: provider returned HTML instead of JSON; skipping memory: ${toErrorMessage(err)}`);
        return undefined;
      }
      warn(`memory inference failed: ${toErrorMessage(err)}`);
      return undefined;
    },
    fallback: undefined,
    onFallback,
  });
}
