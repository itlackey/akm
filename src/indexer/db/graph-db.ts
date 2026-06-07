// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Database } from "bun:sqlite";
import fs from "node:fs";
import { rethrowIfTestIsolationError } from "../../core/errors";
import { getDbPath } from "../../core/paths";
import { warn } from "../../core/warn";
import type { GraphRelation } from "../../llm/graph-extract";
import { closeDatabase, openExistingDatabase } from "../db";
import type {
  GraphExtractionTelemetry,
  GraphFile,
  GraphFileNode,
  GraphQualityTelemetry,
} from "../graph/graph-extraction";

export interface StoredGraphSnapshot {
  stashPath: string;
  graphPath: string;
  schemaVersion: number;
  generatedAt: string;
  quality?: GraphQualityTelemetry;
  telemetry?: GraphExtractionTelemetry;
  files: GraphFileNode[];
  entities: string[];
  relations: GraphRelation[];
}

export interface StoredGraphMeta {
  stashPath: string;
  graphPath: string;
  schemaVersion: number;
  generatedAt: string;
  quality?: GraphQualityTelemetry;
  telemetry?: GraphExtractionTelemetry;
}

function withReadableGraphDb<T>(db: Database | undefined, fn: (db: Database) => T): T {
  if (db) return fn(db);
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) throw new Error("GRAPH_DB_MISSING");
  const opened = openExistingDatabase(dbPath);
  try {
    return fn(opened);
  } finally {
    closeDatabase(opened);
  }
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function normalizeEntity(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Resolve a file_path within a stash to its entries.id. Returns null when the
 * path has no indexed entry (orphan graph row).
 */
export function resolveEntryIdForPath(db: Database, stashRoot: string, filePath: string): number | null {
  try {
    const row = db
      .prepare("SELECT id FROM entries WHERE stash_dir = ? AND file_path = ? LIMIT 1")
      .get(stashRoot, filePath) as { id: number } | undefined;
    if (row) return row.id;
    // Fall back to file_path-only match (legacy callers may pass a stash root
    // that doesn't exactly match entries.stash_dir, e.g. trailing-slash diffs).
    const fallback = db.prepare("SELECT id FROM entries WHERE file_path = ? LIMIT 1").get(filePath) as
      | { id: number }
      | undefined;
    return fallback?.id ?? null;
  } catch {
    return null;
  }
}

interface ExistingGraphFileRow {
  entry_id: number;
  file_path: string;
  body_hash: string;
}

/**
 * Persist (or update) a graph snapshot for a stash root.
 *
 * Implementation: incremental upsert keyed on entries.id. Unchanged files
 * (matching body_hash) are skipped; changed files have their child rows
 * deleted (CASCADE) and re-inserted; files in DB but absent from the new
 * snapshot are deleted. The old behaviour wiped every row for the stash on
 * each write, which produced ~22k row writes per re-index even when one
 * asset changed.
 *
 * Orphan files (no entries row resolvable) are skipped and counted in a
 * single warn() so the caller sees the magnitude without log spam.
 */
export function replaceStoredGraph(db: Database, graph: GraphFile): void {
  const upsertMeta = db.prepare(
    `INSERT INTO graph_meta (
       stash_root,
       schema_version,
       generated_at,
       considered_files,
       extracted_files,
       entity_count,
       relation_count,
       extraction_coverage,
       density,
       extractor_id,
       extraction_run_id,
       model,
       prompt_version,
       batch_size,
       cache_hits,
       cache_misses,
       truncation_count,
       failure_count
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(stash_root) DO UPDATE SET
        schema_version = excluded.schema_version,
        generated_at = excluded.generated_at,
        considered_files = excluded.considered_files,
        extracted_files = excluded.extracted_files,
        entity_count = excluded.entity_count,
        relation_count = excluded.relation_count,
        extraction_coverage = excluded.extraction_coverage,
        density = excluded.density,
        extractor_id = excluded.extractor_id,
        extraction_run_id = excluded.extraction_run_id,
        model = excluded.model,
        prompt_version = excluded.prompt_version,
        batch_size = excluded.batch_size,
        cache_hits = excluded.cache_hits,
        cache_misses = excluded.cache_misses,
        truncation_count = excluded.truncation_count,
        failure_count = excluded.failure_count`,
  );

  const selectExisting = db.prepare("SELECT entry_id, file_path, body_hash FROM graph_files WHERE stash_root = ?");
  const deleteFile = db.prepare("DELETE FROM graph_files WHERE entry_id = ?");
  const deleteEntities = db.prepare("DELETE FROM graph_file_entities WHERE entry_id = ?");
  const deleteRelations = db.prepare("DELETE FROM graph_file_relations WHERE entry_id = ?");
  const insertFile = db.prepare(
    `INSERT INTO graph_files (
       entry_id, stash_root, file_path, file_order, file_type, body_hash, confidence, status, reason, extraction_run_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateFileMeta = db.prepare(
    `UPDATE graph_files
       SET file_order = ?, file_type = ?, confidence = ?, status = ?, reason = ?, extraction_run_id = ?
        WHERE entry_id = ?`,
  );
  const insertEntity = db.prepare(
    `INSERT INTO graph_file_entities (entry_id, entity_order, stash_root, entity_norm, entity)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertRelation = db.prepare(
    `INSERT INTO graph_file_relations (
       entry_id, relation_order, from_entity_norm, from_entity, to_entity_norm, to_entity, relation_type, confidence
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const quality = graph.quality;
  const telemetry = graph.telemetry;

  db.transaction(() => {
    upsertMeta.run(
      graph.stashRoot,
      graph.schemaVersion,
      graph.generatedAt,
      quality?.consideredFiles ?? graph.files.length,
      quality?.extractedFiles ?? graph.files.length,
      quality?.entityCount ?? graph.entities?.length ?? 0,
      quality?.relationCount ?? graph.relations?.length ?? 0,
      quality?.extractionCoverage ?? 0,
      quality?.density ?? 0,
      telemetry?.extractorId ?? null,
      telemetry?.extractionRunId ?? null,
      telemetry?.model ?? null,
      telemetry?.promptVersion ?? null,
      telemetry?.batchSize ?? null,
      telemetry?.cacheHits ?? 0,
      telemetry?.cacheMisses ?? 0,
      telemetry?.truncationCount ?? 0,
      telemetry?.failureCount ?? 0,
    );

    // Build a snapshot of existing rows for incremental compare.
    const existingRows = selectExisting.all(graph.stashRoot) as ExistingGraphFileRow[];
    const existingByPath = new Map<string, ExistingGraphFileRow>();
    for (const row of existingRows) existingByPath.set(row.file_path, row);

    let orphanCount = 0;
    const presentEntryIds = new Set<number>();

    for (const [fileOrder, node] of graph.files.entries()) {
      // body_hash is NOT NULL in schema v2; default to a sentinel for inputs
      // (test fixtures, legacy imports) that don't supply one. The sentinel
      // never equals a real hash so subsequent staleness checks always
      // re-extract — correct behaviour for "unknown" bodies.
      const bodyHash = node.bodyHash && node.bodyHash.length > 0 ? node.bodyHash : "";

      const entryId = resolveEntryIdForPath(db, graph.stashRoot, node.path);
      if (entryId == null) {
        orphanCount += 1;
        continue;
      }
      presentEntryIds.add(entryId);

      const existing = existingByPath.get(node.path);
      if (existing && existing.entry_id === entryId && existing.body_hash === bodyHash) {
        // Body unchanged — only fix up file_order/confidence in case they drifted.
        updateFileMeta.run(
          fileOrder,
          node.type,
          node.confidence ?? null,
          node.status ?? (node.entities.length > 0 ? "extracted" : "empty"),
          node.reason ?? (node.entities.length > 0 ? "none" : "no_graph_content"),
          node.extractionRunId ?? telemetry?.extractionRunId ?? null,
          entryId,
        );
        continue;
      }

      if (existing) {
        // Stale row (different body_hash, or entry_id moved to a different
        // path under the same file_path). Wipe child rows; CASCADE would do
        // it but explicit DELETE keeps the order deterministic.
        deleteEntities.run(existing.entry_id);
        deleteRelations.run(existing.entry_id);
        deleteFile.run(existing.entry_id);
      }

      insertFile.run(
        entryId,
        graph.stashRoot,
        node.path,
        fileOrder,
        node.type,
        bodyHash,
        node.confidence ?? null,
        node.status ?? (node.entities.length > 0 ? "extracted" : "empty"),
        node.reason ?? (node.entities.length > 0 ? "none" : "no_graph_content"),
        node.extractionRunId ?? telemetry?.extractionRunId ?? null,
      );
      for (const [entityOrder, entity] of node.entities.entries()) {
        insertEntity.run(entryId, entityOrder, graph.stashRoot, normalizeEntity(entity), entity);
      }
      for (const [relationOrder, relation] of node.relations.entries()) {
        insertRelation.run(
          entryId,
          relationOrder,
          normalizeEntity(relation.from),
          relation.from,
          normalizeEntity(relation.to),
          relation.to,
          relation.type ?? null,
          relation.confidence ?? null,
        );
      }
    }

    // Delete files present in DB but absent from the new snapshot. Child
    // tables CASCADE on entry_id.
    for (const row of existingRows) {
      if (!presentEntryIds.has(row.entry_id)) {
        deleteEntities.run(row.entry_id);
        deleteRelations.run(row.entry_id);
        deleteFile.run(row.entry_id);
      }
    }

    if (orphanCount > 0) {
      warn(
        `[graph] replaceStoredGraph: skipped ${orphanCount} file(s) with no resolvable entry under ${graph.stashRoot}.`,
      );
    }
  })();
}

export function deleteStoredGraph(db: Database, stashPath: string): void {
  db.transaction(() => {
    // Child rows cascade via entry_id; deleting graph_files clears them.
    db.prepare("DELETE FROM graph_files WHERE stash_root = ?").run(stashPath);
    db.prepare("DELETE FROM graph_meta WHERE stash_root = ?").run(stashPath);
  })();
}

/**
 * Scoped loader — only the graph_meta row for a stash. Used by callers that
 * only need summary numbers (e.g. `akm graph summary`).
 */
export function loadGraphMetaOnly(stashPath: string, db?: Database): StoredGraphMeta | null {
  return loadStoredGraphMeta(stashPath, db);
}

/**
 * Scoped loader — graph_files rows without entities/relations. Used for
 * orphan detection and entity overview commands.
 */
export function loadGraphFilesOnly(
  stashPath: string,
  db?: Database,
): Array<{
  entryId: number;
  path: string;
  type: string;
  bodyHash: string;
  confidence?: number;
  status?: GraphFileNode["status"];
  reason?: GraphFileNode["reason"];
}> {
  try {
    return withReadableGraphDb(db, (readDb) => {
      try {
        const rows = readDb
          .prepare(
            `SELECT entry_id, file_path, file_type, body_hash, confidence, status, reason
                FROM graph_files
                WHERE stash_root = ?
                ORDER BY file_order`,
          )
          .all(stashPath) as Array<{
          entry_id: number;
          file_path: string;
          file_type: string;
          body_hash: string;
          confidence: number | null;
          status: string | null;
          reason: string | null;
        }>;
        return rows.map((row) => ({
          entryId: row.entry_id,
          path: row.file_path,
          type: row.file_type,
          bodyHash: row.body_hash,
          ...(typeof row.confidence === "number" ? { confidence: row.confidence } : {}),
          ...(row.status ? { status: row.status as GraphFileNode["status"] } : {}),
          ...(row.reason ? { reason: row.reason as GraphFileNode["reason"] } : {}),
        }));
      } catch {
        return [];
      }
    });
  } catch (err) {
    // Never mask the bun-test isolation guard as "no stored graph files".
    rethrowIfTestIsolationError(err);
    return [];
  }
}

/**
 * Scoped loader — entities for a single entry_id. Used by per-asset lookups.
 */
export function loadGraphEntitiesByEntry(db: Database, entryId: number): string[] {
  try {
    const rows = db
      .prepare("SELECT entity FROM graph_file_entities WHERE entry_id = ? ORDER BY entity_order")
      .all(entryId) as Array<{ entity: string }>;
    return rows.map((r) => r.entity);
  } catch {
    return [];
  }
}

export function loadStoredGraphMeta(stashPath: string, db?: Database): StoredGraphMeta | null {
  try {
    return withReadableGraphDb(db, (readDb) => {
      try {
        const row = readDb
          .prepare(
            `SELECT
               stash_root,
               schema_version,
               generated_at,
               considered_files,
               extracted_files,
               entity_count,
               relation_count,
               extraction_coverage,
               density,
               extractor_id,
               extraction_run_id,
               model,
               prompt_version,
               batch_size,
               cache_hits,
               cache_misses,
               truncation_count,
               failure_count
              FROM graph_meta
              WHERE stash_root = ?`,
          )
          .get(stashPath) as
          | {
              stash_root: string;
              schema_version: number;
              generated_at: string;
              considered_files: number;
              extracted_files: number;
              entity_count: number;
              relation_count: number;
              extraction_coverage: number;
              density: number;
              extractor_id: string | null;
              extraction_run_id: string | null;
              model: string | null;
              prompt_version: string | null;
              batch_size: number | null;
              cache_hits: number;
              cache_misses: number;
              truncation_count: number;
              failure_count: number;
            }
          | undefined;
        if (!row) return null;
        return {
          stashPath: row.stash_root,
          graphPath: getDbPath(),
          schemaVersion: row.schema_version,
          generatedAt: row.generated_at,
          quality: {
            consideredFiles: row.considered_files,
            extractedFiles: row.extracted_files,
            entityCount: row.entity_count,
            relationCount: row.relation_count,
            extractionCoverage: row.extraction_coverage,
            density: row.density,
          },
          telemetry: {
            ...(row.extractor_id ? { extractorId: row.extractor_id } : {}),
            ...(row.extraction_run_id ? { extractionRunId: row.extraction_run_id } : {}),
            ...(row.model ? { model: row.model } : {}),
            ...(row.prompt_version ? { promptVersion: row.prompt_version } : {}),
            ...(typeof row.batch_size === "number" ? { batchSize: row.batch_size } : {}),
            cacheHits: row.cache_hits,
            cacheMisses: row.cache_misses,
            truncationCount: row.truncation_count,
            failureCount: row.failure_count,
            // `retry_attempts` is not persisted to the graph-meta table (it is
            // surfaced from the run's emitted telemetry into `akm health`, not
            // from the reuse cache). Default to 0 so the loaded shape satisfies
            // GraphExtractionTelemetry.
            retryAttempts: 0,
          },
        };
      } catch {
        return null;
      }
    });
  } catch (err) {
    // Never mask the bun-test isolation guard as "no stored graph meta".
    rethrowIfTestIsolationError(err);
    return null;
  }
}

export function loadStoredGraphSnapshot(stashPath: string, db?: Database): StoredGraphSnapshot | null {
  try {
    return withReadableGraphDb(db, (readDb) => {
      const meta = loadStoredGraphMeta(stashPath, readDb);
      if (!meta) return null;

      try {
        const fileRows = readDb
          .prepare(
            `SELECT entry_id, file_path, file_type, body_hash, confidence, status, reason, extraction_run_id
              FROM graph_files
              WHERE stash_root = ?
              ORDER BY file_order`,
          )
          .all(stashPath) as Array<{
          entry_id: number;
          file_path: string;
          file_type: string;
          body_hash: string | null;
          confidence: number | null;
          status: string | null;
          reason: string | null;
          extraction_run_id: string | null;
        }>;
        const entityRows = readDb
          .prepare(
            `SELECT gfe.entry_id AS entry_id, gf.file_path AS file_path, gfe.entity AS entity
             FROM graph_file_entities gfe
             JOIN graph_files gf ON gf.entry_id = gfe.entry_id
             WHERE gf.stash_root = ?
             ORDER BY gf.file_order, gfe.entity_order`,
          )
          .all(stashPath) as Array<{ entry_id: number; file_path: string; entity: string }>;
        const relationRows = readDb
          .prepare(
            `SELECT gfr.entry_id AS entry_id,
                    gf.file_path AS file_path,
                    gfr.from_entity AS from_entity,
                    gfr.to_entity AS to_entity,
                    gfr.relation_type AS relation_type,
                    gfr.confidence AS confidence
             FROM graph_file_relations gfr
             JOIN graph_files gf ON gf.entry_id = gfr.entry_id
             WHERE gf.stash_root = ?
             ORDER BY gf.file_order, gfr.relation_order`,
          )
          .all(stashPath) as Array<{
          entry_id: number;
          file_path: string;
          from_entity: string;
          to_entity: string;
          relation_type: string | null;
          confidence: number | null;
        }>;

        const entitiesByPath = new Map<string, string[]>();
        for (const row of entityRows) {
          const bucket = entitiesByPath.get(row.file_path);
          if (bucket) bucket.push(row.entity);
          else entitiesByPath.set(row.file_path, [row.entity]);
        }

        const relationsByPath = new Map<string, GraphRelation[]>();
        for (const row of relationRows) {
          const relation: GraphRelation = {
            from: row.from_entity,
            to: row.to_entity,
            ...(row.relation_type ? { type: row.relation_type } : {}),
            ...(typeof row.confidence === "number" ? { confidence: row.confidence } : {}),
          };
          const bucket = relationsByPath.get(row.file_path);
          if (bucket) bucket.push(relation);
          else relationsByPath.set(row.file_path, [relation]);
        }

        const files: GraphFileNode[] = fileRows.map((row) => ({
          path: row.file_path,
          type: row.file_type,
          ...(row.body_hash ? { bodyHash: row.body_hash } : {}),
          entities: entitiesByPath.get(row.file_path) ?? [],
          relations: relationsByPath.get(row.file_path) ?? [],
          ...(typeof row.confidence === "number" ? { confidence: row.confidence } : {}),
          ...(row.status ? { status: row.status as GraphFileNode["status"] } : {}),
          ...(row.reason ? { reason: row.reason as GraphFileNode["reason"] } : {}),
          ...(row.extraction_run_id ? { extractionRunId: row.extraction_run_id } : {}),
        }));

        return {
          stashPath: meta.stashPath,
          graphPath: meta.graphPath,
          schemaVersion: meta.schemaVersion,
          generatedAt: meta.generatedAt,
          ...(meta.quality ? { quality: meta.quality } : {}),
          ...(meta.telemetry ? { telemetry: meta.telemetry } : {}),
          files,
          entities: uniqueSorted(files.flatMap((file) => file.entities)),
          relations: files.flatMap((file) => file.relations),
        };
      } catch {
        return null;
      }
    });
  } catch (err) {
    // Never mask the bun-test isolation guard as "no stored graph snapshot".
    rethrowIfTestIsolationError(err);
    return null;
  }
}
