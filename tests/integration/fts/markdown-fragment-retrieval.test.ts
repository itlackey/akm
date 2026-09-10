// Opens a real index.db to verify atomic parent + fragment FTS publication.
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fragmentForSelector, splitMarkdownFragments } from "../../../src/core/asset/markdown-fragments";
import { stableFtsScore } from "../../../src/core/lexical-score";
import { deriveEntryProvenance } from "../../../src/indexer/installations";
import {
  type IndexDocument,
  projectMarkdownFragmentContent,
  setMarkdownFragmentContent,
} from "../../../src/indexer/passes/metadata";
import { applyRankingRules } from "../../../src/indexer/search/ranking";
import { buildSearchText } from "../../../src/indexer/search/search-fields";
import type { Database } from "../../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import { getIndexedMarkdownFragments, searchFts } from "../../../src/storage/repositories/index-fts-repository";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function open(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-fragment-"));
  dirs.push(dir);
  return openIndexDatabase(path.join(dir, "index.db"));
}

function put(db: Database, name: string, body: string, description = "ordinary metadata"): void {
  const entry: IndexDocument = { name, type: "knowledge", description, content: body.replace(/[#\n]/g, " ") };
  setMarkdownFragmentContent(entry, projectMarkdownFragmentContent(body));
  upsertEntry(
    db,
    `/fixture/knowledge/${name}.md`,
    entry,
    buildSearchText(entry),
    deriveEntryProvenance({ bundleId: "fixture", componentId: "fixture", adapterId: "akm" }, "knowledge", name),
  );
}

describe("isolated lexical Markdown fragments (#937)", () => {
  test("returns a selector only for an independently matching fragment and round-trips it", () => {
    const db = open();
    try {
      const body = [
        "# Intro",
        "",
        Array.from({ length: 500 }, () => "ordinary background prose").join(" "),
        "",
        "# Evidence",
        "",
        "rarefragmenttoken carries proof",
      ].join("\n");
      put(db, "note", body);
      const hit = searchFts(db, "rarefragmenttoken", 5)[0];
      expect(hit?.fragmentId).toMatch(/^akm-fragment-/);
      const safe = projectMarkdownFragmentContent(body)!;
      expect(fragmentForSelector(safe, hit!.fragmentId!)?.text).toContain("rarefragmenttoken");
    } finally {
      closeDatabase(db);
    }
  });

  test("calibrates separate parent and fragment BM25 populations before merging", () => {
    const db = open();
    try {
      put(
        db,
        "buried",
        `${Array.from({ length: 1200 }, () => "background prose").join(" ")}\n\nrarecalibrationtoken proof`,
      );
      const parent = db
        .prepare("SELECT bm25(entries_fts, 0, 10, 5, 3, 2, 1) AS score FROM entries_fts WHERE entries_fts MATCH ?")
        .get("rarecalibrationtoken") as { score: number };
      const fragment = db
        .prepare("SELECT bm25(entry_fragments_fts) AS score FROM entry_fragments_fts WHERE entry_fragments_fts MATCH ?")
        .get("rarecalibrationtoken") as { score: number };
      // These are two FTS corpora, so raw magnitudes are evidence only, not a
      // shared ordering. The fixed population-aware mapping is what the merge
      // consumes; a short decisive fragment beats its length-penalized parent.
      expect(parent.score).toBeLessThan(0);
      expect(fragment.score).toBeLessThan(0);
      expect(stableFtsScore(fragment.score, "fragment")).toBeGreaterThan(stableFtsScore(parent.score, "parent"));
      expect(searchFts(db, "rarecalibrationtoken", 5)[0]?.fragmentId).toMatch(/^akm-fragment-/);
    } finally {
      closeDatabase(db);
    }
  });

  test("keeps metadata + later-body conjunction on the parent and metadata-only hits selector-free", () => {
    const db = open();
    try {
      const body = ["# First", "alpha only", "", "# Later", "bodyonlymarker later"].join("\n");
      put(db, "note", body, "metadatamarker description");
      expect(searchFts(db, "metadatamarker", 5)[0]?.fragmentId).toBeUndefined();
      // No one fragment holds both terms, so the established parent FTS row is
      // responsible for the conjunction and no misleading selector is emitted.
      expect(searchFts(db, "metadatamarker bodyonlymarker", 5)[0]?.fragmentId).toBeUndefined();
    } finally {
      closeDatabase(db);
    }
  });

  test("scans past many matching fragments from one parent to fill distinct parents", () => {
    const db = open();
    try {
      put(db, "monopoly", Array.from({ length: 80 }, (_, i) => `needle monopoly paragraph ${i}\n\n`).join(""));
      put(db, "other-a", "needle other alpha");
      put(db, "other-b", "needle other beta");
      const names = searchFts(db, "needle", 3).map((hit) => hit.entry.name);
      expect(new Set(names).size).toBe(3);
      expect(names).toContain("other-a");
      expect(names).toContain("other-b");
    } finally {
      closeDatabase(db);
    }
  });

  test("keeps every tied distinct fragment parent for downstream ranking", () => {
    const db = open();
    try {
      for (const name of ["fragment-a", "fragment-b", "fragment-c"]) {
        // The parent projection deliberately does not contain the needle: this
        // exercises the fragment boundary rather than inheriting parent FTS's
        // already-covered #940 expansion.
        const entry: IndexDocument = { name, type: "knowledge", content: "ordinary parent text" };
        setMarkdownFragmentContent(entry, projectMarkdownFragmentContent("fragmentboundary proof"));
        upsertEntry(
          db,
          `/fixture/knowledge/${name}.md`,
          entry,
          buildSearchText(entry),
          deriveEntryProvenance({ bundleId: "fixture", componentId: "fixture", adapterId: "akm" }, "knowledge", name),
        );
      }
      expect(searchFts(db, "fragmentboundary", 1).map((hit) => hit.entry.name)).toEqual([
        "fragment-a",
        "fragment-b",
        "fragment-c",
      ]);
    } finally {
      closeDatabase(db);
    }
  });

  test("uses a single SQLite parent-window plan under broad monopoly pressure", () => {
    const db = open();
    try {
      const longParagraph = `broadneedle ${"filler ".repeat(260)}`;
      put(db, "monopoly-window", Array.from({ length: 90 }, () => longParagraph).join("\n\n"));
      for (let index = 0; index < 40; index++) put(db, `parent-${index}`, `broadneedle parent ${index}`);
      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN WITH matches AS MATERIALIZED (
             SELECT e.id, f.fragment_id, f.fragment_ordinal, bm25(entry_fragments_fts) AS bm25Score
             FROM entry_fragments_fts f JOIN entries e ON e.id = f.entry_id
             WHERE entry_fragments_fts MATCH ?
           ), ranked AS MATERIALIZED (
             SELECT *, ROW_NUMBER() OVER (PARTITION BY id ORDER BY bm25Score, fragment_ordinal, fragment_id) AS parentRank FROM matches
           ), parents AS MATERIALIZED (
             SELECT * FROM ranked WHERE parentRank = 1
           ), boundary AS (
             SELECT bm25Score FROM parents ORDER BY bm25Score LIMIT 1 OFFSET ?
           ) SELECT e.id, e.document_json
             FROM parents JOIN entries e ON e.id = parents.id
             WHERE NOT EXISTS (SELECT 1 FROM boundary)
                OR parents.bm25Score <= (SELECT bm25Score FROM boundary)
             ORDER BY parents.bm25Score, parents.id`,
        )
        .all("broadneedle", 9) as Array<{ detail: string }>;
      expect(plan.some((row) => /VIRTUAL TABLE|entry_fragments_fts/i.test(row.detail))).toBe(true);
      const started = performance.now();
      const hits = searchFts(db, "broadneedle", 10);
      const elapsedMs = performance.now() - started;
      // The tie-preserving candidate rule may return more than K distinct
      // parents, but a fragmented monopoly still cannot consume a parent slot.
      expect(new Set(hits.map((hit) => hit.id)).size).toBeGreaterThanOrEqual(10);
      // CI budget, deliberately roomy; this catches a return to client OFFSET
      // pagination without encoding machine-specific microbenchmarks.
      expect(elapsedMs).toBeLessThan(1000);
    } finally {
      closeDatabase(db);
    }
  });

  test("batch-enriches selected fragment provenance within a bounded p95 cost", () => {
    const db = open();
    try {
      for (let index = 0; index < 20; index++) {
        const name = `enrichment-${index}`;
        const safeBody = Array.from(
          { length: 30 },
          (_, ordinal) =>
            `## Turn ${ordinal + 1}\nbatchedneedle parent ${index} turn ${ordinal} ${"context ".repeat(80)}`,
        ).join("\n\n");
        const entry: IndexDocument = { name, type: "knowledge", content: "ordinary parent projection" };
        setMarkdownFragmentContent(entry, safeBody);
        upsertEntry(
          db,
          `/fixture/knowledge/${name}.md`,
          entry,
          buildSearchText(entry),
          deriveEntryProvenance({ bundleId: "fixture", componentId: "fixture", adapterId: "akm" }, "knowledge", name),
        );
      }
      const hits = searchFts(db, "batchedneedle", 20);
      const selections = hits.flatMap((hit) =>
        hit.fragmentId ? [{ itemRef: hit.itemRef, fragmentId: hit.fragmentId }] : [],
      );
      expect(selections).toHaveLength(20);

      const timings: number[] = [];
      let enriched: ReturnType<typeof getIndexedMarkdownFragments> = [];
      for (let run = 0; run < 25; run++) {
        const started = performance.now();
        enriched = getIndexedMarkdownFragments(db, selections);
        timings.push(performance.now() - started);
      }
      const p95 = timings.sort((left, right) => left - right)[Math.floor(timings.length * 0.95)]!;
      expect(enriched).toHaveLength(20);
      expect(enriched.every((fragment) => fragment?.count === 30)).toBe(true);
      // Deliberately roomy CI budget: catches an accidental return to one
      // query or repeated full-parent split per selected fragment.
      expect(p95).toBeLessThan(1000);
    } finally {
      closeDatabase(db);
    }
  });

  test("replaces parent and fragment rows atomically on incremental update", () => {
    const db = open();
    try {
      put(db, "replace", "oldfragmentmarker");
      put(db, "replace", "newfragmentmarker");
      expect(searchFts(db, "oldfragmentmarker", 5)).toHaveLength(0);
      expect(searchFts(db, "newfragmentmarker", 5)[0]?.entry.name).toBe("replace");
    } finally {
      closeDatabase(db);
    }
  });

  test("rolls back entry, parent FTS, fragment source, and fragment FTS together on a fragment write failure", () => {
    const db = open();
    try {
      put(db, "atomic", "oldatomicmarker");
      const before = ["entries", "entries_fts", "entry_fragments", "entry_fragments_fts"].map((table) =>
        rowCount(db, table),
      );
      const [beforeEntries, beforeParentFts, beforeFragmentSource, beforeFragmentFts] = before;
      // Fail after replacement removed old FTS rows, while all four surfaces
      // still exist, so the savepoint rollback is observable end to end.
      db.exec(`
        CREATE TRIGGER abort_fragment_source BEFORE INSERT ON entry_fragments
        WHEN NEW.safe_markdown LIKE '%newatomicmarker%'
        BEGIN SELECT RAISE(ABORT, 'injected fragment publication failure'); END;
      `);
      expect(() => put(db, "atomic", "newatomicmarker")).toThrow();
      // The failed replacement is isolated in upsertEntry's savepoint: the
      // parent row and its old derived surfaces remain mutually consistent.
      expect(rowCount(db, "entries")).toBe(beforeEntries!);
      expect(rowCount(db, "entries_fts")).toBe(beforeParentFts!);
      expect(rowCount(db, "entry_fragments")).toBe(beforeFragmentSource!);
      expect(rowCount(db, "entry_fragments_fts")).toBe(beforeFragmentFts!);
      expect(searchFts(db, "oldatomicmarker", 5)[0]?.entry.name).toBe("atomic");
    } finally {
      closeDatabase(db);
    }
  });

  test("clears Markdown fragments deliberately and keeps non-Markdown parent search unchanged", () => {
    const db = open();
    try {
      put(db, "transition", "oldtransitionmarker");
      const cleared: IndexDocument = { name: "transition", type: "knowledge", content: "parentonlymarker" };
      // An observed Markdown scan with no safe body is explicit null/clear,
      // unlike a metadata-only re-upsert which leaves stored fragments alone.
      setMarkdownFragmentContent(cleared, undefined);
      upsertEntry(
        db,
        "/fixture/knowledge/transition.md",
        cleared,
        buildSearchText(cleared),
        deriveEntryProvenance(
          { bundleId: "fixture", componentId: "fixture", adapterId: "akm" },
          "knowledge",
          "transition",
        ),
      );
      expect(rowCount(db, "entry_fragments")).toBe(0);
      expect(searchFts(db, "oldtransitionmarker", 5)).toHaveLength(0);
      expect(searchFts(db, "parentonlymarker", 5)[0]?.fragmentId).toBeUndefined();

      const script: IndexDocument = { name: "plain-script", type: "script", content: "nativemarkernonmarkdown" };
      upsertEntry(
        db,
        "/fixture/scripts/plain-script.ts",
        script,
        buildSearchText(script),
        deriveEntryProvenance(
          { bundleId: "fixture", componentId: "fixture", adapterId: "akm" },
          "script",
          "plain-script",
        ),
      );
      expect(searchFts(db, "nativemarkernonmarkdown", 5)[0]?.fragmentId).toBeUndefined();
      expect(rowCount(db, "entry_fragments")).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });

  test("keeps the same winning selector across identical reindexes and preserves structured parent fields once", () => {
    const db = open();
    try {
      const body = `${Array.from({ length: 400 }, () => "background").join(" ")}\n\ndeterministicmarker proof`;
      const entry: IndexDocument = {
        name: "structured",
        type: "knowledge",
        content: body,
        toc: [{ level: 1, text: "Stable", line: 1 }],
        parameters: [{ name: "region", description: "deployment region" }],
      };
      const provenance = deriveEntryProvenance(
        { bundleId: "fixture", componentId: "fixture", adapterId: "akm" },
        "knowledge",
        "structured",
      );
      let firstSelector: string | undefined;
      for (let run = 0; run < 2; run++) {
        setMarkdownFragmentContent(entry, projectMarkdownFragmentContent(body));
        upsertEntry(db, "/fixture/knowledge/structured.md", entry, buildSearchText(entry), provenance);
        const hit = searchFts(db, "deterministicmarker", 5)[0];
        if (run === 0) expect(hit?.fragmentId).toBeDefined();
        else expect(hit?.fragmentId).toBe(firstSelector);
        if (run === 0) firstSelector = hit?.fragmentId;
      }
      expect(rowCount(db, "entries_fts")).toBe(1);
      const parent = db
        .prepare("SELECT document_json FROM entries WHERE item_ref = ?")
        .get("fixture//knowledge/structured") as { document_json: string };
      expect(JSON.parse(parent.document_json)).toMatchObject({ toc: entry.toc, parameters: entry.parameters });
    } finally {
      closeDatabase(db);
    }
  });

  test("many matching fragments contribute parent ranking signals exactly once", () => {
    const db = open();
    try {
      const repeated = Array.from({ length: 90 }, () => `contributorneedle ${"filler ".repeat(260)}`).join("\n\n");
      put(db, "many-fragments", repeated);
      const result = searchFts(db, "contributorneedle", 5);
      expect(result).toHaveLength(1);
      const hit = result[0]!;
      const ranked = applyRankingRules({
        db,
        query: "contributorneedle",
        graphContext: null,
        items: [
          {
            id: hit.id,
            entry: { ...hit.entry, quality: "curated" },
            filePath: hit.filePath,
            score: 0.5,
            rankingMode: "fts",
            lexicalMatch: hit.lexicalMatch,
          },
        ],
      });
      expect(ranked).toHaveLength(1);
      // One parent item reaches contributor application regardless of 90
      // matching children; the fixed curated contribution is therefore not
      // multiplied by fragment count.
      expect(ranked[0]!.score).toBeCloseTo(0.635, 6);
    } finally {
      closeDatabase(db);
    }
  });
});

function rowCount(db: Database, table: string): number {
  return (db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count;
}

describe("Markdown fragment substrate", () => {
  test("preserves preamble/duplicate headings and real source lines while removing unsafe bytes", () => {
    const raw = [
      "---",
      "description: fixture",
      "---",
      "preamble evidence",
      "",
      "# Same",
      "first heading evidence",
      "",
      "# Same",
      "second heading evidence",
      "",
      "```text",
      "FENCED_SECRET",
      "```",
      "[private]: https://secret.invalid/token",
    ].join("\n");
    const safe = projectMarkdownFragmentContent(raw)!;
    const fragments = splitMarkdownFragments(safe);
    expect(fragments.map((fragment) => fragment.startLine)).toContain(4);
    expect(fragments.find((fragment) => fragment.text.includes("first heading"))?.headingSlug).toBe("same");
    expect(fragments.find((fragment) => fragment.text.includes("second heading"))?.headingSlug).toBe("same-1");
    expect(safe).not.toContain("FENCED_SECRET");
    expect(safe).not.toContain("secret.invalid");
  });

  test("uses paragraph then word windows for headingless oversized transcripts", () => {
    const raw = Array.from({ length: 300 }, (_, index) => `Transcript ${index} carries ordinary evidence.`).join(
      "\n\n",
    );
    const fragments = splitMarkdownFragments(projectMarkdownFragmentContent(raw)!);
    expect(fragments.length).toBeGreaterThan(2);
    expect(fragments.every((fragment) => fragment.fragmentId.startsWith("akm-fragment-"))).toBe(true);
    expect(fragments.some((fragment) => fragment.text.includes("Transcript 150"))).toBe(true);
  });

  test("keeps friendly selectors for many independent headed sections", () => {
    const count = 1_200;
    const raw = Array.from({ length: count }, (_, index) => `## Heading ${index}\nproof ${index}`).join("\n\n");
    const fragments = splitMarkdownFragments(raw);
    expect(fragments).toHaveLength(count);
    expect(fragments.map((fragment) => fragment.headingSlug)).toEqual(
      Array.from({ length: count }, (_, index) => `heading-${index}`),
    );
  });

  test("caps single-line word windows while retaining their source-line range", () => {
    const fragments = splitMarkdownFragments(`line ${"word ".repeat(1000)}`, 100);
    expect(fragments.length).toBeGreaterThan(2);
    expect(fragments.every((fragment) => fragment.text.length <= 100)).toBe(true);
    expect(fragments.every((fragment) => fragment.startLine === 1 && fragment.endLine === 1)).toBe(true);
  });
});
