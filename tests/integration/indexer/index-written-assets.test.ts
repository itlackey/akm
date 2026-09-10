// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests for `indexWrittenAssets` — the write-path index update used by
 * `writeMarkdownAsset` (akm remember / knowledge writes) and extract's
 * session assets, so just-written assets are searchable immediately without
 * any read-triggered reindex.
 *
 * docs/plans/index-redesign-contract.md, module B2: `indexWrittenAssets` is
 * now a thin call to B1's real `reconcilePaths` (`src/indexer/reconcile.ts`)
 * followed by B4's real `drainEmbeddingQueue` (`src/indexer/drain.ts`),
 * scoped to exactly the units the write produced. This suite covers what
 * module B2 owns: the lexical-searchability guarantee, the fail-open skips
 * that are still B2's responsibility (absent index, unreadable index, a
 * missing/unindexable file), and the onlyHashes wiring between the two calls
 * — proved end to end against the real drain (a mocked `embedBatch`, the
 * same seam `tests/integration/indexer/drain.test.ts` uses) rather than a
 * stand-in recorder. It no longer covers the rebuild-lock skip (#956) — the
 * redesign has no rebuild lock to probe.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { indexWrittenAssets } from "../../../src/indexer/index-written-assets";
import { akmIndex } from "../../../src/indexer/indexer";
import { _setEmbedderForTests } from "../../../src/llm/embedder";
import type { EmbeddingBatchCommit, EmbeddingBatchSkip } from "../../../src/llm/embedders/remote";
import type { EmbeddingVector } from "../../../src/llm/embedders/types";
import { closeDatabase, openExistingDatabase } from "../../../src/storage/repositories/index-connection";
import { EMBEDDING_DIM } from "../../../src/storage/repositories/index-schema";
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
  onSkip?: (skip: EmbeddingBatchSkip) => unknown,
  onBatch?: EmbeddingBatchCommit,
) => Promise<(EmbeddingVector | undefined)[]>;

/** `beforeEach`'s `akmIndex({ stashDir })` call already creates `units_vec` at the schema default width — vectors handed to the mocked embedder below must match it. */
function stableVec(seed: number): EmbeddingVector {
  return Array.from({ length: EMBEDDING_DIM }, (_v, i) => seed + i);
}

/** `embedding.endpoint` fails fast (connection refused) so `probeProviderLimits`'s real HTTP probe — reused unmocked — never hangs; only `embedBatch` itself is swapped. Mirrors drain.test.ts's convention. */
function semanticConfigOverrides(): Parameters<typeof writeSandboxConfig>[0] {
  return { semanticSearchMode: "auto", embedding: { endpoint: "http://localhost:1", model: "mock-model" } };
}

let stashDir = "";
let cleanup: Cleanup = () => {};

