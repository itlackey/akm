// SPDX-License-Identifier: MPL-2.0
//
// #624 P3: tests for the lazy-graph-extraction pass drain (AC5), the default
// byte-identical no-op (AC6), and the show/curate gating contract (AC3/AC4)
// expressed through the directly drivable seams: `drainExtractionQueue` /
// `enqueueGraphExtraction`, the `graph_extraction_queue` table,
// runGraphExtractionPass draining the queue before its ranked sweep, and the
// `index.graph.lazyGraphExtraction` config key. Symbols are accessed via the
// module namespace for ESM-safety.
//
// runGraphExtractionPass is exercised against a local Bun HTTP server (the same
// harness the existing graph-extraction tests use) — it is the real transport,
// not a process-global module mock — but every test completes in well under a
// second with no real network, so this remains a unit-scope file under tests/.
// Uses sandbox env redirection; never touches host state. Run individually
// before any full-suite gate.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import type { AkmConfig } from "../src/core/config/config";
import { closeDatabase, computeBodyHash, openIndexDatabase, upsertEntry } from "../src/indexer/db/db";
import * as graphDb from "../src/indexer/db/graph-db";
import { buildSearchText } from "../src/indexer/search/search-fields";
import type { SearchSource } from "../src/indexer/search/search-source";
import type { Database } from "../src/storage/database";
import { makeSandboxDir, sandboxXdgDataHome, sandboxXdgStateHome } from "./_helpers/sandbox";

// ── Deferred (not-yet-exported) P3 accessors ─────────────────────────────────

// Accessed via namespace casts for ESM-safety; they resolve to the real
// exports. Same pattern as graph-extraction-topn.test.ts.
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

// ── Local LLM server (mirrors tests/graph-extraction.test.ts) ────────────────

let extractor: (body: string) => {
  entities: string[];
  relations: { from: string; to: string; type?: string; confidence?: number }[];
  confidence?: number;
} = () => ({ entities: [], relations: [] });
const extractedBodies: string[] = [];

function parseBatchBodies(userContent: string): string[] {
  if (!userContent.includes("=== ASSET ") || !/\bN=\d+/.test(userContent)) return [];
  return userContent
    .split(/=== ASSET \d+ ===\n/g)
    .slice(1)
    .map((body) => body.trim())
    .filter(Boolean);
}

const llmServer = Bun.serve({
  port: 0,
  async fetch(request) {
    const payload = (await request.json()) as { messages?: Array<{ role?: string; content?: string }> };
    const userContent = payload.messages?.find((m) => m.role === "user")?.content ?? "";
    const batchBodies = parseBatchBodies(userContent);
    if (batchBodies.length > 0) {
      for (const b of batchBodies) extractedBodies.push(b);
      const arr = batchBodies.map((body) => extractor(body));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(arr) } }] }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    extractedBodies.push(userContent);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(extractor(userContent)) } }] }),
      { headers: { "Content-Type": "application/json" } },
    );
  },
});

const { runGraphExtractionPass } = await import("../src/indexer/graph/graph-extraction");

// ── Fixture / sandbox plumbing ───────────────────────────────────────────────
//
// Uses the tests/_helpers/sandbox.ts helpers (NOT raw mkdtempSync + manual env
// assignment) so this file satisfies the lint-tests-isolation rule: the stash
// is a plain sandbox dir (no env var) and the XDG_DATA_HOME / XDG_STATE_HOME
// redirects go through sandboxXdgDataHome / sandboxXdgStateHome, which set +
// restore the env vars and clean up their temp dirs for us.

let tmpStash = "";
let cleanup: (() => void) | undefined;

beforeEach(() => {
  const stashSandbox = makeSandboxDir("akm-graph-lazy");
  tmpStash = stashSandbox.dir;
  fs.mkdirSync(path.join(tmpStash, "memories"), { recursive: true });
  fs.mkdirSync(path.join(tmpStash, "knowledge"), { recursive: true });

  const data = sandboxXdgDataHome(stashSandbox.cleanup);
  const state = sandboxXdgStateHome(data.cleanup);
  cleanup = state.cleanup;

  extractor = () => ({ entities: [], relations: [] });
  extractedBodies.length = 0;
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  tmpStash = "";
});

