import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AkmConfig, BundleConfigEntry } from "../../src/core/config/config";
import { saveConfig } from "../../src/core/config/config";
import {
  ensureSourceCaches,
  findSourceForPath,
  getPrimarySource,
  isEditable,
  resolveAllStashDirs,
  resolveSourceEntries,
} from "../../src/indexer/search/search-source";
import { mergeLockEntriesSync } from "../../src/integrations/lockfile";
import type { InstallKind } from "../../src/registry/types";

/**
 * Seed a lock-backed registry-managed source (a git/npm `bundles` entry + its
 * §10.2 lock entry) the way `akm add` persists it.
 */
function seedManagedBundle(
  key: string,
  descriptor: BundleConfigEntry,
  lock: { source: InstallKind; ref: string; localRoot: string },
): void {
  saveConfig({ semanticSearchMode: "off", bundles: { [key]: descriptor } });
  mergeLockEntriesSync([{ id: key, source: lock.source, ref: lock.ref, localRoot: lock.localRoot }]);
}

import * as gitProvider from "../../src/sources/providers/git";
import { NpmSourceProvider } from "../../src/sources/providers/npm";
import * as websiteIngest from "../../src/sources/snapshot-fetchers/website-ingest";

const originalStashDir = process.env.AKM_STASH_DIR;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalXdgStateHome = process.env.XDG_STATE_HOME;
let testConfigDir = "";
let testDataDir = "";
let testStateDir = "";
let stashDir = "";

beforeEach(() => {
  testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-source-config-"));
  testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-source-data-"));
  testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-source-state-"));
  stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-source-stash-"));
  for (const sub of ["scripts", "skills", "commands", "agents", "knowledge"]) {
    fs.mkdirSync(path.join(stashDir, sub), { recursive: true });
  }
  process.env.XDG_CONFIG_HOME = testConfigDir;
  // Pair AKM_STASH_DIR mutations with XDG_DATA_HOME / XDG_STATE_HOME so the
  // write-guard in src/core/paths.ts stays inert.
  process.env.XDG_DATA_HOME = testDataDir;
  process.env.XDG_STATE_HOME = testStateDir;
  process.env.AKM_STASH_DIR = stashDir;
});

afterEach(() => {
  process.env.AKM_STASH_DIR = originalStashDir ?? undefined;
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
  if (originalXdgDataHome === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = originalXdgDataHome;
  }
  if (originalXdgStateHome === undefined) {
    delete process.env.XDG_STATE_HOME;
  } else {
    process.env.XDG_STATE_HOME = originalXdgStateHome;
  }
  if (testConfigDir) fs.rmSync(testConfigDir, { recursive: true, force: true });
  if (testDataDir) fs.rmSync(testDataDir, { recursive: true, force: true });
  if (testStateDir) fs.rmSync(testStateDir, { recursive: true, force: true });
  if (stashDir) fs.rmSync(stashDir, { recursive: true, force: true });
});

