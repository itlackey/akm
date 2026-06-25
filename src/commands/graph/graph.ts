// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { parseAssetRef } from "../../core/asset/asset-ref";
import { type AkmConfig, loadConfig } from "../../core/config/config";
import { NotFoundError, UsageError } from "../../core/errors";
import { getDbPath } from "../../core/paths";
import { warn } from "../../core/warn";
import {
  closeDatabase,
  findEntryIdByRef,
  getEntryById,
  getEntryRefRowsForStashRoot,
  openExistingDatabase,
  openIndexDatabase,
} from "../../indexer/db/db";
import { loadStoredGraphSnapshot } from "../../indexer/db/graph-db";
import { listRelatedPathsForFile } from "../../indexer/graph/graph-boost";
import type {
  GraphExtractionPassOptions,
  GraphExtractionTelemetry,
  GraphFile,
  GraphFileNode,
} from "../../indexer/graph/graph-extraction";
import { runGraphExtractionPass } from "../../indexer/graph/graph-extraction";
import { withIndexWriterLease } from "../../indexer/index-writer-lock";
import { lookup } from "../../indexer/indexer";
import { findSourceForPath, resolveSourceEntries } from "../../indexer/search/search-source";
import { resolveAssetPath } from "../../indexer/walk/path-resolver";

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
  telemetry?: GraphExtractionTelemetry;
}

export interface GraphEntitiesResult {
  schemaVersion: 1;
  shape: "graph-entities";
  stashPath: string;
  graphPath: string;
  generatedAt: string;
  total: number;
  entities: Array<{ name: string; fileCount: number; confidence?: number }>;
}

export interface GraphRelationsResult {
  schemaVersion: 1;
  shape: "graph-relations";
  stashPath: string;
  graphPath: string;
  generatedAt: string;
  total: number;
  relations: Array<{ from: string; to: string; type?: string; count: number; confidence?: number }>;
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
  related: Array<{ ref?: string; path: string; type: string; sharedEntities: string[]; relationCount: number }>;
  tip?: string;
}

export interface GraphEntityResult {
  schemaVersion: 1;
  shape: "graph-entity";
  stashPath: string;
  graphPath: string;
  generatedAt: string;
  entity: string;
  total: number;
  matches: Array<{ ref?: string; path: string; type: string; confidence?: number }>;
}

export interface GraphOrphansResult {
  schemaVersion: 1;
  shape: "graph-orphans";
  stashPath: string;
  graphPath: string;
  generatedAt: string;
  totalConsidered: number;
  total: number;
  orphans: Array<{
    ref?: string;
    path: string;
    type: string;
    status?: GraphFileNode["status"];
    reason?: GraphFileNode["reason"];
  }>;
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
  let db: import("../../storage/database").Database | undefined;
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
        ...(snapshot.telemetry ? { telemetry: snapshot.telemetry } : {}),
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

function aggregateEntityStats(nodes: GraphFileNode[]): Map<string, { fileCount: number; confidence?: number }> {
  const stats = new Map<string, { fileCount: number; confidence?: number }>();
  for (const node of nodes) {
    const seen = new Set<string>();
    for (const entity of node.entities) {
      if (seen.has(entity)) continue;
      seen.add(entity);
      const existing = stats.get(entity);
      const nodeConf =
        typeof node.confidence === "number" && Number.isFinite(node.confidence) ? node.confidence : undefined;
      if (existing) {
        existing.fileCount += 1;
        if (nodeConf !== undefined && (existing.confidence === undefined || nodeConf > existing.confidence)) {
          existing.confidence = nodeConf;
        }
      } else {
        stats.set(entity, { fileCount: 1, ...(nodeConf !== undefined ? { confidence: nodeConf } : {}) });
      }
    }
  }
  return stats;
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
    ...(graph.telemetry ? { telemetry: graph.telemetry } : {}),
  };
}

