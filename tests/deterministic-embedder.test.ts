// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import {
  DETERMINISTIC_EMBED_DIM,
  deterministicEmbed,
  isDeterministicEmbedEnabled,
} from "../src/llm/embedders/deterministic";
import { cosineSimilarity } from "../src/llm/embedders/types";

describe("deterministicEmbed", () => {
  test("is the right width and L2-normalized", () => {
    const v = deterministicEmbed("docker homelab release coordination");
    expect(v.length).toBe(DETERMINISTIC_EMBED_DIM);
    const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  test("is deterministic — identical text yields byte-identical vectors", () => {
    const a = deterministicEmbed("coordinate a multi package release");
    const b = deterministicEmbed("coordinate a multi package release");
    expect(a).toEqual(b);
  });

  test("shared vocabulary ⇒ higher cosine similarity than disjoint vocabulary", () => {
    const query = deterministicEmbed("deploy docker compose in a homelab");
    const related = deterministicEmbed("docker compose homelab deployment guide");
    const unrelated = deterministicEmbed("quarterly marketing newsletter analytics");
    expect(cosineSimilarity(query, related)).toBeGreaterThan(cosineSimilarity(query, unrelated));
  });

  test("empty / token-less input returns a stable non-zero unit vector (NaN guard)", () => {
    const v = deterministicEmbed("   !!!   ");
    const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
    expect(v.some((x) => Number.isNaN(x))).toBe(false);
  });

  test("golden fingerprint — the embedding axis is frozen (drift guard)", () => {
    // This pins deterministicEmbed's output for a fixed set of strings. It is
    // the "golden vectors" artifact in lean form: the curate bench holds the
    // embedding axis constant so score deltas between akm versions reflect
    // SOURCE changes, not embedder drift. If this hash changes, the embedder
    // changed and ALL historical curate-bench numbers are now incomparable —
    // re-baseline them deliberately, then update this fingerprint.
    const STRINGS = [
      "deploy docker compose services in my homelab",
      "coordinate a multi package release across repos with changelog",
      "write reliable deterministic tests",
      "git branching and pull request workflow",
      "the docker",
      "",
      "!!!",
      "Docker Homelab deploy compose containers volumes networks",
    ];
    const h = crypto.createHash("sha256");
    for (const s of STRINGS) {
      h.update(
        deterministicEmbed(s)
          .map((x) => x.toFixed(6))
          .join(","),
      );
      h.update("|");
    }
    expect(h.digest("hex")).toBe("25bc7eaf8b43d5db2ef490b246268394d0623e294f85f2b865a26246ba7a704e");
  });

  test("isDeterministicEmbedEnabled reflects the env flag", () => {
    const prev = process.env.AKM_EMBED_DETERMINISTIC;
    try {
      process.env.AKM_EMBED_DETERMINISTIC = "1";
      expect(isDeterministicEmbedEnabled()).toBe(true);
      process.env.AKM_EMBED_DETERMINISTIC = "0";
      expect(isDeterministicEmbedEnabled()).toBe(false);
      delete process.env.AKM_EMBED_DETERMINISTIC;
      expect(isDeterministicEmbedEnabled()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.AKM_EMBED_DETERMINISTIC;
      else process.env.AKM_EMBED_DETERMINISTIC = prev;
    }
  });
});
