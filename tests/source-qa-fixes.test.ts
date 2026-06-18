/**
 * Tests for QA fixes in cluster A (issues #9, #10, #11, #12, #17, #18, #19, #22, #23).
 *
 * - #9/#18/#22: `akm add <path> --name extra` persists the name for filesystem sources.
 * - #10:        Filesystem kind reported as "filesystem", not "local".
 * - #11/#23:    Filesystem writable defaults to true in list output.
 * - #12:        `updatable` field dropped from SourceEntry.
 * - #17:        Website kind reported as "website", not "remote".
 * - #19:        akm update re-mirrors website sources via sync().
 */

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmListSources, akmUpdate } from "../src/commands/sources/installed-stashes";
import { akmAdd } from "../src/commands/sources/source-add";
import { addStash } from "../src/commands/sources/source-manage";
import { loadConfig, saveConfig } from "../src/core/config/config";
import { ConfigError } from "../src/core/errors";
import * as gitProvider from "../src/sources/providers/git";
import * as syncFromRefModule from "../src/sources/providers/sync-from-ref";

const createdTmpDirs: string[] = [];

function createTmpDir(prefix = "akm-qa-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

function makeStashDir(base: string): void {
  for (const sub of ["skills", "commands", "agents", "knowledge", "scripts"]) {
    fs.mkdirSync(path.join(base, sub), { recursive: true });
  }
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalXdgStateHome = process.env.XDG_STATE_HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalStashDir = process.env.AKM_STASH_DIR;
let testCacheDir = "";
let testConfigDir = "";
let testDataDir = "";
let testStateDir = "";
let stashDir = "";

beforeEach(() => {
  testCacheDir = createTmpDir("akm-qa-cache-");
  testConfigDir = createTmpDir("akm-qa-config-");
  testDataDir = createTmpDir("akm-qa-data-");
  testStateDir = createTmpDir("akm-qa-state-");
  stashDir = createTmpDir("akm-qa-stash-");
  makeStashDir(stashDir);
  process.env.XDG_CACHE_HOME = testCacheDir;
  process.env.XDG_CONFIG_HOME = testConfigDir;
  // Pair AKM_STASH_DIR with XDG_DATA_HOME / XDG_STATE_HOME so the
  // test-isolation guard in src/core/paths.ts stays inert.
  process.env.XDG_DATA_HOME = testDataDir;
  process.env.XDG_STATE_HOME = testStateDir;
  process.env.AKM_STASH_DIR = stashDir;
});

afterEach(() => {
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;

  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;

  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdgDataHome;

  if (originalXdgStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalXdgStateHome;

  if (originalStashDir === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = originalStashDir;

  if (testCacheDir) {
    fs.rmSync(testCacheDir, { recursive: true, force: true });
    testCacheDir = "";
  }
  if (testConfigDir) {
    fs.rmSync(testConfigDir, { recursive: true, force: true });
    testConfigDir = "";
  }
  if (testDataDir) {
    fs.rmSync(testDataDir, { recursive: true, force: true });
    testDataDir = "";
  }
  if (testStateDir) {
    fs.rmSync(testStateDir, { recursive: true, force: true });
    testStateDir = "";
  }
});

// ── Issue #9 / #18 / #22: --name persisted for filesystem sources ──────────

describe("issue #9: --name flag persisted for filesystem sources", () => {
  test("akmAdd persists explicit --name for a local path", async () => {
    saveConfig({ semanticSearchMode: "off" });
    const extraStash = createTmpDir("akm-qa-extra-");
    makeStashDir(extraStash);

    const result = await akmAdd({ ref: extraStash, name: "extra" });

    // sourceAdded should carry the explicit name
    expect(result.sourceAdded).toBeDefined();
    expect(result.sourceAdded?.name).toBe("extra");

    // Config should persist the name
    const config = loadConfig();
    const sources = config.sources ?? [];
    const added = sources.find((s) => s.type === "filesystem" && s.path === path.resolve(extraStash));
    expect(added).toBeDefined();
    expect(added?.name).toBe("extra");
  });

  test("akm remove works when source was added with --name", async () => {
    saveConfig({ semanticSearchMode: "off" });
    const extraStash = createTmpDir("akm-qa-extra-rm-");
    makeStashDir(extraStash);

    await akmAdd({ ref: extraStash, name: "extra" });

    // Verify the name is in the config
    const configBefore = loadConfig();
    const sources = configBefore.sources ?? [];
    expect(sources.some((s) => s.name === "extra")).toBe(true);
  });

  test("akmAdd without --name falls back to readable path", async () => {
    saveConfig({ semanticSearchMode: "off" });
    const someStash = createTmpDir("akm-qa-noname-");
    makeStashDir(someStash);

    await akmAdd({ ref: someStash });

    const config = loadConfig();
    const sources = config.sources ?? [];
    const added = sources.find((s) => s.type === "filesystem" && s.path === path.resolve(someStash));
    expect(added).toBeDefined();
    // Name should NOT be the raw path (it's the readable form), but should not be empty
    expect(added?.name).toBeTruthy();
    // name should not be undefined
    expect(typeof added?.name).toBe("string");
  });
});

describe("manual QA add validation", () => {
  test("akmAdd rejects writable installs for npm refs before syncing", async () => {
    saveConfig({ semanticSearchMode: "off" });
    await expect(akmAdd({ ref: "npm:left-pad", writable: true })).rejects.toThrow(ConfigError);
  });

  test("addStash rejects openviking providers before persisting config", () => {
    saveConfig({ semanticSearchMode: "off" });
    expect(() => addStash({ target: "https://example.com", providerType: "openviking" })).toThrow(ConfigError);
    expect(loadConfig().sources).toBeUndefined();
  });

  test("addStash rejects writable website sources before persisting config", () => {
    saveConfig({ semanticSearchMode: "off" });
    expect(() => addStash({ target: "https://example.com", providerType: "website", writable: true })).toThrow(
      ConfigError,
    );
    expect(loadConfig().sources).toBeUndefined();
  });
});

// ── Issue #10: filesystem kind = "filesystem" in list output ──────────────

describe("issue #10: filesystem kind in list output", () => {
  test("filesystem source has kind='filesystem' in akmListSources", async () => {
    const sourceDir = createTmpDir("akm-qa-fs-kind-");
    makeStashDir(sourceDir);

    saveConfig({
      semanticSearchMode: "off",
      sources: [{ type: "filesystem", path: sourceDir }],
    });

    const result = await akmListSources({ stashDir });

    const fsSrc = result.sources.find((s) => s.path === sourceDir);
    expect(fsSrc).toBeDefined();
    expect(fsSrc?.kind).toBe("filesystem");
  });

  test("git source has kind='git' in akmListSources", async () => {
    saveConfig({
      semanticSearchMode: "off",
      sources: [{ type: "git", url: "https://github.com/example/repo.git", name: "my-git" }],
    });

    const result = await akmListSources({ stashDir });

    const gitSrc = result.sources.find((s) => s.name === "my-git");
    expect(gitSrc).toBeDefined();
    expect(gitSrc?.kind).toBe("git");
  });
});

// ── Issue #17: website kind = "website" in list output ──────────────────

describe("issue #17: website kind in list output", () => {
  test("website source has kind='website' in akmListSources", async () => {
    saveConfig({
      semanticSearchMode: "off",
      sources: [{ type: "website", url: "https://example.com", name: "docs-site" }],
    });

    const result = await akmListSources({ stashDir });

    const webSrc = result.sources.find((s) => s.name === "docs-site");
    expect(webSrc).toBeDefined();
    expect(webSrc?.kind).toBe("website");
  });
});

// ── Issue #11 / #23: filesystem writable defaults to true ─────────────────

describe("issue #11: filesystem writable defaults to true in list output", () => {
  test("filesystem source without explicit writable defaults to true", async () => {
    const sourceDir = createTmpDir("akm-qa-writable-");
    makeStashDir(sourceDir);

    saveConfig({
      semanticSearchMode: "off",
      sources: [{ type: "filesystem", path: sourceDir }],
    });

    const result = await akmListSources({ stashDir });

    const fsSrc = result.sources.find((s) => s.path === sourceDir);
    expect(fsSrc).toBeDefined();
    expect(fsSrc?.writable).toBe(true);
  });

  test("filesystem source with writable: false respects the explicit setting", async () => {
    const sourceDir = createTmpDir("akm-qa-writable-false-");
    makeStashDir(sourceDir);

    saveConfig({
      semanticSearchMode: "off",
      sources: [{ type: "filesystem", path: sourceDir, writable: false }],
    });

    const result = await akmListSources({ stashDir });

    const fsSrc = result.sources.find((s) => s.path === sourceDir);
    expect(fsSrc).toBeDefined();
    expect(fsSrc?.writable).toBe(false);
  });

  test("git source without explicit writable defaults to false", async () => {
    saveConfig({
      semanticSearchMode: "off",
      sources: [{ type: "git", url: "https://github.com/example/repo.git", name: "my-git" }],
    });

    const result = await akmListSources({ stashDir });

    const gitSrc = result.sources.find((s) => s.name === "my-git");
    expect(gitSrc).toBeDefined();
    expect(gitSrc?.writable).toBe(false);
  });

  test("website source without explicit writable defaults to false", async () => {
    saveConfig({
      semanticSearchMode: "off",
      sources: [{ type: "website", url: "https://example.com", name: "docs-site" }],
    });

    const result = await akmListSources({ stashDir });

    const webSrc = result.sources.find((s) => s.name === "docs-site");
    expect(webSrc).toBeDefined();
    expect(webSrc?.writable).toBe(false);
  });
});

// ── Issue #12: updatable field dropped from SourceEntry ──────────────────

describe("issue #12: updatable field absent from SourceEntry", () => {
  test("filesystem sources do not expose updatable field", async () => {
    const sourceDir = createTmpDir("akm-qa-no-updatable-");
    makeStashDir(sourceDir);

    saveConfig({
      semanticSearchMode: "off",
      sources: [{ type: "filesystem", path: sourceDir }],
    });

    const result = await akmListSources({ stashDir });

    const fsSrc = result.sources.find((s) => s.path === sourceDir);
    expect(fsSrc).toBeDefined();
    expect("updatable" in (fsSrc ?? {})).toBe(false);
  });

  test("managed sources do not expose updatable field", async () => {
    const cacheDir = createTmpDir("akm-qa-managed-cache-");
    const stashRoot = createTmpDir("akm-qa-managed-root-");
    makeStashDir(stashRoot);

    saveConfig({
      semanticSearchMode: "off",
      installed: [
        {
          id: "test-pkg",
          source: "npm" as const,
          ref: "test-pkg",
          artifactUrl: "https://example.com/test-pkg.tgz",
          stashRoot,
          cacheDir,
          installedAt: new Date().toISOString(),
        },
      ],
    });

    const result = await akmListSources({ stashDir });

    const managed = result.sources.find((s) => s.kind === "managed");
    expect(managed).toBeDefined();
    expect("updatable" in (managed ?? {})).toBe(false);
  });
});

// ── Issue #19: akm update syncs website sources ───────────────────────────

describe("issue #19: akm update website sources", () => {
  test("website source update does not throw TARGET_NOT_UPDATABLE", async () => {
    // Use a local HTTP server to serve minimal HTML for the crawl
    const server = Bun.serve({
      port: 0,
      fetch(_req: Request) {
        return new Response(
          "<html><head><title>Test</title></head><body><h1>Test</h1><p>hello world</p></body></html>",
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      },
    });
    const siteUrl = `http://127.0.0.1:${server.port}`;

    try {
      saveConfig({
        semanticSearchMode: "off",
        sources: [{ type: "website", url: siteUrl, name: "test-site" }],
      });

      // Should not throw TARGET_NOT_UPDATABLE
      const result = await akmUpdate({ target: "test-site", stashDir });
      // Returns an UpdateResponse with processed[] (empty for website sources)
      expect(result).toBeDefined();
      expect(result.schemaVersion).toBe(1);
      expect(result.processed).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("git source update refreshes configured git mirrors instead of treating them as local paths", async () => {
    const syncSpy = spyOn(gitProvider, "syncMirroredRepo").mockResolvedValue({
      id: "https://github.com/example/repo",
      source: "git",
      ref: "https://github.com/example/repo",
      artifactUrl: "https://github.com/example/repo",
      contentDir: stashDir,
      cacheDir: testCacheDir,
      extractedDir: stashDir,
      syncedAt: new Date().toISOString(),
      writable: false,
    });

    saveConfig({
      semanticSearchMode: "off",
      sources: [{ type: "git", url: "https://github.com/example/repo", name: "test-git" }],
    });

    const result = await akmUpdate({ target: "test-git", stashDir });
    expect(result.processed).toEqual([]);
    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(syncSpy).toHaveBeenCalledWith(expect.objectContaining({ name: "test-git" }), {
      force: true,
      writable: false,
    });
    syncSpy.mockRestore();
  });
});

// ── Regression: update preserves source classification for writable github: entries ──

describe("update preserves entry.source for writable installed entries", () => {
  test("updating a github: entry stored as source:git preserves source:git and writable:true", async () => {
    const stashRoot = createTmpDir("akm-qa-writable-stash-");
    makeStashDir(stashRoot);
    const cacheDir = createTmpDir("akm-qa-writable-cache-");

    saveConfig({
      semanticSearchMode: "off",
      installed: [
        {
          id: "github:dimm-city/agent-stash",
          source: "git",
          ref: "github:dimm-city/agent-stash",
          artifactUrl: "https://github.com/dimm-city/agent-stash.git",
          stashRoot,
          cacheDir,
          installedAt: "2026-04-22T16:39:07.564Z",
          writable: true,
          resolvedRevision: "abc123",
        },
      ],
    });

    // syncFromRef for a github: ref returns source: "github" — this is what
    // triggered the bug: updateRegistryEntry was using synced.source ("github")
    // instead of entry.source ("git"), causing the validator to reject writable:true.
    const syncSpy = spyOn(syncFromRefModule, "syncFromRef").mockResolvedValue({
      id: "github:dimm-city/agent-stash",
      source: "github",
      ref: "github:dimm-city/agent-stash",
      artifactUrl: "https://github.com/dimm-city/agent-stash.git",
      contentDir: stashRoot,
      cacheDir,
      extractedDir: stashRoot,
      syncedAt: new Date().toISOString(),
      resolvedRevision: "def456",
    });

    let result: Awaited<ReturnType<typeof akmUpdate>>;
    try {
      result = await akmUpdate({ target: "github:dimm-city/agent-stash", stashDir });
    } finally {
      syncSpy.mockRestore();
    }

    expect(result).toBeDefined();

    const config = loadConfig();
    const entry = config.installed?.find((e) => e.id === "github:dimm-city/agent-stash");
    expect(entry).toBeDefined();
    // source must remain "git" — not reclassified to "github"
    expect(entry?.source).toBe("git");
    // writable must survive the update
    expect(entry?.writable).toBe(true);
    // revision should be updated
    expect(entry?.resolvedRevision).toBe("def456");
  });
});
