// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { rollupAttributionRows } from "../../scripts/akm-eval/src/attribution-rollup";
import { makeSandboxDir } from "../_helpers/sandbox";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const WRAPPER = path.join(REPO_ROOT, "scripts", "akm-eval", "bin", "akm-eval-attribution-rollup");
const cleanups: Array<() => void> = [];

interface AttributionRow {
  id: number;
  eventType: string;
  entryRef: string | null;
  metadata: string | null;
  source: string | null;
  createdAt: string;
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function metadata(value: Record<string, unknown>): string {
  return JSON.stringify({ downstreamAttribution: { version: 1, control: false, ...value } });
}

function fixtureRows(): AttributionRow[] {
  return [
    {
      id: 1,
      eventType: "search",
      entryRef: "stash//memories/direct.derived",
      metadata: metadata({
        memoryInference: { exposure: "direct", childRef: "stash//memories/direct.derived" },
      }),
      source: "user",
      createdAt: "2026-07-22 10:00:00",
    },
    {
      id: 2,
      eventType: "show",
      entryRef: "stash//memories/direct.derived",
      metadata: metadata({
        memoryInference: { exposure: "direct", childRef: "stash//memories/direct.derived" },
      }),
      source: "user",
      createdAt: "2026-07-22 10:00:01",
    },
    {
      id: 3,
      eventType: "search",
      entryRef: "team//memories/parent",
      metadata: metadata({
        memoryInference: { exposure: "surface", childRef: "team//memories/parent.derived" },
      }),
      source: "user",
      createdAt: "2026-07-22 10:01:00",
    },
    {
      id: 4,
      eventType: "curate",
      entryRef: "team//memories/parent",
      metadata: metadata({
        memoryInference: { exposure: "surface", childRef: "team//memories/parent.derived" },
      }),
      source: "user",
      createdAt: "2026-07-22 10:01:01",
    },
    {
      id: 5,
      eventType: "search",
      entryRef: "stash//knowledge/graph",
      metadata: metadata({ graphExtraction: { boost: 0.25, bodyHash: "hash-1", extractionRunId: "run-1" } }),
      source: "user",
      createdAt: "2026-07-22 10:02:00",
    },
    {
      id: 6,
      eventType: "show",
      entryRef: "stash//knowledge/graph",
      metadata: null,
      source: "user",
      createdAt: "2026-07-22 10:02:01",
    },
    {
      id: 7,
      eventType: "curate",
      entryRef: "stash//knowledge/graph",
      metadata: metadata({ graphExtraction: { boost: 0.25, bodyHash: "hash-1", extractionRunId: "run-1" } }),
      source: "user",
      createdAt: "2026-07-22 10:03:00",
    },
    {
      id: 8,
      eventType: "show",
      entryRef: "stash//knowledge/graph",
      metadata: null,
      source: "user",
      createdAt: "2026-07-22 10:03:01",
    },
    {
      id: 9,
      eventType: "search",
      entryRef: "stash//knowledge/old",
      metadata: JSON.stringify({ mode: "keyword", body: "DO-NOT-LEAK", provenance: "DO-NOT-LEAK" }),
      source: "user",
      createdAt: "2026-07-22 10:04:00",
    },
    {
      id: 10,
      eventType: "search",
      entryRef: "stash//knowledge/audit",
      metadata: metadata({ graphExtraction: { boost: 0.5 } }),
      source: "audit",
      createdAt: "2026-07-22 10:05:00",
    },
    {
      id: 11,
      eventType: "show",
      entryRef: "knowledge/bare-old-ref",
      metadata: null,
      source: "user",
      createdAt: "2026-07-22 10:06:00",
    },
    {
      id: 12,
      eventType: "show",
      entryRef: "team//knowledge/malformed-old",
      metadata: "not-json",
      source: "user",
      createdAt: "2026-07-22 10:07:00",
    },
    {
      id: 13,
      eventType: "search",
      entryRef: "stash//knowledge/current-control",
      metadata: JSON.stringify({ downstreamAttribution: { version: 1, control: true } }),
      source: "user",
      createdAt: "2026-07-22 10:08:00",
    },
  ];
}

function makeStateDb(): { root: string; stateDb: string; cleanup: () => void } {
  const sandbox = makeSandboxDir("akm-attribution-rollup");
  cleanups.push(sandbox.cleanup);
  const stateDb = path.join(sandbox.dir, "state.db");
  const db = new Database(stateDb);
  db.exec(`
    CREATE TABLE usage_events (
      id INTEGER PRIMARY KEY,
      event_type TEXT NOT NULL,
      query TEXT,
      entry_id INTEGER,
      entry_ref TEXT,
      signal TEXT,
      metadata TEXT,
      source TEXT,
      created_at TEXT NOT NULL
    )
  `);
  const insert = db.prepare(
    "INSERT INTO usage_events (id, event_type, entry_ref, metadata, source, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const row of fixtureRows()) {
    insert.run(row.id, row.eventType, row.entryRef, row.metadata, row.source, row.createdAt);
  }
  db.close();
  return { root: sandbox.dir, stateDb, cleanup: sandbox.cleanup };
}

function sha256(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function directoryState(dir: string): Array<{
  name: string;
  mode: number;
  size: number;
  mtimeMs: number;
  hash?: string;
}> {
  return fs
    .readdirSync(dir)
    .sort()
    .map((name) => {
      const filePath = path.join(dir, name);
      const stat = fs.lstatSync(filePath);
      return {
        name,
        mode: stat.mode,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ...(stat.isFile() ? { hash: sha256(filePath) } : {}),
      };
    });
}

describe("akm-eval attribution rollup", () => {
  test("separates MI direct/surface, graph exposure/read-back, old rows, and source-qualified refs", () => {
    const report = rollupAttributionRows(fixtureRows());

    expect(report.memoryInference).toMatchObject({
      exposure: { direct: 1, surface: 1 },
      consumption: {
        show: { direct: 1, surface: 0 },
        curate: { direct: 0, surface: 1 },
      },
    });
    expect(report.graphExtraction).toMatchObject({ exposures: 1, selected: 1, shownReadBack: 2 });
    expect(report.currentControl).toEqual({ search: 1, show: 0, curate: 0, total: 1 });
    expect(report.historicalUnattributed).toEqual({ search: 1, show: 1, curate: 0, total: 2 });
    expect(report.excludedUnqualifiedRows).toBe(1);
    expect(report.refs.map((entry) => entry.ref).sort()).toEqual([
      "stash//knowledge/graph",
      "stash//memories/direct.derived",
      "team//memories/parent",
    ]);
    expect(report.refs.find((entry) => entry.ref === "team//memories/parent")?.memoryInference.childRefs).toEqual([
      "team//memories/parent.derived",
    ]);
    expect(JSON.stringify(report)).not.toContain("DO-NOT-LEAK");
    expect(JSON.stringify(report)).not.toContain("audit");
  });

  test("is read-only, refuses input/output collisions, and never clobbers an output", () => {
    const fixture = makeStateDb();
    const beforeHash = sha256(fixture.stateDb);
    const beforeMtime = fs.statSync(fixture.stateDb).mtimeMs;

    const readOnly = Bun.spawnSync([WRAPPER, "--state-db", fixture.stateDb, "--format", "json"], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(readOnly.exitCode).toBe(0);
    expect(JSON.parse(readOnly.stdout.toString()).mode).toBe("read-only");
    expect(sha256(fixture.stateDb)).toBe(beforeHash);
    expect(fs.statSync(fixture.stateDb).mtimeMs).toBe(beforeMtime);

    const collision = Bun.spawnSync(
      [WRAPPER, "--state-db", fixture.stateDb, "--format", "json", "--out", fixture.stateDb],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    expect(collision.exitCode).not.toBe(0);
    expect(collision.stderr.toString()).toContain("collides with the input database");
    expect(sha256(fixture.stateDb)).toBe(beforeHash);

    const out = path.join(fixture.root, "report.json");
    fs.writeFileSync(out, "keep-me");
    const noClobber = Bun.spawnSync([WRAPPER, "--state-db", fixture.stateDb, "--format", "json", "--out", out], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(noClobber.exitCode).not.toBe(0);
    expect(noClobber.stderr.toString()).toContain("already exists");
    expect(fs.readFileSync(out, "utf8")).toBe("keep-me");
    expect(sha256(fixture.stateDb)).toBe(beforeHash);
  });

  test("reads committed WAL data without creating source sidecars or changing the source directory", () => {
    const sandbox = makeSandboxDir("akm-attribution-rollup-wal");
    cleanups.push(sandbox.cleanup);
    const sourceDir = path.join(sandbox.dir, "source");
    fs.mkdirSync(sourceDir);
    const stateDb = path.join(sourceDir, "state.db");
    const writerDbPath = path.join(sandbox.dir, "writer.db");
    const db = new Database(writerDbPath);
    try {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA wal_autocheckpoint = 0");
      db.exec(`
        CREATE TABLE usage_events (
          id INTEGER PRIMARY KEY,
          event_type TEXT NOT NULL,
          entry_ref TEXT,
          metadata TEXT,
          source TEXT,
          created_at TEXT NOT NULL
        )
      `);
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.prepare(
        "INSERT INTO usage_events (event_type, entry_ref, metadata, source, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(
        "search",
        "stash//memories/wal-parent",
        metadata({
          memoryInference: { exposure: "surface", childRef: "stash//memories/wal-parent.derived" },
        }),
        "user",
        "2026-07-22 11:00:00",
      );

      fs.copyFileSync(writerDbPath, stateDb);
      fs.copyFileSync(`${writerDbPath}-wal`, `${stateDb}-wal`);
      expect(fs.existsSync(`${stateDb}-shm`)).toBe(false);
      const before = directoryState(sourceDir);

      const result = Bun.spawnSync([WRAPPER, "--state-db", stateDb, "--format", "json"], {
        cwd: REPO_ROOT,
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.toString()).memoryInference.exposure).toEqual({ direct: 0, surface: 1 });
      expect(directoryState(sourceDir)).toEqual(before);
      expect(fs.existsSync(`${stateDb}-shm`)).toBe(false);
    } finally {
      db.close();
    }
  });
});
