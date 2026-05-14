import fs from "node:fs";
import path from "node:path";
import { parseAssetRef } from "../core/asset-ref";
import { loadConfig } from "../core/config";
import { NotFoundError, UsageError } from "../core/errors";
import { closeDatabase, openExistingDatabase } from "../indexer/db";
import { listRelatedPathsForFile } from "../indexer/graph-boost";
import { loadStoredGraphSnapshot } from "../indexer/graph-db";
import type { GraphFile, GraphFileNode } from "../indexer/graph-extraction";
import { lookup } from "../indexer/indexer";
import { resolveAssetPath } from "../indexer/path-resolver";
import { findSourceForPath, resolveSourceEntries } from "../indexer/search-source";

export interface GraphSummaryResult {
  schemaVersion: 1;
  shape: "graph-summary";
  stashPath: string;
  graphPath: string;
  generatedAt: string;
  fileCount: number;
  entityCount: number;
  relationCount: number;
  quality?: GraphFile["quality"];
}

export interface GraphEntitiesResult {
  schemaVersion: 1;
  shape: "graph-entities";
  stashPath: string;
  graphPath: string;
  generatedAt: string;
  total: number;
  entities: Array<{ name: string; fileCount: number }>;
}

export interface GraphRelationsResult {
  schemaVersion: 1;
  shape: "graph-relations";
  stashPath: string;
  graphPath: string;
  generatedAt: string;
  total: number;
  relations: Array<{ from: string; to: string; type?: string; count: number }>;
}

export interface GraphExportResult {
  schemaVersion: 1;
  shape: "graph-export";
  stashPath: string;
  graphPath: string;
  outPath: string;
  format: "json" | "jsonl";
  bytes: number;
}

export interface GraphRelatedResult {
  schemaVersion: 1;
  shape: "graph-related";
  stashPath: string;
  graphPath: string;
  generatedAt: string;
  ref: string;
  path: string;
  total: number;
  related: Array<{ path: string; type: string; sharedEntities: string[]; relationCount: number }>;
  tip?: string;
}

interface LoadedGraph {
  graph: GraphFile;
  stashPath: string;
  graphPath: string;
}

interface ResolvedGraphTarget {
  ref: string;
  parsedRef: ReturnType<typeof parseAssetRef>;
  filePath: string;
  stashPath: string;
}

function resolveGraphStashPath(source?: string): string {
  const sources = resolveSourceEntries(undefined, loadConfig());
  if (sources.length === 0) {
    throw new NotFoundError("No stash sources are configured.", "STASH_NOT_FOUND");
  }
  if (!source || source === "primary") return sources[0].path;
  const matched = sources.find((entry) => entry.registryId === source || entry.path === source);
  if (!matched) {
    throw new NotFoundError(`Source not found: ${source}`, "SOURCE_NOT_FOUND", "Run `akm list` to see source names.");
  }
  return matched.path;
}

function loadGraph(source?: string): LoadedGraph {
  const stashPath = resolveGraphStashPath(source);
  let db: import("bun:sqlite").Database | undefined;
  try {
    db = openExistingDatabase();
    const snapshot = loadStoredGraphSnapshot(stashPath, db);
    if (!snapshot) {
      throw new NotFoundError(
        `Graph data not found for source ${stashPath}.`,
        "FILE_NOT_FOUND",
        "Run the improvement flow that refreshes graph extraction data.",
      );
    }
    return {
      graph: {
        schemaVersion: snapshot.schemaVersion,
        generatedAt: snapshot.generatedAt,
        stashRoot: snapshot.stashPath,
        files: snapshot.files,
        entities: snapshot.entities,
        relations: snapshot.relations,
        ...(snapshot.quality ? { quality: snapshot.quality } : {}),
      },
      stashPath,
      graphPath: snapshot.graphPath,
    };
  } finally {
    if (db) closeDatabase(db);
  }
}

function countEntitiesByFile(nodes: GraphFileNode[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const seen = new Set<string>();
    for (const entity of node.entities) {
      if (seen.has(entity)) continue;
      seen.add(entity);
      counts.set(entity, (counts.get(entity) ?? 0) + 1);
    }
  }
  return counts;
}

export function akmGraphSummary(options?: { source?: string }): GraphSummaryResult {
  const { graph, stashPath, graphPath } = loadGraph(options?.source);
  return {
    schemaVersion: 1,
    shape: "graph-summary",
    stashPath,
    graphPath,
    generatedAt: graph.generatedAt,
    fileCount: graph.files.length,
    entityCount: Array.isArray(graph.entities) ? graph.entities.length : countEntitiesByFile(graph.files).size,
    relationCount: Array.isArray(graph.relations)
      ? graph.relations.length
      : graph.files.reduce((sum, node) => sum + node.relations.length, 0),
    ...(graph.quality ? { quality: graph.quality } : {}),
  };
}

export function akmGraphEntities(options?: { source?: string; limit?: number }): GraphEntitiesResult {
  const { graph, stashPath, graphPath } = loadGraph(options?.source);
  const limit = options?.limit;
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    throw new UsageError("--limit must be a positive integer.", "INVALID_FLAG_VALUE");
  }
  const counts = countEntitiesByFile(graph.files);
  const entities = [...counts.entries()]
    .map(([name, fileCount]) => ({ name, fileCount }))
    .sort((a, b) => b.fileCount - a.fileCount || a.name.localeCompare(b.name));
  const sliced = typeof limit === "number" ? entities.slice(0, limit) : entities;
  return {
    schemaVersion: 1,
    shape: "graph-entities",
    stashPath,
    graphPath,
    generatedAt: graph.generatedAt,
    total: entities.length,
    entities: sliced,
  };
}