afterAll(() => {
  llmServer.stop(true);
});

const SAMPLE_LLM = {
  endpoint: `http://localhost:${llmServer.port}/v1/chat/completions`,
  model: "llama3.2",
};

function configWithLlm(overrides?: Partial<AkmConfig>): AkmConfig {
  return {
    semanticSearchMode: "auto",
    profiles: { llm: { default: { ...SAMPLE_LLM } } },
    defaults: { llm: "default" },
    // batchSize 1 forces the per-asset path so each body is observable
    // distinctly in `extractedBodies`.
    index: { graph: { graphExtractionBatchSize: 1 } },
    ...overrides,
  } as AkmConfig;
}

function dbPath(): string {
  return path.join(tmpStash, "graph-test.db");
}

async function withDb<T>(fn: (db: Database) => T | Promise<T>): Promise<T> {
  const db = openIndexDatabase(dbPath());
  try {
    return await fn(db);
  } finally {
    closeDatabase(db);
  }
}

/**
 * True iff a real graph_files row exists for (stashRoot, filePath). Used in
 * place of hasGraphData() for exact present/absent assertions: Bun's `.get()`
 * returns `null` (not `undefined`) for a no-row query, and hasGraphData()
 * compares `row !== undefined`, so it cannot reliably express "no graph row".
 * This helper checks the row count directly, which is the unambiguous contract.
 */
function graphFileRowExists(db: Database, stashRoot: string, filePath: string): boolean {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM graph_files WHERE stash_root = ? AND file_path = ?")
    .get(stashRoot, filePath) as { n: number };
  return row.n > 0;
}

/** Write an eligible memory + seed its entries row. Returns the abs path. */
function writeMemory(slug: string, body: string): string {
  const filePath = path.join(tmpStash, "memories", `${slug}.md`);
  fs.writeFileSync(filePath, `---\ntype: memory\n---\n\n${body}\n`, "utf8");
  const db = openIndexDatabase(dbPath());
  try {
    const entry = { name: slug, type: "memory", filename: `${slug}.md` } as Parameters<typeof upsertEntry>[5];
    upsertEntry(
      db,
      `${tmpStash}:memory:${slug}`,
      path.dirname(filePath),
      filePath,
      tmpStash,
      entry,
      buildSearchText(entry as Parameters<typeof buildSearchText>[0]),
    );
  } finally {
    closeDatabase(db);
  }
  return filePath;
}

function sources(): SearchSource[] {
  return [{ path: tmpStash } as SearchSource];
}

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — pass drains the queue (highest-priority-first) BEFORE the ranked sweep
// ─────────────────────────────────────────────────────────────────────────────

