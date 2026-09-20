import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addStash, removeStash } from "../src/commands/sources/source-manage";
import { getSources, loadConfig, resetConfigCache, saveConfig } from "../src/core/config/config";
import { getConfigPath } from "../src/core/paths";
import { schedulerActivations, setSchedulerRefEnabled } from "../src/tasks/activation-config";
import { type Cleanup, sandboxStashDir, sandboxXdgCacheHome, sandboxXdgConfigHome } from "./_helpers/sandbox";

const fixtureDirs: string[] = [];

function createTmpDir(prefix = "akm-src-mgmt-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtureDirs.push(dir);
  return dir;
}

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const stashResult = sandboxStashDir(cfgResult.cleanup);
  envCleanup = stashResult.cleanup;
  // Write initial config so loadConfig doesn't return defaults with stale caches
  saveConfig({ semanticSearchMode: "auto" });
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
});

afterAll(() => {
  for (const dir of fixtureDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
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
    expect(getSources(config)).toHaveLength(1);
    expect(getSources(config)[0]!.type).toBe("filesystem");
    expect(getSources(config)[0]!.path).toBe(path.resolve(stashPath));
  });

  test("adds a filesystem path with a name", () => {
    const stashPath = createTmpDir("akm-fs-named-");
    const result = addStash({ target: stashPath, name: "my-stash" });

    expect(result.added).toBe(true);
    expect(result.entry?.name).toBe("my-stash");
  });

  test("inserts a new bundle before or after an existing bundle (#982)", () => {
    const first = createTmpDir("akm-fs-order-first-");
    const second = createTmpDir("akm-fs-order-second-");
    const middle = createTmpDir("akm-fs-order-middle-");
    addStash({ target: first, name: "first" });
    addStash({ target: second, name: "second" });
    addStash({ target: middle, name: "middle", before: "second" });
    addStash({ target: "https://last.example.com", providerType: "website", name: "last", after: "second" });

    expect(Object.keys(loadConfig().bundles ?? {})).toEqual(["first", "middle", "second", "last"]);
  });

  test("rejects ambiguous or missing bundle position targets (#982)", () => {
    const source = createTmpDir("akm-fs-order-invalid-");
    expect(() => addStash({ target: source, name: "source", before: "a", after: "b" })).toThrow(
      "Only one of --before or --after",
    );
    expect(() => addStash({ target: source, name: "source", before: "missing" })).toThrow(
      'Bundle position target "missing" is not configured',
    );
  });

  test("bundle add persists only authored settings instead of schema defaults (#972)", () => {
    fs.writeFileSync(getConfigPath(), `${JSON.stringify({ configVersion: "0.9.0" }, null, 2)}\n`, "utf8");
    resetConfigCache();

    addStash({ target: "lodash", providerType: "npm", name: "lodash" });

    const raw = JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(["bundles", "configVersion"]);
    expect(raw.bundles).toEqual({ lodash: { npm: "lodash" } });
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

  test("adds a URL source", () => {
    const url = "https://example.com";
    const result = addStash({ target: url, providerType: "website" });

    expect(result.added).toBe(true);
    expect(result.entry?.type).toBe("website");
    expect(result.entry?.url).toBe(url);

    const config = loadConfig();
    expect(getSources(config)).toHaveLength(1);
    expect(getSources(config)[0]!.type).toBe("website");
    expect(getSources(config)[0]!.url).toBe(url);
  });

  test("adds a URL source with name and options", () => {
    const url = "https://example.com";
    const result = addStash({
      target: url,
      providerType: "website",
      name: "my-source",
      options: { searchType: "text" },
    });

    expect(result.added).toBe(true);
    expect(result.entry?.name).toBe("my-source");
    expect(result.entry?.options).toEqual({ searchType: "text" });
  });

  test("stores only a symbolic credential reference for a git source (#977)", () => {
    const result = addStash({
      target: "https://git.example.com/private/repo.git",
      providerType: "git",
      name: "private-repo",
      credential: "$GIT_READ_TOKEN",
    });

    expect(result.added).toBe(true);
    expect(loadConfig().bundles?.["private-repo"]?.credential).toBe("$GIT_READ_TOKEN");
  });

  test("rejects literal and non-git credentials before writing config (#977)", () => {
    expect(() =>
      addStash({
        target: "https://git.example.com/private/repo.git",
        providerType: "git",
        name: "literal-token",
        credential: "literal-secret-token",
      }),
    ).toThrow(/credential must be a \$VAR/);
    expect(() =>
      addStash({
        target: "https://docs.example.com",
        providerType: "website",
        name: "website-token",
        credential: "$GIT_READ_TOKEN",
      }),
    ).toThrow(/credential is only supported on git/);
    expect(loadConfig().bundles).toBeUndefined();
  });

  test("throws when URL source has no provider type", () => {
    expect(() => addStash({ target: "https://example.com" })).toThrow("--provider is required");
  });

  test("rejects duplicate URL sources", () => {
    const url = "https://example.com";
    addStash({ target: url, providerType: "website" });
    const result = addStash({ target: url, providerType: "website" });

    expect(result.added).toBe(false);
    expect(result.message).toContain("already configured");
  });

  test("rejects unsupported custom provider types", () => {
    const url = "https://custom.example.com";
    expect(() => addStash({ target: url, providerType: "custom-provider" })).toThrow(/unsupported source type/);
    expect(getSources(loadConfig())).toEqual([]);
  });

  // ── R-013: --provider npm with a bare package spec ──────────────────────
  //
  // Regression coverage for R-013: `akm add <pkg> --provider npm` used to
  // silently ignore `providerType` for any non-URL target and create a
  // filesystem bundle for `<cwd>/<pkg>` instead. A bare package spec must
  // become a declarative npm bundle descriptor (`{ npm: <spec> }`), and a URL
  // target must be rejected loudly at add time (never a valid npm spec).

  test("a bare package spec with --provider npm creates an npm bundle, not a filesystem one", () => {
    const result = addStash({ target: "lodash", providerType: "npm" });

    expect(result.added).toBe(true);
    expect(result.entry?.type).toBe("npm");
    // npm sources carry their package spec in `path` (config-sources.ts
    // bundleEntryToSourceEntry) — never `filesystem` and never a resolved
    // absolute path under cwd.
    expect(result.entry?.path).toBe("lodash");

    const config = loadConfig();
    expect(config.bundles?.lodash).toEqual({ npm: "lodash" });
    expect(getSources(config)).toHaveLength(1);
    expect(getSources(config)[0]!.type).toBe("npm");
  });

  test("a scoped package spec with --provider npm and an explicit name is stored as given", () => {
    const result = addStash({ target: "@scope/pkg@^2", providerType: "npm", name: "scoped-pkg" });

    expect(result.added).toBe(true);
    expect(result.entry?.name).toBe("scoped-pkg");
    expect(result.entry?.type).toBe("npm");
    expect(result.entry?.path).toBe("@scope/pkg@^2");
  });

  test("rejects a URL target with --provider npm instead of deferring to a sync-time failure", () => {
    expect(() => addStash({ target: "https://example.com/lodash.tgz", providerType: "npm" })).toThrow(
      /--provider npm expects a package spec.*not a URL/s,
    );
    // Nothing should be written to config on rejection.
    expect(getSources(loadConfig())).toEqual([]);
  });

  test("deduplicates a bare npm spec added twice", () => {
    addStash({ target: "lodash", providerType: "npm" });
    const result = addStash({ target: "lodash", providerType: "npm" });

    expect(result.added).toBe(false);
    expect(result.message).toContain("already configured");
  });

  test("adds an http:// URL source", () => {
    const url = "http://example.com";
    const result = addStash({ target: url, providerType: "website" });

    expect(result.added).toBe(true);
    expect(result.entry?.url).toBe(url);
  });

  test("allows same URL with different provider types", () => {
    const url = "https://shared.example.com";
    addStash({ target: url, providerType: "website" });
    // Same URL but different provider — deduplicates by URL regardless of type
    const result = addStash({ target: url, providerType: "git" });
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

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]!.name).toBe("ret-test");
  });

  test("can add multiple sources of different types", () => {
    const fsPath = createTmpDir("akm-multi-fs-");
    addStash({ target: fsPath });
    addStash({ target: "https://example1.example.com", providerType: "website" });
    addStash({ target: "https://git.example.com/repo.git", providerType: "git" });

    const config = loadConfig();
    expect(getSources(config)).toHaveLength(3);
    expect(getSources(config)[0]!.type).toBe("filesystem");
    expect(getSources(config)[1]!.type).toBe("website");
    expect(getSources(config)[2]!.type).toBe("git");
  });

  test("preserves existing sources when adding", () => {
    const config = loadConfig();
    saveConfig({
      ...config,
      bundles: { existing: { website: { url: "https://existing.example.com" } } },
    });

    const fsPath = createTmpDir("akm-preserve-");
    addStash({ target: fsPath });

    const updated = getSources(loadConfig());
    expect(updated).toHaveLength(2);
    expect(updated[0]!.url).toBe("https://existing.example.com");
    expect(updated[1]!.type).toBe("filesystem");
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
    expect(getSources(config)).toHaveLength(0);
  });

  test("removes a URL source by URL", () => {
    const url = "https://example.com";
    addStash({ target: url, providerType: "website" });

    const result = removeStash(url);
    expect(result.removed).toBe(true);
    expect(result.entry?.url).toBe(url);

    const config = loadConfig();
    expect(getSources(config)).toHaveLength(0);
  });

  test("removes a source by name", () => {
    const url = "https://example.com";
    addStash({ target: url, providerType: "website", name: "my-source" });

    const result = removeStash("my-source");
    expect(result.removed).toBe(true);
    expect(result.entry?.name).toBe("my-source");
  });

  test("revokes scheduler grants owned by the removed bundle", () => {
    const fsPath = createTmpDir("akm-rm-scheduled-");
    addStash({ target: fsPath, name: "scheduled" });
    setSchedulerRefEnabled("task", "scheduled//tasks/nightly", true);

    removeStash("scheduled");

    expect(schedulerActivations(loadConfig())).toEqual([]);
  });

  test("returns removed: false for non-existent source", () => {
    const result = removeStash("/nonexistent/path");
    expect(result.removed).toBe(false);
    expect(result.message).toContain("No matching source found");
  });

  test("removes only the matched source, preserving others", () => {
    const fsPath = createTmpDir("akm-rm-keep-");
    addStash({ target: fsPath });
    addStash({ target: "https://example.com", providerType: "website" });

    removeStash(fsPath);

    const config = loadConfig();
    expect(getSources(config)).toHaveLength(1);
    expect(getSources(config)[0]!.type).toBe("website");
  });

  test("prefers URL match over name match", () => {
    // 0.9.0 (spec §11.1): a source name IS its bundle key (slug-legal), so it can
    // never equal a URL; removeStash still matches by URL before falling back to
    // the key, which this exercises.
    const url = "https://example.com";
    addStash({ target: url, providerType: "website", name: "my-source" });
    addStash({ target: "https://other.example.com", providerType: "website", name: "other-source" });

    const result = removeStash(url);
    expect(result.removed).toBe(true);
    expect(result.entry?.name).toBe("my-source");

    const config = loadConfig();
    expect(getSources(config)).toHaveLength(1);
    expect(getSources(config)[0]!.name).toBe("other-source");
  });

  test("prefers path match over name match", () => {
    const fsPath = createTmpDir("akm-rm-prio-");
    addStash({ target: fsPath, name: "path-source" });
    addStash({ target: "https://other.example.com", providerType: "website", name: fsPath });

    // Should match by path (first entry), not by name (second entry)
    const result = removeStash(fsPath);
    expect(result.removed).toBe(true);
    expect(result.entry?.type).toBe("filesystem");
  });

  test("removes http:// URL source", () => {
    const url = "http://example.com";
    addStash({ target: url, providerType: "website" });

    const result = removeStash(url);
    expect(result.removed).toBe(true);
    expect(result.entry?.url).toBe(url);
  });

  test("returned stashes array reflects new state", () => {
    const fsPath = createTmpDir("akm-rm-ret-");
    addStash({ target: fsPath, name: "rm-ret-test" });
    addStash({ target: "https://keep.example.com", providerType: "website", name: "keep" });

    const result = removeStash("rm-ret-test");
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]!.name).toBe("keep");
  });

  test("removes filesystem source by relative path that resolves correctly", () => {
    const fsPath = createTmpDir("akm-rm-rel-");
    addStash({ target: fsPath });

    const relativePath = path.relative(process.cwd(), fsPath);
    const result = removeStash(relativePath);
    expect(result.removed).toBe(true);
  });
});

