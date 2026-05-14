/**
 * Search-time graph-boost integration for the `akm index` graph pass (#207).
 *
 * This module is the consumer half of the graph-extraction pass. It loads
 * the persisted `graph.json` (when present) and exposes a single helper,
 * {@link computeGraphBoost}, that the existing FTS5+boosts loop in
 * `src/indexer/db-search.ts` calls per-entry to obtain an additive boost
 * value.
 *
 * CLAUDE.md / v1 spec compliance:
 *   - The graph signal feeds the **single** FTS5+boosts pipeline as one
 *     additive boost component. There is no parallel scoring track.
 *   - There is no second `SearchHit` scorer. `searchDatabase` continues to
 *     own ranking; this module just answers "what additive boost does the
 *     graph contribute for this (query, entry) pair?".
 *   - Missing/stale/unparseable `graph.json` → boost is `0`. The pipeline
 *     degrades gracefully to its non-graph behaviour, exactly as today.
 */

import fs from "node:fs";
import type { AkmConfig } from "../core/config";
import { warn } from "../core/warn";
import { GRAPH_FILE_SCHEMA_VERSION, type GraphFile, type GraphFileNode, getGraphFilePath } from "./graph-extraction";

/**
 * Per-query state for the graph boost. Built once per search invocation by
 * {@link loadGraphBoostContext} and reused for every scored entry, so the
 * disk read + JSON parse only happens at most once per query.
 *
 * `null` when the graph file is missing, unreadable, or schema-mismatched —
 * the caller treats that as "no boost" and skips the entry-level call.
 */
export interface GraphBoostContext {
  /** Map of canonicalised file path → graph node. */
  nodesByPath: Map<string, GraphFileNode>;
  /**
   * Set of entities that match query tokens. Computed once up-front so the
   * per-entry hot path is just two cheap intersections.
   */
  matchedEntities: Set<string>;
  /**
   * Set of entities reachable within configured hops from
   * {@link matchedEntities} via extracted relations.
   */
  connectedEntities: Set<string>;
  connectedConfidence: Map<string, number>;
  entityConfidence: Map<string, number>;
  graph: GraphFile;
  adjacency: Map<string, Map<string, number>>;
  weights: GraphBoostWeights;
}

export interface GraphRelatedEntity {
  name: string;
  kind: "matched" | "connected";
  confidence?: number;
}

export interface GraphRelatedRelation {
  from: string;
  to: string;
  type?: string;
  confidence?: number;
}

export interface GraphRelatedHit {
  path: string;
  type: string;
  entities: GraphRelatedEntity[];
  relations: GraphRelatedRelation[];
}

function normalizeGraphName(value: string): string {
  return value.trim().toLowerCase();
}

interface ParsedGraphContext {
  graph: GraphFile;
  nodesByPath: Map<string, GraphFileNode>;
  entityConfidence: Map<string, number>;
  adjacency: Map<string, Map<string, number>>;
}

let cachedParsedGraph:
  | {
      graphPath: string;
      mtimeMs: number;
      size: number;
      context: ParsedGraphContext;
    }
  | undefined;

function resolveGraphBoostWeights(config?: AkmConfig): GraphBoostWeights {
  const configured = config?.search?.graphBoost;
  return {
    directBoostPerEntity: configured?.directBoostPerEntity ?? GRAPH_DIRECT_BOOST_PER_ENTITY,
    directBoostCap: configured?.directBoostCap ?? GRAPH_DIRECT_BOOST_CAP,
    hopBoostPerEntity: configured?.hopBoostPerEntity ?? GRAPH_HOP_BOOST_PER_ENTITY,
    hopBoostCap: configured?.hopBoostCap ?? GRAPH_HOP_BOOST_CAP,
    maxHops: Math.min(Math.max(configured?.maxHops ?? GRAPH_MAX_HOPS, 1), GRAPH_MAX_HOPS_HARD_CAP),
    confidenceMode: configured?.confidenceMode ?? GRAPH_CONFIDENCE_MODE,
    confidenceWeight: configured?.confidenceWeight ?? GRAPH_CONFIDENCE_WEIGHT,
  };
}

/**
 * Per-entry weights, exposed as constants so tests can read them and so the
 * single-source-of-truth for "how much does the graph contribute" is here
 * rather than inlined into `db-search.ts`. Kept conservative — the goal is
 * a useful tiebreaker, not domination of the lexical signal.
 */
