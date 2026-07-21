// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Regression lock for the enrichment "success after failure" bug.
 *
 * When the metadata-enhance LLM call fails (here: the endpoint returns HTTP
 * 500), the indexer must NOT mark the entry `quality: "enriched"` and must NOT
 * write an `llm_enrichment_cache` row — otherwise a transient outage would
 * poison the entry into a PERMANENT enrichment skip (the cache would report the
 * body already enriched on every later run) even though nothing was enhanced.
 *
 * Drives the real `akmIndex` path (not the private enrichment helper) with
 * `semanticSearchMode: "off"` so no embedding work runs, and points the index
 * engine at a local server that always 500s.
 */
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../src/core/config/config";
import { getDbPath } from "../../src/core/paths";
import { akmIndex } from "../../src/indexer/indexer";
import { closeDatabase, openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { getAllEntries } from "../../src/storage/repositories/index-entries-repository";
import {
  type Cleanup,
  sandboxEnvDir,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
} from "../_helpers/sandbox";

let stashDir = "";
let cleanup: Cleanup = () => {};
let llmCallCount = 0;

const llmServer = Bun.serve({
  port: 0,
  fetch() {
    llmCallCount++;
    return new Response("Internal Server Error", { status: 500, headers: { Connection: "close" } });
  },
});

beforeEach(() => {
  const stash = sandboxStashDir();
  stashDir = stash.dir;
  let chain = sandboxXdgConfigHome(stash.cleanup).cleanup;
  chain = sandboxXdgCacheHome(chain).cleanup;
  chain = sandboxEnvDir("akm-enrich-fail-data", "AKM_DATA_DIR", chain).cleanup;
  chain = sandboxEnvDir("akm-enrich-fail-state", "AKM_STATE_DIR", chain).cleanup;
  cleanup = chain;
  llmCallCount = 0;
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  llmServer.stop(true);
});

test("failed enrichment does not mark the entry enriched or poison the cache", async () => {
  const knowledgeDir = path.join(stashDir, "knowledge");
  fs.mkdirSync(knowledgeDir, { recursive: true });
  // A bare markdown asset with no curated frontmatter → quality "generated" and
  // incomplete metadata, so it is eligible for LLM enrichment.
  fs.writeFileSync(path.join(knowledgeDir, "thing.md"), "# Thing\n\nSome body prose about a thing.\n");

  saveConfig({
    semanticSearchMode: "off",
    engines: {
      index: {
        kind: "llm",
        endpoint: `http://localhost:${llmServer.port}/v1/chat/completions`,
        model: "test-model",
      },
    },
    index: {
      defaults: { engine: "index" },
      // Open the metadata_enhance feature gate so the enrichment call actually
      // runs (and then fails against the 500 server).
      metadataEnhance: { enabled: true },
    },
  });

  await akmIndex({ stashDir, full: true });

  // The enrichment call must have been ATTEMPTED (this is the failed path, not
  // the gated-off skip path).
  expect(llmCallCount).toBeGreaterThan(0);

  const db = openIndexDatabase(getDbPath());
  try {
    const entries = getAllEntries(db);
    const thing = entries.find((e) => e.entry.name === "thing");
    expect(thing).toBeDefined();
    // A failed enrichment must leave the entry at its generated quality.
    expect(thing?.entry.quality).not.toBe("enriched");
    expect(thing?.entry.quality).toBe("generated");

    // And the cache must be empty — a failed call must not write an entry that
    // would make every later run skip re-enrichment.
    const cacheCount = (db.prepare("SELECT COUNT(*) AS cnt FROM llm_enrichment_cache").get() as { cnt: number }).cnt;
    expect(cacheCount).toBe(0);
  } finally {
    closeDatabase(db);
  }
});
