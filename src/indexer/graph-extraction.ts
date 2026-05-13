/**
 * Graph-extraction pass for `akm index` (#207).
 *
 * Walks the primary stash for `memory:` and `knowledge:` assets, asks the
 * configured LLM to extract entities and relations from each one, and
 * persists the result to a single stash-local artifact at
 * `<stashRoot>/.akm/graph.json`. The artifact is consumed by the search
 * pipeline (see `src/indexer/graph-boost.ts`) as a single boost component
 * inside the existing FTS5+boosts loop — there is NO second SearchHit
 * scorer and no parallel ranking track.
 *
 * Disabling — three preconditions must ALL hold for the pass to run:
 *   1. `akm.llm` must be configured (no provider = no extraction). When
 *      absent, `resolveIndexPassLLM("graph", config)` returns `undefined`
 *      and the pass short-circuits.
 *   2. `llm.features.graph_extraction !== false` — the locked v1 spec §14
 *      feature-flag layer. Set to `false` to block the pass at the
 *      feature-gate layer (no network call may ever issue).
 *   3. `index.graph.llm !== false` — the per-pass opt-out layer (#208).
 *      Set to `false` to skip just this pass while leaving other passes
 *      that share the same `llm` block enabled.
 *   Toggling any one off does NOT delete the existing `graph.json` — the
 *   user keeps the boost component they already have, it just stops
 *   refreshing.
 *
 * Locked v1 contract:
 *   - LLM access is exclusively via `resolveIndexPassLLM("graph", config)`.
 *   - The `graph.json` file is an indexer artifact, NOT a user-visible
 *     asset. It does not have an asset ref, does not appear in search
 *     hits, and is not addressable via `akm show`. Direct `fs.writeFile`
 *     is therefore the correct primitive — `writeAssetToSource` is
 *     reserved for asset writes (CLAUDE.md / spec §10 step 5).
 */

import type { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { TYPE_DIRS } from "../core/asset-spec";
import { writeFileAtomic } from "../core/common";
import { concurrentMap } from "../core/concurrent";
import type { AkmConfig } from "../core/config";
import { parseFrontmatter } from "../core/frontmatter";
import { warn } from "../core/warn";
import { extractGraphFromBodies, extractGraphFromBody, type GraphRelation } from "../llm/graph-extract";
import { resolveIndexPassLLM } from "../llm/index-passes";
import { computeBodyHash, getLlmCacheEntry, upsertLlmCacheEntry } from "./db";
import { deduplicateGraph } from "./graph-dedup";
import { withLlmCache } from "./llm-cache";
import type { SearchSource } from "./search-source";
import { walkMarkdownFiles } from "./walker";

/** Schema version for the persisted artifact — bumps trigger a full rebuild. */
export const GRAPH_FILE_SCHEMA_VERSION = 1;

/** Path scheme — kept stable so consumers (search-time boost) can find it. */
export const GRAPH_FILE_RELATIVE_PATH = path.join(".akm", "graph.json");

/** Public path resolver — exported so the search-side reader and tests share the rule. */
export function getGraphFilePath(stashRoot: string): string {
  return path.join(stashRoot, GRAPH_FILE_RELATIVE_PATH);
}

/** One node in the graph — corresponds to a single asset file. */
export interface GraphFileNode {
  /** Absolute path on disk. */
  path: string;
  /** Asset type (`memory` or `knowledge`). */
  type: string;
  /** SHA-256 hash of the parsed markdown body used for staleness checks. */
  bodyHash?: string;
  /** Entities surfaced by the LLM for this file. Lower-cased before matching. */
  entities: string[];
  /** Relations the LLM surfaced from this file's body. */
  relations: GraphRelation[];
  /** Optional extraction confidence score in [0,1]. */
  confidence?: number;
}

/** On-disk shape of `graph.json`. */
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
  /** Whether `graph.json` was written this run. False when the pass is a no-op. */
  written: boolean;
  /** Graph quality telemetry computed from the extracted artifact. */
  quality: GraphQualityTelemetry;
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
};

type ExtractionRecord =
  | {
      absPath: string;
      type: string;
      bodyHash: string;
      entities: string[];
      relations: Array<{ from: string; to: string; type?: string; confidence?: number }>;
      confidence?: number;
    }
  | undefined;

function normalizeConfidence(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return Math.max(0, Math.min(1, raw));
}

export function getGraphExtractionIncludeTypes(config: AkmConfig): string[] {
  const configured = config.index?.graph?.graphExtractionIncludeTypes;
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
  };
}

