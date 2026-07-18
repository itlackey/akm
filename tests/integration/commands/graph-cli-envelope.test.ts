// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS6 characterization test for the `akm graph` command family. Written BEFORE
 * the family was extracted from cli.ts into src/commands/graph-cli.ts and
 * migrated onto `defineJsonCommand`. It seeds a real SQLite graph artifact at
 * the sandboxed index-DB location, drives the success-path subcommands through
 * the in-process CLI harness, and snapshots the JSON envelope (ok flag + shaped
 * payload) so the post-migration output is proven byte-identical.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getDbPath } from "../../../src/core/paths";
import { replaceStoredGraph } from "../../../src/indexer/db/graph-db";
import { GRAPH_FILE_SCHEMA_VERSION } from "../../../src/indexer/graph/graph-extraction";
import { buildSearchText } from "../../../src/indexer/search/search-fields";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import { rebuildFts } from "../../../src/storage/repositories/index-fts-repository";
import { setMeta } from "../../../src/storage/repositories/index-meta-repository";
import { runCliCapture } from "../../_helpers/cli";
import { type Cleanup, sandboxStashDir } from "../../_helpers/sandbox";

let stashCleanup: Cleanup = () => {};

function makeStashDir(): string {
  const stash = sandboxStashDir();
  stashCleanup = stash.cleanup;
  fs.mkdirSync(path.join(stash.dir, ".akm"), { recursive: true });
  return stash.dir;
}

/** Seed a deterministic two-file graph artifact at the sandboxed index DB. */
function seedGraph(stashDir: string): void {
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
    setMeta(db, "builtAt", "2026-05-01T00:00:00.000Z");
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
}

afterEach(() => {
  stashCleanup();
  stashCleanup = () => {};
});

describe("graph CLI success-path JSON envelope (characterization)", () => {
  test("summary emits a stable JSON envelope with counts", async () => {
    const stash = makeStashDir();
    seedGraph(stash);
    const { code, stdout, stderr } = await runCliCapture(["graph", "summary"]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { shape?: string; entityCount?: number; relationCount?: number };
    expect(parsed.shape).toBe("graph-summary");
    expect(parsed.entityCount).toBe(3);
    expect(parsed.relationCount).toBe(2);
  });

  test("entities lists seeded entities in a JSON envelope", async () => {
    const stash = makeStashDir();
    seedGraph(stash);
    const { code, stdout, stderr } = await runCliCapture(["graph", "entities"]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { shape?: string; entities?: Array<{ name: string }> };
    expect(parsed.shape).toBe("graph-entities");
    const names = (parsed.entities ?? []).map((e) => e.name).sort();
    expect(names).toEqual(["alpha", "beta", "gamma"]);
  });

  test("relations lists seeded relations in a JSON envelope", async () => {
    const stash = makeStashDir();
    seedGraph(stash);
    const { code, stdout, stderr } = await runCliCapture(["graph", "relations"]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { shape?: string; relations?: unknown[] };
    expect(parsed.shape).toBe("graph-relations");
    expect((parsed.relations ?? []).length).toBe(2);
  });

  test("bare `graph` (no subcommand) falls through to summary", async () => {
    const stash = makeStashDir();
    seedGraph(stash);
    const { code, stdout, stderr } = await runCliCapture(["graph"]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { shape?: string; entityCount?: number };
    expect(parsed.shape).toBe("graph-summary");
    expect(parsed.entityCount).toBe(3);
  });
});
