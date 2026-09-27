/**
 * Integration tests for the graph's read side: `listRelatedPathsForFile`
 * (`akm show`'s related list and curate's support refs), and that the stored
 * graph plays no part in search ranking. No LLM calls are made — the graph
 * snapshot is written directly to the fixture DB, simulating what the
 * extraction pass would produce.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmSearch } from "../../../src/commands/read/search";
import { resetConfigCache, saveConfig } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { deleteStoredGraph, replaceStoredGraph } from "../../../src/indexer/db/graph-db";
import { GRAPH_FILE_SCHEMA_VERSION } from "../../../src/indexer/graph/graph-extraction";
import { listRelatedPathsForFile } from "../../../src/indexer/graph/graph-related";
import type { GraphFile } from "../../../src/indexer/graph/graph-types";
import { deriveEntryProvenance } from "../../../src/indexer/installations";
import type { IndexDocument } from "../../../src/indexer/passes/metadata";
import { buildSearchText } from "../../../src/indexer/search/search-fields";
import {
  closeDatabase,
  openExistingDatabase,
  openIndexDatabase,
} from "../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import { rebuildFts } from "../../../src/storage/repositories/index-fts-repository";
import { setMeta } from "../../../src/storage/repositories/index-meta-repository";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
  sandboxXdgStateHome,
} from "../../_helpers/sandbox";

// ── Environment isolation ───────────────────────────────────────────────────
//
// The whole corpus + graph fixture is built ONCE in beforeAll (it's expensive
// and every test reads or mutates the same shared DB). Because the suite runs
// all 253 test files in ONE process sharing process.env, the env vars this
// file's DB depends on must be re-asserted before EACH test so another
// concurrently-interleaved file can't clobber XDG_DATA_HOME / AKM_BUNDLE_DIR
// mid-run and point our index DB resolution at the wrong file. We sandbox to
// STABLE per-file dirs (created once in beforeAll, re-pointed in beforeEach)
// rather than rebuilding the fixture per test.

let stashDir = "";
let fileCacheHome = "";
let fileConfigHome = "";
let fileDataHome = "";
let fileStateHome = "";
let envCleanup: Cleanup = () => {};

beforeAll(() => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const dataResult = sandboxXdgDataHome(cfgResult.cleanup);
  const stateResult = sandboxXdgStateHome(dataResult.cleanup);
  const stashResult = sandboxStashDir(stateResult.cleanup);
  fileCacheHome = cacheResult.dir;
  fileConfigHome = cfgResult.dir;
  fileDataHome = dataResult.dir;
  fileStateHome = stateResult.dir;
  stashDir = stashResult.dir;
  envCleanup = stashResult.cleanup;

  resetConfigCache();
  saveTestConfig();

  buildFixture();
});

beforeEach(() => {
  // Re-establish the env vars this file's pre-built index/graph DB depends on,
  // pointing back at the SAME stable per-file dirs (not fresh ones) so the
  // fixture built in beforeAll is reused.
  process.env.XDG_CACHE_HOME = fileCacheHome;
  process.env.XDG_CONFIG_HOME = fileConfigHome;
  process.env.XDG_DATA_HOME = fileDataHome;
  process.env.XDG_STATE_HOME = fileStateHome;
  process.env.AKM_BUNDLE_DIR = stashDir;
  resetConfigCache();
});

// ISOLATION-05: the DB built in beforeAll is shared and mutated by tests
// (installGraph/uninstallGraph), so every test establishes its own
// install/uninstall state before asserting rather than relying on what a
// previous test left behind.

afterAll(() => {
  envCleanup();
  envCleanup = () => {};
  resetConfigCache();
});

// ── Fixture builder ─────────────────────────────────────────────────────────
//
// A small corpus about one database outage. The graph links the runbook and
// the incident memory through shared entities; the checklist's only entity
// ("playbook") is shared with nothing.

function buildFixture(): void {
  // Asset files on disk — graph rows are keyed by absolute file path, so
  // paths must be consistent between fixture build and graph snapshot
  // contents.
  const knowledgeDir = path.join(stashDir, "knowledge");
  const memoryDir = path.join(stashDir, "memories");
  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.mkdirSync(memoryDir, { recursive: true });

  const runbookPath = path.join(knowledgeDir, "database-runbook.md");
  fs.writeFileSync(
    runbookPath,
    "---\ntype: knowledge\n---\n\nThe runbook for database outage recovery after a hardware fault.\n",
  );

  const faqPath = path.join(knowledgeDir, "database-faq.md");
  fs.writeFileSync(
    faqPath,
    "---\ntype: knowledge\n---\n\nA database FAQ covering connection limits, recovery tunables, and outage post-mortems.\n",
  );

  const memoryPath = path.join(memoryDir, "incident-2024-shard.md");
  fs.writeFileSync(
    memoryPath,
    "---\ntype: memory\n---\n\nDuring the 2024 database outage we recovered shard-3 by following the runbook.\n",
  );

  const checklistPath = path.join(knowledgeDir, "incident-checklist.md");
  fs.writeFileSync(
    checklistPath,
    "---\ntype: knowledge\n---\n\nDatabase outage recovery checklist for incident triage and escalation.\n",
  );

  // Index the corpus directly into the SQLite DB.
  const dbPath = getDbPath();
  // Make sure the cache dir exists (akm-graph-rank-cache-* is fresh).
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openIndexDatabase(dbPath);
  try {
    const entries: Array<{ entry: IndexDocument; filePath: string; dirPath: string }> = [
      {
        entry: {
          name: "database-runbook",
          type: "knowledge",
          filename: "database-runbook.md",
          description: "Runbook for database outage recovery after a hardware fault.",
        },
        filePath: runbookPath,
        dirPath: knowledgeDir,
      },
      {
        entry: {
          name: "database-faq",
          type: "knowledge",
          filename: "database-faq.md",
          description: "Database FAQ covering connection limits, recovery tunables, and outage post-mortems.",
        },
        filePath: faqPath,
        dirPath: knowledgeDir,
      },
      {
        entry: {
          name: "incident-2024-shard",
          type: "memory",
          filename: "incident-2024-shard.md",
          description: "We recovered shard-3 during the 2024 database outage by following the runbook.",
        },
        filePath: memoryPath,
        dirPath: memoryDir,
      },
      {
        entry: {
          name: "incident-checklist",
          type: "knowledge",
          filename: "incident-checklist.md",
          description: "Database outage recovery checklist for incident triage and escalation.",
        },
        filePath: checklistPath,
        dirPath: knowledgeDir,
      },
    ];
    for (const e of entries) {
      const searchText = buildSearchText(e.entry);
      // Seed the durable bundle-adapter identity (item_ref/concept_id/bundle_id)
      // that the related-ref reader resolves from. The primary-stash sentinel
      // bundle displays the SHORT conceptId.
      const provenance = deriveEntryProvenance(
        { bundleId: "local", componentId: "local", adapterId: "akm" },
        e.entry.type,
        e.entry.name,
      );
      upsertEntry(db, e.filePath, e.entry, searchText, provenance);
    }
    rebuildFts(db);
    setMeta(db, "stashDir", stashDir);
    setMeta(db, "builtAt", new Date().toISOString());
    setMeta(db, "stashDirs", JSON.stringify([stashDir]));
    setMeta(db, "hasEmbeddings", "0");
  } finally {
    closeDatabase(db);
  }

  uninstallGraph();
}

function uninstallGraph(): void {
  const db = openExistingDatabase(getDbPath());
  try {
    deleteStoredGraph(db, stashDir);
  } finally {
    closeDatabase(db);
  }
}

function installGraph(): void {
  const graph: GraphFile = {
    schemaVersion: GRAPH_FILE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    stashRoot: stashDir,
    files: [
      {
        path: path.join(stashDir, "knowledge", "database-runbook.md"),
        type: "knowledge",
        entities: ["database", "outage", "recovery", "runbook"],
        relations: [
          { from: "outage", to: "recovery" },
          { from: "recovery", to: "database" },
          { from: "recovery", to: "runbook" },
        ],
      },
      {
        path: path.join(stashDir, "memories", "incident-2024-shard.md"),
        type: "memory",
        entities: ["database", "outage", "recovery", "shard-3"],
        relations: [{ from: "outage", to: "recovery" }],
      },
      {
        path: path.join(stashDir, "knowledge", "incident-checklist.md"),
        type: "knowledge",
        entities: ["playbook"],
        relations: [{ from: "runbook", to: "playbook" }],
      },
    ],
  };
  const db = openExistingDatabase(getDbPath());
  try {
    replaceStoredGraph(db, graph);
  } finally {
    closeDatabase(db);
  }
}

async function searchHits(query: string) {
  const result = await akmSearch({ query, source: "local", limit: 100 });
  return result.hits;
}

function saveTestConfig(): void {
  saveConfig({
    semanticSearchMode: "off",
    bundles: { stash: { path: stashDir } },
    defaultBundle: "stash",
    registries: [],
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("search ranking ignores the graph", () => {
  test("the same query returns the same hits and scores with and without a stored graph", async () => {
    const query = "database outage recovery";
    uninstallGraph();
    const without = await searchHits(query);
    expect(without.length).toBeGreaterThan(0);

    installGraph();
    const withGraph = await searchHits(query);
    expect(withGraph.map((h) => [h.name, h.score])).toEqual(without.map((h) => [h.name, h.score]));
  });
});

// ── Gap 6: listRelatedPathsForFile SQL-backed correctness ───────────────────

describe("listRelatedPathsForFile (SQL-backed)", () => {
  test("orders neighbors by sharedEntities DESC and resolves canonical refs", () => {
    installGraph();
    const runbookPath = path.join(stashDir, "knowledge", "database-runbook.md");
    const db = openExistingDatabase(getDbPath());
    try {
      const related = listRelatedPathsForFile(stashDir, runbookPath, 10, db);
      expect(related.length).toBeGreaterThan(0);
      // Top neighbor must be the incident memory (3 shared entities).
      const top = related[0];
      expect(top?.path).toBe(path.join(stashDir, "memories", "incident-2024-shard.md"));
      expect(top?.type).toBe("memory");
      expect(top?.ref).toBe("memories/incident-2024-shard");
      // Shared entities are sorted alphabetically by the helper.
      expect(top?.sharedEntities).toEqual(["database", "outage", "recovery"]);
      // Each consecutive neighbor must have a sharedEntities count ≤ the
      // previous one (descending).
      for (let i = 1; i < related.length; i += 1) {
        const prev = related[i - 1]?.sharedEntities.length ?? 0;
        const curr = related[i]?.sharedEntities.length ?? 0;
        expect(curr).toBeLessThanOrEqual(prev);
      }
    } finally {
      closeDatabase(db);
    }
  });

  test("limit truncates the candidate list", () => {
    installGraph();
    const runbookPath = path.join(stashDir, "knowledge", "database-runbook.md");
    const db = openExistingDatabase(getDbPath());
    try {
      const unlimited = listRelatedPathsForFile(stashDir, runbookPath, 10, db);
      // The fixture only has one real neighbor for the runbook — pad with a
      // limit=1 call to assert truncation works deterministically even when
      // the candidate set fits.
      const limited = listRelatedPathsForFile(stashDir, runbookPath, 1, db);
      expect(limited.length).toBe(Math.min(1, unlimited.length));
      if (unlimited.length > 0) {
        expect(limited[0]?.path).toBe(unlimited[0]?.path);
      }
    } finally {
      closeDatabase(db);
    }
  });

  test("entry with no shared entities returns no neighbors (not an error)", () => {
    installGraph();
    // incident-checklist's only graph entity is "playbook"; nothing else in
    // the corpus references "playbook", so the JOIN yields zero candidate
    // rows. The function must return [] cleanly rather than throwing.
    const checklistPath = path.join(stashDir, "knowledge", "incident-checklist.md");
    const db = openExistingDatabase(getDbPath());
    try {
      const related = listRelatedPathsForFile(stashDir, checklistPath, 5, db);
      expect(related).toEqual([]);
    } finally {
      closeDatabase(db);
    }
  });

  // The annotation ref comes from canonical durable identity (`concept_id` /
  // the `item_ref` tail), not presentation metadata. The seeded neighbor's
  // document name deliberately diverges from its canonical concept id.
  test("related ref is canonical even when the document name diverges", () => {
    // Isolated on-DISK index under a unique dir (built with a UUID rather than a
    // raw temp-dir helper, which the isolation lint bans in a file that also sets
    // AKM env vars). The reader only queries the DB, so the referenced files need
    // not exist on disk; openIndexDatabase creates the parent dir for us.
    const dir = path.join(os.tmpdir(), `akm-graphref-${crypto.randomUUID()}`);
    const root = path.join(dir, "stash");
    const dbPath = path.join(dir, "index.db");
    const targetPath = path.join(root, "knowledge", "target.md");
    const neighborPath = path.join(root, "knowledge", "neighbor.md");
    const db = openIndexDatabase(dbPath);
    try {
      const kType = "knowledge";
      const target: IndexDocument = { name: "target", type: kType };
      upsertEntry(
        db,
        targetPath,
        target,
        buildSearchText(target),
        deriveEntryProvenance({ bundleId: "team-kb", componentId: "team-kb", adapterId: "akm" }, kType, "target"),
      );
      const presentationName = "presentation-neighbor";
      const neighbor: IndexDocument = { name: presentationName, type: kType };
      upsertEntry(
        db,
        neighborPath,
        neighbor,
        buildSearchText(neighbor),
        // Canonical durable identity diverges from the document name.
        {
          itemRef: "team-kb//knowledge/canonical-neighbor",
          bundleId: "team-kb",
          componentId: "team-kb",
          conceptId: "knowledge/canonical-neighbor",
          adapterId: "akm",
        },
      );
      replaceStoredGraph(db, {
        schemaVersion: GRAPH_FILE_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        stashRoot: root,
        files: [
          { path: targetPath, type: "knowledge", entities: ["shared-topic"], relations: [] },
          { path: neighborPath, type: "knowledge", entities: ["shared-topic"], relations: [] },
        ],
      });

      const related = listRelatedPathsForFile(root, targetPath, 5, db);
      expect(related.length).toBe(1);
      expect(related[0]?.path).toBe(neighborPath);
      // Canonical, item_ref-derived ref — not the presentation name.
      expect(related[0]?.ref).toBe("knowledge/canonical-neighbor");
      expect(related[0]?.ref).not.toBe("knowledge/presentation-neighbor");
    } finally {
      closeDatabase(db);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
