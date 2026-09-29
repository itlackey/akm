// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Index verification truthfulness (§24.2 "Semantic" release gate).
 *
 * 1. The semantic status reflects the stored vectors: `ready-js` once every
 *    entry has one, whatever width the provider served, and `blocked` when
 *    the provider fails.
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

/** `dim` may vary per input position to simulate a provider serving inconsistent widths. */
function mockEmbeddingServer(dim: number | ((index: number) => number)): {
  url: string;
  server: ReturnType<typeof Bun.serve>;
} {
  const widthAt = typeof dim === "number" ? () => dim : dim;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { input?: unknown };
      const count = Array.isArray(body.input) ? body.input.length : 1;
      const vectorAt = (index: number) => Array.from({ length: widthAt(index) }, (_, i) => (i + 1) / widthAt(index));
      return new Response(
        JSON.stringify({
          data: Array.from({ length: count }, (_, index) => ({ embedding: vectorAt(index) })),
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

  test("every entry embedded reports ready-js, whatever widths the provider serves", async () => {
    // The config declares 8 dimensions; the endpoint serves a 4-wide vector
    // for the first input and 8-wide ones after it. Each row stores its own
    // vector, so the pass is complete.
    fs.writeFileSync(
      path.join(storage.stashDir, "memories", "vec-truth-2.md"),
      "---\ndescription: second vec truth fixture\n---\n\nAnother memory.\n",
    );
    const mock = mockEmbeddingServer((index) => (index === 0 ? 4 : 8));
    server = mock.server;
    configureEmbedding(mock.url, 8);

    const result = await akmIndex({ stashDir: storage.stashDir, full: true });

    const { entryCount, embeddingCount } = result.verification;
    expect(entryCount).toBeGreaterThanOrEqual(2);
    expect(embeddingCount).toBe(entryCount);
    expect(result.verification.semanticStatus).toBe("ready-js");
    expect(result.verification.message).toBe(`Semantic search ready (${embeddingCount}/${entryCount} embeddings).`);
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
