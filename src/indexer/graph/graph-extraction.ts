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
 * pipeline (see `src/indexer/graph/graph-boost.ts`) as a single boost component
 * inside the existing FTS5+boosts loop — there is NO second SearchHit
 * scorer and no parallel ranking track.
 *
 * Disabling — three preconditions must ALL hold for the pass to run:
 *   1. An LLM profile must be configured (no provider = no extraction). When
 *      absent, `resolveIndexPassExecution("graph", config).runner` is
 *      `undefined` and the pass short-circuits.
 *   2. The selected strategy's `processes.graphExtraction.enabled !== false`
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
 *   - LLM access is exclusively via the frozen runner returned by
 *     `resolveIndexPassExecution("graph", config)`.
 *   - The graph rows are an indexer artifact, NOT a user-visible
 *     asset. It does not have an asset ref, does not appear in search
 *     hits, and is not addressable via `akm show`. The persisted artifact
 *     lives in indexer-owned SQLite tables (`replaceStoredGraph` /
 *     `loadStoredGraphSnapshot` in `../db/graph-db.ts`), NOT as a file on
 *     disk (R-065 #3 — this comment previously described a retired
 *     `fs.writeFile`-based storage layout) — `writeAssetToSource` is
 *     reserved for asset writes (CLAUDE.md / spec §10 step 5).
 */

import fs from "node:fs";
import path from "node:path";
import { stashDirFor } from "../../core/asset/asset-placement";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { concurrentMap } from "../../core/concurrent";
import { type AkmConfig, getIndexPassConfig, loadConfig, resolveBatchSize } from "../../core/config/config";
import { ConfigError, rethrowIfTestIsolationError } from "../../core/errors";
import { warn, warnVerbose } from "../../core/warn";
import type { LoweringNotice } from "../../execution/resolved-request";
import { assertRunnerCredentials } from "../../integrations/agent/runner-dispatch";
import { isProcessEnabled } from "../../llm/feature-gate";
import type { GraphExtractionReason, GraphExtractionStatus, GraphRelation } from "../../llm/graph-extract";
import * as graphExtract from "../../llm/graph-extract";
import { type ResolvedIndexPassExecution, resolveIndexPassExecution } from "../../llm/index-passes";
import type { StructuredLlmRunner } from "../../llm/structured-call";
import type { Database } from "../../storage/database";
import type { LlmCacheEntry } from "../../storage/repositories/index-entry-types";
import {
  computeBodyHash,
  getLlmCacheEntriesByRefs,
  upsertLlmCacheEntry,
} from "../../storage/repositories/index-llm-cache-repository";
import { GRAPH_SCHEMA_VERSION } from "../../storage/repositories/index-schema";
import {
  acknowledgeExtractionQueueEntry,
  enqueueGraphExtraction,
  loadStoredGraphSnapshot,
  peekExtractionQueue,
  replaceStoredGraph,
} from "../db/graph-db";
import type { EnrichmentPassContext } from "../passes/pass-context";
import { walkMarkdownFiles } from "../walk/walker";
import { deduplicateGraph } from "./graph-dedup";
import type { GraphExtractionTelemetry, GraphFile, GraphFileNode, GraphQualityTelemetry } from "./graph-types";

/** Schema version for the persisted artifact — bumps trigger a full rebuild. */
export const GRAPH_FILE_SCHEMA_VERSION = GRAPH_SCHEMA_VERSION;

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
  /** Stable, secret-free execution-lowering diagnostics. */
  notices?: readonly Readonly<LoweringNotice>[];
}

