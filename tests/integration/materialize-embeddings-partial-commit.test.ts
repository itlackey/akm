// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #954: `generateEmbeddingsForDb` used to buffer every embedding in memory
 * and write them all in ONE `db.transaction()` at the very end of the whole
 * run — worse than "commit per chunk", it was "commit once, if the run ever
 * finishes at all". A competing-process collision or any error partway
 * through discarded every embedding already computed (the reporter's
 * observation: "after an hour, embeddings still had 0 rows").
 *
 * These tests drive `generateEmbeddingsForDb` directly against a real
 * index.db (hence tests/integration/ per the ORG-03..06 classification rule)
 * with a fake embedder (via `_setEmbedderForTests`) that calls the provider
 * `onBatch` callback for two batches and then throws, simulating a crash
 * partway through a run — and assert the two already-completed batches'
 * rows survive the eventual failure.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AkmConfig } from "../../src/core/config/config";
import { deriveEntryProvenance, deriveInstallations } from "../../src/indexer/installations";
import { generateEmbeddingsForDb } from "../../src/indexer/materialize-embeddings";
import { buildSearchText } from "../../src/indexer/search/search-fields";
import { _setEmbedderForTests } from "../../src/llm/embedder";
import type { EmbeddingBatchCommit, EmbeddingBatchSkip } from "../../src/llm/embedders/remote";
import type { Database } from "../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../src/storage/repositories/index-entries-repository";
import { getEmbeddingCount } from "../../src/storage/repositories/index-vec-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";
import { overrideSeam } from "../_helpers/seams";

describe("generateEmbeddingsForDb: per-batch commit survives an eventual failure (#954)", () => {
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

  test("a provider embedBatch that commits two batches then throws still persists those two batches' rows (previously 0)", async () => {
    const db = openIndexDatabase();
    try {
      seedEntries(db, 4);

      overrideSeam(_setEmbedderForTests, {
        embedBatch: async (
          _texts: string[],
          _config?: AkmConfig["embedding"],
          _signal?: AbortSignal,
          _onSkip?: (skip: EmbeddingBatchSkip) => void,
          onBatch?: EmbeddingBatchCommit,
        ) => {
          onBatch?.([0], [[0.1, 0.2, 0.3]]);
          onBatch?.([1], [[0.4, 0.5, 0.6]]);
          throw new Error("simulated provider crash after two batches");
        },
      });

      const config = {
        semanticSearchMode: "auto",
        embedding: { endpoint: "http://localhost:1", model: "test-model" },
      } as AkmConfig;

      const result = await generateEmbeddingsForDb(db, config, () => {});

      // The overall pass still reports failure (it never got everything) …
      expect(result.success).toBe(false);
      // … but the two batches that DID complete before the throw are on disk,
      // not discarded — this is the actual fix. The old single-end-of-run
      // transaction would have left this at 0.
      expect(getEmbeddingCount(db)).toBe(2);
    } finally {
      closeDatabase(db);
    }
  });

  test("every successful batch commits even when a later batch is skipped, not just the final one", async () => {
    const db = openIndexDatabase();
    try {
      seedEntries(db, 3);

      overrideSeam(_setEmbedderForTests, {
        embedBatch: async (
          _texts: string[],
          _config?: AkmConfig["embedding"],
          _signal?: AbortSignal,
          onSkip?: (skip: EmbeddingBatchSkip) => void,
          onBatch?: EmbeddingBatchCommit,
        ) => {
          onBatch?.([0], [[0.1, 0.2, 0.3]]);
          onSkip?.({
            index: 1,
            reason: "batch-request-failed",
            message: "synthetic failure",
            batchStart: true,
            batchSize: 1,
            failureKind: "network-error",
          });
          onBatch?.([1], [undefined]);
          onBatch?.([2], [[0.7, 0.8, 0.9]]);
          // Deliberately wrong/unused return value: the materializer must
          // rely on the onBatch commits above, not on the resolved array
          // (#954 — that array is no longer read at all).
          return [undefined, undefined, undefined];
        },
      });

      const config = {
        semanticSearchMode: "auto",
        embedding: { endpoint: "http://localhost:1", model: "test-model" },
      } as AkmConfig;

      const result = await generateEmbeddingsForDb(db, config, () => {});

      expect(result.success).toBe(true);
      expect(getEmbeddingCount(db)).toBe(2);
    } finally {
      closeDatabase(db);
    }
  });

  test("emits an Embedded N/M progress event after EVERY committed batch, not just every 500 (#954)", async () => {
    const db = openIndexDatabase();
    try {
      seedEntries(db, 3);

      overrideSeam(_setEmbedderForTests, {
        embedBatch: async (
          _texts: string[],
          _config?: AkmConfig["embedding"],
          _signal?: AbortSignal,
          _onSkip?: (skip: EmbeddingBatchSkip) => void,
          onBatch?: EmbeddingBatchCommit,
        ) => {
          onBatch?.([0], [[0.1, 0.2, 0.3]]);
          onBatch?.([1], [[0.4, 0.5, 0.6]]);
          onBatch?.([2], [[0.7, 0.8, 0.9]]);
          return [undefined, undefined, undefined];
        },
      });

      const config = {
        semanticSearchMode: "auto",
        embedding: { endpoint: "http://localhost:1", model: "test-model" },
      } as AkmConfig;

      const progressMessages: string[] = [];
      const result = await generateEmbeddingsForDb(db, config, (event) => {
        if (event.phase === "embeddings" && /^Embedded \d+\/\d+ entries\.$/.test(event.message)) {
          progressMessages.push(event.message);
        }
      });

      expect(result.success).toBe(true);
      // One progress event per committed batch (3 batches of 1), not
      // bucketed by 500 stored entries — the old bucketing never fired at
      // all for a run this small, leaving a non-verbose caller silent for
      // the whole embedding phase.
      expect(progressMessages).toEqual(["Embedded 1/3 entries.", "Embedded 2/3 entries.", "Embedded 3/3 entries."]);
    } finally {
      closeDatabase(db);
    }
  });
});
