/**
 * Tests for search scoring pipeline fixes (Issues #1, #3, #4, #7, #8, #12, #14, #15).
 *
 * Each describe block targets a specific issue and follows TDD:
 * write the failing test first, then verify it passes after the fix.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmSearch } from "../../src/commands/read/search";
import { saveConfig } from "../../src/core/config/config";
import { akmIndex } from "../../src/indexer/indexer";
import { buildDbHit, buildWhyMatched } from "../../src/indexer/search/db-search";
import type { SourceSearchHit } from "../../src/sources/types";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
} from "../_helpers/sandbox";

// ── Temp directory tracking ─────────────────────────────────────────────────

const createdTmpDirs: string[] = [];

function createTmpDir(prefix = "akm-scoring-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function writeFile(filePath: string, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function tmpStash(): string {
  const dir = createTmpDir("akm-scoring-stash-");
  for (const sub of ["skills", "commands", "agents", "knowledge", "scripts"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

async function buildTestIndex(stashDir: string, files: Record<string, string> = {}) {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(stashDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  process.env.AKM_STASH_DIR = stashDir;
  saveConfig({ semanticSearchMode: "off" });
  await akmIndex({ stashDir, full: true });
}

function expectDefined<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  if (value === undefined || value === null) {
    throw new Error("Expected value to be defined");
  }
  return value;
}

// ── Environment isolation ───────────────────────────────────────────────────

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  // Sandbox XDG_DATA_HOME so the index DB (getDbPath() →
  // $XDG_DATA_HOME/akm/index.db) is isolated per-test. Without this, under
  // `bun test --parallel` (which runs test files concurrently in the SAME
  // process, sharing process.env), another file mutating process.env.XDG_DATA_HOME
  // between this test's akmIndex() and akmSearch() calls would make the search
  // read a different (empty/wrong) DB than the one just indexed.
  const dataResult = sandboxXdgDataHome(cfgResult.cleanup);
  const stashResult = sandboxStashDir(dataResult.cleanup);
  envCleanup = stashResult.cleanup;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
});

// ── Issue #1: Two-phase boost causes score/rank inconsistency ───────────────

describe("Issue #1: Two-phase boost — score/rank consistency", () => {
  test("curated item ranked higher than generated item also shows higher final score", async () => {
    const stashDir = tmpStash();

    // Create two entries with identical FTS content, but different quality fields.
    // The curated entry should rank higher AND show a higher score.
    // #39: sidecars retired — seed via knowledge/*.md frontmatter. Knowledge, like
    // script, gets no type boost, so the quality-boost mechanics under test are
    // preserved; only the seeding shape (script+sidecar → knowledge frontmatter) changed.
    writeFile(
      path.join(stashDir, "knowledge", "alpha-tool.md"),
      "---\ndescription: A special deployment utility for servers\nquality: curated\n---\n",
    );
    writeFile(
      path.join(stashDir, "knowledge", "beta-tool.md"),
      "---\ndescription: A special deployment utility for servers\nquality: generated\n---\n",
    );

    await buildTestIndex(stashDir, {});

    const result = await akmSearch({ query: "deployment utility", source: "local" });
    const localHits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    const alphaHit = localHits.find((h) => h.name === "alpha-tool");
    const betaHit = localHits.find((h) => h.name === "beta-tool");

    const resolvedAlpha = expectDefined(alphaHit);
    const resolvedBeta = expectDefined(betaHit);

    // After fix: rank order and displayed scores must agree.
    // The curated item (alpha) should rank higher than the generated item.
    // Per CLAUDE.md / spec §9 displayed scores are clamped to [0,1]; on a
    // strong-match query both items may clamp to the ceiling, so the
    // observable score relation is "alpha >= beta" while rank ordering
    // strictly separates them.
    const alphaIdx = localHits.indexOf(resolvedAlpha);
    const betaIdx = localHits.indexOf(resolvedBeta);
    expect(alphaIdx).toBeLessThan(betaIdx);
    expect(resolvedAlpha.score ?? 0).toBeGreaterThanOrEqual(expectDefined(resolvedBeta.score));
  });

  test("buildDbHit does not apply quality/confidence boost a second time", async () => {
    // Directly call buildDbHit with a known score — the score should pass through
    // without further quality/confidence multiplication.
    const stashDir = tmpStash();
    writeFile(path.join(stashDir, "scripts", "passthrough", "passthrough.sh"), "#!/bin/bash\n");
    writeFile(
      path.join(stashDir, "scripts", "passthrough", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "passthrough",
            type: "script",
            description: "Test passthrough",
            quality: "curated",
            confidence: 1.0,
            filename: "passthrough.sh",
          },
        ],
      }),
    );

    const hit = await buildDbHit({
      entry: {
        name: "passthrough",
        type: "script",
        description: "Test passthrough",
        quality: "curated",
        confidence: 1.0,
      },
      path: path.join(stashDir, "scripts", "passthrough", "passthrough.sh"),
      score: 0.0234,
      query: "test",
      rankingMode: "fts",
      defaultStashDir: stashDir,
      allSourceDirs: [stashDir],
      sources: [{ path: stashDir }],
      config: { semanticSearchMode: "off" },
    });

    // After fix: buildDbHit should NOT multiply by quality/confidence.
    // The score should be rounded to 4 decimals from the input score directly.
    expect(hit.score).toBe(0.0234);
  });
});

// ── Issue #3: NaN from vec distance corrupts sort ───────────────────────────

describe("Issue #3: NaN guard on vector distance", () => {
  test("search with indexed entries does not produce NaN scores", async () => {
    // This integration test verifies the general pipeline does not produce NaN.
    // The actual NaN guard is in tryVecScores which is called only when
    // semanticSearchMode is enabled. We test the code path indirectly.
    const stashDir = tmpStash();

    writeFile(path.join(stashDir, "scripts", "vec-safe", "vec-safe.sh"), "#!/bin/bash\necho safe\n");
    writeFile(
      path.join(stashDir, "scripts", "vec-safe", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "vec-safe",
            type: "script",
            description: "A tool for testing NaN safety",
            filename: "vec-safe.sh",
          },
        ],
      }),
    );

    await buildTestIndex(stashDir, {});

    const result = await akmSearch({ query: "testing NaN safety", source: "local" });
    const localHits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");

    for (const hit of localHits) {
      if (hit.score !== undefined) {
        expect(Number.isFinite(hit.score)).toBe(true);
        expect(Number.isNaN(hit.score)).toBe(false);
      }
    }
  });
});

// ── Issue #4: deduplicateByPath precondition ────────────────────────────────

describe("Issue #4: deduplicateByPath enforces sort precondition", () => {
  test("deduplication keeps highest-scored entry when entries share same path", async () => {
    const stashDir = tmpStash();

    // Create two entries that map to the same file path.
    // The one with more boost signals should win.
    const scriptPath = path.join(stashDir, "scripts", "shared-path", "shared.sh");
    writeFile(scriptPath, "#!/bin/bash\necho shared\n");
    writeFile(
      path.join(stashDir, "scripts", "shared-path", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "shared-deploy",
            type: "script",
            description: "Deploy shared infrastructure components",
            tags: ["deploy", "infra"],
            searchHints: ["deploy infrastructure"],
            filename: "shared.sh",
          },
          {
            name: "shared-minimal",
            type: "script",
            description: "Shared infrastructure setup",
            filename: "shared.sh",
          },
        ],
      }),
    );

    await buildTestIndex(stashDir, {});

    const result = await akmSearch({ query: "deploy infra", source: "local" });
    const localHits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");

    // Only one hit per file path should appear
    const pathCounts = new Map<string, number>();
    for (const hit of localHits) {
      pathCounts.set(hit.path, (pathCounts.get(hit.path) ?? 0) + 1);
    }
    for (const [, count] of pathCounts) {
      expect(count).toBe(1);
    }
  });
});

// ── Issue #7: Unbounded boost accumulation ──────────────────────────────────

describe("Issue #7: Boost accumulation caps", () => {
  test("entry with many matching tags does not get unbounded boost", async () => {
    const stashDir = tmpStash();

    // Both entries share the same description so FTS scores are identical.
    // Only the tag boost differs: 10 matching tags vs 2 matching tags.
    const sharedDesc = "Infrastructure automation toolkit for cloud deployments";

    // #39: sidecars retired — seed via knowledge/*.md frontmatter (no type boost,
    // so the tag-boost cap mechanics under test are preserved).
    // Entry with 10 matching tags (would get +1.5 boost uncapped, 2.5x multiplier)
    writeFile(
      path.join(stashDir, "knowledge", "many-tags.md"),
      `---\ndescription: ${sharedDesc}\ntags:\n  - deploy\n  - server\n  - cloud\n  - infra\n  - ci\n  - cd\n  - build\n  - release\n  - ship\n  - prod\n---\n`,
    );

    // Entry with exactly 2 matching tags (capped level)
    writeFile(
      path.join(stashDir, "knowledge", "few-tags.md"),
      `---\ndescription: ${sharedDesc}\ntags:\n  - deploy\n  - server\n---\n`,
    );

    await buildTestIndex(stashDir, {});

    // Use a simple query that both entries match on via FTS (description),
    // with tokens that also match tags in both entries
    const result = await akmSearch({ query: "deploy server", source: "local" });
    const localHits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    const manyTagsHit = localHits.find((h) => h.name === "many-tags");
    const fewTagsHit = localHits.find((h) => h.name === "few-tags");

    const resolvedMany = expectDefined(manyTagsHit);
    const resolvedFew = expectDefined(fewTagsHit);

    // With tag cap at 0.30, both entries cap at the same tag boost (2 tags
    // match "deploy" and "server" in both). The many-tags entry should NOT
    // have a dramatically higher score. The ratio should be bounded.
    const ratio = expectDefined(resolvedMany.score) / expectDefined(resolvedFew.score);
    expect(ratio).toBeLessThan(2.0);
  });

  test("entry with many matching searchHints has capped boost", async () => {
    const stashDir = tmpStash();

    // #39: sidecars retired — seed via knowledge/*.md frontmatter (no type boost,
    // so the searchHints-boost cap mechanics under test are preserved).
    // Entry with 5 matching hints (would get +0.60 boost uncapped)
    writeFile(
      path.join(stashDir, "knowledge", "many-hints.md"),
      "---\ndescription: Testing hint caps for search relevance\nsearchHints:\n  - deploy web apps\n  - deploy mobile apps\n  - deploy backend\n  - deploy microservices\n  - deploy containers\n---\n",
    );

    // Entry with 2 matching hints (at the cap level)
    writeFile(
      path.join(stashDir, "knowledge", "few-hints.md"),
      "---\ndescription: Testing hint caps for search relevance\nsearchHints:\n  - deploy web apps\n  - deploy mobile apps\n---\n",
    );

    await buildTestIndex(stashDir, {});

    const result = await akmSearch({ query: "deploy", source: "local" });
    const localHits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    const manyHintsHit = localHits.find((h) => h.name === "many-hints");
    const fewHintsHit = localHits.find((h) => h.name === "few-hints");

    const resolvedMany = expectDefined(manyHintsHit);
    const resolvedFew = expectDefined(fewHintsHit);

    // The hint cap (0.24) limits hint boost accumulation, but base FTS scores
    // may differ because entries with more hint content have more searchable text.
    // The key invariant: both hits should be found and the ratio should be bounded.
    const ratio = expectDefined(resolvedMany.score) / expectDefined(resolvedFew.score);
    expect(ratio).toBeLessThan(3.5); // Reasonable bound; exact ratio depends on FTS normalization
  });
});

// ── Issue #8: Score rounding destroys differentiation ───────────────────────

describe("Issue #8: Score rounding precision", () => {
  test("scores differentiate entries that would collapse at 2 decimal places", async () => {
    const stashDir = tmpStash();

    // Create two entries with slightly different relevance signals.
    // At 2-decimal rounding, both would be 0.02; at 4-decimal, they should differ.
    // #39: sidecars retired — seed via knowledge/*.md frontmatter (no type boost, so
    // the tag-boost differentiation under test is preserved). precise-a carries the
    // matching `widget` tag; precise-b does not.
    writeFile(
      path.join(stashDir, "knowledge", "precise-a.md"),
      "---\ndescription: Widget factory for production deployment of services\ntags:\n  - widget\n---\n",
    );

    writeFile(
      path.join(stashDir, "knowledge", "precise-b.md"),
      "---\ndescription: Widget factory for production deployment of services\n---\n",
    );

    await buildTestIndex(stashDir, {});

    const result = await akmSearch({ query: "widget", source: "local" });
    const localHits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    const hitA = localHits.find((h) => h.name === "precise-a");
    const hitB = localHits.find((h) => h.name === "precise-b");

    const resolvedA = expectDefined(hitA);
    const resolvedB = expectDefined(hitB);

    // With 4-decimal rounding, these should have different scores
    // because precise-a has a tag match boost and precise-b does not.
    expect(resolvedA.score).toBeGreaterThan(expectDefined(resolvedB.score));
    expect(resolvedA.score).not.toBe(resolvedB.score);
  });

  test("scores are rounded to at most 4 decimal places", async () => {
    const stashDir = tmpStash();

    // #39: sidecars retired — seed via knowledge/*.md frontmatter.
    writeFile(
      path.join(stashDir, "knowledge", "round-check.md"),
      "---\ndescription: A utility for checking rounding behavior\n---\n",
    );

    await buildTestIndex(stashDir, {});

    const result = await akmSearch({ query: "rounding behavior", source: "local" });
    const localHits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    const hit = localHits.find((h) => h.name === "round-check");
    const resolved = expectDefined(hit);

    // Verify score has at most 4 decimal places
    const scoreStr = String(resolved.score);
    const decimalPart = scoreStr.split(".")[1] ?? "";
    expect(decimalPart.length).toBeLessThanOrEqual(4);
  });
});

// ── Issue #12: buildWhyMatched omits description matches ────────────────────

describe("Issue #12: buildWhyMatched includes description matches", () => {
  test("whyMatched includes 'matched description' when query matches description", async () => {
    const stashDir = tmpStash();

    // #39: sidecars retired — seed via knowledge/*.md frontmatter.
    writeFile(
      path.join(stashDir, "knowledge", "desc-match.md"),
      "---\ndescription: Orchestrates Kubernetes pod lifecycle management\n---\n",
    );

    await buildTestIndex(stashDir, {});

    const result = await akmSearch({ query: "kubernetes", source: "local" });
    const localHits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    const hit = localHits.find((h) => h.name === "desc-match");

    const resolved = expectDefined(hit);
    expect(resolved.whyMatched).toBeDefined();
    expect(resolved.whyMatched).toContain("matched description");
  });

  test("buildWhyMatched unit test: description match is reported", () => {
    const reasons = buildWhyMatched(
      {
        name: "some-tool",
        type: "script",
        description: "Manages infrastructure provisioning",
        tags: [],
      },
      "infrastructure",
      "fts",
      0,
      0,
    );

    expect(reasons).toContain("matched description");
  });

  test("buildWhyMatched unit test: no false positive when description does not match", () => {
    const reasons = buildWhyMatched(
      {
        name: "other-tool",
        type: "script",
        description: "Formats source code",
        tags: [],
      },
      "kubernetes",
      "fts",
      0,
      0,
    );

    expect(reasons).not.toContain("matched description");
  });
});

// ── Issue #14: Unstable sort on tied DB scores ──────────────────────────────

describe("Issue #14: Deterministic sort on tied scores", () => {
  test("entries with equal FTS scores are sorted deterministically by name", async () => {
    const stashDir = tmpStash();

    // Create entries with identical content so they get the same FTS score.
    // Names chosen so alphabetical order is clear: aaa < bbb < ccc
    // #39: sidecars retired — seed via knowledge/*.md frontmatter. All three carry
    // an identical description so they tie on FTS score; the tiebreaker-by-name
    // determinism under test is preserved (knowledge, like script, gets no type boost).
    const names = ["ccc-tool", "aaa-tool", "bbb-tool"];
    for (const name of names) {
      writeFile(
        path.join(stashDir, "knowledge", `${name}.md`),
        "---\ndescription: Identical widget factory for production\n---\n",
      );
    }

    await buildTestIndex(stashDir, {});

    // Run the search multiple times to verify determinism
    const results: string[][] = [];
    for (let i = 0; i < 5; i++) {
      const result = await akmSearch({ query: "widget factory", source: "local", skipLogging: true });
      const localHits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
      const order = localHits.filter((h) => names.includes(h.name)).map((h) => h.name);
      results.push(order);
    }

    // All runs should produce the exact same order — this is the key
    // requirement. Without the tiebreaker, the sort is non-deterministic.
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toEqual(results[0]);
    }

    // Also verify all 3 entries are present
    expect(results[0]!.length).toBe(3);
  });
});

// ── Issue #15: "semantic" label for hybrid results ──────────────────────────

describe("Issue #15: Hybrid ranking mode label", () => {
  test("buildWhyMatched handles 'hybrid' ranking mode", () => {
    const reasons = buildWhyMatched(
      {
        name: "hybrid-test",
        type: "script",
        description: "A hybrid test entry",
        tags: [],
      },
      "hybrid",
      "hybrid",
      0,
      0,
    );

    expect(reasons[0]).toContain("hybrid");
    expect(reasons[0]).toContain("fts");
    expect(reasons[0]).toContain("semantic");
  });

  test("buildWhyMatched still handles 'fts' ranking mode", () => {
    const reasons = buildWhyMatched(
      {
        name: "fts-test",
        type: "script",
        description: "An fts test entry",
        tags: [],
      },
      "fts",
      "fts",
      0,
      0,
    );

    expect(reasons[0]).toContain("fts");
    expect(reasons[0]).toContain("bm25");
  });

  test("buildWhyMatched still handles 'semantic' ranking mode for vec-only results", () => {
    const reasons = buildWhyMatched(
      {
        name: "semantic-test",
        type: "script",
        description: "A semantic test entry",
        tags: [],
      },
      "semantic",
      "semantic",
      0,
      0,
    );

    expect(reasons[0]).toContain("semantic");
  });

  test("buildDbHit accepts 'hybrid' ranking mode", async () => {
    const stashDir = tmpStash();
    writeFile(path.join(stashDir, "scripts", "hybrid-entry", "hybrid-entry.sh"), "#!/bin/bash\n");

    const hit = await buildDbHit({
      entry: {
        name: "hybrid-entry",
        type: "script",
        description: "A hybrid test",
      },
      path: path.join(stashDir, "scripts", "hybrid-entry", "hybrid-entry.sh"),
      score: 0.025,
      query: "hybrid",
      rankingMode: "hybrid",
      defaultStashDir: stashDir,
      allSourceDirs: [stashDir],
      sources: [{ path: stashDir }],
      config: { semanticSearchMode: "off" },
    });

    expect(hit.whyMatched).toBeDefined();
    expect(hit.whyMatched?.[0]).toContain("hybrid");
  });
});

// ── Cross-stash identity (indexer level) ─────────────────────────────────────

describe("Cross-stash identity at index time", () => {
  test("same asset in two stash sources remains addressable in both bundles", async () => {
    const primaryStash = tmpStash();
    const secondStash = tmpStash();

    // Same asset name + metadata in both stashes (mimics primary stash + installed
    // stash). #39: sidecars retired — seed via knowledge/*.md frontmatter.
    const asset = "---\ndescription: GitHub Platform Adapter for issue tracking\n---\n";

    writeFile(path.join(primaryStash, "knowledge", "github.md"), asset);
    writeFile(path.join(secondStash, "knowledge", "github.md"), asset);

    process.env.AKM_STASH_DIR = primaryStash;
    saveConfig({
      semanticSearchMode: "off",
      bundles: { second: { path: secondStash } },
    });
    await akmIndex({ stashDir: primaryStash, full: true });

    const result = await akmSearch({ query: "github", source: "stash" });
    const localHits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");

    // Filter to just the "github" platform adapter hits
    const githubHits = localHits.filter(
      (h) => h.name.includes("github") && h.description?.includes("GitHub Platform Adapter"),
    );

    expect(githubHits.length).toBe(2);
    expect(githubHits.map((hit) => hit.path).sort()).toEqual(
      [path.join(primaryStash, "knowledge", "github.md"), path.join(secondStash, "knowledge", "github.md")].sort(),
    );
  });

  test("different stash directory structures are not deduped when entry names differ", async () => {
    const primaryStash = tmpStash();
    const secondStash = tmpStash();

    // Create identical descriptions in both stashes but with DIFFERENT canonical
    // names (nested subpaths), so type + name identity keeps them distinct.
    // #39: sidecars retired — seed via knowledge/*.md frontmatter; the nested ref
    // subpath IS the canonical name (knowledge/<subpath>.md → name "<subpath>").
    const adapterFm = "---\ndescription: GitHub Platform Adapter wrapping the gh CLI\n---\n";
    writeFile(path.join(primaryStash, "knowledge", "tracker", "platforms", "github.md"), adapterFm);
    writeFile(path.join(secondStash, "knowledge", "platforms", "github.md"), adapterFm);

    process.env.AKM_STASH_DIR = primaryStash;
    saveConfig({
      semanticSearchMode: "off",
      bundles: { second: { path: secondStash } },
    });
    await akmIndex({ stashDir: primaryStash, full: true });

    const result = await akmSearch({ query: "github adapter", source: "stash" });
    const localHits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");

    // Filter to just the adapter hits (same description from different roots)
    const adapterHits = localHits.filter((h) => h.description?.includes("GitHub Platform Adapter"));

    // Identity uses type + entry.name, so different canonical names remain distinct.
    expect(adapterHits.length).toBe(2);
  });

  test("same asset name across stashes preserves each bundle's description", async () => {
    const primaryStash = tmpStash();
    const secondStash = tmpStash();

    // #39: sidecars retired — seed via knowledge/*.md frontmatter. Both roots
    // declare the SAME name (`helper`) with DIFFERENT descriptions.
    writeFile(path.join(primaryStash, "knowledge", "helper.md"), "---\ndescription: Build helper for CI\n---\n");
    writeFile(path.join(secondStash, "knowledge", "helper.md"), "---\ndescription: Test helper for local dev\n---\n");

    process.env.AKM_STASH_DIR = primaryStash;
    saveConfig({
      semanticSearchMode: "off",
      bundles: { second: { path: secondStash } },
    });
    await akmIndex({ stashDir: primaryStash, full: true });

    const result = await akmSearch({ query: "helper", source: "stash" });
    const localHits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    const helperHits = localHits.filter((h) => h.name.includes("helper"));

    expect(helperHits.length).toBe(2);
    expect(helperHits.map((hit) => hit.description).sort()).toEqual([
      "Build helper for CI",
      "Test helper for local dev",
    ]);
  });
});
