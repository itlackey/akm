// SPDX-License-Identifier: MPL-2.0
//
// #624 P3 (RED): TDD failing tests for the lazy graph-extraction queue
// accessors (`enqueueGraphExtraction` / `drainExtractionQueue`) and the
// per-file extractor (`extractGraphForSingleFile`).
//
// The feature does NOT exist yet — these tests assert the target behavior and
// MUST fail now for the RIGHT reason: the `graph_extraction_queue` table and
// the new exported functions are absent. Named imports of the absent functions
// would abort the whole file at module load (Bun ESM), so the not-yet-exported
// symbols are accessed via the module namespace and resolve to `undefined`
// today (call -> "not a function" -> RED for the right reason). After P3 lands
// the casts resolve to the real exports.
//
// P3 is OPT-IN / DEFAULT-PRESERVING: nothing here exercises a real
// LLM/spawn/serve and no test exceeds a few ms, so this is a UNIT test and
// lives in tests/ (not tests/integration/). Uses sandbox helpers; never touches
// host state. Run this file individually before any full-suite gate.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { closeDatabase, computeBodyHash, openIndexDatabase, upsertEntry } from "../src/indexer/db/db";
import * as graphDb from "../src/indexer/db/graph-db";
import { loadGraphFilesOnly, replaceStoredGraph } from "../src/indexer/db/graph-db";
import type { GraphFile } from "../src/indexer/graph/graph-extraction";
import * as graphExtraction from "../src/indexer/graph/graph-extraction";
import type { Database } from "../src/storage/database";
import { makeStashDir, type SandboxedDir } from "./_helpers/sandbox";

// ── Deferred (not-yet-exported) P3 symbols ───────────────────────────────────
//
// Accessed via the namespace so the file LOADS while the exports are absent.

// NOTE: the casts declare the symbols as REQUIRED (non-optional) so the file
// type-checks while the real exports are still absent — at runtime they resolve
// to `undefined` and the first call throws "not a function" (RED for the right
// reason). Same pattern as tests/graph-extraction-topn.test.ts (#624-P2).
const enqueueGraphExtraction = (
  graphDb as unknown as {
    enqueueGraphExtraction: (
      db: Database,
      stashRoot: string,
      filePath: string,
      bodyHash: string,
      priority?: number,
    ) => void;
  }
).enqueueGraphExtraction;

const drainExtractionQueue = (
  graphDb as unknown as {
    drainExtractionQueue: (
      db: Database,
      stashRoot: string,
      limit: number,
    ) => Array<{ filePath: string; bodyHash: string; priority: number }>;
  }
).drainExtractionQueue;

type LlmOverride = (body: string) => Promise<{
  entities: string[];
  relations: Array<{ from: string; to: string; type?: string; confidence?: number }>;
  confidence?: number;
}>;

const extractGraphForSingleFile = (
  graphExtraction as unknown as {
    extractGraphForSingleFile: (
      db: Database,
      stashRoot: string,
      filePath: string,
      bodyHash?: string,
      opts?: { llmOverride?: LlmOverride; signal?: AbortSignal },
    ) => Promise<boolean>;
  }
).extractGraphForSingleFile;

// ── Sandbox plumbing ─────────────────────────────────────────────────────────

let stash: SandboxedDir;
let dbPath: string;
let db: Database;

beforeEach(() => {
  stash = makeStashDir();
  dbPath = path.join(stash.dir, "index.db");
  db = openIndexDatabase(dbPath);
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
 * True iff a real graph_files row exists for (stashRoot, filePath). Used for
 * exact present/absent assertions instead of hasGraphData(): Bun's `.get()`
 * returns `null` (not `undefined`) for a no-row query and hasGraphData compares
 * `row !== undefined`, so it cannot reliably express "no graph row".
 */
function graphFileRowExists(stashRoot: string, filePath: string): boolean {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM graph_files WHERE stash_root = ? AND file_path = ?")
    .get(stashRoot, filePath) as { n: number };
  return row.n > 0;
}

function queueRowCount(stashRoot: string): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM graph_extraction_queue WHERE stash_root = ?").get(stashRoot) as {
    n: number;
  };
  return row.n;
}

/**
 * Write an eligible markdown memory on disk + seed its entries row, returning
 * the absolute path. extractGraphForSingleFile reads the body from disk.
 */
