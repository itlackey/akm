import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  akmGraphEntities,
  akmGraphEntity,
  akmGraphExport,
  akmGraphOrphans,
  akmGraphRelated,
  akmGraphRelations,
  akmGraphSummary,
} from "../../../src/commands/graph/graph";
import { saveConfig } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { deleteStoredGraph, replaceStoredGraph } from "../../../src/indexer/db/graph-db";
import { GRAPH_FILE_SCHEMA_VERSION } from "../../../src/indexer/graph/graph-extraction";
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
  const db = openIndexDatabase(dbPath);
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
  // Graph rows are keyed on entries.id (schema v2). Seed the minimal
  // entries the fixture references so replaceStoredGraph can resolve
  // entry_ids for each file_path.
  const knowledgeDir = path.join(stashDir, "knowledge");
  const memoryDir = path.join(stashDir, "memories");
  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.mkdirSync(memoryDir, { recursive: true });
  const k1Path = path.join(knowledgeDir, "k1.md");
  const m1Path = path.join(memoryDir, "m1.md");
  if (!fs.existsSync(k1Path)) fs.writeFileSync(k1Path, "# Alpha\n", "utf8");
  if (!fs.existsSync(m1Path)) fs.writeFileSync(m1Path, "# Gamma\n", "utf8");

  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openIndexDatabase(dbPath);
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
    replaceStoredGraph(db, {
      schemaVersion: GRAPH_FILE_SCHEMA_VERSION,
      generatedAt: "2026-05-01T00:00:00.000Z",
      stashRoot: stashDir,
      files: [
        {
          path: k1Path,
          type: "knowledge",
          bodyHash: "k1-body-hash",
          entities: ["alpha", "beta"],
          relations: [{ from: "alpha", to: "beta", type: "uses" }],
        },
        {
          path: m1Path,
          type: "memory",
          bodyHash: "m1-body-hash",
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
      telemetry: {
        extractorId: "graph-extraction:v2:test",
        extractionRunId: "run-123",
        model: "test-model",
        promptVersion: "v2",
        batchSize: 4,
        cacheHits: 1,
        cacheMisses: 1,
        truncationCount: 0,
        failureCount: 0,
        retryAttempts: 0,
      },
    });
  } finally {
    closeDatabase(db);
  }
  return getDbPath();
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
    expect(result.telemetry?.model).toBe("test-model");
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
    const db = openIndexDatabase(dbPath);
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

    const graphDb = openIndexDatabase(getDbPath());
    try {
      replaceStoredGraph(graphDb, {
        schemaVersion: GRAPH_FILE_SCHEMA_VERSION,
        generatedAt: "2026-05-01T00:00:00.000Z",
        stashRoot: secondaryStashDir,
        files: [
          {
            path: sharedPath,
            type: "knowledge",
            bodyHash: "shared-body-hash",
            entities: ["Shared", "Guide"],
            relations: [{ from: "Shared", to: "Guide" }],
          },
          {
            path: neighborPath,
            type: "memory",
            bodyHash: "neighbor-body-hash",
            entities: ["Shared"],
            relations: [{ from: "Shared", to: "Neighbor" }],
          },
        ],
      });
    } finally {
      closeDatabase(graphDb);
    }

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

  test("related result populates canonical ref alongside legacy path", async () => {
    writeGraphArtifact();
    seedGraphLookupIndex();
    const result = await akmGraphRelated({ ref: "knowledge:k1" });
    expect(result.shape).toBe("graph-related");
    expect(result.related.length).toBe(1);
    const first = result.related[0];
    expect(first).toBeDefined();
    expect(typeof first?.path).toBe("string");
    // Canonical ref is `type:name`, with the stash-dir prefix stripped from
    // entries.entry_key. The legacy `path` field must remain populated for
    // back-compat consumers.
    expect(first?.ref).toBe("memories/m1");
    expect(first?.ref?.includes(stashDir)).toBe(false);
    expect(first?.ref?.startsWith(":")).toBe(false);
  });
});

// ── Gap 1: akm graph entity <name> ──────────────────────────────────────────

