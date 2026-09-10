// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #956: an index run interrupted mid-embedding-phase must be
 * RESUMABLE, not restarted. Two end-to-end scenarios, both driven through
 * the real `akmIndex()` entry point against a real index.db, with a fake
 * embedder that partially commits then aborts to simulate a genuine
 * interruption (the owner observed the abort path restarting instead of
 * resuming):
 *
 *  - a plain `akm index` (no `--full`) after an interrupted pass embeds only
 *    the units still missing a vector — no purge, no canary (`units`/
 *    `units_vec`, index-redesign A2, are content-addressed: an unit whose
 *    hash already has a vector is simply never selected as pending again);
 *  - a subsequent `akm index --full` sends a provider request only for the
 *    units that were never embedded at all because the interruption landed
 *    before they were reached — `--full` drops `entries`/`files` but never
 *    `units`/`units_vec` (rule 2, docs/plans/index-redesign.md), so the
 *    already-embedded ones were never at risk of the wipe and there is
 *    nothing to salvage FROM; #955's `embedding_salvage` table exists for the
 *    legacy entry-id-keyed `embeddings` table, which nothing writes to any
 *    more (index-redesign B5a retired its only caller).
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

/**
 * `units` rows with a stored vector — the content-addressed (index-redesign
 * A2) analogue of the pre-redesign `embeddings` table. That legacy,
 * entry-id-keyed table is only ever written by `materialize-embeddings.ts`,
 * which nothing calls any more (B5a retired its only caller), so it stays at
 * zero for the whole run; this reads the table `drainEmbeddingQueue` (B4)
 * actually writes.
 */
function getUnitVectorCount(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM units").get() as { c: number }).c;
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
  // `dimension: 3` matches `stableVec`'s own output shape below: `units_vec`
  // (sqlite-vec, index-redesign A2) is a fixed-width virtual table, unlike
  // the legacy `embeddings` BLOB column this test predates — a real provider
  // response width mismatch (the untouched 384 default against stableVec's
  // 3) fails the insert outright rather than silently accepting any length.
  writeSandboxConfig({ semanticSearchMode: "auto", embedding: { dimension: 3 } });
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
  // Empty body (frontmatter only): the akm adapter's own fragment projection
  // (`projectMarkdownFragmentContent`) returns `undefined` for content with
  // nothing left after the frontmatter, so `deriveUnits` (index-redesign A1)
  // produces exactly ONE unit per entry — its structured-fields "card". A
  // non-empty body would additionally derive a fragment unit per entry,
  // breaking this test's entries-to-embeddable-units 1:1 assumption (every
  // count and index below is entry-scoped).
  for (const name of ["alpha", "bravo", "charlie", "delta", "echo"]) {
    writeMemory(name, "");
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
    expect(getUnitVectorCount(db)).toBe(3);
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
      expect(getUnitVectorCount(db)).toBe(5);
    } finally {
      closeDatabase(db);
    }
  });

  test("a subsequent `akm index --full` reuses the interrupted run's embeddings, and embeds only what was never reached", async () => {
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

    // `--full` drops `entries`/`files` but never `units`/`units_vec`
    // (index-redesign B5a, docs/plans/index-redesign.md rule 2: vectors are
    // content-addressed and never rebuilt) — the 3 already-embedded units
    // from the interrupted pass are never at risk of the wipe in the first
    // place, so there is nothing to salvage FROM (#955's `embedding_salvage`
    // exists for the legacy entry-id-keyed `embeddings` table, which nothing
    // writes to any more). Only the 2 units the interrupted pass never
    // reached are still missing a vector, so only those go to the provider.
    expect(calls).toBe(1);
    expect(lastTextCount).toBe(2);

    const db = openDb();
    try {
      expect(getUnitVectorCount(db)).toBe(5);
      expect(salvageRowCount(db)).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });
});
