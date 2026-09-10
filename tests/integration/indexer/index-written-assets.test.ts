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
 * now a thin call to B1's `reconcilePaths` (stubbed in this branch — see
 * src/indexer/reconcile.ts's header) followed by B4's `drainEmbeddingQueue`
 * (also stubbed — see src/indexer/drain.ts's header), scoped to exactly the
 * units the write produced. This suite covers what module B2 owns: the
 * lexical-searchability guarantee and the onlyHashes wiring between the two
 * calls, plus the fail-open skips that are still B2's responsibility (absent
 * index, unreadable index, a missing/unindexable file). It no longer covers
 * the rebuild-lock skip (#956) — the redesign has no rebuild lock to probe —
 * nor real embedding-provider behavior, which moves to B4's own test suite
 * once B4 lands for real.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getDbPath } from "../../../src/core/paths";
import { _drainCallsForTests, _resetDrainCallsForTests } from "../../../src/indexer/drain";
import { indexWrittenAssets } from "../../../src/indexer/index-written-assets";
import { akmIndex } from "../../../src/indexer/indexer";
import { unitHashesForPaths } from "../../../src/indexer/reconcile";
import { closeDatabase, openExistingDatabase } from "../../../src/storage/repositories/index-connection";
import {
  type Cleanup,
  sandboxEnvDir,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  writeSandboxConfig,
} from "../../_helpers/sandbox";

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
  _resetDrainCallsForTests();
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

      await indexWrittenAssets(stashDir, [firstPath, secondPath]);

      const calls = _drainCallsForTests();
      expect(calls).toHaveLength(1);
      const requested = calls[0]?.onlyHashes ?? [];

      // Non-empty, well-formed unit hashes (sha256 hex from hashEmbeddableText) —
      // not a placeholder or an empty pass-through.
      expect(requested.length).toBeGreaterThan(0);
      for (const hash of requested) expect(hash).toMatch(/^[0-9a-f]{64}$/);

      // Exactly what reconcilePaths derived for these two paths — no
      // duplicates, nothing dropped, nothing from an unrelated entry
      // (the beforeEach-seeded "seed-memory" is not among these paths).
      const expected = unitHashesForPaths([firstPath, secondPath]);
      expect(new Set(requested)).toEqual(new Set(expected));
      expect(requested.length).toBe(new Set(requested).size);

      // Two files with different content must not collapse to the same hash
      // set — proves the wiring carries real per-file hashes, not a fixed
      // stand-in value.
      const firstOnly = unitHashesForPaths([firstPath]);
      const secondOnly = unitHashesForPaths([secondPath]);
      expect(new Set(firstOnly)).not.toEqual(new Set(secondOnly));
      expect(new Set(requested)).toEqual(new Set([...firstOnly, ...secondOnly]));
    });

    test("a call touching zero units after filtering asks the drain for nothing", async () => {
      await indexWrittenAssets(stashDir, [path.join(stashDir, "memories", "never-written.md")]);

      const calls = _drainCallsForTests();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.onlyHashes).toEqual([]);
    });
  });
});
