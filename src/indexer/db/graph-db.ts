// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import { rethrowIfTestIsolationError } from "../../core/errors";
import { getDbPath } from "../../core/paths";
import type { GraphRelation } from "../../llm/graph-extract";
import type { Database } from "../../storage/database";
import { closeDatabase, openExistingDatabase } from "../../storage/repositories/index-connection";
import type { GraphExtractionTelemetry, GraphFile, GraphFileNode, GraphQualityTelemetry } from "../graph/graph-types";

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

interface ExistingGraphFileRow {
  file_path: string;
  body_hash: string;
  file_order: number;
}

/**
 * Persist (or update) a graph snapshot for a stash root.
 *
 * #624-P1: keyed on (stash_root, file_path, body_hash) — NOT entries.id. Graph
 * rows are self-keyed by path, so they survive an entries delete + reinsert
 * (a reindex) when body_hash is unchanged. Unchanged files (matching body_hash)
 * only have their file-meta refreshed; files whose body_hash changed have their
 * old row + child rows deleted and the new content inserted; files in DB but
 * absent from the new snapshot are deleted. There is no entry_id resolution and
 * no orphan-skip — a graph file no longer needs a matching entries row.
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

  const selectExisting = db.prepare("SELECT file_path, body_hash, file_order FROM graph_files WHERE stash_root = ?");
  const deleteFile = db.prepare("DELETE FROM graph_files WHERE stash_root = ? AND file_path = ? AND body_hash = ?");
  const deleteEntities = db.prepare(
    "DELETE FROM graph_file_entities WHERE stash_root = ? AND file_path = ? AND body_hash = ?",
  );
  const deleteRelations = db.prepare(
    "DELETE FROM graph_file_relations WHERE stash_root = ? AND file_path = ? AND body_hash = ?",
  );
  const insertFile = db.prepare(
    `INSERT INTO graph_files (
       stash_root, file_path, file_order, file_type, body_hash, confidence, status, reason, extraction_run_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateFileMeta = db.prepare(
    `UPDATE graph_files
       SET file_order = ?, file_type = ?, confidence = ?, status = ?, reason = ?, extraction_run_id = ?
        WHERE stash_root = ? AND file_path = ? AND body_hash = ?`,
  );
  const insertEntity = db.prepare(
    `INSERT INTO graph_file_entities (stash_root, file_path, body_hash, entity_order, entity_norm, entity)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertRelation = db.prepare(
    `INSERT INTO graph_file_relations (
       stash_root, file_path, body_hash, relation_order, from_entity_norm, from_entity, to_entity_norm, to_entity, relation_type, confidence
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

    // Build a snapshot of existing rows for incremental compare. The unique
    // index idx_graph_files_path guarantees at most one row per file_path.
    const existingRows = selectExisting.all(graph.stashRoot) as ExistingGraphFileRow[];
    const existingByPath = new Map<string, ExistingGraphFileRow>();
    for (const row of existingRows) existingByPath.set(row.file_path, row);

    const presentPaths = new Set<string>();

    for (const [fileOrder, node] of graph.files.entries()) {
      // body_hash is part of the PK; default to a sentinel for inputs (test
      // fixtures, legacy imports) that don't supply one. The sentinel never
      // equals a real hash so subsequent staleness checks always re-extract —
      // correct behaviour for "unknown" bodies. Distinct files in one stash
      // are still keyed apart by file_path, so the empty sentinel is safe.
      const bodyHash = node.bodyHash && node.bodyHash.length > 0 ? node.bodyHash : "";

      presentPaths.add(node.path);

      const existing = existingByPath.get(node.path);
      if (existing && existing.body_hash === bodyHash) {
        // Body unchanged — only fix up file_order/confidence in case they drifted.
        updateFileMeta.run(
          fileOrder,
          node.type,
          node.confidence ?? null,
          node.status ?? (node.entities.length > 0 ? "extracted" : "empty"),
          node.reason ?? (node.entities.length > 0 ? "none" : "no_graph_content"),
          node.extractionRunId ?? telemetry?.extractionRunId ?? null,
          graph.stashRoot,
          node.path,
          bodyHash,
        );
        continue;
      }

      if (existing) {
        // Stale row (different body_hash for this path). Delete the old row by
        // its OLD body_hash; child rows cascade, but explicit DELETE keeps the
        // order deterministic and is safe regardless of the FK pragma.
        deleteEntities.run(graph.stashRoot, existing.file_path, existing.body_hash);
        deleteRelations.run(graph.stashRoot, existing.file_path, existing.body_hash);
        deleteFile.run(graph.stashRoot, existing.file_path, existing.body_hash);
      }

      insertFile.run(
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
        insertEntity.run(graph.stashRoot, node.path, bodyHash, entityOrder, normalizeEntity(entity), entity);
      }
      for (const [relationOrder, relation] of node.relations.entries()) {
        insertRelation.run(
          graph.stashRoot,
          node.path,
          bodyHash,
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
    // tables CASCADE on the composite key; explicit DELETE keeps it determinstic.
    for (const row of existingRows) {
      if (!presentPaths.has(row.file_path)) {
        deleteEntities.run(graph.stashRoot, row.file_path, row.body_hash);
        deleteRelations.run(graph.stashRoot, row.file_path, row.body_hash);
        deleteFile.run(graph.stashRoot, row.file_path, row.body_hash);
      }
    }
  })();
}

export function deleteStoredGraph(db: Database, stashPath: string): void {
  db.transaction(() => {
    // Child rows cascade via the composite (stash_root, file_path, body_hash)
    // FK; deleting graph_files clears them. This is the explicit full-clear
    // path for a stash (entries-delete no longer wipes graph data — see #624-P1).
    db.prepare("DELETE FROM graph_files WHERE stash_root = ?").run(stashPath);
    db.prepare("DELETE FROM graph_meta WHERE stash_root = ?").run(stashPath);
  })();
}

/**
 * #624-P1 — does any graph data exist for a file_path under a stash root?
 * Consumed by show/curate flows (P3) but defined here so the schema and its
 * accessors land together.
 */
