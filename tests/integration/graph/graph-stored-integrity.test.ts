// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Stored-graph integrity (graph evaluation and refactor plan 2026-09-27, §2 and
 * refactor step 1):
 *   - N1: a re-extraction of an unchanged body replaces its stored rows.
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
      schemaVersion: 4,
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
