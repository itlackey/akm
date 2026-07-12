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
import { getDbPath, getIndexWriterLockPath } from "../../src/core/paths";
import { closeDatabase, openExistingDatabase } from "../../src/indexer/db/db";
import { indexWrittenAssets } from "../../src/indexer/index-written-assets";
import { akmIndex } from "../../src/indexer/indexer";
import {
  type Cleanup,
  sandboxEnvDir,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  writeSandboxConfig,
} from "../_helpers/sandbox";

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
    const entryNames = (db.prepare("SELECT entry_json FROM entries").all() as Array<{ entry_json: string }>).map(
      (r) => (JSON.parse(r.entry_json) as { name: string }).name,
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

  test("indexes a workflow entry AND its workflow_documents side-table row (PR-715 review)", async () => {
    // `akm mv` rewrites citer files that can be workflows, so the fast path
    // must mirror the full walk: upsert the entry, then the parsed document.
    const filePath = path.join(stashDir, "workflows", "rewritten-citer.md");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      [
        "---",
        "description: workflow citing a moved xylophone memory",
        "---",
        "",
        "# Workflow: Rewritten Citer",
        "",
        "## Step: First",
        "Step ID: first",
        "",
        "### Instructions",
        "Read memory:xylophone-note and act.",
        "",
      ].join("\n"),
      "utf8",
    );
    await indexWrittenAssets(stashDir, [filePath]);

    const db = openExistingDatabase(getDbPath());
    try {
      const row = db.prepare("SELECT id, entry_json FROM entries WHERE file_path = ?").get(filePath) as {
        id: number;
        entry_json: string;
      } | null;
      expect(row).not.toBeNull();
      expect((JSON.parse((row as { entry_json: string }).entry_json) as { type: string }).type).toBe("workflow");
      const doc = db
        .prepare("SELECT COUNT(*) AS c FROM workflow_documents WHERE entry_id = ?")
        .get((row as { id: number }).id) as { c: number };
      expect(doc.c).toBe(1);
    } finally {
      closeDatabase(db);
    }
  });

  test("waits for a full-index writer lease before publishing a targeted update", async () => {
    const filePath = writeMemory("serialized-write", "Targeted update.");
    const lockPath = getIndexWriterLockPath();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }), "utf8");

    const update = indexWrittenAssets(stashDir, [filePath]);
    await Bun.sleep(150);
    expect(queryIndex().entryNames).not.toContain("serialized-write");
    fs.rmSync(lockPath, { force: true });
    await update;
    expect(queryIndex().entryNames).toContain("serialized-write");
  });

  test("removes stale metadata when a rewritten file is no longer indexable", async () => {
    const filePath = path.join(stashDir, "workflows", "stale-workflow.md");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      "---\ndescription: Valid workflow\n---\n\n# Workflow: Valid\n\n## Step: First\nStep ID: first\n\n### Instructions\nRun.\n",
      "utf8",
    );
    await indexWrittenAssets(stashDir, [filePath]);
    expect(indexedFileCount(filePath)).toBe(1);

    fs.writeFileSync(filePath, "---\ndescription: Broken workflow\n---\n\nNo workflow heading.\n", "utf8");
    await indexWrittenAssets(stashDir, [filePath]);
    expect(indexedFileCount(filePath)).toBe(0);
  });
});
