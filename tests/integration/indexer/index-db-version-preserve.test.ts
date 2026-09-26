// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `index_meta.version` is a layout marker, not a gate: reopening an index
 * whose marker is older than this binary's keeps its entries and vectors (the
 * writable opener migrates the layout in place) and restamps the marker.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveEntryProvenance } from "../../../src/indexer/installations";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { getEntryCount, upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import { getMeta, setMeta } from "../../../src/storage/repositories/index-meta-repository";
import { DB_VERSION } from "../../../src/storage/repositories/index-schema";
import { getEmbeddingCount, upsertEmbedding } from "../../../src/storage/repositories/index-vec-repository";

describe("index.db layout marker", () => {
  test("an older marker keeps entries and embeddings on reopen", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-layout-marker-"));
    const dbPath = path.join(tmpDir, "index.db");
    try {
      let db = openIndexDatabase(dbPath, { embeddingDim: 4 });
      const id = upsertEntry(
        db,
        "/s/memories/a.md",
        { name: "a", type: "memory" },
        "a",
        deriveEntryProvenance({ bundleId: "s", componentId: "s", adapterId: "akm" }, "memory", "a"),
      );
      upsertEmbedding(db, id, [1, 0, 0, 0]);
      setMeta(db, "version", String(DB_VERSION - 1));
      closeDatabase(db);

      db = openIndexDatabase(dbPath, { embeddingDim: 4 });
      try {
        expect(getEntryCount(db)).toBe(1);
        expect(getEmbeddingCount(db)).toBe(1);
        expect(getMeta(db, "version")).toBe(String(DB_VERSION));
      } finally {
        closeDatabase(db);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
