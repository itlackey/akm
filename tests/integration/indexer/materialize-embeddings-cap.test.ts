// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #956: `generateEmbeddingsForDb` truncates a document's embedded
 * text to `embedding.maxInputTokens` (default 512, `DEFAULT_MAX_INPUT_TOKENS`)
 * BEFORE batching, instead of ever skipping a whole batch over one oversized
 * entry. Drives the real materializer against a real index.db (hence
 * tests/integration/, ORG-03/04), with a fake embedder that records the exact
 * text it was handed — the same pattern
 * tests/integration/indexer/embedding-fingerprint.test.ts uses.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AkmConfig } from "../../../src/core/config/config";
import { _setWarnSinkForTests } from "../../../src/core/warn";
import { deriveEntryProvenance, deriveInstallations } from "../../../src/indexer/installations";
import { generateEmbeddingsForDb } from "../../../src/indexer/materialize-embeddings";
import { _setEmbedderForTests } from "../../../src/llm/embedder";
import type { EmbeddingBatchCommit } from "../../../src/llm/embedders/remote";
import { DEFAULT_MAX_INPUT_TOKENS, estimateTokenCount } from "../../../src/llm/embedders/remote";
import type { EmbeddingVector } from "../../../src/llm/embedders/types";
import type { Database } from "../../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import { getEmbeddingCount } from "../../../src/storage/repositories/index-vec-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";
import { overrideSeam } from "../../_helpers/seams";

function configFor(overrides: NonNullable<AkmConfig["embedding"]> = {}): AkmConfig {
  return {
    semanticSearchMode: "auto",
    embedding: { endpoint: "http://localhost:1", model: "test-model", ...overrides },
  } as AkmConfig;
}

describe("generateEmbeddingsForDb: per-document embedding cap (#956)", () => {
  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });
  afterEach(() => {
    storage.cleanup();
    _setWarnSinkForTests(undefined);
  });

  function seedOneEntry(db: Database, searchText: string): void {
    const installation = deriveInstallations([{ path: storage.stashDir, writable: true }])[0];
    const component = installation?.components[0];
    if (!installation || !component) throw new Error("failed to derive a test bundle installation");
    const entry = { name: "big-note", type: "memories", filename: "big-note.md" };
    const provenance = deriveEntryProvenance(
      { bundleId: installation.id, componentId: component.id, adapterId: component.adapter },
      "memories",
      "big-note",
    );
    upsertEntry(db, `${storage.stashDir}/memories/big-note.md`, entry, searchText, provenance);
  }

  test("a 2,000-token entry is embedded as its truncated head, not skipped", async () => {
    const db = openIndexDatabase();
    try {
      const bigText = "x".repeat(8000); // estimateTokenCount = 2000
      seedOneEntry(db, bigText);

      const receivedTexts: string[] = [];
      overrideSeam(_setEmbedderForTests, {
        embedBatch: async (texts, _config, _signal, _onSkip, onBatch?: EmbeddingBatchCommit) => {
          receivedTexts.push(...texts);
          const vectors: EmbeddingVector[] = texts.map(() => [1, 0, 0]);
          onBatch?.(
            texts.map((_t, i) => i),
            vectors,
          );
          return vectors;
        },
      });

      const result = await generateEmbeddingsForDb(db, configFor(), () => {});

      expect(result.success).toBe(true);
      expect(getEmbeddingCount(db)).toBe(1); // embedded, not skipped
      expect(receivedTexts).toHaveLength(1);
      const sentText = receivedTexts[0] as string;
      // Truncated: shorter than the original, and its own estimate fits the
      // default 512-token cap.
      expect(sentText.length).toBeLessThan(bigText.length);
      expect(estimateTokenCount(sentText)).toBeLessThanOrEqual(DEFAULT_MAX_INPUT_TOKENS);
      expect(sentText).toBe(bigText.slice(0, sentText.length));
    } finally {
      closeDatabase(db);
    }
  });

  test("reports how many entries were truncated, once per run, through onProgress only (#954)", async () => {
    const db = openIndexDatabase();
    try {
      seedOneEntry(db, "x".repeat(8000));

      const warnCalls: string[] = [];
      _setWarnSinkForTests((_level, args) => {
        warnCalls.push(args.map(String).join(" "));
      });

      overrideSeam(_setEmbedderForTests, {
        embedBatch: async (texts, _config, _signal, _onSkip, onBatch?: EmbeddingBatchCommit) => {
          const vectors: EmbeddingVector[] = texts.map(() => [1, 0, 0]);
          onBatch?.(
            texts.map((_t, i) => i),
            vectors,
          );
          return vectors;
        },
      });

      const progressMessages: string[] = [];
      await generateEmbeddingsForDb(db, configFor(), (event) => progressMessages.push(event.message));

      // Once, through onProgress (which the index CLI's handler writes to
      // stderr AND the log file via info()) — never ALSO through warn(),
      // which used to print the identical sentence a second time in text
      // mode (#954, field-report follow-up).
      const truncationLines = progressMessages.filter((line) => line.includes("truncated to the"));
      expect(truncationLines).toHaveLength(1);
      expect(truncationLines[0]).toContain("1 entry truncated to the 512-token embedding cap");
      expect(warnCalls.some((line) => line.includes("truncated to the"))).toBe(false);
    } finally {
      closeDatabase(db);
    }
  });

  test("a document already under the cap is embedded unchanged", async () => {
    const db = openIndexDatabase();
    try {
      const smallText = "a short note";
      seedOneEntry(db, smallText);

      const receivedTexts: string[] = [];
      overrideSeam(_setEmbedderForTests, {
        embedBatch: async (texts, _config, _signal, _onSkip, onBatch?: EmbeddingBatchCommit) => {
          receivedTexts.push(...texts);
          const vectors: EmbeddingVector[] = texts.map(() => [1, 0, 0]);
          onBatch?.(
            texts.map((_t, i) => i),
            vectors,
          );
          return vectors;
        },
      });

      const result = await generateEmbeddingsForDb(db, configFor(), () => {});

      expect(result.success).toBe(true);
      expect(receivedTexts).toEqual([smallText]);
    } finally {
      closeDatabase(db);
    }
  });

  test("embedding.maxInputTokens overrides the default cap", async () => {
    const db = openIndexDatabase();
    try {
      const text = "y".repeat(400); // estimateTokenCount = 100
      seedOneEntry(db, text);

      const receivedTexts: string[] = [];
      overrideSeam(_setEmbedderForTests, {
        embedBatch: async (texts, _config, _signal, _onSkip, onBatch?: EmbeddingBatchCommit) => {
          receivedTexts.push(...texts);
          const vectors: EmbeddingVector[] = texts.map(() => [1, 0, 0]);
          onBatch?.(
            texts.map((_t, i) => i),
            vectors,
          );
          return vectors;
        },
      });

      // A cap of 10 tokens (well below the entry's ~100) forces truncation
      // even though the default 512-token cap would have left it whole.
      await generateEmbeddingsForDb(db, configFor({ maxInputTokens: 10 }), () => {});

      expect(receivedTexts).toHaveLength(1);
      expect(estimateTokenCount(receivedTexts[0] as string)).toBeLessThanOrEqual(10);
    } finally {
      closeDatabase(db);
    }
  });
});
