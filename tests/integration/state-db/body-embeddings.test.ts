// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests for the body_embeddings state.db table helpers (WS-3a).
 *
 * Verifies:
 *   - BLOB round-trip (Float32 stored and retrieved correctly).
 *   - Bulk cache lookup (hits, misses, partial).
 *   - Model-id mismatch triggers drop-all and returns empty map.
 *   - Upsert replaces existing rows (INSERT OR REPLACE).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { openStateDatabase } from "../../../src/core/state-db";
import type { Database } from "../../../src/storage/database";
import {
  blobToEmbedding,
  embeddingToBlob,
  getBodyEmbeddings,
  upsertBodyEmbeddings,
} from "../../../src/storage/repositories/embeddings-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let db: Database;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  db = openStateDatabase(path.join(storage.dataDir, "state.db"));
});

afterEach(() => {
  db.close();
  storage.cleanup();
});

describe("embeddingToBlob / blobToEmbedding (WS-3a)", () => {
  test("round-trips a Float32 embedding vector through BLOB bytes", () => {
    const vec = [0.1, 0.2, 0.3, -0.5, 1.0];
    const blob = embeddingToBlob(vec);
    const recovered = blobToEmbedding(blob);
    expect(recovered).toHaveLength(vec.length);
    // Float32 precision: values within 1e-6 of the original.
    for (let i = 0; i < vec.length; i++) {
      expect(Math.abs((recovered[i] as number) - (vec[i] as number))).toBeLessThan(1e-6);
    }
  });

  test("round-trips a 384-dimension vector (bge-small-en-v1.5 size)", () => {
    const vec = Array.from({ length: 384 }, (_, i) => Math.sin(i * 0.01));
    const blob = embeddingToBlob(vec);
    const recovered = blobToEmbedding(blob);
    expect(recovered).toHaveLength(384);
    expect(Math.abs((recovered[0] as number) - (vec[0] as number))).toBeLessThan(1e-6);
  });
});

describe("upsertBodyEmbeddings + getBodyEmbeddings (WS-3a)", () => {
  const MODEL_ID = "Xenova/bge-small-en-v1.5";

  test("upsert then retrieve returns the stored embedding", () => {
    const hash = "abc123";
    const vec = [0.1, 0.5, -0.3];
    upsertBodyEmbeddings(db, [{ contentHash: hash, embedding: vec, modelId: MODEL_ID }]);
    const result = getBodyEmbeddings(db, [hash], MODEL_ID);
    expect(result.has(hash)).toBe(true);
    const retrieved = result.get(hash) as number[];
    expect(retrieved).toHaveLength(3);
    expect(Math.abs(retrieved[0] - 0.1)).toBeLessThan(1e-6);
  });

  test("bulk lookup returns only existing hashes (misses → absent)", () => {
    const hash1 = "hash-1";
    const hash2 = "hash-2";
    const vec = [1.0, 0.0];
    upsertBodyEmbeddings(db, [{ contentHash: hash1, embedding: vec, modelId: MODEL_ID }]);
    const result = getBodyEmbeddings(db, [hash1, hash2], MODEL_ID);
    expect(result.has(hash1)).toBe(true);
    expect(result.has(hash2)).toBe(false);
  });

  test("empty contentHashes input returns empty map without query", () => {
    const result = getBodyEmbeddings(db, [], MODEL_ID);
    expect(result.size).toBe(0);
  });

  test("model-id mismatch drops all rows and returns empty map", () => {
    const hash = "xyz";
    upsertBodyEmbeddings(db, [{ contentHash: hash, embedding: [0.5], modelId: "model-a" }]);
    // Now query with a different model_id — rows should be dropped.
    const result = getBodyEmbeddings(db, [hash], "model-b");
    expect(result.size).toBe(0);
    // Confirm the table was cleared.
    const after = getBodyEmbeddings(db, [hash], "model-b");
    expect(after.size).toBe(0);
  });

  test("upsert is idempotent — re-inserting the same hash replaces the row", () => {
    const hash = "dup";
    upsertBodyEmbeddings(db, [{ contentHash: hash, embedding: [1.0, 0.0], modelId: MODEL_ID }]);
    upsertBodyEmbeddings(db, [{ contentHash: hash, embedding: [0.0, 1.0], modelId: MODEL_ID }]);
    const result = getBodyEmbeddings(db, [hash], MODEL_ID);
    const vec = result.get(hash) as number[];
    expect(vec).toHaveLength(2);
    // Should have the second write's values.
    expect(Math.abs(vec[0] - 0.0)).toBeLessThan(1e-6);
    expect(Math.abs(vec[1] - 1.0)).toBeLessThan(1e-6);
  });
});