function makeEligibleMemory(slug: string, body: string): string {
  const memDir = path.join(stash.dir, "memories");
  fs.mkdirSync(memDir, { recursive: true });
  const absPath = path.join(memDir, `${slug}.md`);
  fs.writeFileSync(absPath, `---\ntype: memory\n---\n${body}\n`);
  const entry = { name: slug, type: "memory", filename: `${slug}.md` } as Parameters<typeof upsertEntry>[5];
  upsertEntry(db, `${stash.dir}:memory:${slug}`, memDir, absPath, stash.dir, entry, slug);
  return absPath;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — enqueue / drain accessors
// ─────────────────────────────────────────────────────────────────────────────

describe("#624 P3 enqueueGraphExtraction / drainExtractionQueue (AC1)", () => {
  test("enqueueGraphExtraction inserts one queue row", () => {
    expect(typeof enqueueGraphExtraction).toBe("function");
    enqueueGraphExtraction(db, stash.dir, "/a.md", "hashA", 0);
    expect(queueRowCount(stash.dir)).toBe(1);
  });

  test("idempotent on (stash_root,file_path) — second enqueue leaves exactly one row", () => {
    enqueueGraphExtraction(db, stash.dir, "/a.md", "hashA", 0);
    enqueueGraphExtraction(db, stash.dir, "/a.md", "hashA2", 0);
    expect(queueRowCount(stash.dir)).toBe(1);
    const row = db
      .prepare("SELECT body_hash FROM graph_extraction_queue WHERE stash_root = ? AND file_path = ?")
      .get(stash.dir, "/a.md") as { body_hash: string };
    // ON CONFLICT updates body_hash to the latest enqueued value.
    expect(row.body_hash).toBe("hashA2");
  });

  test("re-enqueue keeps the HIGHER priority (MAX of existing/new)", () => {
    enqueueGraphExtraction(db, stash.dir, "/a.md", "hashA", 5);
    enqueueGraphExtraction(db, stash.dir, "/a.md", "hashA", 1);
    const row = db
      .prepare("SELECT priority FROM graph_extraction_queue WHERE stash_root = ? AND file_path = ?")
      .get(stash.dir, "/a.md") as { priority: number };
    expect(row.priority).toBe(5);
  });

  test("drainExtractionQueue returns rows highest-priority-first then oldest queued_at", () => {
    enqueueGraphExtraction(db, stash.dir, "/low.md", "h1", 0);
    enqueueGraphExtraction(db, stash.dir, "/high.md", "h2", 10);
    enqueueGraphExtraction(db, stash.dir, "/mid.md", "h3", 5);

    const drained = drainExtractionQueue(db, stash.dir, 10);
    expect(drained.map((r) => r.filePath)).toEqual(["/high.md", "/mid.md", "/low.md"]);
  });

  test("drainExtractionQueue respects limit and deletes the drained rows", () => {
    enqueueGraphExtraction(db, stash.dir, "/a.md", "h1", 3);
    enqueueGraphExtraction(db, stash.dir, "/b.md", "h2", 2);
    enqueueGraphExtraction(db, stash.dir, "/c.md", "h3", 1);

    const first = drainExtractionQueue(db, stash.dir, 2);
    expect(first.map((r) => r.filePath)).toEqual(["/a.md", "/b.md"]);
    // The two highest-priority rows are gone; only the lowest remains.
    expect(queueRowCount(stash.dir)).toBe(1);

    const second = drainExtractionQueue(db, stash.dir, 10);
    expect(second.map((r) => r.filePath)).toEqual(["/c.md"]);
    expect(queueRowCount(stash.dir)).toBe(0);
  });

  test("drainExtractionQueue is scoped per stash_root", () => {
    enqueueGraphExtraction(db, stash.dir, "/a.md", "h1", 0);
    enqueueGraphExtraction(db, "/other/stash", "/b.md", "h2", 0);
    const drained = drainExtractionQueue(db, stash.dir, 10);
    expect(drained.map((r) => r.filePath)).toEqual(["/a.md"]);
    // The other stash's row is untouched.
    expect(queueRowCount("/other/stash")).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — extractGraphForSingleFile (injected LLM seam)
// ─────────────────────────────────────────────────────────────────────────────

describe("#624 P3 extractGraphForSingleFile (AC2)", () => {
  test("extracts + stores one file's graph via the injected LLM seam", async () => {
    expect(typeof extractGraphForSingleFile).toBe("function");
    const absPath = makeEligibleMemory("target", "Alice works with Bob on Project X.");

    const llmOverride: LlmOverride = async () => ({
      entities: ["Alice", "Bob", "Project X"],
      relations: [{ from: "Alice", to: "Bob", type: "works_with" }],
    });

    const ok = await extractGraphForSingleFile(db, stash.dir, absPath, undefined, { llmOverride });
    expect(ok).toBe(true);

    // A graph_files row now exists for this path.
    expect(graphFileRowExists(stash.dir, absPath)).toBe(true);

    // Its entities are persisted under the file's body_hash.
    const bodyText = fs.readFileSync(absPath, "utf8");
    // body_hash is computed over the PARSED body, so match by file_path only.
    const files = loadGraphFilesOnly(stash.dir, db);
    const stored = files.find((f) => f.path === absPath);
    expect(stored).toBeDefined();
    const entityRows = db
      .prepare("SELECT entity FROM graph_file_entities WHERE stash_root = ? AND file_path = ? ORDER BY entity_order")
      .all(stash.dir, absPath) as Array<{ entity: string }>;
    expect(entityRows.map((r) => r.entity)).toEqual(["Alice", "Bob", "Project X"]);
    // Keep bodyText referenced (sanity that the file is real on disk).
    expect(bodyText.length).toBeGreaterThan(0);
  });

  test("merges — extracting one file does NOT clobber another file's existing graph", async () => {
    const otherPath = makeEligibleMemory("other", "Carol leads Team Y.");
    const targetPath = makeEligibleMemory("target", "Dave ships Widget Z.");

    // Pre-seed an existing graph row for `other` directly (simulating a prior pass).
    const otherBodyHash = computeBodyHash("Carol leads Team Y.");
    const preExisting: GraphFile = {
      schemaVersion: 3,
      generatedAt: new Date().toISOString(),
      stashRoot: stash.dir,
      files: [
        {
          path: otherPath,
          type: "memory",
          bodyHash: otherBodyHash,
          entities: ["Carol", "Team Y"],
          relations: [{ from: "Carol", to: "Team Y", type: "leads" }],
          status: "extracted",
        },
      ],
      entities: ["Carol", "Team Y"],
      relations: [{ from: "Carol", to: "Team Y", type: "leads" }],
    };
    replaceStoredGraph(db, preExisting);
    expect(graphFileRowExists(stash.dir, otherPath)).toBe(true);

    const llmOverride: LlmOverride = async () => ({
      entities: ["Dave", "Widget Z"],
      relations: [{ from: "Dave", to: "Widget Z", type: "ships" }],
    });
    const ok = await extractGraphForSingleFile(db, stash.dir, targetPath, undefined, { llmOverride });
    expect(ok).toBe(true);

    // Both files now have graph data — the merge preserved `other`.
    expect(graphFileRowExists(stash.dir, otherPath)).toBe(true);
    expect(graphFileRowExists(stash.dir, targetPath)).toBe(true);

    // `other`'s entities are intact (not clobbered).
    const otherEntities = db
      .prepare("SELECT entity FROM graph_file_entities WHERE stash_root = ? AND file_path = ? ORDER BY entity_order")
      .all(stash.dir, otherPath) as Array<{ entity: string }>;
    expect(otherEntities.map((r) => r.entity)).toEqual(["Carol", "Team Y"]);
  });

  test("re-reads body from disk and skips silently when the file is gone", async () => {
    const absPath = makeEligibleMemory("ghost", "transient body");
    fs.rmSync(absPath, { force: true });

    let called = false;
    const llmOverride: LlmOverride = async () => {
      called = true;
      return { entities: ["X"], relations: [] };
    };
    const ok = await extractGraphForSingleFile(db, stash.dir, absPath, undefined, { llmOverride });
    // Missing file => no extraction, no LLM call, no graph row, no throw.
    expect(ok).toBe(false);
    expect(called).toBe(false);
    expect(graphFileRowExists(stash.dir, absPath)).toBe(false);
  });
});
