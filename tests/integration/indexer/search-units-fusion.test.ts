// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Module B3 of docs/plans/index-redesign-contract.md — search over units —
 * and B5f item 2 (card/fragment field emphasis by structure, not weights).
 *
 * Opens a real temp `index.db` (`openIndexDatabase`), so this belongs under
 * `tests/integration/` per AGENTS.md's classification rule.
 *
 * Covers, per the contract's test list: lexical-only (card and fragment
 * separately), semantic-only, all three fused (hybrid + grouping to entries
 * by best unit), the kind-scoped field-emphasis behavior itself, type
 * filters, and the `matchedUnit` envelope field end to end through
 * `akmSearch`.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmSearch } from "../../../src/commands/read/search";
import { resetConfigCache, saveConfig } from "../../../src/core/config/config";
import { stableFtsScore } from "../../../src/core/lexical-score";
import { getDbPath } from "../../../src/core/paths";
import { deriveEntryProvenance } from "../../../src/indexer/installations";
import type { IndexDocument } from "../../../src/indexer/passes/metadata";
import { searchUnitsLexical, searchUnitsLexicalPair } from "../../../src/indexer/search/db-search";
import { applyRankingRules, fuseByEntry, type UnitLexicalHit } from "../../../src/indexer/search/ranking";
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

  // Item 2 — the tier ladder is now a PRIORITY ORDER: it tops up from a
  // later tier instead of stopping at the first non-empty one.
  test("tops up from a later tier instead of stopping at the first non-empty one", () => {
    const db = openSeededDb("lexical-tier-topup");
    try {
      // Exact tier: one unit matches every token ("zeta" AND "widget").
      const exactEntryId = insertEntry(db, "zeta-widget-entry");
      seedUnit(db, {
        entryId: exactEntryId,
        ordinal: 0,
        fragmentId: null,
        hash: "hExact",
        kind: "card",
        text: "zeta widget",
      });
      // Relaxed-only: shares just "widget", never "zeta" — no exact/prefix
      // AND hit, only reachable via the relaxed OR recovery.
      const relaxedEntryId = insertEntry(db, "widget-only-entry");
      seedUnit(db, {
        entryId: relaxedEntryId,
        ordinal: 0,
        fragmentId: null,
        hash: "hRelaxed",
        kind: "card",
        text: "widget notes",
      });

      // Under the old early-exit ladder, the single exact hit alone would
      // have been returned and "hRelaxed" would never be seen even with
      // plenty of remaining capacity (k=10).
      const hits = searchUnitsLexical(db, "zeta widget", 10);
      const hashes = hits.map((h) => h.unitHash);
      expect(hashes).toContain("hExact");
      expect(hashes).toContain("hRelaxed");
      const exactHit = hits.find((h) => h.unitHash === "hExact")!;
      const relaxedHit = hits.find((h) => h.unitHash === "hRelaxed")!;
      expect(exactHit.lexicalMatch).toBe("exact");
      expect(relaxedHit.lexicalMatch).toBe("relaxed");
      // The exact hit still ranks first — topping up never reorders what an
      // earlier, stronger tier already found.
      expect(exactHit.rank).toBeLessThan(relaxedHit.rank);
    } finally {
      closeDatabase(db);
    }
  });

  // Item 2 — a genuine bm25 tie must not be split across the `k` cutoff when
  // topping up from a later tier: the final ranking comparator's
  // content-based tie-break depends on the exact score tie surviving into
  // `fuseByEntry`'s output.
  test("a tied group from a later tier is not split at the k cutoff — the whole tie survives even past k", () => {
    const db = openSeededDb("lexical-tier-tie-boundary");
    try {
      // The exact tier's one AND hit — both tokens, but padded long enough
      // (and both tokens diluted by the filler pool below) that it ranks
      // BELOW the tied filler group within the RELAXED query specifically,
      // so it never re-occupies a slot in that tier's own fetch.
      const zw1 = insertEntry(db, "zeta-widget-one");
      seedUnit(db, {
        entryId: zw1,
        ordinal: 0,
        fragmentId: null,
        hash: "hZw1",
        kind: "card",
        text: "zeta widget extra padding word here",
      });

      // A pool of units, each mentioning exactly one of the two query tokens
      // once — tied with each other under the relaxed OR query.
      const fillerHashes: string[] = [];
      for (let i = 0; i < 40; i++) {
        const id = insertEntry(db, `filler-${i}`);
        const hash = `hFiller${i}`;
        fillerHashes.push(hash);
        seedUnit(db, {
          entryId: id,
          ordinal: 0,
          fragmentId: null,
          hash,
          kind: "card",
          text: i % 2 === 0 ? "zeta alone" : "widget alone",
        });
      }
      // A few long, heavily-repeating units — not asserted on directly, but
      // their length pulls the corpus's average document length up enough
      // (BM25's length normalization) that the short exact-tier hit above
      // ranks BELOW the tied filler pool within the relaxed query
      // specifically, so it never re-occupies a slot in that tier's own
      // fetch (verified empirically against the real bm25() output, not
      // assumed).
      for (let i = 0; i < 6; i++) {
        const id = insertEntry(db, `long-padding-${i}`);
        seedUnit(db, {
          entryId: id,
          ordinal: 0,
          fragmentId: null,
          hash: `hLongPadding${i}`,
          kind: "card",
          text: "widget ".repeat(20).trim(),
        });
      }

      // k=5: the exact tier alone already contributes 1 hit, so a naive
      // cutoff (1 exact + 4 of the tied filler hits) would silently drop
      // the 5th tied unit the relaxed tier's own LIMIT=5 fetch found.
      const hits = searchUnitsLexical(db, "zeta widget", 5);
      const exactHit = hits.find((h) => h.unitHash === "hZw1")!;
      expect(exactHit.lexicalMatch).toBe("exact");
      const fillerHits = hits.filter((h) => fillerHashes.includes(h.unitHash));
      // The relaxed tier's own LIMIT=5 fetch is entirely the tied filler
      // group (the exact-tier hit ranks below all of them there) — every one
      // of those 5 fetched, tied hits survives past the k=5 cutoff.
      expect(fillerHits).toHaveLength(5);
      expect(new Set(fillerHits.map((h) => h.rank)).size).toBe(1);
      // The result legitimately exceeds k to keep the tie group whole.
      expect(hits.length).toBeGreaterThan(5);
    } finally {
      closeDatabase(db);
    }
  });
});

