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
import { getDbPath } from "../../src/core/paths";
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
});
