import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assembleInfo } from "../../src/commands/sources/info";
import { resolveStashDir } from "../../src/core/common";
import { loadConfig, resetConfigCache, saveConfig } from "../../src/core/config/config";
import { getCacheDir, getConfigDir, getConfigPath, getDataDir, getStateDir } from "../../src/core/paths";
import { resetQuiet, setQuiet } from "../../src/core/warn";
import { deriveEntryProvenance } from "../../src/indexer/installations";
import type { IndexDocument } from "../../src/indexer/passes/metadata";
import {
  closeDatabase,
  openIndexDatabase,
  openReadonlyExistingDatabase,
} from "../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../src/storage/repositories/index-entries-repository";
import { CANONICAL_INDEX_DB_VERSION } from "../../src/storage/repositories/index-entry-schema";
import { rebuildFts } from "../../src/storage/repositories/index-fts-repository";
import { getMeta, setMeta } from "../../src/storage/repositories/index-meta-repository";
import { searchVec, upsertEmbedding } from "../../src/storage/repositories/index-vec-repository";
import { runCliCapture } from "../_helpers/cli";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
} from "../_helpers/sandbox";
import { makeUnresolvablePath } from "../_helpers/unreadable-path";

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

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const dataResult = sandboxXdgDataHome();
  const cacheResult = sandboxXdgCacheHome(dataResult.cleanup);
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const stashResult = sandboxStashDir(cfgResult.cleanup);
  envCleanup = stashResult.cleanup;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
  // Some tests below call setQuiet() directly to exercise the readIndexStats
  // error path without going through the CLI's argv-parsing startup — reset
  // it so quiet state never leaks into a later test (R-057).
  resetQuiet();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeStashDir(): string {
  const dir = tmpDir("stash");
  // Create minimal stash structure
  fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
  return dir;
}

function makeEntry(type: string, name: string): IndexDocument {
  return {
    type,
    name,
    description: `A test ${type}`,
    tags: ["test"],
  };
}

