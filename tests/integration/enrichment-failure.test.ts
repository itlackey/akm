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
import { ConfigError } from "../../src/core/errors";
import { getConfigPath, getDbPath } from "../../src/core/paths";
import { akmIndex } from "../../src/indexer/indexer";
import { closeDatabase, openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { getAllEntries } from "../../src/storage/repositories/index-entries-repository";
import {
  type Cleanup,
  mutateScopedEnv,
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
let llmModels: string[] = [];
let llmAuthorizations: Array<string | null> = [];
let onLlmRequest: (() => void) | undefined;

const llmServer = Bun.serve({
  port: 0,
  async fetch(request) {
    llmCallCount++;
    llmAuthorizations.push(request.headers.get("authorization"));
    onLlmRequest?.();
    const payload = (await request.json()) as { model?: string };
    if (typeof payload.model === "string") llmModels.push(payload.model);
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
  llmModels = [];
  llmAuthorizations = [];
  onLlmRequest = undefined;
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

test("missing required symbolic credential aborts indexing without provider or enrichment-cache writes", async () => {
  const knowledgeDir = path.join(stashDir, "knowledge");
  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.writeFileSync(path.join(knowledgeDir, "thing.md"), "# Thing\n\nSome body prose about a thing.\n");

  saveConfig({
    semanticSearchMode: "off",
    engines: {
      index: {
        kind: "llm",
        endpoint: `http://localhost:${llmServer.port}/v1/chat/completions`,
        model: "test-model",
        apiKey: "$AKM_ENRICH_REQUIRED_KEY",
      },
    },
    index: { defaults: { engine: "index" }, metadataEnhance: { enabled: true } },
  });

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

test("each metadata-enrichment dispatch reads the credential current at that call; none is indexed", async () => {
  llmSucceeds = true;
  const knowledgeDir = path.join(stashDir, "knowledge");
  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.writeFileSync(path.join(knowledgeDir, "first.md"), "# First\n\nFirst generated body.\n");
  fs.writeFileSync(path.join(knowledgeDir, "second.md"), "# Second\n\nSecond generated body.\n");

  saveConfig({
    semanticSearchMode: "off",
    engines: {
      index: {
        kind: "llm",
        endpoint: `http://localhost:${llmServer.port}/v1/chat/completions`,
        model: "test-model",
        apiKey: "$AKM_ENRICH_ROTATING_KEY",
      },
    },
    index: { defaults: { engine: "index" }, metadataEnhance: { enabled: true } },
  });
  const secret = "enrichment-original-092";
  const rotated = "enrichment-rotated-092";
  onLlmRequest = () => {
    if (llmCallCount === 1) mutateScopedEnv("AKM_ENRICH_ROTATING_KEY", rotated);
  };

  await withEnv({ AKM_ENRICH_ROTATING_KEY: secret }, () => akmIndex({ stashDir, full: true }));

  expect(llmAuthorizations).toEqual([`Bearer ${secret}`, `Bearer ${rotated}`]);
  const db = openIndexDatabase(getDbPath());
  try {
    const entries = getAllEntries(db);
    expect(entries.filter((row) => row.entry.quality === "enriched")).toHaveLength(2);
    expect(JSON.stringify(entries)).not.toContain(secret);
    expect(JSON.stringify(entries)).not.toContain(rotated);
    const cacheCount = (db.prepare("SELECT COUNT(*) AS cnt FROM llm_enrichment_cache").get() as { cnt: number }).cnt;
    expect(cacheCount).toBe(2);
  } finally {
    closeDatabase(db);
  }
});

test("successful enrichment preserves the entry's indexed provenance", async () => {
  llmSucceeds = true;
  const knowledgeDir = path.join(stashDir, "knowledge");
  fs.mkdirSync(knowledgeDir, { recursive: true });
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
      metadataEnhance: { enabled: true },
    },
  });

  await akmIndex({ stashDir, full: true });

  const db = openIndexDatabase(getDbPath());
  try {
    const row = db
      .prepare(
        "SELECT item_ref AS itemRef, bundle_id AS bundleId, component_id AS componentId, " +
          "concept_id AS conceptId, adapter_id AS adapterId FROM entries WHERE file_path = ?",
      )
      .get(path.join(knowledgeDir, "thing.md")) as {
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

test("index freezes enrichment selection once and returns its structured notices", async () => {
  llmSucceeds = true;
  const knowledgeDir = path.join(stashDir, "knowledge");
  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.writeFileSync(path.join(knowledgeDir, "thing.md"), "# Thing\n\nSome body prose about a thing.\n");
  const modelsPath = path.join(path.dirname(getConfigPath()), "models.json");
  const writeModels = (model: string): void => {
    fs.writeFileSync(
      modelsPath,
      JSON.stringify({
        version: 1,
        aliases: { reasoning: { index: { model, inference: { effort: "high" } } } },
      }),
    );
  };
  writeModels("frozen-model");
  saveConfig({
    semanticSearchMode: "off",
    engines: {
      index: {
        kind: "llm",
        endpoint: `http://localhost:${llmServer.port}/v1/chat/completions`,
        model: "reasoning",
      },
    },
    index: { defaults: { engine: "index" }, metadataEnhance: { enabled: true } },
  });

  let mutatedAfterSummary = false;
  const result = await akmIndex({
    stashDir,
    full: true,
    onProgress: (event) => {
      if (event.phase !== "summary" || mutatedAfterSummary) return;
      mutatedAfterSummary = true;
      writeModels("mutated-model");
    },
  });

  expect(mutatedAfterSummary).toBe(true);
  expect(llmModels).toEqual(["frozen-model"]);
  expect(result.notices).toEqual([
    expect.objectContaining({
      code: "untranslated-field",
      adapter: "llm",
      field: "inference.effort",
    }),
  ]);
  expect(JSON.stringify(result.notices)).not.toContain("mutated-model");
});
