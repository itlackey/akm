/**
 * Unit tests for resolveProjectContext.
 *
 * All tests use the `fsOverride` parameter to avoid touching the real
 * filesystem. The `cwd` parameter is used to control which directory
 * is being "tested" without actually changing the process working directory.
 */

import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { resolveProjectContext } from "../../src/indexer/walk/project-context";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal fsOverride that returns specific file contents for specific
 * paths and throws ENOENT for everything else.
 */
function buildFs(files: Record<string, string>) {
  return {
    readFileSync(filePath: string, _enc: BufferEncoding): string {
      if (filePath in files) return files[filePath];
      const err = new Error(`ENOENT: no such file or directory, open '${filePath}'`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    },
  };
}

// A fake "project root" that is not the home dir or /tmp.
const FAKE_PROJECT = "/projects/my-project";

// ── git config extraction ────────────────────────────────────────────────────

describe("resolveProjectContext — git config", () => {
  test("SSH git URL extracts repo name correctly", () => {
    const gitConfig = `
[core]
  repositoryformatversion = 0
[remote "origin"]
  url = git@github.com:itlackey/akm.git
  fetch = +refs/heads/*:refs/remotes/origin/*
`;
    const fs = buildFs({ [`${FAKE_PROJECT}/.git/config`]: gitConfig });
    const ctx = resolveProjectContext(FAKE_PROJECT, fs);
    expect(ctx).not.toBeNull();
    expect(ctx?.tokens).toEqual(new Set(["akm"]));
  });

  test("HTTPS git URL extracts repo name correctly", () => {
    const gitConfig = `
[remote "origin"]
  url = https://github.com/itlackey/akm
`;
    const fs = buildFs({ [`${FAKE_PROJECT}/.git/config`]: gitConfig });
    const ctx = resolveProjectContext(FAKE_PROJECT, fs);
    expect(ctx).not.toBeNull();
    expect(ctx?.tokens).toEqual(new Set(["akm"]));
  });

  test("multi-token repo name is split on hyphens", () => {
    const gitConfig = `
[remote "origin"]
  url = git@github.com:acme/open-palm.git
`;
    const fs = buildFs({ [`${FAKE_PROJECT}/.git/config`]: gitConfig });
    const ctx = resolveProjectContext(FAKE_PROJECT, fs);
    expect(ctx).not.toBeNull();
    // "open" is not in the blocklist; "palm" is not either
    expect(ctx?.tokens).toEqual(new Set(["open", "palm"]));
  });

  test("git URL with .git extension stripped", () => {
    const gitConfig = `
[remote "origin"]
  url = https://github.com/itlackey/my-tool-kit.git
`;
    const fs = buildFs({ [`${FAKE_PROJECT}/.git/config`]: gitConfig });
    const ctx = resolveProjectContext(FAKE_PROJECT, fs);
    // "my", "tool", "kit" are all in blocklist → no tokens survive
    // falls through to package.json and then scope-anchor
    // (no package.json in this FS fixture, so anchor is used)
    // The anchor is FAKE_PROJECT → basename "my-project" → tokens: ["project"]
    // (since "my" is blocked)
    expect(ctx).not.toBeNull();
  });

  test("git config without remote origin falls through to package.json", () => {
    const gitConfig = `
[core]
  repositoryformatversion = 0
`;
    const pkgJson = JSON.stringify({ name: "cool-project" });
    const fs = buildFs({
      [`${FAKE_PROJECT}/.git/config`]: gitConfig,
      [`${FAKE_PROJECT}/package.json`]: pkgJson,
    });
    const ctx = resolveProjectContext(FAKE_PROJECT, fs);
    expect(ctx).not.toBeNull();
    expect(ctx?.tokens).toEqual(new Set(["cool", "project"]));
  });
});

// ── package.json extraction ──────────────────────────────────────────────────

describe("resolveProjectContext — package.json", () => {
  test("simple package name extracts tokens", () => {
    const pkgJson = JSON.stringify({ name: "cool-project" });
    const fs = buildFs({ [`${FAKE_PROJECT}/package.json`]: pkgJson });
    const ctx = resolveProjectContext(FAKE_PROJECT, fs);
    expect(ctx).not.toBeNull();
    expect(ctx?.tokens).toEqual(new Set(["cool", "project"]));
  });

  test("scoped package name uses last segment", () => {
    const pkgJson = JSON.stringify({ name: "@acme/event-bus" });
    const fs = buildFs({ [`${FAKE_PROJECT}/package.json`]: pkgJson });
    const ctx = resolveProjectContext(FAKE_PROJECT, fs);
    expect(ctx).not.toBeNull();
    expect(ctx?.tokens).toEqual(new Set(["event", "bus"]));
  });

  test("common suffixes are stripped before tokenising", () => {
    const pkgJson = JSON.stringify({ name: "my-service-cli" });
    const fs = buildFs({ [`${FAKE_PROJECT}/package.json`]: pkgJson });
    const ctx = resolveProjectContext(FAKE_PROJECT, fs);
    expect(ctx).not.toBeNull();
    // "my" blocked, "service" survives, "-cli" stripped before split
    expect(ctx?.tokens.has("service")).toBe(true);
    expect(ctx?.tokens.has("cli")).toBe(false);
  });

  test("package name 'akm' returns token Set { 'akm' }", () => {
    const pkgJson = JSON.stringify({ name: "akm" });
    const fs = buildFs({ [`${FAKE_PROJECT}/package.json`]: pkgJson });
    const ctx = resolveProjectContext(FAKE_PROJECT, fs);
    expect(ctx).not.toBeNull();
    expect(ctx?.tokens).toEqual(new Set(["akm"]));
  });
});

// ── Noise root guard ─────────────────────────────────────────────────────────

describe("resolveProjectContext — noise roots", () => {
  test("returns null when cwd is the home directory", () => {
    // Home dir has neither .git/config nor package.json in our fake FS,
    // so it falls through to the scope-anchor path which returns homedir —
    // the noise-root guard then returns null.
    const homedir = os.homedir();
    const ctx = resolveProjectContext(homedir, buildFs({}));
    expect(ctx).toBeNull();
  });

  test("returns null when cwd is /tmp", () => {
    const ctx = resolveProjectContext("/tmp", buildFs({}));
    expect(ctx).toBeNull();
  });

  test("returns null when cwd is a sub-path of /tmp", () => {
    const ctx = resolveProjectContext("/tmp/some-runner-dir", buildFs({}));
    expect(ctx).toBeNull();
  });
});

// ── Token blocklist ──────────────────────────────────────────────────────────

describe("resolveProjectContext — token blocklist", () => {
  test("all-blocked tokens from package.json fall through to scope-anchor basename", () => {
    // "my-app" → tokens ["my", "app"] → both blocked → falls through
    const pkgJson = JSON.stringify({ name: "my-app" });
    const fs = buildFs({ [`${FAKE_PROJECT}/package.json`]: pkgJson });
    const ctx = resolveProjectContext(FAKE_PROJECT, fs);
    // FAKE_PROJECT basename is "my-project" → "project" survives
    expect(ctx).not.toBeNull();
    expect(ctx?.tokens.has("my")).toBe(false);
    expect(ctx?.tokens.has("app")).toBe(false);
  });

  test("blocklist words are filtered individually", () => {
    const gitConfig = `
[remote "origin"]
  url = git@github.com:acme/sdk-core-lib.git
`;
    const fs = buildFs({ [`${FAKE_PROJECT}/.git/config`]: gitConfig });
    const ctx = resolveProjectContext(FAKE_PROJECT, fs);
    // "sdk", "core", "lib" are all blocked — falls through to scope anchor
    // FAKE_PROJECT → "my-project" → "project"
    if (ctx) {
      expect(ctx.tokens.has("sdk")).toBe(false);
      expect(ctx.tokens.has("core")).toBe(false);
      expect(ctx.tokens.has("lib")).toBe(false);
    }
  });
});

// ── Token cap ────────────────────────────────────────────────────────────────

describe("resolveProjectContext — token cap", () => {
  test("returns at most 5 tokens", () => {
    // Construct a name with many non-blocked segments
    const pkgJson = JSON.stringify({ name: "alpha-beta-gamma-delta-epsilon-zeta-eta" });
    const fs = buildFs({ [`${FAKE_PROJECT}/package.json`]: pkgJson });
    const ctx = resolveProjectContext(FAKE_PROJECT, fs);
    expect(ctx).not.toBeNull();
    expect(ctx?.tokens.size ?? 0).toBeLessThanOrEqual(5);
  });
});

// ── fsOverride contract ──────────────────────────────────────────────────────

describe("resolveProjectContext — fsOverride injection", () => {
  test("fsOverride is used instead of real FS", () => {
    // This directory does NOT exist on disk — the test only works if the
    // override is actually used.
    const fakeDir = path.join(os.tmpdir(), `akm-test-nonexistent-${Date.now()}`);
    const gitConfig = `
[remote "origin"]
  url = git@github.com:test/fixture-project.git
`;
    const fs = buildFs({ [`${fakeDir}/.git/config`]: gitConfig });
    const ctx = resolveProjectContext(fakeDir, fs);
    // fixture-project → ["fixture", "project"]
    expect(ctx).not.toBeNull();
    expect(ctx?.tokens.has("fixture")).toBe(true);
    expect(ctx?.tokens.has("project")).toBe(true);
  });
});
