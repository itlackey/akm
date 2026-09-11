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
import { _setVecUnavailableForTests } from "../../src/storage/repositories/index-vec-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

function mockEmbeddingServer(dim: number): {
  url: string;
  server: ReturnType<typeof Bun.serve>;
  embeddingRequestCount: () => number;
} {
  let embeddingRequests = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/props" || pathname === "/api/show") {
        return new Response(null, { status: 404 });
      }
      embeddingRequests++;
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
  return { url: `http://localhost:${server.port}`, server, embeddingRequestCount: () => embeddingRequests };
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

  test("a configured dimension the provider contradicts self-heals to the observed width", async () => {
    // `units_vec` is created at FLOAT[8] (the configured `embedding.dimension`)
    // before the drain's first response lands, but the endpoint delivers
    // 4-wide vectors. The observed width is what the embedding identity is
    // keyed on (`deriveObservedEmbeddingIdentity` folds it into the identity
    // string), so the provider's reality wins over a stale config value:
    // adopting the identity recreates `units_vec` at the observed width
    // before anything is written under it, and the run is genuinely ready.
    //
    // This test previously asserted the opposite — that the run stays
    // "blocked" — which encoded a real defect as the contract. The width
    // check inside `dropOtherIdentities` used to be gated behind
    // "some other identity already has rows", which is never true on a fresh
    // index: every insert failed with a width mismatch, the placeholder row
    // was discarded so the gate stayed shut, and no `akm index`, no
    // `--reembed`, and not even correcting the config could recover it.
    // Only deleting index.db could. The guarantee that ran through the old
    // expectation — never report a false `ready-vec` — is unchanged and
    // still pinned by "a failing embedding provider lands a real 'blocked'
    // verification" below and by the missing-sqlite-vec case at the end of
    // this file; what changed is that a width disagreement is no longer one
    // of the ways writing can fail.
    const mock = mockEmbeddingServer(4);
    server = mock.server;
    configureEmbedding(mock.url, 8);

    const result = await akmIndex({ stashDir: storage.stashDir, full: true });

    if (!result.verification.vecAvailable) {
      // Host without the sqlite-vec extension: there is no vec0 table to
      // recreate and nothing is ever written, which the missing-extension
      // test covers on its own terms.
      expect(result.verification.semanticStatus).toBe("blocked");
      return;
    }
    expect(result.verification.semanticStatus).toBe("ready-vec");
    expect(result.verification.embeddingCount).toBeGreaterThan(0);
  });

  test("a missing sqlite-vec extension reports blocked and never calls the embedding provider", async () => {
    // 22c2e858 made buildIndexVerification's `!vecAvailable` branch report
    // `blocked`/`ok: false` with sqlite-vec guidance instead of a status that
    // can never resolve, and 262c2da6 made drainEmbeddingQueue skip the
    // provider entirely rather than burn requests it can never persist. Real
    // hosts without the optional extension can't be produced in a test, so
    // this drives it through the same _setVecUnavailableForTests seam
    // loadVecExtension checks — end to end through akmIndex(), not by
    // constructing an IndexVerification by hand.
    const mock = mockEmbeddingServer(8);
    server = mock.server;
    configureEmbedding(mock.url, 8);
    _setVecUnavailableForTests(true);

    try {
      const result = await akmIndex({ stashDir: storage.stashDir, full: true });

      expect(result.verification.vecAvailable).toBe(false);
      expect(result.verification.semanticStatus).toBe("blocked");
      expect(result.verification.ok).toBe(false);
      expect(result.verification.message).toContain("sqlite-vec");
      expect(result.verification.guidance).toBeTruthy();
      expect(mock.embeddingRequestCount()).toBe(0);
    } finally {
      _setVecUnavailableForTests(false);
    }
  });
  test("a clean vec run still reports ready-vec (control)", async () => {
    const mock = mockEmbeddingServer(8);
    server = mock.server;
    configureEmbedding(mock.url, 8);

    const result = await akmIndex({ stashDir: storage.stashDir, full: true });

    expect(result.verification.embeddingCount).toBeGreaterThan(0);
    // "ready-js" is retired (index redesign, B5): units_vec is a vec0-only
    // store, so a non-zero embeddingCount already proves vecAvailable was
    // true (nothing else can write it) and the only honest status is
    // "ready-vec".
    expect(result.verification.semanticStatus).toBe("ready-vec");
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
