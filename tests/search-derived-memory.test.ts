/**
 * Phase 5A / Advantage D5 — derived memory as primary retrieval target.
 *
 * Asserts that when a parent memory has a `.derived` child indexed, search
 * for the parent surfaces:
 *   - `expandTo` pointing at the derived child's ref, and
 *   - `description` / `tags` swapped in from the derived child
 * while the parent ref itself remains the canonical entry on the hit.
 *
 * Default-safe assertion: a parent memory WITHOUT a derived child is
 * unaffected — no `expandTo`, no description/tags rewrite.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmSearch } from "../src/commands/search";
import { resetConfigCache, saveConfig } from "../src/core/config";
import { getDbPath } from "../src/core/paths";
import { closeDatabase, openDatabase, rebuildFts, setMeta, upsertEntry } from "../src/indexer/db";
import type { StashEntry } from "../src/indexer/metadata";
import { buildSearchText } from "../src/indexer/search-fields";

// ── Environment isolation ───────────────────────────────────────────────────

let stashDir = "";
let originalXdgCacheHome: string | undefined;
let originalXdgConfigHome: string | undefined;
let originalXdgDataHome: string | undefined;
let originalXdgStateHome: string | undefined;
let originalAkmStashDir: string | undefined;
let testCacheDir = "";
let testConfigDir = "";
let testDataDir = "";
let testStateDir = "";

beforeAll(() => {
  originalXdgCacheHome = process.env.XDG_CACHE_HOME;
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  originalXdgDataHome = process.env.XDG_DATA_HOME;
  originalXdgStateHome = process.env.XDG_STATE_HOME;
  originalAkmStashDir = process.env.AKM_STASH_DIR;

  testCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-derived-cache-"));
  testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-derived-config-"));
  testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-derived-data-"));
  testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-derived-state-"));
  stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-derived-stash-"));

  process.env.XDG_CACHE_HOME = testCacheDir;
  process.env.XDG_CONFIG_HOME = testConfigDir;
  process.env.XDG_DATA_HOME = testDataDir;
  process.env.XDG_STATE_HOME = testStateDir;
  process.env.AKM_STASH_DIR = stashDir;

  resetConfigCache();
  saveConfig({
    semanticSearchMode: "off",
    sources: [{ type: "filesystem", path: stashDir }],
    registries: [],
  });

  buildFixture();
});

afterAll(() => {
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdgDataHome;
  if (originalXdgStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalXdgStateHome;
  if (originalAkmStashDir === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = originalAkmStashDir;
  resetConfigCache();
  for (const dir of [testCacheDir, testConfigDir, testDataDir, testStateDir, stashDir]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function buildFixture(): void {
  const memoryDir = path.join(stashDir, "memories");
  fs.mkdirSync(memoryDir, { recursive: true });

  // Parent memory: terse hot-captured note. Description deliberately bland
  // so the swap-in from the derived child is observable in the test.
  const parentPath = path.join(memoryDir, "claude-prefs.md");
  fs.writeFileSync(parentPath, "---\ntype: memory\n---\nUse three-space indent and no semicolons.\n");

  // Derived child: distilled lesson surface — captured the same parent's
  // intent in richer language with explicit tags.
  const derivedPath = path.join(memoryDir, "claude-prefs.derived.md");
  fs.writeFileSync(
    derivedPath,
    "---\ntype: memory\ninferred: true\nsource: memory:claude-prefs\nderivedFrom: claude-prefs\n---\nDistilled style: three spaces, no semicolons, prefer .ts.\n",
  );

  // A second parent that has NO derived child — default-safety baseline.
  const lonelyPath = path.join(memoryDir, "lonely-pref.md");
  fs.writeFileSync(lonelyPath, "---\ntype: memory\n---\nAlways prefix branch names with feat/.\n");

  // Index everything by hand — we want to exercise the indexer's own
  // derived_from extraction path. See `upsertEntry` + StashEntry.derivedFrom.
  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  try {
    const entries: Array<{ entry: StashEntry; filePath: string; dirPath: string }> = [
      {
        entry: {
          name: "claude-prefs",
          type: "memory",
          filename: "claude-prefs.md",
          description: "Use three-space indent and no semicolons.",
          tags: ["style"],
        },
        filePath: parentPath,
        dirPath: memoryDir,
      },
      {
        entry: {
          name: "claude-prefs.derived",
          type: "memory",
          filename: "claude-prefs.derived.md",
          description: "Distilled Claude style preferences: three-space indent, no semicolons, prefer TypeScript.",
          tags: ["claude", "style", "typescript"],
          searchHints: ["claude style", "three spaces"],
          // The key field that drives derived_from indexing:
          derivedFrom: "memory:claude-prefs",
        },
        filePath: derivedPath,
        dirPath: memoryDir,
      },
      {
        entry: {
          name: "lonely-pref",
          type: "memory",
          filename: "lonely-pref.md",
          description: "Always prefix branch names with feat/.",
          tags: ["git"],
        },
        filePath: lonelyPath,
        dirPath: memoryDir,
      },
    ];
    for (const e of entries) {
      const entryKey = `${stashDir}:${e.entry.type}:${e.entry.name}`;
      const searchText = buildSearchText(e.entry);
      upsertEntry(db, entryKey, e.dirPath, e.filePath, stashDir, e.entry, searchText);
    }
    rebuildFts(db);
    setMeta(db, "stashDir", stashDir);
    setMeta(db, "builtAt", new Date().toISOString());
    setMeta(db, "stashDirs", JSON.stringify([stashDir]));
    setMeta(db, "hasEmbeddings", "0");
  } finally {
    closeDatabase(db);
  }
}

describe("derived-memory search enrichment (Phase 5A / Advantage D5)", () => {
  test("parent hit gains expandTo + derived child's description/tags when child exists", async () => {
    const result = await akmSearch({ query: "claude-prefs", source: "stash", limit: 10 });
    const parentHit = result.hits.find((h) => h.type === "memory" && h.name === "claude-prefs");
    expect(parentHit).toBeDefined();
    if (!parentHit) return;

    expect(parentHit.expandTo).toBe("memory:claude-prefs.derived");
    // Description swapped in from the derived child.
    expect(parentHit.description).toBe(
      "Distilled Claude style preferences: three-space indent, no semicolons, prefer TypeScript.",
    );
    // Tags swapped in from the derived child.
    expect(parentHit.tags).toEqual(["claude", "style", "typescript"]);
    // Parent ref is preserved — only surface text is swapped.
    expect(parentHit.ref).toBe("memory:claude-prefs");
  });

  test("memory without a derived child is unchanged (no expandTo, no rewrite)", async () => {
    const result = await akmSearch({ query: "lonely-pref", source: "stash", limit: 10 });
    const hit = result.hits.find((h) => h.type === "memory" && h.name === "lonely-pref");
    expect(hit).toBeDefined();
    if (!hit) return;

    expect(hit.expandTo).toBeUndefined();
    expect(hit.description).toBe("Always prefix branch names with feat/.");
    expect(hit.tags).toEqual(["git"]);
  });

  test("derived child hit is not double-enriched (no recursive expandTo)", async () => {
    const result = await akmSearch({ query: "claude-prefs.derived", source: "stash", limit: 10 });
    const derivedHit = result.hits.find((h) => h.type === "memory" && h.name === "claude-prefs.derived");
    expect(derivedHit).toBeDefined();
    if (!derivedHit) return;
    expect(derivedHit.expandTo).toBeUndefined();
  });
});