export function akmGraphEntities(options?: { source?: string; limit?: number }): GraphEntitiesResult {
  const { graph, stashPath, graphPath } = loadGraph(options?.source);
  const limit = options?.limit;
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    throw new UsageError("--limit must be a positive integer.", "INVALID_FLAG_VALUE");
  }
  const stats = aggregateEntityStats(graph.files);
  const entities = [...stats.entries()]
    .map(([name, info]) => ({
      name,
      fileCount: info.fileCount,
      ...(info.confidence !== undefined ? { confidence: info.confidence } : {}),
    }))
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
  const counts = new Map<string, { from: string; to: string; type?: string; count: number; confidence?: number }>();
  for (const node of graph.files) {
    for (const rel of node.relations) {
      const key = `${rel.from}\u0000${rel.to}\u0000${rel.type ?? ""}`;
      const relConf =
        typeof rel.confidence === "number" && Number.isFinite(rel.confidence) ? rel.confidence : undefined;
      const existing = counts.get(key);
      if (existing) {
        existing.count += 1;
        if (relConf !== undefined && (existing.confidence === undefined || relConf > existing.confidence)) {
          existing.confidence = relConf;
        }
      } else {
        counts.set(key, {
          from: rel.from,
          to: rel.to,
          ...(rel.type ? { type: rel.type } : {}),
          count: 1,
          ...(relConf !== undefined ? { confidence: relConf } : {}),
        });
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
  let db: import("../../storage/database").Database | undefined;
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

function normalizeGraphName(value: string): string {
  return value.trim().toLowerCase();
}

function buildRefByPath(
  stashRoot: string,
  db: import("../../storage/database").Database,
): Map<string, { ref: string; type: string }> {
  const rows = getEntryRefRowsForStashRoot(db, stashRoot);
  const map = new Map<string, { ref: string; type: string }>();
  for (const row of rows) {
    if (map.has(row.file_path)) continue;
    try {
      const entry = JSON.parse(row.entry_json) as {
        type?: string;
        name?: string;
      };
      if (typeof entry.type === "string" && typeof entry.name === "string") {
        map.set(row.file_path, { ref: `${entry.type}:${entry.name}`, type: entry.type });
      }
    } catch {
      // ignore corrupt entry_json
    }
  }
  return map;
}

export function akmGraphEntity(options: { name: string; source?: string; limit?: number }): GraphEntityResult {
  const name = options.name?.trim();
  if (!name) {
    throw new UsageError("`akm graph entity` requires <name>.", "MISSING_REQUIRED_ARGUMENT");
  }
  const limit = options.limit;
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    throw new UsageError("--limit must be a positive integer.", "INVALID_FLAG_VALUE");
  }
  const { graph, stashPath, graphPath } = loadGraph(options.source);
  const target = normalizeGraphName(name);

  let db: import("../../storage/database").Database | undefined;
  let refByPath: Map<string, { ref: string; type: string }>;
  try {
    db = openExistingDatabase();
    refByPath = buildRefByPath(stashPath, db);
  } finally {
    if (db) closeDatabase(db);
  }

  const matches: Array<{ ref?: string; path: string; type: string; confidence?: number }> = [];
  for (const node of graph.files) {
    const found = node.entities.some((entity) => normalizeGraphName(entity) === target);
    if (!found) continue;
    const lookup = refByPath.get(node.path);
    const conf = typeof node.confidence === "number" && Number.isFinite(node.confidence) ? node.confidence : undefined;
    matches.push({
      ...(lookup?.ref ? { ref: lookup.ref } : {}),
      path: node.path,
      type: node.type,
      ...(conf !== undefined ? { confidence: conf } : {}),
    });
  }

  matches.sort((a, b) => {
    const ca = a.confidence ?? 0;
    const cb = b.confidence ?? 0;
    if (cb !== ca) return cb - ca;
    return a.path.localeCompare(b.path);
  });

  const sliced = typeof limit === "number" ? matches.slice(0, limit) : matches;
  return {
    schemaVersion: 1,
    shape: "graph-entity",
    stashPath,
    graphPath,
    generatedAt: graph.generatedAt,
    entity: name,
    total: matches.length,
    matches: sliced,
  };
}

export function akmGraphOrphans(options?: { source?: string; limit?: number }): GraphOrphansResult {
  const limit = options?.limit;
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    throw new UsageError("--limit must be a positive integer.", "INVALID_FLAG_VALUE");
  }
  const { graph, stashPath, graphPath } = loadGraph(options?.source);

  let db: import("../../storage/database").Database | undefined;
  let refByPath: Map<string, { ref: string; type: string }>;
  try {
    db = openExistingDatabase();
    refByPath = buildRefByPath(stashPath, db);
  } finally {
    if (db) closeDatabase(db);
  }

  const orphans: Array<{
    ref?: string;
    path: string;
    type: string;
    status?: GraphFileNode["status"];
    reason?: GraphFileNode["reason"];
  }> = [];
  for (const node of graph.files) {
    if ((node.status ?? (node.entities.length > 0 ? "extracted" : "empty")) === "extracted") continue;
    const lookup = refByPath.get(node.path);
    orphans.push({
      ...(lookup?.ref ? { ref: lookup.ref } : {}),
      path: node.path,
      type: node.type,
      ...(node.status ? { status: node.status } : {}),
      ...(node.reason ? { reason: node.reason } : {}),
    });
  }

  orphans.sort((a, b) => a.type.localeCompare(b.type) || a.path.localeCompare(b.path));
  const sliced = typeof limit === "number" ? orphans.slice(0, limit) : orphans;
  return {
    schemaVersion: 1,
    shape: "graph-orphans",
    stashPath,
    graphPath,
    generatedAt: graph.generatedAt,
    totalConsidered: graph.files.length,
    total: orphans.length,
    orphans: sliced,
  };
}

export interface GraphUpdateResult {
  shape: "graph-update";
  ok: true;
  filesExtracted: number;
  entitiesUpserted: number;
  relationsUpserted: number;
  durationMs: number;
  /** true when refs were provided to scope the extraction pass. */
  scoped: boolean;
}

/**
 * Re-run graph extraction, optionally scoped to specific asset refs.
 *
 * When `refs` is provided, only those files are re-extracted (incremental).
 * When no refs are given, the full eligible set is re-extracted.
 */
export async function akmGraphUpdate(options: {
  refs?: string[];
  source?: string;
  /** Test seam: override stash directory resolution. */
  stashDir?: string;
  /** Test seam: inject a pre-loaded AkmConfig. */
  config?: AkmConfig;
  /** Test seam: inject the graph extraction function. */
  graphExtractionFn?: typeof runGraphExtractionPass;
}): Promise<GraphUpdateResult> {
  const config = options.config ?? loadConfig();
  const sources = resolveSourceEntries(options.stashDir, config);
  if (sources.length === 0) {
    throw new NotFoundError("No stash sources are configured.", "STASH_NOT_FOUND");
  }
  if (options.source && options.source !== "primary") {
    const matched = sources.find((s) => s.registryId === options.source || s.path === options.source);
    if (!matched) {
      throw new NotFoundError(
        `Source not found: ${options.source}`,
        "SOURCE_NOT_FOUND",
        "Run `akm list` to see source names.",
      );
    }
  }

  const scoped = Array.isArray(options.refs) && options.refs.length > 0;

  return withIndexWriterLease({ purpose: "graph-update" }, async () => {
    let candidatePaths: Set<string> | undefined;
    if (scoped && options.refs) {
      // Resolve each ref to an absolute file path while the writer lease is held
      // so the scoped graph write sees the same index snapshot it resolved from.
      const dbPath = getDbPath();
      let db: import("../../storage/database").Database | undefined;
      const resolvedPaths = new Set<string>();
      try {
        db = openIndexDatabase(dbPath);
        for (const ref of options.refs) {
          const trimmed = ref.trim();
          if (!trimmed) continue;
          const entryId = findEntryIdByRef(db, trimmed);
          if (entryId === undefined) {
            warn(`[graph] ref not found in index, skipping: ${trimmed}`);
            continue;
          }
          const row = getEntryById(db, entryId);
          if (!row?.filePath) {
            warn(`[graph] could not resolve path for ref, skipping: ${trimmed}`);
            continue;
          }
          resolvedPaths.add(row.filePath);
        }
      } finally {
        if (db) closeDatabase(db);
      }

      if (resolvedPaths.size === 0) {
        warn("[graph] none of the provided refs resolved to indexed paths — no extraction performed.");
        return {
          shape: "graph-update",
          ok: true,
          filesExtracted: 0,
          entitiesUpserted: 0,
          relationsUpserted: 0,
          durationMs: 0,
          scoped: true,
        };
      }
      candidatePaths = resolvedPaths;
    }

    const extractionFn = options.graphExtractionFn ?? runGraphExtractionPass;
    const passOptions: GraphExtractionPassOptions = candidatePaths ? { candidatePaths } : {};

    let db: import("../../storage/database").Database | undefined;
    const startMs = Date.now();
    try {
      db = openIndexDatabase(getDbPath());

      const onProgress = (event: {
        processed: number;
        total: number;
        extracted: number;
        totalEntities: number;
        totalRelations: number;
        currentPath?: string;
      }) => {
        if (!event.currentPath) return;
        const file = path.basename(event.currentPath);
        warn(`[graph] extracting ${event.processed}/${event.total} ${file}`);
      };

      const result = await extractionFn({
        config,
        sources,
        signal: undefined,
        db,
        reEnrich: false,
        onProgress,
        options: passOptions,
      });
      const durationMs = Date.now() - startMs;

      return {
        shape: "graph-update",
        ok: true,
        filesExtracted: result.quality.extractedFiles,
        entitiesUpserted: result.quality.entityCount,
        relationsUpserted: result.quality.relationCount,
        durationMs,
        scoped,
      };
    } finally {
      if (db) closeDatabase(db);
    }
  });
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