function writeMemory(name: string, body: string): string {
  const filePath = path.join(stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\ndescription: ${name}\n---\n\n# ${name}\n\n${body}\n`, "utf8");
  return filePath;
}

function queryIndex(ftsTerm?: string): { entryNames: string[]; ftsCount: number } {
  const db = openExistingDatabase(getDbPath());
  try {
    const entryNames = (db.prepare("SELECT document_json FROM entries").all() as Array<{ document_json: string }>).map(
      (r) => (JSON.parse(r.document_json) as { name: string }).name,
    );
    const ftsCount = ftsTerm
      ? (db.prepare("SELECT COUNT(*) AS c FROM units_fts WHERE units_fts MATCH ?").get(ftsTerm) as { c: number }).c
      : 0;
    return { entryNames, ftsCount };
  } finally {
    closeDatabase(db);
  }
}

function indexedFileCount(filePath: string): number {
  const db = openExistingDatabase(getDbPath());
  try {
    return (db.prepare("SELECT COUNT(*) AS c FROM entries WHERE file_path = ?").get(filePath) as { c: number }).c;
  } finally {
    closeDatabase(db);
  }
}

beforeEach(async () => {
  const stash = sandboxStashDir();
  stashDir = stash.dir;
  let chain = sandboxXdgConfigHome(stash.cleanup).cleanup;
  chain = sandboxXdgCacheHome(chain).cleanup;
  chain = sandboxEnvDir("akm-written-data", "AKM_DATA_DIR", chain).cleanup;
  chain = sandboxEnvDir("akm-written-state", "AKM_STATE_DIR", chain).cleanup;
  cleanup = chain;
  writeSandboxConfig({ semanticSearchMode: "off" });
  writeMemory("seed-memory", "Seed body.");
  await akmIndex({ stashDir });
});

afterEach(() => {
  cleanup();
});

describe("indexWrittenAssets", () => {
  test("a just-written memory becomes visible in entries AND keyword (FTS) search", async () => {
    const filePath = writeMemory("zanzibar-note", "Notes about the zanzibar deployment quirk.");
    await indexWrittenAssets(stashDir, [filePath]);

    const idx = queryIndex("zanzibar");
    expect(idx.entryNames).toContain("zanzibar-note");
    expect(idx.ftsCount).toBeGreaterThan(0);
  });

  test("re-indexing an edited file updates its entry (idempotent upsert)", async () => {
    const filePath = writeMemory("evolving-note", "Original body.");
    await indexWrittenAssets(stashDir, [filePath]);
    // FTS covers metadata fields (name/description/tags/hints), not the raw
    // body — same as the full walk — so the edit changes the description.
    fs.writeFileSync(
      filePath,
      "---\ndescription: now covers the quokka deployment\n---\n\n# evolving-note\n\nUpdated body.\n",
      "utf8",
    );
    await indexWrittenAssets(stashDir, [filePath]);

    const idx = queryIndex("quokka");
    expect(idx.entryNames.filter((n) => n === "evolving-note")).toHaveLength(1);
    expect(idx.ftsCount).toBeGreaterThan(0);
  });

  test("a write into a stash that is ALSO a configured named bundle uses the configured bundle id, not a path-derived slug of the raw path (#W1)", async () => {
    // The working stash (AKM_BUNDLE_DIR) is ALSO configured as `bundles.myproj`
    // — the exact "config-owned stash" shape the repro used: the bundle-id
    // fallback must resolve the CONFIGURED id here, not slug the raw path
    // into something else (e.g. "stash").
    writeSandboxConfig({ semanticSearchMode: "off", bundles: { myproj: { path: stashDir, writable: true } } });
    const filePath = writeMemory("myproj-note", "Notes proving the write lands under the configured bundle id.");

    await indexWrittenAssets(stashDir, [filePath]);

    const dbAfterWrite = openExistingDatabase(getDbPath());
    let writeRef: string | undefined;
    try {
      writeRef = (
        dbAfterWrite.prepare("SELECT item_ref FROM entries WHERE file_path = ?").get(filePath) as
          | { item_ref: string }
          | undefined
      )?.item_ref;
    } finally {
      closeDatabase(dbAfterWrite);
    }
    expect(writeRef).toStartWith("myproj//");

    // A subsequent full `akm index` reconciling the SAME file under its
    // configured bundle id must converge on the identical row — not leave a
    // stale duplicate under a path-derived slug the full index never touches
    // (the W1 "undeletable row" failure mode).
    await akmIndex({ stashDir });

    const dbAfterFull = openExistingDatabase(getDbPath());
    try {
      const rows = dbAfterFull.prepare("SELECT item_ref FROM entries WHERE file_path = ?").all(filePath) as Array<{
        item_ref: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.item_ref).toBe(writeRef);
    } finally {
      closeDatabase(dbAfterFull);
    }
  });

  test("akmIndex's own IndexResponse envelope reports entriesUpserted/sourcesScanned truthfully, not generatedMetadata/directoriesScanned+Skipped (#W5/#W6)", async () => {
    writeMemory("envelope-note", "Proves the response envelope's renamed fields.");

    const result = await akmIndex({ stashDir });

    // W5: renamed from `generatedMetadata` — same value as before (reconcile's
    // own added+changed count), just no longer misnamed as LLM-generated
    // metadata coverage (`metadata_enhance` is off by default in this suite's
    // config, so a nonzero LLM-enrichment count would be a lie either way).
    expect(result.entriesUpserted).toBeGreaterThan(0);
    expect(result).not.toHaveProperty("generatedMetadata");
    // W6: renamed from `directoriesScanned` (reconcile is a flat per-file
    // stat walk, never a directory walk); `directoriesSkipped` — a hardcoded
    // 0 with no real signal behind it — is dropped outright.
    expect(result.sourcesScanned).toBeGreaterThan(0);
    expect(result).not.toHaveProperty("directoriesScanned");
    expect(result).not.toHaveProperty("directoriesSkipped");
  });

  test("fail-open: absent index.db is a silent no-op (no DB created)", async () => {
    fs.rmSync(getDbPath());
    const filePath = writeMemory("orphan-note", "Body.");
    await indexWrittenAssets(stashDir, [filePath]);
    expect(fs.existsSync(getDbPath())).toBe(false);
  });

  test("fail-open: missing file and non-indexable path are silent no-ops", async () => {
    await indexWrittenAssets(stashDir, [path.join(stashDir, "memories", "never-written.md")]);
    const statePath = path.join(stashDir, "memories", ".hidden", "state.md");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, "not an asset", "utf8");
    await indexWrittenAssets(stashDir, [statePath]);
    const idx = queryIndex();
    expect(idx.entryNames).toEqual(["seed-memory"]);
  });

  test("indexes a rewritten workflow through the shared source compiler", async () => {
    const filePath = path.join(stashDir, "workflows", "rewritten-citer.md");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      [
        "---",
        "type: workflow",
        "description: workflow citing a moved xylophone memory",
        "steps:",
        "  - id: first",
        "---",
        "",
        "# Rewritten Citer",
        "",
        "## first",
        "",
        "Read memory:xylophone-note and act.",
        "",
      ].join("\n"),
      "utf8",
    );
    await indexWrittenAssets(stashDir, [filePath]);

    const db = openExistingDatabase(getDbPath());
    try {
      const row = db.prepare("SELECT id, document_json FROM entries WHERE file_path = ?").get(filePath) as {
        id: number;
        document_json: string;
      } | null;
      expect(row).not.toBeNull();
      expect((JSON.parse((row as { document_json: string }).document_json) as { type: string }).type).toBe("workflow");
    } finally {
      closeDatabase(db);
    }
  });

  test("removes stale metadata when a rewritten file is no longer indexable", async () => {
    const filePath = path.join(stashDir, "workflows", "stale-workflow.md");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      "---\ntype: workflow\ndescription: Valid workflow\nsteps:\n  - id: first\n---\n\n## first\n\nRun.\n",
      "utf8",
    );
    await indexWrittenAssets(stashDir, [filePath]);
    expect(indexedFileCount(filePath)).toBe(1);

    // Broken: no "steps" list at all — parseWorkflow rejects it, so a
    // workflow-typed file (recognized by residence under workflows/,
    // spec §2.5) becomes wholly unindexable rather than partially indexed.
    fs.writeFileSync(
      filePath,
      "---\ntype: workflow\ndescription: Broken workflow\n---\n\nNo steps declared.\n",
      "utf8",
    );
    await indexWrittenAssets(stashDir, [filePath]);
    expect(indexedFileCount(filePath)).toBe(0);
  });

  describe("write-time indexing contract (module B2)", () => {
    test("a written asset is lexically searchable immediately after the call returns", async () => {
      const filePath = writeMemory("immediacy-note", "Proves the entry is searchable the instant the call returns.");

      const result = await indexWrittenAssets(stashDir, [filePath]);

      expect(result).toBe(true);
      const idx = queryIndex("immediacy");
      expect(idx.entryNames).toContain("immediacy-note");
      expect(idx.ftsCount).toBeGreaterThan(0);
    });

    test("the drain is asked for exactly the units the write produced — no more, no fewer, none stale", async () => {
      const firstPath = writeMemory("wiring-first", "First body distinguishing this unit from the second.");
      const secondPath = writeMemory("wiring-second", "Second body, deliberately different from the first.");

      // A unit text NOT reachable from either written path (never wired into
      // entry_units by any reconcile) — proves the drain call is scoped to
      // this write, not "every pending hash in unit_texts". beforeEach's
      // full-walk akmIndex() never touches unit_texts/entry_units at all (no
      // caller in the walk pipeline runs reconcile), so nothing but this
      // manual seed and the write below can put a row there.
      const staleHash = "f".repeat(64);
      const seedDb = openExistingDatabase(getDbPath());
      try {
        seedDb
          .prepare("INSERT INTO unit_texts (unit_hash, kind, text) VALUES (?, 'card', ?)")
          .run(staleHash, "unrelated stale text");
      } finally {
        closeDatabase(seedDb);
      }

      writeSandboxConfig(semanticConfigOverrides());
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

      await indexWrittenAssets(stashDir, [firstPath, secondPath]);

      // Both notes' bodies (a structured-fields "card" unit plus at least one
      // markdown-fragment unit each) got embedded — never the pre-seeded
      // unrelated hash's text.
      expect(seenTexts.length).toBeGreaterThanOrEqual(2);
      expect(seenTexts).not.toContain("unrelated stale text");

      const dbAfter = openExistingDatabase(getDbPath());
      try {
        const embeddedHashes = new Set(
          (dbAfter.prepare("SELECT unit_hash FROM units").all() as Array<{ unit_hash: string }>).map(
            (row) => row.unit_hash,
          ),
        );
        expect(embeddedHashes.has(staleHash)).toBe(false);
        expect(embeddedHashes.size).toBe(seenTexts.length);

        // Every embedded hash really does belong to one of the two written
        // paths, via the same entries.file_path -> entry_units -> unit_hash
        // mapping indexWrittenAssets itself computes.
        const reachable = dbAfter
          .prepare(
            `SELECT DISTINCT eu.unit_hash AS unitHash
               FROM entries e JOIN entry_units eu ON eu.entry_id = e.id
              WHERE e.file_path IN (?, ?)`,
          )
          .all(firstPath, secondPath) as Array<{ unitHash: string }>;
        expect(embeddedHashes).toEqual(new Set(reachable.map((row) => row.unitHash)));
      } finally {
        closeDatabase(dbAfter);
      }
    });

    test("a call touching zero units after filtering asks the drain for nothing", async () => {
      writeSandboxConfig(semanticConfigOverrides());
      let calls = 0;
      const mock: EmbedBatchMock = async (texts) => {
        calls++;
        return texts.map(() => undefined);
      };
      overrideSeam(_setEmbedderForTests, { embedBatch: mock });

      await indexWrittenAssets(stashDir, [path.join(stashDir, "memories", "never-written.md")]);

      expect(calls).toBe(0);
    });
  });
});
