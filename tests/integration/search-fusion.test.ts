// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Opens a real index.db: the fused search pipeline end to end over a
// hand-built index with 4-dimension vectors and a stubbed query embedder.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { akmCurate } from "../../src/commands/read/curate";
import { type AkmConfig, resetConfigCache, saveConfig } from "../../src/core/config/config";
import { getDbPath } from "../../src/core/paths";
import { deriveEntryProvenance } from "../../src/indexer/installations";
import type { IndexDocument } from "../../src/indexer/passes/metadata";
import { searchLocal } from "../../src/indexer/search/db-search";
import { RRF_K } from "../../src/indexer/search/ranking";
import { buildSearchText } from "../../src/indexer/search/search-fields";
import { _setEmbedderForTests } from "../../src/llm/embedder";
import type { Database } from "../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../src/storage/repositories/index-entries-repository";
import { setMeta } from "../../src/storage/repositories/index-meta-repository";
import { upsertEmbedding } from "../../src/storage/repositories/index-vec-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, withMockedFetch } from "../_helpers/sandbox";
import { overrideSeam } from "../_helpers/seams";

const REMOTE_QWEN3 = {
  endpoint: "http://127.0.0.1:9/v1/embeddings",
  model: "embed/qwen3-embedding-0.6b",
  dimension: 4,
};

let storage: IsolatedAkmStorage;
let db: Database;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  db = openIndexDatabase(getDbPath(), { embeddingDim: 4 });
  // Satisfies ensure-index's indexCanServeStash() so searchLocal serves this
  // hand-built index instead of rebuilding it from the (empty) stash.
  setMeta(db, "stashDir", storage.stashDir);
});

afterEach(() => {
  closeDatabase(db);
  storage.cleanup();
});

function put(name: string, fields: Partial<IndexDocument>, vector: number[], filePath?: string): void {
  const entry: IndexDocument = { name, type: "knowledge", ...fields };
  const id = upsertEntry(
    db,
    filePath ?? `/fixture/knowledge/${name}.md`,
    entry,
    buildSearchText(entry),
    deriveEntryProvenance({ bundleId: "stash", componentId: "stash", adapterId: "akm" }, "knowledge", name),
  );
  upsertEmbedding(db, id, vector);
}

function search(query: string, config: AkmConfig = { semanticSearchMode: "auto", embedding: REMOTE_QWEN3 }) {
  return searchLocal({
    query,
    searchType: "any",
    limit: 10,
    stashDir: storage.stashDir,
    sources: [{ path: storage.stashDir }],
    config,
  });
}

