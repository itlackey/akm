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
 * The stub LLM endpoint is a local Bun HTTP server — no module mocking, no
 * global state pollution between test files.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../../../src/core/config/config";
import type { SearchSource } from "../../../src/indexer/search/search-source";
import type { Database } from "../../../src/storage/database";
import { type Cleanup, makeSandboxDir, sandboxXdgDataHome, sandboxXdgStateHome } from "../../_helpers/sandbox";

// ── Local LLM server (stub endpoint) ──────────────────────────────────────────
// A real HTTP server on a random port stands in for the LLM endpoint so
// `configWithLlm()` can point a real engine at it. This avoids
// mock.module("../src/llm/client") which leaks into other test files (e.g.
// tests/llm.test.ts) when Bun shares workers across files. The memory-inference
// tests below never actually reach it — they inject `compressMemoryToDerivedMemory`
// directly (see `memoryInferenceOptions()`) — so this stub only needs to answer
// with well-formed JSON, never anything content-specific.

let llmCallCount = 0;
let llmResponder: (body: string) => { entities: string[]; relations: { from: string; to: string; type?: string }[] } =
  () => ({ entities: [], relations: [] });

const llmServer = Bun.serve({
  port: 0, // OS picks an available port
  fetch(_req) {
    llmCallCount++;
    const result = llmResponder("");
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(result) } }],
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  },
});

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

const { runMemoryInferencePass: runMemoryInferencePassImpl } = await import(
  "../../../src/indexer/passes/memory-inference"
);
const { computeBodyHash, getLlmCacheEntry, upsertLlmCacheEntry, clearStaleCacheEntries } = await import(
  "../../../src/storage/repositories/index-llm-cache-repository"
);
const { openIndexDatabase, closeDatabase } = await import("../../../src/storage/repositories/index-connection");
const { upsertEntry } = await import("../../../src/storage/repositories/index-entries-repository");
const { deriveEntryProvenance } = await import("../../../src/indexer/installations");

function memoryInferenceOptions() {
  return {
    compressMemoryToDerivedMemory: async (_config: unknown, body: string) => {
      memoryCompressCallCount++;
      return memoryCompressor(body);
    },
  };
}

