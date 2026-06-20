// SPDX-License-Identifier: MPL-2.0
//
// #624 P2 (RED): TDD failing tests for utility-ranked, top-N-capped graph
// extraction. The feature does not exist yet — these tests assert the target
// behavior of the new `rankCandidatesByUtility` helper and the `topN` option
// on GraphExtractionPassOptions. They MUST fail now (helper unexported / option
// untyped) for the RIGHT reason: the feature is absent.
//
// DEFAULT-PRESERVING invariant (#624 mandate): with topN unset, ranking is
// never invoked and the eligible set is byte-identical to today.
//
// Unit test (no real LLM/spawn/serve, no 60s timeout) → lives in tests/, not
// tests/integration/. Uses sandbox helpers; never touches host state. Run this
// file individually before any full-suite gate.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { closeDatabase, openDatabase, upsertEntry } from "../src/indexer/db/db";
import * as graphExtraction from "../src/indexer/graph/graph-extraction";
import { collectEligibleFiles } from "../src/indexer/graph/graph-extraction";

type Candidate = { absPath: string; type: string; body: string };

// The new helper under test — exported from graph-extraction.ts once P2 lands.
// Accessed via the namespace so this test file LOADS even while the named
// export is absent (Bun ESM aborts the whole file on a missing named import);
// each test then fails individually on the absent feature, which is the RIGHT
// RED reason. After P2 the cast resolves to the real function.
const rankCandidatesByUtility = (
  graphExtraction as unknown as {
    rankCandidatesByUtility: (db: Database, candidates: Candidate[], stashRoot: string) => Candidate[];
  }
).rankCandidatesByUtility;

import type { Database } from "../src/storage/database";
import { makeStashDir, type SandboxedDir } from "./_helpers/sandbox";

// ── Local sandbox plumbing ───────────────────────────────────────────────────

let stash: SandboxedDir;
let dbPath: string;
let db: Database;

beforeEach(() => {
  stash = makeStashDir();
  dbPath = path.join(stash.dir, "index.db");
  db = openDatabase(dbPath);
});

afterEach(() => {
  try {
    closeDatabase(db);
  } catch {
    /* already closed */
  }
  stash.cleanup();
});

/**
 * Seed one `entries` row whose `file_path` matches a candidate absPath, plus an
 * optional `utility_scores` row. Returns the entry id.
 */
function seedEntryWithUtility(absPath: string, utility: number | null): number {
  const name = path.basename(absPath, path.extname(absPath));
  const dirPath = path.dirname(absPath);
  const entry = { name, type: "memory", filename: path.basename(absPath) } as Parameters<typeof upsertEntry>[5];
  const id = upsertEntry(db, `${stash.dir}:memory:${name}`, dirPath, absPath, stash.dir, entry, name);
  if (utility != null) {
    db.prepare(
      `INSERT INTO utility_scores (entry_id, utility) VALUES (?, ?)
         ON CONFLICT(entry_id) DO UPDATE SET utility = excluded.utility`,
    ).run(id, utility);
  }
  return id;
}

/**
 * Create a real eligible markdown file under <stash>/memories so it is also
 * returned by collectEligibleFiles, and seed its entry/utility. Returns absPath.
 */
function makeEligibleMemory(slug: string, utility: number | null, body = "Some graph-worthy body text."): string {
  const memDir = path.join(stash.dir, "memories");
  fs.mkdirSync(memDir, { recursive: true });
  const absPath = path.join(memDir, `${slug}.md`);
  fs.writeFileSync(absPath, `---\ntype: memory\n---\n${body}\n`);
  seedEntryWithUtility(absPath, utility);
  return absPath;
}

function candidatesFor(absPaths: string[]): Candidate[] {
  return absPaths.map((absPath) => ({ absPath, type: "memory", body: "body" }));
}

// ── AC1: ranked DESC + capped ────────────────────────────────────────────────

describe("#624 P2 rankCandidatesByUtility — ranking", () => {
  test("AC1: returns candidates sorted by utility DESC", () => {
    const low = makeEligibleMemory("low", 1);
    const high = makeEligibleMemory("high", 100);
    const mid = makeEligibleMemory("mid", 50);

    const ranked = rankCandidatesByUtility(db, candidatesFor([low, high, mid]), stash.dir);
    expect(ranked.map((c) => c.absPath)).toEqual([high, mid, low]);
  });

  test("AC1: does not mutate the input array", () => {
    const a = makeEligibleMemory("a", 1);
    const b = makeEligibleMemory("b", 9);
    const input = candidatesFor([a, b]);
    const snapshot = input.map((c) => c.absPath);
    rankCandidatesByUtility(db, input, stash.dir);
    expect(input.map((c) => c.absPath)).toEqual(snapshot);
  });
});

// ── AC2: unscored sort last, never dropped ───────────────────────────────────

