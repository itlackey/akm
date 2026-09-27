// Opens a real index.db to verify atomic publication of the parent FTS row and
// its fragment source. Fragments are a write-side projection that `akm show`
// reads; search ranks whole documents and never selects a fragment.
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { splitMarkdownFragments } from "../../../src/core/asset/markdown-fragments";
import { deriveEntryProvenance } from "../../../src/indexer/installations";
import {
  type IndexDocument,
  projectMarkdownFragmentContent,
  setMarkdownFragmentContent,
} from "../../../src/indexer/passes/metadata";
import { buildSearchText } from "../../../src/indexer/search/search-fields";
import type { Database } from "../../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import { searchFts } from "../../../src/storage/repositories/index-fts-repository";

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

describe("Markdown fragment publication (#937)", () => {
  test("replaces parent and fragment rows atomically on incremental update", () => {
    const db = open();
    try {
      put(db, "replace", "oldfragmentmarker");
      put(db, "replace", "newfragmentmarker");
      expect(searchFts(db, "oldfragmentmarker", 5)).toHaveLength(0);
      expect(searchFts(db, "newfragmentmarker", 5)[0]?.itemRef).toBe("fixture//knowledge/replace");
    } finally {
      closeDatabase(db);
    }
  });

  test("rolls back entry, parent FTS, and fragment source together on a fragment write failure", () => {
    const db = open();
    try {
      put(db, "atomic", "oldatomicmarker");
      const before = ["entries", "entries_fts", "entry_fragments"].map((table) => rowCount(db, table));
      const [beforeEntries, beforeParentFts, beforeFragmentSource] = before;
      // Fail after replacement removed the old FTS row, while all three
      // surfaces still exist, so the savepoint rollback is observable end to end.
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
      expect(searchFts(db, "oldatomicmarker", 5)[0]?.itemRef).toBe("fixture//knowledge/atomic");
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
      expect(searchFts(db, "parentonlymarker", 5)[0]?.itemRef).toBe("fixture//knowledge/transition");

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
      expect(searchFts(db, "nativemarkernonmarkdown", 5)[0]?.itemRef).toBe("fixture//scripts/plain-script");
      expect(rowCount(db, "entry_fragments")).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });

  test("identical reindexes keep one parent FTS row and preserve structured parent fields", () => {
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
      for (let run = 0; run < 2; run++) {
        setMarkdownFragmentContent(entry, projectMarkdownFragmentContent(body));
        upsertEntry(db, "/fixture/knowledge/structured.md", entry, buildSearchText(entry), provenance);
        expect(searchFts(db, "deterministicmarker", 5).map((hit) => hit.itemRef)).toEqual([
          "fixture//knowledge/structured",
        ]);
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
