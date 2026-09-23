// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * LLM helper for the `akm index` graph-extraction pass (#207).
 *
 * Given a single asset body (typically a `memory:` or `knowledge:` file),
 * asks the configured LLM to surface the entities mentioned in it and the
 * relations between them. The pass itself
 * (`src/indexer/graph/graph-extraction.ts`) is responsible for deciding which
 * files to extract, persisting the resulting nodes/edges to the index DB,
 * and feeding the graph data into the FTS5+boosts
 * search pipeline as a single boost component.
 *
 * This module is intentionally tiny and stateless so tests can stub it via
 * `mock.module("../src/llm/graph-extract", ...)` without hitting a network.
 *
 * The symbolic LLM runner comes from the current index-pass execution
 * resolution and is passed straight through.
 */

import systemPromptTemplate from "../assets/prompts/graph-extract-system.md" with { type: "text" };
import userPromptTemplate from "../assets/prompts/graph-extract-user-prompt.md" with { type: "text" };
import { splitMarkdownFragmentStats } from "../core/asset/markdown-fragments";
import { toErrorMessage } from "../core/common";
import type { AkmConfig } from "../core/config/config";
import { ConfigError } from "../core/errors";
import { parseEmbeddedJsonResponse } from "../core/parse";
import { warn, warnVerbose } from "../core/warn";
import type { LoweringNotice } from "../execution/resolved-request";
import type { LoweredExecutionDispatchLease } from "../integrations/agent/execution-lowering";
import { type ChatMessage, isContextSizeError, isTransportFailure, LlmCallError } from "./client";
import { type TryLlmFeatureFallbackEvent, tryLlmFeature } from "./feature-gate";
import { type CallStructuredRequest, callStructured, type StructuredLlmRunner } from "./structured-call";

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

/**
 * Default cap on chunks processed per asset (R12b + R20) — overridable via
 * `processes.graphExtraction.maxChunksPerAsset`. Without a cap, one long file
 * chunked at MAX_CHUNK_BODY_CHARS could spend dozens of calls on a single
 * asset (one file spent 21 of 27 run calls this way) before its output was
 * sliced to MAX_ENTITIES_PER_ASSET/MAX_RELATIONS_PER_ASSET anyway.
 */
const DEFAULT_MAX_CHUNKS_PER_ASSET = 8;

const SYSTEM_PROMPT = systemPromptTemplate;

const USER_PROMPT_PREFIX = userPromptTemplate
  .replace("{{MAX_ENTITIES}}", String(MAX_ENTITIES_PER_ASSET))
  .replace("{{MAX_RELATIONS}}", String(MAX_RELATIONS_PER_ASSET));

/**
 * Strict JSON Schema for the single-asset extraction payload (R12b). Sent via
 * `responseSchema` to providers that opt into structured output
 * (`runner.connection.supportsJsonSchema` — same lift as memory-infer.ts's
 * `DERIVED_MEMORY_JSON_SCHEMA`); the client silently drops it otherwise.
 * `maxItems` mirrors MAX_ENTITIES_PER_ASSET/MAX_RELATIONS_PER_ASSET so a
 * compliant provider cannot pay for output beyond what parseGraphExtraction
 * keeps, and `additionalProperties: false` forbids the `confidence` field the
 * prompt never asks for.
 */
const GRAPH_EXTRACTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    entities: { type: "array", items: { type: "string" }, maxItems: MAX_ENTITIES_PER_ASSET },
    relations: {
      type: "array",
      maxItems: MAX_RELATIONS_PER_ASSET,
      items: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          type: { type: "string" },
        },
        required: ["from", "to"],
        additionalProperties: false,
      },
    },
  },
  required: ["entities", "relations"],
  additionalProperties: false,
} as const;

