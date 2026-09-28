// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Graph-extraction pass for `akm index` (#207).
 *
 * Walks the primary stash for `memory:` and `knowledge:` assets, asks the
 * configured LLM to extract entities and relations from each one, and
 * persists the result to stash-local SQLite graph tables keyed by stash root.
 * The artifact backs `akm show`'s `related` list and curate's support refs
 * (`src/indexer/graph/graph-related.ts`); it plays no part in search ranking.
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
 *   user keeps the related links they already have, they just stop
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
import { type AkmConfig, getIndexPassConfig, resolveBatchSize } from "../../core/config/config";
import { ConfigError } from "../../core/errors";
import { warn, warnVerbose } from "../../core/warn";
import type { LoweringNotice } from "../../execution/resolved-request";
import { assertRunnerCredentials } from "../../integrations/agent/runner-dispatch";
import { isProcessEnabled } from "../../llm/feature-gate";
import type { GraphExtractionReason, GraphExtractionStatus } from "../../llm/graph-extract";
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
import { loadStoredGraphMeta, loadStoredGraphSnapshot, replaceStoredGraph } from "../db/graph-db";
import type { EnrichmentPassContext } from "../passes/pass-context";
import { walkMarkdownFiles } from "../walk/walker";
import type { GraphExtractionTelemetry, GraphFile, GraphFileNode, GraphQualityTelemetry } from "./graph-types";

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
  /** The stored graph's counts after this run (`graph_meta`, derived from the stored rows). */
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
  /** The strategy's asset types; unset reads `index.graph.graphExtractionIncludeTypes`, then memory and knowledge. */
  includeTypes?: string[];
  /** The strategy's batch size; unset reads `index.graph.graphExtractionBatchSize`, then 4. */
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

const DEFAULT_GRAPH_EXTRACTION_INCLUDE_TYPES = ["memory", "knowledge"] as const;

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
  | { kind: "cache-hit"; candidate: EligibleFile; bodyHash: string; cached: GraphCacheShape }
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

/**
 * GR-D16: one notice when this run's extractor differs from the one that last
 * wrote the graph. Cached extractions are keyed by extractor, so a config
 * change that alters it (model, batch size, included types, prompt version)
 * re-extracts every cached file; the notice says which change and how many.
 */