describe("resolveSourceEntries", () => {
  test("returns primary stash as first source", () => {
    saveConfig({ semanticSearchMode: "off" });
    const sources = resolveSourceEntries();
    expect(sources.length).toBeGreaterThanOrEqual(1);
    expect(sources[0]!.path).toBe(stashDir);
    expect(sources[0]!.registryId).toBeUndefined();
  });

  test("includes valid stash paths", () => {
    const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-extra-"));
    try {
      saveConfig({ semanticSearchMode: "off", bundles: { extra: { path: extraDir } } });
      const sources = resolveSourceEntries();
      expect(sources.length).toBe(2);
      expect(sources[1]!.path).toBe(extraDir);
    } finally {
      fs.rmSync(extraDir, { recursive: true, force: true });
    }
  });

  test("git bundle resolves to its lock localRoot (already the materialized content root)", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-git-root-"));
    try {
      for (const sub of ["skills", "commands", "agents", "knowledge", "scripts"]) {
        fs.mkdirSync(path.join(repoRoot, sub), { recursive: true });
      }
      // 0.9.0 (spec §10.2): the resolved content root lives in the lock — the
      // content/-subdir resolution happens at install time, not at resolve time.
      seedManagedBundle(
        "git-root",
        { git: "https://example.test/repo.git" },
        {
          source: "git",
          ref: "https://example.test/repo.git",
          localRoot: repoRoot,
        },
      );
      const sources = resolveSourceEntries();
      expect(sources[1]?.path).toBe(repoRoot);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test("git bundle resolves the content/ layout that install materialized into localRoot", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-git-content-"));
    try {
      const contentRoot = path.join(repoRoot, "content");
      fs.mkdirSync(path.join(contentRoot, "knowledge"), { recursive: true });
      // The install flow already resolved content/ and recorded it as localRoot.
      seedManagedBundle(
        "git-content",
        { git: "https://example.test/repo.git" },
        {
          source: "git",
          ref: "https://example.test/repo.git",
          localRoot: contentRoot,
        },
      );
      const sources = resolveSourceEntries();
      expect(sources[1]?.path).toBe(contentRoot);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test("skips non-existent stash paths", () => {
    saveConfig({
      semanticSearchMode: "off",
      bundles: { missing: { path: "/nonexistent/path/should/not/exist" } },
    });
    const sources = resolveSourceEntries();
    expect(sources.length).toBe(1);
  });

  test("includes registry-managed bundles resolved from the lock localRoot", () => {
    const installedDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-installed-"));
    try {
      // The bundle key is the SearchSource registryId; the original install id is
      // preserved on the bundle's registryId.
      seedManagedBundle(
        "test-pkg",
        { npm: "npm:test-pkg@1.0.0", registryId: "npm:test-pkg" },
        {
          source: "npm",
          ref: "npm:test-pkg@1.0.0",
          localRoot: installedDir,
        },
      );
      const sources = resolveSourceEntries();
      const installed = sources.find((s) => s.registryId === "test-pkg");
      expect(installed).toBeDefined();
      expect(installed?.path).toBe(installedDir);
    } finally {
      fs.rmSync(installedDir, { recursive: true, force: true });
    }
  });

  test("preserves ordering: primary, plain source, managed", () => {
    const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-extra-"));
    const installedDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-installed-"));
    try {
      saveConfig({
        semanticSearchMode: "off",
        bundles: {
          extra: { path: extraDir },
          "test-pkg": { npm: "npm:test-pkg@1.0.0", registryId: "npm:test-pkg" },
        },
      });
      mergeLockEntriesSync([{ id: "test-pkg", source: "npm", ref: "npm:test-pkg@1.0.0", localRoot: installedDir }]);
      const sources = resolveSourceEntries();
      expect(sources[0]!.path).toBe(stashDir);
      expect(sources[0]!.registryId).toBeUndefined();
      expect(sources[1]!.path).toBe(extraDir);
      expect(sources[1]!.registryId).toBe("extra");
      expect(sources[2]!.path).toBe(installedDir);
      expect(sources[2]!.registryId).toBe("test-pkg");
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
      expect(sources[0]!.path).toBe(overrideDir);
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
      saveConfig({ semanticSearchMode: "off", bundles: { extra: { path: extraDir } } });
      const filePath = path.join(extraDir, "scripts", "deploy.sh");
      expect(isEditable(filePath)).toBe(true);
    } finally {
      fs.rmSync(extraDir, { recursive: true, force: true });
    }
  });

  test("files under a non-writable managed bundle's lock localRoot are NOT editable (Decision D)", () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-cache-"));
    try {
      // A lock-backed npm bundle (not writable) → files under its localRoot are
      // cache-managed and overwritten on `akm update`, so not editable.
      seedManagedBundle(
        "test-pkg",
        { npm: "npm:test-pkg@1.0.0", registryId: "npm:test-pkg" },
        {
          source: "npm",
          ref: "npm:test-pkg@1.0.0",
          localRoot: cacheDir,
        },
      );
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
  test("completes without error when there are no bundles", async () => {
    const config: AkmConfig = { semanticSearchMode: "off", bundles: {} };
    await expect(ensureSourceCaches(config)).resolves.toBeUndefined();
  });

  test("completes without error for filesystem bundles (no sync needed)", async () => {
    const config: AkmConfig = {
      semanticSearchMode: "off",
      bundles: { s: { path: stashDir } },
    };
    await expect(ensureSourceCaches(config)).resolves.toBeUndefined();
  });

  test("git bundles are processed via the provider sync loop", async () => {
    // We can't run a real git mirror in unit tests, but we verify that the
    // function does NOT throw even when the git URL is unreachable (it warns).
    const config: AkmConfig = {
      semanticSearchMode: "off",
      bundles: { "test-git": { git: "https://github.com/example/nonexistent-repo.git" } },
    };
    const gitSpy = spyOn(gitProvider, "ensureGitMirror").mockResolvedValue(undefined);
    try {
      await expect(ensureSourceCaches(config)).resolves.toBeUndefined();
      expect(gitSpy).toHaveBeenCalledTimes(1);
    } finally {
      gitSpy.mockRestore();
    }
  });

  test("reads from sources[] not stashes[] — website entries in sources[] are processed", async () => {
    // A config where sources[] has a website entry and stashes is undefined.
    // The mirror will fail (unreachable host) but the function warns, not throws.
    const config: AkmConfig = {
      semanticSearchMode: "off",
      bundles: { "test-website": { website: { url: "https://example.invalid/docs" } } },
    };
    await expect(ensureSourceCaches(config)).resolves.toBeUndefined();
  });

  // R2 bug fix: npm sources are cache-backed too, but the old type-gated loops
  // only handled git-stash + website, so an npm source's cache was NEVER
  // refreshed. After routing through the provider registry's polymorphic
  // sync(), every cache-backed kind (including npm) must be refreshed.
  test("npm sources are refreshed (R2: routes through provider sync())", async () => {
    const npmSyncSpy = spyOn(NpmSourceProvider.prototype, "sync").mockResolvedValue(undefined);
    // Avoid real git/website network in the same run.
    const gitSpy = spyOn(gitProvider, "ensureGitMirror").mockResolvedValue(undefined);
    const websiteSpy = spyOn(websiteIngest, "ensureWebsiteMirror").mockResolvedValue({
      rootDir: "/tmp/root",
      stashDir: "/tmp/stash",
      manifestPath: "/tmp/manifest.json",
    });
    const config: AkmConfig = {
      semanticSearchMode: "off",
      bundles: { "npm-source": { npm: "npm:test-pkg@1.2.3" } },
    };
    try {
      await ensureSourceCaches(config);
      expect(npmSyncSpy).toHaveBeenCalledTimes(1);
    } finally {
      npmSyncSpy.mockRestore();
      gitSpy.mockRestore();
      websiteSpy.mockRestore();
    }
  });

  test("git and website sources are still refreshed via the consolidated loop (R2 characterization)", async () => {
    const gitSpy = spyOn(gitProvider, "ensureGitMirror").mockResolvedValue(undefined);
    const websiteSpy = spyOn(websiteIngest, "ensureWebsiteMirror").mockResolvedValue({
      rootDir: "/tmp/root",
      stashDir: "/tmp/stash",
      manifestPath: "/tmp/manifest.json",
    });
    const config: AkmConfig = {
      semanticSearchMode: "off",
      bundles: {
        "git-source": { git: "https://github.com/example/repo" },
        "website-source": { website: { url: "https://example.com/docs" } },
      },
    };
    try {
      await ensureSourceCaches(config);
      expect(gitSpy).toHaveBeenCalledTimes(1);
      expect(websiteSpy).toHaveBeenCalledTimes(1);
    } finally {
      gitSpy.mockRestore();
      websiteSpy.mockRestore();
    }
  });

  test("force option propagates to cache-backed sources", async () => {
    const gitSpy = spyOn(gitProvider, "ensureGitMirror").mockResolvedValue(undefined);
    const websiteSpy = spyOn(websiteIngest, "ensureWebsiteMirror").mockResolvedValue({
      rootDir: "/tmp/root",
      stashDir: "/tmp/stash",
      manifestPath: "/tmp/manifest.json",
    });
    const config: AkmConfig = {
      semanticSearchMode: "off",
      bundles: {
        "git-source": { git: "https://github.com/example/repo" },
        "website-source": { website: { url: "https://example.com/docs" } },
      },
    };

    await ensureSourceCaches(config, { force: true });

    expect(gitSpy).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      requireRepoDir: true,
      writable: false,
      force: true,
    });
    expect(websiteSpy).toHaveBeenCalledWith(expect.objectContaining({ name: "website-source" }), {
      requireStashDir: true,
      force: true,
    });
    gitSpy.mockRestore();
    websiteSpy.mockRestore();
  });
});
