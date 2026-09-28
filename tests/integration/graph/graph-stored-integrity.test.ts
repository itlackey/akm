// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Stored-graph integrity (graph evaluation and refactor plan 2026-09-27, §2 and
 * refactor step 1):
 *   - N1: a re-extraction of an unchanged body replaces its stored rows;
 *   - N2 and review defect 1: an aborted run, or one scoped by `topN`, keeps
 *     the stored rows of every eligible file it did not reach;
 *   - review defect 9: the rows of a file that left the eligible set are dropped;
 *   - N3 and review defect 10: graph_meta counts are derived from the stored rows.
 *
 * Opens real SQLite databases and serves a localhost LLM stub, so it lives under
 * tests/integration/.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../../../src/core/config/config";
import { replaceStoredGraph } from "../../../src/indexer/db/graph-db";
import { runGraphExtractionPass } from "../../../src/indexer/graph/graph-extraction";
import type { GraphFileNode } from "../../../src/indexer/graph/graph-types";
import type { Database } from "../../../src/storage/database";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

// ── LLM stub: one extraction per body, tagged with the requesting model ──────

let requestCount = 0;
let failRequests = false;
let onRequest: (() => void) | undefined;

/** The note number a prompt (or one batch section of it) carries. */
function noteNumber(text: string): string | undefined {
  return /Topic-(\d+)-end/.exec(text)?.[1];
}

function extractionFor(text: string, model: string) {
  const n = noteNumber(text);
  if (!n) return { entities: [], relations: [] };
  return {
    entities: [`Topic ${n}`, "Shared Hub", `By ${model}`],
    relations: [{ from: `Topic ${n}`, to: "Shared Hub", type: "uses" }],
  };
}

const llmServer = Bun.serve({
  port: 0,
  async fetch(request) {
    requestCount++;
    onRequest?.();
    const payload = (await request.json()) as { model?: string; messages?: Array<{ role?: string; content?: string }> };
    const user = payload.messages?.find((message) => message.role === "user")?.content ?? "";
    if (failRequests) return new Response("stub: provider down", { status: 500 });
    const model = payload.model ?? "unknown";
    const sections = /\bN=\d+/.test(user) ? user.split(/=== ASSET \d+ ===\n/g).slice(1) : [];
    const content =
      sections.length > 0
        ? JSON.stringify(sections.map((section) => extractionFor(section, model)))
        : JSON.stringify(extractionFor(user, model));
    return Response.json({ choices: [{ message: { content } }] });
  },
});

afterAll(() => {
  llmServer.stop(true);
});

// ── Fixture ──────────────────────────────────────────────────────────────────

let storage: IsolatedAkmStorage;
let db: Database;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  db = openIndexDatabase(path.join(storage.dataDir, "graph-integrity.db"));
  requestCount = 0;
  failRequests = false;
  onRequest = undefined;
});

afterEach(() => {
  closeDatabase(db);
  storage.cleanup();
});

function configFor(model: string): AkmConfig {
  return {
    semanticSearchMode: "auto",
    engines: { index: { kind: "llm", endpoint: `http://localhost:${llmServer.port}/v1/chat/completions`, model } },
    index: { defaults: { engine: "index" }, graph: { enabled: true, graphExtractionBatchSize: 1 } },
  };
}

/** Write memories `n1.md`..`n<count>.md`; returns their absolute paths in number order. */
function writeNotes(count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    const filePath = path.join(storage.stashDir, "memories", `n${i + 1}.md`);
    fs.writeFileSync(filePath, `---\ndescription: note ${i + 1}\n---\n\nA note about Topic-${i + 1}-end.\n`);
    return filePath;
  });
}

function run(
  opts: {
    model?: string;
    signal?: AbortSignal;
    reEnrich?: boolean;
    topN?: number;
    candidatePaths?: ReadonlySet<string>;
  } = {},
) {
  return runGraphExtractionPass({
    config: configFor(opts.model ?? "model-a"),
    sources: [{ path: storage.stashDir }],
    db,
    reEnrich: opts.reEnrich ?? false,
    ...(opts.signal ? { signal: opts.signal } : {}),
    options: {
      ...(opts.topN != null ? { topN: opts.topN } : {}),
      ...(opts.candidatePaths ? { candidatePaths: opts.candidatePaths } : {}),
    },
  });
}

/** Stored entity names per file, in entity order (files without entity rows map to []). */
function storedEntities(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const rows = db
    .prepare(
      `SELECT gf.file_path AS file_path, e.entity AS entity
         FROM graph_files gf
         LEFT JOIN graph_file_entities e
           ON e.stash_root = gf.stash_root AND e.file_path = gf.file_path AND e.body_hash = gf.body_hash
        WHERE gf.stash_root = ?
        ORDER BY gf.file_path, e.entity_order`,
    )
    .all(storage.stashDir) as Array<{ file_path: string; entity: string | null }>;
  for (const row of rows) {
    const list = out.get(row.file_path) ?? [];
    if (row.entity !== null) list.push(row.entity);
    out.set(row.file_path, list);
  }
  return out;
}

