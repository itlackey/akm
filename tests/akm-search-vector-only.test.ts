// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * VALUE-02 residual (issue #787): a test that deterministically forces
 * `akmSearch` down its vector-only match path — a hit with no lexical match
 * at all, surfaced purely from the units_vec side of `fuseByEntry`
 * (`rankingMode: "semantic"` in src/indexer/search/ranking.ts).
 *
 * The deterministic feature-hashing embedder
 * (src/llm/embedders/deterministic.ts) has no semantic understanding, so
 * "vector-only" cannot be forced by picking synonyms the way it could against
 * a real model. The mechanism used instead is the one structural difference
 * that always holds:
 *
 *   - FTS only returns rows whose indexed text actually contains a query
 *     token. A query whose tokens appear in NO entry matches nothing, in every
 *     variant `searchUnitsLexical` tries (exact AND, prefix, relaxed OR).
 *   - The vector path returns nearest NEIGHBOURS. It is not gated on token
 *     overlap at all (no minScore floor — index-redesign B5c deleted it, and
 *     the units path never had a semantic-only floor to begin with), so it
 *     still ranks the only indexed entry.
 *
 * So: index exactly one entry, query tokens that appear nowhere in it, and the
 * only thing that can produce a hit is the vector path.
 *
 * This originally worked by a different route — 16 filler tokens plus a 17th,
 * exploiting `MAX_LEXICAL_QUERY_TOKENS = 16` to push the real token out of the
 * FTS query. That cap has since been deleted for silently truncating user
 * queries, and a test should not have depended on an arbitrary constraint in
 * the first place: it made the constraint harder to remove, which is exactly
 * backwards. The mechanism above rests on what FTS and vector search
 * fundamentally are, so nothing about it can be tuned away.
 *
 * Verified for real: run against a deliberately disabled vector path, the
 * assertion fails; restored, it passes.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmSearch } from "../src/commands/read/search";
import { saveConfig } from "../src/core/config/config";
import { akmIndex } from "../src/indexer/indexer";
import { withIsolatedAkmStorage } from "./_helpers/sandbox";

/** The sole indexed entry's content. Appears in no query this test runs. */
const TARGET_TOKEN = "qzorbnitkelvin";
/** Tokens that appear in NO indexed entry, so every FTS variant misses. */
const QUERY = ["qfillerazq", "qfillerbzq", "qfillerczq"].join(" ");

describe("akmSearch: vector-only match path (VALUE-02)", () => {
  test("a query matching no indexed token still surfaces a vector-only hit", async () => {
    const storage = withIsolatedAkmStorage({ AKM_EMBED_DETERMINISTIC: "1" });
    try {
      const knowledgeFile = path.join(storage.stashDir, "knowledge", "target.md");
      fs.mkdirSync(path.dirname(knowledgeFile), { recursive: true });
      fs.writeFileSync(knowledgeFile, `---\ndescription: ${TARGET_TOKEN}\n---\n${TARGET_TOKEN}\n`, "utf8");

      saveConfig({
        semanticSearchMode: "auto",
        bundles: { stash: { path: storage.stashDir } },
        defaultBundle: "stash",
        registries: [],
      });
      await akmIndex({ stashDir: storage.stashDir, full: true });

      // Control: with semantic search off, this query must find nothing —
      // proving FTS genuinely cannot match it, so any hit in the hybrid run
      // below came from the vector path and not from lexical retrieval.
      saveConfig({
        semanticSearchMode: "off",
        bundles: { stash: { path: storage.stashDir } },
        defaultBundle: "stash",
        registries: [],
      });
      const ftsOnly = await akmSearch({ query: QUERY, skipLogging: true });
      expect(ftsOnly.hits.some((hit) => "path" in hit && hit.path === knowledgeFile)).toBe(false);

      // With semantic search back on, the vector path must surface the entry
      // purely as a nearest neighbour — a genuine vector-only hit.
      saveConfig({
        semanticSearchMode: "auto",
        bundles: { stash: { path: storage.stashDir } },
        defaultBundle: "stash",
        registries: [],
      });
      const hybrid = await akmSearch({ query: QUERY, skipLogging: true });
      const hit = hybrid.hits.find((h) => "path" in h && h.path === knowledgeFile);
      expect(hit).toBeDefined();
      // `rankingMode: "semantic"` (vector-only, no FTS match) is the only
      // ranking mode that produces this exact reason string
      // (buildWhyMatched in src/indexer/search/db-search.ts).
      expect(hit?.whyMatched).toContain("semantic similarity");
    } finally {
      storage.cleanup();
    }
  });
});
