import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SearchSource } from "../../src/indexer/search/search-source";
import { isRemoteOrigin, resolveSourcesForLocator, resolveSourcesForOrigin } from "../../src/registry/origin-resolve";

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-origin-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeSource(overrides?: Partial<SearchSource>): SearchSource {
  return {
    path: overrides?.path ?? makeTmpDir(),
    registryId: overrides?.registryId,
  };
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

// ── resolveSourcesForOrigin ─────────────────────────────────────────────────

describe("resolveSourcesForOrigin", () => {
  test("returns all sources when origin is undefined", () => {
    const sources = [makeSource(), makeSource()];
    const result = resolveSourcesForOrigin(undefined, sources);
    expect(result).toEqual(sources);
  });

  test("does not retarget an absent 'local' bundle to the primary source", () => {
    const sources = [makeSource(), makeSource(), makeSource()];
    const result = resolveSourcesForOrigin("local", sources);
    expect(result).toEqual([]);
  });

  test("configured bundles named local or stash resolve literally", () => {
    const primary = makeSource();
    const local = makeSource({ registryId: "local" });
    const stash = makeSource({ registryId: "stash" });
    const sources = [primary, local, stash];

    expect(resolveSourcesForOrigin("local", sources)).toEqual([local]);
    expect(resolveSourcesForOrigin("stash", sources)).toEqual([stash]);
  });

  test("an implicit source resolves by its derived canonical bundle id", () => {
    const parent = makeTmpDir();
    const stashPath = path.join(parent, "stash");
    fs.mkdirSync(stashPath);
    const source = makeSource({ path: stashPath });

    expect(resolveSourcesForOrigin("stash", [source])).toEqual([source]);
    expect(resolveSourcesForOrigin("local", [source])).toEqual([]);
  });

  test("returns empty array for 'local' origin with no sources", () => {
    const result = resolveSourcesForOrigin("local", []);
    expect(result).toEqual([]);
  });

  test("does not treat an install registry id as an asset bundle id", () => {
    const target = makeSource({ registryId: "npm:@scope/pkg" });
    const other = makeSource({ registryId: "github:owner/repo" });
    const sources = [makeSource(), target, other];
    const result = resolveSourcesForOrigin("npm:@scope/pkg", sources);
    expect(result).toEqual([]);
  });

  test("falls through to empty when parseRegistryRef throws for invalid shorthand", () => {
    // "owner/repo" looks path-like and fails statSync, so parseRegistryRef throws.
    // The catch block in resolveSourcesForOrigin swallows the error, and path matching
    // also fails since the path doesn't exist. Result: empty array.
    const target = makeSource({ registryId: "github:owner/repo" });
    const sources = [makeSource(), target];
    const result = resolveSourcesForOrigin("owner/repo", sources);
    expect(result).toEqual([]);
  });

  test("does not parse a full install locator as an asset bundle", () => {
    const target = makeSource({ registryId: "github:owner/repo" });
    const sources = [makeSource(), target];
    const result = resolveSourcesForOrigin("github:owner/repo", sources);
    expect(result).toEqual([]);
  });

  test("does not parse a filesystem path as an asset bundle", () => {
    const dir = makeTmpDir();
    const source = makeSource({ path: dir });
    const sources = [makeSource(), source];
    const result = resolveSourcesForOrigin(dir, sources);
    expect(result).toEqual([]);
  });

  test("returns empty array when no match found", () => {
    const sources = [makeSource(), makeSource()];
    const result = resolveSourcesForOrigin("nonexistent:thing", sources);
    expect(result).toEqual([]);
  });

  test("returns empty array for empty sources list with a non-local origin", () => {
    const result = resolveSourcesForOrigin("npm:@scope/pkg", []);
    expect(result).toEqual([]);
  });

  test("a configured bundle id is reserved ahead of a colliding implicit id", () => {
    const parent = makeTmpDir();
    const stashPath = path.join(parent, "stash");
    fs.mkdirSync(stashPath);
    const implicit = makeSource({ path: stashPath });
    const configured = makeSource({ registryId: "stash" });

    expect(resolveSourcesForOrigin("stash", [implicit, configured])).toEqual([configured]);
  });

  test("a local bundle cannot fall through to npm shorthand", () => {
    const parent = makeTmpDir();
    const localPath = path.join(parent, "local");
    fs.mkdirSync(localPath);
    const implicit = makeSource({ path: localPath });
    const npmLocal = makeSource({ registryId: "npm:local" });

    expect(resolveSourcesForOrigin("local", [implicit, npmLocal])).toEqual([implicit]);
  });
});

describe("resolveSourcesForLocator", () => {
  test("matches exact registry ids and filesystem paths for clone inputs", () => {
    const dir = makeTmpDir();
    const byId = makeSource({ registryId: "npm:@scope/pkg" });
    const byPath = makeSource({ path: dir });
    const sources = [byId, byPath];

    expect(resolveSourcesForLocator("npm:@scope/pkg", sources)).toEqual([byId]);
    expect(resolveSourcesForLocator(dir, sources)).toEqual([byPath]);
  });
});

// ── isRemoteOrigin ──────────────────────────────────────────────────────────

describe("isRemoteOrigin", () => {
  test("returns false for 'local' origin", () => {
    expect(isRemoteOrigin("local", [])).toBe(false);
  });

  test("returns true when origin matches no sources", () => {
    const sources = [makeSource()];
    expect(isRemoteOrigin("npm:@nonexistent/pkg", sources)).toBe(true);
  });

  test("returns false when origin matches a source by registryId", () => {
    const source = makeSource({ registryId: "npm:@scope/pkg" });
    expect(isRemoteOrigin("npm:@scope/pkg", [source])).toBe(false);
  });

  test("returns false when origin matches a source by path", () => {
    const dir = makeTmpDir();
    const source = makeSource({ path: dir });
    expect(isRemoteOrigin(dir, [source])).toBe(false);
  });

  test("returns true for an uninstalled GitHub ref", () => {
    const sources = [makeSource()];
    expect(isRemoteOrigin("github:unknown/repo", sources)).toBe(true);
  });
});
