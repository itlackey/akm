// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #954 (field-F4 F4b): the final throughput line's tokens/s figure must sum
 * the CAPPED text actually transmitted to the embedding provider, not the
 * entry's raw (pre-`capEmbeddingText`) search text. Before this fix,
 * `storedTokens += estimateTokenCount(entry.searchText)` accumulated the
 * uncapped estimate while `texts[]` — what `embedBatch` was actually handed
 * — held the capped strings, so every entry over `embedding.maxInputTokens`
 * inflated the reported rate.
 *
 * Drives `generateEmbeddingsForDb` against a real index.db (hence
 * tests/integration/, ORG-03/04) with a fake embedder, same pattern as
 * materialize-embeddings-cap.test.ts. The wall-clock elapsed time baked into
 * the printed line is not itself deterministic, so the test recovers the
 * average tokens-per-stored-entry as `tokensPerSec / entriesPerSec` — the
 * shared (unknown) elapsed time cancels out of that ratio — rather than
 * asserting an exact tokens/s figure.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AkmConfig } from "../../../src/core/config/config";
import { deriveEntryProvenance, deriveInstallations } from "../../../src/indexer/installations";
import { generateEmbeddingsForDb } from "../../../src/indexer/materialize-embeddings";
import { _setEmbedderForTests } from "../../../src/llm/embedder";
import {
  DEFAULT_MAX_INPUT_TOKENS,
  type EmbeddingBatchCommit,
  estimateTokenCount,
} from "../../../src/llm/embedders/remote";
import type { EmbeddingVector } from "../../../src/llm/embedders/types";
import type { Database } from "../../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";
import { overrideSeam } from "../../_helpers/seams";

function configFor(): AkmConfig {
  return {
    semanticSearchMode: "auto",
    embedding: { endpoint: "http://localhost:1", model: "test-model" },
  } as AkmConfig;
}

describe("generateEmbeddingsForDb: throughput line sums the capped text actually sent (#954)", () => {
  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });
  afterEach(() => {
    storage.cleanup();
  });

  function seedEntries(db: Database, texts: string[]): void {
    const installation = deriveInstallations([{ path: storage.stashDir, writable: true }])[0];
    const component = installation?.components[0];
    if (!installation || !component) throw new Error("failed to derive a test bundle installation");
    texts.forEach((text, i) => {
      const name = `entry-${i}`;
      const entry = { name, type: "memories", filename: `${name}.md` };
      const provenance = deriveEntryProvenance(
        { bundleId: installation.id, componentId: component.id, adapterId: component.adapter },
        "memories",
        name,
      );
      upsertEntry(db, `${storage.stashDir}/memories/${name}.md`, entry, text, provenance);
    });
  }

  test("the reported tokens/s reflects the capped text sent, not the raw search text", async () => {
    const db = openIndexDatabase();
    try {
      // Entry A stays under the default 512-token cap unchanged; entry B is
      // 4x the cap and gets truncated by capEmbeddingText before it is ever
      // sent — the exact repro field-F4.md's F4b names.
      const underCapText = "a".repeat(400); // estimateTokenCount = 100
      const overCapText = "b".repeat(4 * DEFAULT_MAX_INPUT_TOKENS * 4); // 4x the cap, pre-truncation
      seedEntries(db, [underCapText, overCapText]);

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

      const messages: string[] = [];
      const result = await generateEmbeddingsForDb(db, configFor(), (e) => messages.push(e.message));
      expect(result.success).toBe(true);

      const finalLine = messages.find((m) => m.startsWith("Stored "));
      expect(finalLine).toBeDefined();
      const match = (finalLine as string).match(/\(([\d.]+) entries\/s, ~(\d+) tokens\/s\)/);
      expect(match).not.toBeNull();
      const entriesPerSec = Number((match as RegExpMatchArray)[1]);
      const tokensPerSec = Number((match as RegExpMatchArray)[2]);
      // storedTokens/elapsedSeconds divided by storedCount/elapsedSeconds
      // cancels the (non-deterministic, wall-clock) elapsed time and
      // recovers the average tokens-per-stored-entry the line's rate was
      // computed from.
      const avgTokensPerEntry = tokensPerSec / entriesPerSec;

      const cappedAvg = (estimateTokenCount(underCapText) + DEFAULT_MAX_INPUT_TOKENS) / 2;
      const uncappedAvg = (estimateTokenCount(underCapText) + estimateTokenCount(overCapText)) / 2;
      expect(uncappedAvg).toBeGreaterThan(cappedAvg * 2); // sanity: the two are far apart

      expect(avgTokensPerEntry).toBeGreaterThan(cappedAvg * 0.5);
      // Closer to the capped average than the uncapped one — pins the fix
      // without depending on the exact (non-deterministic) elapsed time.
      expect(avgTokensPerEntry).toBeLessThan((cappedAvg + uncappedAvg) / 2);
    } finally {
      closeDatabase(db);
    }
  });
});
