// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests for `indexWrittenAssets` — the write-path single-file index update
 * used by `writeMarkdownAsset` (akm remember / knowledge writes) and extract's
 * session assets, so just-written assets are searchable immediately without
 * any read-triggered reindex.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmSearch } from "../../../src/commands/read/search";
import { getDbPath, getIndexRebuildLockPath } from "../../../src/core/paths";
import { _setWarnSinkForTests } from "../../../src/core/warn";
import { indexWrittenAssets } from "../../../src/indexer/index-written-assets";
import { akmIndex } from "../../../src/indexer/indexer";
import { _setEmbedderForTests } from "../../../src/llm/embedder";
import { closeDatabase, openExistingDatabase } from "../../../src/storage/repositories/index-connection";
import { getMeta } from "../../../src/storage/repositories/index-meta-repository";
import {
  isVecAvailable,
  isVecFastPathReady,
  searchVec,
  setVecFastPathReady,
  upsertEmbedding,
} from "../../../src/storage/repositories/index-vec-repository";
import {
  type Cleanup,
  sandboxEnvDir,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  writeSandboxConfig,
} from "../../_helpers/sandbox";
import { overrideSeam } from "../../_helpers/seams";

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
      ? (db.prepare("SELECT COUNT(*) AS c FROM entries_fts WHERE entries_fts MATCH ?").get(ftsTerm) as { c: number }).c
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

function embeddingCountForFile(filePath: string): number {
  const db = openExistingDatabase(getDbPath());
  try {
    return (
      db
        .prepare(
          `SELECT COUNT(*) AS c
             FROM embeddings b
             JOIN entries e ON e.id = b.id
            WHERE e.file_path = ?`,
        )
        .get(filePath) as { c: number }
    ).c;
  } finally {
    closeDatabase(db);
  }
}