function relationCount(filePath: string): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM graph_file_relations WHERE stash_root = ? AND file_path = ?")
      .get(storage.stashDir, filePath) as { n: number }
  ).n;
}

function graphMeta() {
  return db
    .prepare(
      `SELECT considered_files, extracted_files, entity_count, relation_count, extraction_coverage, density
         FROM graph_meta WHERE stash_root = ?`,
    )
    .get(storage.stashDir) as Record<string, number>;
}

// ── N1 ───────────────────────────────────────────────────────────────────────

describe("N1: an unchanged body's stored rows follow its latest extraction", () => {
  test("a cache hit refills rows a failed attempt left empty and replaces an older extraction, with no LLM call", async () => {
    const [emptied, stale, intact] = writeNotes(3) as [string, string, string];
    await run();
    expect(requestCount).toBe(3);
    const primed = storedEntities();

    // The live shapes (2026-09-27): status 'extracted' with no entity rows, and
    // entity rows an older extraction of the same body wrote.
    db.prepare("DELETE FROM graph_file_entities WHERE file_path = ?").run(emptied);
    db.prepare("DELETE FROM graph_file_relations WHERE file_path = ?").run(emptied);
    db.prepare("UPDATE graph_file_entities SET entity = 'Old Name', entity_norm = 'old name' WHERE file_path = ?").run(
      stale,
    );

    requestCount = 0;
    failRequests = true;
    const result = await run();

    expect(requestCount).toBe(0);
    expect(result.telemetry).toMatchObject({ cacheHits: 3, cacheMisses: 0 });
    expect(storedEntities()).toEqual(primed);
    expect(relationCount(emptied)).toBe(1);
    expect(relationCount(intact)).toBe(1);
  });

  test("replaceStoredGraph rewrites the child rows of an unchanged body when its extraction differs", () => {
    const filePath = path.join(storage.stashDir, "memories", "direct.md");
    const snapshot = (entities: string[], relations: GraphFileNode["relations"]) => ({
      generatedAt: new Date().toISOString(),
      stashRoot: storage.stashDir,
      files: [{ path: filePath, type: "memory", bodyHash: "same-body", entities, relations }],
    });

    replaceStoredGraph(db, snapshot(["Old"], []));
    replaceStoredGraph(db, snapshot(["New A", "New B"], [{ from: "New A", to: "New B", type: "uses" }]));

    expect(storedEntities().get(filePath)).toEqual(["New A", "New B"]);
    expect(relationCount(filePath)).toBe(1);
  });
});

// ── N2 and review defect 1 ───────────────────────────────────────────────────

describe("N2: a partial run never shrinks the stored graph", () => {
  test("two budget-aborted runs keep the rows of every file they did not finish", async () => {
    const paths = writeNotes(6);
    await run();

    for (const model of ["model-b", "model-c"]) {
      // A new model misses the cache for every file; the budget fires during
      // the second request, as the 2026-09-26 backfill's 4 h budget did.
      const budget = new AbortController();
      requestCount = 0;
      onRequest = () => {
        if (requestCount === 2) budget.abort();
      };
      await run({ model, signal: budget.signal });

      const stored = storedEntities();
      expect([...stored.keys()].sort()).toEqual([...paths].sort());
      for (const entities of stored.values()) expect(entities).toHaveLength(3);
      // Only the one request that completed before the abort replaced a file's rows.
      expect([...stored.values()].filter((entities) => entities.includes(`By ${model}`))).toHaveLength(1);
    }
  });

  test("a failure-rate abort keeps the rows of the files it attempted and the files it skipped", async () => {
    const paths = writeNotes(6);
    await run();
    const primed = storedEntities();
    expect([...primed.keys()].sort()).toEqual([...paths].sort());

    // Every file needs a call; four failed dispatches trip the abort, two files are never tried.
    failRequests = true;
    const result = await run({ reEnrich: true });

    expect(result.telemetry?.aborted).toBe(true);
    expect(storedEntities()).toEqual(primed);
    const statuses = db.prepare("SELECT DISTINCT status FROM graph_files WHERE stash_root = ?").all(storage.stashDir);
    expect(statuses).toEqual([{ status: "extracted" }]);
  });

  test("topN refreshes its selection and keeps every other stored file, with no LLM call on a warm cache", async () => {
    const paths = writeNotes(6);
    await run();
    const primed = storedEntities();

    requestCount = 0;
    const result = await run({ topN: 1 });

    expect(result.considered).toBe(1);
    expect(requestCount).toBe(0);
    expect([...storedEntities().keys()].sort()).toEqual([...paths].sort());
    expect(storedEntities()).toEqual(primed);
  });

  test("a stored node an older extractor wrote is re-extracted, never reused as the current extractor's output", async () => {
    const [kept, refreshed] = writeNotes(2) as [string, string];
    await run({ model: "model-a" });
    // model-b refreshes one file, so graph_meta names model-b's extractor while
    // the other file still holds the rows model-a wrote.
    await run({ model: "model-b", candidatePaths: new Set([refreshed]) });
    expect(storedEntities().get(kept)).toContain("By model-a");

    requestCount = 0;
    await run({ model: "model-b" });

    expect(requestCount).toBe(1);
    expect(storedEntities().get(kept)).toContain("By model-b");
    const cached = db
      .prepare("SELECT result_json FROM llm_enrichment_cache WHERE asset_ref = ? AND cache_variant LIKE ?")
      .get(kept, "%:model-b:%") as { result_json: string };
    expect(JSON.parse(cached.result_json).entities).toContain("By model-b");
  });
});

