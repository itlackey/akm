// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #953 field gap, ported to `drainEmbeddingQueue` (docs/plans/index-redesign-contract.md,
 * B5d) from the deleted `materialize-embeddings.ts`'s
 * `generateEmbeddingsForDb` (see `tests/integration/indexer/embedding-credential-diagnostics.test.ts`
 * as it stood at `fc711fd6^`, its origin): a keyless request against a remote
 * embedding endpoint could not be reproduced in the lab — every
 * `RemoteEmbedder` path already resolves `secret://` through one boundary, so
 * a keyless request can only mean `embedding.apiKey` was absent from the
 * config the run actually loaded. The actionable outcome is a self-diagnosing
 * run: one default-level progress line, before the first provider request,
 * naming the endpoint, the model, and the credential SOURCE (never the
 * value), so a field run can compare it against what the gateway actually
 * saw.
 *
 * Integration-scoped (ORG-03/06): opens a real index.db via
 * `openIndexDatabase`, matching `drain.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AkmConfig } from "../../../src/core/config/config";
import { getConfigPath } from "../../../src/core/paths";
import { resetVerbose, setVerbose } from "../../../src/core/warn";
import { drainEmbeddingQueue } from "../../../src/indexer/drain";
import { _setEmbedderForTests } from "../../../src/llm/embedder";
import type { EmbeddingBatchCommit } from "../../../src/llm/embedders/remote";
import type { EmbeddingVector } from "../../../src/llm/embedders/types";
import type { Database } from "../../../src/storage/database";
import { ensureFileAndUnitTextTables } from "../../../src/storage/repositories/files-repository";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";
import { overrideSeam } from "../../_helpers/seams";

function seedUnitTexts(db: Database, hashes: readonly string[]): void {
  ensureFileAndUnitTextTables(db);
  const insert = db.prepare("INSERT INTO unit_texts (unit_hash, kind, text) VALUES (?, 'card', ?)");
  for (const hash of hashes) insert.run(hash, `text for ${hash}`);
}

function configWithApiKey(apiKey?: string): AkmConfig {
  return {
    semanticSearchMode: "auto",
    embedding: { endpoint: "http://localhost:1", model: "mock-model", ...(apiKey !== undefined ? { apiKey } : {}) },
  } as AkmConfig;
}

function mockEmbedder(): void {
  overrideSeam(_setEmbedderForTests, {
    embedBatch: async (texts, _config, _signal, _onSkip, onBatch?: EmbeddingBatchCommit) => {
      const vectors: EmbeddingVector[] = texts.map(() => [1, 0, 0]);
      onBatch?.(
        texts.map((_t, i) => i),
        vectors,
        "mock-model",
      );
      return vectors;
    },
  });
}

let storage: IsolatedAkmStorage;
let db: Database;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  db = openIndexDatabase(undefined, { embeddingDim: 3 });
});

afterEach(() => {
  closeDatabase(db);
  storage.cleanup();
  resetVerbose();
});

describe("drainEmbeddingQueue: embedding-credential diagnostics (#953)", () => {
  test("names the endpoint, model, and credential SOURCE before the first provider request", async () => {
    seedUnitTexts(db, ["h1"]);
    mockEmbedder();

    const messages: string[] = [];
    await drainEmbeddingQueue(db, configWithApiKey("secret://lab-api-key"), {
      onProgress: (line) => messages.push(line),
    });

    const diagnosticIndex = messages.findIndex((m) => m.startsWith("[embed] endpoint "));
    expect(diagnosticIndex).toBeGreaterThanOrEqual(0);
    expect(messages[diagnosticIndex]).toBe(
      "[embed] endpoint http://localhost:1/embeddings, model mock-model; credential: secret://lab-api-key (store)",
    );
    // Before the first provider request — i.e. before any per-batch progress
    // line and before the final "[drain] done" summary.
    const batchIndex = messages.findIndex((m) => m.startsWith("[drain]"));
    expect(batchIndex).toBeGreaterThan(diagnosticIndex);
    // Never the resolved value — only ever the reference shape.
    expect(messages[diagnosticIndex]).not.toContain("Bearer");
  });

  test("reports 'none configured' when embedding.apiKey is absent", async () => {
    seedUnitTexts(db, ["h1"]);
    mockEmbedder();

    const messages: string[] = [];
    await drainEmbeddingQueue(db, configWithApiKey(undefined), { onProgress: (line) => messages.push(line) });

    expect(messages.some((m) => m.includes("credential: none configured"))).toBe(true);
  });

  test("reports the $VAR env-reference shape, not a resolved value", async () => {
    seedUnitTexts(db, ["h1"]);
    mockEmbedder();

    const messages: string[] = [];
    await drainEmbeddingQueue(db, configWithApiKey("$LAB_API_KEY"), { onProgress: (line) => messages.push(line) });

    expect(messages.some((m) => m.includes("credential: $LAB_API_KEY (env)"))).toBe(true);
  });

  test("under --verbose, the same line also names the loaded config file", async () => {
    seedUnitTexts(db, ["h1"]);
    mockEmbedder();
    setVerbose(true);

    const messages: string[] = [];
    await drainEmbeddingQueue(db, configWithApiKey("secret://lab-api-key"), {
      onProgress: (line) => messages.push(line),
    });

    const diagnostic = messages.find((m) => m.startsWith("[embed] endpoint "));
    expect(diagnostic).toContain(`; config: ${getConfigPath()}`);
  });

  test("a local (non-remote) embedding config never emits the diagnostic — nothing to diagnose", async () => {
    seedUnitTexts(db, ["h1"]);
    mockEmbedder();

    const messages: string[] = [];
    await drainEmbeddingQueue(db, { semanticSearchMode: "auto" } as AkmConfig, {
      onProgress: (line) => messages.push(line),
    });

    expect(messages.some((m) => m.startsWith("[embed] endpoint "))).toBe(false);
  });

  test("nothing pending means no provider request, so the diagnostic never fires either", async () => {
    ensureFileAndUnitTextTables(db);
    mockEmbedder();

    const messages: string[] = [];
    await drainEmbeddingQueue(db, configWithApiKey("secret://lab-api-key"), {
      onProgress: (line) => messages.push(line),
    });

    expect(messages.some((m) => m.startsWith("[embed] endpoint "))).toBe(false);
  });
});
