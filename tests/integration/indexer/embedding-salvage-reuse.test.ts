// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #955: a full rebuild or an index-generation bump used to re-embed the
 * whole corpus even when no content changed, because `deleteAllEntries` /
 * `rebuildIncompatibleIndexGeneration` discard `embeddings` unconditionally
 * and the two tables share no key once the old rows are gone. Embedding
 * salvage copies vectors aside at the moment they would otherwise be
 * discarded (keyed by `sha256(search_text)` + the fingerprint they were
 * generated under) so the next embedding pass can hand them straight back
 * without a provider call.
 *
 * These tests drive real `index.db` connections (`openIndexDatabase` /
 * `akmIndex`), hence tests/integration/ per the ORG-03..06 classification
 * rule, with a fake embedder installed via `_setEmbedderForTests` so a
 * "provider call" is directly observable/countable.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { akmIndex, type IndexProgressEvent } from "../../../src/indexer/indexer";
import { deriveEntryProvenance, deriveInstallations } from "../../../src/indexer/installations";
import { generateEmbeddingsForDb } from "../../../src/indexer/materialize-embeddings";
import { buildSearchText } from "../../../src/indexer/search/search-fields";
import { _setEmbedderForTests } from "../../../src/llm/embedder";
import type { EmbeddingBatchCommit, EmbeddingBatchSkip } from "../../../src/llm/embedders/remote";
import type { EmbeddingVector } from "../../../src/llm/embedders/types";
import type { Database } from "../../../src/storage/database";
import {
  hashEmbeddableText,
  salvageEmbeddingsBeforeDiscard,
} from "../../../src/storage/repositories/embedding-salvage-repository";
import {
  closeDatabase,
  openExistingDatabase,
  openIndexDatabase,
} from "../../../src/storage/repositories/index-connection";
import { deleteAllEntries, upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import { getMeta } from "../../../src/storage/repositories/index-meta-repository";
import { getEmbeddingCount } from "../../../src/storage/repositories/index-vec-repository";
import {
  type Cleanup,
  type IsolatedAkmStorage,
  sandboxEnvDir,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../../_helpers/sandbox";
import { overrideSeam } from "../../_helpers/seams";

type EmbedBatchMock = (
  texts: string[],
  config?: AkmConfig["embedding"],
  signal?: AbortSignal,
  onSkip?: (skip: EmbeddingBatchSkip) => void,
  onBatch?: EmbeddingBatchCommit,
) => Promise<(EmbeddingVector | undefined)[]>;

function stableVec(i: number): EmbeddingVector {
  return [1 + i, 2 + i, 3 + i];
}

function salvageRowCount(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM embedding_salvage").get() as { c: number }).c;
}

function entriesVecCount(db: Database): number {
  try {
    return (db.prepare("SELECT COUNT(*) AS c FROM entries_vec").get() as { c: number }).c;
  } catch {
    return -1; // sqlite-vec unavailable in this environment
  }
}

// ── Scenarios driven through the real akmIndex end-to-end path ─────────────

describe("embedding salvage across full rebuilds (#955, akmIndex end-to-end)", () => {
  let stashDir = "";
  let cleanup: Cleanup = () => {};
  let providerCalls = 0;
  let lastProviderTextCount = 0;

  function writeMemory(name: string, description: string, body: string): void {
    const file = path.join(stashDir, "memories", `${name}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `---\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`, "utf8");
  }

  function installCountingEmbedder(): void {
    providerCalls = 0;
    lastProviderTextCount = 0;
    const mock: EmbedBatchMock = async (texts, _config, _signal, _onSkip, onBatch) => {
      providerCalls++;
      lastProviderTextCount = texts.length;
      const vectors = texts.map((_t, i) => stableVec(i));
      onBatch?.(
        texts.map((_t, i) => i),
        vectors,
      );
      return vectors;
    };
    overrideSeam(_setEmbedderForTests, { embedBatch: mock });
  }

  function openDb(): Database {
    const db = openExistingDatabase(getDbPath());
    if (!db) throw new Error("expected an existing index.db");
    return db;
  }

  beforeEach(() => {
    const stash = sandboxStashDir();
    stashDir = stash.dir;
    let chain = sandboxXdgConfigHome(stash.cleanup).cleanup;
    chain = sandboxXdgCacheHome(chain).cleanup;
    chain = sandboxEnvDir("akm-salvage-data", "AKM_DATA_DIR", chain).cleanup;
    chain = sandboxEnvDir("akm-salvage-state", "AKM_STATE_DIR", chain).cleanup;
    cleanup = chain;
    writeSandboxConfig({ semanticSearchMode: "auto" });
    installCountingEmbedder();
  });

  afterEach(() => cleanup());

  test("a second `--full` run on an unchanged corpus makes zero provider calls and reuses every vector", async () => {
    writeMemory("alpha", "alpha memory", "Alpha body.");
    writeMemory("bravo", "bravo memory", "Bravo body.");
    writeMemory("charlie", "charlie memory", "Charlie body.");

    const first = await akmIndex({ stashDir, full: true });
    expect(first.verification.ok).toBe(true);
    expect(providerCalls).toBe(1);
    expect(lastProviderTextCount).toBe(3);

    const db1 = openDb();
    const embeddingsAfterFirst = getEmbeddingCount(db1);
    const vecAfterFirst = entriesVecCount(db1);
    const salvageAfterFirst = salvageRowCount(db1);
    closeDatabase(db1);
    expect(embeddingsAfterFirst).toBe(3);
    expect(salvageAfterFirst).toBe(0);

    providerCalls = 0;
    const messages: string[] = [];
    const second = await akmIndex({
      stashDir,
      full: true,
      onProgress: (event: IndexProgressEvent) => messages.push(event.message),
    });
    expect(second.verification.ok).toBe(true);

    // The whole point: NOTHING went to the provider the second time.
    expect(providerCalls).toBe(0);
    expect(messages.some((m) => m.includes("Reused 3 embedding"))).toBe(true);

    const db2 = openDb();
    try {
      expect(getEmbeddingCount(db2)).toBe(embeddingsAfterFirst);
      if (vecAfterFirst >= 0) expect(entriesVecCount(db2)).toBe(vecAfterFirst);
      expect(salvageRowCount(db2)).toBe(0);
    } finally {
      closeDatabase(db2);
    }
  });

  test("editing one entry between two `--full` runs sends only that entry to the provider", async () => {
    writeMemory("alpha", "alpha memory", "Alpha body.");
    writeMemory("bravo", "bravo memory", "Bravo body.");
    writeMemory("charlie", "charlie memory", "Charlie body.");

    const first = await akmIndex({ stashDir, full: true });
    expect(first.verification.ok).toBe(true);
    expect(providerCalls).toBe(1);

    // Change bravo's description — this changes buildSearchText's output, so
    // its content hash no longer matches the salvaged vector.
    writeMemory("bravo", "bravo memory revised", "Bravo body.");

    providerCalls = 0;
    lastProviderTextCount = 0;
    const messages: string[] = [];
    const second = await akmIndex({
      stashDir,
      full: true,
      onProgress: (event: IndexProgressEvent) => messages.push(event.message),
    });
    expect(second.verification.ok).toBe(true);

    expect(providerCalls).toBe(1);
    expect(lastProviderTextCount).toBe(1);
    expect(messages.some((m) => m.includes("Reused 2 embedding"))).toBe(true);

    const db = openDb();
    try {
      expect(getEmbeddingCount(db)).toBe(3);
      expect(salvageRowCount(db)).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });
});

// ── Canary-adjacent scenarios driven directly against generateEmbeddingsForDb ─
//
// The fingerprint-rename canary only ever samples entries that CURRENTLY
// carry an embedding (`sampleEmbeddedEntriesForCanary`); a plain `--full`
// akmIndex run wipes every embedding before the embedding phase even starts,
// so its canary sample is always empty. These interactions are therefore
// exercised the same way the pre-existing #955 canary suite does — direct
// `generateEmbeddingsForDb` calls against a real index.db seeded with both
// live embeddings (for the canary to sample) and leftover salvage rows (as a
// full rebuild would leave behind).

describe("embedding salvage: canary interactions (#955, generateEmbeddingsForDb direct)", () => {
  // Each test opens `openIndexDatabase()` with no explicit path — it resolves
  // against AKM_DATA_DIR/XDG_DATA_HOME, which `tests/_preload.ts` otherwise
  // points at ONE per-process sandbox shared by every test in this file.
  // `withIsolatedAkmStorage()` gives each test its own index.db so entry/
  // embedding counts asserted below cannot leak across tests.
  let storage: IsolatedAkmStorage;

  function seedEntries(db: Database, names: string[]): number[] {
    const installation = deriveInstallations([{ path: storage.stashDir, writable: true }])[0];
    const component = installation?.components[0];
    if (!installation || !component) throw new Error("failed to derive a test bundle installation");
    return names.map((name) => {
      const entry = { name, type: "memories", filename: `${name}.md` };
      const provenance = deriveEntryProvenance(
        { bundleId: installation.id, componentId: component.id, adapterId: component.adapter },
        "memories",
        name,
      );
      return upsertEntry(db, `${storage.stashDir}/memories/${name}.md`, entry, buildSearchText(entry), provenance);
    });
  }

  function searchTextFor(name: string): string {
    return buildSearchText({ name, type: "memories", filename: `${name}.md` });
  }

  function configWithModel(model: string): AkmConfig {
    return {
      semanticSearchMode: "auto",
      embedding: { endpoint: "http://localhost:1", model },
    } as AkmConfig;
  }

  function mockEmbedder(fn: EmbedBatchMock): void {
    overrideSeam(_setEmbedderForTests, { embedBatch: fn });
  }

  function simpleMock(vecFor: (i: number) => EmbeddingVector): EmbedBatchMock {
    return async (texts, _config, _signal, _onSkip, onBatch) => {
      const vectors = texts.map((_t, i) => vecFor(i));
      onBatch?.(
        texts.map((_t, i) => i),
        vectors,
      );
      return vectors;
    };
  }

  function insertSalvageRow(db: Database, searchText: string, fingerprint: string, vector: EmbeddingVector): void {
    const buf = Buffer.from(new Float32Array(vector).buffer);
    db.prepare(
      "INSERT OR REPLACE INTO embedding_salvage (content_hash, fingerprint, embedding, salvaged_at) VALUES (?, ?, ?, ?)",
    ).run(hashEmbeddableText(searchText), fingerprint, buf, new Date().toISOString());
  }

  function readEmbedding(db: Database, id: number): number[] {
    const row = db.prepare("SELECT embedding FROM embeddings WHERE id = ?").get(id) as
      | { embedding: Buffer }
      | undefined;
    if (!row) throw new Error(`expected an embedding row for id ${id}`);
    const f32 = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
    return Array.from(f32);
  }

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    fs.mkdirSync(path.join(storage.stashDir, "memories"), { recursive: true });
  });

  afterEach(() => storage.cleanup());

  test("a canary 'rebuild' verdict (genuinely different model) purges salvage instead of reusing it", async () => {
    const db = openIndexDatabase();
    try {
      seedEntries(db, ["alpha", "bravo", "charlie"]);
      mockEmbedder(simpleMock(stableVec));
      const first = await generateEmbeddingsForDb(db, configWithModel("model-a"), () => {});
      expect(first.success).toBe(true);
      expect(getEmbeddingCount(db)).toBe(3);

      // Leftover salvage from an earlier, unrelated full rebuild — tagged
      // with the CURRENT (about to be superseded) fingerprint, for an entry
      // that has no live embedding right now.
      const [deltaId] = seedEntries(db, ["delta"]);
      insertSalvageRow(db, searchTextFor("delta"), getMeta(db, "embeddingFingerprint") ?? "model-a", [9, 9, 9]);
      expect(salvageRowCount(db)).toBe(1);

      let calls = 0;
      let lastTextCount = 0;
      mockEmbedder(async (texts, _config, _signal, _onSkip, onBatch) => {
        calls++;
        lastTextCount = texts.length;
        // Genuinely different model: orthogonal vectors both for the canary
        // probe AND (if reached) the main pass.
        const vectors = texts.map((_t, i): EmbeddingVector => [3 + i, -(1 + i), 0.001]);
        onBatch?.(
          texts.map((_t, i) => i),
          vectors,
        );
        return vectors;
      });
      const second = await generateEmbeddingsForDb(db, configWithModel("model-b"), () => {});
      expect(second.success).toBe(true);
      // Canary call (1) + main pass (1): delta was NOT reused from the stale
      // salvage row, so it is among the entries the main pass re-embeds.
      expect(calls).toBe(2);
      expect(lastTextCount).toBe(4); // alpha, bravo, charlie, delta — all rebuilt
      expect(getEmbeddingCount(db)).toBe(4);
      expect(salvageRowCount(db)).toBe(0);

      // delta's stored vector is the rebuilt one, not the stale [9,9,9] salvage row.
      expect(readEmbedding(db, deltaId as number)[0]).not.toBe(9);
    } finally {
      closeDatabase(db);
    }
  });

  test("a canary 'keep' verdict (renamed fingerprint, same model) relabels salvage so it stays reusable", async () => {
    const db = openIndexDatabase();
    try {
      seedEntries(db, ["alpha", "bravo", "charlie"]);
      mockEmbedder(simpleMock(stableVec));
      const first = await generateEmbeddingsForDb(db, configWithModel("model-a"), () => {});
      expect(first.success).toBe(true);
      const oldFingerprint = getMeta(db, "embeddingFingerprint");
      if (!oldFingerprint) throw new Error("expected a stored fingerprint after the first pass");

      // Leftover salvage from an earlier full rebuild, tagged with the OLD
      // fingerprint string, for an entry with no live embedding.
      const [deltaId] = seedEntries(db, ["delta"]);
      insertSalvageRow(db, searchTextFor("delta"), oldFingerprint, stableVec(0));
      expect(salvageRowCount(db)).toBe(1);

      let calls = 0;
      mockEmbedder(async (texts, _config, _signal, _onSkip, onBatch) => {
        calls++;
        // First call is the canary probe (alpha/bravo/charlie); a SECOND
        // call would mean delta was NOT reused from the relabeled salvage
        // row and instead went through the main pass — give it an easily
        // distinguishable vector so a regression is unmistakable.
        const vectors = texts.map((_t, i): EmbeddingVector => (calls === 1 ? stableVec(i) : [99, 99, 99]));
        onBatch?.(
          texts.map((_t, i) => i),
          vectors,
        );
        return vectors;
      });
      const second = await generateEmbeddingsForDb(db, configWithModel("model-a-renamed"), () => {});
      expect(second.success).toBe(true);

      const newFingerprint = getMeta(db, "embeddingFingerprint");
      expect(newFingerprint).not.toBe(oldFingerprint);
      // Only the canary probe ran — delta was reused from the relabeled
      // salvage row, never reaching a main-pass provider call.
      expect(calls).toBe(1);
      expect(getEmbeddingCount(db)).toBe(4);
      expect(readEmbedding(db, deltaId as number)).toEqual(stableVec(0));
      // The pass completed successfully, so the (now fully consumed)
      // salvage table was purged at the end.
      expect(salvageRowCount(db)).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });

  test("--reembed forces every entry through the provider; salvage is purged, never consulted", async () => {
    const db = openIndexDatabase();
    try {
      seedEntries(db, ["alpha", "bravo"]);
      mockEmbedder(simpleMock(stableVec));
      const config = configWithModel("model-a");
      const first = await generateEmbeddingsForDb(db, config, () => {});
      expect(first.success).toBe(true);

      // Salvage row under the SAME fingerprint the forced rebuild would
      // otherwise be willing to reuse from, for an entry that (before
      // --reembed) has no live embedding.
      seedEntries(db, ["charlie"]);
      insertSalvageRow(db, searchTextFor("charlie"), getMeta(db, "embeddingFingerprint") ?? "model-a", stableVec(0));
      expect(salvageRowCount(db)).toBe(1);

      let lastTextCount = 0;
      mockEmbedder(async (texts, _config, _signal, _onSkip, onBatch) => {
        lastTextCount = texts.length;
        const vectors = texts.map((_t, i) => stableVec(i));
        onBatch?.(
          texts.map((_t, i) => i),
          vectors,
        );
        return vectors;
      });
      const forced = await generateEmbeddingsForDb(db, config, () => {}, undefined, undefined, { forceReembed: true });
      expect(forced.success).toBe(true);
      // All 3 entries (alpha, bravo, charlie) went to the provider — charlie
      // was NOT quietly reused from the salvage row that would have matched.
      expect(lastTextCount).toBe(3);
      expect(getEmbeddingCount(db)).toBe(3);
      expect(salvageRowCount(db)).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });

  test("a failed pass leaves salvage intact; a later full-scope retry reuses it", async () => {
    const db = openIndexDatabase();
    try {
      const config = configWithModel("model-a");
      seedEntries(db, ["alpha", "bravo", "charlie"]);
      mockEmbedder(simpleMock(stableVec));
      const first = await generateEmbeddingsForDb(db, config, () => {});
      expect(first.success).toBe(true);
      expect(getEmbeddingCount(db)).toBe(3);

      // Simulate the exact salvage-then-discard sequence a full rebuild
      // performs, inside one transaction, then reinsert the same three
      // entries (new ids, unchanged search_text) plus a brand-new entry
      // that never had an embedding.
      db.transaction(() => {
        salvageEmbeddingsBeforeDiscard(db);
        deleteAllEntries(db);
      })();
      seedEntries(db, ["alpha", "bravo", "charlie"]);
      const [deltaId] = seedEntries(db, ["delta"]);
      expect(salvageRowCount(db)).toBe(3);
      expect(getEmbeddingCount(db)).toBe(0);

      // First attempt is scoped to ONLY the new entry (as a targeted write
      // would be) and its provider call fails outright — alpha/bravo/
      // charlie's salvage rows are never even looked at by this call.
      mockEmbedder(async () => {
        throw new Error("simulated provider crash");
      });
      const failed = await generateEmbeddingsForDb(db, config, () => {}, undefined, [deltaId as number]);
      expect(failed.success).toBe(false);
      expect(salvageRowCount(db)).toBe(3);
      expect(getEmbeddingCount(db)).toBe(0);

      // A later full-scope run (the retry) finds alpha/bravo/charlie's
      // salvage rows still there and reuses all three with zero provider
      // calls for them; only delta needs the (now working) provider.
      let calls = 0;
      let lastTextCount = 0;
      mockEmbedder(async (texts, _config, _signal, _onSkip, onBatch) => {
        calls++;
        lastTextCount = texts.length;
        const vectors = texts.map((_t, i) => stableVec(i));
        onBatch?.(
          texts.map((_t, i) => i),
          vectors,
        );
        return vectors;
      });
      const messages: string[] = [];
      const retried = await generateEmbeddingsForDb(db, config, (e) => messages.push(e.message));
      expect(retried.success).toBe(true);
      expect(calls).toBe(1);
      expect(lastTextCount).toBe(1); // only delta went to the provider
      expect(messages.some((m) => m.includes("Reused 3 embedding"))).toBe(true);
      expect(getEmbeddingCount(db)).toBe(4);
      expect(salvageRowCount(db)).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });
});

// ── Storage-layer contract: salvage must never be swept by deleteAllEntries ─

describe("embedding salvage: exempt from deleteAllEntries (#955)", () => {
  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });
  afterEach(() => storage.cleanup());

  test("deleteAllEntries wipes entries and embeddings but never touches embedding_salvage", () => {
    const db = openIndexDatabase();
    try {
      const installation = deriveInstallations([{ path: storage.stashDir, writable: true }])[0];
      const component = installation?.components[0];
      if (!installation || !component) throw new Error("failed to derive a test bundle installation");
      const entry = { name: "solo", type: "memories", filename: "solo.md" };
      const provenance = deriveEntryProvenance(
        { bundleId: installation.id, componentId: component.id, adapterId: component.adapter },
        "memories",
        "solo",
      );
      upsertEntry(db, path.join(storage.stashDir, "solo.md"), entry, buildSearchText(entry), provenance);

      db.prepare(
        "INSERT INTO embedding_salvage (content_hash, fingerprint, embedding, salvaged_at) VALUES (?, ?, ?, ?)",
      ).run("deadbeef", "local:test", Buffer.from(new Float32Array([1, 2, 3]).buffer), new Date().toISOString());
      expect(salvageRowCount(db)).toBe(1);

      deleteAllEntries(db);

      expect((db.prepare("SELECT COUNT(*) AS c FROM entries").get() as { c: number }).c).toBe(0);
      expect(salvageRowCount(db)).toBe(1);
    } finally {
      closeDatabase(db);
    }
  });
});

// ── semanticSearchMode "off" must drain salvage, not orphan it (#955) ─────
//
// Salvage is supposed to be zero-steady-state / self-emptying: a full
// rebuild performed with semantic search disabled never reaches the reuse
// step (generateEmbeddingsForDb returns before it), so nothing will ever
// consume rows a prior rebuild salvaged. Without an explicit purge on this
// path they would sit in embedding_salvage forever.

describe('embedding salvage: purged when semanticSearchMode is "off" (#955)', () => {
  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });
  afterEach(() => storage.cleanup());

  test("a disabled-semantic-search pass purges leftover salvage instead of leaving it orphaned", async () => {
    const db = openIndexDatabase();
    try {
      db.prepare(
        "INSERT INTO embedding_salvage (content_hash, fingerprint, embedding, salvaged_at) VALUES (?, ?, ?, ?)",
      ).run("deadbeef", "local:test", Buffer.from(new Float32Array([1, 2, 3]).buffer), new Date().toISOString());
      expect(salvageRowCount(db)).toBe(1);

      const result = await generateEmbeddingsForDb(db, { semanticSearchMode: "off" } as AkmConfig, () => {});
      expect(result.success).toBe(false);
      expect(salvageRowCount(db)).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });
});
