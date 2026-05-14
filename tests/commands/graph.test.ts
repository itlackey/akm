import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  akmGraphEntities,
  akmGraphExport,
  akmGraphRelated,
  akmGraphRelations,
  akmGraphSummary,
} from "../../src/commands/graph";
import { saveConfig } from "../../src/core/config";
import { getDbPath } from "../../src/core/paths";
import { closeDatabase, openDatabase, rebuildFts, setMeta, upsertEntry } from "../../src/indexer/db";
import { getGraphFilePath } from "../../src/indexer/graph-extraction";
import { buildSearchText } from "../../src/indexer/search-fields";

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
let secondaryStashDir = "";

function seedGraphLookupIndex(): void {
  const knowledgeDir = path.join(stashDir, "knowledge");
  const memoryDir = path.join(stashDir, "memories");
  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.mkdirSync(memoryDir, { recursive: true });
  const k1Path = path.join(knowledgeDir, "k1.md");
  const m1Path = path.join(memoryDir, "m1.md");
  fs.writeFileSync(k1Path, "# Alpha\n", "utf8");
  fs.writeFileSync(m1Path, "# Gamma\n", "utf8");

  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  try {
    upsertEntry(
      db,
      `${stashDir}:knowledge:k1`,
      knowledgeDir,
      k1Path,
      stashDir,
      { name: "k1", type: "knowledge", filename: "k1.md", description: "Knowledge alpha" },
      buildSearchText({ name: "k1", type: "knowledge", filename: "k1.md", description: "Knowledge alpha" }),
    );
    upsertEntry(
      db,
      `${stashDir}:memory:m1`,
      memoryDir,
      m1Path,
      stashDir,
      { name: "m1", type: "memory", filename: "m1.md", description: "Memory gamma" },
      buildSearchText({ name: "m1", type: "memory", filename: "m1.md", description: "Memory gamma" }),
    );
    rebuildFts(db);
    setMeta(db, "stashDir", stashDir);
    setMeta(db, "builtAt", new Date().toISOString());
    setMeta(db, "stashDirs", JSON.stringify([stashDir]));
  } finally {
    closeDatabase(db);
  }
}

