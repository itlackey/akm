import type { Database } from "bun:sqlite";
import fs from "node:fs";
import { getDbPath } from "../core/paths";
import type { GraphRelation } from "../llm/graph-extract";
import { closeDatabase, openExistingDatabase } from "./db";
import type { GraphFile, GraphFileNode, GraphQualityTelemetry } from "./graph-extraction";

export interface StoredGraphSnapshot {
  stashPath: string;
  graphPath: string;
  schemaVersion: number;
  generatedAt: string;
  quality?: GraphQualityTelemetry;
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
       density
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(stash_root) DO UPDATE SET
       schema_version = excluded.schema_version,
       generated_at = excluded.generated_at,
       considered_files = excluded.considered_files,
       extracted_files = excluded.extracted_files,
       entity_count = excluded.entity_count,
       relation_count = excluded.relation_count,
       extraction_coverage = excluded.extraction_coverage,
       density = excluded.density`,
  );
  const deleteRelations = db.prepare("DELETE FROM graph_file_relations WHERE stash_root = ?");
  const deleteEntities = db.prepare("DELETE FROM graph_file_entities WHERE stash_root = ?");
  const deleteFiles = db.prepare("DELETE FROM graph_files WHERE stash_root = ?");
  const insertFile = db.prepare(
    `INSERT INTO graph_files (stash_root, file_path, file_order, file_type, body_hash, confidence)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertEntity = db.prepare(
    `INSERT INTO graph_file_entities (stash_root, file_path, entity_order, entity)
     VALUES (?, ?, ?, ?)`,
  );
  const insertRelation = db.prepare(
    `INSERT INTO graph_file_relations (
       stash_root,
       file_path,
       relation_order,
       from_entity,
       to_entity,
       relation_type,
       confidence
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const quality = graph.quality;

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
    );
    deleteRelations.run(graph.stashRoot);
    deleteEntities.run(graph.stashRoot);
    deleteFiles.run(graph.stashRoot);

    for (const [fileOrder, node] of graph.files.entries()) {
      insertFile.run(graph.stashRoot, node.path, fileOrder, node.type, node.bodyHash ?? null, node.confidence ?? null);
      for (const [entityOrder, entity] of node.entities.entries()) {
        insertEntity.run(graph.stashRoot, node.path, entityOrder, entity);
      }
      for (const [relationOrder, relation] of node.relations.entries()) {
        insertRelation.run(
          graph.stashRoot,
          node.path,
          relationOrder,
          relation.from,
          relation.to,
          relation.type ?? null,
          relation.confidence ?? null,
        );
      }
    }
  })();
}

export function deleteStoredGraph(db: Database, stashPath: string): void {
  db.transaction(() => {
    db.prepare("DELETE FROM graph_file_relations WHERE stash_root = ?").run(stashPath);
    db.prepare("DELETE FROM graph_file_entities WHERE stash_root = ?").run(stashPath);
    db.prepare("DELETE FROM graph_files WHERE stash_root = ?").run(stashPath);
    db.prepare("DELETE FROM graph_meta WHERE stash_root = ?").run(stashPath);
  })();
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
               density
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
        };
      } catch {
        return null;
      }
    });
  } catch {
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
            `SELECT file_path, file_type, body_hash, confidence
             FROM graph_files
             WHERE stash_root = ?
             ORDER BY file_order`,
          )
          .all(stashPath) as Array<{
          file_path: string;
          file_type: string;
          body_hash: string | null;
          confidence: number | null;
        }>;
        const entityRows = readDb
          .prepare(
            `SELECT file_path, entity
             FROM graph_file_entities
             WHERE stash_root = ?
             ORDER BY file_path, entity_order`,
          )
          .all(stashPath) as Array<{ file_path: string; entity: string }>;
        const relationRows = readDb
          .prepare(
            `SELECT file_path, from_entity, to_entity, relation_type, confidence
             FROM graph_file_relations
             WHERE stash_root = ?
             ORDER BY file_path, relation_order`,
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
        }));

        return {
          stashPath: meta.stashPath,
          graphPath: meta.graphPath,
          schemaVersion: meta.schemaVersion,
          generatedAt: meta.generatedAt,
          ...(meta.quality ? { quality: meta.quality } : {}),
          files,
          entities: uniqueSorted(files.flatMap((file) => file.entities)),
          relations: files.flatMap((file) => file.relations),
        };
      } catch {
        return null;
      }
    });
  } catch {
    return null;
  }
}