/**
 * Hard output-token cap for the single-asset extraction call (R20), derived
 * from the caps above so a compliant provider cannot pay for output beyond
 * what parseGraphExtraction ever keeps. ~12 tokens covers a short quoted
 * entity plus its array separator; a relation costs roughly 2x that for its
 * two entity refs and `type` field, plus headroom for JSON punctuation.
 */
const MAX_GRAPH_EXTRACTION_TOKENS = MAX_ENTITIES_PER_ASSET * 12 + MAX_RELATIONS_PER_ASSET * 24;

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
  /** Chunks skipped because the asset exceeded maxChunksPerAsset (R12b + R20). */
  truncatedChunks?: number;
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
  /** Chunks skipped because an asset exceeded maxChunksPerAsset (R12b + R20). */
  truncatedChunks?: number;
  failureCount?: number;
  htmlErrorCount?: number;
  retryAttempts?: number;
  filteredGenericEntities?: number;
  filteredInvalidRelations?: number;
  filteredLowConfidenceRelations?: number;
  contextBatchRetries?: number;
  nonArrayBatchFailures?: number;
}

export interface GraphExtractionRuntimeOptions {
  batchState?: GraphBatchState;
  telemetry?: GraphRuntimeTelemetry;
  onNotices?: (notices: readonly Readonly<LoweringNotice>[]) => void;
  lease?: LoweredExecutionDispatchLease;
  /**
   * Cap on chunks processed per asset (R12b + R20). Bodies chunked beyond
   * this are truncated to the first N chunks; the rest are recorded as
   * `truncatedChunks`, never processed. Defaults to
   * {@link DEFAULT_MAX_CHUNKS_PER_ASSET} (8) when unset.
   */
  maxChunksPerAsset?: number;
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

function splitBodyIntoChunks(
  body: string,
  maxChars = MAX_CHUNK_BODY_CHARS,
): { chunks: string[]; truncationCount: number } {
  const split = splitMarkdownFragmentStats(body, maxChars);
  // Graph extraction keeps its historical cost shape: adjacent safe fragments
  // share one LLM call whenever they fit. The fragment splitter is still the
  // sole boundary authority; this is only prompt packing, never a second
  // parser/chunker. Hard splits stay isolated and telemetry remains the core
  // split count rather than counting ordinary heading boundaries.
  const chunks: string[] = [];
  let current = "";
  for (const fragment of split.fragments) {
    const candidate = current ? `${current}\n\n${fragment.text}` : fragment.text;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      current = fragment.text;
    }
  }
  if (current) chunks.push(current);
  return { chunks, truncationCount: split.hardSplitCount };
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
  let truncatedChunks = 0;
  let filteredGenericEntities = 0;
  let filteredInvalidRelations = 0;
  let filteredLowConfidenceRelations = 0;
  let firstFailureReason: GraphExtractionReason | undefined;

