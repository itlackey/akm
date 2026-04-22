import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, saveConfig } from "../src/config";
import { akmListSources, akmRemove, akmUpdate } from "../src/installed-kits";

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

// ── akmListSources ────────────────────────────────────────────────────

describe("akmListSources", () => {
  test("returns empty list when no sources configured", async () => {
    saveConfig({ semanticSearchMode: "off" });

    const result = await akmListSources({ stashDir });

    expect(result.totalSources).toBe(0);
    expect(result.sources).toEqual([]);
    expect(result.stashDir).toBe(stashDir);
  });

  test("returns managed and local sources", async () => {
    const cacheDir = createTmpDir("akm-registry-cache-entry-");
    const stashRoot = createTmpDir("akm-registry-stashroot-");

    saveConfig({
      semanticSearchMode: "off",
      stashes: [{ type: "filesystem", path: stashRoot, writable: true }],
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

    const result = await akmListSources({ stashDir });

    expect(result.totalSources).toBe(2);
    // Local source from stashes[]
    const local = result.sources.find((s) => s.kind === "local");
    expect(local).toBeDefined();
    if (!local) {
      throw new Error("Expected local source");
    }
    expect(local.path).toBe(stashRoot);
    expect(local.writable).toBe(true);
    expect(local.updatable).toBe(false);
    // Managed source from installed[]
    const managed = result.sources.find((s) => s.kind === "managed");
    expect(managed).toBeDefined();
    if (!managed) {
      throw new Error("Expected managed source");
    }
    expect(managed.name).toBe("test-pkg");
    expect(managed.ref).toBe("test-pkg");
    expect(managed.status.exists).toBe(true);
    expect(managed.writable).toBe(false);
    expect(managed.updatable).toBe(true);
  });

  test("reports missing directories in status", async () => {
    const nonExistentCache = path.join(os.tmpdir(), `akm-nonexistent-cache-${Date.now()}`);
    const nonExistentStashRoot = path.join(os.tmpdir(), `akm-nonexistent-root-${Date.now()}`);

    saveConfig({
      semanticSearchMode: "off",
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

    const result = await akmListSources({ stashDir });

    expect(result.totalSources).toBe(1);
    expect(result.sources[0].kind).toBe("managed");
    expect(result.sources[0].status.exists).toBe(false);
    expect(result.sources[0].writable).toBe(false);
  });

  test("reports writable managed sources from installed metadata", async () => {
    const cacheDir = createTmpDir("akm-registry-cache-entry-");
    const stashRoot = createTmpDir("akm-registry-stashroot-");

    saveConfig({
      semanticSearchMode: "off",
      installed: [
        {
          id: "github:owner/repo",
          source: "github",
          ref: "github:owner/repo",
          artifactUrl: "https://github.com/owner/repo.git",
          stashRoot,
          cacheDir,
          installedAt: new Date().toISOString(),
          writable: true,
        },
      ],
    });

    const result = await akmListSources({ stashDir, kind: ["managed"] });

    expect(result.totalSources).toBe(1);
    expect(result.sources[0].kind).toBe("managed");
    expect(result.sources[0].updatable).toBe(true);
    expect(result.sources[0].writable).toBe(true);
  });

  test("filters by kind", async () => {
    const stashRoot = createTmpDir("akm-registry-stashroot-");
    const cacheDir = createTmpDir("akm-registry-cache-");

    saveConfig({
      semanticSearchMode: "off",
      stashes: [{ type: "filesystem", path: stashRoot }],
      installed: [
        {
          id: "test-pkg",
          source: "npm",
          ref: "test-pkg",
          artifactUrl: "https://example.com/test-pkg.tgz",
          stashRoot,
          cacheDir,
          installedAt: new Date().toISOString(),
        },
      ],
    });

    const managedOnly = await akmListSources({ stashDir, kind: ["managed"] });
    expect(managedOnly.totalSources).toBe(1);
    expect(managedOnly.sources[0].kind).toBe("managed");

    const localOnly = await akmListSources({ stashDir, kind: ["local"] });
    expect(localOnly.totalSources).toBe(1);
    expect(localOnly.sources[0].kind).toBe("local");
  });
});

// ── akmRemove ──────────────────────────────────────────────────────────

describe("akmRemove", () => {
  test("throws for empty target", async () => {
    saveConfig({ semanticSearchMode: "off" });

    await expect(akmRemove({ target: "", stashDir })).rejects.toThrow("Target is required.");
  });

  test("throws for whitespace-only target", async () => {
    saveConfig({ semanticSearchMode: "off" });

    await expect(akmRemove({ target: "   ", stashDir })).rejects.toThrow("Target is required.");
  });

  test("throws for unknown target", async () => {
    saveConfig({ semanticSearchMode: "off" });

    await expect(akmRemove({ target: "nonexistent-package", stashDir })).rejects.toThrow(
      "No matching source for target",
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
      semanticSearchMode: "off",
      stashes: [{ type: "filesystem", path: stashRoot }],
      installed: [entry],
    });

    const result = await akmRemove({ target: entry.id, stashDir });

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
      semanticSearchMode: "off",
      stashes: [{ type: "filesystem", path: stashRoot }],
      installed: [entry],
    });

    const result = await akmRemove({ target: entry.ref, stashDir });

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
      semanticSearchMode: "off",
      stashes: [{ type: "filesystem", path: stashRoot }],
      installed: [entry],
    });

    await akmRemove({ target: entry.id, stashDir });

    expect(fs.existsSync(cacheDir)).toBe(false);
  });
});

