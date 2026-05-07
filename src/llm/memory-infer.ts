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
 * shared `akm.llm` block — never from a per-pass override. Callers obtain
 * the connection via `resolveIndexPassLLM("memory", config)` and pass it
 * straight through.
 */

import { toErrorMessage } from "../core/common";
import type { LlmConnectionConfig } from "../core/config";
import { warn } from "../core/warn";
import { chatCompletion, parseEmbeddedJsonResponse } from "./client";

/** Hard cap on body chars sent to the model — pragmatic and matches `runLlmEnrich`. */
const MAX_BODY_CHARS = 4000;

/** Hard timeout for the LLM call. The index run must not hang on a misbehaving endpoint. */
const LLM_TIMEOUT_MS = 30_000;

const SYSTEM_PROMPT =
  "You compress a developer memory into one high-signal derived memory for later retrieval. " +
  "Return only valid JSON. No prose outside the JSON object. No markdown fences.";

const USER_PROMPT_PREFIX =
  `Compress the memory below into one concise, information-dense derived memory.

Rules:
- Output ONLY a JSON object with exactly these keys: {"title": string, "description": string, "tags": string[], "searchHints": string[], "content": string}.
- ` +
  '"title"' +
  ` is a short, descriptive title for the derived memory.
- ` +
  '"description"' +
  ` is one sentence explaining why this derived memory matters.
- ` +
  '"tags"' +
  ` contains 3-8 specific keywords.
- ` +
  '"searchHints"' +
  ` contains 3-6 natural-language retrieval phrases.
- ` +
  '"content"' +
  ` must be compact markdown that preserves the reusable insight, root cause, fix, constraints, and applicability conditions when present.
- Prefer 2-4 short sections with informative headings over long prose.
- Omit timestamps, verification-only metrics, pleasantries, and session-specific chatter unless they are essential to applying the insight later.
- Preserve technical specifics (names, versions, identifiers, selectors, file paths, config keys) verbatim.

Memory:
`;

export interface DerivedMemoryDraft {
  title: string;
  description: string;
  tags: string[];
  searchHints: string[];
  content: string;
}

/**
 * Compress a single memory body into one derived memory via the configured LLM.
 *
 * Returns `undefined` on any failure (timeout, invalid JSON, empty response).
 * Errors
 * are logged via `warn()` but never thrown — a failed split for one memory
 * must not abort the rest of the index pass.
 */
export async function compressMemoryToDerivedMemory(
  llmConfig: LlmConnectionConfig,
  body: string,
  signal?: AbortSignal,
): Promise<DerivedMemoryDraft | undefined> {
  const trimmedBody = body.trim();
  if (!trimmedBody) return undefined;

  const userPrompt = `${USER_PROMPT_PREFIX}${trimmedBody.slice(0, MAX_BODY_CHARS)}`;

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      chatCompletion(
        llmConfig,
        [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        { temperature: 0.1, signal },
      ),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error("memory inference timed out")), LLM_TIMEOUT_MS);
      }),
    ]);
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
  } catch (err) {
    warn(`memory inference failed: ${toErrorMessage(err)}`);
    return undefined;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}