function extractorChangeNotice(args: {
  previous: GraphExtractionTelemetry | undefined;
  current: { extractorId: string; model: string; batchSize: number; promptVersion: string };
  files: EligibleFile[];
  db: Database;
}): string | undefined {
  const { previous, current, files, db } = args;
  if (!previous?.extractorId || previous.extractorId === current.extractorId) return undefined;
  const cachedUnder = (cacheVariant: string) =>
    new Set(
      planEligibleGraphExtractions({ eligible: files, db, reEnrich: false, cacheVariant })
        .filter((plan) => plan.kind === "cache-hit")
        .map((plan) => plan.candidate.absPath),
    );
  const stillCached = cachedUnder(current.extractorId);
  const reextracted = [...cachedUnder(previous.extractorId)].filter((file) => !stillCached.has(file)).length;
  const changes = [
    previous.model !== current.model ? `model ${previous.model} -> ${current.model}` : undefined,
    previous.batchSize !== current.batchSize ? `batch size ${previous.batchSize} -> ${current.batchSize}` : undefined,
    previous.promptVersion !== current.promptVersion
      ? `prompt ${previous.promptVersion} -> ${current.promptVersion}`
      : undefined,
  ].filter((change) => change !== undefined);
  return (
    `graph extraction: the extractor changed (${changes.join(", ") || "included asset types"}), ` +
    `so ${reextracted} file(s) with a cached extraction will be extracted again.`
  );
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

/**
 * The stored graph after a run: each refreshed node replaces the stored node
 * for its path, and every other stored node is kept as it was — files a
 * scoped run (`candidatePaths`, `topN`) did not select, and files an aborted
 * run never reached. With `keptPaths`, stored nodes outside it are dropped
 * (the file left the eligible set); without it, nothing is dropped.
 */
function mergeGraphNodes(
  previousNodes: GraphFileNode[],
  refreshedNodes: GraphFileNode[],
  keptPaths?: ReadonlySet<string>,
): GraphFileNode[] {
  const refreshedByPath = new Map(refreshedNodes.map((node) => [node.path, node]));
  const merged: GraphFileNode[] = [];
  for (const node of previousNodes) {
    const refreshed = refreshedByPath.get(node.path);
    if (refreshed) {
      merged.push(refreshed);
      refreshedByPath.delete(node.path);
    } else if (!keptPaths || keptPaths.has(node.path)) {
      merged.push(node);
    }
  }
  merged.push(...refreshedByPath.values());
  return merged;
}

/**
 * A file is a cache hit only through `llm_enrichment_cache`, whose variant is
 * the extractor id. A stored graph node is never reused here: the graph keeps
 * nodes that older extractors wrote (files a run did not reach), and reusing
 * one would record another extractor's output as this one's.
 */
function planEligibleGraphExtractions(args: {
  eligible: EligibleFile[];
  db: Database;
  reEnrich: boolean | undefined;
  cacheVariant: string;
}): EligibleGraphPlan[] {
  const { eligible, db, reEnrich, cacheVariant } = args;
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
          return { kind: "cache-hit", candidate, bodyHash, cached };
        }
      } catch {
        // A corrupt cache row is a miss.
      }
    }
    return { kind: "model", candidate, bodyHash };
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
  const previousGraph = loadGraphFile(primary.path, db);
  const batchSize = resolveBatchSize(
    options.batchSize ?? getIndexPassConfig(config.index, "graph")?.graphExtractionBatchSize,
    llmRunner.connection.contextLength,
  );
  const extractorId = getGraphExtractorId({ model: llmRunner.connection.model, batchSize, includeTypes });
  const scan = collectEligibleFiles(primary.path, includeTypes);
  // The stored nodes this run keeps without touching them: every eligible file
  // (outside candidatePaths or topN, or never reached before an abort). Only a
  // node whose file left the eligible set — gone, emptied, inferred, or of a
  // type no longer included — is dropped, and an incomplete scan drops nothing.
  const keptPaths = scan.complete ? new Set(scan.files.map((file) => file.absPath)) : undefined;
  let eligible = scan.files.filter(
    (candidate) => !options.candidatePaths || options.candidatePaths.has(candidate.absPath),
  );
  // P2 (#624): when topN is set, rank the (already candidate-filtered)
  // eligible set by utility_scores DESC and keep only the top-N. Unset issues
  // no ranking query. Ranking composes WITH the candidatePaths filter:
  // scoped-then-ranked-then-sliced.
  if (options.topN != null && options.topN >= 0) {
    eligible = rankCandidatesByUtility(db, eligible).slice(0, options.topN);
  }
  const considered = eligible.length;
  const eligiblePlans = planEligibleGraphExtractions({ eligible, db, reEnrich, cacheVariant: extractorId });

  if (signal?.aborted) return emptyResult();

  // Validate exactly once iff classification found real model work. Cache
  // writes and graph replacement happen after this boundary, so a missing
  // credential cannot partially mutate a batch.
  if (eligiblePlans.some((plan) => plan.kind === "model")) assertRunnerCredentials(llmRunner);

  if (considered === 0) {
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
  const extractorNotice = extractorChangeNotice({
    previous: previousGraph.telemetry,
    current: {
      extractorId,
      model: llmRunner.connection.model,
      batchSize,
      promptVersion: graphExtract.GRAPH_EXTRACT_PROMPT_VERSION,
    },
    files: scan.files,
    db,
  });
  if (extractorNotice) warn(extractorNotice);
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

  // A failed attempt says nothing about the file, so a stored node for it stays
  // as it was; only a file with no stored node records the failure.
  const storedPaths = new Set(previousGraph.files.map((node) => node.path));
  const nodes = results.flatMap((result) =>
    !result || (isFailedExtractionStatus(result.status) && storedPaths.has(result.absPath))
      ? []
      : [toGraphNode(result, extractionRunId)],
  );
  telemetry.truncationCount = runtimeTelemetry.truncationCount ?? 0;
  telemetry.truncatedChunks = runtimeTelemetry.truncatedChunks ?? 0;
  telemetry.failureCount = runtimeTelemetry.failureCount ?? 0;
  telemetry.htmlErrorCount = runtimeTelemetry.htmlErrorCount ?? 0;
  telemetry.retryAttempts = runtimeTelemetry.retryAttempts ?? 0;
  telemetry.nonArrayBatchFailures = runtimeTelemetry.nonArrayBatchFailures ?? 0;
  telemetry.aborted = abortState.aborted;

  const graph = buildGraphFile(primary.path, mergeGraphNodes(previousGraph.files, nodes, keptPaths), telemetry);
  const written = writeGraphFile(db, graph);
  const quality = loadStoredGraphMeta(primary.path, db)?.quality ?? EMPTY_RESULT.quality;
  const warnings = buildLowQualityWarnings(quality, telemetry);
  if (extractorNotice) warnings.push(extractorNotice);
  if (abortState.message) warnings.push(abortState.message);
  for (const warning of warnings) warnVerbose(`graph extraction quality: ${warning}`);
  warnVerbose(
    `graph extraction: ${written ? "persisted" : "did not persist"} graph for ${primary.path}; ` +
      `considered=${considered}, extractedThisRun=${extracted}, storedFiles=${quality.consideredFiles}, ` +
      `entities=${quality.entityCount}, relations=${quality.relationCount}, coverage=${quality.extractionCoverage}.`,
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

/**
 * The persisted node for one extraction outcome: entities trimmed and kept
 * once per {@link graphExtract.normalizeEntityKey} (the first form wins),
 * relations trimmed.
 */
function toGraphNode(record: ExtractionRecord, extractionRunId: string): GraphFileNode {
  const confidence = normalizeConfidence(record.confidence);
  const entityKeys = new Set<string>();
  const entities = record.entities
    .map((entity) => entity.trim())
    .filter((entity) => {
      const key = graphExtract.normalizeEntityKey(entity);
      if (!key || entityKeys.has(key)) return false;
      entityKeys.add(key);
      return true;
    });
  return {
    path: record.absPath,
    type: record.type,
    bodyHash: record.bodyHash,
    entities,
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

/** The graph snapshot to store for `files`; its counts are derived from the stored rows on write. */
function buildGraphFile(stashRoot: string, files: GraphFileNode[], telemetry?: GraphExtractionTelemetry): GraphFile {
  return {
    generatedAt: new Date().toISOString(),
    stashRoot,
    files,
    ...(telemetry ? { telemetry } : {}),
  };
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
 * `complete` is false when a directory or a candidate file could not be read,
 * so the result may be missing eligible files.
 *
 * Exported for direct unit testing.
 */
export function collectEligibleFiles(
  stashRoot: string,
  includeTypes: string[] = [...DEFAULT_GRAPH_EXTRACTION_INCLUDE_TYPES],
): { files: EligibleFile[]; complete: boolean } {
  const out: EligibleFile[] = [];
  let complete = true;
  for (const rawType of includeTypes) {
    const type = rawType.trim().toLowerCase();
    if (!SUPPORTED_GRAPH_EXTRACTION_INCLUDE_TYPES.has(type)) continue;
    const stashDir = stashDirFor(type);
    if (!stashDir) continue;
    const dir = path.join(stashRoot, stashDir);
    if (!fs.existsSync(dir)) continue;
    const walked = walkMarkdownFiles(dir);
    if (!walked.complete) {
      complete = false;
      warn(`graph extraction: directory scan under ${dir} is incomplete — some files may be missing`);
    }
    for (const filePath of walked.files) {
      let raw: string;
      try {
        raw = fs.readFileSync(filePath, "utf8");
      } catch (err) {
        complete = false;
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
  return { files: out, complete };
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