function infoEntryProvenance(type: string, name: string) {
  return deriveEntryProvenance({ bundleId: "stash", componentId: "stash", adapterId: "akm" }, type, name);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("assembleInfo", () => {
  test("returns a version string", () => {
    const info = assembleInfo();

    expect(typeof info.version).toBe("string");
    expect(info.version.length).toBeGreaterThan(0);
  });

  test("returns assetTypes array with built-in types", () => {
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
    const info = assembleInfo();

    expect(Array.isArray(info.searchModes)).toBe(true);
    // fts is always available
    expect(info.searchModes).toContain("fts");
  });

  test("works without an index (entryCount: 0)", () => {
    const info = assembleInfo();

    expect(info.indexStats.entryCount).toBe(0);
    expect(info.indexStats.hasEmbeddings).toBe(false);
  });

  test("returns registries from config", () => {
    const info = assembleInfo();

    expect(Array.isArray(info.registries)).toBe(true);
    // Default config has registries
    const config = loadConfig();
    const expected = config.registries ?? [];
    expect(info.registries.length).toBe(expected.length);
  });

  test("includes indexStats when index exists with entries", () => {
    const stashDir = makeStashDir();

    // Create an index with some entries
    const dbPath = path.join(tmpDir("db"), "test.db");
    const db = openIndexDatabase(dbPath);
    const entry = makeEntry("skill", "test-skill");
    upsertEntry(db, path.join(stashDir, "skills", "test-skill"), entry, infoEntryProvenance("skill", "test-skill"));
    rebuildFts(db);
    setMeta(db, "builtAt", "2026-03-17T00:00:00Z");
    closeDatabase(db);

    const info = assembleInfo({ dbPath });

    expect(info.indexStats.entryCount).toBe(1);
    expect(info.indexStats.lastBuiltAt).toBe("2026-03-17T00:00:00Z");
  });

  // R-057(a): indexStats previously carried only an aggregate entryCount with
  // no per-type breakdown. `byType` must sum back to entryCount and reflect
  // the actual mix of indexed asset types.
  test("indexStats.byType breaks entryCount down per asset type", () => {
    const stashDir = makeStashDir();
    const dbPath = path.join(tmpDir("db"), "test.db");
    const db = openIndexDatabase(dbPath);
    upsertEntry(
      db,
      path.join(stashDir, "skills", "test-skill"),
      makeEntry("skill", "test-skill"),
      infoEntryProvenance("skill", "test-skill"),
    );
    upsertEntry(
      db,
      path.join(stashDir, "skills", "test-skill-2"),
      makeEntry("skill", "test-skill-2"),
      infoEntryProvenance("skill", "test-skill-2"),
    );
    upsertEntry(
      db,
      path.join(stashDir, "knowledge", "test-doc"),
      makeEntry("knowledge", "test-doc"),
      infoEntryProvenance("knowledge", "test-doc"),
    );
    rebuildFts(db);
    closeDatabase(db);

    const info = assembleInfo({ dbPath });

    expect(info.indexStats.entryCount).toBe(3);
    expect(info.indexStats.byType).toEqual({ skill: 2, knowledge: 1 });
    const total = Object.values(info.indexStats.byType).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(info.indexStats.entryCount);
  });

  test("indexStats.byType is an empty object when there is no index", () => {
    const info = assembleInfo();
    expect(info.indexStats.byType).toEqual({});
  });

  // R-057(a): akm info previously had no top-level bundleDir/defaultBundle,
  // even though akm sources list resolves and reports both (SourceListResponse).
  // akm info must agree with akm sources list on which stash/bundle is primary
  // — i.e. use the SAME resolution (resolveStashDir(), env override first).
  test("bundleDir matches resolveStashDir() and defaultBundle matches the configured bundle", () => {
    const config = loadConfig();
    config.bundles = { primary: { path: makeStashDir() } };
    config.defaultBundle = "primary";
    saveConfig(config);
    resetConfigCache();

    const info = assembleInfo();

    expect(info.bundleDir).toBe(resolveStashDir());
    expect(info.defaultBundle).toBe("primary");
  });

  test("defaultBundle is null when no bundle is configured", () => {
    const info = assembleInfo();
    expect(info.defaultBundle).toBeNull();
    expect(typeof info.bundleDir).toBe("string");
  });

  // #951: scripts (e.g. a host-vs-container health script) previously had to
  // hardcode akm's data/config/cache/state roots; assembleInfo now exposes
  // the same resolvers `akm health`/paths.ts use, alongside bundleDir.
  test("exposes dataDir/configDir/cacheDir/stateDir alongside bundleDir", () => {
    const info = assembleInfo();

    expect(info.dataDir).toBe(getDataDir());
    expect(info.configDir).toBe(getConfigDir());
    expect(info.cacheDir).toBe(getCacheDir());
    expect(info.stateDir).toBe(getStateDir());
  });

  // R-057(b): readIndexStats' error branch used to write straight to
  // process.stderr, bypassing core/warn's setQuiet()-gated error() helper —
  // the byte-identical stderr line was emitted with AND without --quiet. It
  // must now route through error(), which IS gated by setQuiet().
  test("the corrupted-index error message is suppressed by setQuiet(true), emitted otherwise", () => {
    const dbPath = path.join(tmpDir("db"), "corrupt.db");
    fs.writeFileSync(dbPath, "not a sqlite database");

    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      setQuiet(true);
      const quietInfo = assembleInfo({ dbPath });
      expect(errorSpy).not.toHaveBeenCalled();
      // The read still fails safe to the empty stats shape.
      expect(quietInfo.indexStats.entryCount).toBe(0);

      resetQuiet();
      errorSpy.mockClear();
      assembleInfo({ dbPath });
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain("failed to read index stats");
    } finally {
      errorSpy.mockRestore();
      resetQuiet();
    }
  });

  test("does not downgrade embedding metadata when reading info", () => {
    const stashDir = makeStashDir();

    const dbPath = path.join(tmpDir("db"), "test.db");
    let db = openIndexDatabase(dbPath);
    const entry = makeEntry("skill", "embed-skill");
    const id = upsertEntry(
      db,
      path.join(stashDir, "skills", "embed-skill"),
      entry,
      infoEntryProvenance("skill", "embed-skill"),
    );
    upsertEmbedding(db, id, [1, 0, 0, 0]);
    setMeta(db, "hasEmbeddings", "1");
    rebuildFts(db);
    closeDatabase(db);

    const info = assembleInfo({ dbPath });

    expect(info.indexStats.entryCount).toBe(1);

    db = openIndexDatabase(dbPath);
    try {
      expect(searchVec(db, [1, 0, 0, 0], 10)).toHaveLength(1);
    } finally {
      closeDatabase(db);
    }
  });

  test("returns sourceProviders from config", () => {
    const info = assembleInfo();

    expect(Array.isArray(info.sourceProviders)).toBe(true);
  });

  // Precondition for consolidate-wave2-e.test.ts's D5 deletion (Phase 2
  // triage): that file's "assembleInfo — sourceProviders populated" test only
  // asserted `typeof assembleInfo === "function"`. This strengthens the real
  // coverage: sourceProviders is empty with no configured bundle, and once a
  // bundle IS configured it projects the bundle → source shape assembleInfo
  // actually emits (src/commands/sources/info.ts:47-56).
  test("sourceProviders is empty with no configured bundle, and reflects a configured bundle", () => {
    expect(assembleInfo().sourceProviders).toEqual([]);

    const stashDir = makeStashDir();
    const config = loadConfig();
    config.bundles = { primary: { path: stashDir } };
    config.defaultBundle = "primary";
    saveConfig(config);

    const info = assembleInfo();
    expect(info.sourceProviders).toEqual([{ type: "filesystem", name: "primary", path: stashDir }]);
  });

  test("output is valid JSON-serializable", () => {
    const info = assembleInfo();
    const json = JSON.stringify(info);
    const parsed = JSON.parse(json);

    expect(parsed.version).toBe(info.version);
    expect(parsed.assetTypes).toEqual(info.assetTypes);
    expect(parsed.searchModes).toEqual(info.searchModes);
    expect(parsed.indexStats).toEqual(info.indexStats);
  });

  // Owner ruling 9 (R-039): the runtime default flipped from "auto" to "off",
  // so a bare install never silently downloads the ~130 MB embedding model.
  // `akm info` on a fresh install therefore reports mode "off" / status
  // "disabled" rather than "auto" / "pending". The "auto" case is pinned
  // separately below so the pending-status path keeps its coverage.
  test("reports semantic search off by default (R-039)", () => {
    const info = assembleInfo();

    expect(info.searchModes).toContain("fts");
    expect(info.searchModes).not.toContain("semantic");
    expect(info.searchModes).not.toContain("hybrid");
    expect(info.semanticSearch.mode).toBe("off");
    expect(info.semanticSearch.status).toBe("disabled");
  });

  test("reports pending semantic search status when the user opts in to auto", () => {
    const config = loadConfig();
    config.semanticSearchMode = "auto";
    saveConfig(config);
    resetConfigCache();

    const info = assembleInfo();

    expect(info.searchModes).toContain("fts");
    expect(info.searchModes).not.toContain("semantic");
    expect(info.searchModes).not.toContain("hybrid");
    expect(info.semanticSearch.mode).toBe("auto");
    expect(info.semanticSearch.status).toBe("pending");
  });

  test("does not leak apiKey from registry options", () => {
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
    expect(info.registries[0]!.url).toBe("https://example.com/registry");
    expect(info.registries[0]!.name).toBe("test-registry");
    // Ensure apiKey is not present anywhere in the serialized output
    const serialized = JSON.stringify(info);
    expect(serialized).not.toContain("super-secret-key-12345");
    expect(serialized).not.toContain("apiKey");
  });
});

