/**
 * Tests for the vector search path (`searchVec`):
 *
 *  - results from the BLOB table, closest first, ranked by cosine similarity
 *  - Dimension mismatch produces zero similarity
 *  - targeted embedding selection and the L2-to-cosine conversion
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveEntryProvenance } from "../../src/indexer/installations";
import type { IndexDocument } from "../../src/indexer/passes/metadata";
import { cosineSimilarity } from "../../src/llm/embedder";
import type { Database } from "../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../src/storage/repositories/index-entries-repository";
import { rebuildFts } from "../../src/storage/repositories/index-fts-repository";
import { setMeta } from "../../src/storage/repositories/index-meta-repository";
import {
  getAllEntriesForEmbedding,
  searchVec,
  upsertEmbedding,
} from "../../src/storage/repositories/index-vec-repository";
import { type Cleanup, sandboxXdgCacheHome, sandboxXdgConfigHome } from "../_helpers/sandbox";

// ── Temp directory management ───────────────────────────────────────────────

const createdTmpDirs: string[] = [];

function createTmpDir(prefix = "akm-vec-"): string {
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

function tmpDbPath(label = "vec"): string {
  const dir = createTmpDir(`akm-${label}-`);
  return path.join(dir, "test.db");
}

function makeEntry(overrides: Partial<IndexDocument> & { name: string; type: string }): IndexDocument {
  return {
    description: "A test entry",
    ...overrides,
  };
}

function insertTestEntry(
  db: Database,
  key: string,
  opts?: {
    filePath?: string;
    stashDir?: string;
    description?: string;
    searchText?: string;
    type?: string;
    tags?: string[];
    content?: string;
  },
): number {
  const type = opts?.type ?? "script";
  const entry = makeEntry({
    name: key,
    type,
    description: opts?.description ?? `Description for ${key}`,
    tags: opts?.tags,
    content: opts?.content,
  });
  return upsertEntry(
    db,
    opts?.filePath ?? path.join(opts?.stashDir ?? "/test/stash", `${key}.ts`),
    entry,
    opts?.searchText ?? `${key} ${entry.description}`,
    deriveEntryProvenance({ bundleId: "stash", componentId: "stash", adapterId: "akm" }, type, key),
  );
}

/**
 * Create a normalized Float32 vector of the given dimension.
 * The vector has value `val` at each position, then is L2-normalized.
 */
function makeNormalizedVec(dim: number, val = 1): number[] {
  const raw = new Array(dim).fill(val);
  const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0));
  return raw.map((v) => v / norm);
}

// ── Environment isolation ───────────────────────────────────────────────────

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  envCleanup = cfgResult.cleanup;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
});

// ── Test a: searchVec over the BLOB table ──────────────────────────────────

describe("searchVec over stored embeddings", () => {
  test("searchVec returns results when embeddings exist in BLOB table", () => {
    // Verify the low-level searchVec returns results from the embeddings
    // BLOB table. This is the data path the vector channel consumes.
    const dbPath = tmpDbPath("vec-activation");
    const dim = 4;
    const db = openIndexDatabase(dbPath);
    try {
      const id = insertTestEntry(db, "vec-ready-tool", {
        description: "A tool with embeddings ready for vector search",
        stashDir: "/test/stash",
      });
      rebuildFts(db);

      // Insert a normalized embedding into the BLOB table
      const embedding = makeNormalizedVec(dim);
      upsertEmbedding(db, id, embedding);
      setMeta(db, "hasEmbeddings", "1");

      // Query with the same vector — should find the entry
      const results = searchVec(db, embedding, 5);
      expect(results.length).toBe(1);
      expect(results[0]!.id).toBe(id);
      // Distance should be ~0 since query = stored embedding
      expect(results[0]!.distance).toBeLessThan(0.01);
    } finally {
      closeDatabase(db);
    }
  });

  test("searchVec returns results sorted by similarity (closest first)", () => {
    const dbPath = tmpDbPath("vec-sorted");
    const dim = 4;
    const db = openIndexDatabase(dbPath);
    try {
      // Insert two entries with different embeddings
      const id1 = insertTestEntry(db, "close-match", {
        description: "Close match entry",
        stashDir: "/test/stash",
      });
      const id2 = insertTestEntry(db, "far-match", {
        description: "Far match entry",
        stashDir: "/test/stash",
      });
      rebuildFts(db);

      // close-match: embedding near the query direction
      const closeEmb = makeNormalizedVec(dim, 1); // [0.5, 0.5, 0.5, 0.5] normalized
      upsertEmbedding(db, id1, closeEmb);

      // far-match: embedding in a very different direction
      const farRaw = [1, 0, 0, 0]; // already unit
      upsertEmbedding(db, id2, farRaw);

      setMeta(db, "hasEmbeddings", "1");

      // Query with the same direction as close-match
      const queryVec = makeNormalizedVec(dim, 1);
      const results = searchVec(db, queryVec, 10);

      expect(results.length).toBe(2);
      // The close match should come first (smaller distance)
      const closeResult = results.find((r) => r.id === id1);
      const farResult = results.find((r) => r.id === id2);
      expect(closeResult).toBeDefined();
      expect(farResult).toBeDefined();
      expect(closeResult?.distance).toBeLessThan(farResult?.distance ?? Number.POSITIVE_INFINITY);
    } finally {
      closeDatabase(db);
    }
  });
});