describe("#624 P3 runGraphExtractionPass drains the queue first (AC5)", () => {
  test("a queued path is extracted even when it would not be in the normal candidate set", async () => {
    expect(typeof enqueueGraphExtraction).toBe("function");

    // `queued` is a real eligible file but we scope the normal sweep to EXCLUDE
    // it via candidatePaths, proving the extraction came from the queue drain.
    const queued = writeMemory("queued", "Eve maintains Service Q.");
    const swept = writeMemory("swept", "Frank owns Repo R.");

    extractor = (body) => {
      if (body.includes("Eve")) return { entities: ["Eve", "Service Q"], relations: [] };
      if (body.includes("Frank")) return { entities: ["Frank", "Repo R"], relations: [] };
      return { entities: [], relations: [] };
    };

    await withDb(async (db) => {
      enqueueGraphExtraction(db, tmpStash, queued, computeBodyHash("Eve maintains Service Q."), 10);

      await runGraphExtractionPass({
        config: configWithLlm(),
        sources: sources(),
        db,
        // Scope the normal sweep to ONLY `swept`. Without the queue-drain,
        // `queued` would never be extracted.
        options: { candidatePaths: new Set([swept]) },
      });

      // Both got graph data: `swept` from the normal sweep, `queued` from the drain.
      expect(graphFileRowExists(db, tmpStash, swept)).toBe(true);
      expect(graphFileRowExists(db, tmpStash, queued)).toBe(true);

      // The queue is emptied after the pass drains it.
      const remaining = drainExtractionQueue(db, tmpStash, 100);
      expect(remaining).toHaveLength(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6 — default byte-identical: flag off + empty queue = no-op vs today
// ─────────────────────────────────────────────────────────────────────────────

describe("#624 P3 default byte-identical (AC6)", () => {
  test("empty queue: pass extracts exactly the normal candidate set and nothing extra", async () => {
    const a = writeMemory("alpha", "Grace ships Alpha.");
    const b = writeMemory("beta", "Heidi ships Beta.");
    extractor = (body) =>
      body.includes("Grace")
        ? { entities: ["Grace", "Alpha"], relations: [] }
        : { entities: ["Heidi", "Beta"], relations: [] };

    await withDb(async (db) => {
      // No enqueue, no lazyGraphExtraction flag → behaves exactly like today.
      await runGraphExtractionPass({ config: configWithLlm(), sources: sources(), db });

      // Both normal-eligible files extracted; no queue table interaction needed.
      expect(graphFileRowExists(db, tmpStash, a)).toBe(true);
      expect(graphFileRowExists(db, tmpStash, b)).toBe(true);

      // The queue accessor over an untouched table returns nothing (no throw,
      // no spurious rows) — the drain is a guarded no-op when empty.
      expect(drainExtractionQueue(db, tmpStash, 100)).toEqual([]);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3/AC4 — show/curate gating contract via the enqueue seam.
//
// The full akmShowUnified/akmCurate entry points require a complete search
// index; here we assert the lower-level contract those hooks rely on: with the
// flag OFF (no enqueue), an ungraphed asset stays ungraphed and the queue is
// empty (AC4a/AC3 "no inline extraction, no LLM, no graph row"); the enqueue
// seam (curate path, AC3) records intent WITHOUT creating a graph row or
// touching the LLM.
// ─────────────────────────────────────────────────────────────────────────────

describe("#624 P3 curate enqueue-not-extract contract (AC3)", () => {
  test("enqueue records a queue row but does NOT create a graph_files row or call the LLM", async () => {
    const asset = writeMemory("ungraphed", "Ivan documents System V.");
    let llmCalls = 0;
    extractor = () => {
      llmCalls++;
      return { entities: ["X"], relations: [] };
    };

    await withDb(async (db) => {
      expect(graphFileRowExists(db, tmpStash, asset)).toBe(false);

      // The curate hook's behavior: enqueue only (no extraction, no LLM).
      enqueueGraphExtraction(db, tmpStash, asset, computeBodyHash("Ivan documents System V."), 0);

      // No graph row was created and the LLM server was never hit.
      expect(graphFileRowExists(db, tmpStash, asset)).toBe(false);
      expect(llmCalls).toBe(0);
      expect(extractedBodies).toHaveLength(0);

      // Intent was recorded for a later pass to drain.
      const drained = drainExtractionQueue(db, tmpStash, 10);
      expect(drained.map((r) => r.filePath)).toEqual([asset]);
    });
  });

  test("default off (no enqueue): ungraphed asset stays ungraphed and queue is empty (AC4a)", async () => {
    const asset = writeMemory("plain", "Judy reads Doc W.");
    await withDb((db) => {
      // No flag, no enqueue → nothing happens. Mirrors `show` with the flag unset.
      expect(graphFileRowExists(db, tmpStash, asset)).toBe(false);
      expect(drainExtractionQueue(db, tmpStash, 10)).toEqual([]);
      expect(extractedBodies).toHaveLength(0);
    });
  });
});
