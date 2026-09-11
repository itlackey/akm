// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #813 — a failed query embedding is a real search-quality degradation, not
 * ordinary keyword mode. The fallback must stay useful, machine-visible, and
 * safe to print even when the provider/runtime error contains credentials.
 */

import { expect, test } from "bun:test";
import { akmCurate } from "../../../src/commands/read/curate";
import { akmSearch } from "../../../src/commands/read/search";
import type { AkmConfig } from "../../../src/core/config/config";
import { saveConfig } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { _setWarnSinkForTests } from "../../../src/core/warn";
import { deriveObservedEmbeddingIdentity } from "../../../src/indexer/embedding-identity";
import { deriveEntryProvenance } from "../../../src/indexer/installations";
import type { IndexDocument } from "../../../src/indexer/passes/metadata";
import { searchLocal } from "../../../src/indexer/search/db-search";
import { _setEmbedderForTests } from "../../../src/llm/embedder";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../src/storage/repositories/index-entries-repository";

import { setMeta } from "../../../src/storage/repositories/index-meta-repository";
import { upsertUnitVectors } from "../../../src/storage/repositories/units-repository";
import { withIsolatedAkmStorage } from "../../_helpers/sandbox";
import { overrideSeam } from "../../_helpers/seams";
import { seedUnitsForAllEntries } from "../../_helpers/seed-units";

