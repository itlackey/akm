import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, saveConfig } from "../src/config";
import { agentikitList, agentikitRemove, agentikitUpdate } from "../src/stash-registry";

const createdTmpDirs: string[] = [];

function createTmpDir(prefix = "akm-registry-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalStashDir = process.env.AKM_STASH_DIR;
let testCacheDir = "";
let testConfigDir = "";
let stashDir = "";

beforeEach(() => {
  testCacheDir = createTmpDir("akm-registry-cache-");
  testConfigDir = createTmpDir("akm-registry-config-");
  stashDir = createTmpDir("akm-registry-stash-");
  for (const sub of ["scripts", "skills", "commands", "agents", "knowledge"]) {
    fs.mkdirSync(path.join(stashDir, sub), { recursive: true });
  }
  process.env.XDG_CACHE_HOME = testCacheDir;
  process.env.XDG_CONFIG_HOME = testConfigDir;
  process.env.AKM_STASH_DIR = stashDir;
});

afterEach(() => {
  if (originalXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME;
  } else {
    process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  }
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
  if (originalStashDir === undefined) {
    delete process.env.AKM_STASH_DIR;
  } else {
    process.env.AKM_STASH_DIR = originalStashDir;
  }
  if (testCacheDir) {
    fs.rmSync(testCacheDir, { recursive: true, force: true });
    testCacheDir = "";
  }
  if (testConfigDir) {
    fs.rmSync(testConfigDir, { recursive: true, force: true });
    testConfigDir = "";
  }
});

// ── agentikitList ────────────────────────────────────────────────────────────

describe("agentikitList", () => {
  test("returns empty list when no registry installed", async () => {
    saveConfig({ semanticSearch: false, searchPaths: [] });

    const result = await agentikitList({ stashDir });

    expect(result.totalInstalled).toBe(0);
    expect(result.installed).toEqual([]);
    expect(result.stashDir).toBe(stashDir);
  });

  test("returns installed entries with status", async () => {
    const cacheDir = createTmpDir("akm-registry-cache-entry-");
    const stashRoot = createTmpDir("akm-registry-stashroot-");

    saveConfig({
      semanticSearch: false,
      searchPaths: [stashRoot],
      installed: [
        {
          id: "test-pkg",
          source: "npm",
          ref: "test-pkg",
          artifactUrl: "https://example.com/test-pkg.tgz",
          stashRoot: stashRoot,
          cacheDir: cacheDir,
          installedAt: new Date().toISOString(),
        },
      ],
    });

    const result = await agentikitList({ stashDir });

    expect(result.totalInstalled).toBe(1);
    expect(result.installed.length).toBe(1);
    expect(result.installed[0].id).toBe("test-pkg");
    expect(result.installed[0].source).toBe("npm");
    expect(result.installed[0].ref).toBe("test-pkg");
    expect(result.installed[0].status.cacheDirExists).toBe(true);
    expect(result.installed[0].status.stashRootExists).toBe(true);
  });

  test("reports missing directories in status", async () => {
    const nonExistentCache = path.join(os.tmpdir(), `akm-nonexistent-cache-${Date.now()}`);
    const nonExistentStashRoot = path.join(os.tmpdir(), `akm-nonexistent-root-${Date.now()}`);

    saveConfig({
      semanticSearch: false,
      searchPaths: [],
      installed: [
        {
          id: "missing-pkg",
          source: "npm",
          ref: "missing-pkg",
          artifactUrl: "https://example.com/missing-pkg.tgz",
          stashRoot: nonExistentStashRoot,
          cacheDir: nonExistentCache,
          installedAt: new Date().toISOString(),
        },
      ],
    });

    const result = await agentikitList({ stashDir });

    expect(result.totalInstalled).toBe(1);
    expect(result.installed[0].status.cacheDirExists).toBe(false);
    expect(result.installed[0].status.stashRootExists).toBe(false);
  });
});

// ── agentikitRemove ──────────────────────────────────────────────────────────

describe("agentikitRemove", () => {
  test("throws for empty target", async () => {
    saveConfig({ semanticSearch: false, searchPaths: [] });

    await expect(agentikitRemove({ target: "", stashDir })).rejects.toThrow("Target is required.");
  });

  test("throws for whitespace-only target", async () => {
    saveConfig({ semanticSearch: false, searchPaths: [] });

    await expect(agentikitRemove({ target: "   ", stashDir })).rejects.toThrow("Target is required.");
  });

  test("throws for unknown target", async () => {
    saveConfig({ semanticSearch: false, searchPaths: [] });

    await expect(agentikitRemove({ target: "nonexistent-package", stashDir })).rejects.toThrow(
      "No installed kit matched target",
    );
  });

  test("removes entry by id", async () => {
    const cacheDir = createTmpDir("akm-registry-remove-cache-");
    const stashRoot = createTmpDir("akm-registry-remove-root-");
    for (const sub of ["scripts", "skills", "commands", "agents", "knowledge"]) {
      fs.mkdirSync(path.join(stashRoot, sub), { recursive: true });
    }

    const entry = {
      id: "test-pkg",
      source: "npm" as const,
      ref: "npm:test-pkg",
      artifactUrl: "https://example.com/test.tgz",
      stashRoot,
      cacheDir,
      installedAt: new Date().toISOString(),
    };

    saveConfig({
      semanticSearch: false,
      searchPaths: [stashRoot],
      installed: [entry],
    });

    const result = await agentikitRemove({ target: entry.id, stashDir });

    expect(result.removed.id).toBe(entry.id);

    const config = loadConfig();
    const remaining = config.installed ?? [];
    expect(remaining.find((e) => e.id === entry.id)).toBeUndefined();
  });

  test("removes entry by ref", async () => {
    const cacheDir = createTmpDir("akm-registry-remove-cache-ref-");
    const stashRoot = createTmpDir("akm-registry-remove-root-ref-");
    for (const sub of ["scripts", "skills", "commands", "agents", "knowledge"]) {
      fs.mkdirSync(path.join(stashRoot, sub), { recursive: true });
    }

    const entry = {
      id: "test-pkg-ref",
      source: "npm" as const,
      ref: "npm:test-pkg-ref",
      artifactUrl: "https://example.com/test-ref.tgz",
      stashRoot,
      cacheDir,
      installedAt: new Date().toISOString(),
    };

    saveConfig({
      semanticSearch: false,
      searchPaths: [stashRoot],
      installed: [entry],
    });

    const result = await agentikitRemove({ target: entry.ref, stashDir });

    expect(result.removed.id).toBe(entry.id);

    const config = loadConfig();
    const remaining = config.installed ?? [];
    expect(remaining.find((e) => e.id === entry.id)).toBeUndefined();
  });

  test("cleans up cache directory", async () => {
    const cacheDir = createTmpDir("akm-registry-remove-cache-cleanup-");
    const stashRoot = createTmpDir("akm-registry-remove-root-cleanup-");
    for (const sub of ["scripts", "skills", "commands", "agents", "knowledge"]) {
      fs.mkdirSync(path.join(stashRoot, sub), { recursive: true });
    }

    const entry = {
      id: "test-pkg-cleanup",
      source: "npm" as const,
      ref: "npm:test-pkg-cleanup",
      artifactUrl: "https://example.com/test-cleanup.tgz",
      stashRoot,
      cacheDir,
      installedAt: new Date().toISOString(),
    };

    saveConfig({
      semanticSearch: false,
      searchPaths: [stashRoot],
      installed: [entry],
    });

    await agentikitRemove({ target: entry.id, stashDir });

    expect(fs.existsSync(cacheDir)).toBe(false);
  });

  test("does not delete local source directories", async () => {
    const localDir = createTmpDir("akm-registry-remove-local-");
    fs.mkdirSync(path.join(localDir, "scripts"), { recursive: true });

    const entry = {
      id: `local:${path.basename(localDir)}`,
      source: "local" as const,
      ref: localDir,
      artifactUrl: `file://${localDir}`,
      stashRoot: localDir,
      cacheDir: localDir,
      installedAt: new Date().toISOString(),
    };

    saveConfig({
      semanticSearch: false,
      searchPaths: [localDir],
      installed: [entry],
    });

    await agentikitRemove({ target: entry.id, stashDir });

    expect(fs.existsSync(localDir)).toBe(true);
  });
});

// ── selectTargets (tested via agentikitUpdate error paths) ────────────────

describe("selectTargets via agentikitUpdate", () => {
  test("throws when both target and all are specified", async () => {
    saveConfig({ semanticSearch: false, searchPaths: [] });

    await expect(agentikitUpdate({ target: "some-pkg", all: true, stashDir })).rejects.toThrow(
      "Specify either <target> or --all, not both.",
    );
  });

  test("throws when neither target nor all is specified", async () => {
    saveConfig({ semanticSearch: false, searchPaths: [] });

    await expect(agentikitUpdate({ stashDir })).rejects.toThrow("Either <target> or --all is required.");
  });

  test("--all selects all installed entries", async () => {
    const firstLocalDir = createTmpDir("akm-registry-all-local-1-");
    const secondLocalDir = createTmpDir("akm-registry-all-local-2-");
    fs.mkdirSync(path.join(firstLocalDir, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(secondLocalDir, "scripts"), { recursive: true });

    saveConfig({
      semanticSearch: false,
      searchPaths: [firstLocalDir, secondLocalDir],
      installed: [
        {
          id: `local:${path.basename(firstLocalDir)}`,
          source: "local" as const,
          ref: firstLocalDir,
          artifactUrl: `file://${firstLocalDir}`,
          stashRoot: firstLocalDir,
          cacheDir: firstLocalDir,
          installedAt: new Date().toISOString(),
        },
        {
          id: `local:${path.basename(secondLocalDir)}`,
          source: "local" as const,
          ref: secondLocalDir,
          artifactUrl: `file://${secondLocalDir}`,
          stashRoot: secondLocalDir,
          cacheDir: secondLocalDir,
          installedAt: new Date().toISOString(),
        },
      ],
    });

    const result = await agentikitUpdate({ all: true, stashDir });

    expect(result.processed).toHaveLength(2);
  });

  test("--force does not delete local source directories", async () => {
    const localDir = createTmpDir("akm-registry-update-local-force-");
    fs.mkdirSync(path.join(localDir, "scripts"), { recursive: true });

    saveConfig({
      semanticSearch: false,
      searchPaths: [localDir],
      installed: [
        {
          id: `local:${path.basename(localDir)}`,
          source: "local" as const,
          ref: localDir,
          artifactUrl: `file://${localDir}`,
          stashRoot: localDir,
          cacheDir: localDir,
          installedAt: new Date().toISOString(),
        },
      ],
    });

    const result = await agentikitUpdate({ target: localDir, force: true, stashDir });

    expect(result.processed).toHaveLength(1);
    expect(fs.existsSync(localDir)).toBe(true);
  });

  test("does not delete local directories when cache path string changes", async () => {
    const localDir = createTmpDir("akm-registry-update-local-cache-change-");
    fs.mkdirSync(path.join(localDir, "scripts"), { recursive: true });

    saveConfig({
      semanticSearch: false,
      searchPaths: [localDir],
      installed: [
        {
          id: `local:${path.basename(localDir)}`,
          source: "local" as const,
          ref: localDir,
          artifactUrl: `file://${localDir}`,
          stashRoot: localDir,
          cacheDir: path.join(localDir, "."),
          installedAt: new Date().toISOString(),
        },
      ],
    });

    const result = await agentikitUpdate({ target: localDir, stashDir });

    expect(result.processed).toHaveLength(1);
    expect(fs.existsSync(localDir)).toBe(true);
  });
});
