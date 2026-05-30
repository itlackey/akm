/**
 * Integration tests for `runGraphExtractionPass` with `graphExtractionBatchSize`.
 *
 * The graph extraction pass runs against a local Bun HTTP server so the real
 * `../src/llm/graph-extract` and client transport path are exercised without
 * process-global module mocks. These tests verify that:
 *
 *   (g) `graphExtractionBatchSize > 1` routes through `extractGraphFromBodies`
 *       (batch path), writing a correct SQLite-backed graph snapshot for a 3-file stash.
 *   (h) Default batch size (=1) uses the per-asset `extractGraphFromBody` path
 *       — behaviour is identical to the original implementation.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AkmConfig, LlmConnectionConfig } from "../src/core/config";
import { closeDatabase, openDatabase, upsertEntry } from "../src/indexer/db";
import { loadStoredGraphSnapshot } from "../src/indexer/graph-db";
import type { GraphExtractionResult } from "../src/indexer/graph-extraction";
import { buildSearchText } from "../src/indexer/search-fields";
import type { GraphExtraction } from "../src/llm/graph-extract";

// ── Local LLM server ─────────────────────────────────────────────────────────

let batchExtractorStub: ((bodies: string[]) => Promise<GraphExtraction[]>) | null = null;
let singleExtractorStub: ((body: string) => Promise<GraphExtraction>) | null = null;
let batchCallCount = 0;
let singleCallCount = 0;

function parseBatchBodies(userContent: string): string[] {
  const marker = "=== ASSET ";
  if (!userContent.includes(marker)) return [];
  return userContent
    .split(/=== ASSET \d+ ===\n/g)
    .slice(1)
    .map((body) => body.trim())
    .filter(Boolean);
}

const llmServer = Bun.serve({
  port: 0,
  async fetch(request) {
    const payload = (await request.json()) as {
      messages?: Array<{ role?: string; content?: string }>;
    };
    const userContent = payload.messages?.find((m) => m.role === "user")?.content ?? "";

    if (userContent.includes("N=")) {
      batchCallCount++;
      const bodies = parseBatchBodies(userContent);
      let result: GraphExtraction[];
      try {
        result = batchExtractorStub
          ? await batchExtractorStub(bodies)
          : bodies.map(() => ({ entities: [], relations: [] }));
      } catch (err) {
        return new Response(String(err instanceof Error ? err.message : err), { status: 500 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    singleCallCount++;
    let result: GraphExtraction;
    try {
      result = singleExtractorStub ? await singleExtractorStub(userContent) : { entities: [], relations: [] };
    } catch (err) {
      return new Response(String(err instanceof Error ? err.message : err), { status: 500 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }), {
      headers: { "Content-Type": "application/json" },
    });
  },
});

const { runGraphExtractionPass, GRAPH_FILE_SCHEMA_VERSION } = await import("../src/indexer/graph-extraction");

// ── Fixture helpers ──────────────────────────────────────────────────────────

const SAMPLE_LLM: LlmConnectionConfig = {
  endpoint: `http://localhost:${llmServer.port}/v1/chat/completions`,
  model: "llama3.2",
};

function makeConfig(overrides?: Partial<AkmConfig>): AkmConfig {
  return {
    semanticSearchMode: "auto",
    profiles: {
      llm: { default: { ...SAMPLE_LLM } },
      improve: { default: { processes: { graphExtraction: { enabled: true } } } },
    },
    defaults: { llm: "default" },
    ...overrides,
  };
}

let tmpStash = "";
let tmpDataHome = "";
let tmpStateHome = "";
const savedXdgDataHome = process.env.XDG_DATA_HOME;
const savedXdgStateHome = process.env.XDG_STATE_HOME;
const savedAkmStashDir = process.env.AKM_STASH_DIR;

beforeEach(() => {
  tmpStash = fs.mkdtempSync(path.join(os.tmpdir(), "akm-batch-pass-"));
  fs.mkdirSync(path.join(tmpStash, "memories"), { recursive: true });
  fs.mkdirSync(path.join(tmpStash, "knowledge"), { recursive: true });
  // Pair tmpStash with XDG_DATA_HOME / XDG_STATE_HOME so that any
  // production helper inside graph-db / graph-extraction that incidentally
  // calls getDbPath()/getTaskHistoryStateDir() does not fire the test-isolation guard
  // when a prior leaky test left process.env.AKM_STASH_DIR set.
  tmpDataHome = fs.mkdtempSync(path.join(os.tmpdir(), "akm-batch-pass-data-"));
  tmpStateHome = fs.mkdtempSync(path.join(os.tmpdir(), "akm-batch-pass-state-"));
  process.env.XDG_DATA_HOME = tmpDataHome;
  process.env.XDG_STATE_HOME = tmpStateHome;
  batchExtractorStub = null;
  singleExtractorStub = null;
  batchCallCount = 0;
  singleCallCount = 0;
});

afterEach(() => {
  if (tmpStash) {
    fs.rmSync(tmpStash, { recursive: true, force: true });
    tmpStash = "";
  }
  if (tmpDataHome) {
    fs.rmSync(tmpDataHome, { recursive: true, force: true });
    tmpDataHome = "";
  }
  if (tmpStateHome) {
    fs.rmSync(tmpStateHome, { recursive: true, force: true });
    tmpStateHome = "";
  }
  if (savedXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedXdgDataHome;
  if (savedXdgStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedXdgStateHome;
  if (savedAkmStashDir === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = savedAkmStashDir;
});

afterAll(() => {
  llmServer.stop(true);
});

function writeMemory(name: string, body: string): void {
  const content = `---\ntitle: ${name}\n---\n\n${body}\n`;
  const filePath = path.join(tmpStash, "memories", `${name}.md`);
  const dirPath = path.dirname(filePath);
  fs.writeFileSync(filePath, content, "utf8");
  // Schema v2: graph_files.entry_id FKs entries.id. Seed a minimal entry so
  // replaceStoredGraph can resolve this file_path to an entry_id.
  // Tests open multiple DB filenames per `withGraphDb` call; seed each one
  // ahead of test execution so any DB the test opens already has the entry.
  for (const dbName of [
    "graph-batch.db",
    "graph-default.db",
    "graph-chunked.db",
    "graph-adaptive.db",
    "graph-disable-batching.db",
    "graph-consistency.db",
  ]) {
    const db = openDatabase(path.join(tmpStash, dbName));
    try {
      const entry = { name, type: "memory", filename: `${name}.md` };
      upsertEntry(
        db,
        `${tmpStash}:memory:${name}`,
        dirPath,
        filePath,
        tmpStash,
        entry as Parameters<typeof upsertEntry>[5],
        buildSearchText(entry as Parameters<typeof buildSearchText>[0]),
      );
    } finally {
      closeDatabase(db);
    }
  }
}

function sources() {
  return [{ path: tmpStash }];
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("runGraphExtractionPass — batch path", () => {
  test("(g) batchSize=3 routes through extractGraphFromBodies once for 3 files and writes correct SQLite graph rows", async () => {
    writeMemory("m1", "ServiceA integrates with ServiceB.");
    writeMemory("m2", "Terraform provisions ProdCluster.");
    writeMemory("m3", "No extractable content.");

    let capturedBodies: string[] | null = null;
    batchExtractorStub = async (bodies) => {
      capturedBodies = bodies;
      return [
        { entities: ["ServiceA", "ServiceB"], relations: [{ from: "ServiceA", to: "ServiceB", type: "integrates" }] },
        { entities: ["Terraform", "ProdCluster"], relations: [] },
        { entities: [], relations: [] }, // m3 — no graph content
      ];
    };

    const db = openDatabase(path.join(tmpStash, "graph-batch.db"));
    let parsed:
      | {
          schemaVersion: number;
          files: Array<{ path: string; entities: string[]; relations: unknown[]; status?: string; reason?: string }>;
        }
      | undefined;
    try {
      const result = await runGraphExtractionPass(
        makeConfig({ index: { graph: { graphExtractionBatchSize: 3 } } }),
        sources(),
        undefined,
        db,
      );

      // extractGraphFromBodies was called exactly once with all 3 bodies.
      expect(batchCallCount).toBe(1);
      expect(singleCallCount).toBe(0);
      expect(capturedBodies).toHaveLength(3);

      // Telemetry: m3 returned no entities so it is excluded from extracted count.
      expect(result.written).toBe(true);
      expect(result.considered).toBe(3);
      expect(result.extracted).toBe(2);
      expect(result.totalEntities).toBe(4);
      expect(result.totalRelations).toBe(1);

      parsed = loadStoredGraphSnapshot(tmpStash, db) as {
        schemaVersion: number;
        files: Array<{ path: string; entities: string[]; relations: unknown[]; status?: string; reason?: string }>;
      };
      expect(parsed.schemaVersion).toBe(GRAPH_FILE_SCHEMA_VERSION);
      expect(parsed.files).toHaveLength(3);
      expect(
        parsed.files.some((file) => file.entities.includes("ServiceA") && file.entities.includes("ServiceB")),
      ).toBe(true);
      expect(
        parsed.files.some((file) => file.entities.includes("Terraform") && file.entities.includes("ProdCluster")),
      ).toBe(true);
      const emptyFile = parsed.files.find((file) => file.entities.length === 0);
      expect(emptyFile?.status).toBe("empty");
      expect(emptyFile?.reason).toBe("no_graph_content");
    } finally {
      closeDatabase(db);
    }
  });

  test("(h) explicit batchSize=1 uses per-asset path and behaves identically to original implementation", async () => {
    writeMemory("m1", "Alpha body.");
    writeMemory("m2", "Beta body.");

    const callBodies: string[] = [];
    singleExtractorStub = async (body) => {
      callBodies.push(body);
      if (body.includes("Alpha")) return { entities: ["Alpha"], relations: [] };
      if (body.includes("Beta")) return { entities: ["Beta"], relations: [] };
      return { entities: [], relations: [] };
    };

    // Phase 1 perf fix: the default batch size moved from 1 → 4, so callers
    // that want the per-asset path must opt in with batchSize=1 explicitly.
    const db = openDatabase(path.join(tmpStash, "graph-default.db"));
    let result: GraphExtractionResult;
    try {
      result = await runGraphExtractionPass(
        makeConfig({ index: { graph: { graphExtractionBatchSize: 1 } } }),
        sources(),
        undefined,
        db,
      );
    } finally {
      closeDatabase(db);
    }

    // Per-asset path: 2 individual calls, 0 batch calls.
    expect(singleCallCount).toBe(2);
    expect(batchCallCount).toBe(0);
    expect(callBodies).toHaveLength(2);

    expect(result.written).toBe(true);
    expect(result.extracted).toBe(2);
    expect(result.considered).toBe(2);
  });

  test("(g2) batchSize=2 chunks 5 files into 2 batch calls plus 1 single-body fallback chunk", async () => {
    for (let i = 1; i <= 5; i++) writeMemory(`m${i}`, `Entity${i} uses Tool${i}.`);

    const callSizes: number[] = [];
    batchExtractorStub = async (bodies) => {
      callSizes.push(bodies.length);
      return bodies.map((_, j) => ({
        entities: [`E${j}`],
        relations: [],
      }));
    };
    singleExtractorStub = async () => ({ entities: ["E-final"], relations: [] });

    const db = openDatabase(path.join(tmpStash, "graph-chunked.db"));
    let result: GraphExtractionResult;
    try {
      result = await runGraphExtractionPass(
        makeConfig({ index: { graph: { graphExtractionBatchSize: 2 } } }),
        sources(),
        undefined,
        db,
      );
    } finally {
      closeDatabase(db);
    }

    // 5 files / batchSize=2 → chunks [2, 2, 1]. The final 1-item chunk still
    // routes through extractGraphFromBodies, which delegates to the single-body
    // path, so we observe 2 batch calls and 1 single-body call.
    expect(batchCallCount).toBe(2);
    expect(singleCallCount).toBe(1);
    expect(callSizes).toEqual([2, 2]);
    expect(result.considered).toBe(5);
    expect(result.extracted).toBe(5);
  });

  test("adaptive batching retries smaller groups on context-size failures", async () => {
    writeMemory("m1", "Alpha uses Beta.");
    writeMemory("m2", "Gamma uses Delta.");
    writeMemory("m3", "Epsilon uses Zeta.");

    batchExtractorStub = async (bodies) => {
      if (bodies.length > 1) throw new Error("context size exceeded");
      return bodies.map((_, index) => ({ entities: [`Single${index}`], relations: [] }));
    };
    singleExtractorStub = async (body) => ({
      entities: [body.includes("Alpha") ? "Alpha" : body.includes("Gamma") ? "Gamma" : "Epsilon"],
      relations: [],
    });

    const db = openDatabase(path.join(tmpStash, "graph-adaptive.db"));
    try {
      const result = await runGraphExtractionPass(
        makeConfig({ index: { graph: { graphExtractionBatchSize: 3 } } }),
        sources(),
        undefined,
        db,
      );

      expect(result.considered).toBe(3);
      expect(result.extracted).toBe(3);
      expect(batchCallCount).toBe(2);
      expect(singleCallCount).toBe(3);
      expect(result.telemetry?.failureCount).toBeGreaterThanOrEqual(0);
    } finally {
      closeDatabase(db);
    }
  });

  test("repeated non-array batch responses disable batching for the remainder of the run", async () => {
    for (let i = 1; i <= 6; i++) writeMemory(`m${i}`, `Entity${i} uses Tool${i}.`);

    batchExtractorStub = async (_bodies) => ({ nope: true }) as unknown as GraphExtraction[];
    singleExtractorStub = async (body) => ({ entities: [body.match(/Entity\d+/)?.[0] ?? "fallback"], relations: [] });

    const db = openDatabase(path.join(tmpStash, "graph-disable-batching.db"));
    try {
      const result = await runGraphExtractionPass(
        makeConfig({ index: { graph: { graphExtractionBatchSize: 2 } } }),
        sources(),
        undefined,
        db,
      );

      expect(result.considered).toBe(6);
      expect(result.extracted).toBe(6);
      expect(batchCallCount).toBe(2);
      expect(singleCallCount).toBe(6);
    } finally {
      closeDatabase(db);
    }
  });

  test("consistency-based confidence boosts entities/relations appearing in multiple chunks", async () => {
    // Create a long document that will be chunked into multiple pieces.
    // The same entity "SharedService" appears in multiple chunks.
    const longBody = Array(40)
      .fill(null)
      .map(
        (_, i) =>
          `## Section ${i + 1}\n\nSharedService uses Database${i}. It also integrates with Cache${i}. This is additional padding text to ensure the document exceeds the chunk size threshold for graph extraction.`,
      )
      .join("\n\n");
    writeMemory("long-doc", longBody);

    singleExtractorStub = async (body) => {
      const entities: string[] = ["SharedService"];
      const relations: Array<{ from: string; to: string; type: string }> = [];
      for (let i = 0; i < 40; i++) {
        if (body.includes(`Database${i}`)) {
          entities.push(`Database${i}`);
          relations.push({ from: "SharedService", to: `Database${i}`, type: "uses" });
        }
        if (body.includes(`Cache${i}`)) {
          entities.push(`Cache${i}`);
          relations.push({ from: "SharedService", to: `Cache${i}`, type: "integrates with" });
        }
      }
      return { entities, relations };
    };

    const db = openDatabase(path.join(tmpStash, "graph-consistency.db"));
    try {
      const result = await runGraphExtractionPass(
        makeConfig({ index: { graph: { graphExtractionBatchSize: 1 } } }),
        sources(),
        undefined,
        db,
      );

      expect(result.considered).toBe(1);
      expect(result.extracted).toBe(1);
      // The file was chunked, so we should have merged results
      const parsed = loadStoredGraphSnapshot(tmpStash, db);
      if (!parsed) throw new Error("expected stored graph snapshot");
      const node = parsed.files.find((f) => f.path.includes("long-doc"));
      expect(node).toBeDefined();
      expect(node?.entities).toContain("SharedService");
      // Confidence should be computed from consistency (non-zero since entity appears in multiple chunks)
      expect(typeof node?.confidence).toBe("number");
      expect(node?.confidence).toBeGreaterThan(0);
    } finally {
      closeDatabase(db);
    }
  });
});