// ── Review defect 9 ──────────────────────────────────────────────────────────

describe("files that left the eligible set", () => {
  test("a scoped run drops the rows of a deleted file and a now-inferred memory, and keeps the rest", async () => {
    const [deleted, inferred, kept, touched] = writeNotes(4) as [string, string, string, string];
    await run();

    fs.rmSync(deleted);
    fs.writeFileSync(inferred, "---\ninferred: true\n---\n\nA derived note about Topic-2-end.\n");
    await run({ candidatePaths: new Set([touched]) });

    expect([...storedEntities().keys()].sort()).toEqual([kept, touched].sort());
  });

  test.skipIf(process.getuid?.() === 0)("an incomplete scan drops no stored rows", async () => {
    const [deleted, kept] = writeNotes(2) as [string, string];
    const unreadableDir = path.join(storage.stashDir, "memories", "locked");
    fs.mkdirSync(unreadableDir);
    await run();

    fs.rmSync(deleted);
    fs.chmodSync(unreadableDir, 0o000);
    try {
      await run();
    } finally {
      fs.chmodSync(unreadableDir, 0o755);
    }

    expect([...storedEntities().keys()].sort()).toEqual([deleted, kept].sort());
  });
});

// ── N3 and review defect 10 ──────────────────────────────────────────────────

describe("graph_meta counts are derived from the stored rows", () => {
  test("files, case-folded entities and relations are counted from the rows, whatever the snapshot claims", () => {
    const file = (name: string) => path.join(storage.stashDir, "knowledge", `${name}.md`);
    replaceStoredGraph(db, {
      generatedAt: new Date().toISOString(),
      stashRoot: storage.stashDir,
      files: [
        {
          path: file("a"),
          type: "knowledge",
          bodyHash: "a",
          entities: ["Redis", "Postgres"],
          relations: [{ from: "Redis", to: "Postgres", type: "feeds" }],
        },
        {
          path: file("b"),
          type: "knowledge",
          bodyHash: "b",
          entities: ["redis", "Kafka"],
          relations: [{ from: "redis", to: "postgres", type: "Feeds" }],
        },
        { path: file("c"), type: "knowledge", bodyHash: "c", entities: [], relations: [], status: "empty" },
      ],
      quality: {
        consideredFiles: 99,
        extractedFiles: 99,
        entityCount: 99,
        relationCount: 99,
        extractionCoverage: 1,
        density: 1,
      },
    });

    expect(graphMeta()).toEqual({
      considered_files: 3,
      extracted_files: 2,
      entity_count: 3,
      relation_count: 1,
      extraction_coverage: 0.6667,
      density: 0.3333,
    });
  });

  test("the pass reports the stored counts after a run that fails every call", async () => {
    const [emptied] = writeNotes(3) as [string, string, string];
    await run();
    // One file's rows are missing (the N1 shape) and a new file can only fail.
    db.prepare("DELETE FROM graph_file_entities WHERE file_path = ?").run(emptied);
    db.prepare("DELETE FROM graph_file_relations WHERE file_path = ?").run(emptied);
    fs.writeFileSync(path.join(storage.stashDir, "memories", "n9.md"), "---\n---\n\nA note about Topic-9-end.\n");

    failRequests = true;
    const result = await run();

    const count = (sql: string) => (db.prepare(sql).get(storage.stashDir) as { n: number }).n;
    const rows = {
      files: count("SELECT COUNT(*) AS n FROM graph_files WHERE stash_root = ?"),
      filesWithEntities: count("SELECT COUNT(DISTINCT file_path) AS n FROM graph_file_entities WHERE stash_root = ?"),
      entities: count("SELECT COUNT(DISTINCT entity_norm) AS n FROM graph_file_entities WHERE stash_root = ?"),
    };
    expect(rows).toEqual({ files: 4, filesWithEntities: 3, entities: 5 });
    expect(result.quality).toMatchObject({
      consideredFiles: rows.files,
      extractedFiles: rows.filesWithEntities,
      entityCount: rows.entities,
      relationCount: 3,
      extractionCoverage: 0.75,
    });
    expect(graphMeta()).toMatchObject({
      considered_files: rows.files,
      extracted_files: rows.filesWithEntities,
      entity_count: rows.entities,
      relation_count: 3,
    });
  });
});
