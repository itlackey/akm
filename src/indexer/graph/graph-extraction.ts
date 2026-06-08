// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Graph-extraction pass for `akm index` (#207).
 *
 * Walks the primary stash for `memory:` and `knowledge:` assets, asks the
 * configured LLM to extract entities and relations from each one, and
 * persists the result to stash-local SQLite graph tables keyed by stash root.
 * The artifact is consumed by the search
 * pipeline (see `src/indexer/graph-boost.ts`) as a single boost component
 * inside the existing FTS5+boosts loop — there is NO second SearchHit
 * scorer and no parallel ranking track.
 *
 * Disabling — three preconditions must ALL hold for the pass to run:
 *   1. An LLM profile must be configured (no provider = no extraction). When
 *      absent, `resolveIndexPassLLM("graph", config)` returns `undefined`
 *      and the pass short-circuits.
 *   2. `profiles.improve.default.processes.graphExtraction.enabled !== false`
 *      — the feature-gate layer (historically v1 spec §14, since superseded by
 *      the 0.8.0 profile shape). Set to `false` to block the pass at the
 *      feature-gate layer (no network call may ever issue).
 *   3. `index.graph.llm !== false` — the per-pass opt-out layer (#208).
 *      Set to `false` to skip just this pass while leaving other passes
 *      that share the same LLM profile enabled.
 *   Toggling any one off does NOT delete the existing persisted graph — the
 *   user keeps the boost component they already have, it just stops
 *   refreshing.
 *
 * Locked v1 contract:
 *   - LLM access is exclusively via `resolveIndexPassLLM("graph", config)`.
 *   - The graph rows are an indexer artifact, NOT a user-visible
 *     asset. It does not have an asset ref, does not appear in search
 *     hits, and is not addressable via `akm show`. Direct `fs.writeFile`
 *     is therefore the correct primitive — `writeAssetToSource` is
 *     reserved for asset writes (CLAUDE.md / spec §10 step 5).
 */

import fs from "node:fs";
import path from "node:path";
import { TYPE_DIRS } from "../../core/asset/asset-spec";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { concurrentMap } from "../../core/concurrent";
import { type AkmConfig, getIndexPassConfig, resolveBatchSize } from "../../core/config/config";
import { warn, warnVerbose } from "../../core/warn";
import { isProcessEnabled } from "../../llm/feature-gate";
import type { GraphExtractionReason, GraphExtractionStatus, GraphRelation } from "../../llm/graph-extract";
import * as graphExtract from "../../llm/graph-extract";
import { resolveIndexPassLLM } from "../../llm/index-passes";
import type { Database } from "../../storage/database";
import {
  computeBodyHash,
  GRAPH_SCHEMA_VERSION,
  getLlmCacheEntriesByRefs,
  getLlmCacheEntry,
  type LlmCacheEntry,
  upsertLlmCacheEntry,
} from "../db/db";
import { loadStoredGraphSnapshot, replaceStoredGraph } from "../db/graph-db";
import type { EnrichmentPassContext } from "../passes/pass-context";
import { walkMarkdownFiles } from "../walk/walker";
import { deduplicateGraph } from "./graph-dedup";

/** Schema version for the persisted artifact — bumps trigger a full rebuild. */
export const GRAPH_FILE_SCHEMA_VERSION = GRAPH_SCHEMA_VERSION;

/** One node in the graph — corresponds to a single asset file. */
export interface GraphFileNode {
  /** Absolute path on disk. */
  path: string;
  /** Asset type (`memory` or `knowledge`). */
  type: string;
  /** SHA-256 hash of the parsed markdown body used for staleness checks. */
  bodyHash?: string;
  /** Entities surfaced by the LLM for this file. */
  entities: string[];
  /** Relations the LLM surfaced from this file's body. */
  relations: GraphRelation[];
  /** Optional extraction confidence score in [0,1]. */
  confidence?: number;
  /** Extraction outcome for this file. */
  status?: GraphExtractionStatus;
  /** Empty/failure reason for this file. */
  reason?: GraphExtractionReason;
  /** Run id that most recently updated this file. */
  extractionRunId?: string;
}

export interface GraphExtractionTelemetry {
  extractorId?: string;
  extractionRunId?: string;
  model?: string;
  promptVersion?: string;
  batchSize?: number;
  cacheHits: number;
  cacheMisses: number;
  truncationCount: number;
  failureCount: number;
  /**
   * Asset extractions where the provider returned an HTML body (e.g. LM Studio
   * serving its web UI) instead of JSON. Tracked distinctly from
   * `failureCount` so a provider-load failure is observable in health output
   * rather than folded into the generic failure count (#497).
   */
  htmlErrorCount?: number;
  /** Count of single bounded retries triggered for transient LLM failures. */
  retryAttempts: number;
}

/** Persisted graph shape loaded from SQLite. */
export interface GraphFile {
  schemaVersion: number;
  /** ISO-8601 timestamp of the last refresh. */
  generatedAt: string;
  /** Stash root the file was extracted from (canonicalised). */
  stashRoot: string;
  /** Per-file extraction results. */
  files: GraphFileNode[];
  /** Deduplicated entity list across all files (schema v2+). Canonical casing, first-seen order. */
  entities?: string[];
  /** Deduplicated relation list across all files (schema v2+). Dangling relations excluded. */
  relations?: GraphRelation[];
  /** Graph quality telemetry emitted by the extraction pass. */
  quality?: GraphQualityTelemetry;
  /** Durable latest-run extraction telemetry. */
  telemetry?: GraphExtractionTelemetry;
}

export interface GraphQualityTelemetry {
  /** Eligible files considered by extraction. */
  consideredFiles: number;
  /** Files with at least one extracted entity. */
  extractedFiles: number;
  /** Unique deduplicated entity count in the graph. */
  entityCount: number;
  /** Unique deduplicated relation count in the graph. */
  relationCount: number;
  /** Fraction of eligible files that produced at least one entity. */
  extractionCoverage: number;
  /** Undirected graph density over unique entities/relations. */
  density: number;
}

/** Telemetry — useful for tests and progress events. */
export interface GraphExtractionResult {
  /** Eligible files considered (all `memory:` / `knowledge:` markdown files). */
  considered: number;
  /** Files for which the LLM returned at least one entity. */
  extracted: number;
  /** Total entities across all extracted files. */
  totalEntities: number;
  /** Total relations across all extracted files. */
  totalRelations: number;
  /** Whether graph rows were written this run. False when the pass is a no-op. */
  written: boolean;
  /** Graph quality telemetry computed from the extracted artifact. */
  quality: GraphQualityTelemetry;
  /** Durable latest-run extraction telemetry. */
  telemetry?: GraphExtractionTelemetry;
  /** Warnings surfaced by quality gates or low-coverage outcomes. */
  warnings?: string[];
}

export interface GraphExtractionPassOptions {
  candidatePaths?: ReadonlySet<string>;
}

/** Progress event emitted by {@link runGraphExtractionPass}. */
export interface GraphExtractionProgress {
  processed: number;
  total: number;
  extracted: number;
  totalEntities: number;
  totalRelations: number;
  currentPath?: string;
}

/** Parameter object for {@link runGraphExtractionPass}. */
export type GraphExtractionPassContext = EnrichmentPassContext<GraphExtractionProgress, GraphExtractionPassOptions>;

interface LoadedGraphFile {
  files: GraphFileNode[];
  telemetry?: GraphExtractionTelemetry;
}

const EMPTY_QUALITY: GraphQualityTelemetry = {
  consideredFiles: 0,
  extractedFiles: 0,
  entityCount: 0,
  relationCount: 0,
  extractionCoverage: 0,
  density: 0,
};

const EMPTY_RESULT: GraphExtractionResult = {
  considered: 0,
  extracted: 0,
  totalEntities: 0,
  totalRelations: 0,
  written: false,
  quality: { ...EMPTY_QUALITY },
  telemetry: {
    cacheHits: 0,
    cacheMisses: 0,
    truncationCount: 0,
    failureCount: 0,
    retryAttempts: 0,
  },
  warnings: [],
};

function roundMetric(value: number): number {
  return Number(value.toFixed(4));
}

function computeGraphQualityTelemetry(
  consideredFiles: number,
  extractedFiles: number,
  entityCount: number,
  relationCount: number,
): GraphQualityTelemetry {
  const extractionCoverage = consideredFiles > 0 ? extractedFiles / consideredFiles : 0;
  const maxEdges = entityCount > 1 ? (entityCount * (entityCount - 1)) / 2 : 0;
  const density = maxEdges > 0 ? relationCount / maxEdges : 0;
  return {
    consideredFiles,
    extractedFiles,
    entityCount,
    relationCount,
    extractionCoverage: roundMetric(extractionCoverage),
    density: roundMetric(density),
  };
}

export const DEFAULT_GRAPH_EXTRACTION_INCLUDE_TYPES = ["memory", "knowledge"] as const;

const SUPPORTED_GRAPH_EXTRACTION_INCLUDE_TYPES = new Set([
  "memory",
  "knowledge",
  "skill",
  "command",
  "agent",
  "workflow",
  "lesson",
  "task",
  "wiki",
]);

type GraphCacheShape = {
  entities: string[];
  relations: Array<{ from: string; to: string; type?: string; confidence?: number }>;
  confidence?: number;
  status?: GraphExtractionStatus;
  reason?: GraphExtractionReason;
};

type ExtractionRecord =
  | {
      absPath: string;
      type: string;
      bodyHash: string;
      entities: string[];
      relations: Array<{ from: string; to: string; type?: string; confidence?: number }>;
      confidence?: number;
      status?: GraphExtractionStatus;
      reason?: GraphExtractionReason;
    }
  | undefined;

const GRAPH_CACHE_VARIANT_PREFIX = "graph-extraction";

function normalizeConfidence(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return Math.max(0, Math.min(1, raw));
}

function getGraphExtractorId(config: { model: string; batchSize: number; includeTypes: string[] }): string {
  const fingerprint = computeBodyHash(
    JSON.stringify({
      promptVersion: graphExtract.GRAPH_EXTRACT_PROMPT_VERSION,
      model: config.model,
      batchSize: config.batchSize,
      includeTypes: config.includeTypes,
      maxChunkBodyChars: 1600,
      maxBatchBodyChars: 1600,
    }),
  ).slice(0, 16);
  return `${GRAPH_CACHE_VARIANT_PREFIX}:${graphExtract.GRAPH_EXTRACT_PROMPT_VERSION}:${config.model}:${fingerprint}`;
}

function buildLowQualityWarnings(quality: GraphQualityTelemetry, telemetry: GraphExtractionTelemetry): string[] {
  const warnings: string[] = [];
  if (quality.consideredFiles >= 5 && quality.extractionCoverage < 0.3) {
    warnings.push(
      `Low graph extraction coverage (${quality.extractedFiles}/${quality.consideredFiles}, ${quality.extractionCoverage}).`,
    );
  }
  if (quality.entityCount >= 8 && quality.relationCount === 0) {
    warnings.push("Graph extraction produced many entities but no relations.");
  }
  if (telemetry.failureCount > 0) {
    warnings.push(`Graph extraction encountered ${telemetry.failureCount} failed file extraction(s).`);
  }
  return warnings;
}

export function getGraphExtractionIncludeTypes(config: AkmConfig): string[] {
  const configured = getIndexPassConfig(config.index, "graph")?.graphExtractionIncludeTypes;
  if (!configured || configured.length === 0) return [...DEFAULT_GRAPH_EXTRACTION_INCLUDE_TYPES];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawType of configured) {
    const type = rawType.trim().toLowerCase();
    if (!type || seen.has(type)) continue;
    if (!SUPPORTED_GRAPH_EXTRACTION_INCLUDE_TYPES.has(type)) continue;
    seen.add(type);
    out.push(type);
  }

  return out.length > 0 ? out : [...DEFAULT_GRAPH_EXTRACTION_INCLUDE_TYPES];
}

