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
import type { AkmConfig, LlmConnectionConfig } from "../core/config";
import { warn } from "../core/warn";
import { chatCompletion, parseEmbeddedJsonResponse } from "./client";
import { type TryLlmFeatureFallbackEvent, tryLlmFeature } from "./feature-gate";
import userPromptTemplate from "./prompts/graph-extract-user-prompt.md" with { type: "text" };

/**
 * Separator token used between assets in a batch prompt.
 * Chosen to be visually clear and unlikely to appear verbatim in asset bodies.
 */
const BATCH_ASSET_SEPARATOR = "=== ASSET";

/** Hard cap on body chars sent to the model. */
const MAX_BODY_CHARS = 4000;

/** Hard cap on entities returned per asset — guards against runaway LLM output. */
const MAX_ENTITIES_PER_ASSET = 32;

/** Hard cap on relations returned per asset. */
const MAX_RELATIONS_PER_ASSET = 32;

const SYSTEM_PROMPT =
  "You extract a knowledge graph from developer notes. Return ONLY valid JSON — no prose, no markdown fences, no preamble.";

const USER_PROMPT_PREFIX = userPromptTemplate
  .replace("{{MAX_ENTITIES}}", String(MAX_ENTITIES_PER_ASSET))
  .replace("{{MAX_RELATIONS}}", String(MAX_RELATIONS_PER_ASSET));

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
 * Build the system prompt for a batched graph-extraction call.
 *
 * The prompt instructs the model to return a JSON array of exactly `count`
 * objects, one per asset, in input order. Index alignment is the critical
 * invariant — if the model drops an asset it still must emit an empty
 * placeholder `{"entities":[],"relations":[]}` at that position.
 *
 * Worked example (3 assets, abbreviated):
 *
 *   Input user message:
 *     Extract entities and relations from the N=3 assets below.
 *     ...rules...
 *     === ASSET 1 ===
 *     ServiceA integrates with ServiceB.
 *     === ASSET 2 ===
 *     Terraform provisions the Prod cluster.
 *     === ASSET 3 ===
 *     No extractable graph content here.
 *
 *   Expected model output (valid JSON array, no prose):
 *     [
 *       {"entities":["ServiceA","ServiceB"],"relations":[{"from":"ServiceA","to":"ServiceB","type":"integrates with"}]},
 *       {"entities":["Terraform","Prod cluster"],"relations":[{"from":"Terraform","to":"Prod cluster","type":"provisions"}]},
 *       {"entities":[],"relations":[]}
 *     ]
 *
 * If the model returns fewer than 3 items (partial failure), the caller
 * (`extractGraphFromBodies`) falls back to individual calls for missing indices.
 */
function buildBatchSystemPrompt(): string {
  return (
    "You extract knowledge graphs from developer notes. " +
    "Return ONLY a valid JSON array — no prose, no markdown fences, no preamble. " +
    "Each element of the array corresponds to one input asset, in order. " +
    "The array length MUST equal the number of assets provided. " +
    'Use {"entities":[],"relations":[]} for assets with no extractable graph content.'
  );
}

function buildBatchUserPrompt(bodies: string[]): string {
  const count = bodies.length;
  const assetBlocks = bodies
    .map((body, i) => `${BATCH_ASSET_SEPARATOR} ${i + 1} ===\n${body.trim().slice(0, MAX_BODY_CHARS)}`)
    .join("\n\n");

  return (
    `Extract entities and relations from the N=${count} assets below.\n\n` +
    `Rules:\n` +
    `- Output ONLY a JSON array of exactly ${count} objects, one per asset, preserving input order.\n` +
    `- Each object: {"entities": ["Entity One", ...], "relations": [{"from": "A", "to": "B", "type": "uses"}, ...]}\n` +
    `- Entities are short, canonical noun phrases (project names, services, tools, people, file/dir names, technical concepts).\n` +
    `- Relations connect two entities that both appear in that asset's entities array.\n` +
    `- "type" is a short verb phrase (e.g. "uses", "depends on", "owns"). Optional; omit when unsure.\n` +
    `- Drop pleasantries, meta-commentary, and timestamps.\n` +
    `- Limit to at most ${MAX_ENTITIES_PER_ASSET} entities and ${MAX_RELATIONS_PER_ASSET} relations per asset.\n` +
    `- Use {"entities":[],"relations":[]} for assets with no extractable graph content.\n` +
    `- The array MUST have exactly ${count} elements — one placeholder per asset even if empty.\n\n` +
    assetBlocks
  );
}

