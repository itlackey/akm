// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Every stored vector carries the embedding model (provider fingerprint) it
 * was generated under, and that column is the embedding pass's cursor. A
 * model change therefore re-embeds incrementally: nothing is purged, each row
 * is replaced as its entry is re-embedded, an interrupted pass resumes with
 * only the rows still on the old model, and readers serve only the current
 * model's vectors. (It used to purge the table behind a re-embed "canary",
 * #955.) Drives `generateEmbeddingsForDb` against a real index.db with a fake
 * embedder installed via `_setEmbedderForTests`, hence tests/integration/.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AkmConfig } from "../../../src/core/config/config";
import { _setWarnSinkForTests } from "../../../src/core/warn";
import { deriveEntryProvenance, deriveInstallations } from "../../../src/indexer/installations";
import { generateEmbeddingsForDb } from "../../../src/indexer/materialize-embeddings";
import { buildSearchText } from "../../../src/indexer/search/search-fields";
import { _setEmbedderForTests } from "../../../src/llm/embedder";
import type { EmbeddingBatchCommit, EmbeddingBatchSkip } from "../../../src/llm/embedders/remote";
import type { EmbeddingVector } from "../../../src/llm/embedders/types";
import type { Database } from "../../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import { getMeta } from "../../../src/storage/repositories/index-meta-repository";
import { getEmbeddingCount, searchVec } from "../../../src/storage/repositories/index-vec-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";
import { overrideSeam } from "../../_helpers/seams";

type EmbedBatchMock = (
  texts: string[],
  config?: AkmConfig["embedding"],
  signal?: AbortSignal,
  onSkip?: (skip: EmbeddingBatchSkip) => void,
  onBatch?: EmbeddingBatchCommit,
) => Promise<(EmbeddingVector | undefined)[]>;

function mockEmbedder(embedBatch: EmbedBatchMock): void {
  overrideSeam(_setEmbedderForTests, { embedBatch });
}

/** A stable, distinct vector per entry index — "the same model" every call. */
function stableVec(i: number): EmbeddingVector {
  return [1 + i, 2 + i, 3 + i];
}

/** A vector that shares no direction with `stableVec` — "a different model". */
function orthogonalVec(i: number): EmbeddingVector {
  return [3 + i, -(1 + i), 0.001];
}

function configWithModel(model: string, overrides: Partial<NonNullable<AkmConfig["embedding"]>> = {}): AkmConfig {
  return {
    semanticSearchMode: "auto",
    embedding: { endpoint: "http://localhost:1", model, ...overrides },
  } as AkmConfig;
}

/** A single-batch, always-succeeds mock that commits through `onBatch` (#954). */
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

describe("generateEmbeddingsForDb: per-row embedding model", () => {
  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });
  afterEach(() => {
    storage.cleanup();
    _setWarnSinkForTests(undefined);
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

  function rowCount(db: Database): number {
    return (db.prepare("SELECT COUNT(*) AS n FROM embeddings").get() as { n: number }).n;
  }

  test("a model change re-embeds every entry under the new model without dropping a row", async () => {
    const db = openIndexDatabase();
    try {
      seedEntries(db, 3);
      mockEmbedder(simpleMock(stableVec));
      expect((await generateEmbeddingsForDb(db, configWithModel("model-a"), () => {})).success).toBe(true);
      const modelA = getMeta(db, "embeddingFingerprint");
      expect(getEmbeddingCount(db, modelA)).toBe(3);

      const embedded: string[] = [];
      mockEmbedder(async (texts, config, signal, onSkip, onBatch) => {
        embedded.push(...texts);
        // Nothing was purged before the first provider request.
        expect(rowCount(db)).toBe(3);
        return simpleMock(orthogonalVec)(texts, config, signal, onSkip, onBatch);
      });
      const messages: string[] = [];
      const warnCalls: string[] = [];
      _setWarnSinkForTests((_level, args) => warnCalls.push(args.map(String).join(" ")));
      const second = await generateEmbeddingsForDb(db, configWithModel("model-b"), (e) => messages.push(e.message));

      expect(second.success).toBe(true);
      expect(embedded).toHaveLength(3);
      const modelB = getMeta(db, "embeddingFingerprint");
      expect(modelB).toContain("model-b");
      expect(rowCount(db)).toBe(3);
      expect(getEmbeddingCount(db, modelB)).toBe(3);
      expect(getEmbeddingCount(db, modelA)).toBe(0);
      // Once, through onProgress only (#954) — never ALSO through warn().
      expect(messages.filter((m) => m.includes("Re-embedding 3 entries") && m.includes("model changed"))).toHaveLength(
        1,
      );
      expect(warnCalls.some((m) => m.includes("Re-embedding"))).toBe(false);
    } finally {
      closeDatabase(db);
    }
  });

  test("an interrupted model change keeps the old rows, serves only the new model, and resumes with the rest", async () => {
    const db = openIndexDatabase();
    try {
      seedEntries(db, 3);
      mockEmbedder(simpleMock(stableVec));
      expect((await generateEmbeddingsForDb(db, configWithModel("model-a"), () => {})).success).toBe(true);

      mockEmbedder(async (_texts, _config, _signal, _onSkip, onBatch) => {
        onBatch?.([0], [orthogonalVec(0)]);
        throw new Error("simulated crash mid-re-embed");
      });
      const interrupted = await generateEmbeddingsForDb(db, configWithModel("model-b"), () => {});
      expect(interrupted.success).toBe(false);
      const modelB = getMeta(db, "embeddingFingerprint");
      expect(modelB).toContain("model-b");
      expect(rowCount(db)).toBe(3);
      expect(getEmbeddingCount(db, modelB)).toBe(1);

      // Only the vector generated under the current model is comparable with
      // a current-model query vector.
      const neighbours = searchVec(db, orthogonalVec(0), 10);
      expect(neighbours).toHaveLength(1);

      const resumedTexts: string[] = [];
      mockEmbedder(async (texts, config, signal, onSkip, onBatch) => {
        resumedTexts.push(...texts);
        return simpleMock(orthogonalVec)(texts, config, signal, onSkip, onBatch);
      });
      expect((await generateEmbeddingsForDb(db, configWithModel("model-b"), () => {})).success).toBe(true);
      expect(resumedTexts).toHaveLength(2);
      expect(getEmbeddingCount(db, modelB)).toBe(3);
      expect(rowCount(db)).toBe(3);
    } finally {
      closeDatabase(db);
    }
  });

  test("an unchanged model makes no provider call; --reembed re-embeds everything", async () => {
    const db = openIndexDatabase();
    try {
      seedEntries(db, 3);
      const config = configWithModel("model-a");
      let calls = 0;
      mockEmbedder(async (...args) => {
        calls++;
        return simpleMock(stableVec)(...args);
      });
      expect((await generateEmbeddingsForDb(db, config, () => {})).success).toBe(true);
      expect(calls).toBe(1);

      expect((await generateEmbeddingsForDb(db, config, () => {})).success).toBe(true);
      expect(calls).toBe(1);

      const forced = await generateEmbeddingsForDb(db, config, () => {}, undefined, undefined, { forceReembed: true });
      expect(forced.success).toBe(true);
      expect(calls).toBe(2);
      expect(getEmbeddingCount(db)).toBe(3);
    } finally {
      closeDatabase(db);
    }
  });
});