function validateGraphCacheShape(raw: unknown): GraphCacheShape | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.entities) || !obj.entities.every((e) => typeof e === "string")) return undefined;
  if (
    obj.relations !== undefined &&
    (!Array.isArray(obj.relations) ||
      !obj.relations.every((r) => {
        if (!r || typeof r !== "object") return false;
        const rel = r as Record<string, unknown>;
        if (typeof rel.from !== "string" || typeof rel.to !== "string") return false;
        if (rel.type !== undefined && typeof rel.type !== "string") return false;
        if (rel.confidence !== undefined && (typeof rel.confidence !== "number" || !Number.isFinite(rel.confidence))) {
          return false;
        }
        return true;
      }))
  ) {
    return undefined;
  }
  return {
    entities: obj.entities as string[],
    relations: Array.isArray(obj.relations) ? (obj.relations as GraphCacheShape["relations"]) : [],
    confidence: normalizeConfidence(obj.confidence),
    ...(typeof obj.status === "string" ? { status: obj.status as GraphExtractionStatus } : {}),
    ...(typeof obj.reason === "string" ? { reason: obj.reason as GraphExtractionReason } : {}),
  };
}

function loadGraphFile(stashRoot: string, db?: Database): LoadedGraphFile {
  if (!db) return { files: [] };
  const graph = loadStoredGraphSnapshot(stashRoot, db);
  if (!graph) return { files: [] };
  const out: GraphFileNode[] = [];
  for (const node of graph.files) {
    const cacheShape = validateGraphCacheShape({ entities: node.entities, relations: node.relations });
    if (!cacheShape) continue;
    out.push({
      path: node.path,
      type: node.type,
      bodyHash: node.bodyHash,
      entities: cacheShape.entities,
      relations: cacheShape.relations,
      confidence: normalizeConfidence(node.confidence),
      ...(node.status ? { status: node.status } : {}),
      ...(node.reason ? { reason: node.reason } : {}),
      ...(node.extractionRunId ? { extractionRunId: node.extractionRunId } : {}),
    });
  }
  return {
    files: out,
    ...(graph.telemetry ? { telemetry: graph.telemetry } : {}),
  };
}