describe("#624 P2 rankCandidatesByUtility — unscored handling", () => {
  test("AC2: candidates with no utility_scores row sort LAST with effective utility 0, never dropped", () => {
    const scoredHigh = makeEligibleMemory("scored-high", 80);
    const unscored = makeEligibleMemory("unscored", null); // entry exists, no utility row
    const scoredLow = makeEligibleMemory("scored-low", 5);

    const ranked = rankCandidatesByUtility(db, candidatesFor([unscored, scoredLow, scoredHigh]), stash.dir);
    // Scored DESC first, unscored (utility 0) last.
    expect(ranked.map((c) => c.absPath)).toEqual([scoredHigh, scoredLow, unscored]);
    // Never filtered: total count preserved.
    expect(ranked).toHaveLength(3);
    expect(ranked.map((c) => c.absPath).sort()).toEqual([scoredHigh, scoredLow, unscored].sort());
  });

  test("AC2: candidate with no entries row at all gets utility 0 and is retained", () => {
    const scored = makeEligibleMemory("present", 42);
    const ghost = path.join(stash.dir, "memories", "ghost.md"); // no entries row seeded
    const ranked = rankCandidatesByUtility(db, candidatesFor([ghost, scored]), stash.dir);
    expect(ranked.map((c) => c.absPath)).toEqual([scored, ghost]);
    expect(ranked).toHaveLength(2);
  });
});

// ── AC3: default byte-identical (no ranking when topN unset / no DB) ──────────

describe("#624 P2 default-preserving (AC3)", () => {
  test("AC3: collectEligibleFiles+filter is unchanged and ranking is opt-in", () => {
    // Build a real eligible set on disk.
    const a = makeEligibleMemory("alpha", 3);
    const b = makeEligibleMemory("beta", 99);
    const eligible = collectEligibleFiles(stash.dir, ["memory"]);
    const eligiblePaths = eligible.map((e) => e.absPath).sort();
    expect(eligiblePaths).toEqual([a, b].sort());

    // Ranking the SAME set reorders by utility but preserves membership — i.e.
    // ranking is a pure reorder layered on top of the unchanged eligible set.
    const ranked = rankCandidatesByUtility(db, eligible as Candidate[], stash.dir);
    expect(ranked.map((c) => c.absPath).sort()).toEqual(eligiblePaths);
    expect(ranked.map((c) => c.absPath)).toEqual([b, a]); // utility DESC
  });

  test("AC3: a DB-less ranking falls back to no-ranking (returns input order) and does NOT throw", () => {
    const a = makeEligibleMemory("x", 1);
    const b = makeEligibleMemory("y", 2);
    const input = candidatesFor([a, b]);
    // Cannot rank without a DB → must return the candidates unranked, not throw.
    const out = rankCandidatesByUtility(undefined as unknown as Database, input, stash.dir);
    expect(out.map((c) => c.absPath)).toEqual([a, b]);
  });
});

// ── Chunking edge case: > 999 candidates (SQLite IN cap) ─────────────────────

describe("#624 P2 chunking (SQLite IN param cap)", () => {
  test("ranks correct global DESC order across chunk boundaries for 1500 candidates", () => {
    const memDir = path.join(stash.dir, "memories");
    fs.mkdirSync(memDir, { recursive: true });
    const N = 1500;
    const paths: string[] = [];
    for (let i = 0; i < N; i++) {
      const absPath = path.join(memDir, `f${i}.md`);
      fs.writeFileSync(absPath, `---\ntype: memory\n---\nbody ${i}\n`);
      // utility ascending with i, so DESC order is i = N-1 .. 0.
      seedEntryWithUtility(absPath, i);
      paths.push(absPath);
    }
    // Shuffle input so order must come from ranking, not insertion.
    const shuffled = [...paths].reverse();
    const ranked = rankCandidatesByUtility(db, candidatesFor(shuffled), stash.dir);
    expect(ranked).toHaveLength(N);
    // Highest utility (i=N-1) first, lowest (i=0) last.
    expect(ranked[0]?.absPath).toBe(paths[N - 1]);
    expect(ranked[N - 1]?.absPath).toBe(paths[0]);
    // No "too many SQL variables" error means chunking worked.
  });
});

// ── Tie-break determinism ────────────────────────────────────────────────────

describe("#624 P2 tie-break determinism", () => {
  test("equal-utility candidates sort by file_path ASC (stable, deterministic)", () => {
    const memDir = path.join(stash.dir, "memories");
    fs.mkdirSync(memDir, { recursive: true });
    const cPath = makeEligibleMemory("ccc", 10);
    const aPath = makeEligibleMemory("aaa", 10);
    const bPath = makeEligibleMemory("bbb", 10);

    // Feed in non-sorted order; equal utility → file_path ASC tie-break.
    const ranked = rankCandidatesByUtility(db, candidatesFor([cPath, bPath, aPath]), stash.dir);
    const expected = [aPath, bPath, cPath].sort(); // file_path ASC
    expect(ranked.map((c) => c.absPath)).toEqual(expected);
  });
});
