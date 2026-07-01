/**
 * akm-eval workflow-compliance runner — proposal-queue-respect lifecycle checks.
 *
 * Covers the false-positive class where the old case compared the first global
 * `promoted` event with the first global queue event, mixing unrelated proposal
 * lifecycles and stashes.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { runWorkflowComplianceCase } from "../scripts/akm-eval/src/runners/workflow-compliance";
import type { EvalCase, EvalContext } from "../scripts/akm-eval/src/types";
import { makeSandboxDir, type SandboxedDir } from "./_helpers/sandbox";

interface Fixture {
  root: SandboxedDir;
  dataDir: string;
  stashRoot: string;
  otherStashRoot: string;
  dbPath: string;
}

function makeFixture(): Fixture {
  const root = makeSandboxDir("akm-eval-workflow-compliance");
  const dataDir = path.join(root.dir, "data");
  const stashRoot = path.join(root.dir, "stash");
  const otherStashRoot = path.join(root.dir, "other-stash");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(stashRoot, { recursive: true });
  fs.mkdirSync(otherStashRoot, { recursive: true });
  return { root, dataDir, stashRoot, otherStashRoot, dbPath: path.join(dataDir, "state.db") };
}

function buildStateDb(opts: {
  dbPath: string;
  proposals?: Array<{
    id: string;
    stashDir: string;
    ref: string;
    status: "pending" | "accepted" | "rejected" | "reverted";
    source: string;
    createdAt: string;
  }>;
  events?: Array<{ type: string; ts: string; ref?: string; metadata?: Record<string, unknown> }>;
}): void {
  const db = new Database(opts.dbPath);
  try {
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
        `INSERT INTO proposals
           (id, stash_dir, ref, status, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(p.id, p.stashDir, p.ref, p.status, p.source, p.createdAt, p.createdAt);
    }
    for (const e of opts.events ?? []) {
      db.prepare("INSERT INTO events (event_type, ts, ref, metadata_json) VALUES (?, ?, ?, ?)").run(
        e.type,
        e.ts,
        e.ref ?? null,
        JSON.stringify(e.metadata ?? {}),
      );
    }
  } finally {
    db.close();
  }
}

function makeContext(f: Fixture): EvalContext {
  return {
    stashRoot: f.stashRoot,
    dataDir: f.dataDir,
    akmBin: "akm",
    casesRoot: f.root.dir,
    outRoot: path.join(f.root.dir, "out"),
    keepSandbox: false,
    env: {},
  };
}

function makeCase(input: Record<string, unknown> = {}): EvalCase {
  return {
    schemaVersion: 1,
    id: "proposal-queue-respect",
    suite: "workflow-compliance",
    type: "workflow-compliance",
    description: "test",
    input,
    expected: { proposalQueueRespect: true },
    scoring: { deterministic: true, passThreshold: 1.0 },
  };
}

describe("runWorkflowComplianceCase — proposalQueueRespect", () => {
  const fixtures: Fixture[] = [];

  afterEach(() => {
    while (fixtures.length > 0) {
      fixtures.pop()?.root.cleanup();
    }
  });

  function freshFixture(): Fixture {
    const f = makeFixture();
    fixtures.push(f);
    return f;
  }

  test("ignores unrelated first promoted event from another stash", async () => {
    const f = freshFixture();
    buildStateDb({
      dbPath: f.dbPath,
      proposals: [
        {
          id: "other-proposal",
          stashDir: f.otherStashRoot,
          ref: "lesson:other",
          status: "accepted",
          source: "reflect",
          createdAt: "2026-06-01T00:00:00.000Z",
        },
        {
          id: "current-proposal",
          stashDir: f.stashRoot,
          ref: "lesson:current",
          status: "accepted",
          source: "reflect",
          createdAt: "2026-06-01T00:10:00.000Z",
        },
      ],
      events: [
        {
          type: "promoted",
          ts: "2026-06-01T00:01:00.000Z",
          ref: "lesson:other",
          metadata: { proposalId: "other-proposal" },
        },
        {
          type: "reflect_completed",
          ts: "2026-06-01T00:10:00.000Z",
          ref: "lesson:current",
          metadata: { proposalId: "current-proposal" },
        },
        {
          type: "promoted",
          ts: "2026-06-01T00:11:00.000Z",
          ref: "lesson:current",
          metadata: { proposalId: "current-proposal" },
        },
      ],
    });

    const result = await runWorkflowComplianceCase(makeCase(), makeContext(f));

    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
    const checks = result.evidence.checks as Array<{ name: string; ok: boolean; detail: Record<string, unknown> }>;
    const proposalCheck = checks.find((c) => c.name === "proposalQueueRespect");
    expect(proposalCheck?.ok).toBe(true);
    expect(proposalCheck?.detail.scopedPromotionCount).toBe(1);
    expect(proposalCheck?.detail.ignoredPromotionCount).toBe(1);
  });

  test("fails when an in-scope promotion precedes its proposal lifecycle", async () => {
    const f = freshFixture();
    buildStateDb({
      dbPath: f.dbPath,
      proposals: [
        {
          id: "current-proposal",
          stashDir: f.stashRoot,
          ref: "lesson:current",
          status: "accepted",
          source: "reflect",
          createdAt: "2026-06-01T00:10:00.000Z",
        },
      ],
      events: [
        {
          type: "promoted",
          ts: "2026-06-01T00:05:00.000Z",
          ref: "lesson:current",
          metadata: { proposalId: "current-proposal" },
        },
        {
          type: "reflect_completed",
          ts: "2026-06-01T00:10:00.000Z",
          ref: "lesson:current",
          metadata: { proposalId: "current-proposal" },
        },
      ],
    });

    const result = await runWorkflowComplianceCase(makeCase(), makeContext(f));

    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    const checks = result.evidence.checks as Array<{ name: string; ok: boolean; detail: { violations: unknown[] } }>;
    const proposalCheck = checks.find((c) => c.name === "proposalQueueRespect");
    expect(proposalCheck?.ok).toBe(false);
    expect(proposalCheck?.detail.violations).toHaveLength(1);
  });

  test("skips when events exist but no current-stash proposal lifecycle is in scope", async () => {
    const f = freshFixture();
    buildStateDb({
      dbPath: f.dbPath,
      proposals: [
        {
          id: "other-proposal",
          stashDir: f.otherStashRoot,
          ref: "lesson:other",
          status: "accepted",
          source: "reflect",
          createdAt: "2026-06-01T00:10:00.000Z",
        },
      ],
      events: [
        {
          type: "promoted",
          ts: "2026-06-01T00:11:00.000Z",
          ref: "lesson:other",
          metadata: { proposalId: "other-proposal" },
        },
      ],
    });

    const result = await runWorkflowComplianceCase(makeCase(), makeContext(f));

    expect(result.skipped).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.skipReason).toBe("no current-stash proposal lifecycle in window");
  });

  test("ignores current-stash promotions whose proposal lifecycle started before the window", async () => {
    const f = freshFixture();
    buildStateDb({
      dbPath: f.dbPath,
      proposals: [
        {
          id: "before-window",
          stashDir: f.stashRoot,
          ref: "lesson:old",
          status: "accepted",
          source: "reflect",
          createdAt: "2026-06-01T00:00:00.000Z",
        },
      ],
      events: [
        {
          type: "promoted",
          ts: "2026-06-01T00:20:00.000Z",
          ref: "lesson:old",
          metadata: { proposalId: "before-window" },
        },
      ],
    });

    const result = await runWorkflowComplianceCase(
      makeCase({ windowSince: "2026-06-01T00:10:00.000Z" }),
      makeContext(f),
    );

    expect(result.skipped).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.skipReason).toBe("no current-stash proposal lifecycle in window");
    const checks = result.evidence.checks as Array<{ name: string; detail: Record<string, unknown> }>;
    const proposalCheck = checks.find((c) => c.name === "proposalQueueRespect");
    expect(proposalCheck?.detail.ignoredPromotionCount).toBe(1);
  });
});