export const GRAPH_DIRECT_BOOST_PER_ENTITY = 0.25;
export const GRAPH_DIRECT_BOOST_CAP = 0.75;
export const GRAPH_HOP_BOOST_PER_ENTITY = 0.1;
export const GRAPH_HOP_BOOST_CAP = 0.3;
export const GRAPH_MAX_HOPS = 1;
export const GRAPH_CONFIDENCE_MODE = "blend" as const;
export const GRAPH_CONFIDENCE_WEIGHT = 0.2;
const GRAPH_MAX_HOPS_HARD_CAP = 3;

export interface GraphBoostWeights {
  directBoostPerEntity: number;
  directBoostCap: number;
  hopBoostPerEntity: number;
  hopBoostCap: number;
  maxHops: number;
  confidenceMode: "off" | "blend" | "multiply";
  confidenceWeight: number;
}

function normalizeConfidence(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return Math.max(0, Math.min(1, raw));
}

function combineConfidence(...parts: Array<number | undefined>): number | undefined {
  let out: number | undefined;
  for (const part of parts) {
    const value = normalizeConfidence(part);
    if (value === undefined) continue;
    out = out === undefined ? value : out * value;
  }
  return out;
}

function toConfidenceMultiplier(rawConfidence: number | undefined, weights: GraphBoostWeights): number {
  if (weights.confidenceMode === "off") return 1;
  const confidence = normalizeConfidence(rawConfidence) ?? 1;
  if (weights.confidenceMode === "multiply") return confidence;
  const blendWeight = Math.max(0, Math.min(1, weights.confidenceWeight));
  return 1 - blendWeight + blendWeight * confidence;
}

/**
 * Load the graph file for a stash root and pre-compute everything that's
 * shared across all entries scored for one query. Returns `null` when:
 *   - `graph.json` does not exist.
 *   - The file fails to parse.
 *   - The schema version doesn't match (treated like "missing" so an old
 *     index keeps working until the next `akm index --full`).
 *   - The query produces no token-level entity matches (no boost is
 *     possible, so we skip the per-entry overhead entirely).
 */
export function loadGraphBoostContext(stashRoot: string, query: string, config?: AkmConfig): GraphBoostContext | null {
  const parsed = readParsedGraphContext(stashRoot);
  if (!parsed) return null;
  const weights = resolveGraphBoostWeights(config);

  const queryTokens = query
    .toLowerCase()
    .split(/[\s\-_/]+/)
    .filter((t) => t.length >= 2);
  if (queryTokens.length === 0) return null;

  // Build a flat union of all extracted entities across the corpus. This
  // is small (capped per-asset at extract time) and lets the per-entry
  // path do a single set membership test.
  const allEntities = new Set<string>();
  for (const node of parsed.graph.files) {
    for (const entity of node.entities) allEntities.add(entity);
  }

  // An entity matches the query when any of its sub-tokens equals or
  // contains a query token. Matching is case-insensitive; the graph keeps
  // canonical display strings and we normalize only for comparisons here.
  const matchedEntities = new Set<string>();
  for (const entity of allEntities) {
    const normalizedEntity = normalizeGraphName(entity);
    const entityTokens = normalizedEntity.split(/[\s\-_/]+/).filter(Boolean);
    for (const qt of queryTokens) {
      if (
        normalizedEntity === qt ||
        normalizedEntity.includes(qt) ||
        entityTokens.some((et) => et === qt || et.includes(qt))
      ) {
        matchedEntities.add(entity);
        break;
      }
    }
  }

  if (matchedEntities.size === 0) return null;

  const connectedEntities = new Set<string>();
  const connectedConfidence = new Map<string, number>();
  const visited = new Set<string>();
  let frontier = new Map<string, number>();
  for (const entity of matchedEntities) {
    const seed = parsed.entityConfidence.get(entity) ?? 1;
    frontier.set(entity, seed);
    visited.add(entity);
  }
  for (let hop = 1; hop <= weights.maxHops; hop += 1) {
    const next = new Map<string, number>();
    for (const [entity, pathConfidence] of frontier.entries()) {
      const neighbors = parsed.adjacency.get(entity);
      if (!neighbors) continue;
      for (const [neighbor, edgeConfidence] of neighbors.entries()) {
        const neighborPathConfidence = Math.max(0, Math.min(1, pathConfidence * edgeConfidence));
        const currentBest = connectedConfidence.get(neighbor) ?? 0;
        if (neighborPathConfidence > currentBest) connectedConfidence.set(neighbor, neighborPathConfidence);
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        next.set(neighbor, Math.max(next.get(neighbor) ?? 0, neighborPathConfidence));
        connectedEntities.add(neighbor);
      }
    }
    if (next.size === 0) break;
    frontier = next;
  }

  return {
    graph: parsed.graph,
    nodesByPath: parsed.nodesByPath,
    matchedEntities,
    connectedEntities,
    connectedConfidence,
    entityConfidence: parsed.entityConfidence,
    adjacency: parsed.adjacency,
    weights,
  };
}

