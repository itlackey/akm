// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #954: the embedding heartbeat now names the failed count too,
 * and is visible by default (not --verbose-only). A pure formatter is the
 * fast, timer-free way to pin its exact text — the real 15s `setInterval`
 * that calls it is exercised end-to-end elsewhere, not re-derived here.
 */

import { describe, expect, test } from "bun:test";
import { formatEmbeddingHeartbeat } from "../src/indexer/materialize-embeddings";

describe("formatEmbeddingHeartbeat (#954)", () => {
  test("names stored, total, and failed counts", () => {
    expect(formatEmbeddingHeartbeat(12, 100, 0)).toBe(
      "Still generating embeddings: 12/100 stored, 0 failed; waiting on embedding provider.",
    );
  });

  test("reflects a nonzero failed count", () => {
    expect(formatEmbeddingHeartbeat(3, 50, 7)).toBe(
      "Still generating embeddings: 3/50 stored, 7 failed; waiting on embedding provider.",
    );
  });
});