export interface GraphExtractionPassOptions {
  candidatePaths?: ReadonlySet<string>;
  /** Invocation-owned asset types. Falls back to index.graph only for standalone index calls. */
  includeTypes?: string[];
  /** Invocation-owned batch size. Falls back to index.graph only for standalone index calls. */
  batchSize?: number;
  /**
   * When set (>= 0) and a DB is available, rank eligible files by
   * `utility_scores` DESC and process only the top-N per run (incremental
   * high-signal-first sweep). Unset = process all eligible (current behavior).
   */
  topN?: number;
  /**
   * Invocation-owned cap on chunks processed per asset (R12b + R20). Forwarded
   * to {@link graphExtract.extractGraphFromBody}/`extractGraphFromBodies`;
   * unset falls back to their own default there (currently 8).
   */
  maxChunksPerAsset?: number;
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
export type GraphExtractionPassContext = EnrichmentPassContext<GraphExtractionProgress, GraphExtractionPassOptions> & {
  /** Preferred invocation-owned symbolic runner. Omit only for standalone index passes. */
  llmRunner?: StructuredLlmRunner | null;
};

interface LoadedGraphFile {
  files: GraphFileNode[];
  telemetry?: GraphExtractionTelemetry;
}

/**
 * The frozen execution a graph call runs under: the invocation's own runner
 * when the caller passed one (it already passed its own gates), otherwise the
 * configured `graph` pass's. Undefined when the feature gate closes the pass.
 */
function selectGraphExecution(
  holder: { llmRunner?: StructuredLlmRunner | null },
  config: AkmConfig,
): { execution: ResolvedIndexPassExecution; featureConfig: AkmConfig } | undefined {
  if (Object.hasOwn(holder, "llmRunner")) {
    return {
      execution: Object.freeze({ runner: holder.llmRunner ?? undefined, notices: Object.freeze([]) }),
      featureConfig: { ...config, index: { ...config.index, graph: { ...config.index?.graph, enabled: true } } },
    };
  }
  if (!isProcessEnabled("index", "graph_extraction", config)) return undefined;
  return { execution: resolveIndexPassExecution("graph", config), featureConfig: config };
}

const EMPTY_RESULT: GraphExtractionResult = {
  considered: 0,
  extracted: 0,
  totalEntities: 0,
  totalRelations: 0,
  written: false,
  quality: {
    consideredFiles: 0,
    extractedFiles: 0,
    entityCount: 0,
    relationCount: 0,
    extractionCoverage: 0,
    density: 0,
  },
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

/**
 * Max number of lazy-extraction queue rows drained per pass (#624-P3). Bounds
 * per-run work so a large backlog is spread across runs rather than processed
 * all at once. Generous default — the queue is normally near-empty.
 */
const GRAPH_EXTRACTION_QUEUE_DRAIN_LIMIT = 100;

const SUPPORTED_GRAPH_EXTRACTION_INCLUDE_TYPES = new Set([
  "memory",
  "knowledge",
  "skill",
  "command",
  "agent",
  "workflow",
  "lesson",
  "task",
]);

type GraphCacheShape = {
  entities: string[];
  relations: Array<{ from: string; to: string; type?: string; confidence?: number }>;
  confidence?: number;
  status?: GraphExtractionStatus;
  reason?: GraphExtractionReason;
};

type EligibleGraphPlan =
  | {
      kind: "cache-hit";
      candidate: EligibleFile;
      bodyHash: string;
      cached: GraphCacheShape;
      /** A previous graph node supplied the hit and should seed the DB cache. */
      persistCache: boolean;
    }
  | { kind: "model"; candidate: EligibleFile; bodyHash: string };

type ExtractionRecord = GraphCacheShape & { absPath: string; type: string; bodyHash: string };

const GRAPH_CACHE_VARIANT_PREFIX = "graph-extraction";

function normalizeConfidence(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return Math.max(0, Math.min(1, raw));
}

export function getGraphExtractorId(config: { model: string; batchSize: number; includeTypes: string[] }): string {
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

/**
 * Failure-rate abort for the extraction run (R2), modelled on consolidate's
 * chunk-level guard (`ABORT_MIN_CHUNKS`/`ABORT_FAILURE_RATE` in
 * consolidate.ts, C-6/#392): rate-based over a minimum sample so a couple of
 * transient per-file failures cannot abort a run that would otherwise
 * recover, while a systemically dead provider stops burning through the
 * rest of the eligible set. The existing "one failure must not abort the
 * rest" behaviour for individual files is untouched — this only stops
 * further model calls once the failure rate itself is the signal.
 */
const GRAPH_EXTRACTION_ABORT_MIN_ATTEMPTS = 4;
const GRAPH_EXTRACTION_ABORT_FAILURE_RATE = 0.5;

interface GraphExtractionAbortState {
  attempts: number;
  failures: number;
  aborted: boolean;
  message?: string;
}

/** Records one attempted (non-cache-hit) model call and flips `aborted` once the failure-rate threshold is crossed. */
function recordGraphExtractionAttempt(state: GraphExtractionAbortState, failed: boolean): void {
  if (state.aborted) return;
  state.attempts += 1;
  if (failed) state.failures += 1;
  if (state.attempts < GRAPH_EXTRACTION_ABORT_MIN_ATTEMPTS) return;
  const failureRate = state.failures / state.attempts;
  if (failureRate < GRAPH_EXTRACTION_ABORT_FAILURE_RATE) return;
  state.aborted = true;
  state.message =
    `graph extraction aborted — failure rate ${(failureRate * 100).toFixed(0)}% over ${state.attempts} ` +
    `attempt(s) (>= ${GRAPH_EXTRACTION_ABORT_FAILURE_RATE * 100}% threshold). LLM may be unavailable.`;
  warn(state.message);
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

/**
 * A `"failed"` extraction (provider error, invalid JSON, context overflow —
 * see {@link GraphExtractionStatus}) must never be reused as a cache hit or
 * re-persisted as one. R2: a dead provider upserted ~30,900 rows shaped
 * `{"entities":[],"relations":[],"status":"failed","reason":"llm_error"}`,
 * and both hit paths (the `llm_enrichment_cache` lookup and `reuseGraphNode`
 * over the previous graph) validated the shape without checking `status`, so
 * 92% of the persisted graph became a permanent hit that never retried. A
 * failed result becomes a miss naturally and is overwritten on the next
 * successful extraction; existing failed rows are left on disk untouched.
 */
function isFailedExtractionStatus(status: GraphExtractionStatus | undefined): boolean {
  return status === "failed";
}

function loadGraphFile(stashRoot: string, db: Database): LoadedGraphFile {
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

/** A previous node (validated by {@link loadGraphFile}) for this exact body, unless it failed. */
function reuseGraphNode(
  previousNodes: Map<string, GraphFileNode>,
  candidate: { absPath: string; type: string },
  bodyHash: string,
): GraphCacheShape | undefined {
  const node = previousNodes.get(candidate.absPath);
  if (!node || node.type !== candidate.type || node.bodyHash !== bodyHash) return undefined;
  if (isFailedExtractionStatus(node.status)) return undefined;
  return {
    entities: node.entities,
    relations: node.relations,
    confidence: node.confidence,
    ...(node.status ? { status: node.status } : {}),
    ...(node.reason ? { reason: node.reason } : {}),
  };
}

function planEligibleGraphExtractions(args: {
  eligible: EligibleFile[];
  db: Database;
  reEnrich: boolean | undefined;
  cacheVariant: string;
  previousNodes: Map<string, GraphFileNode>;
  canReusePreviousGraph: boolean;
}): EligibleGraphPlan[] {
  const { eligible, db, reEnrich, cacheVariant, previousNodes, canReusePreviousGraph } = args;
  const cacheEntries = reEnrich
    ? new Map<string, LlmCacheEntry>()
    : getLlmCacheEntriesByRefs(
        db,
        eligible.map((candidate) => candidate.absPath),
        cacheVariant,
      );

  return eligible.map((candidate) => {
    const bodyHash = computeBodyHash(candidate.body);
    if (reEnrich) return { kind: "model", candidate, bodyHash };
    const entry = cacheEntries.get(candidate.absPath);
    if (entry?.bodyHash === bodyHash) {
      try {
        const cached = validateGraphCacheShape(JSON.parse(entry.resultJson));
        if (cached && !isFailedExtractionStatus(cached.status)) {
          return { kind: "cache-hit", candidate, bodyHash, cached, persistCache: false };
        }
      } catch {
        // A corrupt cache row is a miss.
      }
    }
    const reused = canReusePreviousGraph ? reuseGraphNode(previousNodes, candidate, bodyHash) : undefined;
    return reused
      ? { kind: "cache-hit", candidate, bodyHash, cached: reused, persistCache: true }
      : { kind: "model", candidate, bodyHash };
  });
}

function extractionRecord(candidate: EligibleFile, bodyHash: string, shape: GraphCacheShape): ExtractionRecord {
  return {
    absPath: candidate.absPath,
    type: candidate.type,
    bodyHash,
    entities: shape.entities,
    relations: shape.relations,
    ...(shape.confidence !== undefined ? { confidence: shape.confidence } : {}),
    ...(shape.status ? { status: shape.status } : {}),
    ...(shape.reason ? { reason: shape.reason } : {}),
  };
}

/**
 * Run the planned extractions in chunks of `batchSize`: cache hits are taken
 * as-is, and each chunk's model plans go to the provider in one
 * `extractGraphFromBodies` call (a one-body call is the per-asset path).
 */
async function extractGraphBatches(args: {
  plans: EligibleGraphPlan[];
  batchSize: number;
  signal: AbortSignal | undefined;
  db: Database;
  cacheVariant: string;
  telemetry: GraphExtractionTelemetry;
  llmRunner: StructuredLlmRunner;
  featureConfig: AkmConfig;
  onFallback: (event: { feature: string; reason: string }) => void;
  batchState: graphExtract.GraphBatchState;
  runtimeTelemetry: graphExtract.GraphRuntimeTelemetry;
  abortState: GraphExtractionAbortState;
  onNotices: (notices: readonly Readonly<LoweringNotice>[]) => void;
  reportProgress: (currentPath: string | undefined, result: ExtractionRecord | undefined) => void;
  maxChunksPerAsset?: number;
}): Promise<{ results: Array<ExtractionRecord | undefined>; configFailure?: ConfigError }> {
  const {
    plans,
    batchSize,
    signal,
    db,
    cacheVariant,
    telemetry,
    llmRunner,
    featureConfig,
    onFallback,
    abortState,
    batchState,
    runtimeTelemetry,
    onNotices,
    reportProgress,
    maxChunksPerAsset,
  } = args;
  const results: Array<ExtractionRecord | undefined> = new Array(plans.length).fill(undefined);
  const chunkStarts: number[] = [];
  for (let start = 0; start < plans.length; start += batchSize) chunkStarts.push(start);
  let configFailure: ConfigError | undefined;

  await concurrentMap(
    chunkStarts,
    async (start) => {
      if (signal?.aborted) return;
      const chunk = plans.slice(start, start + batchSize);
      const reportChunkProgress = (): void => {
        for (const [j, plan] of chunk.entries()) reportProgress(plan.candidate.absPath, results[start + j]);
      };

      const modelPlans: Array<{ plan: EligibleGraphPlan; offset: number }> = [];
      for (const [offset, plan] of chunk.entries()) {
        if (plan.kind === "model") {
          modelPlans.push({ plan, offset });
          continue;
        }
        telemetry.cacheHits += 1;
        results[start + offset] = extractionRecord(plan.candidate, plan.bodyHash, plan.cached);
        // A reused previous node (never a failed one) seeds the cache.
        if (plan.persistCache) {
          upsertLlmCacheEntry(db, plan.candidate.absPath, plan.bodyHash, JSON.stringify(plan.cached), cacheVariant);
        }
      }
      if (modelPlans.length === 0 || abortState.aborted) {
        reportChunkProgress();
        return;
      }
      telemetry.cacheMisses += modelPlans.length;
      let batchExtractions: Awaited<ReturnType<typeof graphExtract.extractGraphFromBodies>>;
      try {
        batchExtractions = await graphExtract.extractGraphFromBodies(
          llmRunner,
          modelPlans.map(({ plan }) => plan.candidate.body),
          signal,
          featureConfig,
          onFallback,
          {
            batchState,
            telemetry: runtimeTelemetry,
            onNotices,
            ...(maxChunksPerAsset != null ? { maxChunksPerAsset } : {}),
          },
        );
      } catch (error) {
        if (error instanceof ConfigError) {
          configFailure ??= error;
          return;
        }
        throw error;
      }

      let dispatchHadResult = false;
      let dispatchAllFailed = true;
      for (const [i, { plan, offset }] of modelPlans.entries()) {
        const extraction = batchExtractions[i];
        if (!extraction) continue;
        const cacheShape: GraphCacheShape = {
          entities: extraction.entities,
          relations: extraction.relations,
          ...(extraction.confidence !== undefined ? { confidence: extraction.confidence } : {}),
          ...(extraction.status ? { status: extraction.status } : {}),
          ...(extraction.reason ? { reason: extraction.reason } : {}),
        };
        dispatchHadResult = true;
        if (!isFailedExtractionStatus(cacheShape.status)) {
          dispatchAllFailed = false;
          upsertLlmCacheEntry(db, plan.candidate.absPath, plan.bodyHash, JSON.stringify(cacheShape), cacheVariant);
        }
        results[start + offset] = extractionRecord(plan.candidate, plan.bodyHash, cacheShape);
      }
      // One attempt per `extractGraphFromBodies` dispatch (this chunk's batch
      // call), not one per file it covers — mirrors consolidate.ts's
      // totalChunksProcessed++/totalChunksFailed, which count once per chunk
      // regardless of how many memories are in it. Counting per file let a
      // single batched provider_error satisfy GRAPH_EXTRACTION_ABORT_MIN_ATTEMPTS
      // after one HTTP failure whenever graphExtractionBatchSize >= 4.
      if (dispatchHadResult) recordGraphExtractionAttempt(abortState, dispatchAllFailed);
      reportChunkProgress();
    },
    llmRunner.connection.concurrency ?? 1,
  );

  return { results, ...(configFailure ? { configFailure } : {}) };
}

type QueuedGraphPlan =
  | { kind: "deferred"; filePath: string; queuedBodyHash: string; priority: number }
  | { kind: "discard"; filePath: string; queuedBodyHash: string; priority: number }
  | { kind: "hit"; filePath: string; queuedBodyHash: string; currentBodyHash: string; priority: number }
  | { kind: "model"; filePath: string; queuedBodyHash: string; currentBodyHash: string; priority: number };

function readCurrentGraphBodyHash(filePath: string): string | undefined {
  try {
    const body = parseFrontmatter(fs.readFileSync(filePath, "utf8")).content.trim();
    return body ? computeBodyHash(body) : undefined;
  } catch {
    return undefined;
  }
}

function planQueuedGraphExtractions(args: {
  db: Database;
  stashRoot: string;
  previousNodes: Map<string, GraphFileNode>;
  signal: AbortSignal | undefined;
  reEnrich: boolean | undefined;
}): QueuedGraphPlan[] {
  const { db, stashRoot, previousNodes, signal, reEnrich } = args;
  return peekExtractionQueue(db, stashRoot, GRAPH_EXTRACTION_QUEUE_DRAIN_LIMIT).map((queued): QueuedGraphPlan => {
    const base = { filePath: queued.filePath, queuedBodyHash: queued.bodyHash, priority: queued.priority };
    if (signal?.aborted) return { kind: "deferred", ...base };
    const currentBodyHash = readCurrentGraphBodyHash(queued.filePath);
    if (!currentBodyHash) return { kind: "discard", ...base };
    const type = inferGraphTypeForPath(stashRoot, queued.filePath) ?? "memory";
    const hit = !reEnrich && reuseGraphNode(previousNodes, { absPath: queued.filePath, type }, currentBodyHash);
    return { kind: hit ? "hit" : "model", ...base, currentBodyHash };
  });
}

interface QueuedGraphExecution {
  graphChanged: boolean;
  acknowledgements: Array<{ filePath: string; queuedBodyHash: string }>;
}

async function executeQueuedGraphPlans(args: {
  plans: QueuedGraphPlan[];
  db: Database;
  stashRoot: string;
  featureConfig: AkmConfig;
  signal: AbortSignal | undefined;
  llmRunner: StructuredLlmRunner;
  onNotices: (notices: readonly Readonly<LoweringNotice>[]) => void;
}): Promise<QueuedGraphExecution> {
  const { plans, db, stashRoot, featureConfig, signal, llmRunner, onNotices } = args;
  let graphChanged = false;
  const acknowledgements: QueuedGraphExecution["acknowledgements"] = [];
  for (const plan of plans) {
    if (signal?.aborted || plan.kind === "deferred") break;
    // The body this plan settled: none for a discard (the file was gone or empty).
    let settledBodyHash: string | undefined;
    if (plan.kind === "model") {
      const outcome = await extractGraphForSingleFileRevision(db, stashRoot, plan.filePath, {
        config: featureConfig,
        signal,
        llmRunner,
        onNotices,
      });
      if (!outcome.written) continue;
      graphChanged = true;
      settledBodyHash = outcome.bodyHash;
    } else if (plan.kind === "hit") {
      settledBodyHash = plan.currentBodyHash;
    }
    // A body that changed since it was planned goes back on the queue.
    const currentBodyHash = readCurrentGraphBodyHash(plan.filePath);
    if (currentBodyHash !== settledBodyHash) {
      if (currentBodyHash) enqueueGraphExtraction(db, stashRoot, plan.filePath, currentBodyHash, plan.priority);
      continue;
    }
    acknowledgements.push({ filePath: plan.filePath, queuedBodyHash: plan.queuedBodyHash });
  }
  return { graphChanged, acknowledgements };
}

function acknowledgeQueuedGraphPlans(db: Database, stashRoot: string, execution: QueuedGraphExecution): void {
  for (const intent of execution.acknowledgements) {
    acknowledgeExtractionQueueEntry(db, stashRoot, intent.filePath, intent.queuedBodyHash);
  }
}

/**
 * Top-level entry point. Returns a no-op result when the pass is disabled.
 *
 * Three preconditions — ALL must hold for the pass to run:
 *
 *   1. **Provider configured** — an LLM profile must be selectable. Without a
 *      configured provider, `resolveIndexPassExecution("graph", config).runner`
 *      is `undefined` (the pass cannot run because there is no model to call).
 *   2. **Feature gate** — the selected strategy's `processes.graphExtraction.enabled`
 *      (defaults to `true`). When `false`, no network call may issue regardless
 *      of per-pass settings.
 *   3. **Per-pass gate** — `index.graph.llm` (defaults to `true`). When
 *      `false`, the indexer simply skips this pass for the current run.
 *
 * If any of the three is missing or `false`, this function short-circuits
 * to an empty no-op result, leaving any existing persisted graph untouched.
 *
 * Eligible files are chunked by the resolved batch size
 * (`graphExtractionBatchSize`) and each chunk is one `extractGraphFromBodies`
 * call; a batch size of 1 is one call per asset.
 */
export async function runGraphExtractionPass(ctx: GraphExtractionPassContext): Promise<GraphExtractionResult> {
  const { config, sources, signal, db, reEnrich, onProgress, options = {} } = ctx;
  // Gate 1 — the feature gate (selected strategy's
  // processes.graphExtraction.enabled, default enabled).
  const selection = selectGraphExecution(ctx, config);
  if (!selection) return { ...EMPTY_RESULT };

  const noticesByKey = new Map<string, Readonly<LoweringNotice>>();
  const onNotices = (notices: readonly Readonly<LoweringNotice>[]): void => {
    for (const notice of notices) noticesByKey.set(JSON.stringify(notice), notice);
  };
  const emptyResult = (): GraphExtractionResult => ({
    ...EMPTY_RESULT,
    ...(noticesByKey.size > 0 ? { notices: Object.freeze([...noticesByKey.values()]) } : {}),
  });

  // Gate 2 — per-pass opt-out (#208). Retain the whole frozen resolution so
  // selection-time lowering notices cannot be separated from the runner.
  onNotices(selection.execution.notices);
  const llmRunner = selection.execution.runner;
  if (!llmRunner) {
    const reason =
      getIndexPassConfig(config.index, "graph")?.enabled === false
        ? "index.graph.enabled is false"
        : "no LLM engine is configured";
    warnVerbose(`graph extraction: skipped because ${reason}.`);
    return emptyResult();
  }
  const { featureConfig } = selection;
  // The pass only writes to the primary (working) stash. Read-only caches
  // (git, npm, website) are deliberately untouched — the graph artifact for
  // those sources would be clobbered by the next sync().
  const primary = sources[0];
  if (!primary) {
    warnVerbose("graph extraction: skipped because no primary stash source is available.");
    return emptyResult();
  }
  if (!db) {
    warn("graph extraction: no database handle available; skipping graph persistence.");
    return emptyResult();
  }

  const includeTypes = options.includeTypes ?? getGraphExtractionIncludeTypes(config);
  let previousGraph = loadGraphFile(primary.path, db);
  const previousNodes = new Map(previousGraph.files.map((node) => [node.path, node]));
  const batchSize = resolveBatchSize(
    options.batchSize ?? getIndexPassConfig(config.index, "graph")?.graphExtractionBatchSize,
    llmRunner.connection.contextLength,
  );
  const extractorId = getGraphExtractorId({ model: llmRunner.connection.model, batchSize, includeTypes });
  const canReusePreviousGraph = previousGraph.telemetry?.extractorId === extractorId;
  const queuePlans = planQueuedGraphExtractions({
    db,
    stashRoot: primary.path,
    previousNodes,
    signal,
    reEnrich,
  });
  const queuedPaths = new Set(queuePlans.map((plan) => plan.filePath));
  let eligible = collectEligibleFiles(primary.path, includeTypes).filter(
    (candidate) =>
      (!options.candidatePaths || options.candidatePaths.has(candidate.absPath)) && !queuedPaths.has(candidate.absPath),
  );
  // P2 (#624): when topN is set, rank the (already candidate-filtered)
  // eligible set by utility_scores DESC and keep only the top-N. Unset issues
  // no ranking query. Ranking composes WITH the candidatePaths filter:
  // scoped-then-ranked-then-sliced.
  if (options.topN != null && options.topN >= 0) {
    eligible = rankCandidatesByUtility(db, eligible).slice(0, options.topN);
  }
  const considered = eligible.length;
  const eligiblePlans = planEligibleGraphExtractions({
    eligible,
    db,
    reEnrich,
    cacheVariant: extractorId,
    previousNodes,
    canReusePreviousGraph,
  });

  if (signal?.aborted) return emptyResult();

  // Validate exactly once iff classification found real model work. Queue
  // acknowledgements, cache writes, and graph replacement all happen after
  // this boundary, so a missing credential cannot partially mutate a batch.
  if ([...queuePlans, ...eligiblePlans].some((plan) => plan.kind === "model")) assertRunnerCredentials(llmRunner);

  const queueExecution = await executeQueuedGraphPlans({
    plans: queuePlans,
    db,
    stashRoot: primary.path,
    featureConfig,
    signal,
    llmRunner,
    onNotices,
  });
  if (queueExecution.graphChanged) {
    previousGraph = loadGraphFile(primary.path, db);
  }

  if (considered === 0) {
    acknowledgeQueuedGraphPlans(db, primary.path, queueExecution);
    const scoped = options.candidatePaths ? ` matching ${options.candidatePaths.size} candidate path(s)` : "";
    warnVerbose(
      `graph extraction: skipped because no eligible files${scoped} were found under ${primary.path}. ` +
        `includeTypes=${includeTypes.join(",")}`,
    );
    return emptyResult();
  }

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

  const extractionRunId = crypto.randomUUID();
  const telemetry: GraphExtractionTelemetry = {
    extractorId,
    extractionRunId,
    model: llmRunner.connection.model,
    promptVersion: graphExtract.GRAPH_EXTRACT_PROMPT_VERSION,
    batchSize,
    cacheHits: 0,
    cacheMisses: 0,
    truncationCount: 0,
    failureCount: 0,
    htmlErrorCount: 0,
    retryAttempts: 0,
    nonArrayBatchFailures: 0,
  };
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
  const abortState: GraphExtractionAbortState = { attempts: 0, failures: 0, aborted: false };
  warnVerbose(
    `graph extraction: starting for ${considered} eligible file(s) under ${primary.path}; ` +
      `includeTypes=${includeTypes.join(",")}, batchSize=${batchSize}, concurrency=${llmRunner.connection.concurrency ?? 1}, ` +
      `reEnrich=${reEnrich === true}, candidateScoped=${options.candidatePaths ? "true" : "false"}.`,
  );

  const { results, configFailure } = await extractGraphBatches({
    plans: eligiblePlans,
    batchSize,
    signal,
    db,
    cacheVariant: extractorId,
    telemetry,
    llmRunner,
    featureConfig,
    onFallback: (evt) => warn(`[akm] LLM fallback for ${evt.feature}: ${evt.reason}`),
    batchState: { batchingDisabled: false, nonArrayBatchFailures: 0 },
    runtimeTelemetry,
    abortState,
    onNotices,
    reportProgress,
    ...(options.maxChunksPerAsset != null ? { maxChunksPerAsset: options.maxChunksPerAsset } : {}),
  });
  if (configFailure) throw configFailure;
  acknowledgeQueuedGraphPlans(db, primary.path, queueExecution);

  const nodes = results.flatMap((result) => (result ? [toGraphNode(result, extractionRunId)] : []));
  const queuedNodes = options.candidatePaths
    ? []
    : previousGraph.files.filter(
        (node) =>
          queuePlans.some((plan) => plan.filePath === node.path && plan.kind !== "discard") &&
          !nodes.some((candidate) => candidate.path === node.path),
      );
  telemetry.truncationCount = runtimeTelemetry.truncationCount ?? 0;
  telemetry.truncatedChunks = runtimeTelemetry.truncatedChunks ?? 0;
  telemetry.failureCount = runtimeTelemetry.failureCount ?? 0;
  telemetry.htmlErrorCount = runtimeTelemetry.htmlErrorCount ?? 0;
  telemetry.retryAttempts = runtimeTelemetry.retryAttempts ?? 0;
  telemetry.nonArrayBatchFailures = runtimeTelemetry.nonArrayBatchFailures ?? 0;
  telemetry.aborted = abortState.aborted;

  const graph = buildGraphFile(
    primary.path,
    mergeGraphNodes(previousGraph.files, [...queuedNodes, ...nodes], options.candidatePaths),
    telemetry,
  );
  const { quality } = graph;
  const warnings = buildLowQualityWarnings(quality, telemetry);
  if (abortState.message) warnings.push(abortState.message);
  for (const warning of warnings) warnVerbose(`graph extraction quality: ${warning}`);

  const written = writeGraphFile(db, graph);
  warnVerbose(
    `graph extraction: ${written ? "persisted" : "did not persist"} graph for ${primary.path}; ` +
      `considered=${considered}, extractedThisRun=${extracted}, storedFiles=${graph.files.length}, ` +
      `entities=${graph.entities.length}, relations=${graph.relations.length}, coverage=${quality.extractionCoverage}.`,
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
    ...(noticesByKey.size > 0 ? { notices: Object.freeze([...noticesByKey.values()]) } : {}),
  };
}

/** The persisted node for one extraction outcome (entities and relations trimmed, deduplicated). */
function toGraphNode(record: ExtractionRecord, extractionRunId: string): GraphFileNode {
  const confidence = normalizeConfidence(record.confidence);
  return {
    path: record.absPath,
    type: record.type,
    bodyHash: record.bodyHash,
    entities: [...new Set(record.entities.map((entity) => entity.trim()).filter(Boolean))],
    relations: record.relations
      .map((r) => ({
        from: r.from.trim(),
        to: r.to.trim(),
        ...(r.type ? { type: r.type.trim() } : {}),
        ...(normalizeConfidence(r.confidence) !== undefined ? { confidence: normalizeConfidence(r.confidence) } : {}),
      }))
      .filter((relation) => relation.from && relation.to),
    ...(confidence !== undefined ? { confidence } : {}),
    status: record.status ?? (record.entities.length > 0 ? "extracted" : "empty"),
    reason: record.reason ?? (record.entities.length > 0 ? "none" : "no_graph_content"),
    extractionRunId,
  };
}

/** The graph artifact for `files`: deduplicated entities/relations plus quality telemetry. */
function buildGraphFile(
  stashRoot: string,
  files: GraphFileNode[],
  telemetry?: GraphExtractionTelemetry,
): GraphFile & Required<Pick<GraphFile, "entities" | "relations" | "quality">> {
  const deduped = deduplicateGraph(
    files.map((node) => ({ entities: node.entities, relations: node.relations })),
    files.map((node) => node.path),
  );
  const extractedFiles = files.filter((node) => node.status === "extracted" && node.entities.length > 0).length;
  return {
    schemaVersion: GRAPH_FILE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    stashRoot,
    files,
    entities: deduped.entities,
    relations: deduped.relations,
    quality: computeGraphQualityTelemetry(
      files.length,
      extractedFiles,
      deduped.entities.length,
      deduped.relations.length,
    ),
    ...(telemetry ? { telemetry } : {}),
  };
}

/**
 * Injected LLM seam for {@link extractGraphForSingleFile}. Mirrors the shape of
 * a single {@link graphExtract.extractGraphFromBody} result. Tests supply this
 * directly so the per-file extractor can be exercised without a real provider.
 */
export type SingleFileLlmOverride = (body: string) => Promise<{
  entities: string[];
  relations: Array<{ from: string; to: string; type?: string; confidence?: number }>;
  confidence?: number;
}>;

interface SingleFileGraphOptions {
  llmOverride?: SingleFileLlmOverride;
  llmRunner?: StructuredLlmRunner | null;
  onNotices?: (notices: readonly Readonly<LoweringNotice>[]) => void;
  signal?: AbortSignal;
  config?: AkmConfig;
}

type SingleFileGraphRevision = { written: false } | { written: true; bodyHash: string };

/**
 * Infer the asset type (`memory`, `knowledge`, …) for a path from the stash
 * directory segment it lives under. Returns the matching include-type, or
 * `undefined` when the path is not under a known graph-eligible type dir.
 */
function inferGraphTypeForPath(stashRoot: string, absPath: string): string | undefined {
  const rel = path.relative(stashRoot, absPath);
  const firstSeg = rel.split(path.sep)[0];
  if (!firstSeg) return undefined;
  for (const type of SUPPORTED_GRAPH_EXTRACTION_INCLUDE_TYPES) {
    if (stashDirFor(type) === firstSeg) return type;
  }
  return undefined;
}

/**
 * #624-P3 — extract graph data for a SINGLE file and merge it into the stored
 * graph WITHOUT clobbering other files' rows.
 *
 * Re-reads the body from disk at call time (the queued body_hash is NOT trusted
 * blindly — the file may have been deleted or changed since enqueue) and skips
 * silently (returns `false`) when the file is gone or empty. Resolves a frozen
 * LLM execution via {@link resolveIndexPassExecution} (model-available guard:
 * returns `false` when no provider is configured) UNLESS a caller supplies
 * `opts.llmRunner` or `opts.llmOverride`. Those seams let a command reuse an
 * invocation-owned selection or provide a test extractor without re-resolving.
 *
 * Returns `true` when a graph row was written for the file, `false` on any
 * skip (missing file, empty body, unknown type, no model, or extraction error).
 */
async function extractGraphForSingleFileRevision(
  db: Database,
  stashRoot: string,
  filePath: string,
  opts?: SingleFileGraphOptions,
): Promise<SingleFileGraphRevision> {
  try {
    // Re-read from disk — never trust a stale queued body.
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      return { written: false }; // file gone / unreadable → silent skip
    }
    const parsed = parseFrontmatter(raw);
    const body = parsed.content.trim();
    if (!body) return { written: false };

    const type = inferGraphTypeForPath(stashRoot, filePath) ?? "memory";
    const effectiveHash = computeBodyHash(body);

    // Extract — via the injected seam, or the real per-asset path.
    let extraction: { entities: string[]; relations: GraphRelation[]; confidence?: number };
    if (opts?.llmOverride) {
      extraction = await opts.llmOverride(body);
    } else {
      const selection = selectGraphExecution(opts ?? {}, opts?.config ?? loadConfig());
      if (!selection) return { written: false };
      opts?.onNotices?.(selection.execution.notices);
      const llmRunner = selection.execution.runner;
      if (!llmRunner) return { written: false }; // model-available guard
      extraction = await graphExtract.extractGraphFromBody(
        llmRunner,
        body,
        opts?.signal,
        selection.featureConfig,
        undefined,
        { ...(opts?.onNotices ? { onNotices: opts.onNotices } : {}) },
      );
    }

    // A single-file refresh records only entities, relations and confidence;
    // its status follows from the entities that survive trimming.
    const entities = [...new Set(extraction.entities.map((e) => e.trim()).filter(Boolean))];
    const node = toGraphNode(
      {
        absPath: filePath,
        type,
        bodyHash: effectiveHash,
        entities,
        relations: extraction.relations,
        ...(extraction.confidence !== undefined ? { confidence: extraction.confidence } : {}),
      },
      crypto.randomUUID(),
    );

    // Merge with the previously-stored nodes, scoping the refresh to JUST this
    // path so other files' rows are preserved (and graph_meta counts refresh).
    const previousGraph = loadGraphFile(stashRoot, db);
    const graph = buildGraphFile(
      stashRoot,
      mergeGraphNodes(previousGraph.files, [node], new Set([filePath])),
      previousGraph.telemetry,
    );
    return writeGraphFile(db, graph) ? { written: true, bodyHash: effectiveHash } : { written: false };
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    rethrowIfTestIsolationError(err);
    // A genuine extraction/write failure, distinct from the deliberate
    // "nothing to do" skips above (missing file, empty body, no model). Warn
    // so it is visible instead of looking identical to a no-op skip; the
    // entry stays queued and is retried on the next pass.
    warn(
      `graph extraction: failed to extract graph for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { written: false };
  }
}

export async function extractGraphForSingleFile(
  db: Database,
  stashRoot: string,
  filePath: string,
  opts?: SingleFileGraphOptions,
): Promise<boolean> {
  return (await extractGraphForSingleFileRevision(db, stashRoot, filePath, opts)).written;
}

// ── Eligible-file detection ─────────────────────────────────────────────────

/**
 * Rank eligible graph-extraction candidates by their entry `utility_scores`,
 * highest first, for the incremental high-signal-first sweep (P2 of #624).
 *
 * The join is READ-ONLY (`entries.file_path = candidate.absPath`, then
 * `entries.id -> utility_scores.entry_id`) and does NOT re-couple the graph
 * rows to `entries`. It reads the GLOBAL `utility_scores` table (not the
 * per-scope `utility_scores_scoped`), so ranking is corpus-wide.
 *
 * Candidates with no matching `entries` row, or an entry with no
 * `utility_scores` row, get an effective utility of 0 (LEFT JOIN + COALESCE)
 * and sort LAST — they are deprioritized, never dropped, so a `topN >= total`
 * slice still includes them and they remain reachable on later runs.
 *
 * Ties (equal utility) break by `file_path` ASC for deterministic output.
 * Returns a NEW array; the input is not mutated. SQLite's ~999 bound-parameter
 * cap is respected by chunking the `IN (...)` lookup at 500.
 *
 * Exported for direct unit testing.
 */
export function rankCandidatesByUtility(db: Database, candidates: EligibleFile[]): EligibleFile[] {
  if (!db || candidates.length === 0) return candidates;

  const utilityByPath = new Map<string, number>();
  const CHUNK = 500;
  for (let start = 0; start < candidates.length; start += CHUNK) {
    const chunk = candidates.slice(start, start + CHUNK);
    const paths = chunk.map((c) => c.absPath);
    const placeholders = paths.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT e.file_path AS file_path, COALESCE(MAX(u.utility), 0) AS utility
           FROM entries e
           LEFT JOIN utility_scores u ON u.entry_id = e.id
          WHERE e.file_path IN (${placeholders})
          GROUP BY e.file_path`,
      )
      .all(...paths) as Array<{ file_path: string; utility: number }>;
    for (const row of rows) {
      utilityByPath.set(row.file_path, row.utility ?? 0);
    }
  }

  return [...candidates].sort((a, b) => {
    const ua = utilityByPath.get(a.absPath) ?? 0;
    const ub = utilityByPath.get(b.absPath) ?? 0;
    if (ub !== ua) return ub - ua; // utility DESC
    return a.absPath < b.absPath ? -1 : a.absPath > b.absPath ? 1 : 0; // tie-break: path ASC
  });
}

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
    const stashDir = stashDirFor(type);
    if (!stashDir) continue;
    const dir = path.join(stashRoot, stashDir);
    if (!fs.existsSync(dir)) continue;
    const walked = walkMarkdownFiles(dir);
    if (!walked.complete) {
      warn(`graph extraction: directory scan under ${dir} is incomplete — some files may be missing`);
    }
    for (const filePath of walked.files) {
      let raw: string;
      try {
        raw = fs.readFileSync(filePath, "utf8");
      } catch (err) {
        warn(
          `graph extraction: failed to read candidate file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
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
function writeGraphFile(db: Database, graph: GraphFile): boolean {
  try {
    replaceStoredGraph(db, graph);
    return true;
  } catch (err) {
    warn(
      `graph extraction: failed to persist graph for ${graph.stashRoot}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
