// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #955: a fingerprint-mismatch used to purge and re-embed the entire vector
 * index unconditionally, including a pure `embedding.model` rename that
 * serves byte-identical vectors (the trigger: a gateway rename from
 * `qwen3-embedding-0.6b` to `embed/qwen3-embedding-0.6b`). These tests drive
 * `generateEmbeddingsForDb` directly against a real index.db (hence
 * tests/integration/, per the ORG-03..06 classification rule), mostly with a
 * fake embedder (via `_setEmbedderForTests`) that plays the canary probe and
 * the main embedding pass, and assert: a same-model rename with compatible
 * vectors keeps the stored rows; an incompatible rename purges and rebuilds;
 * `--reembed` forces a rebuild regardless; an interrupted rebuild resumes
 * instead of purging again; an unreachable canary keeps the old vectors and
 * fingerprint; and the server-reported model identity (not just the config
 * string) decides compatibility. Test (h) instead drives the real
 * `RemoteEmbedder` (HTTP mocked via `withMockedFetch`) to pin the same
 * unreachable-endpoint outcome against its actual skip-and-continue failure
 * semantics, not a mock that throws.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AkmConfig } from "../../../src/core/config/config";
import { _setWarnSinkForTests } from "../../../src/core/warn";
import { deriveEntryProvenance, deriveInstallations } from "../../../src/indexer/installations";
import { generateEmbeddingsForDb } from "../../../src/indexer/materialize-embeddings";
import { buildSearchText } from "../../../src/indexer/search/search-fields";
import { _setEmbedderForTests } from "../../../src/llm/embedder";
import type { EmbeddingBatchCommit, EmbeddingBatchSkip } from "../../../src/llm/embedders/remote";
import { capEmbeddingText } from "../../../src/llm/embedders/remote";
import type { EmbeddingVector } from "../../../src/llm/embedders/types";
import type { Database } from "../../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import { getMeta } from "../../../src/storage/repositories/index-meta-repository";
import { getEmbeddingCount } from "../../../src/storage/repositories/index-vec-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, withMockedFetch } from "../../_helpers/sandbox";
import { overrideSeam, withSeam } from "../../_helpers/seams";

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

/**
 * A single-batch, always-succeeds mock: returns `vecFor(i)` per text AND
 * commits it via `onBatch` in the same call, so it works correctly both as
 * the canary probe (which reads the return value) and as the main embedding
 * pass (which persists only through `onBatch`, per #954).
 */
function simpleMock(vecFor: (i: number) => EmbeddingVector, model?: string): EmbedBatchMock {
  return async (texts, _config, _signal, _onSkip, onBatch) => {
    const vectors = texts.map((_t, i) => vecFor(i));
    onBatch?.(
      texts.map((_t, i) => i),
      vectors,
      model,
    );
    return vectors;
  };
}

