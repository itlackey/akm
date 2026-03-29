import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, saveConfig } from "../src/config";
import { addStash, listStashes, removeStash } from "../src/stash-source-manage";

const createdTmpDirs: string[] = [];

function createTmpDir(prefix = "akm-src-mgmt-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalAkmStashDir = process.env.AKM_STASH_DIR;
let testCacheDir = "";
let testConfigDir = "";
let testStashDir = "";

beforeEach(() => {
  testCacheDir = createTmpDir("akm-src-cache-");
  testConfigDir = createTmpDir("akm-src-config-");
  testStashDir = createTmpDir("akm-src-stash-");
  process.env.XDG_CACHE_HOME = testCacheDir;
  process.env.XDG_CONFIG_HOME = testConfigDir;
  process.env.AKM_STASH_DIR = testStashDir;
  // Write initial config so loadConfig doesn't return defaults with stale caches
  saveConfig({ semanticSearchMode: "auto" });
});

afterEach(() => {
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  if (originalAkmStashDir === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = originalAkmStashDir;
  for (const dir of createdTmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  createdTmpDirs.length = 0;
});

// ── addStash ──────────────────────────────────────────────────────────

describe("addStash", () => {
  test("adds a filesystem path", () => {
    const stashPath = createTmpDir("akm-fs-source-");
    const result = addStash({ target: stashPath });

    expect(result.added).toBe(true);
    expect(result.entry).toBeDefined();
    expect(result.entry?.type).toBe("filesystem");
    expect(result.entry?.path).toBe(path.resolve(stashPath));

    // Verify persisted
    const config = loadConfig();
    expect(config.stashes).toHaveLength(1);
    expect(config.stashes?.[0].type).toBe("filesystem");
    expect(config.stashes?.[0].path).toBe(path.resolve(stashPath));
  });

  test("adds a filesystem path with a name", () => {
    const stashPath = createTmpDir("akm-fs-named-");
    const result = addStash({ target: stashPath, name: "my-stash" });

    expect(result.added).toBe(true);
    expect(result.entry?.name).toBe("my-stash");
  });

  test("rejects duplicate filesystem paths", () => {
    const stashPath = createTmpDir("akm-fs-dup-");
    addStash({ target: stashPath });
    const result = addStash({ target: stashPath });

    expect(result.added).toBe(false);
    expect(result.message).toContain("already configured");
  });

  test("normalizes relative filesystem paths", () => {
    const stashPath = createTmpDir("akm-fs-rel-");
    const relativePath = path.relative(process.cwd(), stashPath);
    const result = addStash({ target: relativePath });

    expect(result.added).toBe(true);
    expect(result.entry?.path).toBe(path.resolve(stashPath));
  });

  test("deduplicates paths that resolve to the same directory", () => {
    const stashPath = createTmpDir("akm-fs-equiv-");
    addStash({ target: stashPath });
    // Add again with trailing slash
    const result = addStash({ target: `${stashPath}/` });

    expect(result.added).toBe(false);
    expect(result.message).toContain("already configured");
  });

  test("adds an openviking URL source", () => {
    const url = "https://viking.example.com";
    const result = addStash({ target: url, providerType: "openviking" });

    expect(result.added).toBe(true);
    expect(result.entry?.type).toBe("openviking");
    expect(result.entry?.url).toBe(url);

    const config = loadConfig();
    expect(config.stashes).toHaveLength(1);
    expect(config.stashes?.[0].type).toBe("openviking");
    expect(config.stashes?.[0].url).toBe(url);
  });

  test("adds a URL source with name and options", () => {
    const url = "https://viking.example.com";
    const result = addStash({
      target: url,
      providerType: "openviking",
      name: "my-viking",
      options: { searchType: "text" },
    });

    expect(result.added).toBe(true);
    expect(result.entry?.name).toBe("my-viking");
    expect(result.entry?.options).toEqual({ searchType: "text" });
  });

  test("throws when URL source has no provider type", () => {
    expect(() => addStash({ target: "https://example.com" })).toThrow("--provider is required");
  });

  test("rejects duplicate URL sources", () => {
    const url = "https://viking.example.com";
    addStash({ target: url, providerType: "openviking" });
    const result = addStash({ target: url, providerType: "openviking" });

    expect(result.added).toBe(false);
    expect(result.message).toContain("already configured");
  });

  test("supports custom provider types", () => {
    const url = "https://custom.example.com";
    const result = addStash({ target: url, providerType: "custom-provider" });

    expect(result.added).toBe(true);
    expect(result.entry?.type).toBe("custom-provider");
  });

  test("adds an http:// URL source", () => {
    const url = "http://viking.example.com";
    const result = addStash({ target: url, providerType: "openviking" });

    expect(result.added).toBe(true);
    expect(result.entry?.url).toBe(url);
  });

  test("allows same URL with different provider types", () => {
    const url = "https://shared.example.com";
    addStash({ target: url, providerType: "openviking" });
    // Same URL but different provider — deduplicates by URL regardless of type
    const result = addStash({ target: url, providerType: "custom" });
    expect(result.added).toBe(false);
  });

  test("ignores options for filesystem sources", () => {
    const fsPath = createTmpDir("akm-fs-opts-");
    const result = addStash({ target: fsPath, options: { key: "value" } });

    expect(result.added).toBe(true);
    expect(result.entry?.options).toBeUndefined();
  });

  test("returned stashes array reflects new state", () => {
    const fsPath = createTmpDir("akm-stashes-return-");
    const result = addStash({ target: fsPath, name: "ret-test" });

    expect(result.stashes).toHaveLength(1);
    expect(result.stashes[0].name).toBe("ret-test");
  });

  test("can add multiple sources of different types", () => {
    const fsPath = createTmpDir("akm-multi-fs-");
    addStash({ target: fsPath });
    addStash({ target: "https://viking1.example.com", providerType: "openviking" });
    addStash({ target: "https://custom.example.com", providerType: "custom-provider" });

    const config = loadConfig();
    expect(config.stashes).toHaveLength(3);
    expect(config.stashes?.[0].type).toBe("filesystem");
    expect(config.stashes?.[1].type).toBe("openviking");
    expect(config.stashes?.[2].type).toBe("custom-provider");
  });

  test("preserves existing stashes when adding", () => {
    const config = loadConfig();
    saveConfig({
      ...config,
      stashes: [{ type: "openviking", url: "https://existing.example.com", name: "existing" }],
    });

    const fsPath = createTmpDir("akm-preserve-");
    addStash({ target: fsPath });

    const updated = loadConfig();
    expect(updated.stashes).toHaveLength(2);
    expect(updated.stashes?.[0].url).toBe("https://existing.example.com");
    expect(updated.stashes?.[1].type).toBe("filesystem");
  });
});

// ── removeStash ───────────────────────────────────────────────────────

describe("removeStash", () => {
  test("removes a filesystem source by path", () => {
    const fsPath = createTmpDir("akm-rm-fs-");
    addStash({ target: fsPath });

    const result = removeStash(fsPath);
    expect(result.removed).toBe(true);
    expect(result.entry?.type).toBe("filesystem");
    expect(result.entry?.path).toBe(path.resolve(fsPath));

    const config = loadConfig();
    expect(config.stashes).toHaveLength(0);
  });

  test("removes a URL source by URL", () => {
    const url = "https://viking.example.com";
    addStash({ target: url, providerType: "openviking" });

    const result = removeStash(url);
    expect(result.removed).toBe(true);
    expect(result.entry?.url).toBe(url);

    const config = loadConfig();
    expect(config.stashes).toHaveLength(0);
  });

  test("removes a source by name", () => {
    const url = "https://viking.example.com";
    addStash({ target: url, providerType: "openviking", name: "my-viking" });

    const result = removeStash("my-viking");
    expect(result.removed).toBe(true);
    expect(result.entry?.name).toBe("my-viking");
  });

  test("returns removed: false for non-existent source", () => {
    const result = removeStash("/nonexistent/path");
    expect(result.removed).toBe(false);
    expect(result.message).toContain("No matching source found");
  });

  test("removes only the matched source, preserving others", () => {
    const fsPath = createTmpDir("akm-rm-keep-");
    addStash({ target: fsPath });
    addStash({ target: "https://viking.example.com", providerType: "openviking" });

    removeStash(fsPath);

    const config = loadConfig();
    expect(config.stashes).toHaveLength(1);
    expect(config.stashes?.[0].type).toBe("openviking");
  });

  test("prefers URL match over name match", () => {
    const url = "https://viking.example.com";
    addStash({ target: url, providerType: "openviking", name: "my-source" });
    addStash({ target: "https://other.example.com", providerType: "openviking", name: url });

    // Should match by URL (first entry), not by name (second entry)
    const result = removeStash(url);
    expect(result.removed).toBe(true);
    expect(result.entry?.name).toBe("my-source");

    // The second entry (whose name matches the URL) should still exist
    const config = loadConfig();
    expect(config.stashes).toHaveLength(1);
    expect(config.stashes?.[0].name).toBe(url);
  });

  test("prefers path match over name match", () => {
    const fsPath = createTmpDir("akm-rm-prio-");
    addStash({ target: fsPath, name: "path-source" });
    addStash({ target: "https://other.example.com", providerType: "openviking", name: fsPath });

    // Should match by path (first entry), not by name (second entry)
    const result = removeStash(fsPath);
    expect(result.removed).toBe(true);
    expect(result.entry?.type).toBe("filesystem");
  });

  test("removes http:// URL source", () => {
    const url = "http://viking.example.com";
    addStash({ target: url, providerType: "openviking" });

    const result = removeStash(url);
    expect(result.removed).toBe(true);
    expect(result.entry?.url).toBe(url);
  });

  test("returned stashes array reflects new state", () => {
    const fsPath = createTmpDir("akm-rm-ret-");
    addStash({ target: fsPath, name: "rm-ret-test" });
    addStash({ target: "https://keep.example.com", providerType: "openviking", name: "keep" });

    const result = removeStash("rm-ret-test");
    expect(result.stashes).toHaveLength(1);
    expect(result.stashes[0].name).toBe("keep");
  });

  test("removes filesystem source by relative path that resolves correctly", () => {
    const fsPath = createTmpDir("akm-rm-rel-");
    addStash({ target: fsPath });

    const relativePath = path.relative(process.cwd(), fsPath);
    const result = removeStash(relativePath);
    expect(result.removed).toBe(true);
  });
});

// ── listStashes ────────────────────────────────────────────────────────

describe("listStashes", () => {
  test("lists empty stash sources", () => {
    const result = listStashes();

    expect(result.localSources).toBeDefined();
    expect(result.stashes).toEqual([]);
    expect(result.remoteSources).toBeUndefined();
  });

  test("lists filesystem stash sources", () => {
    const fsPath = createTmpDir("akm-list-fs-");
    addStash({ target: fsPath });

    const result = listStashes();
    expect(result.stashes).toHaveLength(1);
    expect(result.stashes[0].type).toBe("filesystem");
  });

  test("lists URL stash sources", () => {
    addStash({ target: "https://viking.example.com", providerType: "openviking" });

    const result = listStashes();
    expect(result.stashes).toHaveLength(1);
    expect(result.stashes[0].type).toBe("openviking");
    expect(result.stashes[0].url).toBe("https://viking.example.com");
  });

  test("lists mixed source types", () => {
    const fsPath = createTmpDir("akm-list-mixed-");
    addStash({ target: fsPath });
    addStash({ target: "https://viking.example.com", providerType: "openviking" });
    addStash({ target: "https://custom.example.com", providerType: "custom" });

    const result = listStashes();
    expect(result.stashes).toHaveLength(3);
  });

  test("includes primary stash dir in localSources", () => {
    const result = listStashes();
    // The primary stash dir (from AKM_STASH_DIR) should always be first
    expect(result.localSources.length).toBeGreaterThanOrEqual(1);
    expect(result.localSources[0].path).toBe(path.resolve(testStashDir));
  });
});

// ── Round-trip integration ──────────────────────────────────────────────────

describe("round-trip integration", () => {
  test("add then list then remove filesystem source", () => {
    const fsPath = createTmpDir("akm-roundtrip-fs-");
    addStash({ target: fsPath, name: "roundtrip-test" });

    const listed = listStashes();
    expect(listed.stashes.some((s) => s.name === "roundtrip-test")).toBe(true);

    removeStash("roundtrip-test");
    const afterRemove = listStashes();
    expect(afterRemove.stashes.some((s) => s.name === "roundtrip-test")).toBe(false);
  });

  test("add then list then remove openviking source", () => {
    const url = "https://roundtrip-viking.example.com";
    addStash({ target: url, providerType: "openviking", name: "rt-viking" });

    const listed = listStashes();
    expect(listed.stashes.some((s) => s.name === "rt-viking")).toBe(true);

    removeStash(url);
    const afterRemove = listStashes();
    expect(afterRemove.stashes.some((s) => s.url === url)).toBe(false);
  });

  test("add then list then remove custom provider source", () => {
    const url = "https://custom-roundtrip.example.com";
    addStash({
      target: url,
      providerType: "my-custom",
      name: "custom-rt",
      options: { key: "value" },
    });

    const listed = listStashes();
    const entry = listed.stashes.find((s) => s.name === "custom-rt");
    expect(entry).toBeDefined();
    expect(entry?.type).toBe("my-custom");
    expect(entry?.options).toEqual({ key: "value" });

    removeStash("custom-rt");
    const afterRemove = listStashes();
    expect(afterRemove.stashes.some((s) => s.name === "custom-rt")).toBe(false);
  });

  test("multiple adds and removes maintain order and integrity", () => {
    const fs1 = createTmpDir("akm-multi-1-");
    const fs2 = createTmpDir("akm-multi-2-");
    const url1 = "https://v1.example.com";
    const url2 = "https://v2.example.com";

    addStash({ target: fs1, name: "fs1" });
    addStash({ target: url1, providerType: "openviking", name: "v1" });
    addStash({ target: fs2, name: "fs2" });
    addStash({ target: url2, providerType: "openviking", name: "v2" });

    let stashes = listStashes().stashes;
    expect(stashes).toHaveLength(4);
    expect(stashes.map((s) => s.name)).toEqual(["fs1", "v1", "fs2", "v2"]);

    // Remove middle entry
    removeStash("v1");
    stashes = listStashes().stashes;
    expect(stashes).toHaveLength(3);
    expect(stashes.map((s) => s.name)).toEqual(["fs1", "fs2", "v2"]);

    // Remove first entry
    removeStash("fs1");
    stashes = listStashes().stashes;
    expect(stashes).toHaveLength(2);
    expect(stashes.map((s) => s.name)).toEqual(["fs2", "v2"]);
  });
});