function mergeGraphNodes(
  previousNodes: GraphFileNode[],
  refreshedNodes: GraphFileNode[],
  candidatePaths?: ReadonlySet<string>,
): GraphFileNode[] {
  if (!candidatePaths) return refreshedNodes;
  const refreshedByPath = new Map(refreshedNodes.map((node) => [node.path, node]));
  const merged: GraphFileNode[] = [];
  for (const node of previousNodes) {
    if (candidatePaths.has(node.path)) continue;
    merged.push(node);
  }
  for (const node of refreshedNodes) merged.push(refreshedByPath.get(node.path) ?? node);
  return merged;
}

function reuseGraphNode(
  previousNodes: Map<string, GraphFileNode>,
  candidate: { absPath: string; type: string },
  bodyHash: string,
): GraphCacheShape | undefined {
  const node = previousNodes.get(candidate.absPath);
  if (!node) return undefined;
  if (node.type !== candidate.type) return undefined;
  if (typeof node.bodyHash !== "string" || node.bodyHash.length === 0) return undefined;
  if (node.bodyHash !== bodyHash) return undefined;
  const validated = validateGraphCacheShape({ entities: node.entities, relations: node.relations });
  if (!validated) return undefined;
  return {
    entities: validated.entities,
    relations: validated.relations,
    confidence: normalizeConfidence(node.confidence),
    ...(node.status ? { status: node.status } : {}),
    ...(node.reason ? { reason: node.reason } : {}),
  };
}

