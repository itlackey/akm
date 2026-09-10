// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Salvage cost must be bounded (#955, field-report follow-up):
 *
 *  - `salvageEmbeddingsBeforeDiscard` streams `entries JOIN embeddings` in
 *    id-ordered pages instead of loading every row into memory before
 *    hashing anything.
 *  - `reuseSalvagedEmbeddings` checks whether ANY salvage row exists for the
 *    current fingerprint before hashing a single pending entry — the steady
 *    state of every ordinary run (nothing was just discarded) must cost one
 *    indexed lookup, not a hash per entry.
 *
 * Drives a real `index.db` connection (`openIndexDatabase`), hence
 * tests/integration/ per the ORG-03..06 classification rule.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { deriveEntryProvenance, deriveInstallations } from "../../../src/indexer/installations";
import { buildSearchText } from "../../../src/indexer/search/search-fields";
import type { EmbeddingVector } from "../../../src/llm/embedders/types";
import type { Database } from "../../../src/storage/database";
import {
  reuseSalvagedEmbeddings,
  salvageEmbeddingsBeforeDiscard,
} from "../../../src/storage/repositories/embedding-salvage-repository";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import { setMeta } from "../../../src/storage/repositories/index-meta-repository";
import { SQLITE_CHUNK_SIZE } from "../../../src/storage/repositories/index-sql";
import { upsertEmbedding } from "../../../src/storage/repositories/index-vec-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const PAGE_SQL =
  "SELECT e.id AS id, e.search_text AS searchText, em.embedding AS embedding " +
  "FROM entries e JOIN embeddings em ON em.id = e.id WHERE e.id > ? ORDER BY e.id LIMIT ?";

function stableVec(i: number): EmbeddingVector {
  return [1 + i, 2 + i, 3 + i];
}

describe("embedding salvage cost is bounded (#955)", () => {
  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });
  afterEach(() => storage.cleanup());

  /** Seed `count` entries, each with a stored embedding, and return their ids. */
  function seedEmbeddedEntries(db: Database, count: number): number[] {
    const installation = deriveInstallations([{ path: storage.stashDir, writable: true }])[0];
    const component = installation?.components[0];
    if (!installation || !component) throw new Error("failed to derive a test bundle installation");
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      const name = `entry-${i}`;
      const entry = { name, type: "memories" as const, filename: `${name}.md` };
      const provenance = deriveEntryProvenance(
        { bundleId: installation.id, componentId: component.id, adapterId: component.adapter },
        "memories",
        name,
      );
      const id = upsertEntry(db, `${storage.stashDir}/memories/${name}.md`, entry, buildSearchText(entry), provenance);
      upsertEmbedding(db, id, stableVec(i));
      ids.push(id);
    }
    return ids;
  }

  test("salvageEmbeddingsBeforeDiscard streams a 1,200-row salvage in >= 3 chunks", () => {
    const db = openIndexDatabase();
    try {
      const count = 1200;
      expect(count).toBeGreaterThan(SQLITE_CHUNK_SIZE * 2);
      seedEmbeddedEntries(db, count);
      setMeta(db, "embeddingFingerprint", "local:test-model");

      let pageCalls = 0;
      const realPrepare = db.prepare.bind(db);
      const prepareSpy = spyOn(db, "prepare").mockImplementation((sql: string) => {
        const stmt = realPrepare(sql);
        if (sql !== PAGE_SQL) return stmt;
        const wrapped = Object.create(stmt);
        wrapped.all = (...args: Parameters<typeof stmt.all>) => {
          pageCalls++;
          return stmt.all(...args);
        };
        return wrapped;
      });

      try {
        const salvaged = salvageEmbeddingsBeforeDiscard(db);
        expect(salvaged).toBe(count);
      } finally {
        prepareSpy.mockRestore();
      }

      // ceil(1200 / 500) = 3 page requests (500 + 500 + 200).
      expect(pageCalls).toBeGreaterThanOrEqual(3);

      const salvageRowCount = (db.prepare("SELECT COUNT(*) AS c FROM embedding_salvage").get() as { c: number }).c;
      expect(salvageRowCount).toBe(count);
    } finally {
      closeDatabase(db);
    }
  });

  test("reuseSalvagedEmbeddings against an empty salvage table hashes nothing", () => {
    const db = openIndexDatabase();
    try {
      const installation = deriveInstallations([{ path: storage.stashDir, writable: true }])[0];
      const component = installation?.components[0];
      if (!installation || !component) throw new Error("failed to derive a test bundle installation");
      const entries = Array.from({ length: 5 }, (_v, i) => {
        const name = `pending-${i}`;
        const entry = { name, type: "memories" as const, filename: `${name}.md` };
        const provenance = deriveEntryProvenance(
          { bundleId: installation.id, componentId: component.id, adapterId: component.adapter },
          "memories",
          name,
        );
        const id = upsertEntry(
          db,
          `${storage.stashDir}/memories/${name}.md`,
          entry,
          buildSearchText(entry),
          provenance,
        );
        return { id, searchText: buildSearchText(entry) };
      });

      // `hashEmbeddableText` is a plain same-module function, not reachable
      // via a bindable seam, so the observable proxy for "no hashing/lookup
      // work happened" is the SQL this function issues: it must run ONLY the
      // `LIMIT 1` existence check and never the per-hash `content_hash IN
      // (...)` lookup that a non-empty salvage table would require.
      let shortCircuitChecks = 0;
      let hashLookupQueries = 0;
      const realPrepare = db.prepare.bind(db);
      const prepareSpy = spyOn(db, "prepare").mockImplementation((sql: string) => {
        if (sql.includes("SELECT 1 FROM embedding_salvage WHERE fingerprint")) shortCircuitChecks++;
        if (sql.includes("content_hash IN (")) hashLookupQueries++;
        return realPrepare(sql);
      });

      try {
        const result = reuseSalvagedEmbeddings(db, entries, "local:test-model", () => true);
        expect(result.reusedCount).toBe(0);
        expect(result.remaining).toEqual(entries);
      } finally {
        prepareSpy.mockRestore();
      }

      // The steady state of every ordinary run: nothing was just discarded,
      // so embedding_salvage is empty — this must cost one indexed lookup,
      // never a hash-lookup query per pending entry.
      expect(shortCircuitChecks).toBe(1);
      expect(hashLookupQueries).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });
});
