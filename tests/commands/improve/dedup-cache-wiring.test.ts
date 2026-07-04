// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Behavioral tests for the body_embeddings cache wiring in runDeterministicDedup
 * (WS-3a blocker fix).
 *
 * embedBatch is stubbed via the embedder module seam (_setEmbedderForTests),
 * installed per-test through overrideSeam (the preload restores it after each
 * test). We control behaviour via the mutable `embedBatchImpl` variable — each
 * test can point it at a fresh mock function to observe call counts. The real
 * `cosineSimilarity` is used.
 *
 * Two behavioral assertions:
 *   (a) Cache MISS → embedBatch is called + vectors are upserted into stateDb.
 *   (b) Cache HIT  → embedBatch is NOT called; the pre-seeded vector is reused.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { cacheHash, runDeterministicDedup } from "../../../src/commands/improve/dedup";
import type { AkmConfig } from "../../../src/core/config/config";
import { openStateDatabase } from "../../../src/core/state-db";
import { _setEmbedderForTests } from "../../../src/llm/embedder";
import { getBodyEmbeddings, upsertBodyEmbeddings } from "../../../src/storage/repositories/embeddings-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";
import { overrideSeam } from "../../_helpers/seams";

type EmbedBatchFn = (texts: string[], config?: unknown, signal?: AbortSignal) => Promise<number[][]>;

let embedBatchImpl: EmbedBatchFn = async (texts) => texts.map(() => [0.1, 0.2, 0.3]);

// ── Storage helpers ─────────────────────────────────────────────────────────

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  // Reset the stub to the default implementation.
  embedBatchImpl = async (texts) => texts.map(() => [0.1, 0.2, 0.3]);
  overrideSeam(_setEmbedderForTests, {
    embedBatch: (texts, config, signal) => embedBatchImpl(texts, config, signal),
    resolveEmbeddingModelId: () => "stub-model",
  });
});
afterEach(() => storage.cleanup());

function writeMemory(name: string, body: string): string {
  const memoriesDir = path.join(storage.stashDir, "memories");
  fs.mkdirSync(memoriesDir, { recursive: true });
  const content = `---\ndescription: ${name}\n---\n${body}\n`;
  const fp = path.join(memoriesDir, `${name}.md`);
  fs.writeFileSync(fp, content, "utf8");
  return fp;
}

/** Minimal AkmConfig with embedding configured so the cache-wiring branch fires. */
const withEmbedConfig = {
  embedding: { localModel: "stub-model" },
} as unknown as AkmConfig;

// ── Tests ───────────────────────────────────────────────────────────────────

describe("runDeterministicDedup — body_embeddings cache behavioral wiring (WS-3a)", () => {
  test("(a) cache MISS: embedBatch is called and vectors are upserted into stateDb", async () => {
    // Two distinct memories — no duplicates, so collapse = 0.
    // The point is to verify that embedBatch IS called and the returned vectors
    // end up in the body_embeddings table.
    writeMemory("alpha", "Distinct body content about topic A.");
    writeMemory("beta", "Completely different body content about topic B.");

    let callCount = 0;
    const capturedTexts: string[] = [];
    // Use orthogonal unit vectors so cosine similarity = 0 (no collapse).
    const orthoVecs = [
      [1, 0, 0],
      [0, 1, 0],
    ];
    embedBatchImpl = async (texts) => {
      callCount++;
      capturedTexts.push(...texts);
      return texts.map((_t, i) => orthoVecs[i] ?? [0, 0, 1]);
    };

    const dbPath = path.join(storage.dataDir, "state.db");
    const db = openStateDatabase(dbPath);
    try {
      const result = await runDeterministicDedup(
        storage.stashDir,
        { enabled: true, cosineThreshold: 0.99 }, // very high threshold → no cosine collapse
        withEmbedConfig,
        undefined,
        undefined,
        db,
      );

      // No actual duplicates, so collapsed = 0.
      expect(result.collapsed).toBe(0);

      // embedBatch must have been called exactly once (one batch for all memories).
      expect(callCount).toBe(1);
      // Both memories were embedded.
      expect(capturedTexts.length).toBe(2);

      // The vectors must now be in the cache.
      const alphaRaw = fs.readFileSync(path.join(storage.stashDir, "memories", "alpha.md"), "utf8");
      const betaRaw = fs.readFileSync(path.join(storage.stashDir, "memories", "beta.md"), "utf8");
      const hashes = [cacheHash(alphaRaw), cacheHash(betaRaw)];
      const cached = getBodyEmbeddings(db, hashes, "stub-model");
      expect(cached.size).toBe(2);
      expect(cached.has(hashes[0] as string)).toBe(true);
      expect(cached.has(hashes[1] as string)).toBe(true);
    } finally {
      db.close();
    }
  });

  test("(b) cache HIT: pre-seeded vectors are reused without calling embedBatch", async () => {
    // One memory — pre-seed its hash in the db before running dedup.
    const body = "Cached body content that should come from the db.";
    writeMemory("gamma", body);

    const dbPath = path.join(storage.dataDir, "state.db");
    const db = openStateDatabase(dbPath);
    try {
      // Pre-seed the cache for this memory's content_hash.
      const rawContent = fs.readFileSync(path.join(storage.stashDir, "memories", "gamma.md"), "utf8");
      const hash = cacheHash(rawContent);
      upsertBodyEmbeddings(db, [{ contentHash: hash, embedding: [0.9, 0.8, 0.7], modelId: "stub-model" }]);

      let callCount = 0;
      embedBatchImpl = async (texts) => {
        callCount++;
        return texts.map(() => [0.5, 0.5, 0.5]); // different vector — if used, it's a bug
      };

      const result = await runDeterministicDedup(
        storage.stashDir,
        { enabled: true, cosineThreshold: 0.99 },
        withEmbedConfig,
        undefined,
        undefined,
        db,
      );

      // Single memory → nothing to compare → no collapse.
      expect(result.collapsed).toBe(0);

      // embedBatch must NOT have been called (cache hit covers all memories).
      expect(callCount).toBe(0);

      // The cached vector must still be present and unchanged.
      const cached = getBodyEmbeddings(db, [hash], "stub-model");
      expect(cached.has(hash)).toBe(true);
      const vec = cached.get(hash) as number[];
      expect(vec[0]).toBeCloseTo(0.9, 6);
      expect(vec[1]).toBeCloseTo(0.8, 6);
    } finally {
      db.close();
    }
  });
});
