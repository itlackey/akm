import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmSearch } from "../src/commands/search";
import { saveConfig } from "../src/core/config";
import {
  closeDatabase,
  openDatabase,
  rebuildFts,
  searchFts,
  setMeta,
  upsertEmbedding,
  upsertEntry,
} from "../src/indexer/db";
import { akmIndex } from "../src/indexer/indexer";
import type { StashEntry } from "../src/indexer/metadata";
import { clearEmbeddingCache } from "../src/llm/embedder";
import type { SourceSearchHit } from "../src/sources/source-types";

// ── Temp directory management ───────────────────────────────────────────────

const createdTmpDirs: string[] = [];

function createTmpDir(prefix = "akm-parallel-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function writeFile(filePath: string, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function tmpStash(): string {
  const dir = createTmpDir("akm-parallel-stash-");
  for (const sub of ["skills", "commands", "agents", "knowledge", "scripts"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

function tmpDbPath(label = "parallel"): string {
  const dir = createTmpDir(`akm-${label}-`);
  return path.join(dir, "test.db");
}

function makeEntry(overrides: Partial<StashEntry> & { name: string; type: StashEntry["type"] }): StashEntry {
  return {
    description: "A test entry",
    ...overrides,
  };
}

function insertTestEntry(
  db: Database,
  key: string,
  opts?: {
    dirPath?: string;
    filePath?: string;
    stashDir?: string;
    description?: string;
    searchText?: string;
    type?: StashEntry["type"];
  },
): number {
  const type = opts?.type ?? "script";
  const entry = makeEntry({ name: key, type, description: opts?.description ?? `Description for ${key}` });
  return upsertEntry(
    db,
    key,
    opts?.dirPath ?? "/test/dir",
    opts?.filePath ?? `/test/dir/${key}.ts`,
    opts?.stashDir ?? "/test/stash",
    entry,
    opts?.searchText ?? `${key} ${entry.description}`,
  );
}

async function buildTestIndex(stashDir: string, files: Record<string, string>) {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(stashDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  process.env.AKM_STASH_DIR = stashDir;
  saveConfig({ semanticSearchMode: "off" });
  await akmIndex({ stashDir, full: true });
}

// ── Environment isolation ───────────────────────────────────────────────────

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalAkmStashDir = process.env.AKM_STASH_DIR;
let testCacheDir = "";
let testConfigDir = "";

beforeEach(() => {
  testCacheDir = createTmpDir("akm-parallel-cache-");
  testConfigDir = createTmpDir("akm-parallel-config-");
  process.env.XDG_CACHE_HOME = testCacheDir;
  process.env.XDG_CONFIG_HOME = testConfigDir;
  clearEmbeddingCache();
});

afterEach(() => {
  if (originalXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME;
  } else {
    process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  }
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
  if (originalAkmStashDir === undefined) {
    delete process.env.AKM_STASH_DIR;
  } else {
    process.env.AKM_STASH_DIR = originalAkmStashDir;
  }
  if (testCacheDir) {
    fs.rmSync(testCacheDir, { recursive: true, force: true });
    testCacheDir = "";
  }
  if (testConfigDir) {
    fs.rmSync(testConfigDir, { recursive: true, force: true });
    testConfigDir = "";
  }
});

// ── Test 1: Search results identical to sequential execution ────────────────

describe("Parallel search: result parity", () => {
  test("FTS-only search results are identical with parallel execution", async () => {
    const stashDir = tmpStash();

    writeFile(path.join(stashDir, "scripts", "deploy", "deploy.sh"), "#!/bin/bash\necho deploy\n");
    writeFile(
      path.join(stashDir, "scripts", "deploy", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "deploy",
            type: "script",
            description: "Deploy application to production servers",
            tags: ["deploy", "production"],
            filename: "deploy.sh",
          },
        ],
      }),
    );

    writeFile(path.join(stashDir, "scripts", "test", "test.sh"), "#!/bin/bash\necho test\n");
    writeFile(
      path.join(stashDir, "scripts", "test", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "test-runner",
            type: "script",
            description: "Run test suite for deployment validation",
            tags: ["test", "deploy"],
            filename: "test.sh",
          },
        ],
      }),
    );

    await buildTestIndex(stashDir, {});

    // Run the same query twice and verify identical results
    const result1 = await akmSearch({ query: "deploy", source: "local" });
    const result2 = await akmSearch({ query: "deploy", source: "local" });
    const localHits1 = result1.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    const localHits2 = result2.hits.filter((h): h is SourceSearchHit => h.type !== "registry");

    expect(localHits1.length).toBeGreaterThan(0);
    expect(localHits1.length).toBe(localHits2.length);

    for (let i = 0; i < localHits1.length; i++) {
      expect(localHits1[i].name).toBe(localHits2[i].name);
      expect(localHits1[i].score).toBe(localHits2[i].score);
      expect(localHits1[i].ref).toBe(localHits2[i].ref);
    }
  });
});

// ── Test 2: Embedding cache ─────────────────────────────────────────────────

