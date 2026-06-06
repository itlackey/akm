// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * LLM helper for the `akm index` graph-extraction pass (#207).
 *
 * Given a single asset body (typically a `memory:` or `knowledge:` file),
 * asks the configured LLM to surface the entities mentioned in it and the
 * relations between them. The pass itself
 * (`src/indexer/graph-extraction.ts`) is responsible for deciding which
 * files to extract, persisting the resulting nodes/edges to the index DB,
 * and feeding the graph data into the FTS5+boosts
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

import userPromptTemplate from "../assets/prompts/graph-extract-user-prompt.md" with { type: "text" };
import { toErrorMessage } from "../core/common";
import type { AkmConfig, LlmConnectionConfig } from "../core/config";
import { warn, warnVerbose } from "../core/warn";
import { chatCompletion, parseEmbeddedJsonResponse } from "./client";
import { type TryLlmFeatureFallbackEvent, tryLlmFeature } from "./feature-gate";

/**
 * Separator token used between assets in a batch prompt.
 * Chosen to be visually clear and unlikely to appear verbatim in asset bodies.
 */
const BATCH_ASSET_SEPARATOR = "=== ASSET";

export const GRAPH_EXTRACT_PROMPT_VERSION = "v2";

/** Asset bodies longer than this are chunked instead of truncated. */
const MAX_CHUNK_BODY_CHARS = 1600;

/** Bodies longer than this are excluded from multi-asset batch prompts. */
const MAX_BATCH_BODY_CHARS = 1600;

const MIN_RELATION_CONFIDENCE = 0.5;
const NON_ARRAY_BATCH_DISABLE_THRESHOLD = 2;

/** Hard cap on entities returned per asset — guards against runaway LLM output. */
const MAX_ENTITIES_PER_ASSET = 32;

/** Hard cap on relations returned per asset. */
const MAX_RELATIONS_PER_ASSET = 32;

const SYSTEM_PROMPT =
  "You extract a knowledge graph from developer notes. Return ONLY valid JSON — no prose, no markdown fences, no preamble.";

const USER_PROMPT_PREFIX = userPromptTemplate
  .replace("{{MAX_ENTITIES}}", String(MAX_ENTITIES_PER_ASSET))
  .replace("{{MAX_RELATIONS}}", String(MAX_RELATIONS_PER_ASSET));

/**
 * Detect whether an error message indicates a context size exceeded condition.
 * Covers common patterns from OpenAI-compatible APIs (LM Studio, Ollama, etc).
 *
 * Requires BOTH a context keyword AND token-count/overflow evidence so that
 * model prose merely mentioning "context size" / "context length" (e.g. gemma
 * narrating about a document) does not get misclassified as a provider
 * context-limit error (#496).
 */
export function isContextSizeError(message: string): boolean {
  const lower = message.toLowerCase();
  const contextKw = /context (size|length|window)|prompt too long|exceeds.*context/.test(lower);
  if (!contextKw) {
    return false;
  }
  const evidence =
    /\b\d+\s*(token|tokens|tk)\b/.test(lower) ||
    /max(imum)?\s+(context|token|input)/.test(lower) ||
    /exceeded|over.*limit|too.*long/.test(lower);
  return evidence;
}

/** Single edge. `type` is optional — callers tolerate undefined and use "" for grouping. */
export interface GraphRelation {
  from: string;
  to: string;
  type?: string;
  confidence?: number;
}

/** Result returned by {@link extractGraphFromBody}. */
export interface GraphExtraction {
  entities: string[];
  relations: GraphRelation[];
  confidence?: number;
  status?: GraphExtractionStatus;
  reason?: GraphExtractionReason;
  chunkCount?: number;
  truncationCount?: number;
  filteredGenericEntities?: number;
  filteredInvalidRelations?: number;
  filteredLowConfidenceRelations?: number;
}

export type GraphExtractionStatus = "extracted" | "empty" | "failed";