function writeEntityFixture(): void {
  const knowledgeDir = path.join(stashDir, "knowledge");
  const memoryDir = path.join(stashDir, "memories");
  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.mkdirSync(memoryDir, { recursive: true });
  const deployRunbookPath = path.join(knowledgeDir, "deploy-runbook.md");
  const deployIncidentPath = path.join(memoryDir, "deploy-incident.md");
  const otherPath = path.join(knowledgeDir, "other.md");
  fs.writeFileSync(deployRunbookPath, "# Deploy runbook\n", "utf8");
  fs.writeFileSync(deployIncidentPath, "# Deploy incident\n", "utf8");
  fs.writeFileSync(otherPath, "# Other topic\n", "utf8");

  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openIndexDatabase(dbPath);
  try {
    const entries: Array<{ key: string; type: string; name: string; filePath: string; dirPath: string }> = [
      {
        key: `${stashDir}:knowledge:deploy-runbook`,
        type: "knowledge",
        name: "deploy-runbook",
        filePath: deployRunbookPath,
        dirPath: knowledgeDir,
      },
      {
        key: `${stashDir}:memory:deploy-incident`,
        type: "memory",
        name: "deploy-incident",
        filePath: deployIncidentPath,
        dirPath: memoryDir,
      },
      {
        key: `${stashDir}:knowledge:other`,
        type: "knowledge",
        name: "other",
        filePath: otherPath,
        dirPath: knowledgeDir,
      },
    ];
    for (const e of entries) {
      const entry = { name: e.name, type: e.type, filename: path.basename(e.filePath) };
      upsertEntry(db, e.key, e.dirPath, e.filePath, stashDir, entry, buildSearchText(entry));
    }
    rebuildFts(db);
    setMeta(db, "stashDir", stashDir);
    setMeta(db, "builtAt", new Date().toISOString());
    setMeta(db, "stashDirs", JSON.stringify([stashDir]));
    replaceStoredGraph(db, {
      schemaVersion: GRAPH_FILE_SCHEMA_VERSION,
      generatedAt: "2026-05-01T00:00:00.000Z",
      stashRoot: stashDir,
      files: [
        {
          path: deployRunbookPath,
          type: "knowledge",
          bodyHash: "deploy-runbook-hash",
          entities: ["deploy", "rollback"],
          relations: [],
          confidence: 0.9,
        },
        {
          path: deployIncidentPath,
          type: "memory",
          bodyHash: "deploy-incident-hash",
          entities: ["deploy", "incident"],
          relations: [],
          confidence: 0.5,
        },
        {
          path: otherPath,
          type: "knowledge",
          bodyHash: "other-hash",
          entities: ["unrelated"],
          relations: [],
        },
      ],
    });
  } finally {
    closeDatabase(db);
  }
}

