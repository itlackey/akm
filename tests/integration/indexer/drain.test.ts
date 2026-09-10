// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * B4 (docs/plans/index-redesign-contract.md): `drainEmbeddingQueue` against a
 * real temp index.db, with a mocked embedder (`_setEmbedderForTests`) so
 * every scenario is deterministic and network-free. `embedding.endpoint` is
 * still set to `http://localhost:1` (the same fails-fast convention
 * tests/integration/indexer/embedding-per-batch-progress.test.ts uses) so
 * `probeProviderLimits`'s own real HTTP probe — reused as-is, not mocked —
 * fails immediately instead of hanging, and so a learned identity takes the
 * "remote:<model>|<dim>" shape.
 *
 * `unit_texts` (B1's table) and `units`/`units_vec` (A2's store, already
 * wired into ensureSchema) are both real: this suite seeds `unit_texts`
 * directly via the stage-2 stub in
 * src/storage/repositories/unit-texts-repository.ts.
 *
 * Integration-scoped (ORG-03/06): opens a real index.db via
 * `openIndexDatabase`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AkmConfig } from "../../../src/core/config/config";
import { drainEmbeddingQueue } from "../../../src/indexer/drain";
import { _setEmbedderForTests } from "../../../src/llm/embedder";
import type { EmbeddingBatchCommit, EmbeddingBatchSkip } from "../../../src/llm/embedders/remote";
import type { EmbeddingVector } from "../../../src/llm/embedders/types";
import type { Database } from "../../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { getMeta } from "../../../src/storage/repositories/index-meta-repository";
import { ensureUnitTextsTable } from "../../../src/storage/repositories/unit-texts-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";
import { overrideSeam } from "../../_helpers/seams";

/** Vector dimension used throughout — matches the `embeddingDim` the test db is opened at, so `units_vec` never needs to be recreated at a new width mid-test. */
const TEST_DIM = 3;

function stableVec(i: number): EmbeddingVector {
  return [1 + i, 2 + i, 3 + i];
}

type EmbedBatchMock = (
  texts: string[],
  config?: AkmConfig["embedding"],
  signal?: AbortSignal,
  onSkip?: (skip: EmbeddingBatchSkip) => unknown,
  onBatch?: EmbeddingBatchCommit,
) => Promise<(EmbeddingVector | undefined)[]>;

function baseConfig(): AkmConfig {
  return {
    semanticSearchMode: "auto",
    // localhost:1 fails fast (connection refused) — probeProviderLimits's
    // real HTTP probe (reused unmocked) never hangs waiting on it. Matches
    // the existing convention in embedding-per-batch-progress.test.ts.
    embedding: { endpoint: "http://localhost:1", model: "mock-model" },
  } as AkmConfig;
}

function seedUnitTexts(db: Database, hashes: readonly string[]): void {
  ensureUnitTextsTable(db);
  const insert = db.prepare("INSERT INTO unit_texts (unit_hash, kind, text) VALUES (?, 'card', ?)");
  for (const hash of hashes) insert.run(hash, `text for ${hash}`);
}

function unitRowCount(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM units").get() as { c: number }).c;
}

let storage: IsolatedAkmStorage;
let db: Database;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  db = openIndexDatabase(undefined, { embeddingDim: TEST_DIM });
});

afterEach(() => {
  closeDatabase(db);
  storage.cleanup();
});

