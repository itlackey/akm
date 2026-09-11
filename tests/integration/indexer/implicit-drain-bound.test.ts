// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A read command's inline index bootstrap (`ensureIndex` → `akmIndex({
 * implicit: true })`) must not embed the whole corpus before the read can
 * answer. The drain is a durable queue (docs/plans/index-redesign.md rule 4),
 * so an implicit run takes one provider request's worth of units and leaves
 * the rest to a later drain; an explicit `akm index` still drains everything.
 *
 * Without the bound, the FIRST `akm search` against a fresh index blocked
 * until every unit was embedded — hours on a large corpus — and, because an
 * implicit run deliberately writes nothing to stderr, with no way to see why.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../../src/core/config/config";
import { akmIndex } from "../../../src/indexer/indexer";
import { clearEmbeddingCache } from "../../../src/llm/embedders/cache";
import { DEFAULT_REMOTE_BATCH_SIZE } from "../../../src/llm/embedders/remote";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

const DIM = 4;
/** Comfortably more units than one implicit slice, so a bound is observable. */
const MEMORY_COUNT = DEFAULT_REMOTE_BATCH_SIZE + 40;

function mockEmbeddingServer() {
  let embeddedDocuments = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      // The provider-limits probe asks for these first; a 404 makes it fall
      // back to its conservative default, as every other mock here does.
      if (pathname === "/props" || pathname === "/api/show") return new Response(null, { status: 404 });
      const body = (await request.json()) as { input?: unknown };
      const count = Array.isArray(body.input) ? body.input.length : 1;
      embeddedDocuments += count;
      const vector = Array.from({ length: DIM }, (_, i) => (i + 1) / DIM);
      return new Response(
        JSON.stringify({
          data: Array.from({ length: count }, () => ({ embedding: vector })),
          model: "test-model",
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
        { headers: { "Content-Type": "application/json", Connection: "close" } },
      );
    },
  });
  return { url: `http://localhost:${server.port}`, server, embeddedDocuments: () => embeddedDocuments };
}

describe("implicit index runs take a bounded slice of the embedding queue", () => {
  let storage: IsolatedAkmStorage;
  let server: ReturnType<typeof Bun.serve> | undefined;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    clearEmbeddingCache();
    for (let i = 0; i < MEMORY_COUNT; i++) {
      fs.writeFileSync(
        path.join(storage.stashDir, "memories", `bounded-${i}.md`),
        `---\ndescription: bounded drain fixture ${i}\n---\n\nBody text for fixture ${i}.\n`,
      );
    }
  });
  afterEach(() => {
    server?.stop(true);
    server = undefined;
    storage.cleanup();
    resetConfigCache();
  });

  test("an implicit run embeds a bounded slice; an explicit run drains the rest", async () => {
    const mock = mockEmbeddingServer();
    server = mock.server;
    writeSandboxConfig({
      semanticSearchMode: "auto",
      bundles: { stash: { path: storage.stashDir, writable: true } },
      defaultBundle: "stash",
      embedding: { endpoint: mock.url, model: "test-model", dimension: DIM },
    });
    resetConfigCache();

    const implicitResult = await akmIndex({ stashDir: storage.stashDir, implicit: true });

    // Every entry is indexed and lexically searchable straight away.
    expect(implicitResult.totalEntries).toBe(MEMORY_COUNT);
    // But the queue is only partly drained: at most one slice was sent, and
    // there are more units than that, so the run cannot report full coverage.
    const implicitDocuments = mock.embeddedDocuments();
    // Non-zero: the slice is a bound, not a skip — an implicit read still
    // makes real progress on the queue, which is what makes repeated reads
    // converge (rule 4). Without this the bound could pass vacuously.
    expect(implicitDocuments).toBeGreaterThan(0);
    expect(implicitDocuments).toBeLessThanOrEqual(DEFAULT_REMOTE_BATCH_SIZE);
    expect(implicitDocuments).toBeLessThan(MEMORY_COUNT);
    if (implicitResult.verification.vecAvailable) {
      expect(implicitResult.verification.semanticStatus).not.toBe("ready-vec");
    }

    // An explicit run is unbounded and finishes the queue.
    const explicitResult = await akmIndex({ stashDir: storage.stashDir });
    expect(mock.embeddedDocuments()).toBeGreaterThan(implicitDocuments);
    if (explicitResult.verification.vecAvailable) {
      expect(explicitResult.verification.semanticStatus).toBe("ready-vec");
    }
  }, 120_000);
});
