// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #955/#956: `decideEmbeddingCompatibility` is the pure decision function
 * (and the single similarity computation, #956) behind the embedding-
 * fingerprint canary — given pairs of (stored vector, freshly re-embedded
 * vector) it decides whether the stored index survives an `embedding.model`
 * string change or must be purged and rebuilt, or whether the sample was too
 * thin/broken to trust either verdict. Pure/in-memory, no database — belongs
 * under tests/, not tests/integration/.
 */

import { describe, expect, test } from "bun:test";
import { decideEmbeddingCompatibility, type EmbeddingCanaryPair } from "../src/indexer/materialize-embeddings";

function pair(stored: number[], fresh: number[] | undefined): EmbeddingCanaryPair {
  return { stored, fresh };
}

describe("decideEmbeddingCompatibility", () => {
  test("keeps when every pair is (near-)identical", () => {
    const pairs = [pair([1, 0, 0], [1, 0, 0]), pair([0, 1, 0], [0, 1, 0]), pair([0, 0, 1], [0, 0, 1])];
    expect(decideEmbeddingCompatibility(pairs).outcome).toBe("keep");
  });

  test("keeps at median >= 0.999 even with one bad pair among many good ones", () => {
    // 7 near-identical pairs and 1 wildly different pair — the median still
    // clears the threshold, so one stale/edited sample does not discard an
    // otherwise-compatible index.
    const good = Array.from({ length: 7 }, () => pair([1, 0, 0], [1, 0, 0]));
    const bad = pair([1, 0, 0], [0, 1, 0]);
    expect(decideEmbeddingCompatibility([...good, bad]).outcome).toBe("keep");
  });

  test("rebuilds on genuinely low similarity (a different model)", () => {
    const pairs = [pair([1, 0, 0], [0, 1, 0]), pair([0, 1, 0], [1, 0, 0]), pair([0, 0, 1], [1, 0, 0])];
    expect(decideEmbeddingCompatibility(pairs).outcome).toBe("rebuild");
  });

  test("rebuilds on a dimension mismatch on a successful re-embed (cosineSimilarity's own 0-on-mismatch guard)", () => {
    const pairs = [pair([1, 0, 0], [1, 0, 0, 0]), pair([0, 1, 0], [0, 1, 0, 0])];
    const decision = decideEmbeddingCompatibility(pairs);
    expect(decision.outcome).toBe("rebuild");
    // Both samples DID re-embed (fresh is defined) — a dimension mismatch on
    // a successful re-embed is genuine evidence, not an excluded failure.
    expect(decision.verifiedSamples).toBe(2);
  });

  test("rebuilds when the median of an even number of pairs falls short", () => {
    // Median of two similarities straddling the threshold from below.
    const pairs = [pair([1, 0], [1, 0]), pair([1, 0], [0, 1])];
    expect(decideEmbeddingCompatibility(pairs).outcome).toBe("rebuild");
  });

  test("an empty sample keeps — nothing to verify, nothing to lose", () => {
    const decision = decideEmbeddingCompatibility([]);
    expect(decision.outcome).toBe("keep");
    expect(decision.medianSimilarity).toBeUndefined();
    expect(decision.verifiedSamples).toBe(0);
  });

  describe("a failed re-embed is excluded from the median, not scored as zero (#956)", () => {
    test("half the sample failing to re-embed is too thin to trust either verdict: unverifiable", () => {
      const pairs = [
        pair([1, 0, 0], [1, 0, 0]),
        pair([1, 0, 0], [1, 0, 0]),
        pair([1, 0, 0], undefined),
        pair([1, 0, 0], undefined),
      ];
      const decision = decideEmbeddingCompatibility(pairs);
      expect(decision.outcome).toBe("unverifiable");
      expect(decision.verifiedSamples).toBe(2);
      expect(decision.medianSimilarity).toBeUndefined();
    });

    test("one failed sample of eight, the rest near-identical: keeps, excluding the failure from the median", () => {
      const pairs = [...Array.from({ length: 7 }, () => pair([1, 0, 0], [1, 0, 0])), pair([1, 0, 0], undefined)];
      const decision = decideEmbeddingCompatibility(pairs);
      expect(decision.outcome).toBe("keep");
      expect(decision.verifiedSamples).toBe(7);
      // A failed sample must not drag a healthy median down — with it
      // excluded (rather than scored 0) the median is a clean 1.0.
      expect(decision.medianSimilarity).toBe(1);
    });

    test("a majority (3 of 5) succeeding still verifies on what did succeed", () => {
      const pairs = [
        pair([1, 0, 0], [1, 0, 0]),
        pair([1, 0, 0], [1, 0, 0]),
        pair([1, 0, 0], [1, 0, 0]),
        pair([1, 0, 0], undefined),
        pair([1, 0, 0], undefined),
      ];
      const decision = decideEmbeddingCompatibility(pairs);
      expect(decision.outcome).toBe("keep");
      expect(decision.verifiedSamples).toBe(3);
    });
  });
});