/**
 * Parse and validate a single item from the batch response array.
 * Mirrors the validation logic in `extractGraphFromBody`.
 */
function parseBatchItem(raw: unknown): GraphExtraction {
  const empty: GraphExtraction = { entities: [], relations: [] };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return empty;
  const item = raw as Record<string, unknown>;

  const entities = Array.isArray(item.entities)
    ? item.entities
        .filter((e): e is string => typeof e === "string")
        .map((e) => e.trim())
        .filter((e) => e.length > 0)
        .slice(0, MAX_ENTITIES_PER_ASSET)
    : [];

  const entitySet = new Set(entities);
  const relations = Array.isArray(item.relations)
    ? item.relations
        .filter(
          (r): r is { from: unknown; to: unknown; type?: unknown } =>
            typeof r === "object" && r !== null && !Array.isArray(r),
        )
        .map((r) => ({
          from: typeof r.from === "string" ? r.from.trim() : "",
          to: typeof r.to === "string" ? r.to.trim() : "",
          type: typeof r.type === "string" && r.type.trim() ? r.type.trim() : undefined,
        }))
        .filter((r) => r.from && r.to && entitySet.has(r.from) && entitySet.has(r.to))
        .slice(0, MAX_RELATIONS_PER_ASSET)
    : [];

  return { entities, relations };
}

/**
 * Extract entities and relations from multiple asset bodies in a single LLM
 * call (batched graph extraction).
 *
 * Sends all `bodies` as a single prompt with `=== ASSET N ===` separators
 * and expects a JSON array where element `i` corresponds to `bodies[i]`.
 *
 * **Partial-failure handling**: if the model returns fewer elements than
 * `bodies.length`, missing indices are filled by falling back to individual
 * `extractGraphFromBody` calls — ensuring every input always has a result.
 *
 * Returns an array of the same length as `bodies` (never shorter).
 * Individual elements default to `{entities:[], relations:[]}` on failure.
 *
 * Routes through `tryLlmFeature("graph_extraction", ...)` so the feature gate
 * and onFallback hook are honoured uniformly.
 *
 * @param llmConfig - LLM connection configuration.
 * @param bodies    - Asset body strings to process in one batch.
 * @param signal    - Optional AbortSignal for cancellation.
 * @param akmConfig - Full AKM config (for feature-gate checks).
 * @param onFallback - Optional fallback event sink.
 */
