// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Locks that search-mode telemetry (`mode: "semantic" | "keyword"`) reflects
 * whether the vector search ACTUALLY executed, carried out as an explicit flag
 * from the search execution — NOT inferred from elapsed embedding milliseconds.
 *
 * The previous heuristic (`embedMs > 0 ? "semantic" : "keyword"`) reported
 * "semantic" for keyword-only searches, because `embedMs` timed the FTS work
 * that runs concurrently with the (short-circuited) embedding request. These
 * tests run keyword-only searches — where FTS does real work but no vector
 * search runs — and assert the mode is honestly "keyword".
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../../../src/core/config/config";
import { saveConfig } from "../../../src/core/config/config";
import { akmIndex } from "../../../src/indexer/indexer";
import { searchLocal } from "../../../src/indexer/search/db-search";
import {
  type Cleanup,
  sandboxEnvDir,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
} from "../../_helpers/sandbox";

let stashDir = "";
let cleanup: Cleanup = () => {};

function runSearch(config: AkmConfig) {
  return searchLocal({
    query: "deploy",
    searchType: "any",
    limit: 5,
    stashDir,
    sources: [{ path: stashDir }],
    config,
  });
}

beforeEach(async () => {
  const stash = sandboxStashDir();
  stashDir = stash.dir;
  let chain = sandboxXdgConfigHome(stash.cleanup).cleanup;
  chain = sandboxXdgCacheHome(chain).cleanup;
  chain = sandboxEnvDir("akm-search-mode-data", "AKM_DATA_DIR", chain).cleanup;
  chain = sandboxEnvDir("akm-search-mode-state", "AKM_STATE_DIR", chain).cleanup;
  cleanup = chain;
  const knowledgeDir = path.join(stashDir, "knowledge");
  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.writeFileSync(
    path.join(knowledgeDir, "deploy.md"),
    "---\ndescription: deploy an application to production\n---\n\n# deploy\n\nDeploy an application.\n",
    "utf8",
  );
  // Build the index with semantic search off — FTS only, no embeddings — so the
  // vector scorer deterministically has nothing to search (hasEmbeddings != 1),
  // independent of whether a local embedding model is available in this env.
  saveConfig({ semanticSearchMode: "off" });
  await akmIndex({ stashDir });
});

afterEach(() => {
  cleanup();
});

describe("search-mode telemetry", () => {
  test("keyword-only search (semanticSearchMode off) reports mode 'keyword'", async () => {
    const result = await runSearch({ semanticSearchMode: "off" });
    // FTS matched the query, so this did real work — but no vector search ran.
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.mode).toBe("keyword");
  });

  test("auto mode without a built semantic index still reports mode 'keyword'", async () => {
    // semanticSearchMode 'auto' but no embeddings were generated — the vector
    // scorer short-circuits (returns null) because hasEmbeddings != 1, so the
    // mode must be keyword, not inferred from how long the concurrent FTS work
    // took.
    const result = await runSearch({ semanticSearchMode: "auto" });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.mode).toBe("keyword");
  });
});
