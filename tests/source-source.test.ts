import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AkmConfig, BundleConfigEntry } from "../src/core/config/config";
import { saveConfig } from "../src/core/config/config";
import { getUnresolvedSourcesDir } from "../src/core/paths";
import { resolveWritable } from "../src/core/write-source";
import { buildDbHit } from "../src/indexer/search/db-search";
import {
  ensureSourceCaches,
  findSourceForPath,
  isEditable,
  resolveSourceEntries,
} from "../src/indexer/search/search-source";
import type { InstallKind } from "../src/registry/types";
import { seedLockEntries } from "./_helpers/lockfile";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

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
  seedLockEntries([{ id: key, source: lock.source, ref: lock.ref, localRoot: lock.localRoot }]);
}

import * as gitProvider from "../src/sources/providers/git";
import { NpmSourceProvider } from "../src/sources/providers/npm";
import * as websiteIngest from "../src/sources/snapshot-fetchers/website-ingest";

let storage: IsolatedAkmStorage;
let stashDir = "";

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  stashDir = storage.stashDir;
});

afterEach(() => {
  storage.cleanup();
  stashDir = "";
});

describe("resolveSourceEntries", () => {
  test("returns primary stash as first source", () => {
    saveConfig({ semanticSearchMode: "off" });
    const sources = resolveSourceEntries();
    expect(sources.length).toBeGreaterThanOrEqual(1);
    expect(sources[0]!.path).toBe(stashDir);
    expect(sources[0]!.registryId).toBeUndefined();
    expect(sources[0]?.writable).toBe(true);
  });

  test("includes valid stash paths", () => {
    const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-extra-"));
    try {
      saveConfig({ semanticSearchMode: "off", bundles: { extra: { path: extraDir } } });
      const sources = resolveSourceEntries();
      expect(sources.length).toBe(2);
      expect(sources[1]!.path).toBe(extraDir);
      expect(sources[1]?.type).toBe("filesystem");
      expect(sources[1]?.writable).toBe(true);
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

  test("keeps non-existent configured paths so indexing can preserve their last-known-good rows", () => {
    saveConfig({
      semanticSearchMode: "off",
      bundles: { missing: { path: "/nonexistent/path/should/not/exist" } },
    });
    const sources = resolveSourceEntries();
    expect(sources).toHaveLength(2);
    expect(sources[1]).toMatchObject({
      path: "/nonexistent/path/should/not/exist",
      registryId: "missing",
      type: "filesystem",
    });
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
      seedLockEntries([{ id: "test-pkg", source: "npm", ref: "npm:test-pkg@1.0.0", localRoot: installedDir }]);
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

  test("keeps AKM_BUNDLE_DIR ahead of a configured default bundle", () => {
    const configuredDefault = fs.mkdtempSync(path.join(os.tmpdir(), "akm-configured-default-"));
    try {
      saveConfig({
        semanticSearchMode: "off",
        defaultBundle: "configured",
        bundles: { configured: { path: configuredDefault } },
      });

      const sources = resolveSourceEntries();
      expect(sources.map((source) => source.path)).toEqual([stashDir, configuredDefault]);
      expect(sources[0]?.registryId).toBeUndefined();
      expect(sources[1]?.registryId).toBe("configured");
    } finally {
      fs.rmSync(configuredDefault, { recursive: true, force: true });
    }
  });

  test("keeps an explicit stash override ahead of env and default bundle", () => {
    const configuredDefault = fs.mkdtempSync(path.join(os.tmpdir(), "akm-configured-default-"));
    const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-explicit-override-"));
    try {
      saveConfig({
        semanticSearchMode: "off",
        defaultBundle: "configured",
        bundles: { configured: { path: configuredDefault } },
      });

      const sources = resolveSourceEntries(overrideDir);
      expect(sources.map((source) => source.path)).toEqual([overrideDir, configuredDefault]);
    } finally {
      fs.rmSync(configuredDefault, { recursive: true, force: true });
      fs.rmSync(overrideDir, { recursive: true, force: true });
    }
  });

  test("represents an escaping default component as unresolved without inserting the escaped root", () => {
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-escaping-default-"));
    try {
      saveConfig({
        semanticSearchMode: "off",
        defaultBundle: "escaping",
        bundles: {
          escaping: { path: bundleRoot, components: { main: { root: "..", adapter: "akm" } } },
        },
      });

      const sources = resolveSourceEntries();
      const unresolved = sources.find((source) => source.registryId === "escaping");
      expect(sources[0]?.path).toBe(stashDir);
      expect(unresolved).toMatchObject({ unresolved: true, registryId: "escaping" });
      // itlackey/akm#890: the placeholder now lives under $CACHE, keyed by the
      // bundle root, never under the bundle root (or the escaped root) itself.
      expect(unresolved?.path.startsWith(`${getUnresolvedSourcesDir(bundleRoot)}${path.sep}`)).toBe(true);
      expect(unresolved?.path.startsWith(`${bundleRoot}${path.sep}`)).toBe(false);
      expect(sources.some((source) => source.path === path.dirname(bundleRoot))).toBe(false);
      if (!unresolved) throw new Error("expected unresolved source");
      fs.mkdirSync(unresolved.path, { recursive: true });
      expect(resolveSourceEntries(unresolved.path)[0]).toMatchObject({
        path: unresolved.path,
        registryId: "escaping",
        unresolved: true,
      });
    } finally {
      fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
  });

  test("uses canonical writable defaults for every configured provider kind", () => {
    const filesystemDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-policy-filesystem-"));
    const gitDefaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-policy-git-default-"));
    const gitWritableDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-policy-git-writable-"));
    const npmDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-policy-npm-"));
    const websiteUrl = "https://example.com/akm-policy";
    const websitePaths = websiteIngest.getWebsiteCachePaths(websiteUrl);
    fs.mkdirSync(websitePaths.stashDir, { recursive: true });
    try {
      saveConfig({
        semanticSearchMode: "off",
        bundles: {
          filesystem: { path: filesystemDir },
          "git-default": { git: "https://example.test/default.git" },
          "git-writable": { git: "https://example.test/writable.git", writable: true },
          website: { website: { url: websiteUrl } },
          npm: { npm: "npm:policy-package@1.0.0" },
        },
      });
      seedLockEntries([
        {
          id: "git-default",
          source: "git",
          ref: "https://example.test/default.git",
          localRoot: gitDefaultDir,
        },
        {
          id: "git-writable",
          source: "git",
          ref: "https://example.test/writable.git",
          localRoot: gitWritableDir,
        },
        { id: "npm", source: "npm", ref: "npm:policy-package@1.0.0", localRoot: npmDir },
      ]);

      const byName = new Map(resolveSourceEntries().map((source) => [source.registryId, source]));
      expect(byName.get("filesystem")).toMatchObject({ type: "filesystem", writable: true });
      expect(byName.get("git-default")).toMatchObject({ type: "git", writable: false });
      expect(byName.get("git-writable")).toMatchObject({ type: "git", writable: true });
      expect(byName.get("website")).toMatchObject({ type: "website", writable: false });
      expect(byName.get("npm")).toMatchObject({ type: "npm", writable: false });
    } finally {
      for (const dir of [filesystemDir, gitDefaultDir, gitWritableDir, npmDir, websitePaths.rootDir]) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
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

  test("agent output honors an explicit read-only policy on the configured primary bundle", async () => {
    saveConfig({
      semanticSearchMode: "off",
      bundles: { stash: { path: stashDir, writable: false } },
      defaultBundle: "stash",
    });
    const sources = resolveSourceEntries();
    const filePath = path.join(stashDir, "knowledge", "guide.md");
    const hit = await buildDbHit({
      entry: { type: "knowledge", name: "guide", description: "Guide" },
      path: filePath,
      itemRef: "stash//knowledge/guide",
      bundleId: "stash",
      conceptId: "knowledge/guide",
      score: 1,
      query: "guide",
      rankingMode: "fts",
      defaultStashDir: stashDir,
      allSourceDirs: sources.map((source) => source.path),
      sources,
      config: { semanticSearchMode: "off" },
    });

    expect(sources[0]).toMatchObject({ registryId: "stash", type: "filesystem", writable: false });
    expect(hit.editable).toBe(false);
    expect(hit.editHint).toContain("read-only under current AKM source policy");
    expect(hit.editHint).not.toContain("overwritten on update");
  });

  test("explicit read-only filesystem bundles are not editable", () => {
    const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-extra-readonly-"));
    try {
      saveConfig({ semanticSearchMode: "off", bundles: { extra: { path: extraDir, writable: false } } });
      expect(isEditable(path.join(extraDir, "scripts", "deploy.sh"))).toBe(false);
    } finally {
      fs.rmSync(extraDir, { recursive: true, force: true });
    }
  });

  test("git bundles are read-only by default", () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-cache-"));
    try {
      seedManagedBundle(
        "team",
        { git: "https://example.test/team.git" },
        {
          source: "git",
          ref: "https://example.test/team.git",
          localRoot: cacheDir,
        },
      );
      expect(isEditable(path.join(cacheDir, "scripts", "deploy.sh"))).toBe(false);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test("writable git bundles are editable", () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-cache-writable-"));
    try {
      seedManagedBundle(
        "team",
        { git: "https://example.test/team.git", writable: true },
        {
          source: "git",
          ref: "https://example.test/team.git",
          localRoot: cacheDir,
        },
      );
      expect(isEditable(path.join(cacheDir, "scripts", "deploy.sh"))).toBe(true);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  for (const type of ["website", "npm"] as const) {
    test(`${type} bundles are read-only`, () => {
      const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), `akm-${type}-readonly-`));
      try {
        const writable = resolveWritable({ type });
        expect(writable).toBe(false);
        expect(
          isEditable(path.join(cacheDir, "knowledge", "guide.md"), undefined, [
            { path: stashDir, writable: true },
            { path: cacheDir, type, writable },
          ]),
        ).toBe(false);
      } finally {
        fs.rmSync(cacheDir, { recursive: true, force: true });
      }
    });
  }

  test("files outside every configured source fail closed", () => {
    saveConfig({ semanticSearchMode: "off" });
    expect(isEditable("/some/random/path/file.sh")).toBe(false);
  });

  test("read-only hits keep a use-oriented action and receive a secondary edit hint", async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-readonly-hit-"));
    try {
      const filePath = path.join(sourceDir, "knowledge", "guide.md");
      const hit = await buildDbHit({
        entry: { type: "knowledge", name: "guide", description: "Guide" },
        path: filePath,
        itemRef: "team//knowledge/guide",
        bundleId: "team",
        conceptId: "knowledge/guide",
        score: 1,
        query: "guide",
        rankingMode: "fts",
        defaultStashDir: stashDir,
        allSourceDirs: [stashDir, sourceDir],
        sources: [
          { path: stashDir, writable: true },
          { path: sourceDir, registryId: "team", type: "git", writable: false },
        ],
        config: { semanticSearchMode: "off" },
      });

      expect(hit.ref).toBe("team//knowledge/guide");
      expect(hit.editable).toBe(false);
      expect(hit.editHint).toContain("akm clone team//knowledge/guide");
      expect(hit.action).toContain("akm show team//knowledge/guide");
      expect(hit.action).not.toContain("clone");
    } finally {
      fs.rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  test("stored item refs distinguish duplicate concepts across bundles", async () => {
    const roots = [
      fs.mkdtempSync(path.join(os.tmpdir(), "akm-bundle-a-")),
      fs.mkdtempSync(path.join(os.tmpdir(), "akm-bundle-b-")),
    ];
    try {
      const hits = await Promise.all(
        roots.map((root, index) =>
          buildDbHit({
            entry: { type: "knowledge", name: "shared" },
            path: path.join(root, "knowledge", "shared.md"),
            itemRef: `bundle-${index + 1}//knowledge/shared`,
            bundleId: `bundle-${index + 1}`,
            conceptId: "knowledge/shared",
            score: 1,
            query: "shared",
            rankingMode: "fts",
            defaultStashDir: stashDir,
            allSourceDirs: roots,
            sources: roots.map((sourceRoot, sourceIndex) => ({
              path: sourceRoot,
              registryId: `bundle-${sourceIndex + 1}`,
              writable: false,
            })),
            config: { semanticSearchMode: "off" },
          }),
        ),
      );
      expect(hits.map((hit) => hit.ref)).toEqual(["bundle-1//knowledge/shared", "bundle-2//knowledge/shared"]);
    } finally {
      for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    }
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

  test("processes website bundles through the provider sync loop", async () => {
    // Mock the mirror (no network) and verify the current website bundle is
    // projected into a provider and synchronized.
    //
    // RUNTIME-05: the URL must NOT be under the `.invalid` TLD. `.invalid` is
    // rejected synchronously by assertWebsiteRequestUrl
    // (src/sources/snapshot-fetchers/website-ingest.ts:677-679) inside the
    // website provider FACTORY (src/sources/providers/website.ts:16-18) — i.e.
    // before `sync()`/`ensureWebsiteMirror` is ever reached. With the old
    // `example.invalid` URL, `ensureSourceCaches` caught that construction
    // error and warned+continued (src/indexer/search/search-source.ts:362-371),
    // so the mocked mirror below would never actually be called — this test
    // would silently stop proving "website entries are processed" at all.
    // `.test` (used by the neighbouring tests in this describe) is not
    // special-cased there, so the mocked path is genuinely exercised.
    const websiteSpy = spyOn(websiteIngest, "ensureWebsiteMirror").mockResolvedValue({
      rootDir: "/tmp/root",
      stashDir: "/tmp/stash",
      manifestPath: "/tmp/manifest.json",
    });
    const config: AkmConfig = {
      semanticSearchMode: "off",
      bundles: { "test-website": { website: { url: "https://example.test/docs" } } },
    };
    try {
      await expect(ensureSourceCaches(config)).resolves.toBeUndefined();
      expect(websiteSpy).toHaveBeenCalledTimes(1);
    } finally {
      websiteSpy.mockRestore();
    }
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

  test("reports 'Hydrating source i/n' progress per source before its sync resolves (#954)", async () => {
    const delayed = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
    const npmSyncSpy = spyOn(NpmSourceProvider.prototype, "sync").mockImplementation(delayed);
    const gitSpy = spyOn(gitProvider, "ensureGitMirror").mockImplementation(delayed);
    const config: AkmConfig = {
      semanticSearchMode: "off",
      bundles: {
        "npm-source": { npm: "npm:test-pkg@1.2.3" },
        "git-source": { git: "https://github.com/example/repo.git" },
      },
    };
    const messages: string[] = [];
    try {
      await ensureSourceCaches(config, { onProgress: (message) => messages.push(message) });
      expect(npmSyncSpy).toHaveBeenCalledTimes(1);
      expect(gitSpy).toHaveBeenCalledTimes(1);
      // One "Hydrating source i/2: <name>" event per source, fired BEFORE
      // that source's sync resolves — proving the caller sees progress
      // while a slow sync is still in flight, not only after the whole call
      // returns.
      expect(messages.filter((m) => /^Hydrating source \d+\/2: /.test(m))).toHaveLength(2);
    } finally {
      npmSyncSpy.mockRestore();
      gitSpy.mockRestore();
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
