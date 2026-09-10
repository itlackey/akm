// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Module B3 of docs/plans/index-redesign-contract.md — search over units.
 *
 * Opens a real temp `index.db` (`openIndexDatabase`), so this belongs under
 * `tests/integration/` per AGENTS.md's classification rule.
 *
 * Covers, per the contract's test list: lexical-only, semantic-only, both
 * (hybrid + grouping to entries by best unit), type filters, and the
 * `matchedUnit` envelope field end to end through `akmSearch`.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmSearch } from "../../../src/commands/read/search";
import { resetConfigCache, saveConfig } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { deriveEntryProvenance } from "../../../src/indexer/installations";
import type { IndexDocument } from "../../../src/indexer/passes/metadata";
import { searchUnitsLexical } from "../../../src/indexer/search/db-search";
import { fuseByEntry, RRF_K } from "../../../src/indexer/search/ranking";
import { buildSearchText } from "../../../src/indexer/search/search-fields";
import type { Database } from "../../../src/storage/database";
import { ensureFileAndUnitTextTables } from "../../../src/storage/repositories/files-repository";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import { setMeta } from "../../../src/storage/repositories/index-meta-repository";
import { ensureUnitTables, searchUnits, type UnitSearchHit } from "../../../src/storage/repositories/units-repository";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
  sandboxXdgStateHome,
} from "../../_helpers/sandbox";

// ── Low-level fixtures (direct DB, no stash/config needed) ─────────────────

const createdTmpDirs: string[] = [];

function tmpDbPath(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `akm-units-${label}-`));
  createdTmpDirs.push(dir);
  return path.join(dir, "index.db");
}