// ── Round-trip integration ──────────────────────────────────────────────────
// R-063 #6: `listStashes`/`SourceListResult` (a thin `{ getSources(loadConfig()),
// resolveSourceEntries() }` wrapper with zero production callers) were deleted;
// these round-trip tests cover the real production functions (`addStash` /
// `removeStash`) and now read sources back via `getSources(loadConfig())` directly.

describe("round-trip integration", () => {
  test("add then list then remove filesystem source", () => {
    const fsPath = createTmpDir("akm-roundtrip-fs-");
    addStash({ target: fsPath, name: "roundtrip-test" });

    const listed = getSources(loadConfig());
    expect(listed.some((s) => s.name === "roundtrip-test")).toBe(true);

    removeStash("roundtrip-test");
    const afterRemove = getSources(loadConfig());
    expect(afterRemove.some((s) => s.name === "roundtrip-test")).toBe(false);
  });

  test("add then list then remove URL source", () => {
    const url = "https://roundtrip.example.com";
    addStash({ target: url, providerType: "website", name: "rt-source" });

    const listed = getSources(loadConfig());
    expect(listed.some((s) => s.name === "rt-source")).toBe(true);

    removeStash(url);
    const afterRemove = getSources(loadConfig());
    expect(afterRemove.some((s) => s.url === url)).toBe(false);
  });

  test("add then list then remove git provider source", () => {
    const url = "https://git-roundtrip.example.com/repo.git";
    addStash({
      target: url,
      providerType: "git",
      name: "git-rt",
    });

    const listed = getSources(loadConfig());
    const entry = listed.find((s) => s.name === "git-rt");
    expect(entry).toBeDefined();
    expect(entry?.type).toBe("git");

    removeStash("git-rt");
    const afterRemove = getSources(loadConfig());
    expect(afterRemove.some((s) => s.name === "git-rt")).toBe(false);
  });

  test("multiple adds and removes maintain order and integrity", () => {
    const fs1 = createTmpDir("akm-multi-1-");
    const fs2 = createTmpDir("akm-multi-2-");
    const url1 = "https://v1.example.com";
    const url2 = "https://v2.example.com";

    addStash({ target: fs1, name: "fs1" });
    addStash({ target: url1, providerType: "website", name: "v1" });
    addStash({ target: fs2, name: "fs2" });
    addStash({ target: url2, providerType: "website", name: "v2" });

    let sources = getSources(loadConfig());
    expect(sources).toHaveLength(4);
    expect(sources.map((s) => s.name)).toEqual(["fs1", "v1", "fs2", "v2"]);

    // Remove middle entry
    removeStash("v1");
    sources = getSources(loadConfig());
    expect(sources).toHaveLength(3);
    expect(sources.map((s) => s.name)).toEqual(["fs1", "fs2", "v2"]);

    // Remove first entry
    removeStash("fs1");
    sources = getSources(loadConfig());
    expect(sources).toHaveLength(2);
    expect(sources.map((s) => s.name)).toEqual(["fs2", "v2"]);
  });
});