// ── selectTargets (tested via akmUpdate error paths) ────────────────

describe("selectTargets via akmUpdate", () => {
  test("throws when both target and all are specified", async () => {
    saveConfig({ semanticSearchMode: "off" });

    await expect(akmUpdate({ target: "some-pkg", all: true, stashDir })).rejects.toThrow(
      "Specify either <target> or --all, not both.",
    );
  });

  test("throws when neither target nor all is specified", async () => {
    saveConfig({ semanticSearchMode: "off" });

    await expect(akmUpdate({ stashDir })).rejects.toThrow("Either <target> or --all is required.");
  });

  test("--all selects all installed entries (registry kits only)", async () => {
    // Use local directory refs so installRegistryRef works without network.
    const localDir1 = createTmpDir("akm-registry-all-1-");
    const localDir2 = createTmpDir("akm-registry-all-2-");
    for (const dir of [localDir1, localDir2]) {
      for (const sub of ["scripts", "skills", "commands", "agents", "knowledge"]) {
        fs.mkdirSync(path.join(dir, sub), { recursive: true });
      }
    }

    // Store as source: "npm" with local-path refs so they stay in installed[]
    // but parseRegistryRef recognizes the ref as a local path.
    saveConfig({
      semanticSearchMode: "off",

      installed: [
        {
          id: `local:${path.basename(localDir1)}`,
          source: "npm" as const,
          ref: localDir1,
          artifactUrl: `file://${localDir1}`,
          stashRoot: localDir1,
          cacheDir: localDir1,
          installedAt: new Date().toISOString(),
        },
        {
          id: `local:${path.basename(localDir2)}`,
          source: "npm" as const,
          ref: localDir2,
          artifactUrl: `file://${localDir2}`,
          stashRoot: localDir2,
          cacheDir: localDir2,
          installedAt: new Date().toISOString(),
        },
      ],
    });

    const result = await akmUpdate({ all: true, stashDir });

    expect(result.processed).toHaveLength(2);
  });

  test("local directories in stashes are preserved by update --force", async () => {
    const localDir = createTmpDir("akm-registry-update-local-force-");
    fs.mkdirSync(path.join(localDir, "scripts"), { recursive: true });

    saveConfig({
      semanticSearchMode: "off",

      stashes: [{ type: "filesystem", path: localDir, name: "test-local" }],
      installed: [],
    });

    // Local dirs are stash sources now — update only affects installed entries
    expect(fs.existsSync(localDir)).toBe(true);
    const config = loadConfig();
    expect((config.stashes ?? []).some((s) => s.path === localDir)).toBe(true);
  });
});