afterAll(() => {
  for (const dir of createdTmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function openSeededDb(label: string): Database {
  // `openIndexDatabase`'s own schema ensure already wires `ensureUnitTables`
  // (index-schema.ts, A2) — an explicit `embeddingDim` is required here so
  // `units_vec` is created at this suite's 4-wide test vectors instead of the
  // real default; a later bare `ensureUnitTables(db, 4)` call would be a
  // no-op once the table already exists at the wrong width.
  const db = openIndexDatabase(tmpDbPath(label), { embeddingDim: 4 });
  ensureFileAndUnitTextTables(db);
  ensureUnitTables(db, 4);
  return db;
}

function insertEntry(db: Database, name: string, type = "memory"): number {
  const entry: IndexDocument = { name, type, description: `${name} description` };
  const searchText = buildSearchText(entry);
  const provenance = deriveEntryProvenance({ bundleId: "stash", componentId: "stash", adapterId: "akm" }, type, name);
  return upsertEntry(db, path.join("/test/stash", `${name}.md`), entry, searchText, provenance);
}

/** Seed one unit: `unit_texts` + `units_fts` + `entry_units`. */
function seedUnit(
  db: Database,
  opts: {
    entryId: number;
    ordinal: number;
    fragmentId: string | null;
    hash: string;
    kind: "card" | "fragment";
    text: string;
  },
): void {
  db.prepare("INSERT INTO unit_texts (unit_hash, kind, text) VALUES (?, ?, ?)").run(opts.hash, opts.kind, opts.text);
  db.prepare("INSERT INTO units_fts (unit_hash, text) VALUES (?, ?)").run(opts.hash, opts.text);
  db.prepare("INSERT INTO entry_units (entry_id, ordinal, fragment_id, unit_hash) VALUES (?, ?, ?, ?)").run(
    opts.entryId,
    opts.ordinal,
    opts.fragmentId,
    opts.hash,
  );
}

function normalizedVec(dim: number, lead: number): number[] {
  const raw = new Array(dim).fill(0);
  raw[0] = lead;
  raw[1] = 1;
  const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0));
  return raw.map((v) => v / norm);
}

// ── searchUnitsLexical ───────────────────────────────────────────────────────

describe("searchUnitsLexical", () => {
  test("ranks bm25 hits best-first, 1-based rank, excludes non-matches", () => {
    const db = openSeededDb("lexical-rank");
    try {
      const entryId = insertEntry(db, "widget-guide");
      seedUnit(db, {
        entryId,
        ordinal: 0,
        fragmentId: null,
        hash: "h-strong",
        kind: "card",
        text: "widget widget widget everywhere",
      });
      seedUnit(db, {
        entryId,
        ordinal: 1,
        fragmentId: "f1",
        hash: "h-weak",
        kind: "fragment",
        text: "a single widget mention",
      });
      seedUnit(db, {
        entryId,
        ordinal: 2,
        fragmentId: "f2",
        hash: "h-nomatch",
        kind: "fragment",
        text: "banana bread recipe",
      });

      const hits = searchUnitsLexical(db, "widget", 10);
      const hashes = hits.map((h) => h.unitHash);
      expect(hashes).toContain("h-strong");
      expect(hashes).toContain("h-weak");
      expect(hashes).not.toContain("h-nomatch");
      // Repeated-term unit is the stronger BM25 match.
      expect(hits[0]!.unitHash).toBe("h-strong");
      expect(hits.map((h) => h.rank)).toEqual(hits.map((_, i) => i + 1));
    } finally {
      closeDatabase(db);
    }
  });

  test("empty/unsearchable query returns no hits", () => {
    const db = openSeededDb("lexical-empty");
    try {
      expect(searchUnitsLexical(db, "", 10)).toEqual([]);
      expect(searchUnitsLexical(db, "   ", 10)).toEqual([]);
    } finally {
      closeDatabase(db);
    }
  });

  test("k bounds the result count", () => {
    const db = openSeededDb("lexical-k");
    try {
      const entryId = insertEntry(db, "many-units");
      for (let i = 0; i < 5; i++) {
        seedUnit(db, {
          entryId,
          ordinal: i,
          fragmentId: `f${i}`,
          hash: `h-${i}`,
          kind: "fragment",
          text: "gadget content",
        });
      }
      expect(searchUnitsLexical(db, "gadget", 2)).toHaveLength(2);
      expect(searchUnitsLexical(db, "gadget", 0)).toEqual([]);
    } finally {
      closeDatabase(db);
    }
  });
});

// ── searchUnits (A2, units-repository.ts) — identity filtering sanity check ─

describe("searchUnits identity filtering", () => {
  test("returns only hits for the requested identity, nearest first, bounded by k", () => {
    const db = openSeededDb("vec-identity");
    const dim = 4;
    const buf = (v: number[]) => Buffer.from(new Float32Array(v).buffer);
    db.prepare("INSERT INTO units_vec (unit_id, embedding, unit_hash, identity) VALUES (?, ?, ?, ?)").run(
      1,
      buf(normalizedVec(dim, 1)),
      "hv-1",
      "remote:model-a|4",
    );
    db.prepare("INSERT INTO units_vec (unit_id, embedding, unit_hash, identity) VALUES (?, ?, ?, ?)").run(
      2,
      buf(normalizedVec(dim, 0.9)),
      "hv-2",
      "remote:model-a|4",
    );
    db.prepare("INSERT INTO units_vec (unit_id, embedding, unit_hash, identity) VALUES (?, ?, ?, ?)").run(
      3,
      buf(normalizedVec(dim, 1)),
      "hv-3",
      "remote:model-b|4",
    );
    try {
      const hits = searchUnits(db, normalizedVec(dim, 1), 5, "remote:model-a|4");
      expect(hits.every((h) => h.hash === "hv-1" || h.hash === "hv-2")).toBe(true);
      expect(hits.map((h) => h.hash)).not.toContain("hv-3");
      expect(hits[0]!.distance).toBeLessThanOrEqual(hits[hits.length - 1]!.distance);

      const bounded = searchUnits(db, normalizedVec(dim, 1), 1, "remote:model-a|4");
      expect(bounded).toHaveLength(1);
    } finally {
      closeDatabase(db);
    }
  });
});

// ── fuseByEntry ──────────────────────────────────────────────────────────────

describe("fuseByEntry — reciprocal rank fusion", () => {
  test("RRF_K is the Cormack et al. 2009 constant", () => {
    expect(RRF_K).toBe(60);
  });

  test("lexical-only hit: rankingMode 'fts', score = 1/(RRF_K + rank)", () => {
    const db = openSeededDb("fuse-lexical-only");
    try {
      const entryId = insertEntry(db, "lex-only");
      seedUnit(db, { entryId, ordinal: 0, fragmentId: null, hash: "hL", kind: "card", text: "lexical only text" });

      const results = fuseByEntry(db, [{ unitHash: "hL", rank: 1 }], []);
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe(entryId);
      expect(results[0]!.rankingMode).toBe("fts");
      expect(results[0]!.score).toBeCloseTo(1 / (RRF_K + 1), 10);
      expect(results[0]!.matchedUnit).toEqual({ unitHash: "hL", fragmentId: null, kind: "card" });
    } finally {
      closeDatabase(db);
    }
  });

  test("semantic-only hit: rankingMode 'semantic', score = 1/(RRF_K + rank)", () => {
    const db = openSeededDb("fuse-semantic-only");
    try {
      const entryId = insertEntry(db, "sem-only");
      seedUnit(db, {
        entryId,
        ordinal: 0,
        fragmentId: "sec1",
        hash: "hS",
        kind: "fragment",
        text: "semantic only text",
      });

      const semanticHits: UnitSearchHit[] = [{ unitId: 1, hash: "hS", distance: 0.05 }];
      const results = fuseByEntry(db, [], semanticHits);
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe(entryId);
      expect(results[0]!.rankingMode).toBe("semantic");
      expect(results[0]!.score).toBeCloseTo(1 / (RRF_K + 1), 10);
      expect(results[0]!.matchedUnit).toEqual({ unitHash: "hS", fragmentId: "sec1", kind: "fragment" });
      // Legacy `fragmentId` is also populated so downstream fragment-ref
      // resolution (buildDbHit's ref = `${parentRef}#${fragmentId}`) works.
      expect(results[0]!.fragmentId).toBe("sec1");
    } finally {
      closeDatabase(db);
    }
  });

  test("both lists hit different units of the SAME entry: hybrid, grouping keeps the better-ranked unit", () => {
    const db = openSeededDb("fuse-hybrid-grouping");
    try {
      const entryA = insertEntry(db, "entry-a");
      const entryB = insertEntry(db, "entry-b");
      seedUnit(db, { entryId: entryA, ordinal: 0, fragmentId: null, hash: "hA-card", kind: "card", text: "a card" });
      seedUnit(db, {
        entryId: entryA,
        ordinal: 1,
        fragmentId: "sec1",
        hash: "hA-frag",
        kind: "fragment",
        text: "a fragment",
      });
      seedUnit(db, { entryId: entryB, ordinal: 0, fragmentId: null, hash: "hB-card", kind: "card", text: "b card" });

      // Lexical: B ranks 1st, A's card ranks 2nd.
      const lexical = [
        { unitHash: "hB-card", rank: 1 },
        { unitHash: "hA-card", rank: 2 },
      ];
      // Semantic: only A's fragment unit hits, so it is the sole (and thus
      // best, entry-rank 1) semantic entry.
      const semantic: UnitSearchHit[] = [{ unitId: 1, hash: "hA-frag", distance: 0.02 }];

      const results = fuseByEntry(db, lexical, semantic);
      const byId = new Map(results.map((r) => [r.id, r]));

      const a = byId.get(entryA)!;
      expect(a.rankingMode).toBe("hybrid");
      // A's lexical entry-rank is 2 (B took entry-rank 1); its semantic
      // entry-rank is 1 (its only competitor in that list). Semantic ranked
      // it strictly better, so matchedUnit reports the fragment unit.
      expect(a.score).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1), 10);
      expect(a.matchedUnit).toEqual({ unitHash: "hA-frag", fragmentId: "sec1", kind: "fragment" });

      const b = byId.get(entryB)!;
      expect(b.rankingMode).toBe("fts");
      expect(b.score).toBeCloseTo(1 / (RRF_K + 1), 10);
      expect(b.matchedUnit).toEqual({ unitHash: "hB-card", fragmentId: null, kind: "card" });
    } finally {
      closeDatabase(db);
    }
  });

  test("a tie between the two lists' entry-rank favors the lexical unit", () => {
    const db = openSeededDb("fuse-tie");
    try {
      const entryId = insertEntry(db, "tie-entry");
      seedUnit(db, { entryId, ordinal: 0, fragmentId: null, hash: "hCard", kind: "card", text: "card text" });
      seedUnit(db, { entryId, ordinal: 1, fragmentId: "sec1", hash: "hFrag", kind: "fragment", text: "fragment text" });

      const results = fuseByEntry(db, [{ unitHash: "hCard", rank: 1 }], [{ unitId: 1, hash: "hFrag", distance: 0.01 }]);
      expect(results).toHaveLength(1);
      expect(results[0]!.rankingMode).toBe("hybrid");
      expect(results[0]!.matchedUnit?.unitHash).toBe("hCard");
    } finally {
      closeDatabase(db);
    }
  });

  test("type filters: typeFilter includes only the named types, excludeTypes drops them", () => {
    const db = openSeededDb("fuse-type-filter");
    try {
      const memoryId = insertEntry(db, "mem-entry", "memory");
      const skillId = insertEntry(db, "skill-entry", "skill");
      seedUnit(db, {
        entryId: memoryId,
        ordinal: 0,
        fragmentId: null,
        hash: "hMem",
        kind: "card",
        text: "memory text",
      });
      seedUnit(db, {
        entryId: skillId,
        ordinal: 0,
        fragmentId: null,
        hash: "hSkill",
        kind: "card",
        text: "skill text",
      });

      const lexical = [
        { unitHash: "hMem", rank: 1 },
        { unitHash: "hSkill", rank: 2 },
      ];

      const included = fuseByEntry(db, lexical, [], { typeFilter: ["memory"] });
      expect(included.map((r) => r.id)).toEqual([memoryId]);

      const excluded = fuseByEntry(db, lexical, [], { excludeTypes: ["skill"] });
      expect(excluded.map((r) => r.id)).toEqual([memoryId]);

      const unfiltered = fuseByEntry(db, lexical, []);
      expect(new Set(unfiltered.map((r) => r.id))).toEqual(new Set([memoryId, skillId]));
    } finally {
      closeDatabase(db);
    }
  });

  test("no hits from either list returns an empty array", () => {
    const db = openSeededDb("fuse-empty");
    try {
      expect(fuseByEntry(db, [], [])).toEqual([]);
    } finally {
      closeDatabase(db);
    }
  });
});