// ── Test f: cosine ranking over the BLOB table ─────────────────────────────

describe("cosine ranking over the BLOB table", () => {
  test("searchVec with BLOB embeddings returns correct similarity ranking", () => {
    const dbPath = tmpDbPath("blob-fallback");
    const db = openIndexDatabase(dbPath);
    try {
      // Insert three entries with different embeddings
      const id1 = insertTestEntry(db, "exact-match", {
        description: "Exact match entry",
        stashDir: "/test/stash",
      });
      const id2 = insertTestEntry(db, "partial-match", {
        description: "Partial match entry",
        stashDir: "/test/stash",
      });
      const id3 = insertTestEntry(db, "no-match", {
        description: "No match entry",
        stashDir: "/test/stash",
      });
      rebuildFts(db);

      // Embeddings with known cosine similarities to query [1, 0, 0, 0]:
      // exact-match: [1, 0, 0, 0] -> cosine = 1.0
      // partial-match: [0.707, 0.707, 0, 0] -> cosine ~ 0.707
      // no-match: [0, 0, 0, 1] -> cosine = 0.0
      upsertEmbedding(db, id1, [1, 0, 0, 0]);
      const partial = Math.SQRT1_2;
      upsertEmbedding(db, id2, [partial, partial, 0, 0]);
      upsertEmbedding(db, id3, [0, 0, 0, 1]);
      setMeta(db, "hasEmbeddings", "1");

      const queryVec = [1, 0, 0, 0];
      const results = searchVec(db, queryVec, 10);

      expect(results.length).toBe(3);

      // Results should be sorted by similarity descending (distance ascending)
      // searchVec converts cosine similarity to L2 distance:
      // For normalized vectors: L2 = sqrt(2 * (1 - cos_sim))
      const exactResult = results.find((r) => r.id === id1);
      const partialResult = results.find((r) => r.id === id2);
      const noMatchResult = results.find((r) => r.id === id3);

      expect(exactResult).toBeDefined();
      expect(partialResult).toBeDefined();
      expect(noMatchResult).toBeDefined();

      // exact match should have smallest distance
      expect(exactResult?.distance).toBeLessThan(partialResult?.distance ?? Number.POSITIVE_INFINITY);
      expect(partialResult?.distance).toBeLessThan(noMatchResult?.distance ?? Number.POSITIVE_INFINITY);

      // exact match distance should be ~0
      expect(exactResult?.distance).toBeCloseTo(0, 2);
      // no-match distance should be ~sqrt(2) ~ 1.414
      expect(noMatchResult?.distance).toBeCloseTo(Math.sqrt(2), 1);
    } finally {
      closeDatabase(db);
    }
  });

  test("searchVec returns empty array when no embeddings exist", () => {
    const dbPath = tmpDbPath("blob-empty");
    const db = openIndexDatabase(dbPath);
    try {
      insertTestEntry(db, "no-embed-entry", {
        description: "Entry without embedding",
        stashDir: "/test/stash",
      });
      rebuildFts(db);

      const results = searchVec(db, [1, 0, 0, 0], 10);
      expect(results).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  test("searchVec with k smaller than total results returns top-k", () => {
    const dbPath = tmpDbPath("blob-topk");
    const dim = 4;
    const db = openIndexDatabase(dbPath);
    try {
      // Insert 5 entries with embeddings
      const ids: number[] = [];
      for (let i = 0; i < 5; i++) {
        const id = insertTestEntry(db, `entry-${i}`, {
          description: `Entry number ${i}`,
          stashDir: "/test/stash",
        });
        // Each entry has a slightly different embedding direction
        const emb = [0, 0, 0, 0];
        emb[i % dim] = 1;
        upsertEmbedding(db, id, emb);
        ids.push(id);
      }
      rebuildFts(db);
      setMeta(db, "hasEmbeddings", "1");

      // Query for top 2 only
      const results = searchVec(db, [1, 0, 0, 0], 2);
      expect(results.length).toBe(2);
    } finally {
      closeDatabase(db);
    }
  });
});

// ── Test g: Dimension mismatch produces zero ───────────────────────────────

describe("Dimension mismatch produces zero similarity", () => {
  test("cosineSimilarity returns 0 for mismatched dimensions (384 vs 768)", () => {
    const vec384 = new Array(384).fill(1 / Math.sqrt(384));
    const vec768 = new Array(768).fill(1 / Math.sqrt(768));

    const similarity = cosineSimilarity(vec384, vec768);
    expect(similarity).toBe(0);
  });

  test("cosineSimilarity returns 0 for mismatched dimensions (small vectors)", () => {
    const vecA = [1, 0, 0];
    const vecB = [1, 0, 0, 0];

    const similarity = cosineSimilarity(vecA, vecB);
    expect(similarity).toBe(0);
  });

  test("cosineSimilarity returns correct value for matching dimensions", () => {
    // Same direction: cosine = 1.0
    const vecA = [1, 0, 0, 0];
    const vecB = [1, 0, 0, 0];
    expect(cosineSimilarity(vecA, vecB)).toBeCloseTo(1.0, 5);

    // Orthogonal: cosine = 0.0
    const vecC = [1, 0, 0, 0];
    const vecD = [0, 1, 0, 0];
    expect(cosineSimilarity(vecC, vecD)).toBeCloseTo(0.0, 5);

    // Opposite: cosine = -1.0
    const vecE = [1, 0, 0, 0];
    const vecF = [-1, 0, 0, 0];
    expect(cosineSimilarity(vecE, vecF)).toBeCloseTo(-1.0, 5);
  });

  test("cosineSimilarity returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  test("cosineSimilarity returns 0 for zero vectors", () => {
    const zero = [0, 0, 0, 0];
    expect(cosineSimilarity(zero, zero)).toBe(0);
  });

  test("searchVec skips a stored embedding whose width differs from the query's", () => {
    // Stored embeddings have 4 dims, the query 8: the row never matches.
    const dbPath = tmpDbPath("dim-mismatch");
    const db = openIndexDatabase(dbPath);
    try {
      const id = insertTestEntry(db, "small-emb", {
        description: "Entry with small embedding",
        stashDir: "/test/stash",
      });
      rebuildFts(db);

      // Store a 4-dim embedding
      upsertEmbedding(db, id, [1, 0, 0, 0]);
      setMeta(db, "hasEmbeddings", "1");

      // Query with an 8-dim vector (dimension mismatch)
      const queryVec8 = [1, 0, 0, 0, 0, 0, 0, 0];
      const results = searchVec(db, queryVec8, 10);

      expect(results).toEqual([]);
    } finally {
      closeDatabase(db);
    }
  });
});

// ── Targeted embedding selection ────────────────────────────────────────────

describe("targeted embedding selection", () => {
  test("queries only requested missing entry IDs", () => {
    const db = openIndexDatabase(tmpDbPath("targeted-selection"));
    try {
      const unrelatedId = insertTestEntry(db, "unrelated-missing");
      const targetId = insertTestEntry(db, "target-missing");

      expect(getAllEntriesForEmbedding(db, [targetId, targetId]).map((entry) => entry.id)).toEqual([targetId]);
      expect(getAllEntriesForEmbedding(db, [unrelatedId]).map((entry) => entry.id)).toEqual([unrelatedId]);
      expect(getAllEntriesForEmbedding(db, [])).toEqual([]);
    } finally {
      closeDatabase(db);
    }
  });
});

// ── End-to-end: L2-to-cosine conversion round-trip ─────────────────────────

describe("L2-to-cosine conversion round-trip", () => {
  test("searchVec distance converts correctly back to cosine similarity", () => {
    // A consumer recovers the cosine as:
    //   raw = 1 - (distance * distance) / 2
    // And searchVec does:
    //   distance = sqrt(2 * max(0, 1 - cosineSim))
    // These should be inverse operations for normalized vectors.
    const dbPath = tmpDbPath("roundtrip");
    const db = openIndexDatabase(dbPath);
    try {
      const id = insertTestEntry(db, "roundtrip-entry", {
        description: "Round-trip test entry",
        stashDir: "/test/stash",
      });
      rebuildFts(db);

      // Known cosine similarity: query=[1,0,0,0], stored=[0.6,0.8,0,0]
      // cos(query, stored) = 0.6
      upsertEmbedding(db, id, [0.6, 0.8, 0, 0]);
      setMeta(db, "hasEmbeddings", "1");

      const results = searchVec(db, [1, 0, 0, 0], 10);
      expect(results.length).toBe(1);

      const distance = results[0]!.distance;
      // Convert back: cosine = 1 - distance^2 / 2
      const recoveredCosine = 1 - (distance * distance) / 2;
      expect(recoveredCosine).toBeCloseTo(0.6, 1);
    } finally {
      closeDatabase(db);
    }
  });
});