/**
 * Top-level entry point. Returns a no-op result when the pass is disabled.
 *
 * Three preconditions — ALL must hold for the pass to run:
 *
 *   1. **Provider configured** — an LLM profile must be selectable. Without a
 *      configured provider, `resolveIndexPassLLM("graph", config)` returns
 *      `undefined` (the pass cannot run because there is no model to call).
 *   2. **Feature gate** — `profiles.improve.default.processes.graphExtraction.enabled`
 *      (defaults to `true`). When `false`, no network call may issue regardless
 *      of per-pass settings.
 *   3. **Per-pass gate** — `index.graph.llm` (defaults to `true`). When
 *      `false`, the indexer simply skips this pass for the current run.
 *
 * If any of the three is missing or `false`, this function short-circuits
 * to an empty no-op result, leaving any existing persisted graph untouched.
 *
 * When `config.index.graph.graphExtractionBatchSize > 1`, eligible files are
 * chunked into batches and each chunk is processed with a single LLM call via
 * `extractGraphFromBodies`. Default batch size is 1 (one call per asset —
 * preserves existing behaviour, fully opt-in).
 */
export async function runGraphExtractionPass(ctx: GraphExtractionPassContext): Promise<GraphExtractionResult> {
  const { config, sources, signal, db, reEnrich, onProgress, options = {} } = ctx;
  // Gate 1 — feature gate via isProcessEnabled, which reads the 0.8.0 path
  // (profiles.improve.default.processes.graphExtraction.enabled). Defaults to
  // enabled when the key is absent.
  if (!isProcessEnabled("index", "graph_extraction", config)) return { ...EMPTY_RESULT };

  // Gate 2 — per-pass opt-out (#208). Returns the resolved llm config or
  // `undefined` when the pass should not run.
  const llmConfig = resolveIndexPassLLM("graph", config);
  if (!llmConfig) {
    const reason =
      getIndexPassConfig(config.index, "graph")?.llm === false
        ? "index.graph.llm is false"
        : "no default LLM profile is configured";
    warnVerbose(`graph extraction: skipped because ${reason}.`);
    return { ...EMPTY_RESULT };
  }

  // The pass only writes to the primary (working) stash. Read-only caches
  // (git, npm, website) are deliberately untouched — the graph artifact for
  // those sources would be clobbered by the next sync().
  const primary = sources[0];
  if (!primary) {
    warnVerbose("graph extraction: skipped because no primary stash source is available.");
    return { ...EMPTY_RESULT };
  }

  const includeTypes = getGraphExtractionIncludeTypes(config);
  const eligible = collectEligibleFiles(primary.path, includeTypes).filter(
    (candidate) => !options.candidatePaths || options.candidatePaths.has(candidate.absPath),
  );
  const considered = eligible.length;
  if (considered === 0) {
    const scoped = options.candidatePaths ? ` matching ${options.candidatePaths.size} candidate path(s)` : "";
    warnVerbose(
      `graph extraction: skipped because no eligible files${scoped} were found under ${primary.path}. ` +
        `includeTypes=${includeTypes.join(",")}`,
    );
    return { ...EMPTY_RESULT };
  }

  const previousGraph = loadGraphFile(primary.path, db);
  const previousNodes = new Map(previousGraph.files.map((node) => [node.path, node]));

  const nodes: GraphFileNode[] = [];
  let totalEntities = 0;
  let totalRelations = 0;
  let processed = 0;
  let extracted = 0;
  onProgress?.({ processed, total: considered, extracted, totalEntities, totalRelations });

  const reportProgress = (currentPath: string | undefined, result: ExtractionRecord | undefined): void => {
    processed += 1;
    if (result) {
      if (result.entities.length > 0) extracted += 1;
      totalEntities += result.entities.length;
      totalRelations += result.relations.length;
    }
    onProgress?.({
      processed,
      total: considered,
      extracted,
      totalEntities,
      totalRelations,
      currentPath,
    });
  };

  // Resolve the effective batch size. Falls back to
  // DEFAULT_GRAPH_EXTRACTION_BATCH_SIZE (4) when unset, and clamps against
  // `llm.contextLength` if the model's context window is configured.
  const batchSize = resolveBatchSize(
    getIndexPassConfig(config.index, "graph")?.graphExtractionBatchSize,
    llmConfig.contextLength,
  );
  const extractionRunId = crypto.randomUUID();
  const extractorId = getGraphExtractorId({ model: llmConfig.model, batchSize, includeTypes });
  const cacheVariant = extractorId;
  const telemetry: GraphExtractionTelemetry = {
    extractorId,
    extractionRunId,
    model: llmConfig.model,
    promptVersion: graphExtract.GRAPH_EXTRACT_PROMPT_VERSION,
    batchSize,
    cacheHits: 0,
    cacheMisses: 0,
    truncationCount: 0,
    failureCount: 0,
    htmlErrorCount: 0,
    retryAttempts: 0,
  };
  const canReusePreviousGraph = previousGraph.telemetry?.extractorId === extractorId;
  const runtimeTelemetry: graphExtract.GraphRuntimeTelemetry = {
    truncationCount: 0,
    failureCount: 0,
    htmlErrorCount: 0,
    retryAttempts: 0,
    filteredGenericEntities: 0,
    filteredInvalidRelations: 0,
    filteredLowConfidenceRelations: 0,
    contextBatchRetries: 0,
    nonArrayBatchFailures: 0,
  };
  const batchState: graphExtract.GraphBatchState = {
    batchingDisabled: false,
    nonArrayBatchFailures: 0,
  };
  warnVerbose(
    `graph extraction: starting for ${considered} eligible file(s) under ${primary.path}; ` +
      `includeTypes=${includeTypes.join(",")}, batchSize=${batchSize}, concurrency=${llmConfig.concurrency ?? 1}, ` +
      `reEnrich=${reEnrich === true}, candidateScoped=${options.candidatePaths ? "true" : "false"}.`,
  );

  const onFallback = (evt: { feature: string; reason: string }) => {
    warn(`[akm] LLM fallback for ${evt.feature}: ${evt.reason}`);
  };

  let extractionResults: Array<ExtractionRecord | undefined>;

  if (batchSize <= 1) {
    // ── Original per-asset path (with incremental cache) ─────────────────
    extractionResults = await concurrentMap(
      eligible,
      async (candidate) => {
        if (signal?.aborted) {
          reportProgress(candidate.absPath, undefined);
          return undefined;
        }
        const bodyHash = computeBodyHash(candidate.body);

        let cached: GraphCacheShape | undefined;
        if (db) {
          if (!(reEnrich ?? false)) {
            const cacheEntry = getLlmCacheEntry(db, candidate.absPath, bodyHash, cacheVariant);
            if (cacheEntry) {
              try {
                cached = validateGraphCacheShape(JSON.parse(cacheEntry.resultJson));
                if (cached) telemetry.cacheHits += 1;
              } catch {
                cached = undefined;
              }
            }
          }
        } else if (!(reEnrich ?? false)) {
          // No DB — best-effort reuse from the previous in-memory graph.
          cached = reuseGraphNode(previousNodes, candidate, bodyHash);
        }

        if (!cached && !(reEnrich ?? false) && canReusePreviousGraph) {
          const reused = reuseGraphNode(previousNodes, candidate, bodyHash);
          if (reused) {
            cached = reused;
            if (db) {
              upsertLlmCacheEntry(db, candidate.absPath, bodyHash, JSON.stringify(reused), cacheVariant);
            }
            telemetry.cacheHits += 1;
          }
        }

        if (!cached) {
          telemetry.cacheMisses += 1;
          const extraction = await graphExtract.extractGraphFromBody(
            llmConfig,
            candidate.body,
            signal,
            config,
            onFallback,
            { batchState, telemetry: runtimeTelemetry },
          );
          cached = {
            entities: extraction.entities,
            relations: extraction.relations,
            ...(extraction.confidence !== undefined ? { confidence: extraction.confidence } : {}),
            ...(extraction.status ? { status: extraction.status } : {}),
            ...(extraction.reason ? { reason: extraction.reason } : {}),
          };
          if (db) {
            upsertLlmCacheEntry(db, candidate.absPath, bodyHash, JSON.stringify(cached), cacheVariant);
          }
        }

        const result: ExtractionRecord = {
          absPath: candidate.absPath,
          type: candidate.type,
          bodyHash,
          entities: cached.entities,
          relations: cached.relations,
          ...(cached.confidence !== undefined ? { confidence: cached.confidence } : {}),
          ...(cached.status ? { status: cached.status } : {}),
          ...(cached.reason ? { reason: cached.reason } : {}),
        };
        reportProgress(candidate.absPath, result);
        return result;
      },
      // Default concurrency of 4 for cloud APIs. Set `llm.concurrency: 1`
      // in config.json for local model servers (LM Studio, Ollama).
      llmConfig.concurrency ?? 1,
    );
  } else {
    // ── Batched path (with incremental cache) ────────────────────────────
    // Chunk eligible files into groups of `batchSize` and call
    // `extractGraphFromBodies` once per chunk. Cache hits are resolved
    // before chunking so they don't consume LLM tokens in the batch call.
    const rawResults: ExtractionRecord[] = new Array(eligible.length).fill(undefined);

    const chunkStarts: number[] = [];
    for (let start = 0; start < eligible.length; start += batchSize) chunkStarts.push(start);

    await concurrentMap(
      chunkStarts,
      async (start) => {
        if (signal?.aborted) return;
        const chunk = eligible.slice(start, start + batchSize);

        const reportChunkProgress = (): void => {
          for (let j = 0; j < chunk.length; j++) {
            const candidate = chunk[j];
            if (!candidate) continue;
            reportProgress(candidate.absPath, rawResults[start + j]);
          }
        };

        // Pre-resolve cache hits for this chunk; track which positions need LLM.
        const bodyHashes: string[] = chunk.map((c) => computeBodyHash(c.body));
        // Batch the cache lookup: one IN(...) query for the whole chunk instead
        // of N individual SELECTs. The map covers every ref in this chunk that
        // has any cached row; the per-position hash check happens below.
        const chunkCache: Map<string, LlmCacheEntry> =
          db && !reEnrich
            ? getLlmCacheEntriesByRefs(
                db,
                chunk.map((c) => c.absPath),
                cacheVariant,
              )
            : new Map();
        const needsLlm: boolean[] = chunk.map((c, j) => {
          if (!db || reEnrich) return true;
          const cached = chunkCache.get(c.absPath);
          // Hash mismatch → body changed, treat as cache miss.
          if (!cached || cached.bodyHash !== (bodyHashes[j] ?? "")) return true;
          try {
            const parsed = validateGraphCacheShape(JSON.parse(cached.resultJson));
            if (!parsed) return true;
            telemetry.cacheHits += 1;
            rawResults[start + j] = {
              absPath: c.absPath,
              type: c.type,
              bodyHash: bodyHashes[j] ?? "",
              entities: parsed.entities,
              relations: parsed.relations,
              ...(parsed.confidence !== undefined ? { confidence: parsed.confidence } : {}),
              ...(parsed.status ? { status: parsed.status } : {}),
              ...(parsed.reason ? { reason: parsed.reason } : {}),
            };
            return false;
          } catch {
            return true;
          }
        });

        // Secondary incremental path: reuse previous graph nodes when the body hash
        // still matches and DB cache is missing/stale/unavailable.
        if (!(reEnrich ?? false) && canReusePreviousGraph) {
          for (let j = 0; j < chunk.length; j++) {
            if (!needsLlm[j]) continue;
            const candidate = chunk[j];
            if (!candidate) continue;
            const reused = reuseGraphNode(previousNodes, candidate, bodyHashes[j] ?? "");
            if (!reused) continue;
            telemetry.cacheHits += 1;
            rawResults[start + j] = {
              absPath: candidate.absPath,
              type: candidate.type,
              bodyHash: bodyHashes[j] ?? "",
              entities: reused.entities,
              relations: reused.relations,
              ...(reused.confidence !== undefined ? { confidence: reused.confidence } : {}),
              ...(reused.status ? { status: reused.status } : {}),
              ...(reused.reason ? { reason: reused.reason } : {}),
            };
            if (db) {
              upsertLlmCacheEntry(db, candidate.absPath, bodyHashes[j] ?? "", JSON.stringify(reused), cacheVariant);
            }
            needsLlm[j] = false;
          }
        }

        const uncachedChunk = chunk.filter((_, j) => needsLlm[j]);
        if (uncachedChunk.length === 0) {
          reportChunkProgress();
          return;
        }

        const bodies = uncachedChunk.map((c) => c.body);
        telemetry.cacheMisses += uncachedChunk.length;

        // extractGraphFromBodies always returns an array of the same length
        // as bodies (it falls back per-asset for any missing indices).
        const batchExtractions = await graphExtract.extractGraphFromBodies(
          llmConfig,
          bodies,
          signal,
          config,
          onFallback,
          { batchState, telemetry: runtimeTelemetry },
        );

        // Map LLM results back to original positions and write cache entries.
        let llmIdx = 0;
        for (let j = 0; j < chunk.length; j++) {
          if (!needsLlm[j]) continue;
          const candidate = chunk[j];
          const extraction = batchExtractions[llmIdx++];
          if (!candidate || !extraction) continue;

          if (db) {
            upsertLlmCacheEntry(
              db,
              candidate.absPath,
              bodyHashes[j] ?? "",
              JSON.stringify({
                entities: extraction.entities,
                relations: extraction.relations,
                ...(extraction.confidence !== undefined ? { confidence: extraction.confidence } : {}),
                ...(extraction.status ? { status: extraction.status } : {}),
                ...(extraction.reason ? { reason: extraction.reason } : {}),
              }),
              cacheVariant,
            );
          }

          rawResults[start + j] = {
            absPath: candidate.absPath,
            type: candidate.type,
            bodyHash: bodyHashes[j] ?? "",
            entities: extraction.entities,
            relations: extraction.relations,
            ...(extraction.confidence !== undefined ? { confidence: extraction.confidence } : {}),
            ...(extraction.status ? { status: extraction.status } : {}),
            ...(extraction.reason ? { reason: extraction.reason } : {}),
          };
        }

        reportChunkProgress();
      },
      llmConfig.concurrency ?? 1,
    );

    extractionResults = rawResults;
  }

  for (const result of extractionResults) {
    if (!result) continue;
    nodes.push({
      path: result.absPath,
      type: result.type,
      bodyHash: result.bodyHash,
      entities: [...new Set(result.entities.map((entity) => entity.trim()).filter(Boolean))],
      relations: result.relations
        .map((r) => ({
          from: r.from.trim(),
          to: r.to.trim(),
          ...(r.type ? { type: r.type.trim() } : {}),
          ...(normalizeConfidence(r.confidence) !== undefined ? { confidence: normalizeConfidence(r.confidence) } : {}),
        }))
        .filter((relation) => relation.from && relation.to),
      ...(normalizeConfidence(result.confidence) !== undefined
        ? { confidence: normalizeConfidence(result.confidence) }
        : {}),
      status: result.status ?? (result.entities.length > 0 ? "extracted" : "empty"),
      reason: result.reason ?? (result.entities.length > 0 ? "none" : "no_graph_content"),
      extractionRunId,
    });
  }

  const mergedNodes = mergeGraphNodes(previousGraph.files, nodes, options.candidatePaths);
  const assetRefs = mergedNodes.map((node) => node.path);
  const deduped = deduplicateGraph(
    mergedNodes.map((node) => ({ entities: node.entities, relations: node.relations })),
    assetRefs,
  );
  telemetry.truncationCount = runtimeTelemetry.truncationCount ?? 0;
  telemetry.failureCount = runtimeTelemetry.failureCount ?? 0;
  telemetry.htmlErrorCount = runtimeTelemetry.htmlErrorCount ?? 0;
  telemetry.retryAttempts = runtimeTelemetry.retryAttempts ?? 0;

  const qualityConsidered = mergedNodes.length;
  const qualityExtracted = mergedNodes.filter((node) => node.status === "extracted" && node.entities.length > 0).length;
  const quality = computeGraphQualityTelemetry(
    qualityConsidered,
    qualityExtracted,
    deduped.entities.length,
    deduped.relations.length,
  );
  const warnings = buildLowQualityWarnings(quality, telemetry);
  for (const warning of warnings) warnVerbose(`graph extraction quality: ${warning}`);

  const graph: GraphFile = {
    schemaVersion: GRAPH_FILE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    stashRoot: primary.path,
    files: mergedNodes,
    entities: deduped.entities,
    relations: deduped.relations,
    quality,
    telemetry,
  };

  const written = writeGraphFile(primary.path, graph, db);
  warnVerbose(
    `graph extraction: ${written ? "persisted" : "did not persist"} graph for ${primary.path}; ` +
      `considered=${considered}, extractedThisRun=${extracted}, storedFiles=${mergedNodes.length}, ` +
      `entities=${deduped.entities.length}, relations=${deduped.relations.length}, coverage=${quality.extractionCoverage}.`,
  );

  return {
    considered,
    extracted,
    totalEntities,
    totalRelations,
    written,
    quality,
    telemetry,
    warnings,
  };
}

