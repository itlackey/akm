// SPDX-License-Identifier: MPL-2.0
//
// #624 P3: tests for the lazy graph-extraction queue accessors
// (`enqueueGraphExtraction` / `peekExtractionQueue` / acknowledgement) and the per-file
// extractor (`extractGraphForSingleFile`), backed by the
// `graph_extraction_queue` table. Symbols are accessed via the module namespace
// for ESM-safety.
//
// P3 is OPT-IN / DEFAULT-PRESERVING: nothing here exercises a real
// LLM/spawn/serve and no test exceeds a few ms. It DOES open a real SQLite
// database (openIndexDatabase) and read/write real files in a sandboxed temp
// dir (makeStashDir), so — unlike a pure in-memory unit test — it correctly
// lives here in tests/integration/, not tests/. Uses sandbox helpers; never
// touches host state. Run this file individually before any full-suite gate.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../../../src/core/config/config";
import { ConfigError } from "../../../src/core/errors";
import * as graphDb from "../../../src/indexer/db/graph-db";
import { loadGraphFilesOnly, replaceStoredGraph } from "../../../src/indexer/db/graph-db";
import * as graphExtraction from "../../../src/indexer/graph/graph-extraction";
import type { GraphFile } from "../../../src/indexer/graph/graph-types";
import { deriveEntryProvenance } from "../../../src/indexer/installations";
import type { Database } from "../../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import { computeBodyHash } from "../../../src/storage/repositories/index-llm-cache-repository";
import { makeStashDir, type SandboxedDir, withEnv } from "../../_helpers/sandbox";

// ── Deferred (not-yet-exported) P3 symbols ───────────────────────────────────
//
// Accessed via the namespace so the file LOADS while the exports are absent.

// Accessed via namespace casts for ESM-safety; they resolve to the real
// exports. Same pattern as tests/graph-extraction-topn.test.ts (#624-P2).
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

const peekExtractionQueue = (
  graphDb as unknown as {
    peekExtractionQueue: (
      db: Database,
      stashRoot: string,
      limit: number,
    ) => Array<{ filePath: string; bodyHash: string; priority: number }>;
  }
).peekExtractionQueue;

const acknowledgeExtractionQueueEntry = (
  graphDb as unknown as {
    acknowledgeExtractionQueueEntry: (db: Database, stashRoot: string, filePath: string, bodyHash: string) => boolean;
  }
).acknowledgeExtractionQueueEntry;

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
      opts?: { llmOverride?: LlmOverride; signal?: AbortSignal; config?: AkmConfig },
    ) => Promise<boolean>;
  }
).extractGraphForSingleFile;

const runGraphExtractionPass = (
  graphExtraction as unknown as {
    runGraphExtractionPass: typeof graphExtraction.runGraphExtractionPass;
  }
).runGraphExtractionPass;

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
  const entry = { name: slug, type: "memory", filename: `${slug}.md` };
  const provenance = deriveEntryProvenance(
    { bundleId: "stash", componentId: "stash", adapterId: "akm" },
    entry.type,
    slug,
  );
  upsertEntry(db, absPath, entry, slug, provenance);
  return absPath;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — enqueue / peek / acknowledge accessors
// ─────────────────────────────────────────────────────────────────────────────

