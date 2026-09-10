// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #954, field-report follow-up: the owner asked for the SAME mid-run
 * visibility proof `bundle-update-embedding-durability.test.ts` gives the
 * post-commit pass, on the plain `akm index` path too — per-batch
 * commits must be independently observable by a second connection WHILE the
 * embedding phase is still running, not just true-in-aggregate at the end.
 *
 * Drives the real `akmIndex` coordinator against a real `index.db` (hence
 * tests/integration/, ORG-03..06) with a mock embeddings server that delays
 * every response ~150ms, so a concurrent poller reliably samples multiple
 * distinct counts before the run finishes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getDbPath } from "../../../src/core/paths";
import { akmIndex } from "../../../src/indexer/indexer";
import type { Database } from "../../../src/storage/database";
import { closeDatabase, openReadonlyExistingDatabase } from "../../../src/storage/repositories/index-connection";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

/**
 * Each entry's inflated `description` is sized (chars ≈ tokens × 4, the
 * same `estimateTokenCount` ratio the packer plans against) so its
 * structured-fields "card" unit alone estimates to `PER_UNIT_TOKENS` — no
 * markdown body, so no second fragment unit (index-redesign A1) muddies the
 * per-batch count.
 */
const PER_UNIT_TOKENS = 1_800;

/**
 * Write `fileCount` frontmatter-only entries whose single unit each
 * estimates to `PER_UNIT_TOKENS` tokens. The index redesign (B5) retired
 * `embedding.batchSize`, so forcing several small provider round trips
 * spread over the run (this test's whole premise — a poller must catch
 * multiple distinct mid-run commits) now comes from the GREEDY packer's own
 * token-budget math against the default (unprobed, 8192-token) window
 * instead of a config override: 4 docs at 1,800 tokens (7,200) fit one
 * request; a 5th (9,000) never does, so 44 entries land in 11 batches of 4 —
 * the same shape `batchSize: 4` used to force directly.
 */
function writeSizedMemoryFiles(rootDir: string, fileCount: number, marker: string): void {
  fs.mkdirSync(path.join(rootDir, "knowledge"), { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    fs.writeFileSync(
      path.join(rootDir, "knowledge", `entry-${i}.md`),
      `---\ndescription: ${marker}-${i}-${"x".repeat(PER_UNIT_TOKENS * 4)}\n---\n`,
    );
  }
}

/**
 * `units` rows with a stored vector — the content-addressed (index-redesign
 * A2) analogue of the pre-redesign, entry-id-keyed `embeddings` table
 * `getEmbeddingCount` used to read. `materialize-embeddings.ts`, the only
 * writer of that legacy table, had no callers left and is deleted
 * (index-redesign B5b) — the `embeddings` table itself is out of scope here
 * (B5c), but reading it would just see zero for the whole run either way.
 */
function getUnitVectorCount(db: Database): number {
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM units").get() as { cnt: number };
  return row.cnt;
}

describe("akm index: mid-run embedding visibility (#954, field-report follow-up)", () => {
  let storage: IsolatedAkmStorage;
  let server: ReturnType<typeof Bun.serve> | undefined;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });
  afterEach(() => {
    server?.stop(true);
    server = undefined;
    storage.cleanup();
  });

  test("a separate read-only connection observes the embeddings count strictly increasing while the server is still receiving requests", async () => {
    const entryCount = 44;
    writeSizedMemoryFiles(storage.stashDir, entryCount, "mid-run");

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const { pathname } = new URL(request.url);
        // `probeProviderLimits` (index-redesign B1's reconcile.ts, probed
        // once per run before any parsing) tries llama.cpp's `GET /props`
        // and, failing that, Ollama's `POST /api/show`, before any real
        // embedding request — neither carries an `{ input }` body.
        if (pathname === "/props" || pathname === "/api/show") {
          return new Response(null, { status: 404 });
        }
        const body = (await request.json()) as { input: string[] };
        await new Promise((resolve) => setTimeout(resolve, 150));
        const data = body.input.map((_t, i) => ({ embedding: [1, 0, 0, 0], index: i }));
        return new Response(JSON.stringify({ data, model: "mock-embed" }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    writeSandboxConfig({
      semanticSearchMode: "auto",
      embedding: {
        endpoint: `http://localhost:${server.port}`,
        model: "mock-embed",
        dimension: 4,
      },
    });

    const samples: number[] = [];
    let polling = true;
    const poll = (async () => {
      while (polling) {
        const reader = openReadonlyExistingDatabase(getDbPath());
        if (reader) {
          try {
            samples.push(getUnitVectorCount(reader));
          } finally {
            closeDatabase(reader);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    })();

    const result = await akmIndex({ stashDir: storage.stashDir, full: true });
    polling = false;
    await poll;

    expect(result.totalEntries).toBe(entryCount);

    // Strictly-increasing steps: consecutive samples where the count grew —
    // proves a reader watching mid-run sees real, incremental progress (per-
    // batch durable commits), not one silent jump at the very end.
    let increases = 0;
    for (let i = 1; i < samples.length; i++) {
      if ((samples[i] as number) > (samples[i - 1] as number)) increases++;
    }
    expect(increases).toBeGreaterThanOrEqual(3);

    const finalDb = openReadonlyExistingDatabase(getDbPath());
    expect(finalDb).not.toBeNull();
    if (finalDb) {
      try {
        // Frontmatter-only entries (writeSizedMemoryFiles): one
        // structured-fields "card" unit per entry, no body-fragment unit.
        expect(getUnitVectorCount(finalDb)).toBe(entryCount);
      } finally {
        closeDatabase(finalDb);
      }
    }
  }, 30_000);
});
