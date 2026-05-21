/**
 * akm-eval proposal-quality runner — windowed validationPassRate regression.
 *
 * Covers the structural metric bug in `proposal-validation-floor`: without
 * a `since` window, the formula `total / (total + creationRejected)` reads
 * the LIVE proposals table (cleaned out post-decision) but the LIFETIME
 * `proposal_creation_rejected` events table, so a healthy validator that
 * had any rejection burst in the past reads as 0% forever.
 *
 * These tests prove the windowed fix: with `since: "24h"`, recent
 * rejections are in scope but old rejections drop out.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveSinceWindow, runProposalQualityCase } from "../scripts/akm-eval/src/runners/proposal-quality";
import type { EvalCase, EvalContext } from "../scripts/akm-eval/src/types";

// ── Fixture helpers ─────────────────────────────────────────────────────────

interface Fixture {
  tmpDir: string;
  dataDir: string;
  stashRoot: string;
  dbPath: string;
}

function makeFixture(): Fixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-eval-pq-"));
  const dataDir = path.join(tmpDir, "data");
  const stashRoot = path.join(tmpDir, "stash");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(stashRoot, { recursive: true });
  return { tmpDir, dataDir, stashRoot, dbPath: path.join(dataDir, "state.db") };
}

function buildStateDb(opts: {
  dbPath: string;
  proposals?: Array<{
    id: string;
    ref: string;
    status: "pending" | "accepted" | "rejected" | "reverted";
    source: string;
    createdAt: string;
  }>;
  events?: Array<{ type: string; ts: string }>;
}) {
  const db = new Database(opts.dbPath);
  db.exec(`
    CREATE TABLE events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type    TEXT NOT NULL,
      ts            TEXT NOT NULL,
      ref           TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE proposals (
      id               TEXT PRIMARY KEY,
      stash_dir        TEXT NOT NULL,
      ref              TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'pending',
      source           TEXT NOT NULL,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL,
      content          TEXT NOT NULL DEFAULT '',
      frontmatter_json TEXT,
      metadata_json    TEXT NOT NULL DEFAULT '{}'
    );
  `);
  for (const p of opts.proposals ?? []) {
    db.prepare(
      "INSERT INTO proposals (id, stash_dir, ref, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(p.id, "/fake/stash", p.ref, p.status, p.source, p.createdAt, p.createdAt);
  }
  for (const e of opts.events ?? []) {
    db.prepare("INSERT INTO events (event_type, ts) VALUES (?, ?)").run(e.type, e.ts);
  }
  db.close();
}

function makeContext(f: Fixture): EvalContext {
  return {
    stashRoot: f.stashRoot,
    dataDir: f.dataDir,
    akmBin: "akm",
    casesRoot: f.tmpDir,
    outRoot: path.join(f.tmpDir, "out"),
    keepSandbox: false,
    env: {},
  };
}

function makeCase(input: Record<string, unknown>): EvalCase {
  return {
    schemaVersion: 1,
    id: "test-proposal-validation-floor",
    suite: "test",
    type: "proposal-quality",
    description: "test",
    input,
    expected: { minValidationPassRate: 0.7 },
    scoring: { deterministic: true, passThreshold: 1.0 },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("resolveSinceWindow", () => {
  const now = new Date("2026-05-21T12:00:00.000Z");

  test("undefined and null disable windowing", () => {
    expect(resolveSinceWindow(undefined, now)).toBeUndefined();
    expect(resolveSinceWindow(null, now)).toBeUndefined();
    expect(resolveSinceWindow("", now)).toBeUndefined();
    expect(resolveSinceWindow(123, now)).toBeUndefined();
  });

  test("shorthand durations resolve relative to now", () => {
    expect(resolveSinceWindow("24h", now)).toBe("2026-05-20T12:00:00.000Z");
    expect(resolveSinceWindow("7d", now)).toBe("2026-05-14T12:00:00.000Z");
    expect(resolveSinceWindow("30m", now)).toBe("2026-05-21T11:30:00.000Z");
    expect(resolveSinceWindow("45s", now)).toBe("2026-05-21T11:59:15.000Z");
  });

  test("ISO timestamps pass through verbatim", () => {
    expect(resolveSinceWindow("2026-05-20T00:00:00Z", now)).toBe("2026-05-20T00:00:00Z");
  });

  test("shorthand is case-insensitive and tolerates whitespace", () => {
    expect(resolveSinceWindow("24H", now)).toBe("2026-05-20T12:00:00.000Z");
    expect(resolveSinceWindow("  24h  ", now)).toBe("2026-05-20T12:00:00.000Z");
  });
});

describe("runProposalQualityCase — windowed validationPassRate", () => {
  const fixtures: Fixture[] = [];

  beforeEach(() => {
    // fresh fixture per test; tracked for cleanup
  });

  afterEach(() => {
    while (fixtures.length > 0) {
      const f = fixtures.pop();
      if (f) fs.rmSync(f.tmpDir, { recursive: true, force: true });
    }
  });

  function freshFixture(): Fixture {
    const f = makeFixture();
    fixtures.push(f);
    return f;
  }

  test("WITHOUT a since window, old rejections + empty live queue = 0% (reproduces bug)", async () => {
    const f = freshFixture();
    // The bug scenario: queue is empty (proposals cleaned out post-decision)
    // but lifetime events table still has rejections from days ago.
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
    buildStateDb({
      dbPath: f.dbPath,
      proposals: [],
      events: Array.from({ length: 23 }, () => ({
        type: "proposal_creation_rejected",
        ts: thirtyDaysAgo,
      })),
    });

    const result = await runProposalQualityCase(makeCase({ since: null }), makeContext(f));

    // Bug: validationPassRate is 0/(0+23) = 0, gate fails.
    expect(result.metrics.validationPassRate).toBe(0);
    expect(result.passed).toBe(false);
    expect((result.metrics.counts as { creationRejected: number }).creationRejected).toBe(23);
  });

  test("WITH since: 24h, old rejections drop out and the gate skips cleanly", async () => {
    const f = freshFixture();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
    buildStateDb({
      dbPath: f.dbPath,
      proposals: [],
      events: Array.from({ length: 23 }, () => ({
        type: "proposal_creation_rejected",
        ts: thirtyDaysAgo,
      })),
    });

    const result = await runProposalQualityCase(makeCase({ since: "24h" }), makeContext(f));

    // Fixed: window excludes the old rejections, denominator is 0,
    // validationPassRate is null, the gate passes (skip-when-no-traffic).
    expect(result.metrics.validationPassRate).toBeNull();
    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(true);
    expect((result.metrics.counts as { creationRejected: number }).creationRejected).toBe(0);
  });

  test("WITH since: 24h, a recent successful proposal + zero recent rejections = 100%", async () => {
    const f = freshFixture();
    const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
    buildStateDb({
      dbPath: f.dbPath,
      proposals: [
        {
          id: "recent-1",
          ref: "lesson:foo",
          status: "pending",
          source: "improve",
          createdAt: oneHourAgo,
        },
      ],
      // Old rejection out of window — should NOT poison the floor.
      events: [{ type: "proposal_creation_rejected", ts: thirtyDaysAgo }],
    });

    const result = await runProposalQualityCase(makeCase({ since: "24h" }), makeContext(f));

    expect(result.metrics.validationPassRate).toBe(1);
    expect(result.passed).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect((result.metrics.counts as { total: number; creationRejected: number }).total).toBe(1);
    expect((result.metrics.counts as { creationRejected: number }).creationRejected).toBe(0);
  });

  test("WITH since: 24h, a recent burst of rejections still trips the gate", async () => {
    const f = freshFixture();
    const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    buildStateDb({
      dbPath: f.dbPath,
      proposals: [
        {
          id: "recent-1",
          ref: "lesson:foo",
          status: "pending",
          source: "improve",
          createdAt: oneHourAgo,
        },
      ],
      // Many recent rejections → real-time validator regression.
      events: Array.from({ length: 10 }, () => ({
        type: "proposal_creation_rejected",
        ts: oneHourAgo,
      })),
    });

    const result = await runProposalQualityCase(makeCase({ since: "24h" }), makeContext(f));

    // 1 / (1 + 10) ≈ 0.09 — well below 0.7 floor.
    expect(result.metrics.validationPassRate).toBeCloseTo(1 / 11, 5);
    expect(result.passed).toBe(false);
    expect(result.skipped).toBeUndefined();
  });
});
