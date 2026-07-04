// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test } from "bun:test";
import { clearEmbeddingCache, getCachedEmbedding, setCachedEmbedding } from "../src/llm/embedders/cache";

/**
 * The embedding cache is a module-level LRU (capacity 100). These tests pin
 * the eviction contract, including the regression where overwriting an
 * already-present key at capacity evicted an unrelated oldest entry.
 */
describe("embedding cache LRU eviction", () => {
  const CAP = 100;

  afterEach(() => clearEmbeddingCache());

  function fill(n: number): void {
    for (let i = 0; i < n; i++) setCachedEmbedding(`k${i}`, [i]);
  }

  test("evicts the oldest entry when a NEW key is inserted at capacity", () => {
    fill(CAP); // k0..k99
    setCachedEmbedding("k100", [100]); // new key → oldest (k0) evicted
    expect(getCachedEmbedding("k0")).toBeUndefined();
    expect(getCachedEmbedding("k100")).toEqual([100]);
    expect(getCachedEmbedding("k99")).toEqual([99]);
  });

  test("overwriting an EXISTING key at capacity does NOT evict another entry", () => {
    fill(CAP); // k0..k99, k0 is the oldest
    // Overwrite an existing key. A Map.set on an existing key does not grow the
    // map, so nothing should be evicted — k0 must survive.
    setCachedEmbedding("k50", [500]);
    expect(getCachedEmbedding("k0")).toEqual([0]);
    expect(getCachedEmbedding("k50")).toEqual([500]);
  });

  test("re-inserting an existing key refreshes its LRU recency", () => {
    fill(CAP); // k0 oldest
    setCachedEmbedding("k0", [0]); // touch k0 → now most-recently-used
    setCachedEmbedding("k100", [100]); // new key evicts the now-oldest (k1)
    expect(getCachedEmbedding("k0")).toEqual([0]); // survived
    expect(getCachedEmbedding("k1")).toBeUndefined(); // evicted instead
  });

  test("getCachedEmbedding promotes an entry so it survives the next eviction", () => {
    fill(CAP); // k0 oldest
    getCachedEmbedding("k0"); // promote k0 to MRU
    setCachedEmbedding("k100", [100]); // evicts k1 (new oldest), not k0
    expect(getCachedEmbedding("k0")).toEqual([0]);
    expect(getCachedEmbedding("k1")).toBeUndefined();
  });
});
