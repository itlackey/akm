// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm index --full` and `akm index --reembed` (index-redesign B5a).
 *
 * `--full` no longer wipes `entries`/`files` and rebuilds a fresh generation
 * from nothing (the old #624/#820-era "drop derived tables, then reconcile"
 * design) — it reconciles with `forceReparse: true` instead: every walked
 * file is treated as needing re-derivation (the stat-hint "unchanged"
 * shortcut is skipped), but the item_ref-keyed UPSERT re-points the SAME row
 * in place, preserving its id/embeddings/utility scores. Content-addressed
 * units (`units`/`units_vec`) are never dropped by a reindex at all — only
 * `--reembed` clears the active identity's vectors, on purpose, to force a
 * from-scratch re-embed.
 *
 * These drive real `index.db`s via `akmIndex`/`akmSearch`, so they are
 * integration tests per the ORG-03..06 classification rule.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmSearch } from "../../../../src/commands/read/search";
import { resetConfigCache } from "../../../../src/core/config/config";
import { getDbPath } from "../../../../src/core/paths";
import { akmIndex } from "../../../../src/indexer/indexer";
import { clearEmbeddingCache } from "../../../../src/llm/embedders/cache";
import { closeDatabase, openExistingDatabase } from "../../../../src/storage/repositories/index-connection";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  clearEmbeddingCache();
});
afterEach(() => {
  storage.cleanup();
  resetConfigCache();
});

function writeMemory(name: string, body: string): string {
  const filePath = path.join(storage.stashDir, "memories", name);
  fs.writeFileSync(filePath, `---\ndescription: ${name}\n---\n\n${body}\n`, "utf8");
  return filePath;
}

function unitCounts(dbPath: string): { total: number; withVector: number } {
  const db = openExistingDatabase(dbPath);
  try {
    const total = (db.prepare("SELECT COUNT(*) AS n FROM units").get() as { n: number }).n;
    const withVector = (db.prepare("SELECT COUNT(*) AS n FROM units_vec").get() as { n: number } | undefined)?.n ?? 0;
    return { total, withVector };
  } finally {
    closeDatabase(db);
  }
}

