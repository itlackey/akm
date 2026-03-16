import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRemoteOrigin, resolveSourcesForOrigin } from "../src/origin-resolve";
import type { SearchSource } from "../src/search-source";

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

  test("returns first source for 'local' origin", () => {
    const sources = [makeSource(), makeSource(), makeSource()];
    const result = resolveSourcesForOrigin("local", sources);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(sources[0]);
  });

  test("returns empty array for 'local' origin with no sources", () => {
    const result = resolveSourcesForOrigin("local", []);
    expect(result).toEqual([]);
  });

  test("matches by exact registryId", () => {
    const target = makeSource({ registryId: "npm:@scope/pkg" });
    const other = makeSource({ registryId: "github:owner/repo" });
    const sources = [makeSource(), target, other];
    const result = resolveSourcesForOrigin("npm:@scope/pkg", sources);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(target);
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

  test("matches by exact registryId with full prefix form", () => {
    const target = makeSource({ registryId: "github:owner/repo" });
    const sources = [makeSource(), target];
    // Full prefix "github:owner/repo" matches exact registryId
    const result = resolveSourcesForOrigin("github:owner/repo", sources);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(target);
  });

  test("matches by resolved path", () => {
    const dir = makeTmpDir();
    const source = makeSource({ path: dir });
    const sources = [makeSource(), source];
    const result = resolveSourcesForOrigin(dir, sources);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(source);
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

  test("exact registryId match takes priority over path match", () => {
    const dir = makeTmpDir();
    const byId = makeSource({ registryId: dir });
    const byPath = makeSource({ path: dir });
    const sources = [byId, byPath];
    // The origin matches byId's registryId exactly
    const result = resolveSourcesForOrigin(dir, sources);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(byId);
  });

  test("returns multiple sources if multiple registryIds match", () => {
    const a = makeSource({ registryId: "npm:@scope/pkg" });
    const b = makeSource({ registryId: "npm:@scope/pkg" });
    const sources = [makeSource(), a, b];
    const result = resolveSourcesForOrigin("npm:@scope/pkg", sources);
    expect(result).toHaveLength(2);
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