export function akmGraphRelations(options?: { source?: string; limit?: number }): GraphRelationsResult {
  const { graph, stashPath, graphPath } = loadGraph(options?.source);
  const limit = options?.limit;
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    throw new UsageError("--limit must be a positive integer.", "INVALID_FLAG_VALUE");
  }
  const counts = new Map<string, { from: string; to: string; type?: string; count: number }>();
  for (const node of graph.files) {
    for (const rel of node.relations) {
      const key = `${rel.from}\u0000${rel.to}\u0000${rel.type ?? ""}`;
      const existing = counts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(key, { from: rel.from, to: rel.to, ...(rel.type ? { type: rel.type } : {}), count: 1 });
      }
    }
  }
  const relations = [...counts.values()].sort(
    (a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );
  const sliced = typeof limit === "number" ? relations.slice(0, limit) : relations;
  return {
    schemaVersion: 1,
    shape: "graph-relations",
    stashPath,
    graphPath,
    generatedAt: graph.generatedAt,
    total: relations.length,
    relations: sliced,
  };
}

export function akmGraphExport(options: { source?: string; out: string; format?: string }): GraphExportResult {
  if (!options.out?.trim()) {
    throw new UsageError("`akm graph export` requires --out <path>.", "MISSING_REQUIRED_ARGUMENT");
  }
  const format = options.format ?? "json";
  if (format !== "json" && format !== "jsonl") {
    throw new UsageError("--format must be one of: json, jsonl.", "INVALID_FLAG_VALUE");
  }
  const { graph, stashPath, graphPath } = loadGraph(options.source);
  const outPath = path.resolve(options.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const payload =
    format === "json"
      ? `${JSON.stringify(graph, null, 2)}\n`
      : `${[
          ...graph.files.flatMap((file) =>
            file.entities.map((entity) => JSON.stringify({ kind: "entity", entity, file: file.path })),
          ),
          ...graph.files.flatMap((file) =>
            file.relations.map((relation) => JSON.stringify({ kind: "relation", ...relation, file: file.path })),
          ),
        ].join("\n")}\n`;
  fs.writeFileSync(outPath, payload, "utf8");
  return {
    schemaVersion: 1,
    shape: "graph-export",
    stashPath,
    graphPath,
    outPath,
    format,
    bytes: Buffer.byteLength(payload, "utf8"),
  };
}

export async function akmGraphRelated(options: {
  ref: string;
  source?: string;
  limit?: number;
}): Promise<GraphRelatedResult> {
  const ref = options.ref.trim();
  if (!ref) {
    throw new UsageError("`akm graph related` requires <ref>.", "MISSING_REQUIRED_ARGUMENT");
  }
  const limit = options.limit;
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    throw new UsageError("--limit must be a positive integer.", "INVALID_FLAG_VALUE");
  }
  const target = await resolveGraphTarget(ref, options.source);
  const { graph, stashPath, graphPath } = loadGraph(target.stashPath);
  let db: import("bun:sqlite").Database | undefined;
  const related = (() => {
    try {
      db = openExistingDatabase();
      return listRelatedPathsForFile(stashPath, target.filePath, limit ?? 5, db);
    } finally {
      if (db) closeDatabase(db);
    }
  })();
  return {
    schemaVersion: 1,
    shape: "graph-related",
    stashPath,
    graphPath,
    generatedAt: graph.generatedAt,
    ref: target.ref,
    path: target.filePath,
    total: related.length,
    related,
    ...(related.length === 0 ? { tip: "No related graph neighbors were found for this asset." } : {}),
  };
}

async function resolveGraphTarget(ref: string, source?: string): Promise<ResolvedGraphTarget> {
  const parsedRef = parseAssetRef(ref);
  const filePath =
    (await resolveAssetPath(parsedRef, {
      mode: "index-first",
      honorOrigin: true,
    })) ?? (await lookup(parsedRef))?.filePath;
  if (!filePath) {
    throw new NotFoundError(`Asset not found for ref: ${ref}`);
  }

  const allSources = resolveSourceEntries(undefined, loadConfig());
  const matchedSource = findSourceForPath(filePath, allSources);
  const inferredStashPath = matchedSource?.path;
  const stashPath = source ? resolveGraphStashPath(source) : inferredStashPath;
  if (!stashPath) {
    throw new NotFoundError(`Could not determine stash source for ref: ${ref}`, "SOURCE_NOT_FOUND");
  }
  if (!filePath.startsWith(path.resolve(stashPath) + path.sep) && path.resolve(filePath) !== path.resolve(stashPath)) {
    throw new UsageError(
      `Resolved asset ${ref} is not inside source ${source ?? stashPath}.`,
      "INVALID_SOURCE_VALUE",
      "Pass --source for the asset's source, or omit it to infer from the resolved asset path.",
    );
  }

  return {
    ref,
    parsedRef,
    filePath,
    stashPath,
  };
}
