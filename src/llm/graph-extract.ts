/**
 * LLM helper for the `akm index` graph-extraction pass (#207).
 *
 * Given a single asset body (typically a `memory:` or `knowledge:` file),
 * asks the configured LLM to surface the entities mentioned in it and the
 * relations between them. The pass itself
 * (`src/indexer/graph-extraction.ts`) is responsible for deciding which
 * files to extract, persisting the resulting nodes/edges to a stash-local
 * `graph.json` artifact, and feeding the artifact into the FTS5+boosts
 * search pipeline as a single boost component.
 *
 * This module is intentionally tiny and stateless so tests can stub it via
 * `mock.module("../src/llm/graph-extract", ...)` without hitting a network.
 *
 * Locked v1 contract (#208): the LLM connection always comes from the
 * shared `akm.llm` block — never from a per-pass override. Callers obtain
 * the connection via `resolveIndexPassLLM("graph", config)` and pass it
 * straight through.
 */

import { toErrorMessage } from "../core/common";
import type { LlmConnectionConfig } from "../core/config";
import { warn } from "../core/warn";
import { chatCompletion, parseJsonResponse } from "./client";

/** Hard cap on body chars sent to the model. */
const MAX_BODY_CHARS = 4000;

/** Hard cap on entities returned per asset — guards against runaway LLM output. */
const MAX_ENTITIES_PER_ASSET = 32;

/** Hard cap on relations returned per asset. */
const MAX_RELATIONS_PER_ASSET = 32;

/** Hard timeout for the LLM call; an `akm index` run must not hang on a misbehaving endpoint. */
const LLM_TIMEOUT_MS = 30_000;

const SYSTEM_PROMPT =
  "You extract a knowledge graph from developer notes. Return only valid JSON. " + "No prose, no markdown fences.";

const USER_PROMPT_PREFIX = `Extract entities and relations from the asset body below.

Rules:
- Output ONLY a JSON object: {"entities": ["Entity One", ...], "relations": [{"from": "A", "to": "B", "type": "uses"}, ...]}.
- Entities are short, canonical noun phrases (project names, services, tools, people, file/dir names, technical concepts).
- Relations connect two entities that both appear in the entities array.
- "type" is a short verb phrase (e.g. "uses", "depends on", "owns", "documents"). Optional; omit when unsure.
- Drop pleasantries, meta-commentary, and timestamps.
- Limit to at most ${MAX_ENTITIES_PER_ASSET} entities and ${MAX_RELATIONS_PER_ASSET} relations per asset.
- Return {"entities": [], "relations": []} if the body has no extractable graph content.

Asset body:
`;

/** Single edge. `type` is optional — callers tolerate undefined and use "" for grouping. */
export interface GraphRelation {
  from: string;
  to: string;
  type?: string;
}

/** Result returned by {@link extractGraphFromBody}. */
export interface GraphExtraction {
  entities: string[];
  relations: GraphRelation[];
}

/**
 * Extract entities and relations from a single asset body via the configured LLM.
 *
 * Returns `{entities: [], relations: []}` on any failure (timeout, invalid
 * JSON, empty response). Errors are logged via `warn()` but never thrown — a
 * failed extraction for one asset must not abort the rest of the index pass.
 */
export async function extractGraphFromBody(llmConfig: LlmConnectionConfig, body: string): Promise<GraphExtraction> {
  const empty: GraphExtraction = { entities: [], relations: [] };
  const trimmedBody = body.trim();
  if (!trimmedBody) return empty;

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
        { maxTokens: 1024, temperature: 0.1 },
      ),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error("graph extraction timed out")), LLM_TIMEOUT_MS);
      }),
    ]);
    if (!raw) return empty;
    const parsed = parseJsonResponse<{ entities?: unknown; relations?: unknown }>(raw);
    if (!parsed) {
      warn("graph extraction: invalid JSON response from LLM; skipping asset.");
      return empty;
    }

    const entities = Array.isArray(parsed.entities)
      ? parsed.entities
          .filter((e): e is string => typeof e === "string")
          .map((e) => e.trim())
          .filter((e) => e.length > 0)
          .slice(0, MAX_ENTITIES_PER_ASSET)
      : [];

    const entitySet = new Set(entities);
    const relations = Array.isArray(parsed.relations)
      ? parsed.relations
          .filter(
            (r): r is { from: unknown; to: unknown; type?: unknown } =>
              typeof r === "object" && r !== null && !Array.isArray(r),
          )
          .map((r) => ({
            from: typeof r.from === "string" ? r.from.trim() : "",
            to: typeof r.to === "string" ? r.to.trim() : "",
            type: typeof r.type === "string" && r.type.trim() ? r.type.trim() : undefined,
          }))
          // Both endpoints must be non-empty AND mentioned in entities[];
          // dangling relations are noise and inflate the boost component.
          .filter((r) => r.from && r.to && entitySet.has(r.from) && entitySet.has(r.to))
          .slice(0, MAX_RELATIONS_PER_ASSET)
      : [];

    return { entities, relations };
  } catch (err) {
    warn(`graph extraction failed: ${toErrorMessage(err)}`);
    return empty;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}