describe("drainEmbeddingQueue (B4)", () => {
  test("identity is learned from the first response and adopted", async () => {
    seedUnitTexts(db, ["h1", "h2", "h3"]);
    expect(getMeta(db, "embeddingIdentity")).toBeUndefined();

    let calls = 0;
    const mock: EmbedBatchMock = async (texts, _config, _signal, _onSkip, onBatch) => {
      calls++;
      const vectors = texts.map((_t, i) => stableVec(i));
      onBatch?.(
        texts.map((_t, i) => i),
        vectors,
        "mock-model",
      );
      return vectors;
    };
    overrideSeam(_setEmbedderForTests, { embedBatch: mock });

    const result = await drainEmbeddingQueue(db, baseConfig(), {});

    expect(calls).toBe(1);
    expect(result).toEqual({ pending: 3, embedded: 3, failed: 0, skipped: 0, identity: "remote:mock-model|3" });
    expect(getMeta(db, "embeddingIdentity")).toBe("remote:mock-model|3");
    expect(unitRowCount(db)).toBe(3);
  });

  test("resume after a simulated kill mid-drain embeds only what is still missing", async () => {
    seedUnitTexts(db, ["h1", "h2", "h3", "h4", "h5"]);

    const interruptingMock: EmbedBatchMock = async (texts, _config, _signal, _onSkip, onBatch) => {
      const committed = Math.min(3, texts.length);
      onBatch?.(
        Array.from({ length: committed }, (_v, i) => i),
        Array.from({ length: committed }, (_v, i) => stableVec(i)),
        "mock-model",
      );
      throw new Error("simulated interruption mid-drain");
    };
    overrideSeam(_setEmbedderForTests, { embedBatch: interruptingMock });

    await expect(drainEmbeddingQueue(db, baseConfig(), {})).rejects.toThrow("simulated interruption mid-drain");

    // The 3 committed via onBatch landed before the throw — per-batch commit
    // durability, not restart-from-zero.
    expect(unitRowCount(db)).toBe(3);
    const identityAfterInterrupt = getMeta(db, "embeddingIdentity");
    expect(identityAfterInterrupt).toBe("remote:mock-model|3");

    let resumeCalls = 0;
    let resumeTextCount = 0;
    const resumeMock: EmbedBatchMock = async (texts, _config, _signal, _onSkip, onBatch) => {
      resumeCalls++;
      resumeTextCount = texts.length;
      const vectors = texts.map((_t, i) => stableVec(i + 10));
      onBatch?.(
        texts.map((_t, i) => i),
        vectors,
        "mock-model",
      );
      return vectors;
    };
    overrideSeam(_setEmbedderForTests, { embedBatch: resumeMock });

    const resumed = await drainEmbeddingQueue(db, baseConfig(), {});

    // Exactly one provider call, for exactly the 2 still missing — the 3
    // already committed are untouched, no re-send.
    expect(resumeCalls).toBe(1);
    expect(resumeTextCount).toBe(2);
    expect(resumed).toEqual({ pending: 2, embedded: 2, failed: 0, skipped: 0, identity: "remote:mock-model|3" });
    expect(unitRowCount(db)).toBe(5);
  });

  test("onlyHashes bounds the work to exactly the given hashes", async () => {
    seedUnitTexts(db, ["h1", "h2", "h3", "h4"]);

    let seenTexts: string[] = [];
    const mock: EmbedBatchMock = async (texts, _config, _signal, _onSkip, onBatch) => {
      seenTexts = texts;
      const vectors = texts.map((_t, i) => stableVec(i));
      onBatch?.(
        texts.map((_t, i) => i),
        vectors,
        "mock-model",
      );
      return vectors;
    };
    overrideSeam(_setEmbedderForTests, { embedBatch: mock });

    const result = await drainEmbeddingQueue(db, baseConfig(), { onlyHashes: ["h1", "h3"] });

    expect(seenTexts.sort()).toEqual(["text for h1", "text for h3"].sort());
    expect(result.pending).toBe(2);
    expect(result.embedded).toBe(2);
    expect(unitRowCount(db)).toBe(2);

    // h2/h4 were never candidates this call — still pending on a later,
    // unrestricted call.
    let laterTexts: string[] = [];
    const laterMock: EmbedBatchMock = async (texts, _config, _signal, _onSkip, onBatch) => {
      laterTexts = texts;
      const vectors = texts.map((_t, i) => stableVec(i + 20));
      onBatch?.(
        texts.map((_t, i) => i),
        vectors,
        "mock-model",
      );
      return vectors;
    };
    overrideSeam(_setEmbedderForTests, { embedBatch: laterMock });
    const later = await drainEmbeddingQueue(db, baseConfig(), {});
    expect(laterTexts.sort()).toEqual(["text for h2", "text for h4"].sort());
    expect(later.embedded).toBe(2);
    expect(unitRowCount(db)).toBe(4);
  });

  test("limit bounds how many missing units one call embeds", async () => {
    seedUnitTexts(db, ["h1", "h2", "h3", "h4", "h5"]);

    let seenCount = 0;
    const mock: EmbedBatchMock = async (texts, _config, _signal, _onSkip, onBatch) => {
      seenCount = texts.length;
      const vectors = texts.map((_t, i) => stableVec(i));
      onBatch?.(
        texts.map((_t, i) => i),
        vectors,
        "mock-model",
      );
      return vectors;
    };
    overrideSeam(_setEmbedderForTests, { embedBatch: mock });

    const first = await drainEmbeddingQueue(db, baseConfig(), { limit: 2 });
    expect(seenCount).toBe(2);
    expect(first.pending).toBe(5);
    expect(first.embedded).toBe(2);
    expect(unitRowCount(db)).toBe(2);

    const second = await drainEmbeddingQueue(db, baseConfig(), {});
    expect(seenCount).toBe(3);
    expect(second.pending).toBe(3);
    expect(second.embedded).toBe(3);
    expect(unitRowCount(db)).toBe(5);
  });

  test("the circuit breaker still trips after consecutive single-document failures", async () => {
    seedUnitTexts(db, ["h1", "h2", "h3", "h4", "h5", "h6"]);

    let requestCount = 0;
    const failingMock: EmbedBatchMock = async (texts, _config, _signal, onSkip, onBatch) => {
      for (let i = 0; i < texts.length; i++) {
        requestCount++;
        const stop = onSkip?.({
          index: i,
          reason: "batch-request-failed",
          message: "connection refused",
          batchStart: true,
          batchSize: 1,
          failureKind: "network-error",
        });
        onBatch?.([i], [undefined], undefined, {
          batchIndex: i + 1,
          batchCount: texts.length,
          docCount: 1,
          requestTokens: 5,
          elapsedMs: 1,
          outcome: "failed",
          reason: "connection refused",
        });
        if (stop === false) break;
      }
      return texts.map(() => undefined);
    };
    overrideSeam(_setEmbedderForTests, { embedBatch: failingMock });

    const result = await drainEmbeddingQueue(db, baseConfig(), {});

    // Tripped after exactly 3 consecutive single-document network-error
    // failures — the 3 remaining hashes are never dispatched at all.
    expect(requestCount).toBe(3);
    expect(result).toEqual({ pending: 6, embedded: 0, failed: 3, skipped: 3, identity: null });
    expect(unitRowCount(db)).toBe(0);
    expect(getMeta(db, "embeddingIdentity")).toBeUndefined();
  });

  test("no unit_texts rows means nothing pending and the embedder is never called", async () => {
    ensureUnitTextsTable(db);

    let calls = 0;
    const mock: EmbedBatchMock = async (texts) => {
      calls++;
      return texts.map(() => undefined);
    };
    overrideSeam(_setEmbedderForTests, { embedBatch: mock });

    const result = await drainEmbeddingQueue(db, baseConfig(), {});
    expect(calls).toBe(0);
    expect(result).toEqual({ pending: 0, embedded: 0, failed: 0, skipped: 0, identity: null });
  });
});
