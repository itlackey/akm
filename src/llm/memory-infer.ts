/**
 * LLM helper for the `akm index` memory-inference pass (#201).
 *
 * Splits a single memory body into a list of atomic facts. The pass itself
 * (in `src/indexer/memory-inference.ts`) is responsible for deciding which
 * memories are pending, persisting the resulting atomic memories with the
 * correct frontmatter (`inferred: true`, `source: <parent-ref>`), and
 * marking the parent as processed for idempotency.
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
import { chatCompletion, parseJsonResponse } from "./client";

/** Hard cap on body chars sent to the model — pragmatic and matches `runLlmEnrich`. */
const MAX_BODY_CHARS = 4000;

/** Hard cap on the number of atomic facts returned per memory. */
const MAX_FACTS_PER_MEMORY = 16;

/** Hard timeout for the LLM call. The index run must not hang on a misbehaving endpoint. */
const LLM_TIMEOUT_MS = 30_000;

const SYSTEM_PROMPT =
  "You split a developer memory into atomic, self-contained facts. " +
  "Return only valid JSON. No prose, no markdown fences.";

const USER_PROMPT_PREFIX = `Split the memory below into a JSON array of short, self-contained atomic facts.

Rules:
- Output ONLY a JSON object: {"facts": ["fact one", "fact two", ...]}.
- Each fact is a single complete sentence, decontextualized so it stands alone.
- Drop pleasantries, meta-commentary, and timestamps.
- Preserve technical specifics (names, versions, identifiers) verbatim.
- If the memory is already a single atomic fact, return it as the only entry.
- Limit to at most ${MAX_FACTS_PER_MEMORY} facts.

Memory:
`;

/**
 * Split a single memory body into atomic facts via the configured LLM.
 *
 * Returns `[]` on any failure (timeout, invalid JSON, empty response). Errors
 * are logged via `warn()` but never thrown — a failed split for one memory
 * must not abort the rest of the index pass.
 */
export async function splitMemoryIntoAtomicFacts(llmConfig: LlmConnectionConfig, body: string): Promise<string[]> {
  const trimmedBody = body.trim();
  if (!trimmedBody) return [];

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
        { maxTokens: 768, temperature: 0.1 },
      ),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error("memory inference timed out")), LLM_TIMEOUT_MS);
      }),
    ]);
    if (!raw) return [];
    const parsed = parseJsonResponse<{ facts?: unknown }>(raw);
    if (!parsed || !Array.isArray(parsed.facts)) {
      warn("memory inference: invalid JSON response from LLM; skipping memory.");
      return [];
    }
    const facts = parsed.facts
      .filter((f): f is string => typeof f === "string")
      .map((f) => f.trim())
      .filter((f) => f.length > 0)
      .slice(0, MAX_FACTS_PER_MEMORY);
    return facts;
  } catch (err) {
    warn(`memory inference failed: ${toErrorMessage(err)}`);
    return [];
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}
