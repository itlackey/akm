// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `generateEmbeddingsForDb`'s outer catch reclassifies a contention-shaped
 * error the same way `akmIndex`'s outer catch already does (field follow-up
 * to #956, dev-team field review 2026-09-10): before this fix, a raw SQLite
 * driver error ("database is locked") escaping this catch built its
 * returned `message` directly from `error.message`, with no
 * `TransientError`/`INDEX_DB_CONTENDED` reclassification — the exact raw
 * string observed in the field as
 * `[index:verify] Semantic search verification failed: database is locked`.
 *
 * Modeled on `materialize-embeddings-partial-commit.test.ts`'s "provider
 * crash" case: a fake `embedBatch` (via `_setEmbedderForTests`) throws
 * synchronously instead of reporting a per-document skip, exercising the
 * SAME outer catch a real contention-shaped driver error would hit — no
 * real second-connection lock hold needed to pin the message-classification
 * bug (the genuine two-connection contention case for the acquisition path
 * is covered by `tests/integration/commands/sources/index-db-contention.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AkmConfig } from "../../src/core/config/config";
import { deriveEntryProvenance, deriveInstallations } from "../../src/indexer/installations";
import { generateEmbeddingsForDb } from "../../src/indexer/materialize-embeddings";
import { buildSearchText } from "../../src/indexer/search/search-fields";
import { _setEmbedderForTests } from "../../src/llm/embedder";
import type { Database } from "../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../src/storage/repositories/index-entries-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";
import { overrideSeam } from "../_helpers/seams";

describe("generateEmbeddingsForDb: contention-shaped errors are reclassified, not raw (field follow-up to #956)", () => {
  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });
  afterEach(() => {
    storage.cleanup();
  });

  function seedEntries(db: Database, count: number): void {
    const installation = deriveInstallations([{ path: storage.stashDir, writable: true }])[0];
    const component = installation?.components[0];
    if (!installation || !component) throw new Error("failed to derive a test bundle installation");
    for (let i = 0; i < count; i++) {
      const name = `memory-${i}`;
      const entry = { name, type: "memories", filename: `${name}.md` };
      const provenance = deriveEntryProvenance(
        { bundleId: installation.id, componentId: component.id, adapterId: component.adapter },
        "memories",
        name,
      );
      upsertEntry(db, `${storage.stashDir}/memories/${name}.md`, entry, buildSearchText(entry), provenance);
    }
  }

  const config = {
    semanticSearchMode: "auto",
    embedding: { endpoint: "http://localhost:1", model: "test-model" },
  } as AkmConfig;

  test("a contention-shaped error (SQLITE_BUSY, 'database is locked') reclassifies to the INDEX_DB_CONTENDED message, never the raw driver string alone", async () => {
    const db = openIndexDatabase();
    try {
      seedEntries(db, 2);

      overrideSeam(_setEmbedderForTests, {
        embedBatch: async () => {
          const raw = new Error("database is locked");
          (raw as Error & { code?: string }).code = "SQLITE_BUSY";
          throw raw;
        },
      });

      const result = await generateEmbeddingsForDb(db, config, () => {});

      expect(result.success).toBe(false);
      // The old bug: message ends up as exactly
      // "Semantic search verification failed: database is locked" — the raw
      // driver string with nothing to tell a reader (or a scheduler parsing
      // logs) that this is ordinary, retryable contention.
      expect(result.message).not.toBe("Semantic search verification failed: database is locked");
      // The fix: the same "akm's index database is busy … retry shortly"
      // wording `reclassifyIndexDbContention`/INDEX_DB_CONTENDED produces at
      // the acquisition-time boundary.
      expect(result.message).toContain("akm's index database is busy");
      expect(result.message).toContain("retry shortly");
    } finally {
      closeDatabase(db);
    }
  });

  test("a non-contention error is still reported as-is (message text unchanged by the reclassifier)", async () => {
    const db = openIndexDatabase();
    try {
      seedEntries(db, 2);

      overrideSeam(_setEmbedderForTests, {
        embedBatch: async () => {
          throw new Error("disk full");
        },
      });

      const result = await generateEmbeddingsForDb(db, config, () => {});

      expect(result.success).toBe(false);
      expect(result.message).toBe("Semantic search verification failed: disk full");
    } finally {
      closeDatabase(db);
    }
  });
});