// ── a10-info: akm info must behave like a help command — always exit 0 and
// report, never refuse. These pin the per-section degrade cases the fix
// covers on top of the pre-existing "absent"/"unreadable" ones above. ────────
describe("assembleInfo — index.db degrade cases never throw (a10-info)", () => {
  test("a newer index layout is reported in indexStats.unavailable, not thrown", () => {
    const stashDir = makeStashDir();
    const dbPath = path.join(tmpDir("db"), "test.db");
    const db = openIndexDatabase(dbPath);
    upsertEntry(
      db,
      path.join(stashDir, "skills", "test-skill"),
      makeEntry("skill", "test-skill"),
      infoEntryProvenance("skill", "test-skill"),
    );
    rebuildFts(db);
    // A version newer than this akm understands (checkIndexLayout's refusal
    // case) — openExistingDatabase would throw ConfigError("INDEX_SCHEMA_INCOMPATIBLE");
    // `akm info` must report it instead.
    setMeta(db, "version", String(CANONICAL_INDEX_DB_VERSION + 1));
    closeDatabase(db);

    const info = assembleInfo({ dbPath });

    expect(info.indexStats.entryCount).toBe(0);
    expect(info.indexStats.unavailable).toBeDefined();
    expect(info.indexStats.unavailable).toContain("newer akm");
    expect(info.indexStats.unavailable).toContain("Upgrade akm");
  });

  test("an older index layout is served as-is, WITHOUT migrating (real stats, no unavailable, version untouched)", () => {
    const stashDir = makeStashDir();
    const dbPath = path.join(tmpDir("db"), "test.db");
    const db = openIndexDatabase(dbPath);
    upsertEntry(
      db,
      path.join(stashDir, "skills", "test-skill"),
      makeEntry("skill", "test-skill"),
      infoEntryProvenance("skill", "test-skill"),
    );
    rebuildFts(db);
    const olderVersion = String(CANONICAL_INDEX_DB_VERSION - 1);
    setMeta(db, "version", olderVersion);
    closeDatabase(db);

    const info = assembleInfo({ dbPath });

    expect(info.indexStats.entryCount).toBe(1);
    expect(info.indexStats.unavailable).toBeUndefined();

    // A read-only open never calls ensureSchema — confirm the on-disk
    // version is still the older one, not bumped by a migration.
    const reread = openReadonlyExistingDatabase(dbPath);
    try {
      expect(reread && getMeta(reread, "version")).toBe(olderVersion);
    } finally {
      if (reread) closeDatabase(reread);
    }
  });

  test("a genuinely empty (0-byte) index.db reports indexStats.unavailable rather than throwing", () => {
    const dbPath = path.join(tmpDir("db"), "empty.db");
    fs.writeFileSync(dbPath, "");

    const info = assembleInfo({ dbPath });

    expect(info.indexStats.entryCount).toBe(0);
    expect(info.indexStats.unavailable).toBeDefined();
  });

  // Regression guard for #791: the pre-existing classifyPathAccess "inaccessible"
  // pre-check (indexStats.unreadable) must still fire unchanged now that the
  // open beneath it is a different, stricter opener. ELOOP is uid-independent
  // (unlike chmod 0000, which is unenforced for uid 0 — see
  // tests/_helpers/unreadable-path.ts), so this runs the same under CI-as-root.
  test("an unreadable index.db (ELOOP) still reports indexStats.unreadable, not unavailable", () => {
    const dir = tmpDir("db");
    const looping = makeUnresolvablePath(dir, "index.db");

    const info = assembleInfo({ dbPath: looping });

    expect(info.indexStats.entryCount).toBe(0);
    expect(info.indexStats.unreadable).toBeDefined();
    expect(info.indexStats.unreadable).toContain("ELOOP");
    expect(info.indexStats.unavailable).toBeUndefined();
  });
});