export type GraphExtractionReason =
  | "none"
  | "no_graph_content"
  | "invalid_json"
  | "context_limit"
  | "llm_error"
  | "low_confidence"
  | "generic_entities_only"
  | "filtered_low_quality";

export interface GraphBatchState {
  batchingDisabled: boolean;
  nonArrayBatchFailures: number;
}

export interface GraphRuntimeTelemetry {
  truncationCount?: number;
  failureCount?: number;
  filteredGenericEntities?: number;
  filteredInvalidRelations?: number;
  filteredLowConfidenceRelations?: number;
  contextBatchRetries?: number;
  nonArrayBatchFailures?: number;
}

export interface GraphExtractionRuntimeOptions {
  batchState?: GraphBatchState;
  telemetry?: GraphRuntimeTelemetry;
}

const GENERIC_ENTITIES = new Set([
  "agent",
  "application",
  "assistant",
  "code",
  "content",
  "data",
  "developer",
  "document",
  "file",
  "knowledge",
  "memory",
  "note",
  "notes",
  "project",
  "service",
  "system",
  "task",
  "team",
  "text",
  "thing",
  "user",
]);

const GENERIC_RELATION_TYPES = new Set(["has", "is", "mentions", "references", "related to"]);

function parseConfidence(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return Math.max(0, Math.min(1, raw));
}

