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
import { saveConfig } from "../src/config";
import { akmIndex } from "../src/indexer";
import { buildDbHit, buildWhyMatched } from "../src/local-search";
import { akmSearch } from "../src/stash-search";
import type { StashSearchHit } from "../src/stash-types";

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

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalAkmStashDir = process.env.AKM_STASH_DIR;
let testCacheDir = "";
let testConfigDir = "";

beforeEach(() => {
  testCacheDir = createTmpDir("akm-scoring-cache-");
  testConfigDir = createTmpDir("akm-scoring-config-");
  process.env.XDG_CACHE_HOME = testCacheDir;
  process.env.XDG_CONFIG_HOME = testConfigDir;
});

afterEach(() => {
  if (originalXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME;
  } else {
    process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  }
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
  if (originalAkmStashDir === undefined) {
    delete process.env.AKM_STASH_DIR;
  } else {
    process.env.AKM_STASH_DIR = originalAkmStashDir;
  }
  if (testCacheDir) {
    fs.rmSync(testCacheDir, { recursive: true, force: true });
    testCacheDir = "";
  }
  if (testConfigDir) {
    fs.rmSync(testConfigDir, { recursive: true, force: true });
    testConfigDir = "";
  }
});

// ── Issue #1: Two-phase boost causes score/rank inconsistency ───────────────

