import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assembleInfo } from "../src/commands/info";
import { loadConfig, saveConfig } from "../src/core/config";
import { closeDatabase, openDatabase, rebuildFts, searchVec, setMeta, upsertEmbedding, upsertEntry } from "../src/indexer/db";
import type { StashEntry } from "../src/indexer/metadata";

// ── Temp directory management ───────────────────────────────────────────────

const createdTmpDirs: string[] = [];

function tmpDir(label = "info"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `akm-${label}-`));
  createdTmpDirs.push(dir);
  return dir;
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
  savedEnv.AKM_STASH_DIR = process.env.AKM_STASH_DIR;
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

function makeStashDir(): string {
  const dir = tmpDir("stash");
  // Create minimal stash structure
  fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
  return dir;
}

function makeEntry(type: string, name: string): StashEntry {
  return {
    type,
    name,
    description: `A test ${type}`,
    tags: ["test"],
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("assembleInfo", () => {
  test("returns a version string", () => {
    const stashDir = makeStashDir();
    process.env.AKM_STASH_DIR = stashDir;

    const info = assembleInfo();

    expect(typeof info.version).toBe("string");
    expect(info.version.length).toBeGreaterThan(0);
  });

  test("returns assetTypes array with built-in types", () => {
    const stashDir = makeStashDir();
    process.env.AKM_STASH_DIR = stashDir;

    const info = assembleInfo();

    expect(Array.isArray(info.assetTypes)).toBe(true);
    expect(info.assetTypes).toContain("skill");
    expect(info.assetTypes).toContain("command");
    expect(info.assetTypes).toContain("agent");
    expect(info.assetTypes).toContain("knowledge");
    expect(info.assetTypes).toContain("script");
    expect(info.assetTypes).toContain("memory");
  });

  test("returns searchModes array", () => {
    const stashDir = makeStashDir();
    process.env.AKM_STASH_DIR = stashDir;

    const info = assembleInfo();

    expect(Array.isArray(info.searchModes)).toBe(true);
    // fts is always available
    expect(info.searchModes).toContain("fts");
  });

  test("works without an index (entryCount: 0)", () => {
    const stashDir = makeStashDir();
    process.env.AKM_STASH_DIR = stashDir;

    const info = assembleInfo();

    expect(info.indexStats.entryCount).toBe(0);
    expect(info.indexStats.hasEmbeddings).toBe(false);
  });

  test("returns registries from config", () => {
    const stashDir = makeStashDir();
    process.env.AKM_STASH_DIR = stashDir;

    const info = assembleInfo();

    expect(Array.isArray(info.registries)).toBe(true);
    // Default config has registries
    const config = loadConfig();
    const expected = config.registries ?? [];
    expect(info.registries.length).toBe(expected.length);
  });

  test("includes indexStats when index exists with entries", () => {
    const stashDir = makeStashDir();
    process.env.AKM_STASH_DIR = stashDir;

    // Create an index with some entries
    const dbPath = path.join(tmpDir("db"), "test.db");
    const db = openDatabase(dbPath);
    const entry = makeEntry("skill", "test-skill");
    upsertEntry(db, "skill:test-skill", "/fake/skill", "/fake/skill/test-skill", stashDir, entry, "test skill");
    rebuildFts(db);
    setMeta(db, "builtAt", "2026-03-17T00:00:00Z");
    closeDatabase(db);

    const info = assembleInfo({ dbPath });

    expect(info.indexStats.entryCount).toBe(1);
    expect(info.indexStats.lastBuiltAt).toBe("2026-03-17T00:00:00Z");
    expect(typeof info.indexStats.vecAvailable).toBe("boolean");
  });

  test("does not downgrade embedding metadata when reading info", () => {
    const stashDir = makeStashDir();
    process.env.AKM_STASH_DIR = stashDir;

    const dbPath = path.join(tmpDir("db"), "test.db");
    let db = openDatabase(dbPath, { embeddingDim: 4 });
    const entry = makeEntry("skill", "embed-skill");
    const id = upsertEntry(db, "skill:embed-skill", "/fake/skill", "/fake/skill/embed-skill", stashDir, entry, "embed skill");
    upsertEmbedding(db, id, [1, 0, 0, 0]);
    setMeta(db, "hasEmbeddings", "1");
    rebuildFts(db);
    closeDatabase(db);

    const info = assembleInfo({ dbPath });

    expect(info.indexStats.entryCount).toBe(1);

    db = openDatabase(dbPath, { embeddingDim: 4 });
    try {
      expect(searchVec(db, [1, 0, 0, 0], 10)).toHaveLength(1);
    } finally {
      closeDatabase(db);
    }
  });

  test("returns sourceProviders from config", () => {
    const stashDir = makeStashDir();
    process.env.AKM_STASH_DIR = stashDir;

    const info = assembleInfo();

    expect(Array.isArray(info.sourceProviders)).toBe(true);
  });

  test("output is valid JSON-serializable", () => {
    const stashDir = makeStashDir();
    process.env.AKM_STASH_DIR = stashDir;

    const info = assembleInfo();
    const json = JSON.stringify(info);
    const parsed = JSON.parse(json);

    expect(parsed.version).toBe(info.version);
    expect(parsed.assetTypes).toEqual(info.assetTypes);
    expect(parsed.searchModes).toEqual(info.searchModes);
    expect(parsed.indexStats).toEqual(info.indexStats);
  });

  test("reports pending semantic search status by default", () => {
    const stashDir = makeStashDir();
    process.env.AKM_STASH_DIR = stashDir;

    const info = assembleInfo();

    expect(info.searchModes).toContain("fts");
    expect(info.searchModes).not.toContain("semantic");
    expect(info.searchModes).not.toContain("hybrid");
    expect(info.semanticSearch.mode).toBe("auto");
    expect(info.semanticSearch.status).toBe("pending");
  });

  test("does not leak apiKey from registry options", () => {
    const stashDir = makeStashDir();
    process.env.AKM_STASH_DIR = stashDir;

    // Write a config with a registry that has an apiKey in its options
    const config = loadConfig();
    config.registries = [
      {
        url: "https://example.com/registry",
        name: "test-registry",
        provider: "static-index",
        options: { apiKey: "super-secret-key-12345" },
      },
    ];
    saveConfig(config);

    const info = assembleInfo();

    expect(info.registries).toHaveLength(1);
    expect(info.registries[0].url).toBe("https://example.com/registry");
    expect(info.registries[0].name).toBe("test-registry");
    // Ensure apiKey is not present anywhere in the serialized output
    const serialized = JSON.stringify(info);
    expect(serialized).not.toContain("super-secret-key-12345");
    expect(serialized).not.toContain("apiKey");
  });
});
