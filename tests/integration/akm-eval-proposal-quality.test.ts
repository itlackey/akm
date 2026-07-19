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

import { resolveSinceWindow, runProposalQualityCase } from "../../scripts/akm-eval/src/runners/proposal-quality";
import type { EvalCase, EvalContext } from "../../scripts/akm-eval/src/types";

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
    const now = Date.now();
    const oneHourAgo = new Date(now - 3_600_000).toISOString();
    const thirtyDaysAgo = new Date(now - 30 * 86_400_000).toISOString();
    buildStateDb({
      dbPath: f.dbPath,
      proposals: [
        {
          id: "recent-1",
          ref: "lessons/foo",
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
          ref: "lessons/foo",
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

describe("runProposalQualityCase — deterministic clock injection (ctx.runStartedAt)", () => {
  // Replay determinism guard: the same fixture + same `since` shorthand MUST
  // produce identical results across runs as long as `ctx.runStartedAt` is
  // pinned to the same instant. Conversely, advancing `runStartedAt` by an
  // hour MUST slide the window forward (events that were in-window at T0
  // drop out at T0+1h). Without the clock-injection fix on the runner side,
  // this property held only by accident (`new Date()` happens to differ
  // little between two calls inside the same second), and replay-vs-record
  // would diverge whenever the gap exceeded the test's resolution.

  const fixtures: Fixture[] = [];

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

  function ctxAt(f: Fixture, runStartedAt: Date): EvalContext {
    return { ...makeContext(f), runStartedAt };
  }

  test("identical runStartedAt → identical resolved since + identical result", async () => {
    const f = freshFixture();
    const anchor = new Date("2026-05-21T12:00:00.000Z");
    // Two events: one inside the 24h window (1h before anchor), one outside
    // (48h before anchor). Both runs should see the same single in-window
    // rejection.
    const oneHourBefore = new Date(anchor.getTime() - 3_600_000).toISOString();
    const fortyEightHoursBefore = new Date(anchor.getTime() - 48 * 3_600_000).toISOString();
    buildStateDb({
      dbPath: f.dbPath,
      proposals: [],
      events: [
        { type: "proposal_creation_rejected", ts: oneHourBefore },
        { type: "proposal_creation_rejected", ts: fortyEightHoursBefore },
      ],
    });

    const r1 = await runProposalQualityCase(makeCase({ since: "24h" }), ctxAt(f, anchor));
    const r2 = await runProposalQualityCase(makeCase({ since: "24h" }), ctxAt(f, anchor));

    // Same since-ISO surfaces in evidence, same counts, same score/passed.
    expect(r1.evidence.since).toBe("2026-05-20T12:00:00.000Z");
    expect(r2.evidence.since).toBe(r1.evidence.since);
    expect((r1.metrics.counts as { creationRejected: number }).creationRejected).toBe(1);
    expect((r2.metrics.counts as { creationRejected: number }).creationRejected).toBe(1);
    expect(r1.score).toBe(r2.score);
    expect(r1.passed).toBe(r2.passed);
  });

  test("different runStartedAt 1h apart → different since + (here) different in-window count", async () => {
    const f = freshFixture();
    // Plant a single rejection at a known instant. Anchor A sees it in
    // the 24h window; anchor B (25h later) does not. The resolved `since`
    // values must differ, and the in-window count must reflect that.
    const eventTs = "2026-05-20T13:00:00.000Z";
    buildStateDb({
      dbPath: f.dbPath,
      proposals: [],
      events: [{ type: "proposal_creation_rejected", ts: eventTs }],
    });

    const anchorA = new Date("2026-05-21T12:00:00.000Z"); // 23h after event → IN window
    const anchorB = new Date("2026-05-21T14:00:00.000Z"); // 25h after event → OUT of window

    const rA = await runProposalQualityCase(makeCase({ since: "24h" }), ctxAt(f, anchorA));
    const rB = await runProposalQualityCase(makeCase({ since: "24h" }), ctxAt(f, anchorB));

    expect(rA.evidence.since).toBe("2026-05-20T12:00:00.000Z");
    expect(rB.evidence.since).toBe("2026-05-20T14:00:00.000Z");
    expect(rA.evidence.since).not.toBe(rB.evidence.since);

    // A sees the event, B does not — proves the runner consults ctx.runStartedAt.
    expect((rA.metrics.counts as { creationRejected: number }).creationRejected).toBe(1);
    expect((rB.metrics.counts as { creationRejected: number }).creationRejected).toBe(0);

    // And the score/passed wiring tracks accordingly: A trips the floor
    // (0/(0+1)=0), B is the skip-when-no-traffic case.
    expect(rA.metrics.validationPassRate).toBe(0);
    expect(rA.passed).toBe(false);
    expect(rB.metrics.validationPassRate).toBeNull();
    expect(rB.passed).toBe(true);
    expect(rB.skipped).toBe(true);
  });
});
