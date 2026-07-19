import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmGraphUpdate } from "../../../src/commands/graph/graph";
import { saveConfig } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { replaceStoredGraph } from "../../../src/indexer/db/graph-db";
import type {
  GraphExtractionPassContext,
  GraphExtractionPassOptions,
  GraphExtractionResult,
} from "../../../src/indexer/graph/graph-extraction";
import { GRAPH_FILE_SCHEMA_VERSION } from "../../../src/indexer/graph/graph-extraction";
import { probeIndexWriterLease } from "../../../src/indexer/index-writer-lock";
import { deriveEntryProvenance } from "../../../src/indexer/installations";
import { buildSearchText } from "../../../src/indexer/search/search-fields";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import { rebuildFts } from "../../../src/storage/repositories/index-fts-repository";
import { setMeta } from "../../../src/storage/repositories/index-meta-repository";

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalXdgStateHome = process.env.XDG_STATE_HOME;
const originalAkmStashDir = process.env.AKM_STASH_DIR;

let testConfigDir = "";
let testCacheDir = "";
let testDataDir = "";
let testStateDir = "";
let stashDir = "";

beforeEach(() => {
  testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-graph-update-config-"));
  testCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-graph-update-cache-"));
  testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-graph-update-data-"));
  testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-graph-update-state-"));
  stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-graph-update-stash-"));
  process.env.XDG_CONFIG_HOME = testConfigDir;
  process.env.XDG_CACHE_HOME = testCacheDir;
  process.env.XDG_DATA_HOME = testDataDir;
  process.env.XDG_STATE_HOME = testStateDir;
  process.env.AKM_STASH_DIR = stashDir;
  saveConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdgDataHome;
  if (originalXdgStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalXdgStateHome;
  if (originalAkmStashDir === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = originalAkmStashDir;
  for (const dir of [testConfigDir, testCacheDir, testDataDir, testStateDir, stashDir]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Seed a minimal index DB with two entries (knowledge:k1 and memory:m1). */
function seedIndex(): { k1Path: string; m1Path: string } {
  const knowledgeDir = path.join(stashDir, "knowledge");
  const memoryDir = path.join(stashDir, "memories");
  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.mkdirSync(memoryDir, { recursive: true });
  const k1Path = path.join(knowledgeDir, "k1.md");
  const m1Path = path.join(memoryDir, "m1.md");
  fs.writeFileSync(k1Path, "# Alpha entity description\n", "utf8");
  fs.writeFileSync(m1Path, "# Gamma entity description\n", "utf8");

  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openIndexDatabase(dbPath);
  try {
    const bundle = { bundleId: "stash", componentId: "stash", adapterId: "akm" };
    upsertEntry(
      db,
      `${stashDir}:knowledge:k1`,
      knowledgeDir,
      k1Path,
      stashDir,
      { name: "k1", type: "knowledge", filename: "k1.md", description: "Knowledge alpha" },
      buildSearchText({ name: "k1", type: "knowledge", filename: "k1.md", description: "Knowledge alpha" }),
      // F5: the new-grammar ref resolver (findEntryIdByRef → matchIdByItemRef)
      // matches on item_ref, so the seed must populate it like the real indexer.
      deriveEntryProvenance(bundle, "knowledge", "k1"),
    );
    upsertEntry(
      db,
      `${stashDir}:memory:m1`,
      memoryDir,
      m1Path,
      stashDir,
      { name: "m1", type: "memory", filename: "m1.md", description: "Memory gamma" },
      buildSearchText({ name: "m1", type: "memory", filename: "m1.md", description: "Memory gamma" }),
      deriveEntryProvenance(bundle, "memory", "m1"),
    );
    rebuildFts(db);
    setMeta(db, "stashDir", stashDir);
    setMeta(db, "builtAt", new Date().toISOString());
    setMeta(db, "stashDirs", JSON.stringify([stashDir]));
    // Seed an existing graph snapshot so the pass has data to work with.
    replaceStoredGraph(db, {
      schemaVersion: GRAPH_FILE_SCHEMA_VERSION,
      generatedAt: "2026-05-01T00:00:00.000Z",
      stashRoot: stashDir,
      files: [
        {
          path: k1Path,
          type: "knowledge",
          bodyHash: "k1-old-hash",
          entities: ["alpha"],
          relations: [],
        },
        {
          path: m1Path,
          type: "memory",
          bodyHash: "m1-old-hash",
          entities: ["gamma"],
          relations: [],
        },
      ],
    });
  } finally {
    closeDatabase(db);
  }
  return { k1Path, m1Path };
}

/** Build a fake GraphExtractionResult for a given set of extracted files. */
function fakeExtractionResult(extractedFiles: number): GraphExtractionResult {
  return {
    considered: extractedFiles,
    extracted: extractedFiles,
    totalEntities: extractedFiles * 2,
    totalRelations: extractedFiles,
    written: true,
    quality: {
      consideredFiles: extractedFiles,
      extractedFiles,
      entityCount: extractedFiles * 2,
      relationCount: extractedFiles,
      extractionCoverage: 1,
      density: 0.5,
    },
    telemetry: {
      cacheHits: 0,
      cacheMisses: extractedFiles,
      truncationCount: 0,
      failureCount: 0,
      retryAttempts: 0,
    },
    warnings: [],
  };
}

describe("akmGraphUpdate", () => {
  test("full update (no refs) calls extraction without candidatePaths and returns graph-update shape", async () => {
    seedIndex();

    let capturedOptions: GraphExtractionPassOptions | undefined;
    let lockHeldDuringExtraction = false;

    const result = await akmGraphUpdate({
      graphExtractionFn: async ({ options = {} }: GraphExtractionPassContext) => {
        capturedOptions = options;
        const probe = probeIndexWriterLease();
        lockHeldDuringExtraction = probe.state === "held" && probe.holderPid === process.pid;
        return fakeExtractionResult(2);
      },
    });

    expect(result.shape).toBe("graph-update");
    expect(result.ok).toBe(true);
    expect(result.scoped).toBe(false);
    expect(result.filesExtracted).toBe(2);
    expect(result.entitiesUpserted).toBe(4);
    expect(result.relationsUpserted).toBe(2);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(lockHeldDuringExtraction).toBe(true);
    // candidatePaths must be absent for a full pass.
    expect(capturedOptions?.candidatePaths).toBeUndefined();
  });

  test("scoped update with one ref passes candidatePaths containing the resolved file path", async () => {
    const { k1Path } = seedIndex();

    let capturedOptions: GraphExtractionPassOptions | undefined;

    const result = await akmGraphUpdate({
      refs: ["knowledge/k1"],
      graphExtractionFn: async ({ options = {} }: GraphExtractionPassContext) => {
        capturedOptions = options;
        return fakeExtractionResult(1);
      },
    });

    expect(result.shape).toBe("graph-update");
    expect(result.ok).toBe(true);
    expect(result.scoped).toBe(true);
    expect(capturedOptions?.candidatePaths).toBeDefined();
    expect(capturedOptions?.candidatePaths?.has(k1Path)).toBe(true);
    expect(capturedOptions?.candidatePaths?.size).toBe(1);
  });

  test("scoped update with multiple refs passes all resolved paths in candidatePaths", async () => {
    const { k1Path, m1Path } = seedIndex();

    let capturedOptions: GraphExtractionPassOptions | undefined;

    const result = await akmGraphUpdate({
      refs: ["knowledge/k1", "memories/m1"],
      graphExtractionFn: async ({ options = {} }: GraphExtractionPassContext) => {
        capturedOptions = options;
        return fakeExtractionResult(2);
      },
    });

    expect(result.shape).toBe("graph-update");
    expect(result.ok).toBe(true);
    expect(result.scoped).toBe(true);
    expect(capturedOptions?.candidatePaths?.has(k1Path)).toBe(true);
    expect(capturedOptions?.candidatePaths?.has(m1Path)).toBe(true);
    expect(capturedOptions?.candidatePaths?.size).toBe(2);
  });

  test("unknown ref emits a warning and skips without crashing — returns ok with zero extraction", async () => {
    seedIndex();

    let extractionCalled = false;
    const result = await akmGraphUpdate({
      refs: ["knowledge/does-not-exist"],
      graphExtractionFn: async () => {
        extractionCalled = true;
        return fakeExtractionResult(0);
      },
    });

    // The function should not throw, and since no paths were resolved it
    // returns early with zeros rather than calling the extraction fn.
    expect(result.shape).toBe("graph-update");
    expect(result.ok).toBe(true);
    expect(result.scoped).toBe(true);
    expect(result.filesExtracted).toBe(0);
    expect(extractionCalled).toBe(false);
  });

  test("mixed refs — known and unknown — only passes known paths in candidatePaths", async () => {
    const { k1Path } = seedIndex();

    let capturedOptions: GraphExtractionPassOptions | undefined;

    const result = await akmGraphUpdate({
      refs: ["knowledge/k1", "knowledge/ghost-ref"],
      graphExtractionFn: async ({ options = {} }: GraphExtractionPassContext) => {
        capturedOptions = options;
        return fakeExtractionResult(1);
      },
    });

    expect(result.shape).toBe("graph-update");
    expect(result.ok).toBe(true);
    expect(result.scoped).toBe(true);
    expect(capturedOptions?.candidatePaths?.has(k1Path)).toBe(true);
    expect(capturedOptions?.candidatePaths?.size).toBe(1);
  });
});
