/**
 * Integration tests for `runGraphExtractionPass` with `graphExtractionBatchSize`.
 *
 * The `../src/llm/graph-extract` module is mocked so no real LLM calls are
 * made. These tests verify that:
 *
 *   (g) `graphExtractionBatchSize > 1` routes through `extractGraphFromBodies`
 *       (batch path), writing a correct SQLite-backed graph snapshot for a 3-file stash.
 *   (h) Default batch size (=1) uses the per-asset `extractGraphFromBody` path
 *       — behaviour is identical to the original implementation.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AkmConfig, LlmConnectionConfig } from "../src/core/config";
import { closeDatabase, openDatabase } from "../src/indexer/db";
import { loadStoredGraphSnapshot } from "../src/indexer/graph-db";
import type { GraphExtractionResult } from "../src/indexer/graph-extraction";
import type { GraphExtraction } from "../src/llm/graph-extract";

// ── LLM stubs (module-level) ─────────────────────────────────────────────────

let batchExtractorStub: ((bodies: string[]) => Promise<GraphExtraction[]>) | null = null;
let singleExtractorStub: ((body: string) => Promise<GraphExtraction>) | null = null;
let batchCallCount = 0;
let singleCallCount = 0;

mock.module("../src/llm/graph-extract", () => ({
  extractGraphFromBody: async (_cfg: unknown, body: string) => {
    singleCallCount++;
    if (singleExtractorStub) return singleExtractorStub(body);
    return { entities: [], relations: [] };
  },
  extractGraphFromBodies: async (_cfg: unknown, bodies: string[]) => {
    batchCallCount++;
    if (batchExtractorStub) return batchExtractorStub(bodies);
    return bodies.map(() => ({ entities: [], relations: [] }));
  },
}));

// Import AFTER mocks.
const { runGraphExtractionPass, GRAPH_FILE_SCHEMA_VERSION } = await import("../src/indexer/graph-extraction");

// ── Fixture helpers ──────────────────────────────────────────────────────────

const SAMPLE_LLM: LlmConnectionConfig = {
  endpoint: "http://localhost:11434/v1/chat/completions",
  model: "llama3.2",
};

function makeConfig(overrides?: Partial<AkmConfig>): AkmConfig {
  return {
    semanticSearchMode: "auto",
    llm: { ...SAMPLE_LLM, features: { graph_extraction: true } },
    ...overrides,
  };
}

let tmpStash = "";

beforeEach(() => {
  tmpStash = fs.mkdtempSync(path.join(os.tmpdir(), "akm-batch-pass-"));
  fs.mkdirSync(path.join(tmpStash, "memories"), { recursive: true });
  fs.mkdirSync(path.join(tmpStash, "knowledge"), { recursive: true });
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
});

afterAll(() => {
  mock.restore();
});

function writeMemory(name: string, body: string): void {
  const content = `---\ntitle: ${name}\n---\n\n${body}\n`;
  fs.writeFileSync(path.join(tmpStash, "memories", `${name}.md`), content, "utf8");
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
          files: Array<{ entities: string[]; relations: unknown[] }>;
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
        files: Array<{ entities: string[]; relations: unknown[] }>;
      };
      expect(parsed.schemaVersion).toBe(GRAPH_FILE_SCHEMA_VERSION);
      expect(parsed.files).toHaveLength(2);
      expect(
        parsed.files.some((file) => file.entities.includes("ServiceA") && file.entities.includes("ServiceB")),
      ).toBe(true);
      expect(
        parsed.files.some((file) => file.entities.includes("Terraform") && file.entities.includes("ProdCluster")),
      ).toBe(true);
    } finally {
      closeDatabase(db);
    }
  });

  test("(h) default batchSize=1 uses per-asset path and behaves identically to original implementation", async () => {
    writeMemory("m1", "Alpha body.");
    writeMemory("m2", "Beta body.");

    const callBodies: string[] = [];
    singleExtractorStub = async (body) => {
      callBodies.push(body);
      if (body.includes("Alpha")) return { entities: ["Alpha"], relations: [] };
      if (body.includes("Beta")) return { entities: ["Beta"], relations: [] };
      return { entities: [], relations: [] };
    };

    // Use default (no graphExtractionBatchSize → defaults to 1).
    const db = openDatabase(path.join(tmpStash, "graph-default.db"));
    let result: GraphExtractionResult;
    try {
      result = await runGraphExtractionPass(makeConfig(), sources(), undefined, db);
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

  test("(g2) batchSize=2 chunks 5 files into 3 batch calls (2+2+1)", async () => {
    for (let i = 1; i <= 5; i++) writeMemory(`m${i}`, `Entity${i} uses Tool${i}.`);

    const callSizes: number[] = [];
    batchExtractorStub = async (bodies) => {
      callSizes.push(bodies.length);
      return bodies.map((_, j) => ({
        entities: [`E${j}`],
        relations: [],
      }));
    };

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

    // 5 files / batchSize=2 → chunks [2, 2, 1] → 3 batch calls.
    expect(batchCallCount).toBe(3);
    expect(callSizes).toEqual([2, 2, 1]);
    expect(result.considered).toBe(5);
    expect(result.extracted).toBe(5);
  });
});
