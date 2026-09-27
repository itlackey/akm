// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm index --full` re-drains every directory through the same id-preserving
 * diff-persist path as an incremental run, so a vector stays attached to its
 * unchanged entry and only changed text goes back to the embedding provider.
 * (A full run used to wipe `entries` and re-embed the whole corpus, #955.)
 *
 * Drives the real `akmIndex` path against a sandboxed index.db with a fake
 * embedder installed via `_setEmbedderForTests`, so a provider call is
 * directly countable — hence tests/integration/.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { akmIndex } from "../../../src/indexer/indexer";
import { _setEmbedderForTests } from "../../../src/llm/embedder";
import type { EmbeddingBatchCommit, EmbeddingBatchSkip } from "../../../src/llm/embedders/remote";
import type { EmbeddingVector } from "../../../src/llm/embedders/types";
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

describe("akm index --full keeps the vectors of unchanged entries", () => {
  let stashDir = "";
  let cleanup: Cleanup = () => {};
  let providerCalls = 0;
  let embeddedTexts: string[] = [];

  function writeMemory(name: string, description: string, body: string): void {
    const file = path.join(stashDir, "memories", `${name}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `---\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`, "utf8");
  }

  function storedState(): { embeddings: number; ids: number[] } {
    const db = openExistingDatabase(getDbPath());
    try {
      const ids = (db.prepare("SELECT id FROM entries ORDER BY id").all() as Array<{ id: number }>).map((r) => r.id);
      return { embeddings: getEmbeddingCount(db), ids };
    } finally {
      closeDatabase(db);
    }
  }

  beforeEach(() => {
    const stash = sandboxStashDir();
    stashDir = stash.dir;
    let chain = sandboxXdgConfigHome(stash.cleanup).cleanup;
    chain = sandboxXdgCacheHome(chain).cleanup;
    chain = sandboxEnvDir("akm-full-reindex-data", "AKM_DATA_DIR", chain).cleanup;
    chain = sandboxEnvDir("akm-full-reindex-state", "AKM_STATE_DIR", chain).cleanup;
    cleanup = chain;
    writeSandboxConfig({ semanticSearchMode: "auto" });
    providerCalls = 0;
    embeddedTexts = [];
    const mock: EmbedBatchMock = async (texts, _config, _signal, _onSkip, onBatch) => {
      providerCalls++;
      embeddedTexts.push(...texts);
      const vectors = texts.map((_t, i) => [1 + i, 2 + i, 3 + i]);
      onBatch?.(
        texts.map((_t, i) => i),
        vectors,
      );
      return vectors;
    };
    overrideSeam(_setEmbedderForTests, { embedBatch: mock });
  });

  afterEach(() => cleanup());

  test("a second `--full` run on an unchanged corpus makes zero provider calls", async () => {
    writeMemory("alpha", "alpha memory", "Alpha body.");
    writeMemory("bravo", "bravo memory", "Bravo body.");
    writeMemory("charlie", "charlie memory", "Charlie body.");

    expect((await akmIndex({ stashDir, full: true })).verification.ok).toBe(true);
    expect(providerCalls).toBe(1);
    expect(embeddedTexts).toHaveLength(3);
    const before = storedState();
    expect(before.embeddings).toBe(3);

    providerCalls = 0;
    expect((await akmIndex({ stashDir, full: true })).verification.ok).toBe(true);
    expect(providerCalls).toBe(0);
    expect(storedState()).toEqual(before);
  });

  test("editing one entry between two `--full` runs sends only that entry to the provider", async () => {
    writeMemory("alpha", "alpha memory", "Alpha body.");
    writeMemory("bravo", "bravo memory", "Bravo body.");
    writeMemory("charlie", "charlie memory", "Charlie body.");
    expect((await akmIndex({ stashDir, full: true })).verification.ok).toBe(true);
    const before = storedState();

    writeMemory("bravo", "bravo memory revised", "Bravo body.");
    providerCalls = 0;
    embeddedTexts = [];
    expect((await akmIndex({ stashDir, full: true })).verification.ok).toBe(true);

    expect(providerCalls).toBe(1);
    expect(embeddedTexts).toHaveLength(1);
    expect(embeddedTexts[0]).toContain("revised");
    expect(storedState()).toEqual(before);
  });
});