function runMemoryInferencePass(...args: Parameters<typeof runMemoryInferencePassImpl>) {
  const [ctx] = args;
  return runMemoryInferencePassImpl({ ...ctx, options: { ...ctx.options, ...memoryInferenceOptions() } });
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

let tmpStash = "";
let tmpDbPath = "";
let db: Database;

// Pair the tmpStash with XDG_DATA_HOME / XDG_STATE_HOME so any code path that
// calls getDbPath() / getDataDir() under bun test resolves into a temp dir
// instead of being refused by the TEST_ISOLATION_MISSING write-guard in
// src/core/paths.ts.
let envCleanup: Cleanup = () => {};

function configWithLlm(overrides?: Partial<AkmConfig>): AkmConfig {
  const base: AkmConfig = {
    configVersion: "0.9.0",
    semanticSearchMode: "auto",
    engines: {
      test: {
        kind: "llm",
        endpoint: `http://localhost:${llmServer.port}/v1/chat/completions`,
        model: "test-model",
      },
    },
    defaults: { engine: "test", llmEngine: "test" },
    index: { defaults: { engine: "test" } },
  };
  return {
    ...base,
    ...overrides,
    engines: { ...base.engines, ...overrides?.engines },
    defaults: { ...base.defaults, ...overrides?.defaults },
    index: { ...base.index, ...overrides?.index },
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

  // Schema v2: seed an entries row so downstream code that resolves entry_id can find this file.
  if (db) {
    const typeDir = rel.split("/")[0] ?? "";
    const type = typeDir === "memories" ? "memory" : typeDir === "knowledge" ? "knowledge" : typeDir;
    const name = path.basename(rel, path.extname(rel));
    const entry = { name, type, filename: path.basename(rel) };
    try {
      upsertEntry(
        db,
        filePath,
        entry,
        deriveEntryProvenance({ bundleId: "stash", componentId: "stash", adapterId: "akm" }, type, name),
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
  tmpStash = makeSandboxDir("akm-llm-cache-").dir;
  fs.mkdirSync(path.join(tmpStash, "memories"), { recursive: true });
  fs.mkdirSync(path.join(tmpStash, "knowledge"), { recursive: true });

  // Redirect $DATA / $STATE into temp dirs so getDbPath() callers downstream
  // do not trip TEST_ISOLATION_MISSING.
  const dataResult = sandboxXdgDataHome();
  envCleanup = sandboxXdgStateHome(dataResult.cleanup).cleanup;

  tmpDbPath = path.join(tmpStash, "test.db");
  db = openIndexDatabase(tmpDbPath);

  llmCallCount = 0;
  memoryCompressCallCount = 0;
  llmResponder = () => ({ entities: [], relations: [] });
  memoryCompressor = () => undefined;
});

afterEach(() => {
  closeDatabase(db);
  if (tmpStash) {
    fs.rmSync(tmpStash, { recursive: true, force: true });
    tmpStash = "";
  }
  envCleanup();
  envCleanup = () => {};
});

afterAll(() => {
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
    expect(getLlmCacheEntry(db, "some-ref", "abc123", "v1")).toBeUndefined();
  });

  test("returns cached entry when hash matches", () => {
    upsertLlmCacheEntry(db, "my-ref", "hashABC", JSON.stringify({ foo: "bar" }), "v1");
    const entry = getLlmCacheEntry(db, "my-ref", "hashABC", "v1");
    expect(entry).not.toBeUndefined();
    expect(entry?.bodyHash).toBe("hashABC");
    expect(JSON.parse(entry?.resultJson ?? "null")).toEqual({ foo: "bar" });
  });

  test("returns undefined (cache miss) when body hash has changed", () => {
    upsertLlmCacheEntry(db, "my-ref", "hashOLD", JSON.stringify({ foo: "bar" }), "v1");
    // Different hash → cache miss
    expect(getLlmCacheEntry(db, "my-ref", "hashNEW", "v1")).toBeUndefined();
  });

  test("upsert overwrites an existing entry", () => {
    upsertLlmCacheEntry(db, "my-ref", "hash1", JSON.stringify({ v: 1 }), "v1");
    upsertLlmCacheEntry(db, "my-ref", "hash2", JSON.stringify({ v: 2 }), "v1");
    const entry = getLlmCacheEntry(db, "my-ref", "hash2", "v1");
    expect(entry).toBeDefined();
    expect(JSON.parse(entry?.resultJson ?? "null")).toEqual({ v: 2 });
  });
});

// ── ensureSchema — retired metadata-enhance cache rows ────────────────────────

describe("ensureSchema — retired metadata-enhance cache rows", () => {
  test("drops the default cache_variant on the next writable open but keeps named variants", () => {
    // Metadata-enhance (retired 0.9.17-alpha.9) was the only writer that left
    // cache_variant at its default empty string; graph and memory inference
    // always pass a named variant.
    upsertLlmCacheEntry(db, "some-bundle//knowledge/thing", "h1", "{}", "");
    upsertLlmCacheEntry(db, "/stash/memories/parent.md", "h2", "{}", "memory-inference-v2");
    closeDatabase(db);

    db = openIndexDatabase(tmpDbPath);

    const rows = db.prepare("SELECT asset_ref, cache_variant FROM llm_enrichment_cache").all();
    expect(rows).toEqual([{ asset_ref: "/stash/memories/parent.md", cache_variant: "memory-inference-v2" }]);
  });
});

// ── clearStaleCacheEntries ────────────────────────────────────────────────────

describe("clearStaleCacheEntries", () => {
  test("removes cache entries whose asset_ref is not in entries or file_path", () => {
    upsertLlmCacheEntry(db, "/stash/memories/ghost.md", "h1", "{}", "v1");
    upsertLlmCacheEntry(db, "/stash/memories/alive.md", "h2", "{}", "v1");

    // Insert a live entry into the entries table so /stash/memories/alive.md is retained.
    upsertEntry(
      db,
      "/stash/memories/alive.md",
      { name: "alive", type: "memory" },
      deriveEntryProvenance({ bundleId: "stash", componentId: "stash", adapterId: "akm" }, "memory", "memories/alive"),
    );

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
    const { parseFrontmatter } = await import("../../../src/core/asset/frontmatter");
    const raw = fs.readFileSync(freshPath, "utf8");
    const parsed = parseFrontmatter(raw);
    const exactBody = parsed.content; // exactly what the pass hashes

    upsertLlmCacheEntry(
      db,
      freshPath,
      computeBodyHash(exactBody),
      JSON.stringify(sampleDraft("Cached Result")),
      "memory-inference-v2",
    );

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
      "memory-inference-v2",
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
    const { parseFrontmatter } = await import("../../../src/core/asset/frontmatter");
    const raw = fs.readFileSync(filePath, "utf8");
    const exactBody = parseFrontmatter(raw).content;
    upsertLlmCacheEntry(
      db,
      filePath,
      computeBodyHash(exactBody),
      JSON.stringify(sampleDraft("Cached")),
      "memory-inference-v2",
    );

    // Run with reEnrich=true — must call LLM despite cache hit.
    await runMemoryInferencePass({ config: configWithLlm(), sources: sources(), db, reEnrich: true });
    expect(memoryCompressCallCount).toBe(1);
  });
});
