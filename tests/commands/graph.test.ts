import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmGraphEntities, akmGraphExport, akmGraphRelations, akmGraphSummary } from "../../src/commands/graph";
import { saveConfig } from "../../src/core/config";
import { getGraphFilePath } from "../../src/indexer/graph-extraction";

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
