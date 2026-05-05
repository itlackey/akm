import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AkmConfig } from "../src/core/config";
import { saveConfig } from "../src/core/config";
import {
  ensureSourceCaches,
  findSourceForPath,
  getPrimarySource,
  isEditable,
  resolveAllStashDirs,
  resolveSourceEntries,
} from "../src/indexer/search-source";

const originalStashDir = process.env.AKM_STASH_DIR;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
let testConfigDir = "";
let stashDir = "";

beforeEach(() => {
  testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-source-config-"));
  stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-source-stash-"));
  for (const sub of ["scripts", "skills", "commands", "agents", "knowledge"]) {
    fs.mkdirSync(path.join(stashDir, sub), { recursive: true });
  }
  process.env.XDG_CONFIG_HOME = testConfigDir;
  process.env.AKM_STASH_DIR = stashDir;
});

afterEach(() => {
  process.env.AKM_STASH_DIR = originalStashDir ?? undefined;
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
  if (testConfigDir) fs.rmSync(testConfigDir, { recursive: true, force: true });
  if (stashDir) fs.rmSync(stashDir, { recursive: true, force: true });
});

describe("resolveSourceEntries", () => {
  test("returns primary stash as first source", () => {
    saveConfig({ semanticSearchMode: "off" });
    const sources = resolveSourceEntries();
    expect(sources.length).toBeGreaterThanOrEqual(1);
    expect(sources[0].path).toBe(stashDir);
    expect(sources[0].registryId).toBeUndefined();
  });

  test("includes valid stash paths", () => {
    const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-extra-"));
    try {
      saveConfig({ semanticSearchMode: "off", sources: [{ type: "filesystem", path: extraDir }] });
      const sources = resolveSourceEntries();
      expect(sources.length).toBe(2);
      expect(sources[1].path).toBe(extraDir);
    } finally {
      fs.rmSync(extraDir, { recursive: true, force: true });
    }
  });

  test("git sources fall back to repo root when content/ does not exist", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-git-root-"));
    try {
      for (const sub of ["skills", "commands", "agents", "knowledge", "scripts"]) {
        fs.mkdirSync(path.join(repoRoot, sub), { recursive: true });
      }
      saveConfig({
        semanticSearchMode: "off",
        sources: [{ type: "git", path: repoRoot, name: "git-root" }],
      });
      const sources = resolveSourceEntries();
      expect(sources[1]?.path).toBe(repoRoot);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test("skips non-existent stash paths", () => {
    saveConfig({
      semanticSearchMode: "off",
      sources: [{ type: "filesystem", path: "/nonexistent/path/should/not/exist" }],
    });
    const sources = resolveSourceEntries();
    expect(sources.length).toBe(1);
  });

  test("includes installed registry entries with registryId", () => {
    const installedDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-installed-"));
    try {
      saveConfig({
        semanticSearchMode: "off",
        installed: [
          {
            id: "npm:test-pkg",
            source: "npm",
            ref: "npm:test-pkg@1.0.0",
            artifactUrl: "https://example.test/test-pkg.tgz",
            stashRoot: installedDir,
            cacheDir: installedDir,
            installedAt: new Date().toISOString(),
          },
        ],
      });
      const sources = resolveSourceEntries();
      const installed = sources.find((s) => s.registryId === "npm:test-pkg");
      expect(installed).toBeDefined();
      expect(installed?.path).toBe(installedDir);
    } finally {
      fs.rmSync(installedDir, { recursive: true, force: true });
    }
  });

  test("preserves ordering: primary, stashes, installed", () => {
    const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-extra-"));
    const installedDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-installed-"));
    try {
      saveConfig({
        semanticSearchMode: "off",
        sources: [{ type: "filesystem", path: extraDir }],
        installed: [
          {
            id: "npm:test-pkg",
            source: "npm",
            ref: "npm:test-pkg@1.0.0",
            artifactUrl: "https://example.test/test-pkg.tgz",
            stashRoot: installedDir,
            cacheDir: installedDir,
            installedAt: new Date().toISOString(),
          },
        ],
      });
      const sources = resolveSourceEntries();
      expect(sources[0].path).toBe(stashDir);
      expect(sources[0].registryId).toBeUndefined();
      expect(sources[1].path).toBe(extraDir);
      expect(sources[1].registryId).toBeUndefined();
      expect(sources[2].path).toBe(installedDir);
      expect(sources[2].registryId).toBe("npm:test-pkg");
    } finally {
      fs.rmSync(extraDir, { recursive: true, force: true });
      fs.rmSync(installedDir, { recursive: true, force: true });
    }
  });

  test("accepts overrideStashDir parameter", () => {
    const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-override-"));
    try {
      saveConfig({ semanticSearchMode: "off" });
      const sources = resolveSourceEntries(overrideDir);
      expect(sources[0].path).toBe(overrideDir);
    } finally {
      fs.rmSync(overrideDir, { recursive: true, force: true });
    }
  });
});

describe("resolveAllStashDirs", () => {
  test("returns just paths in correct order", () => {
    saveConfig({ semanticSearchMode: "off" });
    const dirs = resolveAllStashDirs();
    expect(dirs[0]).toBe(stashDir);
  });
});

describe("getPrimarySource", () => {
  test("returns first source from list", () => {
    const sources = [{ path: stashDir }, { path: "/other/dir" }];
    const primary = getPrimarySource(sources);
    expect(primary).toBeDefined();
    expect(primary?.path).toBe(stashDir);
  });

  test("returns undefined for empty list", () => {
    expect(getPrimarySource([])).toBeUndefined();
  });
});

describe("findSourceForPath", () => {
  test("finds correct source for file inside primary stash", () => {
    const sources = [{ path: stashDir }, { path: "/other/dir" }];
    const filePath = path.join(stashDir, "scripts", "deploy.sh");
    const result = findSourceForPath(filePath, sources);
    expect(result).toBeDefined();
    expect(result?.path).toBe(stashDir);
  });

  test("finds correct source for file inside search path", () => {
    const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-extra-"));
    try {
      const sources = [{ path: stashDir }, { path: extraDir }];
      const filePath = path.join(extraDir, "scripts", "test.sh");
      const result = findSourceForPath(filePath, sources);
      expect(result).toBeDefined();
      expect(result?.path).toBe(extraDir);
    } finally {
      fs.rmSync(extraDir, { recursive: true, force: true });
    }
  });

  test("returns undefined for file not in any source", () => {
    const sources = [{ path: stashDir }];
    const result = findSourceForPath("/completely/unrelated/path.sh", sources);
    expect(result).toBeUndefined();
  });
});

describe("isEditable", () => {
  test("files in primary stash are editable", () => {
    saveConfig({ semanticSearchMode: "off" });
    const filePath = path.join(stashDir, "scripts", "deploy.sh");
    expect(isEditable(filePath)).toBe(true);
  });

  test("files in stash paths are editable", () => {
    const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-extra-"));
    try {
      saveConfig({ semanticSearchMode: "off", sources: [{ type: "filesystem", path: extraDir }] });
      const filePath = path.join(extraDir, "scripts", "deploy.sh");
      expect(isEditable(filePath)).toBe(true);
    } finally {
      fs.rmSync(extraDir, { recursive: true, force: true });
    }
  });

  test("files in cache-managed dirs are NOT editable", () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-cache-"));
    try {
      saveConfig({
        semanticSearchMode: "off",
        installed: [
          {
            id: "npm:test-pkg",
            source: "npm",
            ref: "npm:test-pkg@1.0.0",
            artifactUrl: "https://example.test/test-pkg.tgz",
            stashRoot: cacheDir,
            cacheDir: cacheDir,
            installedAt: new Date().toISOString(),
          },
        ],
      });
      const filePath = path.join(cacheDir, "scripts", "deploy.sh");
      expect(isEditable(filePath)).toBe(false);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test("files outside any known path are editable", () => {
    saveConfig({ semanticSearchMode: "off" });
    expect(isEditable("/some/random/path/file.sh")).toBe(true);
  });
});

// ── ensureSourceCaches ────────────────────────────────────────────────────────

describe("ensureSourceCaches", () => {
  test("completes without error when sources[] is empty", async () => {
    const config: AkmConfig = { semanticSearchMode: "off", sources: [] };
    await expect(ensureSourceCaches(config)).resolves.toBeUndefined();
  });

  test("completes without error when sources[] has filesystem entries (no sync needed)", async () => {
    const config: AkmConfig = {
      semanticSearchMode: "off",
      sources: [{ type: "filesystem", path: stashDir }],
    };
    await expect(ensureSourceCaches(config)).resolves.toBeUndefined();
  });

  test("reads from sources[] not stashes[] — git entries in sources[] are processed", async () => {
    // A config where sources[] has a git entry and stashes is undefined.
    // We can't run a real git mirror in unit tests, but we verify that the
    // function does NOT throw even when the git URL is unreachable (it warns).
    const config: AkmConfig = {
      semanticSearchMode: "off",
      sources: [
        {
          type: "git",
          url: "https://github.com/example/nonexistent-repo.git",
          name: "test-git",
        },
      ],
    };
    // Should resolve (not reject) — failures are warn-only
    await expect(ensureSourceCaches(config)).resolves.toBeUndefined();
  });

  test("reads from sources[] not stashes[] — website entries in sources[] are processed", async () => {
    // A config where sources[] has a website entry and stashes is undefined.
    // The mirror will fail (unreachable host) but the function warns, not throws.
    const config: AkmConfig = {
      semanticSearchMode: "off",
      sources: [
        {
          type: "website",
          url: "https://example.invalid/docs",
          name: "test-website",
        },
      ],
    };
    await expect(ensureSourceCaches(config)).resolves.toBeUndefined();
  });

  test("stashes[] entries are still processed for one-release backwards compat", async () => {
    // stashes[] is deprecated but still accepted in the runtime shape for one release.
    const config: AkmConfig = {
      semanticSearchMode: "off",
      stashes: [
        {
          type: "git",
          url: "https://github.com/example/nonexistent-repo.git",
          name: "legacy-git",
        },
      ],
    };
    await expect(ensureSourceCaches(config)).resolves.toBeUndefined();
  });
});