// ── End-to-end: the switch + the matchedUnit envelope field ────────────────

describe("akmSearch — units path switch and matchedUnit envelope field", () => {
  let stashDir = "";
  let envCleanup: Cleanup = () => {};

  beforeEach(() => {
    const cacheResult = sandboxXdgCacheHome();
    const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
    const dataResult = sandboxXdgDataHome(cfgResult.cleanup);
    const stateResult = sandboxXdgStateHome(dataResult.cleanup);
    const stashResult = sandboxStashDir(stateResult.cleanup);
    stashDir = stashResult.dir;
    envCleanup = stashResult.cleanup;

    resetConfigCache();
    saveConfig({
      semanticSearchMode: "off",
      bundles: { stash: { path: stashDir } },
      defaultBundle: "stash",
      registries: [],
    });
  });

  afterEach(() => {
    envCleanup();
    envCleanup = () => {};
    resetConfigCache();
  });

  test("hits carry matchedUnit once units_fts has rows, and the old path is unaffected when it does not", async () => {
    fs.mkdirSync(path.join(stashDir, "memories"), { recursive: true });
    const notePath = path.join(stashDir, "memories", "alpha-notes.md");
    fs.writeFileSync(notePath, "---\ntype: memory\n---\nAlpha content.\n");

    const dbPath = getDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = openIndexDatabase(dbPath);
    let entryId: number;
    try {
      const entry: IndexDocument = { name: "alpha-notes", type: "memory", description: "Alpha content." };
      const searchText = buildSearchText(entry);
      const provenance = deriveEntryProvenance(
        { bundleId: "stash", componentId: "stash", adapterId: "akm" },
        "memory",
        "alpha-notes",
      );
      entryId = upsertEntry(db, notePath, entry, searchText, provenance);
      // Mark the index as already built for this stash so `ensureIndex` (the
      // bootstrap-only rebuild `akmSearch` runs) does not re-walk the stash
      // and reassign this hand-inserted entry a different id.
      setMeta(db, "stashDir", stashDir);
      setMeta(db, "builtAt", new Date().toISOString());
      setMeta(db, "stashDirs", JSON.stringify([stashDir]));
      setMeta(db, "hasEmbeddings", "0");
    } finally {
      closeDatabase(db);
    }

    // Before B1/B3's units_fts is populated, search must use the old path —
    // no units_fts table at all yet, so a query on this fresh index just
    // returns no hits (there's no entries_fts population here either; this
    // step only proves the units path is not silently used before it exists).
    const beforeUnits = await akmSearch({ query: "alpha", source: "local", limit: 10 });
    expect(beforeUnits.hits.some((h) => "matchedUnit" in h && h.matchedUnit)).toBe(false);

    const dbAfter = openIndexDatabase(dbPath);
    try {
      ensureFileAndUnitTextTables(dbAfter);
      ensureUnitTables(dbAfter, 4);
      seedUnit(dbAfter, {
        entryId,
        ordinal: 0,
        fragmentId: null,
        hash: "hAlpha",
        kind: "card",
        text: "alpha-notes Alpha content.",
      });
    } finally {
      closeDatabase(dbAfter);
    }

    const afterUnits = await akmSearch({ query: "alpha", source: "local", limit: 10 });
    const hit = afterUnits.hits.find((h) => "name" in h && h.name === "alpha-notes");
    expect(hit).toBeDefined();
    if (!hit || !("ref" in hit)) return;
    expect(hit.matchedUnit).toEqual({ unitHash: "hAlpha", fragmentId: null, kind: "card" });
    expect(hit.whyMatched).toContain("fts bm25 relevance");
  });
});
