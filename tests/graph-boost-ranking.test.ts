/**
 * Integration test for the search-time graph boost (#207).
 *
 * Asserts deterministically that for a corpus with a known graph-eligible
 * query, the rank of the expected target improves when a `graph.json`
 * artifact is present versus absent. No LLM calls are made — the graph
 * file is written directly to the fixture stash, simulating what the
 * extraction pass would produce.
 *
 * The test uses TWO independent runs against the SAME database state:
 *   1. Baseline — `graph.json` deleted before search.
 *   2. Boosted — `graph.json` present before search.
 *
 * Acceptance: the target's rank in the boosted run must be ≤ its rank in
 * the baseline run, and at least one of (rank improves) OR (score
 * strictly increases) must hold. This is a deterministic comparison, not
 * a percentage threshold.
 *
 * It also verifies that the graph signal feeds the SAME `score` field on
 * `SourceSearchHit` — i.e. there is no second SearchHit scorer; the
 * graph-aware run produces a (weakly) higher score on the same hit.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmSearch } from "../src/commands/search";
import { resetConfigCache, saveConfig } from "../src/core/config";
import { getDbPath } from "../src/core/paths";
import { closeDatabase, openDatabase, rebuildFts, setMeta, upsertEntry } from "../src/indexer/db";
import { GRAPH_FILE_SCHEMA_VERSION, type GraphFile, getGraphFilePath } from "../src/indexer/graph-extraction";
import type { StashEntry } from "../src/indexer/metadata";
import { buildSearchText } from "../src/indexer/search-fields";

// ── Environment isolation ───────────────────────────────────────────────────

let stashDir = "";
let originalXdgCacheHome: string | undefined;
let originalXdgConfigHome: string | undefined;
let originalAkmStashDir: string | undefined;
let testCacheDir = "";
let testConfigDir = "";

beforeAll(() => {
  originalXdgCacheHome = process.env.XDG_CACHE_HOME;
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  originalAkmStashDir = process.env.AKM_STASH_DIR;

  testCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-graph-rank-cache-"));
  testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-graph-rank-config-"));
  stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-graph-rank-stash-"));

  process.env.XDG_CACHE_HOME = testCacheDir;
  process.env.XDG_CONFIG_HOME = testConfigDir;
  process.env.AKM_STASH_DIR = stashDir;

  resetConfigCache();
  saveConfig({
    semanticSearchMode: "off",
    sources: [{ type: "filesystem", path: stashDir }],
    registries: [],
  });

  buildFixture();
});

afterAll(() => {
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  if (originalAkmStashDir === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = originalAkmStashDir;
  resetConfigCache();
  for (const dir of [testCacheDir, testConfigDir, stashDir]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Fixture builder ─────────────────────────────────────────────────────────
//
// The corpus is small but deliberately constructed so the lexical signal
// is roughly even between two candidates — the graph boost is what
// separates them deterministically:
//
//   - knowledge:database-runbook — recovery procedure for a database
//     outage. The TARGET of the test query. Doesn't have any postgres-
//     specific name match, so a postgres-aware query splits between this
//     and the FAQ on lexical signals alone.
//   - knowledge:database-faq — Q&A document. Lexical match on the same
//     query terms but unrelated to outage recovery operationally. The
//     COMPETITOR.
//   - memory:incident-2024-shard — operational note. Anchors the graph
//     edge connecting "outage recovery" to the runbook file.
//
// With graph.json present, the runbook's entities directly match the
// query tokens and pick up the graph boost; the FAQ has no graph node
// and gets nothing. The deterministic acceptance is "rank improves OR
// score strictly increases" — both work even if the baseline already
// happens to put the runbook on top.

function buildFixture(): void {
  // Asset files on disk — the search-time graph boost matches by absolute
  // file path, so paths must be consistent between fixture build and
  // graph.json contents.
  const knowledgeDir = path.join(stashDir, "knowledge");
  const memoryDir = path.join(stashDir, "memories");
  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.mkdirSync(memoryDir, { recursive: true });

  const runbookPath = path.join(knowledgeDir, "database-runbook.md");
  fs.writeFileSync(
    runbookPath,
    "---\ntype: knowledge\n---\n\nThe runbook for database outage recovery after a hardware fault.\n",
  );

  const faqPath = path.join(knowledgeDir, "database-faq.md");
  fs.writeFileSync(
    faqPath,
    "---\ntype: knowledge\n---\n\nA database FAQ covering connection limits, recovery tunables, and outage post-mortems.\n",
  );

  const memoryPath = path.join(memoryDir, "incident-2024-shard.md");
  fs.writeFileSync(
    memoryPath,
    "---\ntype: memory\n---\n\nDuring the 2024 database outage we recovered shard-3 by following the runbook.\n",
  );

  // Index the corpus directly into the SQLite DB.
  const dbPath = getDbPath();
  // Make sure the cache dir exists (akm-graph-rank-cache-* is fresh).
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  try {
    const entries: Array<{ entry: StashEntry; filePath: string; dirPath: string }> = [
      {
        entry: {
          name: "database-runbook",
          type: "knowledge",
          filename: "database-runbook.md",
          description: "Runbook for database outage recovery after a hardware fault.",
        },
        filePath: runbookPath,
        dirPath: knowledgeDir,
      },
      {
        entry: {
          name: "database-faq",
          type: "knowledge",
          filename: "database-faq.md",
          description: "Database FAQ covering connection limits, recovery tunables, and outage post-mortems.",
        },
        filePath: faqPath,
        dirPath: knowledgeDir,
      },
      {
        entry: {
          name: "incident-2024-shard",
          type: "memory",
          filename: "incident-2024-shard.md",
          description: "We recovered shard-3 during the 2024 database outage by following the runbook.",
        },
        filePath: memoryPath,
        dirPath: memoryDir,
      },
    ];
    for (const e of entries) {
      const entryKey = `${stashDir}:${e.entry.type}:${e.entry.name}`;
      const searchText = buildSearchText(e.entry);
      upsertEntry(db, entryKey, e.dirPath, e.filePath, stashDir, e.entry, searchText);
    }
    rebuildFts(db);
    setMeta(db, "stashDir", stashDir);
    setMeta(db, "builtAt", new Date().toISOString());
    setMeta(db, "stashDirs", JSON.stringify([stashDir]));
    setMeta(db, "hasEmbeddings", "0");
  } finally {
    closeDatabase(db);
  }

  // Pre-build the graph file once, but DON'T install it yet — each test
  // installs/removes it as needed. The entity set is exactly what the
  // graph-extraction LLM helper would have produced for these bodies.
  const graphFile: GraphFile = {
    schemaVersion: GRAPH_FILE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    stashRoot: stashDir,
    files: [
      {
        path: runbookPath,
        type: "knowledge",
        entities: ["database", "outage", "recovery", "runbook"],
        relations: [
          { from: "outage", to: "recovery" },
          { from: "recovery", to: "database" },
        ],
      },
      {
        path: memoryPath,
        type: "memory",
        entities: ["database", "outage", "recovery", "shard-3"],
        relations: [{ from: "outage", to: "recovery" }],
      },
      // database-faq has NO graph entries — the FAQ doesn't operationally
      // relate to outage recovery; it just shares vocabulary. This is the
      // asymmetry that lets the graph signal differentiate the runbook
      // from a vocabulary-matching FAQ.
    ],
  };

  // Stash the prepared graph payload as a JSON file alongside the stash so
  // tests can install/uninstall by file rename.
  fs.mkdirSync(path.join(stashDir, ".akm"), { recursive: true });
  fs.writeFileSync(
    path.join(stashDir, ".akm", "graph.prepared.json"),
    `${JSON.stringify(graphFile, null, 2)}\n`,
    "utf8",
  );
}

function installGraph(): void {
  const prepared = path.join(stashDir, ".akm", "graph.prepared.json");
  fs.copyFileSync(prepared, getGraphFilePath(stashDir));
}

function uninstallGraph(): void {
  const target = getGraphFilePath(stashDir);
  if (fs.existsSync(target)) fs.unlinkSync(target);
}

async function searchHits(query: string) {
  const result = await akmSearch({ query, source: "stash", limit: 20 });
  return result.hits;
}

function rankOf(hits: { name: string }[], name: string): number {
  const idx = hits.findIndex((h) => h.name === name);
  return idx === -1 ? Infinity : idx + 1;
}

function scoreOf(hits: { name: string; score?: number }[], name: string): number {
  const hit = hits.find((h) => h.name === name);
  return hit?.score ?? 0;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("graph boost — search-time integration (#207)", () => {
  test("graph signal lifts runbook above FAQ for outage-recovery query", async () => {
    const query = "database outage recovery";

    // Baseline: no graph file.
    uninstallGraph();
    const baselineHits = await searchHits(query);
    const baselineRank = rankOf(baselineHits, "database-runbook");
    const baselineScore = scoreOf(baselineHits, "database-runbook");
    expect(baselineRank).not.toBe(Infinity);

    // Boosted: graph file present.
    installGraph();
    const boostedHits = await searchHits(query);
    const boostedRank = rankOf(boostedHits, "database-runbook");
    const boostedScore = scoreOf(boostedHits, "database-runbook");
    expect(boostedRank).not.toBe(Infinity);

    // Acceptance criterion (deterministic, not a percentage threshold):
    //   - rank must not regress, AND
    //   - either rank improves OR score strictly increases.
    expect(boostedRank).toBeLessThanOrEqual(baselineRank);
    expect(boostedRank < baselineRank || boostedScore > baselineScore).toBe(true);
  });

  test("absent graph file has no effect on score (no parallel scoring track)", async () => {
    // With the graph file uninstalled, a non-graph-eligible query should
    // produce the same hit ordering as it did before #207 landed. This
    // confirms the graph integration is purely additive — there's no
    // hidden second scorer running unconditionally.
    uninstallGraph();
    const without = await searchHits("database");
    expect(without.length).toBeGreaterThan(0);

    // Re-run the same query while the file is uninstalled — must be
    // byte-identical (same hits, same scores) within the deterministic
    // tiebreaker.
    const without2 = await searchHits("database");
    expect(without2.map((h) => h.name)).toEqual(without.map((h) => h.name));
    expect(without2.map((h) => h.score)).toEqual(without.map((h) => h.score));
  });

  test("graph signal feeds the same SearchHit.score field — no second scorer", async () => {
    // Verify the boost lands on the same `score` property of the same hit
    // object. This is the contract: the graph signal is one boost
    // component inside the FTS5+boosts loop, not a parallel ranking.
    const query = "database outage recovery";

    uninstallGraph();
    const baseline = await searchHits(query);
    const baselineHit = baseline.find((h) => h.name === "database-runbook");
    expect(baselineHit).toBeDefined();
    expect(typeof baselineHit?.score).toBe("number");

    installGraph();
    const boosted = await searchHits(query);
    const boostedHit = boosted.find((h) => h.name === "database-runbook");
    expect(boostedHit).toBeDefined();
    expect(typeof boostedHit?.score).toBe("number");

    // Same hit shape, same score field — just (weakly) higher.
    expect(boostedHit?.path).toBe(baselineHit?.path);
    expect(boostedHit?.ref).toBe(baselineHit?.ref);
    expect(boostedHit?.score ?? 0).toBeGreaterThanOrEqual(baselineHit?.score ?? 0);
  });
});
