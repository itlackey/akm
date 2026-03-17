import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDatabase, DB_VERSION, openDatabase, rebuildFts, searchFts, upsertEntry } from "../src/db";
import { buildSearchFields } from "../src/indexer";
import type { StashEntry } from "../src/metadata";

// ── Temp directory management ───────────────────────────────────────────────

const createdTmpDirs: string[] = [];

function tmpDir(label = "fts"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `akm-${label}-`));
  createdTmpDirs.push(dir);
  return dir;
}

function tmpDbPath(label = "fts"): string {
  const dir = tmpDir(label);
  return path.join(dir, "test.db");
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Environment isolation ───────────────────────────────────────────────────

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv.XDG_CACHE_HOME = process.env.XDG_CACHE_HOME;
  savedEnv.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CACHE_HOME = tmpDir("cache");
  process.env.XDG_CONFIG_HOME = tmpDir("config");
});

afterEach(() => {
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<StashEntry> & { name: string; type: string }): StashEntry {
  return {
    description: "A test entry",
    ...overrides,
  };
}

function insertEntry(db: Database, key: string, entry: StashEntry, searchText: string): number {
  return upsertEntry(db, key, "/test/dir", `/test/dir/${key}.ts`, "/test/stash", entry, searchText);
}

// ── Test 1: Name match ranks higher than description-only match ─────────────

describe("FTS5 field weighting", () => {
  test("name match ranks higher than description-only match", () => {
    const db = openDatabase(tmpDbPath());
    try {
      // Entry with "deploy" in the name
      const nameEntry = makeEntry({
        name: "deploy",
        type: "script",
        description: "Runs a production release process",
      });
      insertEntry(db, "name-deploy", nameEntry, "deploy");

      // Entry with "deploy" only in the description
      const descEntry = makeEntry({
        name: "release-tool",
        type: "script",
        description: "Used to deploy applications to staging servers",
      });
      insertEntry(db, "desc-deploy", descEntry, "deploy");

      rebuildFts(db);

      const results = searchFts(db, "deploy", 10);
      expect(results.length).toBe(2);
      // The name match should rank first (lower bm25 score = better in FTS5)
      expect(results[0].entry.name).toBe("deploy");
    } finally {
      closeDatabase(db);
    }
  });

  // ── Test 2: Name match ranks higher than tag-only match ─────────────────

  test("name match ranks higher than tag-only match", () => {
    const db = openDatabase(tmpDbPath());
    try {
      // Entry with "kubernetes" in the name
      const nameEntry = makeEntry({
        name: "kubernetes",
        type: "script",
        description: "Container orchestration management tool",
      });
      insertEntry(db, "name-k8s", nameEntry, "kubernetes");

      // Entry with "kubernetes" only in tags
      const tagEntry = makeEntry({
        name: "container-manager",
        type: "script",
        description: "Manages container lifecycle operations",
        tags: ["kubernetes", "docker"],
      });
      insertEntry(db, "tag-k8s", tagEntry, "kubernetes");

      rebuildFts(db);

      const results = searchFts(db, "kubernetes", 10);
      expect(results.length).toBe(2);
      expect(results[0].entry.name).toBe("kubernetes");
    } finally {
      closeDatabase(db);
    }
  });

  // ── Test 3: Description match ranks higher than content-only (TOC) match ──

  test("description match ranks higher than content-only match", () => {
    const db = openDatabase(tmpDbPath());
    try {
      // Entry with "terraform" in description
      const descEntry = makeEntry({
        name: "infra-tool",
        type: "script",
        description: "Uses terraform to provision cloud infrastructure",
      });
      insertEntry(db, "desc-tf", descEntry, "terraform");

      // Entry with "terraform" only in content/TOC
      const contentEntry = makeEntry({
        name: "cloud-guide",
        type: "knowledge",
        description: "Guide to cloud architecture patterns",
        toc: [{ text: "terraform setup", depth: 2 }],
      });
      insertEntry(db, "content-tf", contentEntry, "terraform");

      rebuildFts(db);

      const results = searchFts(db, "terraform", 10);
      expect(results.length).toBe(2);
      expect(results[0].entry.name).toBe("infra-tool");
    } finally {
      closeDatabase(db);
    }
  });

  // ── Test 4: Multi-field matches rank highest ──────────────────────────────

  test("multi-field matches rank highest", () => {
    const db = openDatabase(tmpDbPath());
    try {
      // Entry with "deploy" in BOTH name and description
      const multiEntry = makeEntry({
        name: "deploy",
        type: "script",
        description: "Deploy applications to production deploy pipelines",
        tags: ["deploy"],
      });
      insertEntry(db, "multi-deploy", multiEntry, "deploy");

      // Entry with "deploy" only in name
      const nameOnlyEntry = makeEntry({
        name: "deploy-lite",
        type: "script",
        description: "Lightweight release process for staging",
      });
      insertEntry(db, "name-deploy", nameOnlyEntry, "deploy");

      rebuildFts(db);

      const results = searchFts(db, "deploy", 10);
      expect(results.length).toBe(2);
      // The multi-field match should rank first
      expect(results[0].entry.name).toBe("deploy");
    } finally {
      closeDatabase(db);
    }
  });

  // ── Test 5: FTS5 table has separate columns ───────────────────────────────

  test("FTS5 table has separate columns", () => {
    const db = openDatabase(tmpDbPath());
    try {
      // Query the FTS5 table config to verify it has the expected columns
      // FTS5 tables expose column info via sqlite_master
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'entries_fts'").get() as
        | { sql: string }
        | undefined;
      expect(row).toBeDefined();
      const sql = (row as { sql: string }).sql.toLowerCase();
      // Should have separate columns instead of a single search_text
      expect(sql).toContain("name");
      expect(sql).toContain("description");
      expect(sql).toContain("tags");
      expect(sql).toContain("hints");
      expect(sql).toContain("content");
      // Should NOT have the old single search_text column
      expect(sql).not.toContain("search_text");
    } finally {
      closeDatabase(db);
    }
  });

  // ── Test 6: DB_VERSION is incremented ─────────────────────────────────────

  test("DB_VERSION is incremented from 6 to 7", () => {
    expect(DB_VERSION).toBe(7);
  });

  // ── Test 7: Existing search queries still return results ──────────────────

  test("existing search queries still return results (no regression)", () => {
    const db = openDatabase(tmpDbPath());
    try {
      const entry = makeEntry({
        name: "deploy-tool",
        type: "script",
        description: "Deploy applications to production servers",
        tags: ["deploy", "production"],
        searchHints: ["release management"],
      });
      insertEntry(
        db,
        "deploy-tool",
        entry,
        "deploy tool deploy applications to production servers deploy production release management",
      );

      rebuildFts(db);

      // Verify various query patterns still work
      const deployResults = searchFts(db, "deploy", 10);
      expect(deployResults.length).toBeGreaterThanOrEqual(1);

      const productionResults = searchFts(db, "production", 10);
      expect(productionResults.length).toBeGreaterThanOrEqual(1);

      const multiWordResults = searchFts(db, "deploy production", 10);
      expect(multiWordResults.length).toBeGreaterThanOrEqual(1);
    } finally {
      closeDatabase(db);
    }
  });
});

// ── Test buildSearchFields ──────────────────────────────────────────────────

describe("buildSearchFields", () => {
  test("returns separate field strings from entry", () => {
    const entry = makeEntry({
      name: "deploy-tool",
      type: "script",
      description: "Deploy applications to production",
      tags: ["deploy", "production"],
      searchHints: ["release management", "rollout"],
      toc: [
        { text: "Getting Started", depth: 1 },
        { text: "Configuration", depth: 2 },
      ],
    });

    const fields = buildSearchFields(entry);
    expect(fields.name).toContain("deploy");
    expect(fields.name).toContain("tool");
    expect(fields.description).toContain("deploy applications to production");
    expect(fields.tags).toContain("deploy");
    expect(fields.tags).toContain("production");
    expect(fields.hints).toContain("release management");
    expect(fields.hints).toContain("rollout");
    expect(fields.content).toContain("getting started");
    expect(fields.content).toContain("configuration");
  });

  test("handles entry with minimal fields", () => {
    const entry = makeEntry({
      name: "simple",
      type: "script",
    });

    const fields = buildSearchFields(entry);
    expect(fields.name).toBe("simple");
    expect(fields.description).toBe("a test entry");
    expect(fields.tags).toBe("");
    expect(fields.hints).toBe("");
    expect(fields.content).toBe("");
  });
});
