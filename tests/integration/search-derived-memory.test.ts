/**
 * Phase 5A / Advantage D5 — derived memory as a metadata fallback.
 *
 * Asserts that when a parent memory has a `.derived` child indexed, search
 * for the parent surfaces:
 *   - `expandTo` pointing at the derived child's ref, and
 *   - missing `description` / `tags` supplied by the derived child
 * while the parent ref itself remains the canonical entry on the hit.
 *
 * Default-safe assertion: a parent memory WITHOUT a derived child is
 * unaffected — no `expandTo`, no description/tags rewrite.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmSearch } from "../../src/commands/read/search";
import { resetConfigCache, saveConfig } from "../../src/core/config/config";
import { getDbPath } from "../../src/core/paths";
import { deriveEntryProvenance } from "../../src/indexer/installations";
import type { IndexDocument } from "../../src/indexer/passes/metadata";
import { buildDbHit } from "../../src/indexer/search/db-search";
import {
  buildUsageEventAttribution,
  copySearchHitAttribution,
  getSearchHitAttribution,
} from "../../src/indexer/search/search-attribution";
import { closeDatabase, openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../src/storage/repositories/index-entries-repository";
import { rebuildFts } from "../../src/storage/repositories/index-fts-repository";
import { setMeta } from "../../src/storage/repositories/index-meta-repository";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
  sandboxXdgStateHome,
} from "../_helpers/sandbox";

// ── Environment isolation ───────────────────────────────────────────────────
//
// The fixture corpus is built ONCE in beforeAll and every test only searches
// it (read-only). Because the suite runs all test files in ONE process sharing
// process.env, the env vars this file's index DB depends on must be re-asserted
// before EACH test (the index DB resolves at call time from
// $XDG_DATA_HOME/akm/index.db). We sandbox to STABLE per-file dirs created once
// in beforeAll and re-point at them in beforeEach so the prebuilt index is
// reused while a concurrently-interleaved file can't clobber our paths mid-run.

let stashDir = "";
let fileCacheHome = "";
let fileConfigHome = "";
let fileDataHome = "";
let fileStateHome = "";
let envCleanup: Cleanup = () => {};

beforeAll(() => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const dataResult = sandboxXdgDataHome(cfgResult.cleanup);
  const stateResult = sandboxXdgStateHome(dataResult.cleanup);
  const stashResult = sandboxStashDir(stateResult.cleanup);
  fileCacheHome = cacheResult.dir;
  fileConfigHome = cfgResult.dir;
  fileDataHome = dataResult.dir;
  fileStateHome = stateResult.dir;
  stashDir = stashResult.dir;
  envCleanup = stashResult.cleanup;

  resetConfigCache();
  saveConfig({
    semanticSearchMode: "off",
    bundles: { stash: { path: stashDir } },
    defaultBundle: "stash",
    registries: [],
  });

  buildFixture();
});

beforeEach(() => {
  // Re-establish the env vars this file's pre-built index depends on, pointing
  // back at the SAME stable per-file dirs (not fresh ones) so the index built
  // in beforeAll is reused.
  process.env.XDG_CACHE_HOME = fileCacheHome;
  process.env.XDG_CONFIG_HOME = fileConfigHome;
  process.env.XDG_DATA_HOME = fileDataHome;
  process.env.XDG_STATE_HOME = fileStateHome;
  process.env.AKM_BUNDLE_DIR = stashDir;
  resetConfigCache();
});

afterAll(() => {
  envCleanup();
  envCleanup = () => {};
  resetConfigCache();
});

function buildFixture(): void {
  const memoryDir = path.join(stashDir, "memories");
  fs.mkdirSync(memoryDir, { recursive: true });

  // Parent memory: terse hot-captured note. Authored caveats must survive a more confident derived child.
  const parentPath = path.join(memoryDir, "claude-prefs.md");
  fs.writeFileSync(parentPath, "---\ntype: memory\n---\nUse three-space indent and no semicolons.\n");

  // Derived child: distilled lesson surface — captured the same parent's
  // intent in richer language with explicit tags.
  const derivedPath = path.join(memoryDir, "claude-prefs.derived.md");
  fs.writeFileSync(
    derivedPath,
    "---\ntype: memory\ninferred: true\nsource: memories/claude-prefs\nderivedFrom: claude-prefs\n---\nDistilled style: three spaces, no semicolons, prefer .ts.\n",
  );

  // A second parent that has NO derived child — default-safety baseline.
  const lonelyPath = path.join(memoryDir, "lonely-pref.md");
  fs.writeFileSync(lonelyPath, "---\ntype: memory\n---\nAlways prefix branch names with feat/.\n");

  // Index everything by hand — we want to exercise the indexer's own
  // derived_from extraction path. See `upsertEntry` + IndexDocument.derivedFrom.
  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openIndexDatabase(dbPath);
  try {
    const entries: Array<{ entry: IndexDocument; filePath: string; dirPath: string }> = [
      {
        entry: {
          name: "claude-prefs",
          type: "memory",
          filename: "claude-prefs.md",
          description: "Do not use semicolons in examples only; production style is uncertain.",
          source: "frontmatter",
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
          // The key field that drives derived_from indexing — the 0.9.0
          // `memories/<name>` conceptId (Group-C item 2), matching the
          // `getDerivedForParent` lookup key the enricher now builds.
          derivedFrom: "memories/claude-prefs",
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
      const provenance = deriveEntryProvenance(
        { bundleId: "stash", componentId: "stash", adapterId: "akm" },
        e.entry.type,
        e.entry.name,
      );
      upsertEntry(db, e.filePath, e.entry, provenance);
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
  test("parent hit preserves authored qualifications and tags while retaining expandTo", async () => {
    const result = await akmSearch({ query: "claude-prefs", source: "local", limit: 10 });
    const parentHit = result.hits.find((h) => h.type === "memory" && h.name === "claude-prefs");
    expect(parentHit).toBeDefined();
    if (!parentHit || !("ref" in parentHit)) return;

    expect(parentHit.expandTo).toBe("memories/claude-prefs.derived");
    // Authored description is not replaced by a stronger derived claim.
    expect(parentHit.description).toBe("Do not use semicolons in examples only; production style is uncertain.");
    // Populated parent tags are not merged with child tags.
    expect(parentHit.tags).toEqual(["style"]);
    // Parent ref is preserved — only surface text is swapped.
    expect(parentHit.ref).toBe("memories/claude-prefs");
  });

  test("memory without a derived child is unchanged (no expandTo, no rewrite)", async () => {
    const result = await akmSearch({ query: "lonely-pref", source: "local", limit: 10 });
    const hit = result.hits.find((h) => h.type === "memory" && h.name === "lonely-pref");
    expect(hit).toBeDefined();
    if (!hit || !("ref" in hit)) return;

    expect(hit.expandTo).toBeUndefined();
    expect(hit.description).toBe("Always prefix branch names with feat/.");
    expect(hit.tags).toEqual(["git"]);
  });

  test("derived child hit is not double-enriched (no recursive expandTo)", async () => {
    const result = await akmSearch({ query: "claude-prefs.derived", source: "local", limit: 10 });
    const derivedHit = result.hits.find((h) => h.type === "memory" && h.name === "claude-prefs.derived");
    expect(derivedHit).toBeDefined();
    if (!derivedHit || !("ref" in derivedHit)) return;
    expect(derivedHit.expandTo).toBeUndefined();
  });
});

// Replay complete indexed parent/child records through the DB-hit boundary.
// No files are read during metadata enrichment.
const fallbackFixtures: Array<{ name: string; parent: Partial<IndexDocument>; fields: Array<"description" | "tags"> }> =
  [
    { name: "missing", parent: {}, fields: ["description", "tags"] },
    { name: "empty", parent: { description: "", tags: [] }, fields: ["description", "tags"] },
    { name: "whitespace", parent: { description: " \t ", tags: [" ", "\t"] }, fields: ["description", "tags"] },
    {
      name: "filename",
      parent: { description: "Generated filename", source: "filename", tags: ["authored"] },
      fields: ["description"],
    },
    { name: "description-only", parent: { tags: ["authored"] }, fields: ["description"] },
    {
      name: "tags-only",
      parent: { description: "Do not restart production; staging only, pending confirmation.", source: "frontmatter" },
      fields: ["tags"],
    },
    {
      name: "unknown-source",
      parent: { description: "An existing caveat with no recorded source.", tags: ["authored"] },
      fields: [],
    },
  ];
for (const fixture of fallbackFixtures) {
  test(`independent metadata fallback: ${fixture.name}`, async () => {
    const db = openIndexDatabase(":memory:");
    const child = {
      name: `${fixture.name}.derived`,
      type: "memory",
      description: "Restart production immediately.",
      tags: ["derived"],
      derivedFrom: `memories/${fixture.name}`,
    };
    try {
      upsertEntry(
        db,
        `/unread/${child.name}.md`,
        child,
        deriveEntryProvenance({ bundleId: "stash", componentId: "stash", adapterId: "akm" }, "memory", child.name),
      );
      const entry: IndexDocument = {
        name: fixture.name,
        type: "memory",
        ...fixture.parent,
        tags: fixture.parent.tags ? [...fixture.parent.tags] : undefined,
      };
      const hit = await buildDbHit({
        entry,
        path: `/unread/${fixture.name}.md`,
        itemRef: `stash//memories/${fixture.name}`,
        bundleId: "stash",
        conceptId: `memories/${fixture.name}`,
        score: 0.25,
        defaultStashDir: stashDir,
        sources: [],
        db,
      });
      expect(hit.description).toBe(fixture.fields.includes("description") ? child.description : entry.description);
      expect(hit.tags).toEqual(fixture.fields.includes("tags") ? child.tags : entry.tags);
      expect(hit.ref).toBe(`stash//memories/${fixture.name}`);
      expect(hit.score).toBe(0.25);
      expect(hit.expandTo).toBe(`stash//memories/${child.name}`);
      const attribution = getSearchHitAttribution(hit);
      expect(attribution?.memoryInference?.surfaceFields ?? []).toEqual([...fixture.fields]);
      const curated = {};
      copySearchHitAttribution(hit, curated, hit.description);
      expect(getSearchHitAttribution(curated)?.memoryInference?.surfaceFields ?? []).toEqual(
        fixture.fields.includes("description") ? ["description"] : [],
      );
      for (const projection of ["brief", "normal", "agent", "full"] as const) {
        const visible =
          projection === "full"
            ? fixture.fields.length > 0
            : projection !== "brief" && fixture.fields.includes("description");
        expect(
          buildUsageEventAttribution(attribution, `stash//memories/${fixture.name}`, projection)?.memoryInference
            ?.exposure,
        ).toBe(visible ? "surface" : undefined);
      }
    } finally {
      closeDatabase(db);
    }
  });
}
