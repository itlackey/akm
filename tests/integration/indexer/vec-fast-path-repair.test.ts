// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Opens a real index database, so this belongs under tests/integration/. */
import { expect, test } from "bun:test";
import type { AkmConfig } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { deriveEntryProvenance } from "../../../src/indexer/installations";
import { generateEmbeddingsForDb } from "../../../src/indexer/materialize-embeddings";
import type { IndexDocument } from "../../../src/indexer/passes/metadata";
import { _setEmbedderForTests } from "../../../src/llm/embedder";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import {
  isVecFastPathComplete,
  isVecFastPathReady,
  setVecFastPathReady,
  upsertEmbedding,
} from "../../../src/storage/repositories/index-vec-repository";
import { withIsolatedAkmStorage } from "../../_helpers/sandbox";
import { overrideSeam } from "../../_helpers/seams";

test("a global incremental embedding pass repairs sqlite-vec without calling the provider", async () => {
  const storage = withIsolatedAkmStorage();
  const db = openIndexDatabase(getDbPath(), { embeddingDim: 4 });
  let providerCalls = 0;
  overrideSeam(_setEmbedderForTests, {
    embedBatch: async () => {
      providerCalls++;
      throw new Error("embedding provider must not be called during vec mirror repair");
    },
  });

  try {
    const provenance = deriveEntryProvenance(
      { bundleId: "stash", componentId: "stash", adapterId: "akm" },
      "knowledge",
      "repair-target",
    );
    const entryId = upsertEntry(
      db,
      `${storage.stashDir}/knowledge/repair-target.md`,
      { type: "knowledge", name: "repair-target", description: "repair target" } as IndexDocument,
      "repair target",
      provenance,
    );
    expect(upsertEmbedding(db, entryId, [1, 0, 0, 0]).vec).toBe("ok");
    db.prepare("DELETE FROM entries_vec WHERE id = ?").run(entryId);
    setVecFastPathReady(db, false);

    const messages: string[] = [];
    const config: AkmConfig = { semanticSearchMode: "auto", embedding: { dimension: 4 } };
    const result = await generateEmbeddingsForDb(db, config, (event) => messages.push(event.message));

    expect(result.success).toBe(true);
    expect(providerCalls).toBe(0);
    expect(isVecFastPathComplete(db)).toBe(true);
    expect(isVecFastPathReady(db)).toBe(true);
    expect(messages).toContain("[embed] Repaired 1 missing sqlite-vec row; removed 0 orphans; 0 rejected.");
    expect(messages).toContain("Embeddings already up to date.");
  } finally {
    closeDatabase(db);
    storage.cleanup();
  }
});