// ── Eligible-file detection ─────────────────────────────────────────────────

interface EligibleFile {
  absPath: string;
  type: string;
  body: string;
}

/**
 * Scan the primary stash for `memory:` and `knowledge:` markdown files
 * suitable for graph extraction. The directory layout convention is the
 * same one the rest of the indexer uses: `<stashRoot>/<type>/...`.
 *
 * Inferred-child memories (frontmatter `inferred: true`) are skipped — they
 * are already derived summaries, with no additional internal graph structure worth
 * extracting.
 *
 * Exported for direct unit testing.
 */
export function collectEligibleFiles(
  stashRoot: string,
  includeTypes: string[] = [...DEFAULT_GRAPH_EXTRACTION_INCLUDE_TYPES],
): EligibleFile[] {
  const out: EligibleFile[] = [];
  for (const rawType of includeTypes) {
    const type = rawType.trim().toLowerCase();
    if (!SUPPORTED_GRAPH_EXTRACTION_INCLUDE_TYPES.has(type)) continue;
    const stashDir = TYPE_DIRS[type];
    if (!stashDir) continue;
    const dir = path.join(stashRoot, stashDir);
    if (!fs.existsSync(dir)) continue;
    for (const filePath of walkMarkdownFiles(dir)) {
      let raw: string;
      try {
        raw = fs.readFileSync(filePath, "utf8");
      } catch {
        continue;
      }
      const parsed = parseFrontmatter(raw);
      // Skip inferred memory children — they are atomic and there's no
      // graph to extract from a single-fact body.
      if (type === "memory" && parsed.data.inferred === true) continue;
      const body = parsed.content.trim();
      if (!body) continue;
      out.push({ absPath: filePath, type, body });
    }
  }
  return out;
}

// ── Persistence ─────────────────────────────────────────────────────────────

/**
 * Persist graph rows into the SQLite index DB.
 */
function writeGraphFile(stashRoot: string, graph: GraphFile, db?: Database): boolean {
  if (!db) {
    warn("graph extraction: no database handle available; skipping graph persistence.");
    return false;
  }
  try {
    replaceStoredGraph(db, graph);
    return true;
  } catch (err) {
    warn(
      `graph extraction: failed to persist graph for ${stashRoot}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