describe("generateEmbeddingsForDb: embedding-fingerprint canary (#955)", () => {
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

  /** Seed a single entry with an exact, caller-chosen search text (unlike {@link seedEntries}'s fixed content). */
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

  function embeddingBlob(db: Database, index: number): Buffer | undefined {
    const row = db.prepare("SELECT id FROM entries ORDER BY id LIMIT 1 OFFSET ?").get(index) as
      | { id: number }
      | undefined;
    if (!row) return undefined;
    const emb = db.prepare("SELECT embedding FROM embeddings WHERE id = ?").get(row.id) as
      | { embedding: Buffer }
      | undefined;
    return emb?.embedding;
  }

  test("(a) same vectors under a renamed model string: rows unchanged, fingerprint updated", async () => {
    const db = openIndexDatabase();
    try {
      seedEntries(db, 3);

      mockEmbedder(simpleMock(stableVec));
      const first = await generateEmbeddingsForDb(db, configWithModel("model-a"), () => {});
      expect(first.success).toBe(true);
      expect(getEmbeddingCount(db)).toBe(3);
      const before = embeddingBlob(db, 0);

      mockEmbedder(simpleMock(stableVec));
      const messages: string[] = [];
      const second = await generateEmbeddingsForDb(db, configWithModel("model-b"), (e) => messages.push(e.message));

      expect(second.success).toBe(true);
      expect(getEmbeddingCount(db)).toBe(3);
      expect(embeddingBlob(db, 0)).toEqual(before);
      expect(getMeta(db, "embeddingFingerprint")).toContain("model-b");
      expect(messages.some((m) => m.includes("compatible"))).toBe(true);
    } finally {
      closeDatabase(db);
    }
  });

  test("(b) a genuinely different model's vectors: purged and re-embedded", async () => {
    const db = openIndexDatabase();
    try {
      seedEntries(db, 3);

      mockEmbedder(simpleMock(stableVec));
      const first = await generateEmbeddingsForDb(db, configWithModel("model-a"), () => {});
      expect(first.success).toBe(true);
      const before = embeddingBlob(db, 0);

      mockEmbedder(simpleMock(orthogonalVec));
      const messages: string[] = [];
      const warnCalls: string[] = [];
      _setWarnSinkForTests((_level, args) => warnCalls.push(args.map(String).join(" ")));
      const second = await generateEmbeddingsForDb(db, configWithModel("model-b"), (e) => messages.push(e.message));

      expect(second.success).toBe(true);
      expect(getEmbeddingCount(db)).toBe(3);
      expect(embeddingBlob(db, 0)).not.toEqual(before);
      expect(getMeta(db, "embeddingFingerprint")).toContain("model-b");
      // Once, through onProgress only (#954, field-report follow-up) — never
      // ALSO through warn(), which used to print the identical "Re-embedding
      // N entries because ..." sentence a second time in text mode.
      const rebuildLines = messages.filter((m) => m.includes("Re-embedding") && m.includes("vectors differ"));
      expect(rebuildLines).toHaveLength(1);
      expect(warnCalls.some((m) => m.includes("Re-embedding") && m.includes("vectors differ"))).toBe(false);
    } finally {
      closeDatabase(db);
    }
  });

  test("(c) --reembed forces a purge + rebuild even with no fingerprint change at all", async () => {
    const db = openIndexDatabase();
    try {
      seedEntries(db, 3);
      const config = configWithModel("model-a");

      let calls = 0;
      mockEmbedder(async (...args) => {
        calls++;
        return simpleMock(stableVec)(...args);
      });
      const first = await generateEmbeddingsForDb(db, config, () => {});
      expect(first.success).toBe(true);
      expect(calls).toBe(1);

      // Same config, no forceReembed: fingerprint already matches, nothing
      // missing — zero further embedBatch calls (the pre-#955 fast path).
      const noop = await generateEmbeddingsForDb(db, config, () => {});
      expect(noop.success).toBe(true);
      expect(calls).toBe(1);

      // Same config, forceReembed: an explicit override purges and
      // re-embeds every entry even though nothing about the config changed.
      const forced = await generateEmbeddingsForDb(db, config, () => {}, undefined, undefined, {
        forceReembed: true,
      });
      expect(forced.success).toBe(true);
      expect(calls).toBe(2);
      expect(getEmbeddingCount(db)).toBe(3);
    } finally {
      closeDatabase(db);
    }
  });

  test("(d) an interrupted rebuild resumes on the next run instead of purging again", async () => {
    const db = openIndexDatabase();
    try {
      seedEntries(db, 3);

      mockEmbedder(simpleMock(stableVec));
      const first = await generateEmbeddingsForDb(db, configWithModel("model-a"), () => {});
      expect(first.success).toBe(true);
      expect(getEmbeddingCount(db)).toBe(3);

      let call = 0;
      mockEmbedder(async (texts, _config, _signal, _onSkip, onBatch) => {
        call++;
        if (call === 1) {
          // Canary probe: dissimilar vectors -> decision is "rebuild". Read
          // only via the return value, same as the real canary caller.
          return texts.map((_t, i) => orthogonalVec(i));
        }
        // Main pass after the purge: commit one batch, then crash.
        onBatch?.([0], [stableVec(0)]);
        throw new Error("simulated crash mid-rebuild");
      });
      const interrupted = await generateEmbeddingsForDb(db, configWithModel("model-b"), () => {});
      expect(interrupted.success).toBe(false);
      // The new fingerprint was written in the SAME transaction as the purge,
      // before any embedding request — not deferred to a successful finish.
      expect(getMeta(db, "embeddingFingerprint")).toContain("model-b");
      expect(getEmbeddingCount(db)).toBe(1);

      let rerunCalls = 0;
      let rerunTextCount = 0;
      mockEmbedder(async (texts, _config, _signal, _onSkip, onBatch) => {
        rerunCalls++;
        rerunTextCount = texts.length;
        const vectors = texts.map((_t, i) => stableVec(i));
        onBatch?.(
          texts.map((_t, i) => i),
          vectors,
        );
        return vectors;
      });
      const resumed = await generateEmbeddingsForDb(db, configWithModel("model-b"), () => {});
      expect(resumed.success).toBe(true);
      // Fingerprint already matched, so no canary ran — exactly one call,
      // healing only the 2 entries still missing a vector, not purging
      // and re-embedding all 3 again.
      expect(rerunCalls).toBe(1);
      expect(rerunTextCount).toBe(2);
      expect(getEmbeddingCount(db)).toBe(3);
    } finally {
      closeDatabase(db);
    }
  });

  test("(e) a canary that cannot run keeps the existing vectors and the old fingerprint", async () => {
    const db = openIndexDatabase();
    try {
      seedEntries(db, 3);

      mockEmbedder(simpleMock(stableVec));
      const first = await generateEmbeddingsForDb(db, configWithModel("model-a"), () => {});
      expect(first.success).toBe(true);
      expect(getEmbeddingCount(db)).toBe(3);
      const before = embeddingBlob(db, 0);
      const fingerprintBefore = getMeta(db, "embeddingFingerprint");

      mockEmbedder(async () => {
        throw new Error("connect ECONNREFUSED");
      });
      const result = await generateEmbeddingsForDb(db, configWithModel("model-b"), () => {});

      expect(result.success).toBe(false);
      expect(result.message).toContain("could not verify embedding compatibility");
      expect(result.message).toContain("keeping existing vectors");
      expect(getEmbeddingCount(db)).toBe(3);
      expect(embeddingBlob(db, 0)).toEqual(before);
      // The mismatch is left unresolved so the next `akm index` retries it.
      expect(getMeta(db, "embeddingFingerprint")).toBe(fingerprintBefore);
    } finally {
      closeDatabase(db);
    }
  });

  test("(f) same server-reported model id under a different config string: kept without needing the cosines", async () => {
    const db = openIndexDatabase();
    try {
      seedEntries(db, 3);

      mockEmbedder(simpleMock(stableVec, "server-model-x"));
      const first = await generateEmbeddingsForDb(db, configWithModel("model-a"), () => {});
      expect(first.success).toBe(true);
      expect(getMeta(db, "embeddingIdentity")).toBe("remote:server-model-x|3");
      const before = embeddingBlob(db, 0);

      // The canary probe reports the SAME server model id but returns vectors
      // that would fail the cosine check outright — proving the identity
      // match alone decided "keep", not the similarity.
      const messages: string[] = [];
      mockEmbedder(simpleMock(orthogonalVec, "server-model-x"));
      const second = await generateEmbeddingsForDb(db, configWithModel("model-b"), (e) => messages.push(e.message));

      expect(second.success).toBe(true);
      expect(getEmbeddingCount(db)).toBe(3);
      // Stored vectors are untouched — the dissimilar canary vectors above
      // were only ever used for comparison, never written.
      expect(embeddingBlob(db, 0)).toEqual(before);
      expect(getMeta(db, "embeddingIdentity")).toBe("remote:server-model-x|3");
      expect(messages.some((m) => m.includes("server-reported model unchanged"))).toBe(true);
    } finally {
      closeDatabase(db);
    }
  });

  test("(g) a different server-reported model id but identical vectors: kept by cosine", async () => {
    const db = openIndexDatabase();
    try {
      seedEntries(db, 3);

      mockEmbedder(simpleMock(stableVec, "server-model-x"));
      const first = await generateEmbeddingsForDb(db, configWithModel("model-a"), () => {});
      expect(first.success).toBe(true);
      expect(getMeta(db, "embeddingIdentity")).toBe("remote:server-model-x|3");

      // A different server-reported model id, but the SAME vectors — the
      // identity shortcut cannot fire, so the decision falls through to the
      // cosine check, which keeps.
      const messages: string[] = [];
      mockEmbedder(simpleMock(stableVec, "server-model-y"));
      const second = await generateEmbeddingsForDb(db, configWithModel("model-b"), (e) => messages.push(e.message));

      expect(second.success).toBe(true);
      expect(getEmbeddingCount(db)).toBe(3);
      expect(getMeta(db, "embeddingIdentity")).toBe("remote:server-model-y|3");
      expect(messages.some((m) => m.includes("stored vectors are compatible"))).toBe(true);
    } finally {
      closeDatabase(db);
    }
  });

  test("(h) a REAL RemoteEmbedder failing every canary request keeps existing vectors, not a spurious purge", async () => {
    // Unlike every other test in this file, this one does NOT mock
    // `embedBatch` itself for the second pass — it lets `generateEmbeddingsForDb`
    // reach the real `RemoteEmbedder` and mocks only the HTTP layer via
    // `withMockedFetch`. `RemoteEmbedder.embedBatch` SKIPS a failing request
    // (onSkip + `undefined` slots) rather than throwing (#874) — a mock
    // embedder function that throws on failure (as test (e) uses) cannot
    // reproduce that shape and would give false confidence that this path is
    // covered.
    const db = openIndexDatabase();
    try {
      seedEntries(db, 3);

      await withSeam(_setEmbedderForTests, { embedBatch: simpleMock(stableVec) }, async () => {
        const first = await generateEmbeddingsForDb(db, configWithModel("model-a"), () => {});
        expect(first.success).toBe(true);
      });
      expect(getEmbeddingCount(db)).toBe(3);
      const before = embeddingBlob(db, 0);
      const fingerprintBefore = getMeta(db, "embeddingFingerprint");

      const result = await withMockedFetch(
        () => generateEmbeddingsForDb(db, configWithModel("model-b"), () => {}),
        async () => new Response("synthetic upstream failure", { status: 500 }),
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain("could not verify embedding compatibility");
      expect(result.message).toContain("keeping existing vectors");
      expect(getEmbeddingCount(db)).toBe(3);
      expect(embeddingBlob(db, 0)).toEqual(before);
      // The mismatch is left unresolved so the next `akm index` retries it —
      // NOT purged as "vectors differ" the way an unhandled all-undefined
      // canary result used to be misread.
      expect(getMeta(db, "embeddingFingerprint")).toBe(fingerprintBefore);
    } finally {
      closeDatabase(db);
    }
  });

  test("(i) the canary embeds the same capped text the pipeline embeds, not the raw search text (#955)", async () => {
    const db = openIndexDatabase();
    try {
      // 10-token cap -> 40-char budget; this entry's search text is 4x that,
      // so an uncapped canary request would carry a different string than
      // what produced the stored vector.
      const maxInputTokens = 10;
      const bigText = "w".repeat(160);
      seedOneEntry(db, bigText);
      const expectedCappedText = capEmbeddingText(bigText, maxInputTokens).text;
      expect(expectedCappedText.length).toBeLessThan(bigText.length);

      mockEmbedder(simpleMock(stableVec));
      const first = await generateEmbeddingsForDb(db, configWithModel("model-a", { maxInputTokens }), () => {});
      expect(first.success).toBe(true);
      expect(getEmbeddingCount(db)).toBe(1);
      const before = embeddingBlob(db, 0);

      const canaryTexts: string[] = [];
      mockEmbedder(async (texts, _config, _signal, _onSkip, onBatch) => {
        canaryTexts.push(...texts);
        const vectors = texts.map((_t, i) => stableVec(i));
        onBatch?.(
          texts.map((_t, i) => i),
          vectors,
        );
        return vectors;
      });
      const second = await generateEmbeddingsForDb(db, configWithModel("model-b", { maxInputTokens }), () => {});

      // Same model, so the vectors the mock returns for the canary are
      // identical to the stored ones -> "keep". The assertion that matters
      // is the request BODY: the canary must have embedded exactly the
      // capped text the first pass embedded, never the raw 160-char text.
      expect(second.success).toBe(true);
      expect(embeddingBlob(db, 0)).toEqual(before);
      expect(canaryTexts).toEqual([expectedCappedText]);
    } finally {
      closeDatabase(db);
    }
  });
});