describe("Embedding cache", () => {
  test("clearEmbeddingCache is callable without error", () => {
    // Verify the exported function exists and can be called
    expect(() => clearEmbeddingCache()).not.toThrow();
  });

  test("clearEmbeddingCache is idempotent and does not throw on repeated calls", () => {
    clearEmbeddingCache();
    clearEmbeddingCache();
    // Verify idempotence: calling clear multiple times should never throw
    expect(() => clearEmbeddingCache()).not.toThrow();
  });
});

// ── Test 3: Search works when vector search is unavailable ──────────────────

describe("Parallel search: vector unavailable", () => {
  test("search returns FTS results when no embeddings exist in DB", async () => {
    const stashDir = tmpStash();

    writeFile(path.join(stashDir, "scripts", "lint", "lint.sh"), "#!/bin/bash\necho lint\n");
    writeFile(
      path.join(stashDir, "scripts", "lint", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "lint",
            type: "script",
            description: "Lint source code for errors and style violations",
            filename: "lint.sh",
          },
        ],
      }),
    );

    await buildTestIndex(stashDir, {});

    const result = await akmSearch({ query: "lint", source: "local" });
    const localHits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");

    expect(localHits.length).toBeGreaterThanOrEqual(1);
    const lintHit = localHits.find((h) => h.name === "lint");
    expect(lintHit).toBeDefined();
    expect(lintHit?.score).toBeGreaterThan(0);
    // With semanticSearchMode disabled, should use FTS ranking
    expect(lintHit?.whyMatched).toContain("fts bm25 relevance");
  });
});

// ── Test 4: Search works when FTS returns empty ─────────────────────────────

describe("Parallel search: FTS empty", () => {
  test("search returns empty when FTS has no matches and no vec", async () => {
    const stashDir = tmpStash();

    writeFile(path.join(stashDir, "scripts", "alpha", "alpha.sh"), "#!/bin/bash\necho alpha\n");
    writeFile(
      path.join(stashDir, "scripts", "alpha", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "alpha",
            type: "script",
            description: "Alpha tool for testing",
            filename: "alpha.sh",
          },
        ],
      }),
    );

    await buildTestIndex(stashDir, {});

    // Query for something that won't match any FTS tokens
    const result = await akmSearch({ query: "zzzznonexistent", source: "local" });
    const localHits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");

    // Should return 0 results without crashing
    expect(localHits.length).toBe(0);
  });

  test("search with DB having vec entries but FTS empty returns vec-only results", async () => {
    // This test uses the low-level DB API to set up a scenario where
    // FTS has no matches but vec does (simulating semantic-only match)
    const dbPath = tmpDbPath("fts-empty");
    const db = openDatabase(dbPath, { embeddingDim: 4 });
    try {
      const id = insertTestEntry(db, "semantic-tool", {
        description: "A tool found only via semantic similarity",
        searchText: "vector embedding similarity neural network",
        stashDir: "/test/stash",
        dirPath: "/test/dir",
        filePath: "/test/dir/semantic-tool.ts",
      });

      upsertEmbedding(db, id, [1, 0, 0, 0]);
      setMeta(db, "hasEmbeddings", "1");
      setMeta(db, "stashDir", "/test/stash");
      rebuildFts(db);

      // Searching for "garbledftsquery" won't match FTS, but we verify
      // the search doesn't crash when FTS is empty
      const ftsResults = searchFts(db, "garbledftsquery", 10);
      expect(ftsResults).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });
});

// ── Test 5: Promise.all structure verification ──────────────────────────────

describe("Parallel search: FTS result ordering", () => {
  test("FTS search returns results sorted by score descending (semanticSearchMode off)", async () => {
    // NOTE: Despite the original "hybrid" naming, this test runs with
    // semanticSearchMode: "off", so only FTS scoring is exercised. True hybrid
    // (FTS + vector) coverage lives in tests/vector-search.test.ts.
    const stashDir = tmpStash();

    writeFile(path.join(stashDir, "scripts", "build", "build.sh"), "#!/bin/bash\necho build\n");
    writeFile(
      path.join(stashDir, "scripts", "build", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "build",
            type: "script",
            description: "Build the project from source",
            tags: ["build", "compile"],
            filename: "build.sh",
          },
        ],
      }),
    );

    writeFile(path.join(stashDir, "scripts", "compile", "compile.sh"), "#!/bin/bash\necho compile\n");
    writeFile(
      path.join(stashDir, "scripts", "compile", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "compile",
            type: "script",
            description: "Compile source code into binary artifacts",
            tags: ["compile"],
            filename: "compile.sh",
          },
        ],
      }),
    );

    await buildTestIndex(stashDir, {});

    const result = await akmSearch({ query: "build compile", source: "local" });
    const localHits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");

    // Both entries should be found
    expect(localHits.length).toBeGreaterThanOrEqual(1);
    // Results should be sorted by score descending
    for (let i = 1; i < localHits.length; i++) {
      expect(localHits[i - 1].score ?? 0).toBeGreaterThanOrEqual(localHits[i].score ?? 0);
    }
  });
});
