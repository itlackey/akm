/**
 * Unit test for {@link resetGraphBoostCache} (#harness-redesign-rec-1).
 *
 * `src/indexer/graph-boost.ts` maintains a module-level `cachedParsedGraph`
 * slot to avoid re-parsing the SQLite graph snapshot on back-to-back
 * `loadGraphBoostContext` calls. The persistence is desirable in production
 * but pathological for tests that swap stash directories between cases
 * without bumping `generatedAt` on the underlying graph snapshot — the cache
 * can serve a previous test's graph nodes against the current test's stash.
 *
 * The harness-redesign report's top recommendation (1 of 3) was to surface
 * this with an exported `resetGraphBoostCache()` so test setup code can
 * invalidate the cache explicitly. This file pins that contract:
 *
 *   1. The function is exported from the module.
 *   2. Calling it when the cache is empty is a no-op (no throw).
 *   3. Calling it after `loadGraphBoostContext` has populated the cache
 *      successfully clears the slot — the next call must re-parse from
 *      the underlying graph data, which the test demonstrates by mutating
 *      the stored graph in-place (same `generatedAt` so the cache key
 *      would otherwise hit) and observing the new entities show up in the
 *      next `loadGraphBoostContext` result.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../src/core/config/config";
import { getDbPath } from "../src/core/paths";
import { closeDatabase, openDatabase, setMeta, upsertEntry } from "../src/indexer/db/db";
import { deleteStoredGraph, replaceStoredGraph } from "../src/indexer/db/graph-db";
import { loadGraphBoostContext, resetGraphBoostCache } from "../src/indexer/graph/graph-boost";
import { GRAPH_FILE_SCHEMA_VERSION, type GraphFile } from "../src/indexer/graph/graph-extraction";
import { buildSearchText } from "../src/indexer/search/search-fields";
import { type Cleanup, withIsolatedAkmStorage } from "./_helpers/sandbox";

// ── Environment isolation ───────────────────────────────────────────────────
//
// Each test builds its own graph DB state, so we give every test a fresh,
// fully isolated sandbox (XDG cache/config/data/state + stash). This is
// mandatory under the shared-process suite: the index DB resolves at call time
// from $XDG_DATA_HOME/akm/index.db, so without a per-test XDG_DATA_HOME sandbox
// a concurrently-interleaved file would share — and clobber — this file's DB.

let stashDir = "";
let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const storage = withIsolatedAkmStorage();
  stashDir = storage.stashDir;
  envCleanup = storage.cleanup;

  resetConfigCache();
  // The graph-boost module caches the parsed graph keyed by (stashPath,
  // generatedAt); this file's tests deliberately reuse a stable generatedAt
  // and reset the cache themselves, but clear it up front so each test starts
  // from a guaranteed-empty cache regardless of cross-file interleaving.
  resetGraphBoostCache();
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
  resetConfigCache();
  resetGraphBoostCache();
});

// ── Fixture helpers ─────────────────────────────────────────────────────────

function assetFilePath(): string {
  return path.join(stashDir, "knowledge", "alpha.md");
}

function ensureAssetIndexed(): void {
  // The graph storage joins by `entries.entry_key`, so a graph row can only
  // be persisted for an asset that exists as an indexed entry. Write the
  // asset file and upsert a single entry once — subsequent installGraph()
  // calls just update the graph rows in place.
  const assetPath = assetFilePath();
  fs.mkdirSync(path.dirname(assetPath), { recursive: true });
  if (!fs.existsSync(assetPath)) {
    fs.writeFileSync(assetPath, "---\ntype: knowledge\n---\n\nGraph-boost cache-reset fixture.\n");
  }
  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  try {
    const entry = {
      name: "alpha",
      type: "knowledge",
      filename: "alpha.md",
      description: "Graph-boost cache-reset fixture.",
    };
    const entryKey = `${stashDir}:${entry.type}:${entry.name}`;
    upsertEntry(db, entryKey, path.dirname(assetPath), assetPath, stashDir, entry, buildSearchText(entry));
    setMeta(db, "stashDir", stashDir);
    setMeta(db, "builtAt", new Date().toISOString());
    setMeta(db, "stashDirs", JSON.stringify([stashDir]));
    setMeta(db, "hasEmbeddings", "0");
  } finally {
    closeDatabase(db);
  }
}

function makeGraph(entities: string[]): GraphFile {
  return {
    schemaVersion: GRAPH_FILE_SCHEMA_VERSION,
    // Stable timestamp — the test mutates entities in-place to prove the
    // cache was cleared rather than relying on `generatedAt` to differ.
    generatedAt: "2026-05-20T00:00:00.000Z",
    stashRoot: stashDir,
    files: [
      {
        path: assetFilePath(),
        type: "knowledge",
        entities,
        relations: [],
      },
    ],
    entities,
    relations: [],
  };
}

function installGraph(entities: string[]): void {
  const db = openDatabase(getDbPath());
  try {
    deleteStoredGraph(db, stashDir);
    replaceStoredGraph(db, makeGraph(entities));
  } finally {
    closeDatabase(db);
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("resetGraphBoostCache", () => {
  test("is exported and callable when the cache is empty (idempotent no-op)", () => {
    expect(typeof resetGraphBoostCache).toBe("function");
    expect(() => resetGraphBoostCache()).not.toThrow();
    // Double-call also fine — clearing an empty slot is a no-op.
    expect(() => resetGraphBoostCache()).not.toThrow();
  });

  test("clears the cached parsed graph so the next load re-reads disk state", () => {
    // Seed the cache with a snapshot containing entity "alpha-original".
    ensureAssetIndexed();
    installGraph(["alpha-original"]);
    resetGraphBoostCache();
    const firstCtx = loadGraphBoostContext(stashDir, "alpha-original");
    expect(firstCtx).not.toBeNull();
    expect(firstCtx?.matchedEntities.has("alpha-original")).toBe(true);

    // Replace the stored graph with a new entity set, but KEEP the same
    // `generatedAt` so the cacheKey would otherwise hit. Without
    // `resetGraphBoostCache`, the second `loadGraphBoostContext` would
    // return the cached context whose entity set still says
    // "alpha-original".
    installGraph(["beta-new"]);

    // Sanity: stale cache would still match "alpha-original" and miss
    // "beta-new". (Don't assert this strictly — it's the failure case the
    // reset prevents.)
    const staleCtx = loadGraphBoostContext(stashDir, "alpha-original");
    expect(staleCtx?.matchedEntities.has("alpha-original")).toBe(true);

    // Now reset and re-query for the new entity — cache must be
    // invalidated so the disk re-read picks up "beta-new".
    resetGraphBoostCache();
    const freshCtx = loadGraphBoostContext(stashDir, "beta-new");
    expect(freshCtx).not.toBeNull();
    expect(freshCtx?.matchedEntities.has("beta-new")).toBe(true);
    // The old entity is no longer in the corpus, so a query for it
    // should now miss too.
    const missCtx = loadGraphBoostContext(stashDir, "alpha-original");
    expect(missCtx).toBeNull();
  });
});
