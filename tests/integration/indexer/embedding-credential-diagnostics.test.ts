// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #953 field gap: a keyless embedding request could not be reproduced in the
 * lab — every `RemoteEmbedder` path already resolves `secret://` through one
 * boundary. The actionable outcome is a self-diagnosing run: one
 * default-level progress line, before the first provider request, naming
 * the endpoint, the model, and the credential SOURCE (never the value), so
 * the next field run can compare it against what the gateway actually saw.
 *
 * Drives `generateEmbeddingsForDb` against a real index.db (hence
 * tests/integration/ per the ORG-03..06 classification rule) with a fake
 * embedder.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AkmConfig } from "../../../src/core/config/config";
import { getConfigPath } from "../../../src/core/paths";
import { resetVerbose, setVerbose } from "../../../src/core/warn";
import { deriveEntryProvenance, deriveInstallations } from "../../../src/indexer/installations";
import { generateEmbeddingsForDb } from "../../../src/indexer/materialize-embeddings";
import { buildSearchText } from "../../../src/indexer/search/search-fields";
import { _setEmbedderForTests } from "../../../src/llm/embedder";
import type { EmbeddingBatchCommit } from "../../../src/llm/embedders/remote";
import type { EmbeddingVector } from "../../../src/llm/embedders/types";
import type { Database } from "../../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";
import { overrideSeam } from "../../_helpers/seams";

function configWithApiKey(apiKey?: string): AkmConfig {
  return {
    semanticSearchMode: "auto",
    embedding: { endpoint: "http://localhost:1", model: "test-model", ...(apiKey !== undefined ? { apiKey } : {}) },
  } as AkmConfig;
}

describe("generateEmbeddingsForDb: embedding-credential diagnostics (#953)", () => {
  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });
  afterEach(() => {
    storage.cleanup();
    resetVerbose();
  });

  function seedOneEntry(db: Database): void {
    const installation = deriveInstallations([{ path: storage.stashDir, writable: true }])[0];
    const component = installation?.components[0];
    if (!installation || !component) throw new Error("failed to derive a test bundle installation");
    const entry = { name: "note", type: "memories", filename: "note.md" };
    const provenance = deriveEntryProvenance(
      { bundleId: installation.id, componentId: component.id, adapterId: component.adapter },
      "memories",
      "note",
    );
    upsertEntry(db, `${storage.stashDir}/memories/note.md`, entry, buildSearchText(entry), provenance);
  }

  function mockEmbedder(): void {
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
  }

  test("names the endpoint, model, and credential SOURCE before the first provider request", async () => {
    const db = openIndexDatabase();
    try {
      seedOneEntry(db);
      mockEmbedder();

      const messages: string[] = [];
      const result = await generateEmbeddingsForDb(db, configWithApiKey("secret://lab-api-key"), (e) =>
        messages.push(e.message),
      );
      expect(result.success).toBe(true);

      const diagnosticIndex = messages.findIndex((m) => m.startsWith("[embed] endpoint "));
      expect(diagnosticIndex).toBeGreaterThanOrEqual(0);
      expect(messages[diagnosticIndex]).toBe(
        "[embed] endpoint http://localhost:1/embeddings, model test-model; credential: secret://lab-api-key (store)",
      );
      // Before the first provider request — i.e. before the "Generating
      // embeddings for N ..." line that precedes the actual embedBatch call.
      const generatingIndex = messages.findIndex((m) => m.startsWith("Generating embeddings for"));
      expect(generatingIndex).toBeGreaterThan(diagnosticIndex);
      // Never the resolved value — only ever the reference shape.
      expect(messages[diagnosticIndex]).not.toContain("Bearer");
    } finally {
      closeDatabase(db);
    }
  });

  test("reports 'none configured' when embedding.apiKey is absent", async () => {
    const db = openIndexDatabase();
    try {
      seedOneEntry(db);
      mockEmbedder();

      const messages: string[] = [];
      await generateEmbeddingsForDb(db, configWithApiKey(undefined), (e) => messages.push(e.message));

      expect(messages.some((m) => m.includes("credential: none configured"))).toBe(true);
    } finally {
      closeDatabase(db);
    }
  });

  test("reports the $VAR env-reference shape, not a resolved value", async () => {
    const db = openIndexDatabase();
    try {
      seedOneEntry(db);
      mockEmbedder();

      const messages: string[] = [];
      await generateEmbeddingsForDb(db, configWithApiKey("$LAB_API_KEY"), (e) => messages.push(e.message));

      expect(messages.some((m) => m.includes("credential: $LAB_API_KEY (env)"))).toBe(true);
    } finally {
      closeDatabase(db);
    }
  });

  test("under --verbose, the same line also names the loaded config file", async () => {
    const db = openIndexDatabase();
    try {
      seedOneEntry(db);
      mockEmbedder();
      setVerbose(true);

      const messages: string[] = [];
      await generateEmbeddingsForDb(db, configWithApiKey("secret://lab-api-key"), (e) => messages.push(e.message));

      const diagnostic = messages.find((m) => m.startsWith("[embed] endpoint "));
      expect(diagnostic).toContain(`; config: ${getConfigPath()}`);
    } finally {
      closeDatabase(db);
    }
  });

  test("a local (non-remote) embedding config never emits the diagnostic — nothing to diagnose", async () => {
    const db = openIndexDatabase();
    try {
      seedOneEntry(db);
      mockEmbedder();

      const messages: string[] = [];
      await generateEmbeddingsForDb(db, { semanticSearchMode: "auto" } as AkmConfig, (e) => messages.push(e.message));

      expect(messages.some((m) => m.startsWith("[embed] endpoint "))).toBe(false);
    } finally {
      closeDatabase(db);
    }
  });
});