/**
 * Compute the graph-boost contribution for a single scored entry.
 *
 * The return value is added directly into `boostSum` in `searchDatabase`'s
 * existing scoring loop — same units, same cap policy. Returns `0` when
 * the entry's file isn't in the graph or when no entity overlap exists.
 */
export function computeGraphBoost(context: GraphBoostContext, filePath: string): number {
  const node = context.nodesByPath.get(filePath);
  if (!node) return 0;

  let directBoostRaw = 0;
  let hopBoostRaw = 0;
  for (const entity of node.entities) {
    if (context.matchedEntities.has(entity)) {
      const directConfidence = combineConfidence(node.confidence, context.entityConfidence.get(entity));
      directBoostRaw +=
        context.weights.directBoostPerEntity * toConfidenceMultiplier(directConfidence, context.weights);
    } else if (context.connectedEntities.has(entity)) {
      const hopConfidence = combineConfidence(
        node.confidence,
        context.entityConfidence.get(entity),
        context.connectedConfidence.get(entity),
      );
      hopBoostRaw += context.weights.hopBoostPerEntity * toConfidenceMultiplier(hopConfidence, context.weights);
    }
  }

  const directBoost = Math.min(context.weights.directBoostCap, directBoostRaw);
  const hopBoost = Math.min(context.weights.hopBoostCap, hopBoostRaw);
  return directBoost + hopBoost;
}

export function collectGraphRelatedHit(context: GraphBoostContext, filePath: string): GraphRelatedHit | null {
  const node = context.nodesByPath.get(filePath);
  if (!node) return null;

  const entities: GraphRelatedEntity[] = [];
  for (const entity of node.entities) {
    if (context.matchedEntities.has(entity)) {
      entities.push({
        name: entity,
        kind: "matched",
        ...(context.entityConfidence.get(entity) !== undefined
          ? { confidence: context.entityConfidence.get(entity) }
          : {}),
      });
      continue;
    }
    if (context.connectedEntities.has(entity)) {
      entities.push({
        name: entity,
        kind: "connected",
        ...(context.connectedConfidence.get(entity) !== undefined
          ? { confidence: context.connectedConfidence.get(entity) }
          : {}),
      });
    }
  }

  if (entities.length === 0) return null;

  const relatedNames = new Set(entities.map((entity) => entity.name));
  const relations = node.relations
    .filter((relation) => relatedNames.has(relation.from) || relatedNames.has(relation.to))
    .map((relation) => ({
      from: relation.from,
      to: relation.to,
      ...(relation.type ? { type: relation.type } : {}),
      ...(normalizeConfidence(relation.confidence) !== undefined
        ? { confidence: normalizeConfidence(relation.confidence) }
        : {}),
    }));

  return {
    path: filePath,
    type: node.type,
    entities: entities.sort((a, b) => a.name.localeCompare(b.name)),
    relations,
  };
}

export function listRelatedPathsForFile(
  stashRoot: string,
  filePath: string,
  limit = 5,
): Array<{
  path: string;
  type: string;
  sharedEntities: string[];
  relationCount: number;
}> {
  const parsed = readParsedGraphContext(stashRoot);
  if (!parsed) return [];
  const node = parsed.nodesByPath.get(filePath);
  if (!node) return [];

  const entitySet = new Set(node.entities.map(normalizeGraphName));
  const results: Array<{ path: string; type: string; sharedEntities: string[]; relationCount: number }> = [];
  for (const candidate of parsed.graph.files) {
    if (candidate.path === filePath) continue;
    const sharedEntities = candidate.entities.filter((entity) => entitySet.has(normalizeGraphName(entity)));
    if (sharedEntities.length === 0) continue;
    const relationCount = candidate.relations.filter(
      (relation) => entitySet.has(normalizeGraphName(relation.from)) || entitySet.has(normalizeGraphName(relation.to)),
    ).length;
    results.push({
      path: candidate.path,
      type: candidate.type,
      sharedEntities: [...new Set(sharedEntities)].sort((a, b) => a.localeCompare(b)),
      relationCount,
    });
  }

  results.sort(
    (a, b) =>
      b.sharedEntities.length - a.sharedEntities.length ||
      b.relationCount - a.relationCount ||
      a.path.localeCompare(b.path),
  );
  return results.slice(0, Math.max(1, limit));
}

