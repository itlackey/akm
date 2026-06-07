/**
 * Tests for incremental LLM enrichment caching.
 *
 * Verifies that:
 *   (a) A cache hit (matching body hash) skips the LLM call and reuses the
 *       stored result.
 *   (b) A changed body hash triggers a fresh LLM call and updates the cache.
 *   (c) --re-enrich bypasses the cache even when the body is unchanged.
 *   (d) clearStaleCacheEntries removes entries for assets no longer in the index.
 *
 * Graph extraction is controlled via a local Bun HTTP server — no module mocking,
 * no global state pollution between test files.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AkmConfig } from "../src/core/config";
import type { SearchSource } from "../src/indexer/search-source";

// ── Local LLM server (graph extraction) ──────────────────────────────────────
// A real HTTP server on a random port stands in for the LLM endpoint.
// This avoids mock.module("../src/llm/client") which leaks into other test
// files (e.g. tests/llm.test.ts) when Bun shares workers across files.

let graphExtractCallCount = 0;
let graphExtractor: (body: string) => { entities: string[]; relations: { from: string; to: string; type?: string }[] } =
  () => ({ entities: [], relations: [] });

const llmServer = Bun.serve({
  port: 0, // OS picks an available port
  fetch(_req) {
    graphExtractCallCount++;
    const result = graphExtractor("");
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(result) } }],
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  },
});

// ── Memory inference stub ─────────────────────────────────────────────────────
// memory-infer is not tested by any other file in the suite, so mock.module
// here is safe and does not leak.

let memoryCompressCallCount = 0;
let memoryCompressor: (body: string) =>
  | {
      title: string;
      description: string;
      tags: string[];
      searchHints: string[];
      content: string;
    }
  | undefined = () => undefined;

mock.module("../src/llm/memory-infer", () => ({
  compressMemoryToDerivedMemory: async (_config: unknown, body: string) => {
    memoryCompressCallCount++;
    return memoryCompressor(body);
  },
}));

// Import AFTER mock.module so the passes pick up the stubs.
const { runGraphExtractionPass } = await import("../src/indexer/graph-extraction");
const { runMemoryInferencePass } = await import("../src/indexer/memory-inference");
const {
  computeBodyHash,
  getLlmCacheEntry,
  upsertLlmCacheEntry,
  clearStaleCacheEntries,
  openDatabase,
  closeDatabase,
  upsertEntry,
} = await import("../src/indexer/db");
const { loadStoredGraphSnapshot } = await import("../src/indexer/graph-db");
const { buildSearchText } = await import("../src/indexer/search-fields");

// ── Fixtures ─────────────────────────────────────────────────────────────────

let tmpStash = "";
let tmpDbPath = "";
let db: Database;

// Pair the tmpStash with XDG_DATA_HOME / XDG_STATE_HOME so any code path that
// calls getDbPath() / getDataDir() under bun test resolves into a temp dir
// instead of being refused by the TEST_ISOLATION_MISSING write-guard in
// src/core/paths.ts.
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalXdgStateHome = process.env.XDG_STATE_HOME;

function configWithLlm(overrides?: Partial<AkmConfig>): AkmConfig {
  return {
    semanticSearchMode: "auto",
    profiles: {
      llm: {
        default: {
          endpoint: `http://localhost:${llmServer.port}/v1/chat/completions`,
          model: "test-model",
        },
      },
      improve: { default: { processes: { graphExtraction: { enabled: true } } } },
    },
    defaults: { llm: "default" },
    ...overrides,
  };
}

function sources(): SearchSource[] {
  return [{ path: tmpStash }];
}

function writeFile(rel: string, frontmatter: Record<string, unknown>, body: string): string {
  const fmLines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    fmLines.push(`${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  }
  fmLines.push("---");
  const content = `${fmLines.join("\n")}\n\n${body}\n`;
  const filePath = path.join(tmpStash, rel);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");

  // Schema v2: seed an entries row so replaceStoredGraph can resolve entry_id.
  if (db) {
    const typeDir = rel.split("/")[0] ?? "";
    const type = typeDir === "memories" ? "memory" : typeDir === "knowledge" ? "knowledge" : typeDir;
    const name = path.basename(rel, path.extname(rel));
    const entry = { name, type, filename: path.basename(rel) };
    try {
      upsertEntry(
        db,
        `${tmpStash}:${type}:${name}`,
        path.dirname(filePath),
        filePath,
        tmpStash,
        entry as Parameters<typeof upsertEntry>[5],
        buildSearchText(entry as Parameters<typeof buildSearchText>[0]),
      );
    } catch {
      /* db may be closed in some teardown paths */
    }
  }
  return filePath;
}