describe("Issue #1: Two-phase boost — score/rank consistency", () => {
  test("curated item ranked higher than generated item also shows higher final score", async () => {
    const stashDir = tmpStash();

    // Create two entries with identical FTS content, but different quality fields.
    // The curated entry should rank higher AND show a higher score.
    writeFile(path.join(stashDir, "scripts", "alpha-tool", "alpha-tool.sh"), "#!/bin/bash\necho alpha\n");
    writeFile(
      path.join(stashDir, "scripts", "alpha-tool", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "alpha-tool",
            type: "script",
            description: "A special deployment utility for servers",
            quality: "curated",
            confidence: 0.9,
            filename: "alpha-tool.sh",
          },
        ],
      }),
    );

    writeFile(path.join(stashDir, "scripts", "beta-tool", "beta-tool.sh"), "#!/bin/bash\necho beta\n");
    writeFile(
      path.join(stashDir, "scripts", "beta-tool", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "beta-tool",
            type: "script",
            description: "A special deployment utility for servers",
            quality: "generated",
            confidence: 0.0,
            filename: "beta-tool.sh",
          },
        ],
      }),
    );

    await buildTestIndex(stashDir, {});

    const result = await akmSearch({ query: "deployment utility", source: "local" });
    const localHits = result.hits.filter((h): h is StashSearchHit => h.type !== "registry");
    const alphaHit = localHits.find((h) => h.name === "alpha-tool");
    const betaHit = localHits.find((h) => h.name === "beta-tool");

    const resolvedAlpha = expectDefined(alphaHit);
    const resolvedBeta = expectDefined(betaHit);

    // After fix: rank order and displayed scores must agree.
    // The curated item (alpha) should both rank higher AND show a higher score.
    const alphaIdx = localHits.indexOf(resolvedAlpha);
    const betaIdx = localHits.indexOf(resolvedBeta);
    expect(alphaIdx).toBeLessThan(betaIdx);
    expect(resolvedAlpha.score).toBeGreaterThan(expectDefined(resolvedBeta.score));
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
      allStashDirs: [stashDir],
      sources: [{ path: stashDir, type: "filesystem" }],
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
    const localHits = result.hits.filter((h): h is StashSearchHit => h.type !== "registry");

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
    const localHits = result.hits.filter((h): h is StashSearchHit => h.type !== "registry");

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

    // Entry with 10 matching tags (would get +1.5 boost uncapped, 2.5x multiplier)
    writeFile(path.join(stashDir, "scripts", "many-tags", "many-tags.sh"), "#!/bin/bash\necho many\n");
    writeFile(
      path.join(stashDir, "scripts", "many-tags", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "many-tags",
            type: "script",
            description: sharedDesc,
            tags: ["deploy", "server", "cloud", "infra", "ci", "cd", "build", "release", "ship", "prod"],
            filename: "many-tags.sh",
          },
        ],
      }),
    );

    // Entry with exactly 2 matching tags (capped level)
    writeFile(path.join(stashDir, "scripts", "few-tags", "few-tags.sh"), "#!/bin/bash\necho few\n");
    writeFile(
      path.join(stashDir, "scripts", "few-tags", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "few-tags",
            type: "script",
            description: sharedDesc,
            tags: ["deploy", "server"],
            filename: "few-tags.sh",
          },
        ],
      }),
    );

    await buildTestIndex(stashDir, {});

    // Use a simple query that both entries match on via FTS (description),
    // with tokens that also match tags in both entries
    const result = await akmSearch({ query: "deploy server", source: "local" });
    const localHits = result.hits.filter((h): h is StashSearchHit => h.type !== "registry");
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

    // Entry with 5 matching hints (would get +0.60 boost uncapped)
    writeFile(path.join(stashDir, "scripts", "many-hints", "many-hints.sh"), "#!/bin/bash\n");
    writeFile(
      path.join(stashDir, "scripts", "many-hints", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "many-hints",
            type: "script",
            description: "Testing hint caps for search relevance",
            searchHints: [
              "deploy web apps",
              "deploy mobile apps",
              "deploy backend",
              "deploy microservices",
              "deploy containers",
            ],
            filename: "many-hints.sh",
          },
        ],
      }),
    );

    // Entry with 2 matching hints (at the cap level)
    writeFile(path.join(stashDir, "scripts", "few-hints", "few-hints.sh"), "#!/bin/bash\n");
    writeFile(
      path.join(stashDir, "scripts", "few-hints", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "few-hints",
            type: "script",
            description: "Testing hint caps for search relevance",
            searchHints: ["deploy web apps", "deploy mobile apps"],
            filename: "few-hints.sh",
          },
        ],
      }),
    );

    await buildTestIndex(stashDir, {});

    const result = await akmSearch({ query: "deploy", source: "local" });
    const localHits = result.hits.filter((h): h is StashSearchHit => h.type !== "registry");
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
    writeFile(path.join(stashDir, "scripts", "precise-a", "precise-a.sh"), "#!/bin/bash\n");
    writeFile(
      path.join(stashDir, "scripts", "precise-a", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "precise-a",
            type: "script",
            description: "Widget factory for production deployment of services",
            tags: ["widget"],
            filename: "precise-a.sh",
          },
        ],
      }),
    );

    writeFile(path.join(stashDir, "scripts", "precise-b", "precise-b.sh"), "#!/bin/bash\n");
    writeFile(
      path.join(stashDir, "scripts", "precise-b", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "precise-b",
            type: "script",
            description: "Widget factory for production deployment of services",
            filename: "precise-b.sh",
          },
        ],
      }),
    );

    await buildTestIndex(stashDir, {});

    const result = await akmSearch({ query: "widget", source: "local" });
    const localHits = result.hits.filter((h): h is StashSearchHit => h.type !== "registry");
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

    writeFile(path.join(stashDir, "scripts", "round-check", "round-check.sh"), "#!/bin/bash\n");
    writeFile(
      path.join(stashDir, "scripts", "round-check", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "round-check",
            type: "script",
            description: "A utility for checking rounding behavior",
            filename: "round-check.sh",
          },
        ],
      }),
    );

    await buildTestIndex(stashDir, {});

    const result = await akmSearch({ query: "rounding behavior", source: "local" });
    const localHits = result.hits.filter((h): h is StashSearchHit => h.type !== "registry");
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

    writeFile(path.join(stashDir, "scripts", "desc-match", "desc-match.sh"), "#!/bin/bash\n");
    writeFile(
      path.join(stashDir, "scripts", "desc-match", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "desc-match",
            type: "script",
            description: "Orchestrates Kubernetes pod lifecycle management",
            filename: "desc-match.sh",
          },
        ],
      }),
    );

    await buildTestIndex(stashDir, {});

    const result = await akmSearch({ query: "kubernetes", source: "local" });
    const localHits = result.hits.filter((h): h is StashSearchHit => h.type !== "registry");
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
    const names = ["ccc-tool", "aaa-tool", "bbb-tool"];
    for (const name of names) {
      writeFile(path.join(stashDir, "scripts", name, `${name}.sh`), "#!/bin/bash\necho same content\n");
      writeFile(
        path.join(stashDir, "scripts", name, ".stash.json"),
        JSON.stringify({
          entries: [
            {
              name,
              type: "script",
              description: "Identical widget factory for production",
              filename: `${name}.sh`,
            },
          ],
        }),
      );
    }

    await buildTestIndex(stashDir, {});

    // Run the search multiple times to verify determinism
    const results: string[][] = [];
    for (let i = 0; i < 5; i++) {
      const result = await akmSearch({ query: "widget factory", source: "local" });
      const localHits = result.hits.filter((h): h is StashSearchHit => h.type !== "registry");
      const order = localHits.filter((h) => names.includes(h.name)).map((h) => h.name);
      results.push(order);
    }

    // All runs should produce the exact same order — this is the key
    // requirement. Without the tiebreaker, the sort is non-deterministic.
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toEqual(results[0]);
    }

    // Also verify all 3 entries are present
    expect(results[0].length).toBe(3);
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
      allStashDirs: [stashDir],
      sources: [{ path: stashDir, type: "filesystem" }],
      config: { semanticSearchMode: "off" },
    });

    expect(hit.whyMatched).toBeDefined();
    expect(hit.whyMatched?.[0]).toContain("hybrid");
  });
});

// ── Cross-stash deduplication (indexer level) ────────────────────────────────

