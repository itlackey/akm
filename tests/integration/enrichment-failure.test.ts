// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Regression lock for the enrichment "success after failure" bug, restored
 * on the reconcile path (index-redesign B5e).
 *
 * When the metadata-enhance LLM call fails (here: the endpoint returns HTTP
 * 500), the indexer must NOT mark the entry `quality: "enriched"` and must NOT
 * write an `llm_enrichment_cache` row — otherwise a transient outage would
 * poison the entry into a PERMANENT enrichment skip (the cache would report the
 * body already enriched on every later run) even though nothing was enhanced.
 *
 * Drives the real `akmIndex` path (not a private enrichment helper) with
 * `semanticSearchMode: "off"` so no embedding work runs, and points the index
 * engine at a local server whose response this file controls per test.
 *
 * index-redesign B5e note: `akm index`'s reconcile rewrite (`cec41361`)
 * dropped the call site this file exercised (and this file with it, in
 * `396edcc9`); `src/indexer/enrich.ts` restores it on the new reconcile path.
 * The cache is now keyed by content (`asset_ref = body_hash = blobHash`, see
 * `enrich.ts`'s module doc) rather than by the entry's canonical `item_ref` —
 * this file's assertions do not depend on the key shape, only on whether a
 * cache row exists at all, so they carry over unchanged. Two tests from the
 * pre-redesign version of this file are intentionally NOT restored: the
 * credential-lease test (the new pass has no cross-candidate lease — each
 * candidate resolves its own credential independently) and the
 * "freezes enrichment selection" notices test (the old directory-batched
 * pass surfaced `LoweringNotice`s on `IndexResponse.notices`; the new
 * per-blob-hash pass does not thread them onto the response). A fourth test
 * new to this file proves the point of keying the cache by content: a cache
 * hit re-applies cached metadata under `--full` with no new provider call.
 */
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../src/core/config/config";
import { ConfigError } from "../../src/core/errors";
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
  withEnv,
} from "../_helpers/sandbox";

let stashDir = "";
let cleanup: Cleanup = () => {};
let llmCallCount = 0;
let llmSucceeds = false;

const llmServer = Bun.serve({
  port: 0,
  async fetch(request) {
    llmCallCount++;
    await request.json(); // drain the body; the handler does not need its contents
    if (llmSucceeds) {
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                description: "Enriched thing",
                searchHints: ["find the enriched thing"],
                tags: ["enriched"],
              }),
            },
          },
        ],
      });
    }
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
  llmSucceeds = false;
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  llmServer.stop(true);
});

function writeThing(): string {
  const knowledgeDir = path.join(stashDir, "knowledge");
  fs.mkdirSync(knowledgeDir, { recursive: true });
  const filePath = path.join(knowledgeDir, "thing.md");
  fs.writeFileSync(filePath, "# Thing\n\nSome body prose about a thing.\n");
  return filePath;
}

function configureEngine(apiKey?: string): void {
  saveConfig({
    semanticSearchMode: "off",
    engines: {
      index: {
        kind: "llm",
        endpoint: `http://localhost:${llmServer.port}/v1/chat/completions`,
        model: "test-model",
        ...(apiKey ? { apiKey } : {}),
      },
    },
    index: {
      defaults: { engine: "index" },
      // Open the metadata_enhance feature gate so the enrichment call actually
      // runs.
      metadataEnhance: { enabled: true },
    },
  });
}

test("failed enrichment does not mark the entry enriched or poison the cache", async () => {
  writeThing();
  configureEngine();

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

test("missing required symbolic credential aborts indexing without provider or enrichment-cache writes", async () => {
  writeThing();
  configureEngine("$AKM_ENRICH_REQUIRED_KEY");

  const failure = withEnv({ AKM_ENRICH_REQUIRED_KEY: undefined }, () => akmIndex({ stashDir, full: true }));
  await expect(failure).rejects.toBeInstanceOf(ConfigError);
  await expect(failure).rejects.toMatchObject({ code: "INVALID_CONFIG_FILE" });
  expect(llmCallCount).toBe(0);

  const db = openIndexDatabase(getDbPath());
  try {
    const cacheCount = (db.prepare("SELECT COUNT(*) AS cnt FROM llm_enrichment_cache").get() as { cnt: number }).cnt;
    expect(cacheCount).toBe(0);
    const thing = getAllEntries(db).find((entry) => entry.entry.name === "thing");
    expect(thing?.entry.quality).not.toBe("enriched");
  } finally {
    closeDatabase(db);
  }
});

test("successful enrichment preserves the entry's indexed provenance", async () => {
  llmSucceeds = true;
  const filePath = writeThing();
  configureEngine();

  await akmIndex({ stashDir, full: true });

  const db = openIndexDatabase(getDbPath());
  try {
    const row = db
      .prepare(
        "SELECT item_ref AS itemRef, bundle_id AS bundleId, component_id AS componentId, " +
          "concept_id AS conceptId, adapter_id AS adapterId FROM entries WHERE file_path = ?",
      )
      .get(filePath) as {
      itemRef: string;
      bundleId: string;
      componentId: string;
      conceptId: string;
      adapterId: string;
    };
    expect(row.itemRef).toBe(`${row.bundleId}//knowledge/thing`);
    expect(row.componentId).toBe(row.bundleId);
    expect(row.conceptId).toBe("knowledge/thing");
    expect(row.adapterId).toBe("akm");
  } finally {
    closeDatabase(db);
  }
});

test("a cache hit re-applies cached enrichment under --full with no new provider call", async () => {
  llmSucceeds = true;
  writeThing();
  configureEngine();

  await akmIndex({ stashDir, full: true });
  expect(llmCallCount).toBe(1);

  const db = openIndexDatabase(getDbPath());
  try {
    const thing = getAllEntries(db).find((entry) => entry.entry.name === "thing");
    expect(thing?.entry.quality).toBe("enriched");
    expect(thing?.entry.description).toBe("Enriched thing");
    const cacheCount = (db.prepare("SELECT COUNT(*) AS cnt FROM llm_enrichment_cache").get() as { cnt: number }).cnt;
    expect(cacheCount).toBe(1);
  } finally {
    closeDatabase(db);
  }

  // The file on disk is untouched (enrichment only ever wrote the DB row), so
  // `--full` re-parses it to `quality: "generated"` again and it becomes an
  // enrichment candidate again — but its blob hash is unchanged, so the
  // content-addressed cache lookup hits and no new provider call happens.
  await akmIndex({ stashDir, full: true });
  expect(llmCallCount).toBe(1);

  const db2 = openIndexDatabase(getDbPath());
  try {
    const thing = getAllEntries(db2).find((entry) => entry.entry.name === "thing");
    expect(thing?.entry.quality).toBe("enriched");
    expect(thing?.entry.description).toBe("Enriched thing");
    expect(thing?.entry.tags).toEqual(["enriched"]);
    const cacheCount = (db2.prepare("SELECT COUNT(*) AS cnt FROM llm_enrichment_cache").get() as { cnt: number }).cnt;
    expect(cacheCount).toBe(1);
  } finally {
    closeDatabase(db2);
  }
});