// ── searchUnitsLexicalPair (index-redesign-contract.md B5f item 2) ─────────

describe("searchUnitsLexicalPair — kind-scoped lexical search (field emphasis by structure)", () => {
  test("splits hits into a card pool and a fragment pool", () => {
    const db = openSeededDb("pair-filter");
    try {
      const entryId = insertEntry(db, "widget-guide");
      seedUnit(db, { entryId, ordinal: 0, fragmentId: null, hash: "hCard", kind: "card", text: "widget card" });
      seedUnit(db, {
        entryId,
        ordinal: 1,
        fragmentId: "f1",
        hash: "hFrag",
        kind: "fragment",
        text: "widget fragment",
      });

      const { card, fragment } = searchUnitsLexicalPair(db, "widget", 10);
      expect(card.map((h) => h.unitHash)).toEqual(["hCard"]);
      expect(fragment.map((h) => h.unitHash)).toEqual(["hFrag"]);
    } finally {
      closeDatabase(db);
    }
  });

  // The actual field-emphasis proof (index-redesign-contract.md B5f item 2):
  // the old index ranked name/description above body matches through
  // per-column BM25 weights. Here, a weak card match ranks #1 of ONE in the
  // card pool regardless of how many fragments elsewhere match the same term
  // far more strongly — no weight compares the two pools against each other,
  // because they are never in the same pool.
  test("a weak card match ranks #1 in its own pool even when unrelated fragments match the term far more strongly", () => {
    const db = openSeededDb("pair-emphasis");
    try {
      const cardEntryId = insertEntry(db, "ci-pipeline");
      seedUnit(db, {
        entryId: cardEntryId,
        ordinal: 0,
        fragmentId: null,
        hash: "hWeakCard",
        kind: "card",
        text: "ci pipeline setup",
      });
      // Five unrelated entries whose fragments repeat the term heavily — in a
      // single mixed BM25 pool these would out-rank the single weak card hit.
      for (let i = 0; i < 5; i++) {
        const noisyId = insertEntry(db, `noisy-${i}`);
        seedUnit(db, {
          entryId: noisyId,
          ordinal: 1,
          fragmentId: `f${i}`,
          hash: `hNoisyFrag${i}`,
          kind: "fragment",
          text: "pipeline pipeline pipeline pipeline pipeline pipeline pipeline pipeline",
        });
      }

      const { card, fragment } = searchUnitsLexicalPair(db, "pipeline", 10);
      expect(card).toHaveLength(1);
      expect(card[0]!.unitHash).toBe("hWeakCard");
      expect(card[0]!.rank).toBe(1);

      expect(fragment).toHaveLength(5);
      expect(fragment.map((h) => h.unitHash)).not.toContain("hWeakCard");
    } finally {
      closeDatabase(db);
    }
  });

  test("neither pool has a real match, so both independently fall back to relaxed", () => {
    const db = openSeededDb("pair-relaxed-independent");
    try {
      const entryId = insertEntry(db, "relaxed-fragment-only");
      // No card unit matches any query token at all; only a fragment does.
      seedUnit(db, { entryId, ordinal: 0, fragmentId: null, hash: "hCard", kind: "card", text: "unrelated card" });
      seedUnit(db, {
        entryId,
        ordinal: 1,
        fragmentId: "f1",
        hash: "hFrag",
        kind: "fragment",
        text: "completely different alpha beta",
      });

      const { card, fragment } = searchUnitsLexicalPair(db, "alpha gamma", 10);
      // Neither pool has an "alpha AND gamma" hit at any tier, so each
      // independently escalates on its own to the relaxed OR tier.
      expect(fragment.map((h) => h.unitHash)).toEqual(["hFrag"]);
      expect(fragment[0]!.lexicalMatch).toBe("relaxed");
      // The card pool independently ran its own ladder too, found nothing at
      // any tier (not even relaxed — "unrelated card" shares no token with
      // the query), and stays empty on its own account.
      expect(card).toEqual([]);
    } finally {
      closeDatabase(db);
    }
  });

  // Item 2 (confirmed defect fixed) — sharing one fallback-tier decision
  // across both pools meant an incidental exact hit in ONE pool locked the
  // OTHER pool out of ever escalating to its own relaxed recovery, even when
  // that pool's only candidate was the genuinely relevant one. Each pool now
  // runs its own ladder independently (`searchUnitsLexicalScoped`'s own
  // doc), and magnitude fusion (not rank) is what makes that safe: a
  // relaxed-tier match now scores at `stableFtsScore`'s 0.3 floor instead of
  // competing on rank against the exact-tier hit in the other pool.
  test("a fragment pool's own exact hit does not block the card pool from independently escalating to relaxed", () => {
    const db = openSeededDb("pair-independent-ladders");
    try {
      // The fragment pool's exact AND hit for the whole phrase — a pasted
      // "stack trace" quoting every query token, the shape of hit the brief
      // names as the confirmed failure.
      const logDumpId = insertEntry(db, "log-dump-entry");
      seedUnit(db, {
        entryId: logDumpId,
        ordinal: 0,
        fragmentId: null,
        hash: "hLogCard",
        kind: "card",
        text: "unrelated log dump card",
      });
      seedUnit(db, {
        entryId: logDumpId,
        ordinal: 1,
        fragmentId: "f1",
        hash: "hStackTrace",
        kind: "fragment",
        text: "widget catalog overview stack trace dump",
      });

      // The genuinely relevant entry: its card shares only ONE query token —
      // no exact/prefix AND hit of its own, reachable only via relaxed.
      const relevantId = insertEntry(db, "relevant-entry");
      seedUnit(db, {
        entryId: relevantId,
        ordinal: 0,
        fragmentId: null,
        hash: "hRelevantCard",
        kind: "card",
        text: "widget notes",
      });

      const { card, fragment } = searchUnitsLexicalPair(db, "widget catalog overview", 10);
      const stackHit = fragment.find((h) => h.unitHash === "hStackTrace");
      expect(stackHit?.lexicalMatch).toBe("exact");

      // Under the old shared-tier design this pool stayed empty forever,
      // because the fragment pool's exact hit stopped the WHOLE query. Now
      // it independently escalates and still surfaces the relevant entry.
      const relevantHit = card.find((h) => h.unitHash === "hRelevantCard");
      expect(relevantHit?.lexicalMatch).toBe("relaxed");
    } finally {
      closeDatabase(db);
    }
  });

  test("k bounds the result count per pool", () => {
    const db = openSeededDb("pair-k");
    try {
      const entryId = insertEntry(db, "many-fragments");
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
      expect(searchUnitsLexicalPair(db, "gadget", 2).fragment).toHaveLength(2);
      expect(searchUnitsLexicalPair(db, "gadget", 0).fragment).toEqual([]);
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

/**
 * Cosine similarity from a `units_vec` L2 distance over normalized vectors —
 * mirrors `ranking.ts`'s own private `semanticCosine` (and the retired
 * `tryVecScores`' conversion it is pinned against): `1 - distance²/2`,
 * clamped at 0.
 */
function cosine(distance: number): number {
  return Math.max(0, 1 - (distance * distance) / 2);
}

describe("fuseByEntry — magnitude fusion over three lists (card lexical, fragment lexical, semantic)", () => {
  test("card-lexical-only hit: rankingMode 'fts', score = stableFtsScore(bm25, 'parent')", () => {
    const db = openSeededDb("fuse-card-only");
    try {
      const entryId = insertEntry(db, "card-only");
      seedUnit(db, { entryId, ordinal: 0, fragmentId: null, hash: "hC", kind: "card", text: "card only text" });

      const results = fuseByEntry(db, [{ unitHash: "hC", rank: 1, bm25: -50, lexicalMatch: "exact" }], [], []);
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe(entryId);
      expect(results[0]!.rankingMode).toBe("fts");
      expect(results[0]!.score).toBeCloseTo(stableFtsScore(-50, "parent"), 10);
      expect(results[0]!.matchedUnit).toEqual({ unitHash: "hC", fragmentId: null, kind: "card" });
    } finally {
      closeDatabase(db);
    }
  });

  test("fragment-lexical-only hit: rankingMode 'fts', score = stableFtsScore(bm25, 'fragment') — same calibration as a card-only hit", () => {
    const db = openSeededDb("fuse-fragment-only");
    try {
      const entryId = insertEntry(db, "fragment-only");
      seedUnit(db, {
        entryId,
        ordinal: 1,
        fragmentId: "sec1",
        hash: "hF",
        kind: "fragment",
        text: "fragment only text",
      });

      const results = fuseByEntry(db, [], [{ unitHash: "hF", rank: 1, bm25: -50, lexicalMatch: "exact" }], []);
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe(entryId);
      expect(results[0]!.rankingMode).toBe("fts");
      expect(results[0]!.score).toBeCloseTo(stableFtsScore(-50, "fragment"), 10);
      expect(results[0]!.matchedUnit).toEqual({ unitHash: "hF", fragmentId: "sec1", kind: "fragment" });
      expect(results[0]!.fragmentId).toBe("sec1");
    } finally {
      closeDatabase(db);
    }
  });

  test("semantic-only hit: rankingMode 'semantic', score = cosine * 0.3 — never enough alone to outrank a real lexical floor", () => {
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
      const results = fuseByEntry(db, [], [], semanticHits);
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe(entryId);
      expect(results[0]!.rankingMode).toBe("semantic");
      expect(results[0]!.score).toBeCloseTo(cosine(0.05) * 0.3, 10);
      // Semantic alone is capped at 0.3*1 = 0.3 — at most `stableFtsScore`'s
      // own lexical floor, never above it.
      expect(results[0]!.score).toBeLessThanOrEqual(0.3);
      expect(results[0]!.matchedUnit).toEqual({ unitHash: "hS", fragmentId: "sec1", kind: "fragment" });
      // Legacy `fragmentId` is also populated so downstream fragment-ref
      // resolution (buildDbHit's ref = `${parentRef}#${fragmentId}`) works.
      expect(results[0]!.fragmentId).toBe("sec1");
    } finally {
      closeDatabase(db);
    }
  });

  test("a card match and a fragment match on the SAME entry: lexical evidence is the BEST of the two, not summed — but matchedUnit still prefers card by priority", () => {
    const db = openSeededDb("fuse-card-plus-fragment");
    try {
      const entryId = insertEntry(db, "card-and-fragment");
      seedUnit(db, { entryId, ordinal: 0, fragmentId: null, hash: "hCard", kind: "card", text: "card text" });
      seedUnit(db, { entryId, ordinal: 1, fragmentId: "sec1", hash: "hFrag", kind: "fragment", text: "fragment text" });

      // The fragment's bm25 is the far stronger match (-500 vs -0.0001).
      const results = fuseByEntry(
        db,
        [{ unitHash: "hCard", rank: 1, bm25: -0.0001, lexicalMatch: "exact" }],
        [{ unitHash: "hFrag", rank: 1, bm25: -500, lexicalMatch: "exact" }],
        [],
      );
      expect(results).toHaveLength(1);
      // Score is the MAX of the two magnitudes — the fragment's stronger
      // evidence, not a sum of both (unlike the retired RRF fusion, which
      // summed reciprocal-rank credit from every list a unit appeared in).
      expect(results[0]!.score).toBeCloseTo(stableFtsScore(-500, "fragment"), 10);
      expect(results[0]!.rankingMode).toBe("fts");
      // matchedUnit is still card: a fixed evidence-strength priority
      // (card, then fragment, then semantic), independent of which
      // magnitude actually won the score.
      expect(results[0]!.matchedUnit).toEqual({ unitHash: "hCard", fragmentId: null, kind: "card" });
    } finally {
      closeDatabase(db);
    }
  });

  test("all three present: lexical (max of card/fragment) * 0.7 + semantic * 0.3, hybrid, matchedUnit is card", () => {
    const db = openSeededDb("fuse-triple-match");
    try {
      const entryId = insertEntry(db, "triple-match");
      seedUnit(db, { entryId, ordinal: 0, fragmentId: null, hash: "hCard", kind: "card", text: "card text" });
      seedUnit(db, { entryId, ordinal: 1, fragmentId: "sec1", hash: "hFrag", kind: "fragment", text: "fragment text" });

      const results = fuseByEntry(
        db,
        [{ unitHash: "hCard", rank: 1, bm25: -500, lexicalMatch: "exact" }],
        [{ unitHash: "hFrag", rank: 1, bm25: -0.0001, lexicalMatch: "exact" }],
        [{ unitId: 1, hash: "hFrag", distance: 0.01 }],
      );
      expect(results).toHaveLength(1);
      const expected = stableFtsScore(-500, "parent") * 0.7 + cosine(0.01) * 0.3;
      expect(results[0]!.score).toBeCloseTo(expected, 10);
      expect(results[0]!.rankingMode).toBe("hybrid");
      expect(results[0]!.matchedUnit).toEqual({ unitHash: "hCard", fragmentId: null, kind: "card" });
    } finally {
      closeDatabase(db);
    }
  });

  test("matchedUnit priority is a fixed order — card > fragment > semantic — never a magnitude comparison across lists", () => {
    const db = openSeededDb("fuse-tie-priority");
    try {
      const entryId = insertEntry(db, "tie-entry");
      seedUnit(db, { entryId, ordinal: 0, fragmentId: null, hash: "hCard", kind: "card", text: "card text" });
      seedUnit(db, { entryId, ordinal: 1, fragmentId: "sec1", hash: "hFrag", kind: "fragment", text: "fragment text" });

      // fragment vs semantic: fragment wins even when semantic evidence is
      // objectively stronger by magnitude.
      const fragVsSem = fuseByEntry(
        db,
        [],
        [{ unitHash: "hFrag", rank: 1, bm25: -0.0001, lexicalMatch: "relaxed" }],
        [{ unitId: 1, hash: "hFrag", distance: 0.001 }],
      );
      expect(fragVsSem[0]!.matchedUnit?.unitHash).toBe("hFrag");
      expect(fragVsSem[0]!.matchedUnit?.kind).toBe("fragment");

      // card vs semantic: card wins likewise.
      const cardVsSem = fuseByEntry(
        db,
        [{ unitHash: "hCard", rank: 1, bm25: -0.0001, lexicalMatch: "relaxed" }],
        [],
        [{ unitId: 1, hash: "hFrag", distance: 0.001 }],
      );
      expect(cardVsSem[0]!.matchedUnit?.unitHash).toBe("hCard");
    } finally {
      closeDatabase(db);
    }
  });

  test("both lexical lists hit different units of DIFFERENT entries: hybrid grouping, matchedUnit priority overrides which list scored better", () => {
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

      // B's card is the far stronger bm25 match; A's card is barely negative.
      const cardLexical: UnitLexicalHit[] = [
        { unitHash: "hB-card", rank: 1, bm25: -500, lexicalMatch: "exact" },
        { unitHash: "hA-card", rank: 2, bm25: -0.0001, lexicalMatch: "relaxed" },
      ];
      // Semantic: only A's fragment unit hits.
      const semantic: UnitSearchHit[] = [{ unitId: 1, hash: "hA-frag", distance: 0.02 }];

      const results = fuseByEntry(db, cardLexical, [], semantic);
      const byId = new Map(results.map((r) => [r.id, r]));

      const a = byId.get(entryA)!;
      expect(a.rankingMode).toBe("hybrid");
      expect(a.score).toBeCloseTo(stableFtsScore(-0.0001, "parent") * 0.7 + cosine(0.02) * 0.3, 10);
      // A HAS a card hit, so matchedUnit reports the card unit by priority —
      // even though the semantic side is, on its own, a much stronger
      // signal for this entry than its own weak card match.
      expect(a.matchedUnit).toEqual({ unitHash: "hA-card", fragmentId: null, kind: "card" });

      const b = byId.get(entryB)!;
      expect(b.rankingMode).toBe("fts");
      expect(b.score).toBeCloseTo(stableFtsScore(-500, "parent"), 10);
      expect(b.matchedUnit).toEqual({ unitHash: "hB-card", fragmentId: null, kind: "card" });
    } finally {
      closeDatabase(db);
    }
  });

  test("magnitude, not rank, separates a strong lexical match from a weak one — the RRF defect this replaces", () => {
    const db = openSeededDb("fuse-magnitude-separation");
    try {
      const strongId = insertEntry(db, "strong-match");
      seedUnit(db, { entryId: strongId, ordinal: 0, fragmentId: null, hash: "hStrong", kind: "card", text: "strong" });
      const weakId = insertEntry(db, "weak-match");
      seedUnit(db, { entryId: weakId, ordinal: 0, fragmentId: null, hash: "hWeak", kind: "card", text: "weak" });

      // Adjacent ranks (1 and 2) — under the retired RRF fusion these would
      // have scored nearly identically (1/61 vs 1/62, normalized). Under
      // magnitude fusion a strong bm25 and a barely-negative one land far
      // apart: the weak hit sits near `stableFtsScore`'s 0.3 floor, the
      // strong one well above it.
      const results = fuseByEntry(
        db,
        [
          { unitHash: "hStrong", rank: 1, bm25: -1, lexicalMatch: "exact" },
          { unitHash: "hWeak", rank: 2, bm25: -1e-9, lexicalMatch: "relaxed" },
        ],
        [],
        [],
      );
      const strong = results.find((r) => r.id === strongId)!;
      const weak = results.find((r) => r.id === weakId)!;
      expect(strong.score).toBeCloseTo(stableFtsScore(-1, "parent"), 10);
      expect(weak.score).toBeCloseTo(stableFtsScore(-1e-9, "parent"), 10);
      expect(weak.score).toBeLessThan(0.32);
      expect(strong.score).toBeGreaterThan(0.65);
      expect(strong.score - weak.score).toBeGreaterThan(0.4);
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

      const cardLexical: UnitLexicalHit[] = [
        { unitHash: "hMem", rank: 1, bm25: -5, lexicalMatch: "exact" },
        { unitHash: "hSkill", rank: 2, bm25: -5, lexicalMatch: "exact" },
      ];

      const included = fuseByEntry(db, cardLexical, [], [], { typeFilter: ["memory"] });
      expect(included.map((r) => r.id)).toEqual([memoryId]);

      const excluded = fuseByEntry(db, cardLexical, [], [], { excludeTypes: ["skill"] });
      expect(excluded.map((r) => r.id)).toEqual([memoryId]);

      const unfiltered = fuseByEntry(db, cardLexical, [], []);
      expect(new Set(unfiltered.map((r) => r.id))).toEqual(new Set([memoryId, skillId]));
    } finally {
      closeDatabase(db);
    }
  });

  test("no hits from any list returns an empty array", () => {
    const db = openSeededDb("fuse-empty");
    try {
      expect(fuseByEntry(db, [], [], [])).toEqual([]);
    } finally {
      closeDatabase(db);
    }
  });
});

// ── Belief-state ceiling invariant (item 1 confirmed defect) ───────────────

describe("belief-state score ceiling invariant restored by magnitude fusion", () => {
  // The redesign deleted the invariant the belief-state ceilings
  // (ranking-contributors.ts) were calibrated against — "un-demoted keyword
  // hits floor at a 0.3 base, so any un-demoted hit outranks a ceilinged
  // one" — along with `normalizeFtsScores`. Under RRF a hit ranked deep in a
  // large candidate pool could score far below any belief-state ceiling
  // (confirmed: a deprecated entry could outrank 33 live matching entries at
  // `--limit 200`). `stableFtsScore`'s own floor is 0.3 — strictly above the
  // highest ceiling (deprecated, 0.28) — so magnitude fusion restores the
  // invariant as a structural consequence, not a new rule. This constructs
  // the case end to end (real bm25 evidence, real ranking contributors, the
  // real ceiling) rather than assuming it.
  test("a deprecated entry with a strong exact match never outranks many live, only-weakly-matching entries", () => {
    const db = openSeededDb("belief-ceiling-invariant");
    try {
      const deprecatedId = insertEntry(db, "deprecated-entry");
      db.prepare("UPDATE entries SET document_json = json_set(document_json, '$.beliefState', 'deprecated') WHERE id = ?").run(
        deprecatedId,
      );
      seedUnit(db, {
        entryId: deprecatedId,
        ordinal: 0,
        fragmentId: null,
        hash: "hDeprecated",
        kind: "card",
        text: "widget widget widget widget widget widget widget widget widget widget",
      });

      const liveIds: number[] = [];
      for (let i = 0; i < 40; i++) {
        const id = insertEntry(db, `live-entry-${i}`);
        liveIds.push(id);
        seedUnit(db, {
          entryId: id,
          ordinal: 0,
          fragmentId: null,
          hash: `hLive${i}`,
          kind: "card",
          text: `entry number ${i} briefly references a widget once among a long run of unrelated padding text that is otherwise about nothing in particular here`,
        });
      }

      const lexicalHits = searchUnitsLexical(db, "widget", 200);
      const fused = fuseByEntry(db, lexicalHits, [], []);
      applyRankingRules({ db, query: "widget", items: fused, graphContext: null });

      const deprecated = fused.find((r) => r.id === deprecatedId)!;
      const liveResults = fused.filter((r) => liveIds.includes(r.id));
      expect(liveResults.length).toBe(40);
      expect(deprecated.score).toBeCloseTo(0.28, 10);
      for (const live of liveResults) {
        expect(live.score).toBeGreaterThan(deprecated.score);
      }
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