describe("akm graph entity (direct API)", () => {
  test("returns the files that contain the entity, with refs and confidence", () => {
    writeEntityFixture();
    // AKM_STASH_DIR is set to stashDir by the beforeEach, so omitting
    // `source` resolves to the same primary source.
    const result = akmGraphEntity({ name: "deploy" });
    expect(result.shape).toBe("graph-entity");
    expect(result.entity).toBe("deploy");
    expect(result.total).toBe(2);
    expect(result.matches.length).toBe(2);
    for (const match of result.matches) {
      expect(typeof match.ref).toBe("string");
      expect(match.ref).toMatch(/^(memories|knowledge)\//);
    }
    // Sorted by confidence desc, so the runbook (0.9) appears before the
    // incident memory (0.5).
    expect(result.matches[0]?.ref).toBe("knowledge/deploy-runbook");
    expect(result.matches[0]?.confidence).toBe(0.9);
    expect(result.matches[1]?.ref).toBe("memories/deploy-incident");
    expect(result.matches[1]?.confidence).toBe(0.5);
  });

  test("matches case-insensitively", () => {
    writeEntityFixture();
    const lower = akmGraphEntity({ name: "deploy" });
    const upper = akmGraphEntity({ name: "DEPLOY" });
    expect(upper.total).toBe(lower.total);
    expect(upper.matches.map((m) => m.ref)).toEqual(lower.matches.map((m) => m.ref));
  });
});

// ── Gap 2: akm graph orphans ────────────────────────────────────────────────

function writeOrphanFixture(): { orphanPath: string } {
  const knowledgeDir = path.join(stashDir, "knowledge");
  const memoryDir = path.join(stashDir, "memories");
  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.mkdirSync(memoryDir, { recursive: true });
  const richKnowledgePath = path.join(knowledgeDir, "rich-knowledge.md");
  const richMemoryPath = path.join(memoryDir, "rich-memory.md");
  const orphanPath = path.join(knowledgeDir, "orphan.md");
  fs.writeFileSync(richKnowledgePath, "# Rich knowledge\n", "utf8");
  fs.writeFileSync(richMemoryPath, "# Rich memory\n", "utf8");
  fs.writeFileSync(orphanPath, "# Orphan\n", "utf8");

  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openIndexDatabase(dbPath);
  try {
    const entries: Array<{ key: string; type: string; name: string; filePath: string; dirPath: string }> = [
      {
        key: `${stashDir}:knowledge:rich-knowledge`,
        type: "knowledge",
        name: "rich-knowledge",
        filePath: richKnowledgePath,
        dirPath: knowledgeDir,
      },
      {
        key: `${stashDir}:memory:rich-memory`,
        type: "memory",
        name: "rich-memory",
        filePath: richMemoryPath,
        dirPath: memoryDir,
      },
      {
        key: `${stashDir}:knowledge:orphan`,
        type: "knowledge",
        name: "orphan",
        filePath: orphanPath,
        dirPath: knowledgeDir,
      },
    ];
    for (const e of entries) {
      const entry = { name: e.name, type: e.type, filename: path.basename(e.filePath) };
      upsertEntry(db, e.key, e.dirPath, e.filePath, stashDir, entry, buildSearchText(entry));
    }
    rebuildFts(db);
    setMeta(db, "stashDir", stashDir);
    setMeta(db, "builtAt", new Date().toISOString());
    setMeta(db, "stashDirs", JSON.stringify([stashDir]));
    replaceStoredGraph(db, {
      schemaVersion: GRAPH_FILE_SCHEMA_VERSION,
      generatedAt: "2026-05-01T00:00:00.000Z",
      stashRoot: stashDir,
      files: [
        {
          path: richKnowledgePath,
          type: "knowledge",
          bodyHash: "rich-knowledge-hash",
          entities: ["alpha", "beta"],
          relations: [],
        },
        {
          path: richMemoryPath,
          type: "memory",
          bodyHash: "rich-memory-hash",
          entities: ["beta", "gamma"],
          relations: [],
        },
        {
          path: orphanPath,
          type: "knowledge",
          bodyHash: "orphan-hash",
          entities: [],
          relations: [],
        },
      ],
    });
  } finally {
    closeDatabase(db);
  }
  return { orphanPath };
}

describe("akm graph orphans (direct API)", () => {
  test("identifies entity-less graph files and surfaces refs", () => {
    const { orphanPath } = writeOrphanFixture();
    const result = akmGraphOrphans();
    expect(result.shape).toBe("graph-orphans");
    expect(result.totalConsidered).toBe(3);
    expect(result.total).toBe(1);
    expect(result.orphans.length).toBe(1);
    const orphan = result.orphans[0];
    expect(orphan?.path).toBe(orphanPath);
    expect(orphan?.type).toBe("knowledge");
    expect(orphan?.ref).toBe("knowledge/orphan");
  });
});

// ── Gap 3: ON DELETE CASCADE from entries → graph rows ──────────────────────

describe("graph rows survive entries removal (#624-P1)", () => {
  test("removing an entry PRESERVES its graph_* rows (graph is self-keyed)", () => {
    const knowledgeDir = path.join(stashDir, "knowledge");
    fs.mkdirSync(knowledgeDir, { recursive: true });
    const filePath = path.join(knowledgeDir, "cascade.md");
    fs.writeFileSync(filePath, "# Cascade\n", "utf8");

    const dbPath = getDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = openIndexDatabase(dbPath);
    try {
      const entry = { name: "cascade", type: "knowledge", filename: "cascade.md" };
      upsertEntry(db, `${stashDir}:knowledge:cascade`, knowledgeDir, filePath, stashDir, entry, buildSearchText(entry));
      rebuildFts(db);
      setMeta(db, "stashDir", stashDir);
      setMeta(db, "builtAt", new Date().toISOString());
      setMeta(db, "stashDirs", JSON.stringify([stashDir]));
      replaceStoredGraph(db, {
        schemaVersion: GRAPH_FILE_SCHEMA_VERSION,
        generatedAt: "2026-05-01T00:00:00.000Z",
        stashRoot: stashDir,
        files: [
          {
            path: filePath,
            type: "knowledge",
            bodyHash: "cascade-hash",
            entities: ["cascadeA", "cascadeB"],
            relations: [{ from: "cascadeA", to: "cascadeB", type: "uses" }],
          },
        ],
      });

      const entryRow = db.prepare("SELECT id FROM entries WHERE entry_key = ?").get(`${stashDir}:knowledge:cascade`) as
        | { id: number }
        | undefined;
      expect(entryRow).toBeDefined();
      const entryId = entryRow?.id;
      if (entryId === undefined) throw new Error("expected entry id");

      // Pre-condition: all three graph tables have rows for this file_path.
      const fileCount = () =>
        (db.prepare("SELECT COUNT(*) AS c FROM graph_files WHERE file_path = ?").get(filePath) as { c: number }).c;
      const entityCount = () =>
        (db.prepare("SELECT COUNT(*) AS c FROM graph_file_entities WHERE file_path = ?").get(filePath) as { c: number })
          .c;
      const relationCount = () =>
        (
          db.prepare("SELECT COUNT(*) AS c FROM graph_file_relations WHERE file_path = ?").get(filePath) as {
            c: number;
          }
        ).c;
      expect(fileCount()).toBe(1);
      expect(entityCount()).toBe(2);
      expect(relationCount()).toBe(1);

      // #624-P1: deleting the entries row must NOT wipe the graph rows. The
      // graph is keyed on (stash_root, file_path, body_hash), with no FK back
      // to entries(id), so it survives a reindex's delete + reinsert.
      db.prepare("DELETE FROM entries WHERE id = ?").run(entryId);
      expect(fileCount()).toBe(1);
      expect(entityCount()).toBe(2);
      expect(relationCount()).toBe(1);

      // deleteStoredGraph remains the explicit full-clear path for a stash.
      deleteStoredGraph(db, stashDir);
      expect(fileCount()).toBe(0);
      expect(entityCount()).toBe(0);
      expect(relationCount()).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });
});

// ── Gap 4: replaceStoredGraph incremental upsert ────────────────────────────
//
// The Phase 2 incremental upsert is supposed to skip files whose
// body_hash matches the row already in the DB — only touching changed
// rows. Verify by stamping a sentinel entity onto each row before the
// second pass: if the file's body_hash is unchanged the row is taken
// down the UPDATE-only path (file_order/confidence only) and the
// sentinel survives; if the body_hash changed, the row is delete-
// inserted and the sentinel is wiped.

describe("replaceStoredGraph incremental upsert", () => {
  test("skips unchanged rows, rewrites changed rows, removes vanished rows, inserts new rows", () => {
    const knowledgeDir = path.join(stashDir, "knowledge");
    fs.mkdirSync(knowledgeDir, { recursive: true });
    const file1Path = path.join(knowledgeDir, "f1.md");
    const file2Path = path.join(knowledgeDir, "f2.md");
    const file3Path = path.join(knowledgeDir, "f3.md");
    const file4Path = path.join(knowledgeDir, "f4.md");
    fs.writeFileSync(file1Path, "# F1\n", "utf8");
    fs.writeFileSync(file2Path, "# F2\n", "utf8");
    fs.writeFileSync(file3Path, "# F3\n", "utf8");
    fs.writeFileSync(file4Path, "# F4\n", "utf8");

    const dbPath = getDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = openIndexDatabase(dbPath);
    try {
      for (const name of ["f1", "f2", "f3", "f4"]) {
        const filePath = path.join(knowledgeDir, `${name}.md`);
        const entry = { name, type: "knowledge", filename: `${name}.md` };
        upsertEntry(
          db,
          `${stashDir}:knowledge:${name}`,
          knowledgeDir,
          filePath,
          stashDir,
          entry,
          buildSearchText(entry),
        );
      }
      rebuildFts(db);
      setMeta(db, "stashDir", stashDir);
      setMeta(db, "builtAt", new Date().toISOString());
      setMeta(db, "stashDirs", JSON.stringify([stashDir]));

      replaceStoredGraph(db, {
        schemaVersion: GRAPH_FILE_SCHEMA_VERSION,
        generatedAt: "2026-05-01T00:00:00.000Z",
        stashRoot: stashDir,
        files: [
          { path: file1Path, type: "knowledge", bodyHash: "f1-hash-v1", entities: ["e1"], relations: [] },
          { path: file2Path, type: "knowledge", bodyHash: "f2-hash-v1", entities: ["e2"], relations: [] },
          { path: file3Path, type: "knowledge", bodyHash: "f3-hash-v1", entities: ["e3"], relations: [] },
        ],
      });

      // Stable-marker trick: stamp a sentinel entity onto every existing
      // row. If the second pass leaves a row alone (body_hash matched),
      // the sentinel survives; if it's delete-and-reinserted, the
      // sentinel is wiped along with the rest of the children.
      const beforeRows = db
        .prepare("SELECT file_path, body_hash FROM graph_files WHERE stash_root = ?")
        .all(stashDir) as Array<{ file_path: string; body_hash: string }>;
      for (const row of beforeRows) {
        db.prepare(
          "INSERT INTO graph_file_entities (stash_root, file_path, body_hash, entity_order, entity_norm, entity) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(stashDir, row.file_path, row.body_hash, 99, "__sentinel__", "__sentinel__");
      }

      replaceStoredGraph(db, {
        schemaVersion: GRAPH_FILE_SCHEMA_VERSION,
        generatedAt: "2026-05-02T00:00:00.000Z",
        stashRoot: stashDir,
        files: [
          // unchanged — same body_hash
          { path: file1Path, type: "knowledge", bodyHash: "f1-hash-v1", entities: ["e1"], relations: [] },
          // changed — different body_hash
          { path: file2Path, type: "knowledge", bodyHash: "f2-hash-v2", entities: ["e2new"], relations: [] },
          // file 3 missing → should be removed
          // new file
          { path: file4Path, type: "knowledge", bodyHash: "f4-hash-v1", entities: ["e4"], relations: [] },
        ],
      });

      const afterRows = db
        .prepare("SELECT file_path, body_hash FROM graph_files WHERE stash_root = ?")
        .all(stashDir) as Array<{ file_path: string; body_hash: string }>;
      const afterByPath = new Map(afterRows.map((r) => [r.file_path, r]));

      const f1After = afterByPath.get(file1Path);
      expect(f1After).toBeDefined();
      expect(f1After?.body_hash).toBe("f1-hash-v1");

      const f2After = afterByPath.get(file2Path);
      expect(f2After).toBeDefined();
      expect(f2After?.body_hash).toBe("f2-hash-v2");

      // f3: removed.
      expect(afterByPath.has(file3Path)).toBe(false);

      // f4: new.
      expect(afterByPath.has(file4Path)).toBe(true);
      expect(afterByPath.get(file4Path)?.body_hash).toBe("f4-hash-v1");

      // Entity tables prove which files were rewritten.
      const entityRows = db
        .prepare(
          `SELECT gf.file_path AS file_path, gfe.entity AS entity
             FROM graph_file_entities gfe
             JOIN graph_files gf
               ON gf.stash_root = gfe.stash_root
              AND gf.file_path = gfe.file_path
              AND gf.body_hash = gfe.body_hash
            WHERE gf.stash_root = ?
            ORDER BY gf.file_path, gfe.entity_order`,
        )
        .all(stashDir) as Array<{ file_path: string; entity: string }>;
      const entitiesByPath = new Map<string, string[]>();
      for (const row of entityRows) {
        const bucket = entitiesByPath.get(row.file_path) ?? [];
        bucket.push(row.entity);
        entitiesByPath.set(row.file_path, bucket);
      }
      // f1 unchanged: original entity plus our sentinel must both be present.
      expect(entitiesByPath.get(file1Path)?.sort()).toEqual(["__sentinel__", "e1"]);
      // f2 changed: only the new entity, sentinel got wiped.
      expect(entitiesByPath.get(file2Path)).toEqual(["e2new"]);
      // f3 removed: no entity rows survive.
      expect(entitiesByPath.has(file3Path)).toBe(false);
      // f4 new: fresh insert from snapshot.
      expect(entitiesByPath.get(file4Path)).toEqual(["e4"]);
    } finally {
      closeDatabase(db);
    }
  });
});