export function hasGraphData(db: Database, stashRoot: string, filePath: string): boolean {
  try {
    const row = db
      .prepare("SELECT 1 AS present FROM graph_files WHERE stash_root = ? AND file_path = ? LIMIT 1")
      .get(stashRoot, filePath) as { present: number } | undefined;
    return row !== undefined;
  } catch {
    return false;
  }
}

/**
 * #624-P3 — enqueue a file for lazy graph extraction. Idempotent on the
 * (stash_root, file_path) PK: a second enqueue refreshes body_hash + queued_at
 * and keeps the HIGHER priority. Non-blocking, no LLM call — the queued row is
 * drained later by the graph-extraction pass. Tolerant of a missing table /
 * db error (best-effort), but never masks the bun-test isolation guard.
 */
export function enqueueGraphExtraction(
  db: Database,
  stashRoot: string,
  filePath: string,
  bodyHash: string,
  priority = 0,
): void {
  try {
    db.prepare(
      `INSERT INTO graph_extraction_queue (stash_root, file_path, body_hash, priority)
         VALUES (?, ?, ?, ?)
       ON CONFLICT(stash_root, file_path) DO UPDATE SET
         body_hash = excluded.body_hash,
         priority  = MAX(graph_extraction_queue.priority, excluded.priority),
         queued_at = datetime('now')`,
    ).run(stashRoot, filePath, bodyHash, priority);
  } catch (err) {
    rethrowIfTestIsolationError(err);
  }
}

/**
 * #624-P3 — drain up to `limit` queued files for a stash, highest-priority
 * first (then oldest queued_at). The returned rows are DELETED from the queue
 * in the SAME transaction (SELECT-then-DELETE-by-PK), so a drain is exactly
 * once. Tolerant of a missing table / db error (returns []), but never masks
 * the bun-test isolation guard.
 */
export function drainExtractionQueue(
  db: Database,
  stashRoot: string,
  limit: number,
): Array<{ filePath: string; bodyHash: string; priority: number }> {
  try {
    return db.transaction(() => {
      const rows = db
        .prepare(
          `SELECT file_path, body_hash, priority
             FROM graph_extraction_queue
             WHERE stash_root = ?
             ORDER BY priority DESC, queued_at ASC
             LIMIT ?`,
        )
        .all(stashRoot, limit) as Array<{ file_path: string; body_hash: string; priority: number }>;
      const del = db.prepare("DELETE FROM graph_extraction_queue WHERE stash_root = ? AND file_path = ?");
      for (const row of rows) del.run(stashRoot, row.file_path);
      return rows.map((row) => ({ filePath: row.file_path, bodyHash: row.body_hash, priority: row.priority }));
    })();
  } catch (err) {
    rethrowIfTestIsolationError(err);
    return [];
  }
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
            `SELECT file_path, file_type, body_hash, confidence, status, reason
                FROM graph_files
                WHERE stash_root = ?
                ORDER BY file_order`,
          )
          .all(stashPath) as Array<{
          file_path: string;
          file_type: string;
          body_hash: string;
          confidence: number | null;
          status: string | null;
          reason: string | null;
        }>;
        return rows.map((row) => ({
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
 * Scoped loader — entities for a single file, keyed on the #624-P1 composite
 * (stash_root, file_path, body_hash). Used by per-asset show/curate lookups.
 */
export function loadGraphEntitiesByPath(db: Database, stashRoot: string, filePath: string, bodyHash: string): string[] {
  try {
    const rows = db
      .prepare(
        `SELECT entity FROM graph_file_entities
          WHERE stash_root = ? AND file_path = ? AND body_hash = ?
          ORDER BY entity_order`,
      )
      .all(stashRoot, filePath, bodyHash) as Array<{ entity: string }>;
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
            `SELECT file_path, file_type, body_hash, confidence, status, reason, extraction_run_id
              FROM graph_files
              WHERE stash_root = ?
              ORDER BY file_order`,
          )
          .all(stashPath) as Array<{
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
            `SELECT gf.file_path AS file_path, gfe.entity AS entity
             FROM graph_file_entities gfe
             JOIN graph_files gf
               ON gf.stash_root = gfe.stash_root
              AND gf.file_path = gfe.file_path
              AND gf.body_hash = gfe.body_hash
             WHERE gf.stash_root = ?
             ORDER BY gf.file_order, gfe.entity_order`,
          )
          .all(stashPath) as Array<{ file_path: string; entity: string }>;
        const relationRows = readDb
          .prepare(
            `SELECT gf.file_path AS file_path,
                    gfr.from_entity AS from_entity,
                    gfr.to_entity AS to_entity,
                    gfr.relation_type AS relation_type,
                    gfr.confidence AS confidence
             FROM graph_file_relations gfr
             JOIN graph_files gf
               ON gf.stash_root = gfr.stash_root
              AND gf.file_path = gfr.file_path
              AND gf.body_hash = gfr.body_hash
             WHERE gf.stash_root = ?
             ORDER BY gf.file_order, gfr.relation_order`,
          )
          .all(stashPath) as Array<{
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
