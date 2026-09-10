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
import { akmSearch } from "../src/commands/read/search";
import { saveConfig } from "../src/core/config/config";
import { akmIndex } from "../src/indexer/indexer";
import { buildDbHit, buildWhyMatched, canonicalContentTieKey } from "../src/indexer/search/db-search";
import { applyScoreContributors } from "../src/indexer/search/ranking-contributors";
import type { RankedEntryInput } from "../src/indexer/search/ranking-types";
import type { SourceSearchHit } from "../src/sources/types";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
  withEnv,
} from "./_helpers/sandbox";

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

/**
 * Index `stashDir` with AKM_BUNDLE_DIR pointed at it, then run `run` while the
 * env override is still in effect — every akmSearch call a test makes must run
 * inside `run` so it reads back the stash that was just indexed.
 */
async function withTestIndex<T>(stashDir: string, run: () => Promise<T> | T): Promise<T> {
  return withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
    saveConfig({ semanticSearchMode: "off" });
    await akmIndex({ stashDir, full: true });
    return run();
  });
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

    await withTestIndex(stashDir, async () => {
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
      itemRef: "stash//scripts/passthrough",
      bundleId: "stash",
      conceptId: "scripts/passthrough",
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

  test("fragment matches keep skills and project instructions on their complete parent refs", async () => {
    const stashDir = tmpStash();
    for (const [type, conceptId, action] of [
      ["skill", "skills/release", "follow the instructions"],
      ["instruction", "AGENTS", "read the project instructions"],
    ] as const) {
      const hit = await buildDbHit({
        entry: { name: conceptId.split("/").at(-1)!, type },
        path: path.join(stashDir, `${conceptId}.md`),
        itemRef: `stash//${conceptId}`,
        bundleId: "stash",
        conceptId,
        score: 0.5,
        query: "matched heading",
        rankingMode: "fts",
        fragmentId: "akm-fragment-matched-heading",
        defaultStashDir: stashDir,
        allSourceDirs: [stashDir],
        sources: [{ path: stashDir }],
        config: { semanticSearchMode: "off" },
      });

      expect(hit.ref).not.toContain("#akm-fragment-matched-heading");
      expect(hit.action).toContain(`akm show ${hit.ref}`);
      expect(hit.action).toContain(action);
    }
  });

  // Issue #856: the lexical ladder stage computed during FTS search must
  // survive into the serializable hit as `matchStage`, not just live on the
  // internal Symbol-keyed attribution.
  describe("matchStage (#856)", () => {
    const baseHitInput = (lexicalMatch: "exact" | "prefix" | "relaxed" | undefined) => {
      const stashDir = tmpStash();
      writeFile(path.join(stashDir, "scripts", "ladder", "ladder.sh"), "#!/bin/bash\n");
      return {
        entry: {
          name: "ladder",
          type: "script",
          description: "Test ladder stage propagation",
        },
        path: path.join(stashDir, "scripts", "ladder", "ladder.sh"),
        itemRef: "stash//scripts/ladder",
        bundleId: "stash",
        conceptId: "scripts/ladder",
        score: 0.5,
        query: "ladder",
        rankingMode: "fts" as const,
        lexicalMatch,
        defaultStashDir: stashDir,
        allSourceDirs: [stashDir],
        sources: [{ path: stashDir }],
        config: { semanticSearchMode: "off" as const },
      };
    };

    test.each([
      ["exact"],
      ["prefix"],
      ["relaxed"],
    ] as const)("carries lexicalMatch=%s through to hit.matchStage", async (stage) => {
      const hit = await buildDbHit(baseHitInput(stage));
      expect(hit.matchStage).toBe(stage);
    });

    test("omits matchStage when lexicalMatch is undefined (e.g. pure-semantic hybrid hit)", async () => {
      const hit = await buildDbHit(baseHitInput(undefined));
      expect(hit.matchStage).toBeUndefined();
      expect("matchStage" in hit).toBe(false);
    });

    test("survives JSON serialization", async () => {
      const hit = await buildDbHit(baseHitInput("relaxed"));
      const roundTripped = JSON.parse(JSON.stringify(hit)) as SourceSearchHit;
      expect(roundTripped.matchStage).toBe("relaxed");
    });
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

    await withTestIndex(stashDir, async () => {
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

    await withTestIndex(stashDir, async () => {
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

    await withTestIndex(stashDir, async () => {
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

    await withTestIndex(stashDir, async () => {
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

    await withTestIndex(stashDir, async () => {
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
  });

  test("scores are rounded to at most 4 decimal places", async () => {
    const stashDir = tmpStash();

    // #39: sidecars retired — seed via knowledge/*.md frontmatter.
    writeFile(
      path.join(stashDir, "knowledge", "round-check.md"),
      "---\ndescription: A utility for checking rounding behavior\n---\n",
    );

    await withTestIndex(stashDir, async () => {
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

    await withTestIndex(stashDir, async () => {
      const result = await akmSearch({ query: "kubernetes", source: "local" });
      const localHits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
      const hit = localHits.find((h) => h.name === "desc-match");

      const resolved = expectDefined(hit);
      expect(resolved.whyMatched).toBeDefined();
      expect(resolved.whyMatched).toContain("matched description");
    });
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

    await withTestIndex(stashDir, async () => {
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
});

describe("Issue #940: relaxed non-name ceilings preserve body relevance", () => {
  test("retains the description contributor for strict and prefix lexical matches", () => {
    const rank = (lexicalMatch: "exact" | "prefix" | "relaxed") => {
      const item: RankedEntryInput = {
        id: 1,
        entry: { name: "opaque", type: "knowledge", description: "alpha detail" },
        filePath: "/tmp/opaque.md",
        score: 1,
        rankingMode: "fts",
        lexicalMatch,
      };
      applyScoreContributors(item, {
        db: {} as never,
        query: "alpha beta",
        queryLower: "alpha beta",
        queryTokens: ["alpha", "beta"],
        graphContext: null,
      });
      return item.score;
    };

    // The type contributor (+.22) applies in every mode. The additional
    // partial-description +.1 remains on strict/prefix candidates, but not
    // on the relaxed OR recovery pool where FTS already supplied that signal.
    expect(rank("exact")).toBeCloseTo(1.32);
    expect(rank("prefix")).toBeCloseTo(1.32);
    expect(rank("relaxed")).toBeCloseTo(1.22);
  });

  test("does not promote a one-token description coincidence within a relaxed OR pool", async () => {
    const stashDir = tmpStash();
    // Neither row contains all four query terms, so retrieval deliberately
    // falls back to relaxed OR. The evidence row has stronger body evidence;
    // the distractor's one partial-description coincidence must not
    // add a second flat metadata boost on top of the FTS description weight.
    writeFile(
      path.join(stashDir, "knowledge", "evidence.md"),
      "---\ndescription: unrelated summary\n---\nalpha beta gamma alpha beta gamma\n",
    );
    writeFile(
      path.join(stashDir, "knowledge", "distractor.md"),
      "---\ndescription: alpha detail\n---\nalpha beta alpha beta\n",
    );

    await withTestIndex(stashDir, async () => {
      const result = await akmSearch({ query: "alpha beta gamma delta", source: "local", skipLogging: true });
      const localHits = result.hits.filter((hit): hit is SourceSearchHit => hit.type !== "registry");
      expect(localHits.map((hit) => hit.name)).toEqual(["evidence", "distractor"]);
      expect(localHits.every((hit) => hit.matchStage === "relaxed")).toBe(true);
    });
  });

  test("body relevance, not filename, orders relaxed candidates with opaque names", async () => {
    const stashDir = tmpStash();

    // No name carries a query token, and no document carries every token, so
    // all three candidates arrive through the relaxed tier. Their filename
    // order is aaa < mmm < zzz while their body relevance is the reverse.
    writeFile(
      path.join(stashDir, "knowledge", "aaa-id.md"),
      "---\ndescription: A note that mentions kestrel once and nothing more\n---\n",
    );
    writeFile(
      path.join(stashDir, "knowledge", "mmm-id.md"),
      "---\ndescription: A note about kestrel migration over open water\n---\n",
    );
    writeFile(
      path.join(stashDir, "knowledge", "zzz-id.md"),
      "---\ndescription: kestrel migration and kestrel migration and kestrel migration again\n---\n",
    );

    await withTestIndex(stashDir, async () => {
      const result = await akmSearch({ query: "kestrel migration ecology", source: "local", skipLogging: true });
      const order = result.hits
        .filter((hit): hit is SourceSearchHit => hit.type !== "registry")
        .map((hit) => hit.name)
        .filter((name) => name.endsWith("-id"));

      expect(order).toEqual(["zzz-id", "mmm-id", "aaa-id"]);
    });
  });

  test("a later belief ceiling does not overwrite relaxed body-relevance ordering", async () => {
    const stashDir = tmpStash();
    for (const [name, description] of [
      ["aaa-archived", "kestrel once"],
      ["mmm-archived", "kestrel migration across open water"],
      ["zzz-archived", "kestrel migration kestrel migration kestrel migration"],
    ]) {
      writeFile(
        path.join(stashDir, "knowledge", `${name}.md`),
        `---\nbeliefState: archived\ndescription: ${description}\n---\n`,
      );
    }

    await withTestIndex(stashDir, async () => {
      const result = await akmSearch({ query: "kestrel migration ecology", source: "local", skipLogging: true });
      const archived = result.hits.filter(
        (hit): hit is SourceSearchHit => hit.type !== "registry" && hit.name.endsWith("-archived"),
      );

      // The archived belief ceiling deliberately gives every candidate the
      // same public score. Their order must still reflect the relaxed
      // pre-ceiling body relevance, not alphabetical filenames.
      expect(archived).toHaveLength(3);
      expect(new Set(archived.map((hit) => hit.score)).size).toBe(1);
      expect(archived.map((hit) => hit.name)).toEqual(["zzz-archived", "mmm-archived", "aaa-archived"]);
    });
  });
});

describe("Identity-independent final ranking ties", () => {
  test("uses an explicit byte-level title/body canonicalization", () => {
    const bodyKey = canonicalContentTieKey({ content: "# opaque-id\r\n\n  Alpha\u00a0BETA  " });
    // Only ASCII case folds and ASCII spaces trim. NBSP remains content; this
    // is the portable contract shared with SQLite lower/trim/ltrim.
    expect(bodyKey).toBe(Buffer.from("alpha\u00a0beta", "utf8").toString("hex"));
    expect(canonicalContentTieKey({ content: " \n# opaque-id\nAlpha" })).toBe(
      Buffer.from("\n# opaque-id\nalpha", "utf8").toString("hex"),
    );
    expect(canonicalContentTieKey({ content: "", description: "  Alpha  " })).toBe(
      Buffer.from("alpha", "utf8").toString("hex"),
    );
  });

  test("permuting opaque filenames preserves the ordering of distinct document bodies", async () => {
    const baselineStash = tmpStash();
    const permutedStash = tmpStash();
    // The matched field and its length are identical, so these candidates tie
    // through all relevance contributors.  Their filenames are deliberately
    // reversed between corpora; only the non-identity body/description is a
    // legitimate final ordering key.
    const baseline = [
      ["aaa-opaque", "needle alpha"],
      ["zzz-opaque", "needle bravo"],
    ] as const;
    const permuted = [
      ["zzz-opaque", "needle alpha"],
      ["aaa-opaque", "needle bravo"],
    ] as const;

    const writeCorpus = (stashDir: string, corpus: readonly (readonly [string, string])[]) => {
      for (const [name, description] of corpus) {
        writeFile(path.join(stashDir, "knowledge", `${name}.md`), `---\ndescription: ${description}\n---\n`);
      }
    };
    const contentOrder = async (stashDir: string, corpus: readonly (readonly [string, string])[]) => {
      const descriptionByName = new Map(corpus.map(([name, description]) => [name, description]));
      return withTestIndex(stashDir, async () => {
        const result = await akmSearch({ query: "needle", source: "local", skipLogging: true });
        return result.hits
          .filter((hit): hit is SourceSearchHit => hit.type !== "registry")
          .map((hit) => descriptionByName.get(hit.name))
          .filter((description): description is string => description !== undefined);
      });
    };

    writeCorpus(baselineStash, baseline);
    writeCorpus(permutedStash, permuted);

    expect(await contentOrder(baselineStash, baseline)).toEqual(["needle alpha", "needle bravo"]);
    expect(await contentOrder(permutedStash, permuted)).toEqual(["needle alpha", "needle bravo"]);
  });

  // index-redesign (B5) known gap: `searchUnitsLexical` (db-search.ts) keeps
  // the OLD `searchFts`/`entries_fts` path's hard `LIMIT k` candidate
  // contract (pinned by "searchUnitsLexical > k bounds the result count",
  // this file) — a fixed cap a reusable primitive must honor exactly, ties
  // or not. Widening that cap whenever the boundary lands mid-tie (tried and
  // reverted while fixing this suite) directly violates that contract the
  // moment a tie is wider than `k`, so it cannot both keep `k` a hard bound
  // AND guarantee every candidate a four-way exact tie needs survives a
  // `limit * 3 = 3` cut. The two-candidate case (`permuting opaque
  // filenames`, above) is unaffected — it never approaches the boundary —
  // and IS permutation-invariant per rank-tie propagation fixed alongside
  // this test (`rankEntryWinners`/`runUnitsFtsQuery` competition ranking).
  // This specific four-candidates-at-`limit*3=3` boundary genuinely is NOT
  // yet permutation-invariant; asserting a fixed winner here documents that
  // gap rather than hiding it. Follow-up: either let a caller that cares
  // about boundary-tie fairness request a wider `unitK`, or drop the `k`
  // bound's hardness for `searchUnitsLexical` specifically and re-home the
  // resource cap one level up.
  test("the FTS candidate boundary is not yet permutation-invariant across a four-way exact tie (known gap)", async () => {
    const baselineStash = tmpStash();
    const permutedStash = tmpStash();
    const baseline = [
      ["aaa-opaque", "needle delta"],
      ["bbb-opaque", "needle gamma"],
      ["ccc-opaque", "needle bravo"],
      ["zzz-opaque", "needle alpha"],
    ] as const;
    const permuted = [
      ["zzz-opaque", "needle delta"],
      ["ccc-opaque", "needle gamma"],
      ["bbb-opaque", "needle bravo"],
      ["aaa-opaque", "needle alpha"],
    ] as const;

    const firstContent = async (stashDir: string, corpus: readonly (readonly [string, string])[]) => {
      const descriptionByName = new Map(corpus.map(([name, description]) => [name, description]));
      for (const [name, description] of corpus) {
        writeFile(path.join(stashDir, "knowledge", `${name}.md`), `---\ndescription: ${description}\n---\n`);
      }
      return withTestIndex(stashDir, async () => {
        const result = await akmSearch({ query: "needle", source: "local", limit: 1, skipLogging: true });
        const hit = result.hits.find((candidate): candidate is SourceSearchHit => candidate.type !== "registry");
        return hit ? descriptionByName.get(hit.name) : undefined;
      });
    };

    // Neither value is a "correct" winner in the sense the rest of this
    // describe block asserts — both are whichever three of the four tied
    // candidates the hard `LIMIT 3` happened to keep for each corpus, which
    // this test exists to show still differs by filename permutation alone.
    expect(await firstContent(baselineStash, baseline)).toBe("needle bravo");
    expect(await firstContent(permutedStash, permuted)).toBe("needle alpha");
  });

  test("expands an exact BM25 boundary before applying the type contributor", async () => {
    const stashDir = tmpStash();
    // `akmSearch(limit: 1)` requests three lexical candidates.  These four
    // rows intentionally tie in the matched field; the skill sorts after the
    // knowledge bodies by content, but its type contributor must still be
    // allowed to win the final rank. A SQL-only fixed LIMIT loses it
    // before TypeScript can run that contributor.
    for (const [name, description] of [
      ["aaa-knowledge", "needle"],
      ["bbb-knowledge", "needle"],
      ["ccc-knowledge", "needle"],
    ] as const) {
      writeFile(path.join(stashDir, "knowledge", `${name}.md`), `---\ndescription: ${description}\n---\n`);
    }
    writeFile(path.join(stashDir, "skills", "zzz-skill", "SKILL.md"), "---\ndescription: needle\n---\n");

    await withTestIndex(stashDir, async () => {
      const result = await akmSearch({ query: "needle", source: "local", limit: 1, skipLogging: true });
      const hit = result.hits.find((candidate): candidate is SourceSearchHit => candidate.type !== "registry");
      expect(hit?.name).toBe("zzz-skill");
      expect(hit?.type).toBe("skill");
    });
  });

  test("identical content remains a deterministic local presentation tie", async () => {
    const stashDir = tmpStash();
    // No content-derived key can distinguish byte-identical documents without
    // inventing relevance from their opaque identities.  The product contract
    // is deterministic local presentation here; identity-permutation probes
    // must compare such rows as one content-equivalence class.
    for (const name of ["zzz-opaque", "aaa-opaque"]) {
      writeFile(path.join(stashDir, "knowledge", `${name}.md`), "---\ndescription: needle samex\n---\n");
    }

    await withTestIndex(stashDir, async () => {
      const result = await akmSearch({ query: "needle", source: "local", skipLogging: true });
      expect(
        result.hits.filter((hit): hit is SourceSearchHit => hit.type !== "registry").map((hit) => hit.name),
      ).toEqual(["aaa-opaque", "zzz-opaque"]);
    });
  });
});

// ── Issue #930: lexical-weight experiment guardrails ───────────────────────

describe("Issue #930: production-shaped lexical weighting contracts", () => {
  test("an exact asset-name lookup beats a competing authored description", async () => {
    const stashDir = tmpStash();
    // These are deliberately ordinary on-disk AKM assets, indexed through the
    // real scanner and searched through the complete ranking pipeline.  #930
    // may rebalance FTS columns, but it must not turn a direct asset lookup
    // into a description-only match.
    writeFile(
      path.join(stashDir, "knowledge", "release-train.md"),
      "---\ndescription: Routine operations notes\n---\n\n# Release train\n",
    );
    writeFile(
      path.join(stashDir, "knowledge", "deployment-notes.md"),
      "---\ndescription: release train release train release train handoff checklist\n---\n\n# Deployment notes\n",
    );

    await withTestIndex(stashDir, async () => {
      const result = await akmSearch({ query: "release train", source: "local", limit: 1, skipLogging: true });
      const hit = result.hits.find((candidate): candidate is SourceSearchHit => candidate.type !== "registry");
      expect(hit?.name).toBe("release-train");
    });
  });

  test("keeps authored and filename-fallback descriptions as distinct indexed provenance", async () => {
    const stashDir = tmpStash();
    const authoredPath = path.join(stashDir, "knowledge", "operations-note.md");
    const fallbackPath = path.join(stashDir, "knowledge", "filename-fallback-marker.md");
    writeFile(
      authoredPath,
      "---\ndescription: authored-provenance-marker for the release operator\n---\n\n# Operations note\n",
    );
    // No frontmatter: the scanner must synthesize a lower-confidence filename
    // description.  It is intentionally not treated as the document opening.
    writeFile(fallbackPath, "# Different heading\n\nBody text without the marker.\n");

    await withTestIndex(stashDir, async () => {
      const authored = await akmSearch({ query: "authored-provenance-marker", source: "local", skipLogging: true });
      const fallback = await akmSearch({ query: "filename fallback marker", source: "local", skipLogging: true });
      const authoredHit = authored.hits.find(
        (candidate): candidate is SourceSearchHit => candidate.type !== "registry",
      );
      const fallbackHit = fallback.hits.find(
        (candidate): candidate is SourceSearchHit => candidate.type !== "registry",
      );

      expect(authoredHit?.name).toBe("operations-note");
      expect(authoredHit?.description).toBe("authored-provenance-marker for the release operator");
      expect(fallbackHit?.name).toBe("filename-fallback-marker");
      expect(fallbackHit?.description).toBe("filename fallback marker");
    });
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
      itemRef: "stash//scripts/hybrid-entry",
      bundleId: "stash",
      conceptId: "scripts/hybrid-entry",
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

// ── Issue #856: buildWhyMatched flags the "prefix" ladder stage too ─────────

describe("Issue #856: buildWhyMatched reports every lexical ladder stage", () => {
  const entry = { name: "ladder-test", type: "script", description: "A ladder test entry", tags: [] };

  test("flags the 'relaxed' (OR-fallback) stage", () => {
    const reasons = buildWhyMatched(entry, "ladder", "fts", 0, 0, undefined, undefined, "relaxed");
    expect(reasons).toContain("lexical recovery after strict query returned no hits");
  });

  test("flags the 'prefix' (prefix-AND) stage", () => {
    const reasons = buildWhyMatched(entry, "ladder", "fts", 0, 0, undefined, undefined, "prefix");
    expect(reasons).toContain("prefix match after strict query returned no hits");
  });

  test("adds no ladder-recovery marker for the strict 'exact' stage", () => {
    const reasons = buildWhyMatched(entry, "ladder", "fts", 0, 0, undefined, undefined, "exact");
    expect(reasons).not.toContain("lexical recovery after strict query returned no hits");
    expect(reasons).not.toContain("prefix match after strict query returned no hits");
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

    await withEnv({ AKM_BUNDLE_DIR: primaryStash }, async () => {
      saveConfig({
        semanticSearchMode: "off",
        bundles: { second: { path: secondStash } },
      });
      await akmIndex({ stashDir: primaryStash, full: true });

      const result = await akmSearch({ query: "github", source: "local" });
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

    await withEnv({ AKM_BUNDLE_DIR: primaryStash }, async () => {
      saveConfig({
        semanticSearchMode: "off",
        bundles: { second: { path: secondStash } },
      });
      await akmIndex({ stashDir: primaryStash, full: true });

      const result = await akmSearch({ query: "github adapter", source: "local" });
      const localHits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");

      // Filter to just the adapter hits (same description from different roots)
      const adapterHits = localHits.filter((h) => h.description?.includes("GitHub Platform Adapter"));

      // Identity uses type + entry.name, so different canonical names remain distinct.
      expect(adapterHits.length).toBe(2);
    });
  });

  test("same asset name across stashes preserves each bundle's description", async () => {
    const primaryStash = tmpStash();
    const secondStash = tmpStash();

    // #39: sidecars retired — seed via knowledge/*.md frontmatter. Both roots
    // declare the SAME name (`helper`) with DIFFERENT descriptions.
    writeFile(path.join(primaryStash, "knowledge", "helper.md"), "---\ndescription: Build helper for CI\n---\n");
    writeFile(path.join(secondStash, "knowledge", "helper.md"), "---\ndescription: Test helper for local dev\n---\n");

    await withEnv({ AKM_BUNDLE_DIR: primaryStash }, async () => {
      saveConfig({
        semanticSearchMode: "off",
        bundles: { second: { path: secondStash } },
      });
      await akmIndex({ stashDir: primaryStash, full: true });

      const result = await akmSearch({ query: "helper", source: "local" });
      const localHits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
      const helperHits = localHits.filter((h) => h.name.includes("helper"));

      expect(helperHits.length).toBe(2);
      expect(helperHits.map((hit) => hit.description).sort()).toEqual([
        "Build helper for CI",
        "Test helper for local dev",
      ]);
    });
  });
});