function loadPreviousGraphNodes(stashRoot: string): Map<string, GraphFileNode> {
  const target = getGraphFilePath(stashRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch {
    return new Map();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Map();
  }
  if (!parsed || typeof parsed !== "object") return new Map();
  const files = (parsed as Record<string, unknown>).files;
  if (!Array.isArray(files)) return new Map();

  const out = new Map<string, GraphFileNode>();
  for (const f of files) {
    if (!f || typeof f !== "object") continue;
    const node = f as Record<string, unknown>;
    if (typeof node.path !== "string") continue;
    if (typeof node.type !== "string") continue;
    const cacheShape = validateGraphCacheShape({
      entities: node.entities,
      relations: node.relations,
    });
    if (!cacheShape) continue;
    out.set(node.path, {
      path: node.path,
      type: node.type,
      bodyHash: typeof node.bodyHash === "string" ? node.bodyHash : undefined,
      entities: cacheShape.entities,
      relations: cacheShape.relations,
      confidence: normalizeConfidence(node.confidence),
    });
  }
  return out;
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
  };
}

/**
 * Top-level entry point. Returns a no-op result when the pass is disabled.
 *
 * Three preconditions — ALL must hold for the pass to run:
 *
 *   1. **Provider configured** — `akm.llm` must be present. Without a
 *      configured provider, `resolveIndexPassLLM("graph", config)` returns
 *      `undefined` (the pass cannot run because there is no model to call).
 *   2. **Feature gate** — `llm.features.graph_extraction` (defaults to
 *      `true`). When `false`, no network call may issue regardless of
 *      per-pass settings. This is the locked spec-§14 gate.
 *   3. **Per-pass gate** — `index.graph.llm` (defaults to `true`). When
 *      `false`, the indexer simply skips this pass for the current run.
 *
 * If any of the three is missing or `false`, this function short-circuits
 * to an empty no-op result, leaving any existing `graph.json` untouched on
 * disk.
 *
 * When `config.index.graph.graphExtractionBatchSize > 1`, eligible files are
 * chunked into batches and each chunk is processed with a single LLM call via
 * `extractGraphFromBodies`. Default batch size is 1 (one call per asset —
 * preserves existing behaviour, fully opt-in).
 */