/**
 * Lightweight reader — extracted so the boost loader and tests share one
 * code path. Tolerant of missing files (returns null) but logs a warning
 * when an existing file fails to parse so corruption is visible.
 */
function readGraphFile(stashRoot: string): GraphFile | null {
  const target = getGraphFilePath(stashRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch {
    // Missing → no boost. Not an error: the user simply hasn't enabled
    // graph extraction yet, or the pass hasn't run.
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warn(`graph boost: failed to parse ${target}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (!isGraphFile(parsed) || parsed.schemaVersion !== GRAPH_FILE_SCHEMA_VERSION) {
    return null;
  }
  return parsed;
}

function readParsedGraphContext(stashRoot: string): ParsedGraphContext | null {
  const target = getGraphFilePath(stashRoot);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return null;
  }
  if (
    cachedParsedGraph &&
    cachedParsedGraph.graphPath === target &&
    cachedParsedGraph.mtimeMs === stat.mtimeMs &&
    cachedParsedGraph.size === stat.size
  ) {
    return cachedParsedGraph.context;
  }
  const graph = readGraphFile(stashRoot);
  if (!graph) return null;

  const nodesByPath = new Map<string, GraphFileNode>();
  const entityConfidence = new Map<string, number>();
  const adjacency = new Map<string, Map<string, number>>();

  function setBestEntityConfidence(entity: string, confidence: number | undefined): void {
    const normalized = normalizeConfidence(confidence);
    if (normalized === undefined) return;
    const current = entityConfidence.get(entity);
    if (current === undefined || normalized > current) entityConfidence.set(entity, normalized);
  }

  function setBestEdgeConfidence(from: string, to: string, confidence: number | undefined): void {
    const normalized = normalizeConfidence(confidence);
    if (!adjacency.has(from)) adjacency.set(from, new Map());
    const neighbors = adjacency.get(from);
    if (!neighbors) return;
    const current = neighbors.get(to);
    const next = normalized ?? 1;
    if (current === undefined || next > current) neighbors.set(to, next);
  }

  for (const node of graph.files) {
    nodesByPath.set(node.path, node);
    for (const entity of node.entities) {
      setBestEntityConfidence(entity, node.confidence);
    }
    for (const rel of node.relations) {
      const edgeConfidence = combineConfidence(node.confidence, rel.confidence);
      setBestEdgeConfidence(rel.from, rel.to, edgeConfidence);
      setBestEdgeConfidence(rel.to, rel.from, edgeConfidence);
    }
  }

  const context = { graph, nodesByPath, entityConfidence, adjacency };
  cachedParsedGraph = { graphPath: target, mtimeMs: stat.mtimeMs, size: stat.size, context };
  return context;
}

function isGraphFile(value: unknown): value is GraphFile {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.schemaVersion !== "number") return false;
  if (typeof obj.generatedAt !== "string") return false;
  if (typeof obj.stashRoot !== "string") return false;
  if (!Array.isArray(obj.files)) return false;
  for (const f of obj.files) {
    if (typeof f !== "object" || f === null) return false;
    const node = f as Record<string, unknown>;
    if (typeof node.path !== "string") return false;
    if (typeof node.type !== "string") return false;
    if (!Array.isArray(node.entities) || !node.entities.every((e) => typeof e === "string")) return false;
    if (!Array.isArray(node.relations)) return false;
    for (const r of node.relations as unknown[]) {
      if (typeof r !== "object" || r === null) return false;
      const rel = r as Record<string, unknown>;
      if (typeof rel.from !== "string" || typeof rel.to !== "string") return false;
      if (rel.type !== undefined && typeof rel.type !== "string") return false;
      if (rel.confidence !== undefined && typeof rel.confidence !== "number") return false;
    }
  }
  return true;
}
