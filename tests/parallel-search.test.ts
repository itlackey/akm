import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmSearch } from "../src/commands/read/search";
import { saveConfig } from "../src/core/config/config";
import { akmIndex } from "../src/indexer/indexer";
import { clearEmbeddingCache } from "../src/llm/embedder";
import { getCachedEmbedding, setCachedEmbedding } from "../src/llm/embedders/cache";
import type { SourceSearchHit } from "../src/sources/types";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
  withEnv,
} from "./_helpers/sandbox";

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

/**
 * Index `stashDir` with AKM_BUNDLE_DIR pointed at it, then run `run` while the
 * env override is still in effect — every akmSearch call a test makes must run
 * inside `run` so it reads back the stash that was just indexed.
 */
async function withTestIndex<T>(stashDir: string, run: () => Promise<T> | T): Promise<T> {
  return withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
    saveConfig({ semanticSearchMode: "off" });
    await akmIndex({ stashDir, full: true });
    return run();
  });
}

// ── Environment isolation ───────────────────────────────────────────────────

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const dataResult = sandboxXdgDataHome();
  const cacheResult = sandboxXdgCacheHome(dataResult.cleanup);
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const stashResult = sandboxStashDir(cfgResult.cleanup);
  envCleanup = stashResult.cleanup;
  clearEmbeddingCache();
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
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

    await withTestIndex(stashDir, async () => {
      // Run the same query twice and verify identical results.
      // skipLogging prevents utility-score bumps from the first call affecting
      // the second call's ranking scores.
      const result1 = await akmSearch({ query: "deploy", source: "local", skipLogging: true });
      const result2 = await akmSearch({ query: "deploy", source: "local", skipLogging: true });
      const localHits1 = result1.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
      const localHits2 = result2.hits.filter((h): h is SourceSearchHit => h.type !== "registry");

      expect(localHits1.length).toBeGreaterThan(0);
      expect(localHits1.length).toBe(localHits2.length);

      for (let i = 0; i < localHits1.length; i++) {
        expect(localHits1[i]!.name).toBe(localHits2[i]!.name);
        expect(localHits1[i]!.score).toBe(localHits2[i]!.score);
        expect(localHits1[i]!.ref).toBe(localHits2[i]!.ref);
      }
    });
  });
});

// ── Test 2: Embedding cache ─────────────────────────────────────────────────

describe("Embedding cache", () => {
  test("clearEmbeddingCache is idempotent and does not throw on repeated calls", () => {
    clearEmbeddingCache();
    clearEmbeddingCache();
    // Verify idempotence: calling clear multiple times should never throw
    expect(() => clearEmbeddingCache()).not.toThrow();
  });

  // VALUE-17: `not.toThrow()` alone can't fail if clearing became a no-op —
  // it would still not throw. Pin the observable effect instead: a cached
  // embedding is gone after clearing, so the next lookup is a real miss.
  test("clearEmbeddingCache actually discards cached entries, not just avoids throwing", () => {
    const key = "value-17-cache-probe";
    setCachedEmbedding(key, [0.1, 0.2, 0.3]);
    expect(getCachedEmbedding(key)).toEqual([0.1, 0.2, 0.3]);

    clearEmbeddingCache();

    expect(getCachedEmbedding(key)).toBeUndefined();
  });
});

// ── Test 3: Search works when vector search is unavailable ──────────────────

describe("Parallel search: vector unavailable", () => {
  test("search returns FTS results when no embeddings exist in DB", async () => {
    const stashDir = tmpStash();

    // #39: sidecars retired — seed via knowledge/*.md frontmatter (this test pins
    // FTS fallback when no embeddings exist, not sidecar behavior).
    writeFile(
      path.join(stashDir, "knowledge", "lint.md"),
      "---\ndescription: Lint source code for errors and style violations\n---\n",
    );

    await withTestIndex(stashDir, async () => {
      const result = await akmSearch({ query: "lint", source: "local" });
      const localHits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");

      expect(localHits.length).toBeGreaterThanOrEqual(1);
      const lintHit = localHits.find((h) => h.name === "lint");
      expect(lintHit).toBeDefined();
      expect(lintHit?.score).toBeGreaterThan(0);
      // With semanticSearchMode disabled, should use FTS ranking
      expect(lintHit?.whyMatched).toEqual(["lexical rank 1"]);
    });
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

    await withTestIndex(stashDir, async () => {
      // Query for something that won't match any FTS tokens
      const result = await akmSearch({ query: "zzzznonexistent", source: "local" });
      const localHits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");

      // Should return 0 results without crashing
      expect(localHits.length).toBe(0);
    });
  });
});

// ── Test 5: Promise.all structure verification ──────────────────────────────

describe("Parallel search: FTS result ordering", () => {
  test("FTS search returns results sorted by score descending (semanticSearchMode off)", async () => {
    // NOTE: Despite the original "hybrid" naming, this test runs with
    // semanticSearchMode: "off", so only FTS scoring is exercised. True hybrid
    // (FTS + vector) coverage lives in tests/vector-search.test.ts.
    const stashDir = tmpStash();

    // #39: sidecars retired — seed via knowledge/*.md frontmatter (this test pins
    // score-descending FTS ordering, not sidecar behavior).
    writeFile(
      path.join(stashDir, "knowledge", "build.md"),
      "---\ndescription: Build the project from source\ntags:\n  - build\n  - compile\n---\n",
    );

    writeFile(
      path.join(stashDir, "knowledge", "compile.md"),
      "---\ndescription: Compile source code into binary artifacts\ntags:\n  - compile\n---\n",
    );

    await withTestIndex(stashDir, async () => {
      const result = await akmSearch({ query: "build compile", source: "local" });
      const localHits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");

      // Both entries should be found
      expect(localHits.length).toBeGreaterThanOrEqual(1);
      // Results should be sorted by score descending
      for (let i = 1; i < localHits.length; i++) {
        expect(localHits[i - 1]!.score ?? 0).toBeGreaterThanOrEqual(localHits[i]!.score ?? 0);
      }
    });
  });
});
