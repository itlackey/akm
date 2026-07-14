/**
 * Meta-test over `tests/fixtures/goldens/**` (WI-01, R12 — brief §3.3 / plan
 * §15 rule 5): every golden fixture asset must have exactly one entry in
 * `tests/fixtures/goldens/DESIGNATIONS.json`, with a valid designation and
 * (for `re-baseline` assets) a `reBaselineChunk` that names a real chunk in
 * `docs/design/akm-0.9.0-chunk-manifest.json`.
 *
 * Written FIRST (test-first): at the moment this file is created, neither
 * `tests/fixtures/goldens/DESIGNATIONS.json` nor the area directories exist
 * yet, so this suite is expected to fail (ENOENT reading the registry) until
 * WI-01's implementation step lands them.
 *
 * This suite must be green against an empty-but-valid registry — the state
 * WI-01 itself lands in, before any of WI-02..WI-07 commits a fixture. All
 * assertions here are universally-quantified over `entries`/asset files, so
 * they hold vacuously when both are empty; nothing in this file requires a
 * non-empty registry to pass.
 *
 * Excluded from "needs a designation" (not golden fixture data):
 *   - `tests/fixtures/goldens/DESIGNATIONS.json` itself (the registry)
 *   - any `fixture-refs.ts` module (per-area fixture-local ref constants —
 *     brief §3.2 rule 3; a source module, not a captured golden)
 *   - `.gitkeep` placeholders (git-empty-dir markers used to commit the
 *     empty area directories minted by WI-01 step 2)
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..");
const GOLDENS_ROOT = path.join(REPO_ROOT, "tests", "fixtures", "goldens");
const DESIGNATIONS_PATH = path.join(GOLDENS_ROOT, "DESIGNATIONS.json");
const MANIFEST_PATH = path.join(REPO_ROOT, "docs", "design", "akm-0.9.0-chunk-manifest.json");

const VALID_DESIGNATIONS = new Set(["frozen-migration-input", "re-baseline"]);

interface DesignationEntry {
  path: string;
  designation: string;
  reBaselineChunk?: string;
  consumers: string[];
  notes?: string;
}

interface DesignationsFile {
  entries: DesignationEntry[];
}

interface ChunkManifest {
  chunks: { id: string }[];
}

function readJson<T>(absPath: string): T {
  return JSON.parse(fs.readFileSync(absPath, "utf8")) as T;
}

function toRepoRelativePosix(absPath: string): string {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join("/");
}

/** Recursively list every file under `dir` as absolute paths. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(abs));
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
  return out;
}

function isExcludedFromDesignation(absPath: string): boolean {
  if (absPath === DESIGNATIONS_PATH) return true;
  if (absPath.endsWith("fixture-refs.ts")) return true;
  if (path.basename(absPath) === ".gitkeep") return true;
  return false;
}

/** Every golden fixture asset that requires a DESIGNATIONS.json entry. */
function collectAssetFiles(): string[] {
  if (!fs.existsSync(GOLDENS_ROOT)) return [];
  return listFiles(GOLDENS_ROOT)
    .filter((f) => !isExcludedFromDesignation(f))
    .map(toRepoRelativePosix)
    .sort();
}

describe("golden designation registry (meta-test, R12 / brief §3.3)", () => {
  test("registry file exists and has a well-formed entries array", () => {
    const designations = readJson<DesignationsFile>(DESIGNATIONS_PATH);
    expect(Array.isArray(designations.entries)).toBe(true);
  });

  test("every golden fixture asset has exactly one DESIGNATIONS.json entry", () => {
    const designations = readJson<DesignationsFile>(DESIGNATIONS_PATH);
    const assetFiles = collectAssetFiles();

    const entryPathCounts = new Map<string, number>();
    for (const entry of designations.entries) {
      entryPathCounts.set(entry.path, (entryPathCounts.get(entry.path) ?? 0) + 1);
    }

    for (const assetFile of assetFiles) {
      expect(entryPathCounts.get(assetFile)).toBe(1);
    }
  });

  test("no entry is duplicated and no entry names a non-asset path", () => {
    const designations = readJson<DesignationsFile>(DESIGNATIONS_PATH);
    const assetFiles = new Set(collectAssetFiles());

    const entryPathCounts = new Map<string, number>();
    for (const entry of designations.entries) {
      entryPathCounts.set(entry.path, (entryPathCounts.get(entry.path) ?? 0) + 1);
    }

    for (const [entryPath, count] of entryPathCounts) {
      expect(count).toBe(1);
      expect(assetFiles.has(entryPath)).toBe(true);
    }
  });

  test("designation is a member of {frozen-migration-input, re-baseline}", () => {
    const designations = readJson<DesignationsFile>(DESIGNATIONS_PATH);
    for (const entry of designations.entries) {
      expect(VALID_DESIGNATIONS.has(entry.designation)).toBe(true);
    }
  });

  test("reBaselineChunk is present iff designation is re-baseline, and names a real manifest chunk id", () => {
    const designations = readJson<DesignationsFile>(DESIGNATIONS_PATH);
    const manifest = readJson<ChunkManifest>(MANIFEST_PATH);
    const chunkIds = new Set(manifest.chunks.map((c) => c.id));

    for (const entry of designations.entries) {
      if (entry.designation === "re-baseline") {
        expect(typeof entry.reBaselineChunk).toBe("string");
        expect(chunkIds.has(entry.reBaselineChunk as string)).toBe(true);
      } else {
        expect(entry.reBaselineChunk).toBeUndefined();
      }
    }
  });

  test("every entry's path exists on disk", () => {
    const designations = readJson<DesignationsFile>(DESIGNATIONS_PATH);
    for (const entry of designations.entries) {
      const abs = path.join(REPO_ROOT, entry.path);
      expect(fs.existsSync(abs)).toBe(true);
    }
  });

  test("every entry's consumers[] path exists on disk", () => {
    const designations = readJson<DesignationsFile>(DESIGNATIONS_PATH);
    for (const entry of designations.entries) {
      expect(Array.isArray(entry.consumers)).toBe(true);
      for (const consumer of entry.consumers) {
        const abs = path.join(REPO_ROOT, consumer);
        expect(fs.existsSync(abs)).toBe(true);
      }
    }
  });
});