describe("#624 P3 enqueueGraphExtraction / peekExtractionQueue (AC1)", () => {
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

  test("acknowledging an older revision preserves a concurrent re-enqueue", () => {
    enqueueGraphExtraction(db, stash.dir, "/a.md", "hashA", 5);
    enqueueGraphExtraction(db, stash.dir, "/a.md", "hashA2", 5);

    expect(acknowledgeExtractionQueueEntry(db, stash.dir, "/a.md", "hashA")).toBe(false);
    const row = db
      .prepare("SELECT body_hash FROM graph_extraction_queue WHERE stash_root = ? AND file_path = ?")
      .get(stash.dir, "/a.md") as { body_hash: string };
    expect(row.body_hash).toBe("hashA2");
  });

  test("peekExtractionQueue returns rows highest-priority-first then oldest queued_at", () => {
    enqueueGraphExtraction(db, stash.dir, "/low.md", "h1", 0);
    enqueueGraphExtraction(db, stash.dir, "/high.md", "h2", 10);
    enqueueGraphExtraction(db, stash.dir, "/mid.md", "h3", 5);

    const peeked = peekExtractionQueue(db, stash.dir, 10);
    expect(peeked.map((r) => r.filePath)).toEqual(["/high.md", "/mid.md", "/low.md"]);
  });

  test("peekExtractionQueue respects limit and only acknowledged rows leave the queue", () => {
    enqueueGraphExtraction(db, stash.dir, "/a.md", "h1", 3);
    enqueueGraphExtraction(db, stash.dir, "/b.md", "h2", 2);
    enqueueGraphExtraction(db, stash.dir, "/c.md", "h3", 1);

    const first = peekExtractionQueue(db, stash.dir, 2);
    expect(first.map((r) => r.filePath)).toEqual(["/a.md", "/b.md"]);
    // Peeking claims nothing.
    expect(queueRowCount(stash.dir)).toBe(3);
    for (const row of first) {
      expect(acknowledgeExtractionQueueEntry(db, stash.dir, row.filePath, row.bodyHash)).toBe(true);
    }
    // The two highest-priority rows are gone; only the lowest remains.
    expect(queueRowCount(stash.dir)).toBe(1);

    const second = peekExtractionQueue(db, stash.dir, 10);
    expect(second.map((r) => r.filePath)).toEqual(["/c.md"]);
  });

  test("peekExtractionQueue is scoped per stash_root", () => {
    enqueueGraphExtraction(db, stash.dir, "/a.md", "h1", 0);
    enqueueGraphExtraction(db, "/other/stash", "/b.md", "h2", 0);
    const peeked = peekExtractionQueue(db, stash.dir, 10);
    expect(peeked.map((r) => r.filePath)).toEqual(["/a.md"]);
    // The other stash's row is untouched.
    expect(queueRowCount("/other/stash")).toBe(1);
  });

  test("required symbolic credential failure preserves queued work and creates no graph or cache rows", async () => {
    const absPath = makeEligibleMemory("queued-credential", "Alice works with Bob.");
    enqueueGraphExtraction(db, stash.dir, absPath, computeBodyHash("Alice works with Bob."), 10);
    const config: AkmConfig = {
      semanticSearchMode: "off",
      engines: {
        graph: {
          kind: "llm",
          endpoint: "http://127.0.0.1:1/v1/chat/completions",
          model: "never-dispatched",
          apiKey: "$AKM_GRAPH_PASS_REQUIRED_KEY",
        },
      },
      index: { defaults: { engine: "graph" }, graph: { enabled: true, lazyGraphExtraction: true } },
    };

    const failure = withEnv({ AKM_GRAPH_PASS_REQUIRED_KEY: undefined }, () =>
      runGraphExtractionPass({
        config,
        sources: [{ path: stash.dir }],
        db,
        options: { candidatePaths: new Set() },
      }),
    );

    await expect(failure).rejects.toBeInstanceOf(ConfigError);
    expect(queueRowCount(stash.dir)).toBe(1);
    expect(graphFileRowExists(stash.dir, absPath)).toBe(false);
    const cacheRows = (db.prepare("SELECT COUNT(*) AS n FROM llm_enrichment_cache").get() as { n: number }).n;
    expect(cacheRows).toBe(0);
  });

  test("a queued path already covered by the stored graph is acknowledged without materializing credentials", async () => {
    const body = "Alice works with Bob on Project X.";
    const absPath = makeEligibleMemory("queued-hit", body);
    const extracted = await extractGraphForSingleFile(db, stash.dir, absPath, {
      llmOverride: async () => ({
        entities: ["Alice", "Bob", "Project X"],
        relations: [{ from: "Alice", to: "Bob", type: "works_with" }],
      }),
    });
    expect(extracted).toBe(true);
    enqueueGraphExtraction(db, stash.dir, absPath, computeBodyHash(body), 10);
    const graphBefore = loadGraphFilesOnly(stash.dir, db);
    const config: AkmConfig = {
      semanticSearchMode: "off",
      engines: {
        graph: {
          kind: "llm",
          endpoint: "http://127.0.0.1:1/v1/chat/completions",
          model: "never-dispatched",
          apiKey: "$AKM_GRAPH_QUEUE_HIT_REQUIRED_KEY",
        },
      },
      index: { defaults: { engine: "graph" }, graph: { enabled: true, lazyGraphExtraction: true } },
    };

    const result = await withEnv({ AKM_GRAPH_QUEUE_HIT_REQUIRED_KEY: undefined }, () =>
      runGraphExtractionPass({
        config,
        sources: [{ path: stash.dir }],
        db,
        options: { candidatePaths: new Set() },
      }),
    );

    expect(result.written).toBe(false);
    expect(queueRowCount(stash.dir)).toBe(0);
    expect(loadGraphFilesOnly(stash.dir, db)).toEqual(graphBefore);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — extractGraphForSingleFile (injected LLM seam)
// ─────────────────────────────────────────────────────────────────────────────

describe("#624 P3 extractGraphForSingleFile (AC2)", () => {
  test("required symbolic credential failure leaves lazy extraction caches and graph rows empty", async () => {
    const absPath = makeEligibleMemory("credential", "Alice works with Bob.");
    const config: AkmConfig = {
      semanticSearchMode: "off",
      engines: {
        graph: {
          kind: "llm",
          endpoint: "http://127.0.0.1:1/v1/chat/completions",
          model: "never-dispatched",
          apiKey: "$AKM_LAZY_GRAPH_REQUIRED_KEY",
        },
      },
      index: { defaults: { engine: "graph" }, graph: { enabled: true, lazyGraphExtraction: true } },
    };

    const failure = withEnv({ AKM_LAZY_GRAPH_REQUIRED_KEY: undefined }, () =>
      extractGraphForSingleFile(db, stash.dir, absPath, { config }),
    );
    await expect(failure).rejects.toBeInstanceOf(ConfigError);
    expect(graphFileRowExists(stash.dir, absPath)).toBe(false);
    const cacheRows = (db.prepare("SELECT COUNT(*) AS n FROM llm_enrichment_cache").get() as { n: number }).n;
    expect(cacheRows).toBe(0);
  });

  test("extracts + stores one file's graph via the injected LLM seam", async () => {
    expect(typeof extractGraphForSingleFile).toBe("function");
    const absPath = makeEligibleMemory("target", "Alice works with Bob on Project X.");

    const llmOverride: LlmOverride = async () => ({
      entities: ["Alice", "Bob", "Project X"],
      relations: [{ from: "Alice", to: "Bob", type: "works_with" }],
    });

    const ok = await extractGraphForSingleFile(db, stash.dir, absPath, { llmOverride });
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

  test("binds a single-file graph row to the body revision actually read from disk", async () => {
    const currentBody = "Current body about Alice and Bob.";
    const absPath = makeEligibleMemory("revision-bound", currentBody);

    const ok = await extractGraphForSingleFile(db, stash.dir, absPath, {
      llmOverride: async () => ({ entities: ["Alice", "Bob"], relations: [] }),
    });

    expect(ok).toBe(true);
    const row = db
      .prepare("SELECT body_hash FROM graph_files WHERE stash_root = ? AND file_path = ?")
      .get(stash.dir, absPath) as { body_hash: string };
    expect(row.body_hash).toBe(computeBodyHash(currentBody));
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
    const ok = await extractGraphForSingleFile(db, stash.dir, targetPath, { llmOverride });
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
    const ok = await extractGraphForSingleFile(db, stash.dir, absPath, { llmOverride });
    // Missing file => no extraction, no LLM call, no graph row, no throw.
    expect(ok).toBe(false);
    expect(called).toBe(false);
    expect(graphFileRowExists(stash.dir, absPath)).toBe(false);
  });
});