function sampleDraft(title = "Derived Insight") {
  return {
    title,
    description: "A high-signal summary.",
    tags: ["memory", "derived", "test"],
    searchHints: ["find derived memory", "compressed memory", "inference output"],
    content: "Compressed content body.",
  };
}

beforeEach(() => {
  tmpStash = fs.mkdtempSync(path.join(os.tmpdir(), "akm-llm-cache-"));
  fs.mkdirSync(path.join(tmpStash, "memories"), { recursive: true });
  fs.mkdirSync(path.join(tmpStash, "knowledge"), { recursive: true });

  // Redirect $DATA / $STATE into temp dirs so getDbPath() callers downstream
  // do not trip TEST_ISOLATION_MISSING.
  process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "akm-llm-cache-data-"));
  process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "akm-llm-cache-state-"));

  tmpDbPath = path.join(tmpStash, "test.db");
  db = openDatabase(tmpDbPath);

  graphExtractCallCount = 0;
  memoryCompressCallCount = 0;
  graphExtractor = () => ({ entities: [], relations: [] });
  memoryCompressor = () => undefined;
});

afterEach(() => {
  closeDatabase(db);
  if (tmpStash) {
    fs.rmSync(tmpStash, { recursive: true, force: true });
    tmpStash = "";
  }
  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdgDataHome;
  if (originalXdgStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalXdgStateHome;
});

afterAll(() => {
  mock.restore();
  llmServer.stop(true);
});

// ── computeBodyHash ───────────────────────────────────────────────────────────

describe("computeBodyHash", () => {
  test("produces a hex string", () => {
    const h = computeBodyHash("hello world");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test("different bodies produce different hashes", () => {
    expect(computeBodyHash("body A")).not.toBe(computeBodyHash("body B"));
  });

  test("same body always produces the same hash", () => {
    const body = "stable body text for hashing";
    expect(computeBodyHash(body)).toBe(computeBodyHash(body));
  });
});

// ── getLlmCacheEntry / upsertLlmCacheEntry ────────────────────────────────────

describe("getLlmCacheEntry / upsertLlmCacheEntry", () => {
  test("returns undefined when no entry exists", () => {
    expect(getLlmCacheEntry(db, "some-ref", "abc123")).toBeUndefined();
  });

  test("returns cached entry when hash matches", () => {
    upsertLlmCacheEntry(db, "my-ref", "hashABC", JSON.stringify({ foo: "bar" }));
    const entry = getLlmCacheEntry(db, "my-ref", "hashABC");
    expect(entry).not.toBeUndefined();
    expect(entry?.bodyHash).toBe("hashABC");
    expect(JSON.parse(entry?.resultJson ?? "null")).toEqual({ foo: "bar" });
  });

  test("returns undefined (cache miss) when body hash has changed", () => {
    upsertLlmCacheEntry(db, "my-ref", "hashOLD", JSON.stringify({ foo: "bar" }));
    // Different hash → cache miss
    expect(getLlmCacheEntry(db, "my-ref", "hashNEW")).toBeUndefined();
  });

  test("upsert overwrites an existing entry", () => {
    upsertLlmCacheEntry(db, "my-ref", "hash1", JSON.stringify({ v: 1 }));
    upsertLlmCacheEntry(db, "my-ref", "hash2", JSON.stringify({ v: 2 }));
    const entry = getLlmCacheEntry(db, "my-ref", "hash2");
    expect(entry).toBeDefined();
    expect(JSON.parse(entry?.resultJson ?? "null")).toEqual({ v: 2 });
  });
});

// ── clearStaleCacheEntries ────────────────────────────────────────────────────

describe("clearStaleCacheEntries", () => {
  test("removes cache entries whose asset_ref is not in entries or file_path", () => {
    upsertLlmCacheEntry(db, "/stash/memories/ghost.md", "h1", "{}");
    upsertLlmCacheEntry(db, "/stash/memories/alive.md", "h2", "{}");

    // Insert a live entry into the entries table so /stash/memories/alive.md is retained.
    db.exec(`
      INSERT INTO entries (entry_key, dir_path, file_path, stash_dir, entry_json, search_text, entry_type)
      VALUES ('/stash:memory:alive', '/stash/memories', '/stash/memories/alive.md', '/stash', '{}', '', 'memory')
    `);

    clearStaleCacheEntries(db);

    // Ghost entry should be gone (no matching entries row).
    const ghostCount = (
      db
        .prepare("SELECT COUNT(*) AS cnt FROM llm_enrichment_cache WHERE asset_ref = ?")
        .get("/stash/memories/ghost.md") as {
        cnt: number;
      }
    ).cnt;
    expect(ghostCount).toBe(0);

    // Alive entry should be retained (its file_path matches an entries row).
    const aliveCount = (
      db
        .prepare("SELECT COUNT(*) AS cnt FROM llm_enrichment_cache WHERE asset_ref = ?")
        .get("/stash/memories/alive.md") as {
        cnt: number;
      }
    ).cnt;
    expect(aliveCount).toBe(1);
  });
});

// ── Graph extraction cache ────────────────────────────────────────────────────

describe("runGraphExtractionPass — cache hit skips LLM call", () => {
  test("(a) cache hit: unchanged body does not call the LLM extractor", async () => {
    writeFile("memories/m1.md", {}, "Body about ServiceA and ServiceB.");
    graphExtractor = () => ({ entities: ["ServiceA", "ServiceB"], relations: [] });

    // First run: LLM is called and result is cached.
    const first = await runGraphExtractionPass({ config: configWithLlm(), sources: sources(), db, reEnrich: false });
    expect(first.written).toBe(true);
    expect(graphExtractCallCount).toBe(1);

    const callsAfterFirst = graphExtractCallCount;

    // Second run with same db and same file body: should be a cache hit.
    const second = await runGraphExtractionPass({ config: configWithLlm(), sources: sources(), db, reEnrich: false });
    expect(second.written).toBe(true);
    // LLM must NOT have been called again — it should serve from cache.
    expect(graphExtractCallCount).toBe(callsAfterFirst);

    // The cache table should have one entry.
    const cacheCount = (db.prepare("SELECT COUNT(*) AS cnt FROM llm_enrichment_cache").get() as { cnt: number }).cnt;
    expect(cacheCount).toBeGreaterThan(0);
  });

  test("(b) changed body hash triggers a new LLM call and updates the cache", async () => {
    const filePath = writeFile("memories/m1.md", {}, "Original body about ServiceA.");
    graphExtractor = () => ({ entities: ["ServiceA"], relations: [] });

    // First run.
    await runGraphExtractionPass({ config: configWithLlm(), sources: sources(), db, reEnrich: false });
    expect(graphExtractCallCount).toBe(1);

    // Mutate the file body.
    fs.writeFileSync(filePath, "---\n---\n\nCompletely new body about ServiceB.\n", "utf8");
    graphExtractor = () => ({ entities: ["ServiceB"], relations: [] });

    // Second run: body changed → cache miss → new LLM call.
    const second = await runGraphExtractionPass({ config: configWithLlm(), sources: sources(), db, reEnrich: false });
    expect(graphExtractCallCount).toBe(2);
    expect(second.written).toBe(true);
    // The graph should now contain the new entity.
    const graph = loadStoredGraphSnapshot(tmpStash, db) as { files: Array<{ entities: string[] }> };
    expect(graph.files[0]?.entities).toContain("ServiceB");
  });

  test("(c) --re-enrich bypasses the cache even when body is unchanged", async () => {
    writeFile("memories/m1.md", {}, "Body about ServiceA.");
    graphExtractor = () => ({ entities: ["ServiceA"], relations: [] });

    // First run fills the cache.
    await runGraphExtractionPass({ config: configWithLlm(), sources: sources(), db, reEnrich: false });
    expect(graphExtractCallCount).toBe(1);

    // Second run with reEnrich=true must call LLM again.
    await runGraphExtractionPass({ config: configWithLlm(), sources: sources(), db, reEnrich: true });
    expect(graphExtractCallCount).toBe(2);
  });

  test("(d) graph cache is versioned by extractor settings such as model", async () => {
    writeFile("memories/m1.md", {}, "Body about ServiceA.");
    graphExtractor = () => ({ entities: ["ServiceA"], relations: [] });

    await runGraphExtractionPass({ config: configWithLlm(), sources: sources(), db, reEnrich: false });
    expect(graphExtractCallCount).toBe(1);

    await runGraphExtractionPass({
      config: configWithLlm({
        profiles: {
          llm: {
            default: {
              endpoint: `http://localhost:${llmServer.port}/v1/chat/completions`,
              model: "different-model",
            },
          },
          improve: { default: { processes: { graphExtraction: { enabled: true } } } },
        },
        defaults: { llm: "default" },
      }),
      sources: sources(),
      db,
      reEnrich: false,
    });
    expect(graphExtractCallCount).toBe(2);
  });
});

// ── Memory inference cache ─────────────────────────────────────────────────────

describe("runMemoryInferencePass — cache hit skips LLM call", () => {
  test("(a) cache hit: unchanged body does not call the LLM compressor", async () => {
    // Write a fresh memory file that hasn't been processed yet.
    const freshPath = writeFile("memories/fresh.md", {}, "A brand new memory body.");
    memoryCompressor = () => sampleDraft("Should Not Be Called");

    // Pre-populate the cache with the exact body that parseFrontmatter will
    // return for this file. parseFrontmatter returns content WITH leading "\n\n"
    // stripped (the actual body after the frontmatter block). The body the pass
    // hashes is `parseFrontmatter(raw).content` which equals
    // "\n\nA brand new memory body.\n" for our writeFile helper.
    // We read the actual file and parse it to get the exact string the pass sees.
    const { parseFrontmatter } = await import("../src/core/frontmatter");
    const raw = fs.readFileSync(freshPath, "utf8");
    const parsed = parseFrontmatter(raw);
    const exactBody = parsed.content; // exactly what the pass hashes

    upsertLlmCacheEntry(db, freshPath, computeBodyHash(exactBody), JSON.stringify(sampleDraft("Cached Result")));

    // Run the pass — cache hit → LLM must NOT be called.
    const result = await runMemoryInferencePass({ config: configWithLlm(), sources: sources(), db, reEnrich: false });
    expect(memoryCompressCallCount).toBe(0);
    // Derived memory IS written (from the cached draft).
    expect(result.writtenFacts).toBe(1);
  });

  test("(b) changed body hash triggers a new LLM call", async () => {
    const filePath = writeFile("memories/parent.md", {}, "Original body text.");
    memoryCompressor = () => sampleDraft("From LLM");

    // Prime the cache with a deliberately wrong hash (simulating a stale entry
    // from a previous run when the body was different).
    upsertLlmCacheEntry(
      db,
      filePath,
      computeBodyHash("completely different old body"),
      JSON.stringify(sampleDraft("Stale")),
    );

    // Run — body hash mismatch → cache miss → LLM called.
    const result = await runMemoryInferencePass({ config: configWithLlm(), sources: sources(), db, reEnrich: false });
    expect(memoryCompressCallCount).toBe(1);
    expect(result.writtenFacts).toBe(1);
  });

  test("(c) --re-enrich bypasses the cache", async () => {
    const filePath = writeFile("memories/parent.md", {}, "Body text.");
    memoryCompressor = () => sampleDraft("Fresh");

    // Pre-populate a valid cache entry with the exact parsed body hash.
    const { parseFrontmatter } = await import("../src/core/frontmatter");
    const raw = fs.readFileSync(filePath, "utf8");
    const exactBody = parseFrontmatter(raw).content;
    upsertLlmCacheEntry(db, filePath, computeBodyHash(exactBody), JSON.stringify(sampleDraft("Cached")));

    // Run with reEnrich=true — must call LLM despite cache hit.
    await runMemoryInferencePass({ config: configWithLlm(), sources: sources(), db, reEnrich: true });
    expect(memoryCompressCallCount).toBe(1);
  });
});
