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
import { warn } from "../core/warn";
import {
  GRAPH_FILE_SCHEMA_VERSION,
  type GraphFile,
  type GraphFileNode,
  type GraphRelation,
  getGraphFilePath,
} from "./graph-extraction";

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
   * Set of entities reachable in one hop from {@link matchedEntities} via
   * extracted relations. Used so an entry whose entities are *connected*
   * to the query (rather than directly matching) still receives a smaller
   * boost — that is the whole point of having a graph.
   */
  oneHopEntities: Set<string>;
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
export function loadGraphBoostContext(stashRoot: string, query: string): GraphBoostContext | null {
  const graph = readGraphFile(stashRoot);
  if (!graph) return null;

  const queryTokens = query
    .toLowerCase()
    .split(/[\s\-_/]+/)
    .filter((t) => t.length >= 2);
  if (queryTokens.length === 0) return null;

  // Build a flat union of all extracted entities across the corpus. This
  // is small (capped per-asset at extract time) and lets the per-entry
  // path do a single set membership test.
  const allEntities = new Set<string>();
  const nodesByPath = new Map<string, GraphFileNode>();
  for (const node of graph.files) {
    nodesByPath.set(node.path, node);
    for (const entity of node.entities) allEntities.add(entity);
  }

  // An entity matches the query when any of its sub-tokens equals or
  // contains a query token. Cheap and forgiving — exact substring match is
  // sufficient because both sides are already lower-cased at extract time.
  const matchedEntities = new Set<string>();
  for (const entity of allEntities) {
    const entityTokens = entity.split(/[\s\-_/]+/).filter(Boolean);
    for (const qt of queryTokens) {
      if (entity === qt || entity.includes(qt) || entityTokens.some((et) => et === qt)) {
        matchedEntities.add(entity);
        break;
      }
    }
  }

  if (matchedEntities.size === 0) return null;

  // One-hop neighbours: any entity that appears on the other end of a
  // relation whose other endpoint is in matchedEntities.
  const oneHopEntities = new Set<string>();
  for (const node of graph.files) {
    for (const rel of node.relations) {
      if (matchedEntities.has(rel.from) && !matchedEntities.has(rel.to)) {
        oneHopEntities.add(rel.to);
      } else if (matchedEntities.has(rel.to) && !matchedEntities.has(rel.from)) {
        oneHopEntities.add(rel.from);
      }
    }
  }

  return { nodesByPath, matchedEntities, oneHopEntities };
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

  let directHits = 0;
  let hopHits = 0;
  for (const entity of node.entities) {
    if (context.matchedEntities.has(entity)) directHits += 1;
    else if (context.oneHopEntities.has(entity)) hopHits += 1;
  }

  const directBoost = Math.min(GRAPH_DIRECT_BOOST_CAP, directHits * GRAPH_DIRECT_BOOST_PER_ENTITY);
  const hopBoost = Math.min(GRAPH_HOP_BOOST_CAP, hopHits * GRAPH_HOP_BOOST_PER_ENTITY);
  return directBoost + hopBoost;
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
    }
  }
  return true;
}

// re-export GraphRelation so other modules can use a single import root.
export type { GraphRelation };
