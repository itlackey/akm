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
 * The LLM modules are mocked via `mock.module` — no real network calls occur.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AkmConfig } from "../src/core/config";
import type { SearchSource } from "../src/indexer/search-source";

// ── LLM stubs ────────────────────────────────────────────────────────────────

// Graph extraction stub — controlled per-test via `graphExtractor`.
let graphExtractCallCount = 0;
let graphExtractor: (body: string) => { entities: string[]; relations: { from: string; to: string; type?: string }[] } =
  () => ({ entities: [], relations: [] });

mock.module("../src/llm/graph-extract", () => ({
  extractGraphFromBody: async (_config: unknown, body: string) => {
    graphExtractCallCount++;
    return graphExtractor(body);
  },
  extractGraphFromBodies: async (_config: unknown, bodies: string[]) => {
    return bodies.map((body) => {
      graphExtractCallCount++;
      return graphExtractor(body);
    });
  },
}));

// Memory inference stub — controlled per-test via `memoryCompressor`.
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
const { computeBodyHash, getLlmCacheEntry, upsertLlmCacheEntry, clearStaleCacheEntries, openDatabase, closeDatabase } =
  await import("../src/indexer/db");

// ── Fixtures ─────────────────────────────────────────────────────────────────

let tmpStash = "";
let tmpDbPath = "";
let db: Database;

const SAMPLE_LLM = {
  endpoint: "http://localhost:11434/v1/chat/completions",
  model: "llama3.2",
};

function configWithLlm(overrides?: Partial<AkmConfig>): AkmConfig {
  return { semanticSearchMode: "auto", llm: { ...SAMPLE_LLM }, ...overrides };
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
});

// Restore all mock.module overrides so they don't leak into other test files
// when Bun runs multiple files in the same worker process.
afterAll(() => {
  mock.restore();
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
    const first = await runGraphExtractionPass(configWithLlm(), sources(), undefined, db, false);
    expect(first.written).toBe(true);
    expect(graphExtractCallCount).toBe(1);

    const callsAfterFirst = graphExtractCallCount;

    // Second run with same db and same file body: should be a cache hit.
    const second = await runGraphExtractionPass(configWithLlm(), sources(), undefined, db, false);
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
    await runGraphExtractionPass(configWithLlm(), sources(), undefined, db, false);
    expect(graphExtractCallCount).toBe(1);

    // Mutate the file body.
    fs.writeFileSync(filePath, "---\n---\n\nCompletely new body about ServiceB.\n", "utf8");
    graphExtractor = () => ({ entities: ["ServiceB"], relations: [] });

    // Second run: body changed → cache miss → new LLM call.
    const second = await runGraphExtractionPass(configWithLlm(), sources(), undefined, db, false);
    expect(graphExtractCallCount).toBe(2);
    expect(second.written).toBe(true);
    // The graph should now contain the new entity.
    const graphPath = path.join(tmpStash, ".akm", "graph.json");
    const graph = JSON.parse(fs.readFileSync(graphPath, "utf8")) as { files: Array<{ entities: string[] }> };
    expect(graph.files[0]?.entities).toContain("serviceb");
  });

  test("(c) --re-enrich bypasses the cache even when body is unchanged", async () => {
    writeFile("memories/m1.md", {}, "Body about ServiceA.");
    graphExtractor = () => ({ entities: ["ServiceA"], relations: [] });

    // First run fills the cache.
    await runGraphExtractionPass(configWithLlm(), sources(), undefined, db, false);
    expect(graphExtractCallCount).toBe(1);

    // Second run with reEnrich=true must call LLM again.
    await runGraphExtractionPass(configWithLlm(), sources(), undefined, db, true);
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
    const result = await runMemoryInferencePass(configWithLlm(), sources(), undefined, db, false);
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
    const result = await runMemoryInferencePass(configWithLlm(), sources(), undefined, db, false);
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
    await runMemoryInferencePass(configWithLlm(), sources(), undefined, db, true);
    expect(memoryCompressCallCount).toBe(1);
  });
});
