// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Index verification truthfulness (§24.2 "Semantic" release gate).
 *
 * 1. `ready-vec` must reflect the path search will ACTUALLY take: when the
 *    embedding phase records vec fast-path insert failures (e.g. a
 *    vector-width mismatch), the verification/`akm info` status must say so
 *    instead of overstating "sqlite-vec active" from the loaded extension
 *    alone.
 *
 *    Since the index-redesign (B2/B3, docs/plans/index-fragment-vectors.md
 *    "one copy of every vector, in vec0") `units`/`units_vec` are the ONLY
 *    vector store for units — there is no BLOB-table fallback for a unit
 *    vector the way the legacy entry-keyed `embeddings`/`entries_vec` pair
 *    used to provide, so a width mismatch has no "JS-cosine fallback" degraded
 *    mode to fall into (`ready-js` is consequently unreachable from this
 *    path; see the "vec fast-path insert failures" test below). What must
 *    still never happen is a FALSE `ready-vec`: a run whose vectors failed to
 *    write must report `blocked` with actionable guidance, not silently
 *    claim semantic search is ready when it is not.
 * 2. A pre-aborted / mid-run-aborted AbortSignal must reject `akmIndex()`
 *    rather than being ignored.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../src/core/config/config";
import { akmIndex } from "../../src/indexer/indexer";
import { clearEmbeddingCache } from "../../src/llm/embedders/cache";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

function mockEmbeddingServer(dim: number): { url: string; server: ReturnType<typeof Bun.serve> } {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/props" || pathname === "/api/show") {
        return new Response(null, { status: 404 });
      }
      const body = (await request.json()) as { input?: unknown };
      const count = Array.isArray(body.input) ? body.input.length : 1;
      const vector = Array.from({ length: dim }, (_, i) => (i + 1) / dim);
      return new Response(
        JSON.stringify({
          data: Array.from({ length: count }, () => ({ embedding: vector })),
          model: "test",
          usage: { prompt_tokens: 5, total_tokens: 5 },
        }),
        { headers: { "Content-Type": "application/json", Connection: "close" } },
      );
    },
  });
  return { url: `http://localhost:${server.port}`, server };
}

describe("index verification truthfulness", () => {
  let storage: IsolatedAkmStorage;
  let server: ReturnType<typeof Bun.serve> | undefined;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    clearEmbeddingCache();
    fs.writeFileSync(
      path.join(storage.stashDir, "memories", "vec-truth.md"),
      "---\ndescription: vec truth fixture\n---\n\nA memory used to exercise embedding storage.\n",
    );
  });
  afterEach(() => {
    server?.stop(true);
    server = undefined;
    storage.cleanup();
    resetConfigCache();
  });

  function configureEmbedding(url: string, dimension: number): void {
    writeSandboxConfig({
      semanticSearchMode: "auto",
      bundles: { stash: { path: storage.stashDir, writable: true } },
      defaultBundle: "stash",
      embedding: { endpoint: url, model: "test-model", dimension },
    });
    resetConfigCache();
  }

  test("vec fast-path insert failures never report a false ready-vec (reported blocked, not silently degraded)", async () => {
    // units_vec is created at FLOAT[8] (config dimension) before the drain's
    // first response ever lands, but the endpoint delivers 4-wide vectors:
    // every vec0 insert for this identity fails with a width mismatch. Units
    // have no BLOB fallback table (module doc, units-repository.ts — "one
    // copy of every vector, in vec0"), so unlike the old entry-keyed
    // dual-storage system there is no partially-degraded "ready-js" state to
    // land in here: a vector that fails to write leaves NO row behind (see
    // upsertUnitVectors' per-row fault tolerance), so embeddingCount stays 0
    // and the run honestly reports "blocked" with retry guidance instead of
    // ever claiming semantic search is ready.
    const mock = mockEmbeddingServer(4);
    server = mock.server;
    configureEmbedding(mock.url, 8);

    const result = await akmIndex({ stashDir: storage.stashDir, full: true });

    expect(result.verification.semanticStatus).not.toBe("ready-vec");
    expect(result.verification.embeddingCount).toBe(0);
    if (!result.verification.vecAvailable) {
      // Host without the sqlite-vec extension: nothing was ever attempted
      // this way — "pending" (never embedded) is trivially non-lying too.
      return;
    }
    expect(result.verification.semanticStatus).toBe("blocked");
    expect(result.verification.ok).toBe(false);
    expect(result.verification.guidance).toBeDefined();
  });

  test("a clean vec run still reports ready-vec (control)", async () => {
    const mock = mockEmbeddingServer(8);
    server = mock.server;
    configureEmbedding(mock.url, 8);

    const result = await akmIndex({ stashDir: storage.stashDir, full: true });

    expect(result.verification.embeddingCount).toBeGreaterThan(0);
    expect(result.verification.semanticStatus).toBe(result.verification.vecAvailable ? "ready-vec" : "ready-js");
  });

  test("a failing embedding provider lands a real 'blocked' verification, not a crash or a lie", async () => {
    // Drives an actual provider failure through akmIndex() to the persisted
    // status — the production glue between "the fetch threw" and
    // "semanticStatus: blocked" that only manually-written status files
    // exercised before.
    server = Bun.serve({
      port: 0,
      fetch: () => new Response("upstream exploded", { status: 500 }),
    });
    configureEmbedding(`http://localhost:${server.port}`, 8);

    const result = await akmIndex({ stashDir: storage.stashDir, full: true });

    expect(result.verification.ok).toBe(false);
    expect(result.verification.semanticStatus).toBe("blocked");
    expect(result.verification.embeddingCount).toBe(0);
  });

  test("a pre-aborted signal rejects akmIndex", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled"));
    await expect(akmIndex({ stashDir: storage.stashDir, signal: controller.signal })).rejects.toThrow(
      /caller cancelled/,
    );
  });

  test("aborting mid-run stops the index at the next checkpoint", async () => {
    const mock = mockEmbeddingServer(8);
    server = mock.server;
    configureEmbedding(mock.url, 8);

    const controller = new AbortController();
    let aborted = false;
    await expect(
      akmIndex({
        stashDir: storage.stashDir,
        full: true,
        signal: controller.signal,
        onProgress: () => {
          if (!aborted) {
            aborted = true;
            controller.abort(new Error("mid-run cancel"));
          }
        },
      }),
    ).rejects.toThrow(/mid-run cancel/);
    expect(aborted).toBe(true);
  });
});