  for (const extraction of extractions) {
    truncationCount += extraction.truncationCount ?? 0;
    truncatedChunks += extraction.truncatedChunks ?? 0;
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
    truncatedChunks,
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
      // Drop generic/empty entities AND raw file/dir paths (anything with a
      // path separator) — the prompt no longer asks for them and isJunkEntity
      // discards them downstream, so emitting them is pure waste/junk (#632).
      if (
        !/[a-z0-9]/i.test(normalized) ||
        GENERIC_ENTITIES.has(normalizedKey) ||
        normalized.includes("/") ||
        normalized.includes("\\")
      ) {
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

/**
 * Hardened system prompt for the single batch retry (#635). Used only after a
 * first response failed array salvage — leans harder on "raw array only" so a
 * model that wrapped the array in prose/fences corrects itself before we pay
 * the per-asset fallback.
 */
function buildBatchRetrySystemPrompt(): string {
  return (
    `${buildBatchSystemPrompt()} ` +
    "Your previous response could NOT be parsed as a JSON array. " +
    "Respond with ONLY the raw JSON array — start with '[' and end with ']'. " +
    "No prose, no explanation, no markdown code fences, no preamble."
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

function formatContextHint(llmRunner: StructuredLlmRunner): string {
  return llmRunner.connection.contextLength ? `, configured contextLength=${llmRunner.connection.contextLength}` : "";
}

/** Dispatch one raw graph prompt through the common resolved-request adapter. */
async function callGraphLlm(
  runner: StructuredLlmRunner,
  messages: ChatMessage[],
  request: CallStructuredRequest,
  lease: LoweredExecutionDispatchLease | undefined,
  onNotices?: (notices: readonly Readonly<LoweringNotice>[]) => void,
): Promise<string> {
  return callStructured<string>({
    feature: "graph_extraction",
    runner,
    ...(lease ? { lease } : {}),
    messages,
    request,
    onNotices,
    parse: (raw) => raw ?? "",
    onError: (_cls, error) => {
      throw error;
    },
    fallback: "",
  });
}

/**
 * Parse and validate a single item from the batch response array.
 * Mirrors the validation logic in `extractGraphFromBody`.
 */
function parseBatchItem(raw: unknown): GraphExtraction {
  return parseGraphExtraction(raw);
}

function applySuccessfulBatchResults(
  results: GraphExtraction[],
  batchResult: unknown[],
  nonEmptyBodies: string[],
  nonEmptyIndices: number[],
  batchState: GraphBatchState | undefined,
): void {
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
    if (j < batchResult.length) results[originalIndex] = parseBatchItem(batchResult[j]);
  }
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
 * @param llmRunner - Symbolic LLM runner selected through shared execution lowering.
 * @param bodies    - Asset body strings to process in one batch.
 * @param signal    - Optional AbortSignal for cancellation.
 * @param akmConfig - Full AKM config (for feature-gate checks).
 * @param onFallback - Optional fallback event sink.
 */
export async function extractGraphFromBodies(
  llmRunner: StructuredLlmRunner,
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
    const result = await extractGraphFromBody(llmRunner, bodies[0] ?? "", signal, akmConfig, onFallback, options);
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
          llmRunner,
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
      bodies.map((body) => extractGraphFromBody(llmRunner, body, signal, akmConfig, onFallback, options)),
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
  // R2: a dead/erroring provider must not be hammered with a per-asset
  // fallback retry for every body in the batch — that is what turned one
  // outage into 15,453 additional retry attempts. `isTransportFailure`
  // (shared with client.ts's `isRetryable` — see its definition) covers
  // `provider_error`, `network_error`, and `provider_html_error`: the
  // provider itself is failing (a dead endpoint more often raises
  // `network_error` or `provider_html_error` than a plain 5xx), not that this
  // particular response was malformed; skip the fallback and record every
  // asset as failed instead.
  let batchProviderError = false;

  const batchOutcome = await tryLlmFeature<
    { kind: "value"; value: unknown[] | null } | { kind: "config-error"; error: ConfigError }
  >(
    "graph_extraction",
    akmConfig,
    async () => {
      try {
        const raw = await callGraphLlm(
          llmRunner,
          [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          {
            temperature: 0.1,
            timeoutMs: llmRunner.timeoutMs,
            signal,
            onRetryAttempt: () => bumpTelemetry(options.telemetry, "retryAttempts"),
          },
          options.lease,
          options.onNotices,
        );
        if (!raw) return { kind: "value", value: null };
        // Array-preferring salvage (#635): the batch contract is a top-level
        // JSON array. A leading/example `{…}` object in the response must not
        // mask a valid `[…]` array as a false "non-array" failure.
        let parsed = parseEmbeddedJsonResponse<unknown[]>(raw, { expect: "array" });
        if (!Array.isArray(parsed)) {
          // One stricter-reprompt retry before paying the per-asset fallback
          // (#635). Many genuine non-array responses recover when the model is
          // told explicitly to emit only the raw array.
          bumpTelemetry(options.telemetry, "retryAttempts");
          const retryRaw = await callGraphLlm(
            llmRunner,
            [
              { role: "system", content: buildBatchRetrySystemPrompt() },
              { role: "user", content: userPrompt },
            ],
            { temperature: 0, timeoutMs: llmRunner.timeoutMs, signal },
            options.lease,
            options.onNotices,
          );
          parsed = retryRaw ? parseEmbeddedJsonResponse<unknown[]>(retryRaw, { expect: "array" }) : undefined;
        }
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
            `graph extraction (batch): LLM response was not a JSON array for ${nonEmptyBodies.length} asset(s) ` +
              `even after a stricter retry; will fall back per-asset. ` +
              `promptChars=${userPrompt.length}${formatContextHint(llmRunner)}`,
          );
          return { kind: "value", value: null };
        }
        return { kind: "value", value: parsed };
      } catch (err) {
        if (err instanceof ConfigError) return { kind: "config-error", error: err };
        const errMsg = toErrorMessage(err);
        if (isContextSizeError(errMsg)) {
          batchContextError = true;
          bumpTelemetry(options.telemetry, "contextBatchRetries");
          warn(
            `graph extraction (batch): context size exceeded for ${nonEmptyBodies.length} asset(s); ` +
              `skipping batch. promptChars=${userPrompt.length}${formatContextHint(llmRunner)}`,
          );
        } else if (err instanceof LlmCallError && isTransportFailure(err)) {
          batchProviderError = true;
          bumpTelemetry(options.telemetry, "failureCount", nonEmptyBodies.length);
          warn(
            `graph extraction (batch): provider error (${err.code}) for ${nonEmptyBodies.length} asset(s); ` +
              `skipping per-asset fallback retries. promptChars=${userPrompt.length}${formatContextHint(llmRunner)}: ${errMsg}`,
          );
        } else {
          warn(
            `graph extraction (batch) failed for ${nonEmptyBodies.length} asset(s); ` +
              `promptChars=${userPrompt.length}${formatContextHint(llmRunner)}: ${errMsg}`,
          );
        }
        return { kind: "value", value: null };
      }
    },
    { kind: "value", value: null },
    {
      timeoutMs: llmRunner.timeoutMs,
      onFallback,
    },
  );
  if (batchOutcome.kind === "config-error") throw batchOutcome.error;
  const batchResult = batchOutcome.value;

  // Map successful batch results back to their original indices.
  if (batchResult !== null) {
    applySuccessfulBatchResults(results, batchResult, nonEmptyBodies, nonEmptyIndices, batchState);
  } else if (batchProviderError) {
    // No per-asset fallback against a failing provider — record every asset
    // in this batch as a genuine failure so it is neither silently empty nor
    // retried again below.
    for (const origIdx of nonEmptyIndices)
      results[origIdx] = { entities: [], relations: [], status: "failed", reason: "llm_error" };
  }

  if (batchContextError && nonEmptyBodies.length > 1) {
    const splitAt = Math.ceil(nonEmptyBodies.length / 2);
    const left = await extractGraphFromBodies(
      llmRunner,
      nonEmptyBodies.slice(0, splitAt),
      signal,
      akmConfig,
      onFallback,
      options,
    );
    const right = await extractGraphFromBodies(
      llmRunner,
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
    if (batchProviderError) return false; // skip individual retries against a failing provider
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
        results[origIdx] = await extractGraphFromBody(llmRunner, body, signal, akmConfig, onFallback, options);
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
  llmRunner: StructuredLlmRunner,
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

  // R12b + R20: bound per-asset cost by capping how many chunks of a long
  // asset are ever sent to the LLM. Excess chunks are dropped, never
  // processed — the coverage loss is recorded as truncatedChunks rather than
  // silently absorbed.
  const maxChunksPerAsset = options.maxChunksPerAsset ?? DEFAULT_MAX_CHUNKS_PER_ASSET;
  const cappedChunks =
    chunked.chunks.length > maxChunksPerAsset ? chunked.chunks.slice(0, maxChunksPerAsset) : chunked.chunks;
  const truncatedChunkCount = chunked.chunks.length - cappedChunks.length;
  if (truncatedChunkCount > 0) {
    bumpTelemetry(options.telemetry, "truncatedChunks", truncatedChunkCount);
    warnVerbose(
      `graph extraction: capped a long asset to ${cappedChunks.length} of ${chunked.chunks.length} chunk(s) ` +
        `(maxChunksPerAsset=${maxChunksPerAsset}); ${truncatedChunkCount} chunk(s) not processed.`,
    );
  }

  if (cappedChunks.length > 1) {
    const chunkResults: GraphExtraction[] = [];
    for (const chunk of cappedChunks) {
      chunkResults.push(await extractGraphFromBody(llmRunner, chunk, signal, akmConfig, onFallback, options));
    }
    const merged = mergeGraphExtractions(chunkResults);
    merged.truncationCount = (merged.truncationCount ?? 0) + chunked.truncationCount;
    merged.truncatedChunks = (merged.truncatedChunks ?? 0) + truncatedChunkCount;
    return merged;
  }

  // When capped down to exactly one chunk from a body that originally split
  // into more, that single surviving chunk (not the full trimmedBody) is what
  // must be sent — otherwise the cap would have no effect on prompt size.
  const bodyForCall = truncatedChunkCount > 0 ? (cappedChunks[0] ?? trimmedBody) : trimmedBody;
  const userPrompt = `${USER_PROMPT_PREFIX}${bodyForCall}`;

  const result = await callStructured<GraphExtraction>({
    feature: "graph_extraction",
    akmConfig,
    runner: llmRunner,
    ...(options.lease ? { lease: options.lease } : {}),
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    request: {
      temperature: 0.1,
      timeoutMs: llmRunner.timeoutMs,
      signal,
      responseSchema: GRAPH_EXTRACTION_JSON_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: MAX_GRAPH_EXTRACTION_TOKENS,
      onRetryAttempt: () => bumpTelemetry(options.telemetry, "retryAttempts"),
    },
    onNotices: options.onNotices,
    parse: (raw) => {
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
    },
    onError: (cls, err) => {
      const errMsg = toErrorMessage(err);
      if (cls === "context_limit") {
        bumpTelemetry(options.telemetry, "failureCount");
        warn(
          `graph extraction: context size exceeded for asset; promptChars=${userPrompt.length}${formatContextHint(llmRunner)}. ` +
            `Consider increasing llm.contextLength in config.json.`,
        );
        return empty("context_limit", "failed");
      } else if (cls === "html") {
        bumpTelemetry(options.telemetry, "htmlErrorCount");
        warn(
          `graph extraction: provider returned HTML instead of JSON for asset; promptChars=${userPrompt.length}${formatContextHint(llmRunner)}: ${errMsg}`,
        );
        return empty("llm_error", "failed");
      } else {
        bumpTelemetry(options.telemetry, "failureCount");
        warn(
          `graph extraction failed for asset; promptChars=${userPrompt.length}${formatContextHint(llmRunner)}: ${errMsg}`,
        );
        return empty("llm_error", "failed");
      }
    },
    fallback: empty(),
    onFallback,
  });
  if (truncatedChunkCount > 0) result.truncatedChunks = (result.truncatedChunks ?? 0) + truncatedChunkCount;
  return result;
}

// deduplicateGraph lives in src/indexer/graph/graph-dedup.ts (pure utility, no
// LLM calls) — import it from there directly. The re-export that used to live
// here created a value edge back to graph-dedup.ts, which (via its type-only
// import of GraphExtraction/GraphRelation below) formed a 2-file import cycle
// (chunk 9 WI-9.8 KILL 4 sever). No src or test consumer used this re-export
// (graph-extraction.ts and the test suite already import graph-dedup.ts
// directly), so it is deleted outright rather than repointed.
