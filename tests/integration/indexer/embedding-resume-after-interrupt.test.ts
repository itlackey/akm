// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #956: an index run interrupted mid-embedding-phase must be
 * RESUMABLE, not restarted. Two end-to-end scenarios, both driven through
 * the real `akmIndex()` entry point (not `generateEmbeddingsForDb` directly)
 * against a real index.db, with a fake embedder that partially commits then
 * aborts to simulate a genuine interruption (the owner observed the abort
 * path restarting instead of resuming):
 *
 *  - a plain `akm index` (no `--full`) after an interrupted pass embeds only
 *    the entries still missing a vector — no purge, no canary (the
 *    fingerprint never changed, so that whole branch of
 *    `generateEmbeddingsForDb` never runs);
 *  - a subsequent `akm index --full` reuses the already-embedded entries via
 *    salvage (#955 — the full rebuild's own salvage-before-discard step)
 *    and sends a provider request only for the entries that were never
 *    embedded at all because the interruption landed before they were
 *    reached.
 *
 * Integration-scoped (ORG-03/06): drives `akmIndex` end-to-end against a
 * real index.db.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { akmIndex, type IndexProgressEvent } from "../../../src/indexer/indexer";
import { _setEmbedderForTests } from "../../../src/llm/embedder";
import type { EmbeddingBatchCommit, EmbeddingBatchSkip } from "../../../src/llm/embedders/remote";
import type { EmbeddingVector } from "../../../src/llm/embedders/types";
import type { Database } from "../../../src/storage/database";
import { closeDatabase, openExistingDatabase } from "../../../src/storage/repositories/index-connection";
import { getEmbeddingCount } from "../../../src/storage/repositories/index-vec-repository";
import {
  type Cleanup,
  sandboxEnvDir,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
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

let stashDir = "";
let cleanup: Cleanup = () => {};

function writeMemory(name: string, body: string): void {
  const file = path.join(stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\ndescription: ${name}\n---\n\n${body}\n`, "utf8");
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
  chain = sandboxEnvDir("akm-resume-data", "AKM_DATA_DIR", chain).cleanup;
  chain = sandboxEnvDir("akm-resume-state", "AKM_STATE_DIR", chain).cleanup;
  cleanup = chain;
  writeSandboxConfig({ semanticSearchMode: "auto" });
});

afterEach(() => cleanup());

/**
 * Writes 5 memories and runs an interrupted first pass: the fake embedder
 * commits 3 of them (via `onBatch`, the same per-batch-commit path
 * `RemoteEmbedder` uses in production, #954) then throws — simulating an
 * AbortSignal-style interruption (a genuine caller abort surfaces to
 * `generateEmbeddingsForDb` the same way: as a rejection out of `embedBatch`)
 * partway through the embedding phase. Returns the committed count.
 */
async function writeFiveAndInterruptAfterThree(): Promise<void> {
  for (const name of ["alpha", "bravo", "charlie", "delta", "echo"]) {
    writeMemory(name, `${name} body.`);
  }

  const interruptingMock: EmbedBatchMock = async (texts, _config, _signal, _onSkip, onBatch) => {
    const committed = Math.min(3, texts.length);
    onBatch?.(
      Array.from({ length: committed }, (_v, i) => i),
      Array.from({ length: committed }, (_v, i) => stableVec(i)),
    );
    throw new Error("simulated interruption mid-embedding-phase");
  };
  overrideSeam(_setEmbedderForTests, { embedBatch: interruptingMock });

  const interrupted = await akmIndex({ stashDir, full: false });
  expect(interrupted.verification.ok).toBe(false);

  const db = openDb();
  try {
    expect(getEmbeddingCount(db)).toBe(3);
  } finally {
    closeDatabase(db);
  }
}

describe("index resumability after an interrupted embedding phase (#956)", () => {
  test("a plain `akm index` (no --full) resume embeds only the remaining entries — no purge, no canary", async () => {
    await writeFiveAndInterruptAfterThree();

    let calls = 0;
    let lastTextCount = 0;
    const resumeMock: EmbedBatchMock = async (texts, _config, _signal, _onSkip, onBatch) => {
      calls++;
      lastTextCount = texts.length;
      const vectors = texts.map((_t, i) => stableVec(i));
      onBatch?.(
        texts.map((_t, i) => i),
        vectors,
      );
      return vectors;
    };
    overrideSeam(_setEmbedderForTests, { embedBatch: resumeMock });

    const messages: string[] = [];
    const resumed = await akmIndex({
      stashDir,
      full: false,
      onProgress: (event: IndexProgressEvent) => messages.push(event.message),
    });
    expect(resumed.verification.ok).toBe(true);

    // Exactly one provider call, for exactly the 2 entries still missing a
    // vector — the 3 already committed are untouched (no purge), and no
    // canary probe ran first (the fingerprint never changed, so
    // generateEmbeddingsForDb's rename branch never executes at all).
    expect(calls).toBe(1);
    expect(lastTextCount).toBe(2);
    expect(messages.some((m) => m.includes("already embedded") || m.includes("renamed"))).toBe(false);

    const db = openDb();
    try {
      expect(getEmbeddingCount(db)).toBe(5);
    } finally {
      closeDatabase(db);
    }
  });

  test("a subsequent `akm index --full` reuses the interrupted run's embeddings via salvage, and embeds only what was never reached", async () => {
    await writeFiveAndInterruptAfterThree();

    let calls = 0;
    let lastTextCount = 0;
    const fullMock: EmbedBatchMock = async (texts, _config, _signal, _onSkip, onBatch) => {
      calls++;
      lastTextCount = texts.length;
      const vectors = texts.map((_t, i) => stableVec(i));
      onBatch?.(
        texts.map((_t, i) => i),
        vectors,
      );
      return vectors;
    };
    overrideSeam(_setEmbedderForTests, { embedBatch: fullMock });

    const messages: string[] = [];
    const full = await akmIndex({
      stashDir,
      full: true,
      onProgress: (event: IndexProgressEvent) => messages.push(event.message),
    });
    expect(full.verification.ok).toBe(true);

    // The 3 already-embedded entries are salvaged across the full rebuild's
    // purge-and-recreate (#955) — only the 2 the interrupted pass never
    // reached go to the provider.
    expect(calls).toBe(1);
    expect(lastTextCount).toBe(2);
    expect(messages.some((m) => m.includes("Reused 3 embedding"))).toBe(true);

    const db = openDb();
    try {
      expect(getEmbeddingCount(db)).toBe(5);
      expect(salvageRowCount(db)).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });
});
