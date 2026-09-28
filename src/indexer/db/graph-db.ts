// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { rethrowIfDataDirUnreadable, rethrowIfTestIsolationError } from "../../core/errors";
import { isPathAbsent } from "../../core/path-access";
import { getDbPath } from "../../core/paths";
import { type GraphRelation, normalizeEntityKey } from "../../llm/graph-extract";
import type { Database } from "../../storage/database";
import { closeDatabase, openExistingDatabase } from "../../storage/repositories/index-connection";
import { GRAPH_SCHEMA_VERSION } from "../../storage/repositories/index-schema";
import type { GraphExtractionTelemetry, GraphFile, GraphFileNode, GraphQualityTelemetry } from "../graph/graph-types";

export interface StoredGraphSnapshot {
  stashPath: string;
  graphPath: string;
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
  generatedAt: string;
  quality?: GraphQualityTelemetry;
  telemetry?: GraphExtractionTelemetry;
}

function withReadableGraphDb<T>(db: Database | undefined, fn: (db: Database) => T): T {
  if (db) return fn(db);
  const dbPath = getDbPath();
  // `GRAPH_DB_MISSING` is the loaders' "nothing extracted yet" sentinel — every
  // caller below turns it into `null`/`[]`. Reserve it for a genuinely ABSENT
  // index: an index that exists and cannot be read must reach the caller as the
  // ConfigError `openExistingDatabase` raises, not as "no graph data" (#791).
  if (isPathAbsent(dbPath)) throw new Error("GRAPH_DB_MISSING");
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

interface ExistingGraphFileRow {
  file_path: string;
  body_hash: string;
  file_order: number;
}

/** Child rows joined to their file row, the same join the loaders read through. */
const STORED_ENTITIES = `graph_file_entities e
  JOIN graph_files gf ON gf.stash_root = e.stash_root AND gf.file_path = e.file_path AND gf.body_hash = e.body_hash
  WHERE gf.stash_root = ?`;
const STORED_RELATIONS = `graph_file_relations r
  JOIN graph_files gf ON gf.stash_root = r.stash_root AND gf.file_path = r.file_path AND gf.body_hash = r.body_hash
  WHERE gf.stash_root = ?`;

/** One comparable key for a file's extraction: its entities and relations, in order. */
function extractionKey(entities: readonly string[], relations: readonly GraphRelation[]): string {
  return JSON.stringify([entities, relations.map((r) => [r.from, r.to, r.type ?? null, r.confidence ?? null])]);
}

const EMPTY_EXTRACTION_KEY = extractionKey([], []);

/** The extraction key of every stored file under a root that has child rows. */
function readStoredExtractionKeys(db: Database, stashRoot: string): Map<string, string> {
  const entityRows = db
    .prepare(
      `SELECT e.file_path AS file_path, e.entity AS entity FROM ${STORED_ENTITIES} ORDER BY e.file_path, e.entity_order`,
    )
    .all(stashRoot) as Array<{ file_path: string; entity: string }>;
  const relationRows = db
    .prepare(
      `SELECT r.file_path AS file_path, r.from_entity AS from_entity, r.to_entity AS to_entity,
              r.relation_type AS relation_type, r.confidence AS confidence
         FROM ${STORED_RELATIONS} ORDER BY r.file_path, r.relation_order`,
    )
    .all(stashRoot) as Array<{
    file_path: string;
    from_entity: string;
    to_entity: string;
    relation_type: string | null;
    confidence: number | null;
  }>;
  const byPath = new Map<string, { entities: string[]; relations: GraphRelation[] }>();
  const bucket = (filePath: string) => {
    let entry = byPath.get(filePath);
    if (!entry) {
      entry = { entities: [], relations: [] };
      byPath.set(filePath, entry);
    }
    return entry;
  };
  for (const row of entityRows) bucket(row.file_path).entities.push(row.entity);
  for (const row of relationRows) {
    bucket(row.file_path).relations.push({
      from: row.from_entity,
      to: row.to_entity,
      ...(row.relation_type !== null ? { type: row.relation_type } : {}),
      ...(row.confidence !== null ? { confidence: row.confidence } : {}),
    });
  }
  return new Map([...byPath].map(([filePath, stored]) => [filePath, extractionKey(stored.entities, stored.relations)]));
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4));
}

/**
 * The graph_meta counts, derived from the stored rows of one root. Each field
 * has one meaning (see {@link GraphQualityTelemetry}): files are graph_files
 * rows, entities are distinct case-folded names, relations are distinct
 * case-folded (from, to, type) triples.
 */
function readStoredGraphQuality(db: Database, stashRoot: string): GraphQualityTelemetry {
  const count = (sql: string): number => (db.prepare(sql).get(stashRoot) as { n: number }).n;
  const storedFiles = count("SELECT COUNT(*) AS n FROM graph_files WHERE stash_root = ?");
  const filesWithEntities = count(`SELECT COUNT(DISTINCT gf.file_path) AS n FROM ${STORED_ENTITIES}`);
  const entityCount = count(`SELECT COUNT(DISTINCT e.entity_norm) AS n FROM ${STORED_ENTITIES}`);
  const relationCount = count(
    `SELECT COUNT(*) AS n FROM (
       SELECT DISTINCT r.from_entity_norm, r.to_entity_norm, lower(coalesce(r.relation_type, '')) FROM ${STORED_RELATIONS}
     )`,
  );
  const maxEdges = entityCount > 1 ? (entityCount * (entityCount - 1)) / 2 : 0;
  return {
    consideredFiles: storedFiles,
    extractedFiles: filesWithEntities,
    entityCount,
    relationCount,
    extractionCoverage: storedFiles > 0 ? roundMetric(filesWithEntities / storedFiles) : 0,
    density: maxEdges > 0 ? roundMetric(relationCount / maxEdges) : 0,
  };
}

