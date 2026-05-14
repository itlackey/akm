import type { Database } from "bun:sqlite";
import { closeDatabase, openDatabase } from "../../src/indexer/db";
import { deleteStoredGraph, loadStoredGraphSnapshot, replaceStoredGraph } from "../../src/indexer/graph-db";
import type { GraphFile } from "../../src/indexer/graph-extraction";

export function seedStoredGraph(graph: GraphFile, dbPath: string): void {
  const db = openDatabase(dbPath);
  try {
    replaceStoredGraph(db, graph);
  } finally {
    closeDatabase(db);
  }
}

export function removeStoredGraph(dbPath: string, stashPath: string): void {
  const db = openDatabase(dbPath);
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
