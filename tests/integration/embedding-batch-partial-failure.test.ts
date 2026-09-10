// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Regression coverage for #874: `akm index` used to batch embeddings by a
 * fixed document COUNT (100) with a fixed 30s timeout, and a single failing
 * batch — or a single oversized document — discarded the ENTIRE embedding
 * phase, leaving every other entry's embedding unwritten (`embeddings` at 0
 * rows on the reporting install, despite 23,856 embeddable entries).
 *
 * These tests drive a real `akmIndex({ full: true })` run against a mock
 * OpenAI-compatible endpoint over a bundle with a deliberate MIX of small
 * documents, one that trips a server-side failure, and one configured to be
 * too large for the token budget — and assert the OTHER documents still end
 * up embedded rather than the whole run coming back with zero embeddings.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../src/core/config/config";
import { akmIndex } from "../../src/indexer/indexer";
import { clearEmbeddingCache } from "../../src/llm/embedders/cache";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

describe("embedding batches: a failing batch or an oversized document does not discard the rest (#874)", () => {
  let storage: IsolatedAkmStorage;
  let server: ReturnType<typeof Bun.serve> | undefined;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    clearEmbeddingCache();
  });
  afterEach(() => {
    server?.stop(true);
    server = undefined;
    storage.cleanup();
    resetConfigCache();
  });

  function writeMemory(name: string, body: string): void {
    fs.writeFileSync(
      path.join(storage.stashDir, "memories", name),
      `---\ndescription: ${name}\n---\n\n${body}\n`,
      "utf8",
    );
  }

  test("a batch that fails server-side is skipped without discarding the other batches' embeddings", async () => {
    // One request per document (batchSize: 1) so the "bad" document's
    // failure is isolated to its own batch, proving the failure does not
    // propagate to the other batches already/still to be embedded.
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const { pathname } = new URL(request.url);
        // `probeProviderLimits` (index-redesign B1's reconcile.ts, probed once
        // per run before any parsing) tries llama.cpp's `GET /props` and,
        // failing that, Ollama's `POST /api/show` before any real embedding
        // request — neither carries an `{ input }` body, so route them away
        // from the embedding handling below (mirrors
        // index-embedding-secret-credential.test.ts's own mock server).
        if (pathname === "/props" || pathname === "/api/show") {
          return new Response(null, { status: 404 });
        }
        const body = (await request.json()) as { input: string[] };
        if (body.input.some((t) => t.toLowerCase().includes("trigger_500"))) {
          return new Response("synthetic upstream failure", { status: 500 });
        }
        const data = body.input.map(() => ({ embedding: [1, 0, 0, 0] }));
        return new Response(JSON.stringify({ data, model: "test", usage: { prompt_tokens: 1, total_tokens: 1 } }), {
          headers: { "Content-Type": "application/json", Connection: "close" },
        });
      },
    });

    writeMemory("good-1.md", "An ordinary small memory entry, entry one.");
    writeMemory("good-2.md", "An ordinary small memory entry, entry two.");
    writeMemory("bad.md", "This entry's content will TRIGGER_500 on the mock server.");
    writeMemory("good-3.md", "An ordinary small memory entry, entry three.");

    writeSandboxConfig({
      semanticSearchMode: "auto",
      bundles: { stash: { path: storage.stashDir, writable: true } },
      defaultBundle: "stash",
      embedding: { endpoint: `http://localhost:${server.port}`, model: "test-model", dimension: 4, batchSize: 1 },
    });
    resetConfigCache();

    const result = await akmIndex({ stashDir: storage.stashDir, full: true });

    // `embeddingCount` counts UNITS, not entries (index-redesign A1/B1): each
    // of the 4 entries here has a structured-fields "card" unit (name/desc,
    // no body) plus one body-fragment unit (its one-paragraph content, no
    // heading), so 8 units total. `batchSize: 1` sends one unit per request,
    // and only the "bad" entry's FRAGMENT unit contains "trigger_500" — its
    // card unit's request has no such text, so it still embeds fine. The 3
    // good entries' 6 units plus the bad entry's 1 surviving (card) unit is
    // the "does not discard the rest" proof at unit granularity: 7 of 8.
    expect(result.verification.embeddingCount).toBe(7);
    expect(result.verification.entryCount).toBe(4);
  });

  test("an oversized single document is skipped as a named reason, not a phase failure — the rest still embeds", async () => {
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const { pathname } = new URL(request.url);
        // See the other test's mock server for why these two paths are
        // routed away from the `{ input }`-body embedding handling below.
        if (pathname === "/props" || pathname === "/api/show") {
          return new Response(null, { status: 404 });
        }
        const body = (await request.json()) as { input: string[] };
        const data = body.input.map(() => ({ embedding: [1, 0, 0, 0] }));
        return new Response(JSON.stringify({ data, model: "test", usage: { prompt_tokens: 1, total_tokens: 1 } }), {
          headers: { "Content-Type": "application/json", Connection: "close" },
        });
      },
    });

    writeMemory("small-1.md", "A short entry.");
    writeMemory("small-2.md", "Another short entry.");
    // ~1000 chars ≈ 250 estimated tokens — comfortably over the 100-token
    // budget configured below, well under the small entries' few tokens.
    writeMemory("huge.md", "oversized content ".repeat(60));

    writeSandboxConfig({
      semanticSearchMode: "auto",
      bundles: { stash: { path: storage.stashDir, writable: true } },
      defaultBundle: "stash",
      embedding: { endpoint: `http://localhost:${server.port}`, model: "test-model", dimension: 4, maxTokens: 100 },
    });
    resetConfigCache();

    const result = await akmIndex({ stashDir: storage.stashDir, full: true });

    // `embeddingCount` counts UNITS, not entries (see the other test's
    // comment): 3 entries × (card + one body-fragment unit) = 6 candidate
    // units. `huge.md`'s NAME is short (its card unit embeds fine); only its
    // body fragment is long enough to trip `maxTokens: 100` and get skipped
    // as oversized. Both small entries' 4 units plus huge's surviving card
    // unit is the "rest still embeds" proof at unit granularity: 5 of 6.
    expect(result.verification.embeddingCount).toBe(5);
    expect(result.verification.entryCount).toBe(3);
  });
});