/** A mock embedding endpoint that routes the pre-flight limits probe away and logs how many texts it was asked to embed per request. */
function mockEmbeddingServer(
  dim: number,
  requestSizes: number[],
): { url: string; server: ReturnType<typeof Bun.serve> } {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/props" || pathname === "/api/show") return new Response(null, { status: 404 });
      const body = (await request.json()) as { input?: unknown };
      const count = Array.isArray(body.input) ? body.input.length : 1;
      requestSizes.push(count);
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

describe("akm index --full", () => {
  test("re-derives every file in place: same entry id, refreshed content, no data loss", async () => {
    const asset = writeMemory("stable.md", "Original body content.");
    writeSandboxConfig({
      semanticSearchMode: "off",
      bundles: { stash: { path: storage.stashDir, writable: true } },
      defaultBundle: "stash",
    });
    resetConfigCache();

    await akmIndex({ stashDir: storage.stashDir, full: true });
    const dbPath = getDbPath();
    let firstId: number;
    {
      const db = openExistingDatabase(dbPath);
      try {
        const row = db.prepare("SELECT id FROM entries WHERE item_ref = ?").get("stash//memories/stable") as
          | { id: number }
          | undefined;
        if (!row) throw new Error("missing first-run row");
        firstId = row.id;
      } finally {
        closeDatabase(db);
      }
    }

    // A second --full run over UNCHANGED content: the stat-hint shortcut is
    // deliberately bypassed (forceReparse), but the row is the same concept
    // identity, so it re-points in place rather than minting a new id.
    await akmIndex({ stashDir: storage.stashDir, full: true });
    {
      const db = openExistingDatabase(dbPath);
      try {
        const row = db.prepare("SELECT id FROM entries WHERE item_ref = ?").get("stash//memories/stable") as
          | { id: number }
          | undefined;
        expect(row?.id).toBe(firstId);
        expect((db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n).toBe(1);
      } finally {
        closeDatabase(db);
      }
    }

    // A --full run after an actual content edit: still the same id, but the
    // new content is what search finds.
    fs.writeFileSync(asset, "---\ndescription: stable.md\n---\n\nRevised body content.\n", "utf8");
    await akmIndex({ stashDir: storage.stashDir, full: true });
    {
      const db = openExistingDatabase(dbPath);
      try {
        const row = db.prepare("SELECT id FROM entries WHERE item_ref = ?").get("stash//memories/stable") as
          | { id: number }
          | undefined;
        expect(row?.id).toBe(firstId);
      } finally {
        closeDatabase(db);
      }
    }
    const hit = await akmSearch({ query: "revised body content", skipLogging: true });
    // A fragment-anchored ref (index-redesign B2/B3's per-paragraph unit
    // coverage) is expected here — the best match is the body text, not the
    // frontmatter card — so this checks the entry prefix, not an exact ref.
    expect(hit.hits.some((h) => "ref" in h && h.ref.split("#", 1)[0] === "memories/stable")).toBe(true);
  });

  test("a full walk followed by search proves units are populated and the units path serves real results", async () => {
    writeMemory("alpha.md", "A distinctive passage about lighthouse keepers on rocky coastlines.");
    writeMemory("beta.md", "An unrelated passage about baking sourdough bread at high altitude.");
    const requestSizes: number[] = [];
    const mock = mockEmbeddingServer(4, requestSizes);
    try {
      writeSandboxConfig({
        semanticSearchMode: "auto",
        bundles: { stash: { path: storage.stashDir, writable: true } },
        defaultBundle: "stash",
        embedding: { endpoint: mock.url, model: "test-model", dimension: 4 },
      });
      resetConfigCache();

      const result = await akmIndex({ stashDir: storage.stashDir, full: true });

      expect(result.verification.semanticStatus).toBe("ready-vec");
      expect(result.verification.embeddingCount).toBeGreaterThan(0);
      expect(requestSizes.length).toBeGreaterThan(0);

      const dbPath = getDbPath();
      const counts = unitCounts(dbPath);
      expect(counts.total).toBeGreaterThan(0);
      expect(counts.withVector).toBe(counts.total);

      // The units path actually serves a real hit for lexical content — the
      // point of "units populated" is that search can find it, not merely
      // that a row exists.
      const found = await akmSearch({ query: "lighthouse keepers rocky coastlines", skipLogging: true });
      expect(found.hits.some((h) => "ref" in h && h.ref.split("#", 1)[0] === "memories/alpha")).toBe(true);
    } finally {
      mock.server.stop(true);
    }
  });
});

describe("akm index --reembed", () => {
  test("drops the active identity's vectors and re-embeds every unit from scratch, even though nothing changed", async () => {
    writeMemory("gamma.md", "Content that will be embedded, then re-embedded on demand.");
    const requestSizes: number[] = [];
    const mock = mockEmbeddingServer(4, requestSizes);
    try {
      writeSandboxConfig({
        semanticSearchMode: "auto",
        bundles: { stash: { path: storage.stashDir, writable: true } },
        defaultBundle: "stash",
        embedding: { endpoint: mock.url, model: "test-model", dimension: 4 },
      });
      resetConfigCache();

      const first = await akmIndex({ stashDir: storage.stashDir, full: true });
      expect(first.verification.semanticStatus).toBe("ready-vec");
      const firstRequestCount = requestSizes.length;
      expect(firstRequestCount).toBeGreaterThan(0);

      const dbPath = getDbPath();
      const afterFirst = unitCounts(dbPath);
      expect(afterFirst.withVector).toBe(afterFirst.total);

      // A plain incremental reindex with nothing changed: the drain's
      // set-difference finds nothing missing, so the provider is not
      // contacted again.
      requestSizes.length = 0;
      await akmIndex({ stashDir: storage.stashDir });
      expect(requestSizes.length).toBe(0);
      expect(unitCounts(dbPath)).toEqual(afterFirst);

      // --reembed: the SAME units (nothing changed on disk) are nonetheless
      // sent to the provider again, because their vectors were dropped first.
      requestSizes.length = 0;
      const reembedResult = await akmIndex({ stashDir: storage.stashDir, reembed: true });
      expect(requestSizes.length).toBeGreaterThan(0);
      expect(reembedResult.verification.semanticStatus).toBe("ready-vec");
      const afterReembed = unitCounts(dbPath);
      expect(afterReembed.total).toBe(afterFirst.total);
      expect(afterReembed.withVector).toBe(afterFirst.total);
    } finally {
      mock.server.stop(true);
    }
  });
});
