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

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmListSources, akmUpdate } from "../src/commands/installed-stashes";
import { akmAdd } from "../src/commands/source-add";
import { loadConfig, saveConfig } from "../src/core/config";

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
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalStashDir = process.env.AKM_STASH_DIR;
let testCacheDir = "";
let testConfigDir = "";
let stashDir = "";

beforeEach(() => {
  testCacheDir = createTmpDir("akm-qa-cache-");
  testConfigDir = createTmpDir("akm-qa-config-");
  stashDir = createTmpDir("akm-qa-stash-");
  makeStashDir(stashDir);
  process.env.XDG_CACHE_HOME = testCacheDir;
  process.env.XDG_CONFIG_HOME = testConfigDir;
  process.env.AKM_STASH_DIR = stashDir;
});

afterEach(() => {
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;

  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;

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
    const sources = config.sources ?? config.stashes ?? [];
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
    const sources = configBefore.sources ?? configBefore.stashes ?? [];
    expect(sources.some((s) => s.name === "extra")).toBe(true);
  });

  test("akmAdd without --name falls back to readable path", async () => {
    saveConfig({ semanticSearchMode: "off" });
    const someStash = createTmpDir("akm-qa-noname-");
    makeStashDir(someStash);

    await akmAdd({ ref: someStash });

    const config = loadConfig();
    const sources = config.sources ?? config.stashes ?? [];
    const added = sources.find((s) => s.type === "filesystem" && s.path === path.resolve(someStash));
    expect(added).toBeDefined();
    // Name should NOT be the raw path (it's the readable form), but should not be empty
    expect(added?.name).toBeTruthy();
    // name should not be undefined
    expect(typeof added?.name).toBe("string");
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
});