function writeGraphArtifact(): string {
  const graphPath = getGraphFilePath(stashDir);
  fs.mkdirSync(path.dirname(graphPath), { recursive: true });
  fs.writeFileSync(
    graphPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: "2026-05-01T00:00:00.000Z",
        stashRoot: stashDir,
        files: [
          {
            path: path.join(stashDir, "knowledge", "k1.md"),
            type: "knowledge",
            entities: ["alpha", "beta"],
            relations: [{ from: "alpha", to: "beta", type: "uses" }],
          },
          {
            path: path.join(stashDir, "memories", "m1.md"),
            type: "memory",
            entities: ["alpha", "gamma"],
            relations: [{ from: "alpha", to: "gamma" }],
          },
        ],
        entities: ["alpha", "beta", "gamma"],
        relations: [
          { from: "alpha", to: "beta", type: "uses" },
          { from: "alpha", to: "gamma" },
        ],
        quality: {
          consideredFiles: 2,
          extractedFiles: 2,
          entityCount: 3,
          relationCount: 2,
          extractionCoverage: 1,
          density: 0.6667,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return graphPath;
}

beforeEach(() => {
  testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-graph-config-"));
  testCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-graph-cache-"));
  testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-graph-data-"));
  testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-graph-state-"));
  stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-graph-stash-"));
  secondaryStashDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-graph-secondary-"));
  process.env.XDG_CONFIG_HOME = testConfigDir;
  process.env.XDG_CACHE_HOME = testCacheDir;
  process.env.XDG_DATA_HOME = testDataDir;
  process.env.XDG_STATE_HOME = testStateDir;
  process.env.AKM_STASH_DIR = stashDir;
  saveConfig({
    semanticSearchMode: "off",
    sources: [{ type: "filesystem", path: secondaryStashDir, name: "sec-a" }],
  });
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
  for (const dir of [testConfigDir, testCacheDir, testDataDir, testStateDir, stashDir, secondaryStashDir]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("akm graph", () => {
  test("summary returns counts and quality telemetry", () => {
    const graphPath = writeGraphArtifact();
    const result = akmGraphSummary();
    expect(result.shape).toBe("graph-summary");
    expect(result.graphPath).toBe(graphPath);
    expect(result.fileCount).toBe(2);
    expect(result.entityCount).toBe(3);
    expect(result.relationCount).toBe(2);
    expect(result.quality?.density).toBe(0.6667);
  });

  test("entities returns ranked entity list with limits", () => {
    writeGraphArtifact();
    const result = akmGraphEntities({ limit: 2 });
    expect(result.shape).toBe("graph-entities");
    expect(result.total).toBe(3);
    expect(result.entities).toEqual([
      { name: "alpha", fileCount: 2 },
      { name: "beta", fileCount: 1 },
    ]);
  });

  test("relations returns deduplicated relation counts", () => {
    writeGraphArtifact();
    const result = akmGraphRelations();
    expect(result.shape).toBe("graph-relations");
    expect(result.total).toBe(2);
    expect(result.relations[0]).toEqual({ from: "alpha", to: "beta", type: "uses", count: 1 });
  });

  test("related resolves neighboring assets for a ref", async () => {
    writeGraphArtifact();
    seedGraphLookupIndex();
    const result = await akmGraphRelated({ ref: "knowledge:k1" });
    expect(result.shape).toBe("graph-related");
    expect(result.ref).toBe("knowledge:k1");
    expect(result.total).toBe(1);
    expect(result.related[0]?.type).toBe("memory");
    expect(result.related[0]?.sharedEntities).toContain("alpha");
  });

  test("related infers source graph from resolved secondary asset path", async () => {
    const secKnowledgeDir = path.join(secondaryStashDir, "knowledge");
    const secMemoryDir = path.join(secondaryStashDir, "memories");
    fs.mkdirSync(secKnowledgeDir, { recursive: true });
    fs.mkdirSync(secMemoryDir, { recursive: true });
    const sharedPath = path.join(secKnowledgeDir, "shared.md");
    const neighborPath = path.join(secMemoryDir, "neighbor.md");
    fs.writeFileSync(sharedPath, "# Shared\n", "utf8");
    fs.writeFileSync(neighborPath, "# Neighbor\n", "utf8");

    const dbPath = getDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = openDatabase(dbPath);
    try {
      upsertEntry(
        db,
        `${secondaryStashDir}:knowledge:shared`,
        secKnowledgeDir,
        sharedPath,
        secondaryStashDir,
        { name: "shared", type: "knowledge", filename: "shared.md", description: "Secondary shared" },
        buildSearchText({ name: "shared", type: "knowledge", filename: "shared.md", description: "Secondary shared" }),
      );
      upsertEntry(
        db,
        `${secondaryStashDir}:memory:neighbor`,
        secMemoryDir,
        neighborPath,
        secondaryStashDir,
        { name: "neighbor", type: "memory", filename: "neighbor.md", description: "Secondary neighbor" },
        buildSearchText({
          name: "neighbor",
          type: "memory",
          filename: "neighbor.md",
          description: "Secondary neighbor",
        }),
      );
      rebuildFts(db);
      setMeta(db, "stashDir", stashDir);
      setMeta(db, "builtAt", new Date().toISOString());
      setMeta(db, "stashDirs", JSON.stringify([stashDir, secondaryStashDir]));
    } finally {
      closeDatabase(db);
    }

    const graphPath = getGraphFilePath(secondaryStashDir);
    fs.mkdirSync(path.dirname(graphPath), { recursive: true });
    fs.writeFileSync(
      graphPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          generatedAt: "2026-05-01T00:00:00.000Z",
          stashRoot: secondaryStashDir,
          files: [
            {
              path: sharedPath,
              type: "knowledge",
              entities: ["Shared", "Guide"],
              relations: [{ from: "Shared", to: "Guide" }],
            },
            {
              path: neighborPath,
              type: "memory",
              entities: ["Shared"],
              relations: [{ from: "Shared", to: "Neighbor" }],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await akmGraphRelated({ ref: "sec-a//knowledge:shared" });
    expect(result.stashPath).toBe(secondaryStashDir);
    expect(result.total).toBe(1);
    expect(result.related[0]?.type).toBe("memory");
  });

  test("export writes JSONL output", () => {
    writeGraphArtifact();
    const out = path.join(stashDir, "graph-export.jsonl");
    const result = akmGraphExport({ out, format: "jsonl" });
    expect(result.shape).toBe("graph-export");
    expect(result.outPath).toBe(out);
    expect(result.bytes).toBeGreaterThan(0);
    const lines = fs.readFileSync(out, "utf8").trim().split("\n");
    expect(lines.length).toBe(6);
  });
});
