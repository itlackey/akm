/**
 * Tests for the `improve_runs` table (state.db migration 003).
 *
 * Validates:
 *   1. Migration 003 creates the table + indexes on a fresh DB.
 *   2. `recordImproveRun` persists every column for a production run.
 *   3. `recordImproveRun` persists `dry_run=1` for dry-run input — the
 *      specific bug from MEMORY.md feedback_akm_dryrun_artifact_trap.
 *   4. `purgeOldImproveRuns` deletes only rows older than retentionDays.
 *   5. Re-opening a DB that already has migration 003 is a no-op.
 *
 * These tests must NOT touch the user's real state.db. Each test mints a
 * temporary XDG_DATA_HOME so `openStateDatabase()` writes into a tmpdir.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AkmImproveResult } from "../../src/commands/improve/improve";
import { openStateDatabase } from "../../src/core/state-db";
import {
  computeImproveRunMetrics,
  purgeOldImproveRuns,
  recordImproveRun,
} from "../../src/storage/repositories/improve-runs-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

function buildMinimalResult(overrides: Partial<AkmImproveResult> = {}): AkmImproveResult {
  return {
    schemaVersion: 2,
    ok: true,
    strategy: "default",
    scope: { mode: "all" },
    dryRun: false,
    memorySummary: { eligible: 0, derived: 0 },
    plannedRefs: [],
    actions: [],
    ...overrides,
  };
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

describe("migration 003 — improve_runs", () => {
  test("creates the table and indexes on a fresh database", () => {
    const db = openStateDatabase();
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'improve_runs'")
        .all() as Array<{ name: string }>;
      expect(tables).toEqual([{ name: "improve_runs" }]);

      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'improve_runs' ORDER BY name")
        .all() as Array<{ name: string }>;
      const indexNames = indexes.map((r) => r.name).filter((n) => !n.startsWith("sqlite_"));
      expect(indexNames).toEqual(
        expect.arrayContaining([
          "idx_improve_runs_dry_run",
          "idx_improve_runs_started",
          "idx_improve_runs_stash_scope",
        ]),
      );

      const cols = db.prepare("PRAGMA table_info(improve_runs)").all() as Array<{ name: string; type: string }>;
      const colNames = new Set(cols.map((c) => c.name));
      for (const required of [
        "id",
        "started_at",
        "completed_at",
        "stash_dir",
        "dry_run",
        "profile",
        "strategy",
        "scope_mode",
        "scope_value",
        "guidance",
        "ok",
        "result_json",
        "metrics_json",
        "metadata_json",
      ]) {
        expect(colNames.has(required)).toBe(true);
      }

      expect(indexNames).toContain("idx_improve_runs_strategy_started");

      // schema_migrations records the migration id so subsequent opens skip it.
      const applied = db.prepare("SELECT id FROM schema_migrations WHERE id = '003-improve-runs'").all() as Array<{
        id: string;
      }>;
      expect(applied).toEqual([{ id: "003-improve-runs" }]);
    } finally {
      db.close();
    }
  });

  test("re-opening a DB that already has migration 003 is a no-op", () => {
    // First open applies the migration.
    const db1 = openStateDatabase();
    db1.close();

    // Second open should observe the migration as applied and skip it
    // without raising "table improve_runs already exists".
    const db2 = openStateDatabase();
    try {
      const applied = db2
        .prepare("SELECT COUNT(*) AS c FROM schema_migrations WHERE id = '003-improve-runs'")
        .get() as { c: number };
      expect(applied.c).toBe(1);
    } finally {
      db2.close();
    }
  });
});

describe("recordImproveRun", () => {
  test("writes a production run with every column correct", () => {
    const db = openStateDatabase();
    try {
      const result = buildMinimalResult({
        scope: { mode: "type", value: "lesson" },
        dryRun: false,
        guidance: "focus on tier 1 cleanup",
      });
      recordImproveRun(db, {
        id: "run-001",
        startedAt: "2026-05-23T12:00:00.000Z",
        completedAt: "2026-05-23T12:01:00.000Z",
        stashDir: "/tmp/test-stash",
        dryRun: false,
        legacyProfile: "default",
        scopeMode: "type",
        scopeValue: "lesson",
        guidance: "focus on tier 1 cleanup",
        ok: true,
        result,
      });

      const row = db
        .prepare(
          `SELECT id, started_at, completed_at, stash_dir, dry_run, profile,
                  scope_mode, scope_value, guidance, ok, result_json,
                  metrics_json, metadata_json
           FROM improve_runs WHERE id = 'run-001'`,
        )
        .get() as Record<string, unknown>;

      expect(row.id).toBe("run-001");
      expect(row.started_at).toBe("2026-05-23T12:00:00.000Z");
      expect(row.completed_at).toBe("2026-05-23T12:01:00.000Z");
      expect(row.stash_dir).toBe("/tmp/test-stash");
      expect(row.dry_run).toBe(0);
      expect(row.profile).toBe("default");
      expect(row.scope_mode).toBe("type");
      expect(row.scope_value).toBe("lesson");
      expect(row.guidance).toBe("focus on tier 1 cleanup");
      expect(row.ok).toBe(1);
      expect(row.metadata_json).toBe("{}");

      // result_json round-trip preserves the input.
      const parsedResult = JSON.parse(row.result_json as string) as AkmImproveResult;
      expect(parsedResult.scope).toEqual({ mode: "type", value: "lesson" });
      expect(parsedResult.dryRun).toBe(false);

      // metrics_json carries the aggregate counts derived from result.
      const parsedMetrics = JSON.parse(row.metrics_json as string) as Record<string, number>;
      expect(parsedMetrics.plannedCount).toBe(0);
      expect(parsedMetrics.actionsCount).toBe(0);
      expect(parsedMetrics.acceptedCount).toBe(0);
      expect(parsedMetrics.rejectedCount).toBe(0);
      expect(parsedMetrics.autoAcceptedCount).toBe(0);
      expect(parsedMetrics.errorCount).toBe(0);
    } finally {
      db.close();
    }
  });

  test("writes the selected 0.9 strategy without relabeling legacy profile rows", () => {
    const db = openStateDatabase();
    try {
      const result = buildMinimalResult();
      recordImproveRun(db, {
        id: "run-strategy",
        startedAt: "2026-07-11T12:00:00.000Z",
        completedAt: "2026-07-11T12:01:00.000Z",
        stashDir: "/tmp/test-stash",
        dryRun: false,
        strategy: "quick",
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: true,
        result,
      });
      const row = db.prepare("SELECT profile, strategy FROM improve_runs WHERE id = 'run-strategy'").get() as {
        profile: string | null;
        strategy: string | null;
      };
      expect(row).toEqual({ profile: null, strategy: "quick" });
    } finally {
      db.close();
    }
  });

  test("writes a dry-run row with dry_run=1 (closes the dry-run artifact-trap)", () => {
    const db = openStateDatabase();
    try {
      const result = buildMinimalResult({ dryRun: true });
      recordImproveRun(db, {
        id: "run-dry",
        startedAt: "2026-05-23T12:00:00.000Z",
        completedAt: "2026-05-23T12:00:00.000Z",
        stashDir: "/tmp/test-stash",
        dryRun: true,
        strategy: "default",
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: true,
        result,
      });

      // Productivity-audit-style filter: real runs only.
      const realRuns = db.prepare("SELECT id FROM improve_runs WHERE dry_run = 0").all() as Array<{ id: string }>;
      expect(realRuns).toEqual([]);

      const dryRuns = db.prepare("SELECT id, dry_run FROM improve_runs WHERE dry_run = 1").all() as Array<{
        id: string;
        dry_run: number;
      }>;
      expect(dryRuns).toEqual([{ id: "run-dry", dry_run: 1 }]);
    } finally {
      db.close();
    }
  });

  test("derives metrics from actions with mixed modes", () => {
    const db = openStateDatabase();
    try {
      const result = buildMinimalResult({
        plannedRefs: [
          { ref: "lesson:a", reason: "scope-type" },
          { ref: "lesson:b", reason: "scope-type" },
          { ref: "lesson:c", reason: "scope-type" },
        ],
        actions: [
          { ref: "lesson:a", mode: "reflect", result: { ok: true, autoAccepted: true } as never },
          { ref: "lesson:b", mode: "distill", result: { ok: true } as never },
          { ref: "lesson:c", mode: "reflect-cooldown", result: { ok: true, reason: "cooldown" } },
          { ref: "lesson:d", mode: "error", result: { ok: false, error: "boom" } },
        ],
      });
      recordImproveRun(db, {
        id: "run-mixed",
        startedAt: "2026-05-23T12:00:00.000Z",
        completedAt: "2026-05-23T12:00:00.000Z",
        stashDir: "/tmp/test-stash",
        dryRun: false,
        legacyProfile: null,
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: true,
        result,
      });

      const row = db.prepare("SELECT metrics_json FROM improve_runs WHERE id = 'run-mixed'").get() as {
        metrics_json: string;
      };
      const metrics = JSON.parse(row.metrics_json) as Record<string, number>;
      expect(metrics.plannedCount).toBe(3);
      expect(metrics.actionsCount).toBe(4);
      expect(metrics.acceptedCount).toBe(2);
      // reflect-cooldown is a gated skip, not a rejection (deep-tuning #1).
      expect(metrics.rejectedCount).toBe(0);
      expect(metrics.skippedCount).toBe(1);
      expect(metrics.autoAcceptedCount).toBe(1);
      expect(metrics.errorCount).toBe(1);
    } finally {
      db.close();
    }
  });

  test("buckets reflect-guard-rejected as rejected (round-2 health fix)", () => {
    // Behaviour change (code-health round-2, audit items C1/H3): before the
    // shared classifyImproveAction was introduced, computeImproveRunMetrics'
    // switch had no case for `reflect-guard-rejected` and no default arm, so a
    // guard rejection was silently counted in NONE of accepted/rejected/error —
    // a data-integrity miscount. Owner-approved decision: bucket it as
    // "rejected" (a deliberate non-application of the action). This asserts the
    // corrected total: the guard rejection now contributes to rejectedCount.
    const metrics = computeImproveRunMetrics(
      buildMinimalResult({
        plannedRefs: [{ ref: "lesson:a", reason: "scope-type" }],
        actions: [
          { ref: "lesson:a", mode: "reflect", result: { ok: true } as never },
          {
            ref: "lesson:b",
            mode: "reflect-guard-rejected",
            result: { ok: true, reason: "EXCESSIVE_SHRINKAGE" },
          },
        ],
      }),
    );
    expect(metrics.acceptedCount).toBe(1);
    // Was 0 before the fix (the variant vanished); now 1.
    expect(metrics.rejectedCount).toBe(1);
    expect(metrics.errorCount).toBe(0);
  });

  test("computeImproveRunMetrics is a pure helper consistent with recorded metrics", () => {
    const result = buildMinimalResult({
      plannedRefs: [{ ref: "lesson:a", reason: "scope-type" }],
      actions: [{ ref: "lesson:a", mode: "reflect", result: { ok: true } as never }],
    });
    const metrics = computeImproveRunMetrics(result);
    expect(metrics).toEqual({
      plannedCount: 1,
      actionsCount: 1,
      acceptedCount: 1,
      rejectedCount: 0,
      skippedCount: 0,
      autoAcceptedCount: 0,
      errorCount: 0,
    });
  });

  // C1 (13-bus-factor): the per-ref distill-skipped rows no longer live in
  // `result.actions`; they are folded into the `distillSkipped` aggregate. The
  // metric total must still be counted from the aggregate, NOT from per-ref rows.
  test("counts distillSkipped aggregate into skippedCount and actionsCount", () => {
    const result = buildMinimalResult({
      plannedRefs: [{ ref: "lesson:a", reason: "scope-type" }],
      actions: [{ ref: "lesson:a", mode: "reflect", result: { ok: true } as never }],
      distillSkipped: {
        total: 13000,
        byReason: { "no new signal since last proposal": 12000, "pending proposal exists": 1000 },
        samples: [{ ref: "memory:a", reason: "no new signal since last proposal" }],
      },
    });
    const metrics = computeImproveRunMetrics(result);
    // 1 reflect + 13000 folded skips.
    expect(metrics.actionsCount).toBe(13001);
    expect(metrics.acceptedCount).toBe(1);
    expect(metrics.skippedCount).toBe(13000);
    expect(metrics.rejectedCount).toBe(0);
    expect(metrics.errorCount).toBe(0);
  });

  // The aggregate that gets persisted is bounded — the sample list is small even
  // for a 13k-skip run, so result_json can no longer grow with the ref pool.
  test("persists the bounded distillSkipped aggregate (no unbounded per-ref rows)", () => {
    const db = openStateDatabase();
    try {
      const result = buildMinimalResult({
        actions: [],
        distillSkipped: {
          total: 13000,
          byReason: { "no new signal since last proposal": 13000 },
          samples: [
            { ref: "memory:a", reason: "no new signal since last proposal" },
            { ref: "memory:b", reason: "no new signal since last proposal" },
            { ref: "memory:c", reason: "no new signal since last proposal" },
          ],
        },
      });
      recordImproveRun(db, {
        id: "run-aggregate",
        startedAt: "2026-07-05T12:00:00.000Z",
        completedAt: "2026-07-05T12:00:00.000Z",
        stashDir: "/tmp/test-stash",
        dryRun: false,
        legacyProfile: null,
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: true,
        result,
      });
      const row = db.prepare("SELECT result_json, metrics_json FROM improve_runs WHERE id = 'run-aggregate'").get() as {
        result_json: string;
        metrics_json: string;
      };
      const persisted = JSON.parse(row.result_json) as AkmImproveResult;
      // No per-ref distill-skipped rows survive in the persisted actions array.
      expect((persisted.actions ?? []).some((a) => a.mode === "distill-skipped")).toBe(false);
      // The aggregate IS persisted, and its sample list is bounded (3, not 13000).
      expect(persisted.distillSkipped?.total).toBe(13000);
      expect(persisted.distillSkipped?.samples.length).toBe(3);
      const metrics = JSON.parse(row.metrics_json) as Record<string, number>;
      expect(metrics.skippedCount).toBe(13000);
    } finally {
      db.close();
    }
  });
});

describe("purgeOldImproveRuns", () => {
  test("deletes rows older than retentionDays and preserves recent ones", () => {
    const db = openStateDatabase();
    try {
      const now = Date.now();
      const day = 86_400_000;
      const oldStarted = new Date(now - 120 * day).toISOString();
      const recentStarted = new Date(now - 3 * day).toISOString();

      recordImproveRun(db, {
        id: "run-old",
        startedAt: oldStarted,
        completedAt: oldStarted,
        stashDir: "/tmp/test-stash",
        dryRun: false,
        legacyProfile: null,
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: true,
        result: buildMinimalResult(),
      });
      recordImproveRun(db, {
        id: "run-recent",
        startedAt: recentStarted,
        completedAt: recentStarted,
        stashDir: "/tmp/test-stash",
        dryRun: false,
        legacyProfile: null,
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: true,
        result: buildMinimalResult(),
      });

      const before = db.prepare("SELECT COUNT(*) AS c FROM improve_runs").get() as { c: number };
      expect(before.c).toBe(2);

      const purged = purgeOldImproveRuns(db, 90);
      expect(purged).toBe(1);

      const survivors = db.prepare("SELECT id FROM improve_runs").all() as Array<{ id: string }>;
      expect(survivors).toEqual([{ id: "run-recent" }]);
    } finally {
      db.close();
    }
  });

  test("returns 0 and is a no-op when retentionDays is 0 (disabled)", () => {
    const db = openStateDatabase();
    try {
      const oldStarted = new Date(Date.now() - 365 * 86_400_000).toISOString();
      recordImproveRun(db, {
        id: "run-old",
        startedAt: oldStarted,
        completedAt: oldStarted,
        stashDir: "/tmp/test-stash",
        dryRun: false,
        legacyProfile: null,
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: true,
        result: buildMinimalResult(),
      });

      expect(purgeOldImproveRuns(db, 0)).toBe(0);
      expect(purgeOldImproveRuns(db, Number.NaN)).toBe(0);

      const after = db.prepare("SELECT COUNT(*) AS c FROM improve_runs").get() as { c: number };
      expect(after.c).toBe(1);
    } finally {
      db.close();
    }
  });

  test("returns 0 when there are no rows older than the window", () => {
    const db = openStateDatabase();
    try {
      const recentStarted = new Date(Date.now() - 1 * 86_400_000).toISOString();
      recordImproveRun(db, {
        id: "run-recent",
        startedAt: recentStarted,
        completedAt: recentStarted,
        stashDir: "/tmp/test-stash",
        dryRun: false,
        legacyProfile: null,
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: true,
        result: buildMinimalResult(),
      });

      expect(purgeOldImproveRuns(db, 90)).toBe(0);
    } finally {
      db.close();
    }
  });
});

// Regression guard: 2026-05-26. Pre-fix, runs SIGTERM'd by the cron timeout
// (or that threw mid-loop) left NO improve_runs row because the writer fired
// only at successful end-of-run. recordTerminatedImproveRun now persists an
// ok:false row with the reason captured in metadata.terminated so
// `akm health` can see what happened without inferring from task_history.
describe("recordTerminatedImproveRun", () => {
  test("writes an ok:false row with metadata.terminated.reason for SIGTERM", async () => {
    const { recordTerminatedImproveRun } = await import("../../src/commands/improve/improve-result-file");
    const db = openStateDatabase();
    try {
      const runId = "2026-05-26T05-07-01-587Z-deadbeef";
      const startedAt = "2026-05-26T05:07:01.587Z";
      recordTerminatedImproveRun("/tmp/test-stash", runId, startedAt, "SIGTERM", {
        scopeMode: "all",
        dryRun: false,
        strategy: "default",
      });

      const row = db
        .prepare("SELECT id, ok, dry_run, scope_mode, result_json, metadata_json FROM improve_runs WHERE id = ?")
        .get(runId) as {
        id: string;
        ok: number;
        dry_run: number;
        scope_mode: string;
        result_json: string;
        metadata_json: string;
      };
      expect(row).toBeDefined();
      expect(row.ok).toBe(0);
      expect(row.dry_run).toBe(0);
      expect(row.scope_mode).toBe("all");

      const metadata = JSON.parse(row.metadata_json) as { terminated?: { reason?: string } };
      expect(metadata.terminated?.reason).toBe("SIGTERM");

      const result = JSON.parse(row.result_json) as {
        ok: boolean;
        terminated?: { reason?: string; errorMessage?: string };
      };
      expect(result.ok).toBe(false);
      expect(result.terminated?.reason).toBe("SIGTERM");
    } finally {
      db.close();
    }
  });

  test("captures errorMessage for exception terminations and preserves scope_value", async () => {
    const { recordTerminatedImproveRun } = await import("../../src/commands/improve/improve-result-file");
    const db = openStateDatabase();
    try {
      const runId = "2026-05-26T05-08-00-000Z-cafebabe";
      const startedAt = "2026-05-26T05:08:00.000Z";
      recordTerminatedImproveRun("/tmp/test-stash", runId, startedAt, "exception", {
        scopeMode: "type",
        scopeValue: "memory",
        dryRun: false,
        strategy: "default",
        errorMessage: "LLM provider returned 503",
      });

      const row = db.prepare("SELECT result_json, scope_value FROM improve_runs WHERE id = ?").get(runId) as {
        result_json: string;
        scope_value: string;
      };
      const result = JSON.parse(row.result_json) as {
        terminated?: { reason?: string; errorMessage?: string };
      };
      expect(result.terminated?.reason).toBe("exception");
      expect(result.terminated?.errorMessage).toBe("LLM provider returned 503");
      expect(row.scope_value).toBe("memory");
    } finally {
      db.close();
    }
  });
});