export async function runGraphExtractionPass(
  config: AkmConfig,
  sources: SearchSource[],
  signal?: AbortSignal,
  db?: Database,
  reEnrich?: boolean,
  onProgress?: (event: {
    processed: number;
    total: number;
    extracted: number;
    totalEntities: number;
    totalRelations: number;
    currentPath?: string;
  }) => void,
): Promise<GraphExtractionResult> {
  // Gate 1 — locked feature flag (§14). Defaults to enabled; only an
  // explicit `false` disables the pass entirely.
  if (config.llm?.features?.graph_extraction === false) return { ...EMPTY_RESULT };

  // Gate 2 — per-pass opt-out (#208). Returns the resolved llm config or
  // `undefined` when the pass should not run.
  const llmConfig = resolveIndexPassLLM("graph", config);
  if (!llmConfig) return { ...EMPTY_RESULT };

  // The pass only writes to the primary (working) stash. Read-only caches
  // (git, npm, website) are deliberately untouched — the graph artifact for
  // those sources would be clobbered by the next sync().
  const primary = sources[0];
  if (!primary) return { ...EMPTY_RESULT };

  const eligible = collectEligibleFiles(primary.path, getGraphExtractionIncludeTypes(config));
  const considered = eligible.length;
  if (considered === 0) return { ...EMPTY_RESULT };

  const previousNodes = loadPreviousGraphNodes(primary.path);

  const nodes: GraphFileNode[] = [];
  let totalEntities = 0;
  let totalRelations = 0;
  let processed = 0;
  let extracted = 0;
  onProgress?.({ processed, total: considered, extracted, totalEntities, totalRelations });

  // Read the configured batch size. Default of 1 preserves the existing
  // per-asset behaviour and is fully opt-in.
  const batchSize = config.index?.graph?.graphExtractionBatchSize ?? 1;

  const onFallback = (evt: { feature: string; reason: string }) => {
    warn(`[akm] LLM fallback for ${evt.feature}: ${evt.reason}`);
  };

  let extractionResults: Array<ExtractionRecord | undefined>;

  if (batchSize <= 1) {
    // ── Original per-asset path (with incremental cache) ─────────────────
    extractionResults = await concurrentMap(
      eligible,
      async (candidate) => {
        if (signal?.aborted) return undefined;
        const bodyHash = computeBodyHash(candidate.body);

        let cached: GraphCacheShape | undefined;
        if (db) {
          // withLlmCache handles hash computation, cache lookup, LLM call, and cache write.
          // When cache misses and this run is not forced, attempt graph-node reuse before LLM.
          cached = await withLlmCache<GraphCacheShape>(
            db,
            candidate.absPath,
            candidate.body,
            reEnrich ?? false,
            async () => {
              if (!(reEnrich ?? false)) {
                const reused = reuseGraphNode(previousNodes, candidate, bodyHash);
                if (reused) return reused;
              }
              const extraction = await extractGraphFromBody(llmConfig, candidate.body, signal, config, onFallback);
              // Cache empty results too so we skip on next run.
              return {
                entities: extraction.entities,
                relations: extraction.relations,
                ...(extraction.confidence !== undefined ? { confidence: extraction.confidence } : {}),
              };
            },
            validateGraphCacheShape,
          );
        } else if (!(reEnrich ?? false)) {
          cached = reuseGraphNode(previousNodes, candidate, bodyHash);
        }

        if (!cached) {
          const extraction = await extractGraphFromBody(llmConfig, candidate.body, signal, config, onFallback);
          cached = {
            entities: extraction.entities,
            relations: extraction.relations,
            ...(extraction.confidence !== undefined ? { confidence: extraction.confidence } : {}),
          };
        }

        if (!cached || cached.entities.length === 0) return undefined;
        return {
          absPath: candidate.absPath,
          type: candidate.type,
          bodyHash,
          entities: cached.entities,
          relations: cached.relations,
          ...(cached.confidence !== undefined ? { confidence: cached.confidence } : {}),
        };
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

    for (let start = 0; start < eligible.length; start += batchSize) {
      if (signal?.aborted) break;
      const chunk = eligible.slice(start, start + batchSize);

      // Pre-resolve cache hits for this chunk; track which positions need LLM.
      const bodyHashes: string[] = chunk.map((c) => computeBodyHash(c.body));
      const needsLlm: boolean[] = chunk.map((c, j) => {
        if (!db || reEnrich) return true;
        const cached = getLlmCacheEntry(db, c.absPath, bodyHashes[j] ?? "");
        if (!cached) return true;
        try {
          const parsed = validateGraphCacheShape(JSON.parse(cached.resultJson));
          if (!parsed) return true;
          const entities = parsed.entities;
          rawResults[start + j] =
            entities.length > 0
              ? {
                  absPath: c.absPath,
                  type: c.type,
                  bodyHash: bodyHashes[j] ?? "",
                  entities,
                  relations: parsed.relations,
                  ...(parsed.confidence !== undefined ? { confidence: parsed.confidence } : {}),
                }
              : undefined;
          return false; // cache hit
        } catch {
          return true; // corrupt cache entry — re-call LLM
        }
      });

      // Secondary incremental path: reuse previous graph nodes when the body hash
      // still matches and DB cache is missing/stale/unavailable.
      if (!(reEnrich ?? false)) {
        for (let j = 0; j < chunk.length; j++) {
          if (!needsLlm[j]) continue;
          const candidate = chunk[j];
          if (!candidate) continue;
          const reused = reuseGraphNode(previousNodes, candidate, bodyHashes[j] ?? "");
          if (!reused) continue;
          rawResults[start + j] =
            reused.entities.length > 0
              ? {
                  absPath: candidate.absPath,
                  type: candidate.type,
                  bodyHash: bodyHashes[j] ?? "",
                  entities: reused.entities,
                  relations: reused.relations,
                  ...(reused.confidence !== undefined ? { confidence: reused.confidence } : {}),
                }
              : undefined;
          if (db) {
            upsertLlmCacheEntry(db, candidate.absPath, bodyHashes[j] ?? "", JSON.stringify(reused));
          }
          needsLlm[j] = false;
        }
      }

      const uncachedChunk = chunk.filter((_, j) => needsLlm[j]);
      if (uncachedChunk.length === 0) {
        processed += chunk.length;
        onProgress?.({
          processed,
          total: considered,
          extracted,
          totalEntities,
          totalRelations,
          currentPath: chunk.at(-1)?.absPath,
        });
        continue;
      }

      const bodies = uncachedChunk.map((c) => c.body);

      // extractGraphFromBodies always returns an array of the same length
      // as bodies (it falls back per-asset for any missing indices).
      const batchExtractions = await extractGraphFromBodies(llmConfig, bodies, signal, config, onFallback);

      // Map LLM results back to original positions and write cache entries.
      let llmIdx = 0;
      for (let j = 0; j < chunk.length; j++) {
        if (!needsLlm[j]) continue;
        const candidate = chunk[j];
        const extraction = batchExtractions[llmIdx++];
        if (!candidate || !extraction) continue;

        // Cache the result for future runs.
        if (db) {
          upsertLlmCacheEntry(
            db,
            candidate.absPath,
            bodyHashes[j] ?? "",
            JSON.stringify({
              entities: extraction.entities,
              relations: extraction.relations,
              ...(extraction.confidence !== undefined ? { confidence: extraction.confidence } : {}),
            }),
          );
        }

        if (extraction.entities.length === 0) {
          rawResults[start + j] = undefined;
        } else {
          rawResults[start + j] = {
            absPath: candidate.absPath,
            type: candidate.type,
            bodyHash: bodyHashes[j] ?? "",
            entities: extraction.entities,
            relations: extraction.relations,
            ...(extraction.confidence !== undefined ? { confidence: extraction.confidence } : {}),
          };
        }
        processed++;
        if (extraction.entities.length > 0) {
          extracted++;
          totalEntities += extraction.entities.length;
          totalRelations += extraction.relations.length;
        }
        onProgress?.({
          processed,
          total: considered,
          extracted,
          totalEntities,
          totalRelations,
          currentPath: candidate.absPath,
        });
      }
    }

    extractionResults = rawResults;
  }

  for (const result of extractionResults) {
    if (!result) continue;
    nodes.push({
      path: result.absPath,
      type: result.type,
      bodyHash: result.bodyHash,
      // Lower-case once at write time so the search-time boost can do a
      // single case-folded comparison without re-canonicalising on every
      // query.
      entities: result.entities.map((e) => e.toLowerCase()),
      relations: result.relations.map((r) => ({
        from: r.from.toLowerCase(),
        to: r.to.toLowerCase(),
        ...(r.type ? { type: r.type.toLowerCase() } : {}),
        ...(normalizeConfidence(r.confidence) !== undefined ? { confidence: normalizeConfidence(r.confidence) } : {}),
      })),
      ...(normalizeConfidence(result.confidence) !== undefined
        ? { confidence: normalizeConfidence(result.confidence) }
        : {}),
    });
  }

  if (batchSize <= 1) {
    processed = 0;
    extracted = 0;
    totalEntities = 0;
    totalRelations = 0;
    for (let i = 0; i < extractionResults.length; i++) {
      const result = extractionResults[i];
      processed++;
      if (result) {
        extracted++;
        totalEntities += result.entities.length;
        totalRelations += result.relations.length;
      }
      onProgress?.({
        processed,
        total: considered,
        extracted,
        totalEntities,
        totalRelations,
        currentPath: eligible[i]?.absPath,
      });
    }
  }

  const assetRefs = extractionResults.filter((r): r is NonNullable<typeof r> => Boolean(r)).map((r) => r.absPath);
  const deduped = deduplicateGraph(
    extractionResults
      .filter((r): r is NonNullable<typeof r> => Boolean(r))
      .map((r) => ({ entities: r.entities, relations: r.relations })),
    assetRefs,
  );

  if (nodes.length === 0) {
    warn("graph extraction: all extractions failed or returned no entities; leaving existing graph.json untouched.");
    return {
      considered,
      extracted: 0,
      totalEntities: 0,
      totalRelations: 0,
      written: false,
      quality: computeGraphQualityTelemetry(considered, 0, 0, 0),
    };
  }

  const quality = computeGraphQualityTelemetry(
    considered,
    nodes.length,
    deduped.entities.length,
    deduped.relations.length,
  );

  const graph: GraphFile = {
    schemaVersion: GRAPH_FILE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    stashRoot: primary.path,
    files: nodes,
    entities: deduped.entities,
    relations: deduped.relations,
    quality,
  };

  const written = writeGraphFile(primary.path, graph);

  return {
    considered,
    extracted: nodes.length,
    totalEntities,
    totalRelations,
    written,
    quality,
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
 * Write `graph.json` atomically to `<stashRoot>/.akm/graph.json`.
 *
 * Direct `fs.writeFile` is intentional. The graph artifact is an indexer
 * cache — not a user-visible asset — so it does not have an asset ref and
 * `writeAssetToSource` (which routes through the asset-spec rendering
 * layer) is the wrong primitive here. See CLAUDE.md / spec §10 step 5 for
 * the carve-out: kind-branching writes for asset content live in
 * `src/core/write-source.ts`; opaque indexer artifacts may write directly.
 */
function writeGraphFile(stashRoot: string, graph: GraphFile): boolean {
  const target = getGraphFilePath(stashRoot);
  const dir = path.dirname(target);
  try {
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(target, `${JSON.stringify(graph, null, 2)}\n`);
    return true;
  } catch (err) {
    warn(`graph extraction: failed to write ${target}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
