// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Coverage-hardening: source resolution + transient-stash detection + include
 * config discovery. These are branchy ref/path classifiers where the existing
 * suite exercises only the happy shape (a valid config, a symlink escape), so a
 * whole boundary could be broken and every committed test would still pass.
 *
 *   - isTransientStashPath: prefix vs exact-match asymmetry across /tmp,
 *     /var/tmp, /private/tmp, /var/folders. A regression here would either leak
 *     the host config (false negative) or misroute a real stash (false positive)
 *     — the exact incident that motivated the function.
 *   - findNearestIncludeConfig: NO existing test. Walk-up-to-boundary logic
 *     with multiple package.json SHAPES (nearest wins, malformed JSON, wrong
 *     type, empty list, boundary inclusive/exclusive).
 *   - copyIncludedPaths: only the symlink branch is covered elsewhere; the
 *     path-escape and missing-path throw branches are not.
 */

import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isTransientStashPath } from "../../src/core/paths";
import { copyIncludedPaths, findNearestIncludeConfig } from "../../src/sources/include";

const createdTmpDirs: string[] = [];

function makeTmpDir(prefix = "src-hard-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return fs.realpathSync(dir);
}

function writeFile(filePath: string, content = ""): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── isTransientStashPath ──────────────────────────────────────────────────────

describe("isTransientStashPath — prefix vs exact-match boundaries", () => {
  test("matches nested paths under each transient root", () => {
    for (const p of [
      "/tmp/foo",
      "/tmp/foo/bar",
      "/var/tmp/x",
      "/private/tmp/x",
      "/private/var/folders/ab/cd/T/x",
      "/var/folders/ab/cd/T/x",
    ]) {
      expect(isTransientStashPath(p)).toBe(true);
    }
  });

  test("matches the bare /tmp and /var/tmp roots (exact, no trailing slash)", () => {
    expect(isTransientStashPath("/tmp")).toBe(true);
    expect(isTransientStashPath("/var/tmp")).toBe(true);
  });

  test("does NOT match a sibling whose name merely starts with 'tmp' — the classic prefix trap", () => {
    // `/tmpfoo` must not be swept up by the `/tmp/` prefix rule; this is the
    // false-positive direction that would misroute a real persistent stash.
    expect(isTransientStashPath("/tmpfoo")).toBe(false);
    expect(isTransientStashPath("/tmproot/stash")).toBe(false);
    expect(isTransientStashPath("/var/tmpfoo")).toBe(false);
  });

  test("does NOT match persistent user/home paths (false-positive guard)", () => {
    for (const p of ["/home/user/.local/share/akm", "/Users/me/stash", "/opt/akm", "relative/tmp", ""]) {
      expect(isTransientStashPath(p)).toBe(false);
    }
  });

  test("documents the exact-match asymmetry: /private/tmp and /var/folders WITHOUT a trailing slash are NOT transient", () => {
    // Only `/private/tmp/` (with slash) and `/var/folders/` (with slash) are
    // matched — the bare directory itself is not. This is intentional current
    // behavior; pinning it means a future refactor that "normalizes" the rules
    // has to make a conscious choice rather than silently flipping it.
    expect(isTransientStashPath("/private/tmp")).toBe(false);
    expect(isTransientStashPath("/var/folders")).toBe(false);
    // ...whereas the bare /tmp and /var/tmp ARE matched (asymmetry documented).
    expect(isTransientStashPath("/tmp")).toBe(true);
  });
});

// ── findNearestIncludeConfig ──────────────────────────────────────────────────

function writePkg(dir: string, obj: unknown): void {
  writeFile(path.join(dir, "package.json"), JSON.stringify(obj));
}