export async function extractGraphFromBodies(
  llmConfig: LlmConnectionConfig,
  bodies: string[],
  signal?: AbortSignal,
  akmConfig?: AkmConfig,
  onFallback?: (evt: TryLlmFeatureFallbackEvent) => void,
): Promise<GraphExtraction[]> {
  const empty = (): GraphExtraction => ({ entities: [], relations: [] });

  // Degenerate case: no bodies → empty array (not an error).
  if (bodies.length === 0) return [];

  // Single body: delegate to the single-asset path for identical behaviour.
  if (bodies.length === 1) {
    const result = await extractGraphFromBody(llmConfig, bodies[0] ?? "", signal, akmConfig, onFallback);
    return [result];
  }

  // Filter out bodies that are empty so we don't waste tokens, but keep
  // index correspondence by tracking which indices were non-empty.
  const results: GraphExtraction[] = bodies.map(empty);
  const nonEmptyIndices: number[] = [];
  const nonEmptyBodies: string[] = [];
  for (let i = 0; i < bodies.length; i++) {
    const trimmed = (bodies[i] ?? "").trim();
    if (trimmed) {
      nonEmptyIndices.push(i);
      nonEmptyBodies.push(trimmed);
    }
  }

  if (nonEmptyBodies.length === 0) return results;

  const systemPrompt = buildBatchSystemPrompt();
  const userPrompt = buildBatchUserPrompt(nonEmptyBodies);

  const batchResult = await tryLlmFeature(
    "graph_extraction",
    akmConfig,
    async () => {
      try {
        const raw = await chatCompletion(
          llmConfig,
          [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          {
            // Allocate more tokens for batch responses: each asset can use up
            // to 1024 tokens, but we cap to avoid runaway output.
            maxTokens: Math.min(nonEmptyBodies.length * 1024, 8192),
            temperature: 0.1,
            timeoutMs: llmConfig.timeoutMs ?? 120_000,
            signal,
          },
        );
        if (!raw) return null;
        const parsed = parseEmbeddedJsonResponse<unknown[]>(raw);
        if (!Array.isArray(parsed)) {
          warn("graph extraction (batch): LLM response was not a JSON array; will fall back per-asset.");
          return null;
        }
        return parsed;
      } catch (err) {
        warn(`graph extraction (batch) failed: ${toErrorMessage(err)}`);
        return null;
      }
    },
    null,
    {
      timeoutMs: llmConfig.timeoutMs ?? 120_000,
      featureGateTimeoutMs: akmConfig?.llm?.featureGateTimeoutMs,
      onFallback,
    },
  );

  // Map successful batch results back to their original indices.
  if (batchResult !== null) {
    for (let j = 0; j < nonEmptyBodies.length; j++) {
      const originalIndex = nonEmptyIndices[j];
      if (originalIndex === undefined) continue;
      if (j < batchResult.length) {
        results[originalIndex] = parseBatchItem(batchResult[j]);
      }
      // j >= batchResult.length → partial failure; handled below.
    }
  }

  // Partial-failure fallback: any non-empty body whose result is still the
  // empty placeholder (either because batchResult was null or the array was
  // shorter than expected) gets an individual retry.
  const fallbackIndices = nonEmptyIndices.filter((_origIdx, j) => {
    // Result is still empty → needs a fallback call.
    if (batchResult === null) return true;
    // batchResult was shorter than the number of non-empty bodies.
    return j >= batchResult.length;
  });

  if (fallbackIndices.length > 0) {
    if (batchResult !== null) {
      // Only warn on partial failure (not when the whole batch failed, which
      // already emitted a warn above).
      warn(
        `graph extraction (batch): response had ${batchResult.length} items for ${nonEmptyBodies.length} assets; ` +
          `falling back to individual calls for ${fallbackIndices.length} missing asset(s).`,
      );
    }
    await Promise.all(
      fallbackIndices.map(async (origIdx) => {
        const body = bodies[origIdx] ?? "";
        results[origIdx] = await extractGraphFromBody(llmConfig, body, signal, akmConfig, onFallback);
      }),
    );
  }

  return results;
}

/**
 * Extract entities and relations from a single asset body via the configured LLM.
 *
 * Returns `{entities: [], relations: []}` on any failure (timeout, invalid
 * JSON, empty response). Errors are logged via `warn()` but never thrown — a
 * failed extraction for one asset must not abort the rest of the index pass.
 *
 * Routes through `tryLlmFeature("graph_extraction", ...)` so the feature gate
 * and onFallback hook are honoured uniformly (Fix C5).
 */
export async function extractGraphFromBody(
  llmConfig: LlmConnectionConfig,
  body: string,
  signal?: AbortSignal,
  akmConfig?: AkmConfig,
  onFallback?: (evt: TryLlmFeatureFallbackEvent) => void,
): Promise<GraphExtraction> {
  const empty: GraphExtraction = { entities: [], relations: [] };
  const trimmedBody = body.trim();
  if (!trimmedBody) return empty;

  const userPrompt = `${USER_PROMPT_PREFIX}${trimmedBody.slice(0, MAX_BODY_CHARS)}`;

  return tryLlmFeature(
    "graph_extraction",
    akmConfig,
    async () => {
      try {
        const raw = await chatCompletion(
          llmConfig,
          [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          // 2048 tokens for a single asset: enough headroom for entities and
          // relations without risking runaway output. Batch calls scale
          // dynamically via Math.min(count * 512, 8192).
          { maxTokens: 2048, temperature: 0.1, timeoutMs: llmConfig.timeoutMs ?? 120_000, signal },
        );
        if (!raw) return empty;
        const parsed = parseEmbeddedJsonResponse<{ entities?: unknown; relations?: unknown }>(raw);
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
      }
    },
    empty,
    {
      timeoutMs: llmConfig.timeoutMs ?? 120_000,
      featureGateTimeoutMs: akmConfig?.llm?.featureGateTimeoutMs,
      onFallback,
    },
  );
}

/**
 * Merge an array of per-asset {@link GraphExtraction} results into a single
 * deduplicated graph.
 *
 * ### Entity deduplication
 * Entities are compared case-insensitively. The canonical form (first-seen
 * casing) is preserved in the output.
 *
 * ### Relation deduplication
 * Relations are keyed on `(from, to, type)` (all lowercased). Only the
 * first-seen occurrence is kept (canonical endpoint casing). After entity
 * deduplication, **dangling relations** — those whose `from` or `to` is not
 * in the deduplicated entity set — are dropped.
 */
export function deduplicateGraph(
  extractions: GraphExtraction[],
  assetRefs?: string[],
): GraphExtraction & { entitySources: Map<string, string[]>; relationSources: Map<string, string[]> } {
  const entityCanonical = new Map<string, string>();
  const entitySources = new Map<string, string[]>();

  for (let i = 0; i < extractions.length; i++) {
    const ref = assetRefs?.[i] ?? "unknown";
    for (const raw of extractions[i].entities) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const normalized = trimmed.toLowerCase();
      if (!entityCanonical.has(normalized)) {
        entityCanonical.set(normalized, trimmed);
        entitySources.set(normalized, [ref]);
      } else {
        const srcs = entitySources.get(normalized);
        if (srcs && !srcs.includes(ref)) srcs.push(ref);
      }
    }
  }

  const entities: string[] = Array.from(entityCanonical.values());
  const entityNormSet = new Set(entityCanonical.keys());
  const relSeenKey = new Map<string, string[]>();
  const relations: GraphRelation[] = [];

  for (let i = 0; i < extractions.length; i++) {
    const ref = assetRefs?.[i] ?? "unknown";
    for (const rel of extractions[i].relations) {
      const fromNorm = rel.from.trim().toLowerCase();
      const toNorm = rel.to.trim().toLowerCase();
      const typeNorm = rel.type?.trim().toLowerCase() ?? "";
      if (!entityNormSet.has(fromNorm) || !entityNormSet.has(toNorm)) continue;
      const key = `${fromNorm}\0${toNorm}\0${typeNorm}`;
      if (!relSeenKey.has(key)) {
        relSeenKey.set(key, [ref]);
        const canonical: GraphRelation = {
          from: entityCanonical.get(fromNorm) ?? rel.from,
          to: entityCanonical.get(toNorm) ?? rel.to,
        };
        if (rel.type?.trim()) canonical.type = rel.type.trim();
        relations.push(canonical);
      } else {
        const srcs = relSeenKey.get(key);
        if (srcs && !srcs.includes(ref)) srcs.push(ref);
      }
    }
  }

  const relationSources = new Map<string, string[]>(relSeenKey);
  return { entities, relations, entitySources, relationSources };
}