describe("assembleInfo — config degrade (a10-info)", () => {
  afterEach(() => resetConfigCache());

  test("an invalid config.json reports configError and still shows readable defaults, never throws", () => {
    fs.writeFileSync(getConfigPath(), "{ not valid json\n");
    resetConfigCache();

    const info = assembleInfo();

    expect(info.configError).toBeDefined();
    expect(info.configError).toContain("config");
    // Config-derived fields fall back to the same defaults a fresh install
    // reports (DEFAULT_CONFIG) rather than aborting the whole command.
    expect(info.defaultBundle).toBeNull();
    expect(info.semanticSearch.mode).toBe("off");
    expect(info.semanticSearch.status).toBe("disabled");
    expect(info.registries.length).toBeGreaterThan(0);
    // bundleDir still resolves via the sandboxed AKM_BUNDLE_DIR env override
    // (step 1 of resolveStashDir), which never reads config at all.
    expect(typeof info.bundleDir).toBe("string");
    expect(info.bundleDir.length).toBeGreaterThan(0);
  });

  test("a healthy config never sets configError", () => {
    const info = assembleInfo();
    expect(info.configError).toBeUndefined();
  });
});

// ── WS2: info honors --format (already supported; regression guard) ───────────
describe("akm info --format", () => {
  test("--format text differs from --format json (info honors --format)", async () => {
    resetConfigCache();
    const json = await runCliCapture(["info", "--format", "json"]);
    resetConfigCache();
    const text = await runCliCapture(["info", "--format", "text"]);
    expect(json.code).toBe(0);
    expect(text.code).toBe(0);
    // JSON output parses as JSON; text output does not.
    expect(() => JSON.parse(json.stdout)).not.toThrow();
    expect(json.stdout).not.toBe(text.stdout);
  });
});