describe("findNearestIncludeConfig — walk-up + package.json shape handling", () => {
  test("returns the include list from a package.json at startDir", () => {
    const root = makeTmpDir();
    writePkg(root, { akm: { include: ["a.md", "dir/b.md"] } });
    const cfg = findNearestIncludeConfig(root, root);
    expect(cfg).toBeDefined();
    expect(cfg?.baseDir).toBe(root);
    expect(cfg?.include).toEqual(["a.md", "dir/b.md"]);
  });

  test("NEAREST config wins — a child package.json shadows the parent", () => {
    const parent = makeTmpDir();
    const child = path.join(parent, "pkg");
    fs.mkdirSync(child, { recursive: true });
    writePkg(parent, { akm: { include: ["parent.md"] } });
    writePkg(child, { akm: { include: ["child.md"] } });
    const cfg = findNearestIncludeConfig(child, parent);
    expect(cfg?.baseDir).toBe(child);
    expect(cfg?.include).toEqual(["child.md"]);
  });

  test("walks UP to find a parent config when startDir has none", () => {
    const parent = makeTmpDir();
    const child = path.join(parent, "nested", "deep");
    fs.mkdirSync(child, { recursive: true });
    writePkg(parent, { akm: { include: ["root.md"] } });
    const cfg = findNearestIncludeConfig(child, parent);
    expect(cfg?.baseDir).toBe(parent);
    expect(cfg?.include).toEqual(["root.md"]);
  });

  test("boundary is INCLUSIVE — a config AT the boundary dir is found", () => {
    const boundary = makeTmpDir();
    const start = path.join(boundary, "sub");
    fs.mkdirSync(start, { recursive: true });
    writePkg(boundary, { akm: { include: ["b.md"] } });
    const cfg = findNearestIncludeConfig(start, boundary);
    expect(cfg?.baseDir).toBe(boundary);
  });

  test("does NOT escape above the boundary — a config in the boundary's PARENT is ignored", () => {
    const grandparent = makeTmpDir();
    const boundary = path.join(grandparent, "boundary");
    const start = path.join(boundary, "sub");
    fs.mkdirSync(start, { recursive: true });
    // Config lives ABOVE the boundary — must not be discovered.
    writePkg(grandparent, { akm: { include: ["escaped.md"] } });
    const cfg = findNearestIncludeConfig(start, boundary);
    expect(cfg).toBeUndefined();
  });

  test("returns undefined when no package.json exists anywhere in range", () => {
    const root = makeTmpDir();
    const start = path.join(root, "a", "b");
    fs.mkdirSync(start, { recursive: true });
    expect(findNearestIncludeConfig(start, root)).toBeUndefined();
  });

  test("malformed JSON is skipped (walk continues to a valid parent)", () => {
    const parent = makeTmpDir();
    const child = path.join(parent, "child");
    fs.mkdirSync(child, { recursive: true });
    writeFile(path.join(child, "package.json"), "{ this is not valid json ");
    writePkg(parent, { akm: { include: ["valid.md"] } });
    const cfg = findNearestIncludeConfig(child, parent);
    expect(cfg?.baseDir).toBe(parent);
    expect(cfg?.include).toEqual(["valid.md"]);
  });

  test("a package.json WITHOUT akm.include is skipped (empty/absent akm key)", () => {
    const parent = makeTmpDir();
    const child = path.join(parent, "child");
    fs.mkdirSync(child, { recursive: true });
    writePkg(child, { name: "no-akm-key", version: "1.0.0" });
    writePkg(parent, { akm: { include: ["valid.md"] } });
    const cfg = findNearestIncludeConfig(child, parent);
    expect(cfg?.baseDir).toBe(parent);
  });

  test("akm.include of the wrong type (string, not array) is ignored", () => {
    const root = makeTmpDir();
    writePkg(root, { akm: { include: "not-an-array" } });
    expect(findNearestIncludeConfig(root, root)).toBeUndefined();
  });

  test("an EMPTY include array does not count as a config (keeps walking)", () => {
    const parent = makeTmpDir();
    const child = path.join(parent, "child");
    fs.mkdirSync(child, { recursive: true });
    writePkg(child, { akm: { include: [] } });
    writePkg(parent, { akm: { include: ["p.md"] } });
    const cfg = findNearestIncludeConfig(child, parent);
    expect(cfg?.baseDir).toBe(parent);
  });

  test("whitespace-only include entries are trimmed away, leaving no config", () => {
    const root = makeTmpDir();
    writePkg(root, { akm: { include: ["   ", "", "\t"] } });
    expect(findNearestIncludeConfig(root, root)).toBeUndefined();
  });
});

// ── copyIncludedPaths — error branches ────────────────────────────────────────

describe("copyIncludedPaths — path-safety error branches", () => {
  test("throws when an include entry escapes the source root via ..", () => {
    const source = makeTmpDir();
    const dest = makeTmpDir();
    // A sibling file that `../outside.md` would resolve to.
    writeFile(path.join(path.dirname(source), "outside.md"), "x");
    expect(() => copyIncludedPaths(["../outside.md"], source, dest)).toThrow(/escapes the package root/);
  });

  test("throws when an include entry does not exist on disk", () => {
    const source = makeTmpDir();
    const dest = makeTmpDir();
    expect(() => copyIncludedPaths(["ghost.md"], source, dest)).toThrow(/does not exist/);
  });

  test("copies a real file into dest under its relative path", () => {
    const source = makeTmpDir();
    const dest = makeTmpDir();
    writeFile(path.join(source, "sub", "real.md"), "hello");
    copyIncludedPaths(["sub/real.md"], source, dest);
    expect(fs.readFileSync(path.join(dest, "sub", "real.md"), "utf8")).toBe("hello");
  });

  test("'.' include copies the whole directory contents (whole-dir branch)", () => {
    const source = makeTmpDir();
    const dest = makeTmpDir();
    writeFile(path.join(source, "a.md"), "A");
    writeFile(path.join(source, "nested", "b.md"), "B");
    copyIncludedPaths(["."], source, dest);
    expect(fs.readFileSync(path.join(dest, "a.md"), "utf8")).toBe("A");
    expect(fs.readFileSync(path.join(dest, "nested", "b.md"), "utf8")).toBe("B");
  });
});