function normalizeEntityName(raw: string): string {
  return raw
    .trim()
    .replace(/^[`"']+|[`"']+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[;,!?]+$/g, "")
    .trim();
}

function normalizeRelationType(raw: string): string | undefined {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^[`"']+|[`"']+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.;,!?]+$/g, "")
    .trim();
  if (!normalized) return undefined;
  if (normalized === "use" || normalized === "utilizes") return "uses";
  if (normalized === "depend on" || normalized === "depends") return "depends on";
  if (normalized === "integrates" || normalized === "integration with") return "integrates with";
  return normalized;
}

function normalizeEntityKey(raw: string): string {
  return normalizeEntityName(raw).toLowerCase();
}

function bumpTelemetry(
  telemetry: GraphRuntimeTelemetry | undefined,
  key: keyof GraphRuntimeTelemetry,
  amount = 1,
): void {
  if (!telemetry) return;
  telemetry[key] = (telemetry[key] ?? 0) + amount;
}

function normalizeBatchState(state?: GraphBatchState): GraphBatchState | undefined {
  if (!state) return undefined;
  state.batchingDisabled = state.batchingDisabled === true;
  state.nonArrayBatchFailures = Math.max(0, state.nonArrayBatchFailures ?? 0);
  return state;
}

function splitParagraph(text: string, maxChars: number): { chunks: string[]; truncationCount: number } {
  if (text.length <= maxChars) return { chunks: [text], truncationCount: 0 };
  const chunks: string[] = [];
  let truncationCount = 0;
  let remaining = text;
  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf(" ", maxChars);
    if (splitAt < Math.floor(maxChars * 0.6)) splitAt = maxChars;
    const piece = remaining.slice(0, splitAt).trim();
    if (piece) chunks.push(piece);
    remaining = remaining.slice(splitAt).trim();
    truncationCount += 1;
  }
  if (remaining) chunks.push(remaining);
  return { chunks, truncationCount };
}

function splitBodyIntoChunks(
  body: string,
  maxChars = MAX_CHUNK_BODY_CHARS,
): { chunks: string[]; truncationCount: number } {
  const sections = body
    .split(/\n(?=#{1,6}\s)/)
    .map((section) => section.trim())
    .filter(Boolean);
  if (sections.length === 0) return { chunks: [body.trim()].filter(Boolean), truncationCount: 0 };

  const chunks: string[] = [];
  let current = "";
  let truncationCount = 0;

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) chunks.push(trimmed);
    current = "";
  };

  for (const section of sections) {
    if (section.length <= maxChars) {
      const candidate = current ? `${current}\n\n${section}` : section;
      if (candidate.length <= maxChars) current = candidate;
      else {
        flush();
        current = section;
      }
      continue;
    }

    const paragraphs = section
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .filter(Boolean);
    for (const paragraph of paragraphs) {
      if (paragraph.length <= maxChars) {
        const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
        if (candidate.length <= maxChars) current = candidate;
        else {
          flush();
          current = paragraph;
        }
        continue;
      }
      flush();
      const split = splitParagraph(paragraph, maxChars);
      truncationCount += split.truncationCount;
      for (const piece of split.chunks) {
        if (piece.length <= maxChars) chunks.push(piece);
      }
    }
  }

  flush();
  return { chunks, truncationCount };
}

/** Consistency weight for blending chunk-agreement with LLM confidence. */
const CONSISTENCY_WEIGHT = 0.4;

function mergeGraphExtractions(extractions: GraphExtraction[]): GraphExtraction {
  const totalChunks = extractions.length;
  const entityCanonical = new Map<string, string>();
  const entityChunkCounts = new Map<string, number>();
  const relationByKey = new Map<string, GraphRelation>();
  const relationChunkCounts = new Map<string, number>();
  let confidence: number | undefined;
  let truncationCount = 0;
  let filteredGenericEntities = 0;
  let filteredInvalidRelations = 0;
  let filteredLowConfidenceRelations = 0;
  let firstFailureReason: GraphExtractionReason | undefined;

  for (const extraction of extractions) {
    truncationCount += extraction.truncationCount ?? 0;
    filteredGenericEntities += extraction.filteredGenericEntities ?? 0;
    filteredInvalidRelations += extraction.filteredInvalidRelations ?? 0;
    filteredLowConfidenceRelations += extraction.filteredLowConfidenceRelations ?? 0;
    if (extraction.status === "failed" && !firstFailureReason) firstFailureReason = extraction.reason;
    const nextConfidence = parseConfidence(extraction.confidence);
    if (nextConfidence !== undefined)
      confidence = confidence === undefined ? nextConfidence : Math.max(confidence, nextConfidence);
    for (const entity of extraction.entities) {
      const key = normalizeEntityKey(entity);
      if (!key) continue;
      if (!entityCanonical.has(key)) entityCanonical.set(key, entity);
      entityChunkCounts.set(key, (entityChunkCounts.get(key) ?? 0) + 1);
    }
  }

  for (const extraction of extractions) {
    for (const relation of extraction.relations) {
      const fromKey = normalizeEntityKey(relation.from);
      const toKey = normalizeEntityKey(relation.to);
      const type = normalizeRelationType(relation.type ?? "");
      if (!fromKey || !toKey || !type) continue;
      const from = entityCanonical.get(fromKey);
      const to = entityCanonical.get(toKey);
      if (!from || !to) continue;
      const key = `${fromKey}\u0000${toKey}\u0000${type}`;
      if (!relationByKey.has(key)) {
        relationByKey.set(key, {
          from,
          to,
          type,
        });
        relationChunkCounts.set(key, 0);
      }
      relationChunkCounts.set(key, (relationChunkCounts.get(key) ?? 0) + 1);
      const nextConfidence = parseConfidence(relation.confidence);
      const existing = relationByKey.get(key);
      if (existing && nextConfidence !== undefined) {
        const current = parseConfidence(existing.confidence) ?? 0;
        if (nextConfidence > current) existing.confidence = nextConfidence;
      }
    }
  }

  function blendConsistency(llmConfidence: number | undefined, chunkCount: number): number {
    const consistency = totalChunks > 1 ? chunkCount / totalChunks : 1;
    if (llmConfidence === undefined) return consistency;
    return (1 - CONSISTENCY_WEIGHT) * llmConfidence + CONSISTENCY_WEIGHT * consistency;
  }

  const entities = [...entityCanonical.values()].slice(0, MAX_ENTITIES_PER_ASSET);
  const relations = [...relationByKey.values()].slice(0, MAX_RELATIONS_PER_ASSET);

  for (const relation of relations) {
    const fromKey = normalizeEntityKey(relation.from);
    const toKey = normalizeEntityKey(relation.to);
    const type = normalizeRelationType(relation.type ?? "");
    if (!fromKey || !toKey || !type) continue;
    const key = `${fromKey}\u0000${toKey}\u0000${type}`;
    const chunkCount = relationChunkCounts.get(key) ?? 1;
    relation.confidence = blendConsistency(relation.confidence, chunkCount);
  }

  const status: GraphExtractionStatus = entities.length > 0 ? "extracted" : firstFailureReason ? "failed" : "empty";
  const reason: GraphExtractionReason = status === "extracted" ? "none" : (firstFailureReason ?? "no_graph_content");
  const mergedConfidence =
    confidence !== undefined ? blendConsistency(confidence, totalChunks) : totalChunks > 1 ? 1 : undefined;

  return {
    entities,
    relations,
    ...(mergedConfidence !== undefined ? { confidence: mergedConfidence } : {}),
    status,
    reason,
    chunkCount: extractions.length,
    truncationCount,
    filteredGenericEntities,
    filteredInvalidRelations,
    filteredLowConfidenceRelations,
  };
}

function parseGraphExtraction(raw: unknown): GraphExtraction {
  const empty = (reason: GraphExtractionReason = "no_graph_content"): GraphExtraction => ({
    entities: [],
    relations: [],
    status: reason === "llm_error" || reason === "invalid_json" || reason === "context_limit" ? "failed" : "empty",
    reason,
  });
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return empty();
  const item = raw as Record<string, unknown>;

  const extractionConfidence = parseConfidence(item.confidence);

  const entityCanonical = new Map<string, string>();
  let filteredGenericEntities = 0;
  if (Array.isArray(item.entities)) {
    for (const value of item.entities) {
      if (typeof value !== "string") continue;
      const normalized = normalizeEntityName(value);
      if (!normalized) continue;
      const normalizedKey = normalized.toLowerCase();
      if (!/[a-z0-9]/i.test(normalized) || GENERIC_ENTITIES.has(normalizedKey)) {
        filteredGenericEntities += 1;
        continue;
      }
      const key = normalized.toLowerCase();
      if (!entityCanonical.has(key)) entityCanonical.set(key, normalized);
      if (entityCanonical.size >= MAX_ENTITIES_PER_ASSET) break;
    }
  }
  const entities = Array.from(entityCanonical.values());

  const relations: GraphRelation[] = [];
  let filteredInvalidRelations = 0;
  let filteredLowConfidenceRelations = 0;
  if (Array.isArray(item.relations)) {
    for (const relation of item.relations) {
      if (typeof relation !== "object" || relation === null || Array.isArray(relation)) {
        filteredInvalidRelations += 1;
        continue;
      }
      const rel = relation as Record<string, unknown>;
      const fromRaw = typeof rel.from === "string" ? normalizeEntityName(rel.from) : "";
      const toRaw = typeof rel.to === "string" ? normalizeEntityName(rel.to) : "";
      if (!fromRaw || !toRaw) {
        filteredInvalidRelations += 1;
        continue;
      }

      const from = entityCanonical.get(fromRaw.toLowerCase());
      const to = entityCanonical.get(toRaw.toLowerCase());
      if (!from || !to || from.toLowerCase() === to.toLowerCase()) {
        filteredInvalidRelations += 1;
        continue;
      }

      const type = typeof rel.type === "string" ? normalizeRelationType(rel.type) : undefined;
      if (type !== undefined && GENERIC_RELATION_TYPES.has(type)) {
        filteredInvalidRelations += 1;
        continue;
      }
      const confidence = parseConfidence(rel.confidence);
      if (confidence !== undefined && confidence < MIN_RELATION_CONFIDENCE) {
        filteredLowConfidenceRelations += 1;
        continue;
      }
      relations.push({
        from,
        to,
        ...(type ? { type } : {}),
        ...(confidence !== undefined ? { confidence } : {}),
      });
      if (relations.length >= MAX_RELATIONS_PER_ASSET) break;
    }
  }

  const confidence = extractionConfidence;
  const status: GraphExtractionStatus = entities.length > 0 ? "extracted" : "empty";
  const reason: GraphExtractionReason =
    entities.length > 0 ? "none" : filteredGenericEntities > 0 ? "generic_entities_only" : "no_graph_content";
  return {
    entities,
    relations,
    status,
    reason,
    filteredGenericEntities,
    filteredInvalidRelations,
    filteredLowConfidenceRelations,
    ...(confidence !== undefined ? { confidence } : {}),
  };
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
  const assetBlocks = bodies.map((body, i) => `${BATCH_ASSET_SEPARATOR} ${i + 1} ===\n${body.trim()}`).join("\n\n");

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

function formatContextHint(llmConfig: LlmConnectionConfig): string {
  return llmConfig.contextLength ? `, configured contextLength=${llmConfig.contextLength}` : "";
}

/**
 * Parse and validate a single item from the batch response array.
 * Mirrors the validation logic in `extractGraphFromBody`.
 */
function parseBatchItem(raw: unknown): GraphExtraction {
  return parseGraphExtraction(raw);
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
  options: GraphExtractionRuntimeOptions = {},
): Promise<GraphExtraction[]> {
  const empty = (): GraphExtraction => ({ entities: [], relations: [] });
  const batchState = normalizeBatchState(options.batchState);

  // Degenerate case: no bodies → empty array (not an error).
  if (bodies.length === 0) return [];

  // Single body: delegate to the single-asset path for identical behaviour.
  if (bodies.length === 1) {
    const result = await extractGraphFromBody(llmConfig, bodies[0] ?? "", signal, akmConfig, onFallback, options);
    return [result];
  }

  // Filter out bodies that are empty so we don't waste tokens, but keep
  // index correspondence by tracking which indices were non-empty.
  const results: GraphExtraction[] = bodies.map(empty);
  const nonEmptyIndices: number[] = [];
  const nonEmptyBodies: string[] = [];
  const oversizedIndices: number[] = [];
  for (let i = 0; i < bodies.length; i++) {
    const trimmed = (bodies[i] ?? "").trim();
    if (trimmed) {
      if (trimmed.length > MAX_BATCH_BODY_CHARS) {
        oversizedIndices.push(i);
      } else {
        nonEmptyIndices.push(i);
        nonEmptyBodies.push(trimmed);
      }
    }
  }

  if (oversizedIndices.length > 0) {
    await Promise.all(
      oversizedIndices.map(async (index) => {
        results[index] = await extractGraphFromBody(
          llmConfig,
          bodies[index] ?? "",
          signal,
          akmConfig,
          onFallback,
          options,
        );
      }),
    );
  }

  if (nonEmptyBodies.length === 0) return results;

  if (batchState?.batchingDisabled) {
    return Promise.all(
      bodies.map((body) => extractGraphFromBody(llmConfig, body, signal, akmConfig, onFallback, options)),
    );
  }

  const systemPrompt = buildBatchSystemPrompt();
  const userPrompt = buildBatchUserPrompt(nonEmptyBodies);
  const truncatedBodies = nonEmptyBodies.filter((body) => body.length > MAX_BATCH_BODY_CHARS).length;
  if (truncatedBodies > 0) {
    warnVerbose(
      `graph extraction (batch): ${truncatedBodies}/${nonEmptyBodies.length} asset body/bodies exceed the batch body threshold of ${MAX_BATCH_BODY_CHARS} chars.`,
    );
  }
  let batchContextError = false;
  let nonArrayResponse = false;

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
            temperature: 0.1,
            timeoutMs: llmConfig.timeoutMs,
            signal,
          },
        );
        if (!raw) return null;
        const parsed = parseEmbeddedJsonResponse<unknown[]>(raw);
        if (!Array.isArray(parsed)) {
          nonArrayResponse = true;
          bumpTelemetry(options.telemetry, "nonArrayBatchFailures");
          if (batchState) {
            batchState.nonArrayBatchFailures += 1;
            if (batchState.nonArrayBatchFailures >= NON_ARRAY_BATCH_DISABLE_THRESHOLD) {
              batchState.batchingDisabled = true;
            }
          }
          warn(
            `graph extraction (batch): LLM response was not a JSON array for ${nonEmptyBodies.length} asset(s); ` +
              `will fall back per-asset. promptChars=${userPrompt.length}${formatContextHint(llmConfig)}`,
          );
          return null;
        }
        return parsed;
      } catch (err) {
        const errMsg = toErrorMessage(err);
        if (isContextSizeError(errMsg)) {
          batchContextError = true;
          bumpTelemetry(options.telemetry, "contextBatchRetries");
          warn(
            `graph extraction (batch): context size exceeded for ${nonEmptyBodies.length} asset(s); ` +
              `skipping batch. promptChars=${userPrompt.length}${formatContextHint(llmConfig)}`,
          );
        } else {
          warn(
            `graph extraction (batch) failed for ${nonEmptyBodies.length} asset(s); ` +
              `promptChars=${userPrompt.length}${formatContextHint(llmConfig)}: ${errMsg}`,
          );
        }
        return null;
      }
    },
    null,
    {
      timeoutMs: llmConfig.timeoutMs,
      onFallback,
    },
  );

  // Map successful batch results back to their original indices.
  if (batchResult !== null) {
    if (batchState) batchState.nonArrayBatchFailures = 0;
    if (batchResult.length > nonEmptyBodies.length) {
      warn(
        `graph extraction (batch): response had ${batchResult.length} items for ${nonEmptyBodies.length} assets; ` +
          `ignoring ${batchResult.length - nonEmptyBodies.length} extra item(s).`,
      );
    }
    for (let j = 0; j < nonEmptyBodies.length; j++) {
      const originalIndex = nonEmptyIndices[j];
      if (originalIndex === undefined) continue;
      if (j < batchResult.length) {
        results[originalIndex] = parseBatchItem(batchResult[j]);
      }
      // j >= batchResult.length → partial failure; handled below.
    }
  }

  if (batchContextError && nonEmptyBodies.length > 1) {
    const splitAt = Math.ceil(nonEmptyBodies.length / 2);
    const left = await extractGraphFromBodies(
      llmConfig,
      nonEmptyBodies.slice(0, splitAt),
      signal,
      akmConfig,
      onFallback,
      options,
    );
    const right = await extractGraphFromBodies(
      llmConfig,
      nonEmptyBodies.slice(splitAt),
      signal,
      akmConfig,
      onFallback,
      options,
    );
    const combined = [...left, ...right];
    for (let j = 0; j < nonEmptyIndices.length; j++) {
      const origIdx = nonEmptyIndices[j];
      if (origIdx === undefined) continue;
      results[origIdx] = combined[j] ?? empty();
    }
    return results;
  }

  // Partial-failure fallback: any non-empty body whose result is still the
  // empty placeholder (either because batchResult was null or the array was
  // shorter than expected) gets an individual retry — unless the batch failed
  // due to context size, in which case individual calls would also fail.
  const fallbackIndices = nonEmptyIndices.filter((_origIdx, j) => {
    if (batchContextError) return false; // skip individual retries on context error
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
        results[origIdx] = await extractGraphFromBody(llmConfig, body, signal, akmConfig, onFallback, options);
      }),
    );
  } else if (batchContextError) {
    warn(
      `graph extraction (batch): skipped ${nonEmptyBodies.length} asset(s) due to context size error; ` +
        `consider increasing llm.contextLength or reducing index.graph.graphExtractionBatchSize to 1.`,
    );
  } else if (nonArrayResponse && batchState?.batchingDisabled) {
    warn("graph extraction (batch): disabling batching for the rest of this run after repeated non-array responses.");
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
  options: GraphExtractionRuntimeOptions = {},
): Promise<GraphExtraction> {
  const empty = (reason?: GraphExtractionReason, status?: GraphExtractionStatus): GraphExtraction => ({
    entities: [],
    relations: [],
    ...(status ? { status } : {}),
    ...(reason ? { reason } : {}),
  });
  const trimmedBody = body.trim();
  if (!trimmedBody) return empty();

  const chunked = splitBodyIntoChunks(trimmedBody, MAX_CHUNK_BODY_CHARS);
  if (chunked.truncationCount > 0) {
    bumpTelemetry(options.telemetry, "truncationCount", chunked.truncationCount);
    warnVerbose(
      `graph extraction: split a long asset into ${chunked.chunks.length} chunk(s) with ${chunked.truncationCount} hard split(s).`,
    );
  }
  if (chunked.chunks.length > 1) {
    const chunkResults: GraphExtraction[] = [];
    for (const chunk of chunked.chunks) {
      chunkResults.push(await extractGraphFromBody(llmConfig, chunk, signal, akmConfig, onFallback, options));
    }
    const merged = mergeGraphExtractions(chunkResults);
    merged.truncationCount = (merged.truncationCount ?? 0) + chunked.truncationCount;
    return merged;
  }

  const userPrompt = `${USER_PROMPT_PREFIX}${trimmedBody}`;

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
          { temperature: 0.1, timeoutMs: llmConfig.timeoutMs, signal },
        );
        if (!raw) return empty();
        const parsed = parseEmbeddedJsonResponse<{ entities?: unknown; relations?: unknown }>(raw);
        if (!parsed) {
          warn("graph extraction: invalid JSON response from LLM; skipping asset.");
          bumpTelemetry(options.telemetry, "failureCount");
          return empty("invalid_json", "failed");
        }

        const extraction = parseGraphExtraction(parsed);
        bumpTelemetry(options.telemetry, "filteredGenericEntities", extraction.filteredGenericEntities ?? 0);
        bumpTelemetry(options.telemetry, "filteredInvalidRelations", extraction.filteredInvalidRelations ?? 0);
        bumpTelemetry(
          options.telemetry,
          "filteredLowConfidenceRelations",
          extraction.filteredLowConfidenceRelations ?? 0,
        );
        if (extraction.status === "failed") bumpTelemetry(options.telemetry, "failureCount");
        return extraction;
      } catch (err) {
        const errMsg = toErrorMessage(err);
        if (isContextSizeError(errMsg)) {
          bumpTelemetry(options.telemetry, "failureCount");
          warn(
            `graph extraction: context size exceeded for asset; promptChars=${userPrompt.length}${formatContextHint(llmConfig)}. ` +
              `Consider increasing llm.contextLength in config.json.`,
          );
          return empty("context_limit", "failed");
        } else {
          bumpTelemetry(options.telemetry, "failureCount");
          warn(
            `graph extraction failed for asset; promptChars=${userPrompt.length}${formatContextHint(llmConfig)}: ${errMsg}`,
          );
          return empty("llm_error", "failed");
        }
      }
    },
    empty(),
    {
      timeoutMs: llmConfig.timeoutMs,
      onFallback,
    },
  );
}

// deduplicateGraph moved to src/indexer/graph-dedup.ts (pure utility, no LLM calls).
export { deduplicateGraph } from "../indexer/graph-dedup";