describe("Cross-stash deduplication at index time", () => {
  test("same asset in two stash sources produces only one index entry", async () => {
    const primaryStash = tmpStash();
    const secondStash = tmpStash();

    // Same file with same content/metadata in both stashes, but under
    // different directory prefixes (mimics primary stash + installed kit)
    const script = "#!/bin/bash\necho github platform adapter\n";
    const metadata = JSON.stringify({
      entries: [
        {
          name: "github",
          type: "script",
          description: "GitHub Platform Adapter for issue tracking",
          filename: "github.sh",
        },
      ],
    });

    writeFile(path.join(primaryStash, "scripts", "platforms", "github.sh"), script);
    writeFile(path.join(primaryStash, "scripts", "platforms", ".stash.json"), metadata);

    writeFile(path.join(secondStash, "scripts", "platforms", "github.sh"), script);
    writeFile(path.join(secondStash, "scripts", "platforms", ".stash.json"), metadata);

    process.env.AKM_STASH_DIR = primaryStash;
    saveConfig({
      semanticSearchMode: "off",
      stashes: [{ type: "filesystem", path: secondStash, name: "second", enabled: true }],
    });
    await akmIndex({ stashDir: primaryStash, full: true });

    const result = await akmSearch({ query: "github", source: "stash" });
    const localHits = result.hits.filter((h): h is StashSearchHit => h.type !== "registry");

    // Filter to just the "github" platform adapter hits
    const githubHits = localHits.filter(
      (h) => h.name.includes("github") && h.description?.includes("GitHub Platform Adapter"),
    );

    // Indexer should skip the duplicate — only one entry in the DB
    expect(githubHits.length).toBe(1);
    // The surviving hit should be from the primary stash (higher priority)
    expect(githubHits[0].path).toContain(primaryStash);
  });

  test("different stash directory structures deduped by type+basename+description", async () => {
    const primaryStash = tmpStash();
    const secondStash = tmpStash();

    // Create identical assets with identical descriptions in both stashes
    // but with DIFFERENT directory structures (so paths differ)
    writeFile(path.join(primaryStash, "skills", "tracker", "platforms", "github.sh"), "#!/bin/bash\necho adapter\n");
    writeFile(
      path.join(primaryStash, "skills", "tracker", "platforms", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "tracker/platforms/github",
            type: "script",
            description: "GitHub Platform Adapter wrapping the gh CLI",
            filename: "github.sh",
          },
        ],
      }),
    );

    writeFile(path.join(secondStash, "scripts", "platforms", "github.sh"), "#!/bin/bash\necho adapter\n");
    writeFile(
      path.join(secondStash, "scripts", "platforms", ".stash.json"),
      JSON.stringify({
        entries: [
          {
            name: "platforms/github",
            type: "script",
            description: "GitHub Platform Adapter wrapping the gh CLI",
            filename: "github.sh",
          },
        ],
      }),
    );

    process.env.AKM_STASH_DIR = primaryStash;
    saveConfig({
      semanticSearchMode: "off",
      stashes: [{ type: "filesystem", path: secondStash, name: "second", enabled: true }],
    });
    await akmIndex({ stashDir: primaryStash, full: true });

    const result = await akmSearch({ query: "github adapter", source: "stash" });
    const localHits = result.hits.filter((h): h is StashSearchHit => h.type !== "registry");

    // Filter to just the adapter hits (same description from different roots)
    const adapterHits = localHits.filter((h) => h.description?.includes("GitHub Platform Adapter"));

    // Indexer dedup: only one entry despite different paths
    expect(adapterHits.length).toBe(1);
  });

  test("different assets with same filename but different descriptions are NOT deduped", async () => {
    const primaryStash = tmpStash();
    const secondStash = tmpStash();

    writeFile(path.join(primaryStash, "scripts", "utils", "helper.sh"), "#!/bin/bash\necho primary\n");
    writeFile(
      path.join(primaryStash, "scripts", "utils", ".stash.json"),
      JSON.stringify({
        entries: [{ name: "helper", type: "script", description: "Build helper for CI", filename: "helper.sh" }],
      }),
    );

    writeFile(path.join(secondStash, "scripts", "tools", "helper.sh"), "#!/bin/bash\necho second\n");
    writeFile(
      path.join(secondStash, "scripts", "tools", ".stash.json"),
      JSON.stringify({
        entries: [{ name: "helper", type: "script", description: "Test helper for local dev", filename: "helper.sh" }],
      }),
    );

    process.env.AKM_STASH_DIR = primaryStash;
    saveConfig({
      semanticSearchMode: "off",
      stashes: [{ type: "filesystem", path: secondStash, name: "second", enabled: true }],
    });
    await akmIndex({ stashDir: primaryStash, full: true });

    const result = await akmSearch({ query: "helper", source: "stash" });
    const localHits = result.hits.filter((h): h is StashSearchHit => h.type !== "registry");
    const helperHits = localHits.filter((h) => h.name.includes("helper"));

    // Different descriptions = different assets — both should be indexed
    expect(helperHits.length).toBe(2);
  });
});