describe("fused search", () => {
  test("ranks by reciprocal rank fusion of the lexical and vector lists", async () => {
    // `lexical` is the best word match and the farthest vector; `both` is
    // second on each list; `vector` has no matching word but is the nearest
    // vector. Ranks 1 + 3 (1/61 + 1/63) edge out 2 + 2 (2/62).
    put("lexical", { description: "gizmo gizmo manual" }, [0, 0, 1, 0]);
    put("both", { description: "gizmo notes" }, [0.8, 0.6, 0, 0]);
    put("vector", { description: "unrelated words" }, [1, 0, 0, 0]);
    overrideSeam(_setEmbedderForTests, { embed: async () => [1, 0, 0, 0] });

    const result = await search("gizmo");
    expect(result.mode).toBe("semantic");
    expect(result.hits.map((hit) => [hit.name, hit.whyMatched])).toEqual([
      ["lexical", ["lexical rank 1", "vector rank 3"]],
      ["both", ["lexical rank 2", "vector rank 2"]],
      ["vector", ["vector rank 1"]],
    ]);
    const fused = (ranks: number[]) => Math.round(ranks.reduce((sum, rank) => sum + 1 / (RRF_K + rank), 0) * 1e6) / 1e6;
    expect(result.hits.map((hit) => hit.score)).toEqual([fused([1, 3]), fused([2, 2]), fused([1])]);
  });

  test("sends the query to the embedder with its case and the model's query template", async () => {
    put("target", { description: "healthcheck" }, [1, 0, 0, 0]);
    const embedded: string[] = [];
    overrideSeam(_setEmbedderForTests, {
      embed: async (text: string) => {
        embedded.push(text);
        return [1, 0, 0, 0];
      },
    });

    await search("Docker HealthCheck for Llama.cpp");
    expect(embedded).toEqual([
      "Instruct: Given a question or task, retrieve the knowledge asset that helps with it\nQuery:Docker HealthCheck for Llama.cpp",
    ]);

    await search("Docker HealthCheck", {
      semanticSearchMode: "auto",
      embedding: { ...REMOTE_QWEN3, queryTemplate: "" },
    });
    expect(embedded.at(-1)).toBe("Docker HealthCheck");
  });

  test("a query embedding slower than embedding.queryTimeoutMs falls back to keyword ranking with one warning", async () => {
    put("lexical", { description: "gizmo manual" }, [0, 1, 0, 0]);
    put("vector", { description: "unrelated words" }, [1, 0, 0, 0]);
    let signal: AbortSignal | undefined;
    overrideSeam(_setEmbedderForTests, {
      embed: (_text: string, _config: unknown, abort?: AbortSignal) => {
        signal = abort;
        return new Promise<number[]>(() => {});
      },
    });

    const started = Date.now();
    const result = await search("gizmo", {
      semanticSearchMode: "auto",
      embedding: { ...REMOTE_QWEN3, queryTimeoutMs: 50 },
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.mode).toBe("fts-fallback");
    expect(result.hits.map((hit) => hit.name)).toEqual(["lexical"]);
    expect(result.warnings).toEqual([
      "Vector search unavailable: embedding endpoint http://127.0.0.1:9/v1/embeddings is unavailable (request timed out) — falling back to keyword search.",
    ]);
    expect(signal?.aborted).toBe(true);
  });

  test("returns the same ranking every time, ordering equal BM25 scores and distances by ref", async () => {
    // Identical documents inserted out of ref order: both lists order the
    // ties by ref, so the fused order does not depend on row ids.
    put("zeta", { description: "gizmo" }, [1, 0, 0, 0]);
    put("alpha", { description: "gizmo" }, [1, 0, 0, 0]);
    put("mid", { description: "gizmo" }, [1, 0, 0, 0]);
    overrideSeam(_setEmbedderForTests, { embed: async () => [1, 0, 0, 0] });

    const first = await search("gizmo");
    expect(first.hits.map((hit) => [hit.name, hit.whyMatched])).toEqual([
      ["alpha", ["lexical rank 1", "vector rank 1"]],
      ["mid", ["lexical rank 2", "vector rank 2"]],
      ["zeta", ["lexical rank 3", "vector rank 3"]],
    ]);
    const second = await search("gizmo");
    expect(second.hits.map((hit) => [hit.name, hit.score])).toEqual(first.hits.map((hit) => [hit.name, hit.score]));
  });

  test("keeps one hit per file path", async () => {
    put("first", { description: "gizmo gizmo" }, [1, 0, 0, 0], "/fixture/knowledge/shared.md");
    put("second", { description: "gizmo" }, [0, 1, 0, 0], "/fixture/knowledge/shared.md");
    overrideSeam(_setEmbedderForTests, { embed: async () => [1, 0, 0, 0] });

    const result = await search("gizmo");
    expect(result.hits.map((hit) => hit.name)).toEqual(["first"]);
  });
});

describe("curate over fused search", () => {
  test("an enabled reranker gets each candidate's name, description and indexed content", async () => {
    put("alpha", { description: "gizmo guide", content: "Alpha body about the gizmo." }, [1, 0, 0, 0]);
    put("beta", { description: "gizmo notes", content: "Beta body about the gizmo." }, [0, 1, 0, 0]);
    saveConfig({
      semanticSearchMode: "off",
      bundles: { stash: { path: storage.stashDir } },
      defaultBundle: "stash",
      registries: [],
      search: { curateRerank: { enabled: true, endpoint: "http://127.0.0.1:9/rerank" } },
    });
    resetConfigCache();

    let documents: string[] = [];
    const result = await withMockedFetch(
      () => akmCurate({ query: "gizmo", limit: 1, skipLogging: true }),
      (_url, init) => {
        documents = (JSON.parse(String(init?.body)) as { documents: string[] }).documents;
        const results = documents.map((document, index) => ({
          index,
          relevance_score: document.startsWith("beta") ? 1 : 0,
        }));
        return new Response(JSON.stringify({ results }), { headers: { "Content-Type": "application/json" } });
      },
    );

    expect([...documents].sort()).toEqual([
      "alpha\ngizmo guide\nAlpha body about the gizmo.",
      "beta\ngizmo notes\nBeta body about the gizmo.",
    ]);
    expect(result.items.map((item) => ("ref" in item ? item.ref : undefined))).toEqual(["knowledge/beta"]);
  });
});