test("query-embedding failure preserves FTS results and returns one sanitized fts-fallback disclosure", async () => {
  const storage = withIsolatedAkmStorage();
  const config: AkmConfig = {
    semanticSearchMode: "auto",
    embedding: {
      endpoint: "http://endpoint-user:endpoint-password@127.0.0.1:1234/v1?api_key=query-secret",
      model: "test-model",
    },
  };
  const warnings: string[] = [];
  overrideSeam(_setWarnSinkForTests, (level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });

  try {
    const db = openIndexDatabase(getDbPath(), { embeddingDim: 4 });
    try {
      const entryId = upsertEntry(
        db,
        `${storage.stashDir}/knowledge/deploy-guide.md`,
        { type: "knowledge", name: "deploy-guide", description: "deploy applications safely" } as IndexDocument,
        "deploy-guide deploy applications safely",
        deriveEntryProvenance(
          { bundleId: "stash", componentId: "stash", adapterId: "akm" },
          "knowledge",
          "deploy-guide",
        ),
      );
      seedUnitsForAllEntries(db);
      // A units_vec row (not the legacy `embeddings` BLOB table, which the
      // units search path never reads) is what makes `tryUnitVecScores` call
      // the mocked `embed()` below instead of short-circuiting on "nothing
      // embedded yet" — the card unit (ordinal 0, fragment_id NULL) is this
      // entry's only unit.
      const cardUnit = db
        .prepare("SELECT unit_hash FROM entry_units WHERE entry_id = ? AND fragment_id IS NULL")
        .get(entryId) as { unit_hash: string };
      upsertUnitVectors(db, [{ hash: cardUnit.unit_hash, identity: "test-identity", vector: [1, 0, 0, 0] }]);
      setMeta(db, "embeddingIdentity", "test-identity");
      setMeta(db, "hasEmbeddings", "1");
      setMeta(db, "stashDir", storage.stashDir);
    } finally {
      closeDatabase(db);
    }

    overrideSeam(_setEmbedderForTests, {
      embed: async () => {
        throw Object.assign(
          new TypeError("Was there a typo in the url or port? endpoint-password query-secret sk-runtime-secret"),
          { code: "ECONNREFUSED" },
        );
      },
    });

    const result = await searchLocal({
      query: "deploy",
      searchType: "any",
      limit: 10,
      stashDir: storage.stashDir,
      sources: [{ path: storage.stashDir }],
      config,
      disableProjectContext: true,
      disableScopedUtility: true,
    });

    expect(result.hits.map((hit) => hit.ref)).toContain("knowledge/deploy-guide");
    expect(result.mode).toBe("fts-fallback");
    expect(result.warnings).toEqual([
      "Vector search unavailable: cannot reach embedding endpoint http://127.0.0.1:1234/v1/embeddings (connection failed) — falling back to keyword search.",
    ]);
    expect(warnings).toEqual([]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("endpoint-user");
    expect(serialized).not.toContain("endpoint-password");
    expect(serialized).not.toContain("query-secret");
    expect(serialized).not.toContain("sk-runtime-secret");
    expect(serialized).not.toContain("typo in the url or port");

    saveConfig(config);
    const publicSearch = await akmSearch({ query: "deploy", skipLogging: true });
    expect(publicSearch.searchMode).toBe("fts-fallback");
    expect(publicSearch.warnings).toEqual(result.warnings);

    const curated = await akmCurate({ query: "deploy applications safely", skipLogging: true });
    expect(curated.searchMode).toBe("fts-fallback");
    expect(curated.warnings).toEqual(result.warnings);

    const intentionalKeyword = await searchLocal({
      query: "deploy",
      searchType: "any",
      limit: 10,
      stashDir: storage.stashDir,
      sources: [{ path: storage.stashDir }],
      config: { semanticSearchMode: "off" },
      disableProjectContext: true,
      disableScopedUtility: true,
    });
    expect(intentionalKeyword.mode).toBe("keyword");
    expect(intentionalKeyword.warnings ?? []).not.toContainEqual(expect.stringContaining("Vector search unavailable"));
    expect(warnings).toEqual([]);
  } finally {
    storage.cleanup();
  }
});

// item 5 — a query embedded under a different identity than the index must
// not be trusted, even when the embedding call itself succeeds and returns a
// vector of the SAME width the index was built at (the brief's named
// scenario: `embedding.model`/`embedding.endpoint` edited, then searched,
// before re-indexing — a genuine width mismatch is already safe, since
// sqlite-vec throws and the existing fallback above engages).
test("a query embedded under a different identity than the index falls back to lexical with an identity-mismatch warning", async () => {
  const storage = withIsolatedAkmStorage();
  const config: AkmConfig = {
    semanticSearchMode: "auto",
    embedding: { endpoint: "http://127.0.0.1:9999/v1", model: "test-model-v2" },
  };

  try {
    const db = openIndexDatabase(getDbPath(), { embeddingDim: 4 });
    try {
      const entryId = upsertEntry(
        db,
        `${storage.stashDir}/knowledge/deploy-guide.md`,
        { type: "knowledge", name: "deploy-guide", description: "deploy applications safely" } as IndexDocument,
        "deploy-guide deploy applications safely",
        deriveEntryProvenance(
          { bundleId: "stash", componentId: "stash", adapterId: "akm" },
          "knowledge",
          "deploy-guide",
        ),
      );
      seedUnitsForAllEntries(db);
      const cardUnit = db
        .prepare("SELECT unit_hash FROM entry_units WHERE entry_id = ? AND fragment_id IS NULL")
        .get(entryId) as { unit_hash: string };
      // The index was built under "test-model-v1" — the identity stored on
      // disk — but `config.embedding.model` above now reads "test-model-v2":
      // the same edit-then-search-before-reindex the brief names.
      const staleIdentity = deriveObservedEmbeddingIdentity(
        { endpoint: config.embedding!.endpoint, model: "test-model-v1" },
        undefined,
        4,
      )!;
      upsertUnitVectors(db, [{ hash: cardUnit.unit_hash, identity: staleIdentity, vector: [1, 0, 0, 0] }]);
      setMeta(db, "embeddingIdentity", staleIdentity);
      setMeta(db, "hasEmbeddings", "1");
      setMeta(db, "stashDir", storage.stashDir);
    } finally {
      closeDatabase(db);
    }

    // The embedding call itself SUCCEEDS — same width (4), just a different
    // model than the index was built under — so this is not the
    // request-failure path the test above covers.
    overrideSeam(_setEmbedderForTests, {
      embed: async () => [1, 0, 0, 0],
    });

    const result = await searchLocal({
      query: "deploy",
      searchType: "any",
      limit: 10,
      stashDir: storage.stashDir,
      sources: [{ path: storage.stashDir }],
      config,
      disableProjectContext: true,
      disableScopedUtility: true,
    });

    // FTS still finds the entry — the fallback preserves lexical results.
    expect(result.hits.map((hit) => hit.ref)).toContain("knowledge/deploy-guide");
    expect(result.mode).toBe("fts-fallback");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toContain("Vector search unavailable");
    expect(result.warnings?.[0]).toContain("different identity than the index was built with");
  } finally {
    storage.cleanup();
  }
});

// item 5 — the companion branch: a query embedded under the SAME identity
// the index was built under must NOT trip the fallback and must reach the
// vec0 KNN as usual.
test("a query embedded under the SAME identity as the index reaches semantic search normally", async () => {
  const storage = withIsolatedAkmStorage();
  const config: AkmConfig = {
    semanticSearchMode: "auto",
    embedding: { endpoint: "http://127.0.0.1:9999/v1", model: "test-model-v2" },
  };

  try {
    const db = openIndexDatabase(getDbPath(), { embeddingDim: 4 });
    let entryId!: number;
    try {
      entryId = upsertEntry(
        db,
        `${storage.stashDir}/knowledge/deploy-guide.md`,
        { type: "knowledge", name: "deploy-guide", description: "deploy applications safely" } as IndexDocument,
        "deploy-guide deploy applications safely",
        deriveEntryProvenance(
          { bundleId: "stash", componentId: "stash", adapterId: "akm" },
          "knowledge",
          "deploy-guide",
        ),
      );
      seedUnitsForAllEntries(db);
      const cardUnit = db
        .prepare("SELECT unit_hash FROM entry_units WHERE entry_id = ? AND fragment_id IS NULL")
        .get(entryId) as { unit_hash: string };
      // The index's stored identity is derived from the SAME config the
      // query will embed under — the identity the query-time check computes
      // for itself matches exactly.
      const matchingIdentity = deriveObservedEmbeddingIdentity(config.embedding, undefined, 4)!;
      upsertUnitVectors(db, [{ hash: cardUnit.unit_hash, identity: matchingIdentity, vector: [1, 0, 0, 0] }]);
      setMeta(db, "embeddingIdentity", matchingIdentity);
      setMeta(db, "hasEmbeddings", "1");
      setMeta(db, "stashDir", storage.stashDir);
    } finally {
      closeDatabase(db);
    }

    overrideSeam(_setEmbedderForTests, {
      embed: async () => [1, 0, 0, 0],
    });

    const result = await searchLocal({
      query: "deploy",
      searchType: "any",
      limit: 10,
      stashDir: storage.stashDir,
      sources: [{ path: storage.stashDir }],
      config,
      disableProjectContext: true,
      disableScopedUtility: true,
    });

    expect(result.hits.map((hit) => hit.ref)).toContain("knowledge/deploy-guide");
    // No identity mismatch — semantic search actually ran (hybrid, since the
    // query also matches lexically), not the fallback.
    expect(result.mode).not.toBe("fts-fallback");
    expect(result.warnings ?? []).not.toContainEqual(expect.stringContaining("Vector search unavailable"));
  } finally {
    storage.cleanup();
  }
});
