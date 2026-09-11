// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Regression coverage for #874: `akm index` used to batch embeddings by a
 * fixed document COUNT (100) with a fixed 30s timeout, and a single failing
 * batch discarded the ENTIRE embedding phase, leaving every other entry's
 * embedding unwritten (`embeddings` at 0 rows on the reporting install,
 * despite 23,856 embeddable entries).
 *
 * Drives a real `akmIndex({ full: true })` run against a mock
 * OpenAI-compatible endpoint over a bundle with a deliberate MIX of
 * documents — most that embed cleanly, one that trips a server-side
 * failure — and asserts the OTHER documents still end up embedded rather
 * than the whole run coming back with zero embeddings.
 *
 * #874's OTHER original scenario — a single document too large for the
 * token budget, skipped with a named reason rather than failing the whole
 * phase — is retired as an INTEGRATION-level case (index redesign, B5):
 * A1's unit derivation (`deriveUnits`, `src/indexer/units/unit.ts`) now caps
 * every unit's size at `unitMaxChars`, derived from the SAME probed window
 * `RemoteEmbedder` packs requests against, so a unit that exceeds the
 * packing budget can no longer occur via normal content — it is split into
 * smaller units well before reaching the embedder instead. The pre-flight
 * oversized-skip mechanism itself (still real defensive code, e.g. for a
 * provider whose calibration undercounts) stays covered at the
 * `RemoteEmbedder` unit level: tests/embedder-batching.test.ts and
 * tests/integration/embedder.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../src/core/config/config";
import { akmIndex } from "../../src/indexer/indexer";
import { clearEmbeddingCache } from "../../src/llm/embedders/cache";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

describe("embedding batches: a failing batch does not discard the rest (#874)", () => {
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

  /**
   * A frontmatter-only entry (no markdown body, so `deriveUnits`,
   * index-redesign A1, produces exactly ONE unit: the structured-fields
   * "card" from `name` + `description`). `descriptionText` is sized (see
   * `ISOLATING_DESCRIPTION_CHARS`) so this unit never shares a request with
   * another — a markdown BODY fragment would not work for this: it is
   * capped at the fixed `MARKDOWN_FRAGMENT_MAX_CHARS` (1,600 chars,
   * `src/core/asset/markdown-fragments.ts`) regardless of the packing
   * window, far too small to force isolation against the DEFAULT 8192-token
   * window these mock servers (answering neither `/props` nor `/api/show`)
   * leave in effect.
   */
  function writeIsolatedMemory(name: string, descriptionText: string): void {
    fs.writeFileSync(
      path.join(storage.stashDir, "memories", `${name}.md`),
      `---\ndescription: ${descriptionText}\n---\n`,
      "utf8",
    );
  }

  /**
   * Big enough (chars) that its estimated tokens (`estimateTokenCount`,
   * chars/4) alone are more than half the DEFAULT 8192-token packing window
   * — so two such card units never fit one request together, isolating each
   * one's request from the others'. Comfortably under `unitMaxChars` for
   * that same window (~21,132 chars) so it still derives as ONE card unit,
   * not split (index-redesign A1). Retired `embedding.batchSize: 1`'s
   * per-request isolation for this same purpose (index redesign, B5).
   */
  const ISOLATING_DESCRIPTION_CHARS = 19_000;

  test("a batch that fails server-side is skipped without discarding the other batches' embeddings", async () => {
    // Every entry is a single, isolated card unit (see
    // writeIsolatedMemory/ISOLATING_DESCRIPTION_CHARS) — the "bad" entry's
    // failure is isolated to its own request, proving the failure does not
    // propagate to the other requests already/still to be embedded.
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

    writeIsolatedMemory("good-1", `An ordinary memory entry, entry one. ${"x".repeat(ISOLATING_DESCRIPTION_CHARS)}`);
    writeIsolatedMemory("good-2", `An ordinary memory entry, entry two. ${"x".repeat(ISOLATING_DESCRIPTION_CHARS)}`);
    writeIsolatedMemory(
      "bad",
      `This entry's content will TRIGGER_500 on the mock server. ${"x".repeat(ISOLATING_DESCRIPTION_CHARS)}`,
    );
    writeIsolatedMemory("good-3", `An ordinary memory entry, entry three. ${"x".repeat(ISOLATING_DESCRIPTION_CHARS)}`);

    writeSandboxConfig({
      semanticSearchMode: "auto",
      bundles: { stash: { path: storage.stashDir, writable: true } },
      defaultBundle: "stash",
      embedding: { endpoint: `http://localhost:${server.port}`, model: "test-model", dimension: 4 },
    });
    resetConfigCache();

    const result = await akmIndex({ stashDir: storage.stashDir, full: true });

    // `embeddingCount` counts UNITS, not entries (index-redesign A1/B1):
    // each of the 4 entries here is exactly one card unit (frontmatter-only,
    // see writeIsolatedMemory), so 4 units total, sent as 4 requests — one
    // per entry (see ISOLATING_DESCRIPTION_CHARS). Only the "bad" entry's
    // request contains "trigger_500" and fails; the 3 good entries' requests
    // all succeed. 3 of 4 units embedded is the "does not discard the rest"
    // proof.
    expect(result.verification.embeddingCount).toBe(3);
    expect(result.verification.entryCount).toBe(4);
  });
});