function installSemanticTestEmbedder(): void {
  const vectorFor = (text: string): number[] =>
    text.includes("fuel-delivery") || text.includes("gasoline") ? [0, 1, 0, 0] : [1, 0, 0, 0];
  overrideSeam(_setEmbedderForTests, {
    embed: async (text) => vectorFor(text),
    embedBatch: async (texts, _config, _signal, _onSkip, onBatch) => {
      const embeddings = texts.map(vectorFor);
      // The materializer commits per onBatch call (#954); a fake standing in
      // for a whole provider must still fire it, or its writes never land.
      onBatch?.(
        texts.map((_t, i) => i),
        embeddings,
      );
      return embeddings;
    },
  });
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

  test("a successful targeted write is immediately visible to semantic-only retrieval", async () => {
    installSemanticTestEmbedder();
    writeSandboxConfig({ semanticSearchMode: "auto" });
    await akmIndex({ stashDir, full: true });

    const filePath = writeMemory("fuel-delivery-note", "Procedures for refueling fleet vehicles.");
    expect(await indexWrittenAssets(stashDir, [filePath])).toBe(true);

    expect(embeddingCountForFile(filePath)).toBe(1);
    const dbAfterWrite = openExistingDatabase(getDbPath());
    try {
      expect(getMeta(dbAfterWrite, "hasEmbeddings")).toBe("1");
    } finally {
      closeDatabase(dbAfterWrite);
    }
    const search = await akmSearch({ query: "gasoline", skipLogging: true });
    expect(search.searchMode).toBe("semantic");
    expect(search.hits.flatMap((hit) => ("ref" in hit ? [hit.ref] : []))).toContain("memories/fuel-delivery-note");
  });

  test("a targeted success cannot promote a globally incomplete vec fast path", async () => {
    const vector = Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0));
    overrideSeam(_setEmbedderForTests, {
      embed: async () => vector,
      embedBatch: async (texts, _config, _signal, _onSkip, onBatch) => {
        const embeddings = texts.map(() => vector);
        // The materializer commits per onBatch call (#954); a fake standing
        // in for a whole provider must still fire it, or its writes never land.
        onBatch?.(
          texts.map((_t, i) => i),
          embeddings,
        );
        return embeddings;
      },
    });
    writeSandboxConfig({ semanticSearchMode: "auto" });
    writeMemory("second-existing-memory", "A second entry establishes the degraded generation.");
    await akmIndex({ stashDir, full: true });

    const degradedDb = openExistingDatabase(getDbPath());
    try {
      expect(isVecAvailable(degradedDb)).toBe(true);
      const ids = (degradedDb.prepare("SELECT id FROM entries ORDER BY id").all() as Array<{ id: number }>).map(
        (row) => row.id,
      );
      expect(ids).toHaveLength(2);
      expect(degradedDb.prepare("SELECT COUNT(*) AS count FROM embeddings").get()).toEqual({ count: 2 });

      const retainedVecId = ids[1];
      if (retainedVecId === undefined) throw new Error("expected two seeded embedding rows");
      degradedDb.prepare("DELETE FROM entries_vec").run();
      expect(upsertEmbedding(degradedDb, retainedVecId, vector).vec).toBe("ok");
      setVecFastPathReady(degradedDb, false);
      expect(degradedDb.prepare("SELECT COUNT(*) AS count FROM entries_vec").get()).toEqual({ count: 1 });
    } finally {
      closeDatabase(degradedDb);
    }

    const freshFile = writeMemory("targeted-after-degradation", "This targeted write embeds successfully.");
    expect(await indexWrittenAssets(stashDir, [freshFile])).toBe(true);

    const verifiedDb = openExistingDatabase(getDbPath());
    try {
      const allIds = (verifiedDb.prepare("SELECT id FROM entries ORDER BY id").all() as Array<{ id: number }>).map(
        (row) => row.id,
      );
      expect(verifiedDb.prepare("SELECT COUNT(*) AS count FROM embeddings").get()).toEqual({ count: 3 });
      expect(verifiedDb.prepare("SELECT COUNT(*) AS count FROM entries_vec").get()).toEqual({ count: 2 });
      expect(isVecFastPathReady(verifiedDb)).toBe(false);
      expect(
        searchVec(verifiedDb, vector, 10)
          .map((result) => result.id)
          .sort((left, right) => left - right),
      ).toEqual(allIds);
    } finally {
      closeDatabase(verifiedDb);
    }
  });

  test("embedding failure preserves the authored file and FTS row and reports the failure live", async () => {
    installSemanticTestEmbedder();
    writeSandboxConfig({
      semanticSearchMode: "auto",
      embedding: { endpoint: "https://embeddings.example.invalid/v1", model: "test-model" },
    });
    await akmIndex({ stashDir, full: true });
    overrideSeam(_setEmbedderForTests, {
      embed: async () => {
        throw new Error("embedding provider network unreachable");
      },
      embedBatch: async () => {
        throw new Error("embedding provider network unreachable");
      },
    });

    const filePath = writeMemory("offline-provider-note", "Lexical fallback remains available.");
    expect(await indexWrittenAssets(stashDir, [filePath])).toBe(true);

    expect(fs.existsSync(filePath)).toBe(true);
    expect(queryIndex("offline").entryNames).toContain("offline-provider-note");
    expect(queryIndex("offline").ftsCount).toBeGreaterThan(0);
    expect(embeddingCountForFile(filePath)).toBe(0);
    const dbAfterFailure = openExistingDatabase(getDbPath());
    try {
      expect(getMeta(dbAfterFailure, "hasEmbeddings")).toBe("0");
    } finally {
      closeDatabase(dbAfterFailure);
    }
    // Query-time semantic search is attempted fresh (no cached verdict short-
    // circuits it) and hits the same broken embedder live, falling back to
    // FTS and disclosing it in this response.
    const search = await akmSearch({ query: "offline-provider-note", skipLogging: true });
    expect(search.hits.flatMap((hit) => ("ref" in hit ? [hit.ref] : []))).toContain("memories/offline-provider-note");
    expect(search.warnings?.join("\n")).toContain("Vector search unavailable");
    expect(search.searchMode).toBe("fts-fallback");
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

  describe("rebuild lock (#956)", () => {
    afterEach(() => {
      _setWarnSinkForTests(undefined);
    });

    function plantHeldRebuildLock(): string {
      const lockPath = getIndexRebuildLockPath();
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }), "utf8");
      return lockPath;
    }

    test("skips the inline upsert while a rebuild holds the lock, warns once, reports success, and never opens index.db", async () => {
      const lockPath = plantHeldRebuildLock();
      const filePath = writeMemory("busy-rebuild-note", "Written while a rebuild holds the lock.");

      const notices: string[] = [];
      _setWarnSinkForTests((level, args) => {
        if (level === "warn") notices.push(args.map(String).join(" "));
      });

      // A live rebuild owns bringing the index to the expected state; the
      // skip is fail-open success (#956 fix), not a failure — a caller that
      // gates on this boolean (acceptProposal, source clone) must not fail.
      expect(await indexWrittenAssets(stashDir, [filePath])).toBe(true);

      expect(notices.some((n) => /index rebuild in progress \(pid \d+\)/.test(n) && n.includes(filePath))).toBe(true);
      expect(indexedFileCount(filePath)).toBe(0);
      fs.rmSync(lockPath);
      // Once the rebuild finishes and releases its lock, the same write-path
      // upsert heals the missing entry.
      expect(await indexWrittenAssets(stashDir, [filePath])).toBe(true);
      expect(indexedFileCount(filePath)).toBeGreaterThan(0);
    });

    test("names the launcher pid alongside the holder pid when the lock payload recorded one (#956)", async () => {
      const lockPath = getIndexRebuildLockPath();
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.ppid, launcherPid: 4240, startedAt: new Date().toISOString() }),
        "utf8",
      );
      const filePath = writeMemory("launcher-note", "Written while a launcher-tracked rebuild holds the lock.");

      const notices: string[] = [];
      _setWarnSinkForTests((level, args) => {
        if (level === "warn") notices.push(args.map(String).join(" "));
      });

      expect(await indexWrittenAssets(stashDir, [filePath])).toBe(true);

      expect(
        notices.some((n) =>
          new RegExp(`index rebuild in progress \\(pid ${process.ppid} \\(launcher 4240\\)\\)`).test(n),
        ),
      ).toBe(true);
      fs.rmSync(lockPath);
    });

    test("a dead-pid rebuild lock does not block the write-path upsert", async () => {
      const lockPath = getIndexRebuildLockPath();
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 999_999, startedAt: new Date(0).toISOString() }), "utf8");

      const filePath = writeMemory("dead-lock-note", "A stale rebuild lock must not block this.");
      expect(await indexWrittenAssets(stashDir, [filePath])).toBe(true);
      expect(indexedFileCount(filePath)).toBeGreaterThan(0);
      // The write path only probes — reclaiming a stale lock stays `akm
      // index`'s job, not every writer's.
      expect(fs.existsSync(lockPath)).toBe(true);
    });
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
});
