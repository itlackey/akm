import path from "node:path";
import { closeDatabase, openIndexDatabase, rebuildFts, setMeta, upsertEntry } from "../../src/indexer/db/db";
import { deleteStoredGraph, loadStoredGraphSnapshot, replaceStoredGraph } from "../../src/indexer/db/graph-db";
import type { GraphFile } from "../../src/indexer/graph/graph-extraction";
import { buildSearchText } from "../../src/indexer/search/search-fields";
import type { Database } from "../../src/storage/database";

/**
 * Seed a stored graph snapshot, also creating the minimal `entries` rows
 * needed to satisfy schema-v2's entry_id FK on graph_files. Each file in
 * `graph.files` gets a synthetic entry with name derived from its basename
 * and type taken from `file.type`. Tests that rely on real entries can
 * still upsert their own; this helper is idempotent.
 */
export function seedStoredGraph(graph: GraphFile, dbPath: string): void {
  const db = openIndexDatabase(dbPath);
  try {
    for (const file of graph.files) {
      const name = path.basename(file.path, path.extname(file.path));
      const dirPath = path.dirname(file.path);
      const entry = { name, type: file.type, filename: path.basename(file.path) };
      try {
        upsertEntry(
          db,
          `${graph.stashRoot}:${file.type}:${name}`,
          dirPath,
          file.path,
          graph.stashRoot,
          entry as Parameters<typeof upsertEntry>[5],
          buildSearchText(entry as Parameters<typeof buildSearchText>[0]),
        );
      } catch {
        /* entry may already exist with a different key — fall through */
      }
    }
    try {
      rebuildFts(db);
    } catch {
      /* fts rebuild is best-effort for helper seeds */
    }
    // Mark the index as fresh so auto-index in show/search CLIs treats the
    // seeded data as current and does not wipe entries / cascade-delete the
    // graph rows we are about to insert.
    try {
      setMeta(db, "stashDir", graph.stashRoot);
      setMeta(db, "stashDirs", JSON.stringify([graph.stashRoot]));
      // Use a future timestamp so any subsequent file mtimes appear older.
      setMeta(db, "builtAt", new Date(Date.now() + 60_000).toISOString());
    } catch {
      /* meta updates are best-effort */
    }
    // Ensure every file has a body_hash so the schema-v2 NOT NULL holds.
    const normalised: GraphFile = {
      ...graph,
      files: graph.files.map((f) => ({
        ...f,
        bodyHash: f.bodyHash && f.bodyHash.length > 0 ? f.bodyHash : `${path.basename(f.path)}-test-hash`,
      })),
    };
    replaceStoredGraph(db, normalised);
  } finally {
    closeDatabase(db);
  }
}

/**
 * Insert raw `graph_files` + `graph_file_entities` rows linking an already-indexed
 * asset (by its `file_path`) to a set of graph entities, so `getEntitiesByEntryIds`
 * (entries ⋈ graph_files ⋈ graph_file_entities on stash_root/file_path/body_hash)
 * returns them. `entity_norm` is lowercased to mirror real extraction
 * (graph-dedup.ts). Used to drive entity-based recombine clustering and related
 * graph lookups in tests without running real extraction.
 */
export function insertGraphEntities(
  db: Database,
  entryId: number,
  stashRoot: string,
  filePath: string,
  entities: string[],
  fileType: "memory" | "knowledge" | "session" = "memory",
): void {
  const bodyHash = `hash-${entryId}`;
  db.prepare(
    `INSERT OR REPLACE INTO graph_files (stash_root, file_path, file_order, file_type, body_hash, status)
     VALUES (?, ?, ?, ?, ?, 'extracted')`,
  ).run(stashRoot, filePath, entryId, fileType, bodyHash);
  let order = 0;
  for (const ent of entities) {
    db.prepare(
      `INSERT OR REPLACE INTO graph_file_entities (stash_root, file_path, body_hash, entity_order, entity_norm, entity)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(stashRoot, filePath, bodyHash, order++, ent.toLowerCase(), ent);
  }
}

export function removeStoredGraph(dbPath: string, stashPath: string): void {
  const db = openIndexDatabase(dbPath);
  try {
    deleteStoredGraph(db, stashPath);
  } finally {
    closeDatabase(db);
  }
}

export function loadStoredGraph(db: Database, stashPath: string): GraphFile | undefined {
  const snapshot = loadStoredGraphSnapshot(stashPath, db);
  if (!snapshot) return undefined;
  return {
    schemaVersion: snapshot.schemaVersion,
    generatedAt: snapshot.generatedAt,
    stashRoot: snapshot.stashPath,
    files: snapshot.files,
    entities: snapshot.entities,
    relations: snapshot.relations,
    ...(snapshot.quality ? { quality: snapshot.quality } : {}),
  };
}