/**
 * Persist (or update) a graph snapshot for a stash root.
 *
 * #624-P1: keyed on (stash_root, file_path, body_hash) — NOT entries.id. Graph
 * rows are self-keyed by path, so they survive an entries delete + reinsert
 * (a reindex) when body_hash is unchanged. A file whose body_hash is unchanged
 * keeps its row; its entity and relation rows are rewritten only when they
 * differ from the snapshot's (a re-extraction of the same body, e.g. after a
 * model or prompt change or a failed first attempt, must land). Files whose
 * body_hash changed have their old row + child rows deleted and the new content
 * inserted; files in DB but absent from the new snapshot are deleted. There is
 * no entry_id resolution and no orphan-skip — a graph file no longer needs a
 * matching entries row.
 *
 * graph_meta records the snapshot's time and run telemetry; its counts are
 * derived from the rows as stored after the write, never from the caller's
 * in-memory graph.
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

  const telemetry = graph.telemetry;

  db.transaction(() => {
    // Build a snapshot of existing rows for incremental compare. The unique
    // index idx_graph_files_path guarantees at most one row per file_path.
    const existingRows = selectExisting.all(graph.stashRoot) as ExistingGraphFileRow[];
    const existingByPath = new Map<string, ExistingGraphFileRow>();
    for (const row of existingRows) existingByPath.set(row.file_path, row);
    const storedKeys = readStoredExtractionKeys(db, graph.stashRoot);

    const presentPaths = new Set<string>();

    for (const [fileOrder, node] of graph.files.entries()) {
      // body_hash is part of the PK; default to a sentinel for inputs (test
      // fixtures, legacy imports) that don't supply one. The sentinel never
      // equals a real hash so subsequent staleness checks always re-extract —
      // correct behaviour for "unknown" bodies. Distinct files in one stash
      // are still keyed apart by file_path, so the empty sentinel is safe.
      const bodyHash = node.bodyHash && node.bodyHash.length > 0 ? node.bodyHash : "";
      const status = node.status ?? (node.entities.length > 0 ? "extracted" : "empty");
      const reason = node.reason ?? (node.entities.length > 0 ? "none" : "no_graph_content");
      const runId = node.extractionRunId ?? telemetry?.extractionRunId ?? null;

      presentPaths.add(node.path);

      const existing = existingByPath.get(node.path);
      if (existing && existing.body_hash === bodyHash) {
        // Body unchanged — refresh the file meta, and rewrite the child rows
        // only when this snapshot's extraction differs from the stored one.
        updateFileMeta.run(
          fileOrder,
          node.type,
          node.confidence ?? null,
          status,
          reason,
          runId,
          graph.stashRoot,
          node.path,
          bodyHash,
        );
        const storedKey = storedKeys.get(node.path) ?? EMPTY_EXTRACTION_KEY;
        if (storedKey === extractionKey(node.entities, node.relations)) continue;
        deleteEntities.run(graph.stashRoot, node.path, bodyHash);
        deleteRelations.run(graph.stashRoot, node.path, bodyHash);
      } else {
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
          status,
          reason,
          runId,
        );
      }

      for (const [entityOrder, entity] of node.entities.entries()) {
        insertEntity.run(graph.stashRoot, node.path, bodyHash, entityOrder, normalizeEntityKey(entity), entity);
      }
      for (const [relationOrder, relation] of node.relations.entries()) {
        insertRelation.run(
          graph.stashRoot,
          node.path,
          bodyHash,
          relationOrder,
          normalizeEntityKey(relation.from),
          relation.from,
          normalizeEntityKey(relation.to),
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

    const quality = readStoredGraphQuality(db, graph.stashRoot);
    upsertMeta.run(
      graph.stashRoot,
      GRAPH_SCHEMA_VERSION,
      graph.generatedAt,
      quality.consideredFiles,
      quality.extractedFiles,
      quality.entityCount,
      quality.relationCount,
      quality.extractionCoverage,
      quality.density,
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

export function loadStoredGraphMeta(stashPath: string, db?: Database): StoredGraphMeta | null {
  try {
    return withReadableGraphDb(db, (readDb) => {
      const row = readDb
        .prepare(
          `SELECT
             stash_root,
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
    });
  } catch (err) {
    // Never mask the bun-test isolation guard as "no stored graph meta",
    // nor an unreadable index as one that simply has no graph (#791).
    rethrowIfTestIsolationError(err);
    rethrowIfDataDirUnreadable(err);
    return null;
  }
}

export function loadStoredGraphSnapshot(stashPath: string, db?: Database): StoredGraphSnapshot | null {
  try {
    return withReadableGraphDb(db, (readDb) => {
      const meta = loadStoredGraphMeta(stashPath, readDb);
      if (!meta) return null;

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
        generatedAt: meta.generatedAt,
        ...(meta.quality ? { quality: meta.quality } : {}),
        ...(meta.telemetry ? { telemetry: meta.telemetry } : {}),
        files,
        entities: uniqueSorted(files.flatMap((file) => file.entities)),
        relations: files.flatMap((file) => file.relations),
      };
    });
  } catch (err) {
    // Never mask the bun-test isolation guard as "no stored graph snapshot",
    // nor an unreadable index as one that simply has no graph (#791).
    rethrowIfTestIsolationError(err);
    rethrowIfDataDirUnreadable(err);
    return null;
  }
}
