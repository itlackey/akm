import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmHealth } from "../src/commands/health";
import type { AkmImproveResult } from "../src/commands/improve";
import { openStateDatabase, recordImproveRun, upsertTaskHistory } from "../src/core/state-db";

function fixtureResult(partial: Record<string, unknown>): AkmImproveResult {
  return partial as unknown as AkmImproveResult;
}

const savedEnv = {
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
};

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  process.env.XDG_CACHE_HOME = makeTempDir("akm-health-cache-");
  process.env.XDG_CONFIG_HOME = makeTempDir("akm-health-config-");
  process.env.XDG_DATA_HOME = makeTempDir("akm-health-data-");
  process.env.XDG_STATE_HOME = makeTempDir("akm-health-state-");
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Phase 2: --detail per-run ────────────────────────────────────────────────
describe("akm health --detail per-run", () => {
  function seedTwoRuns(): { startA: string; endA: string; startB: string; endB: string } {
    const startA = new Date(Date.now() - 60_000).toISOString();
    const endA = new Date(Date.now() - 30_000).toISOString();
    const startB = new Date(Date.now() - 25_000).toISOString();
    const endB = new Date(Date.now() - 10_000).toISOString();
    const db = openStateDatabase();
    try {
      upsertTaskHistory(db, {
        task_id: "akm-improve",
        status: "completed",
        started_at: startA,
        completed_at: endA,
        failed_at: null,
        log_path: null,
        target_kind: "improve",
        target_ref: null,
        metadata_json: "{}",
      });
      upsertTaskHistory(db, {
        task_id: "akm-improve",
        status: "completed",
        started_at: startB,
        completed_at: endB,
        failed_at: null,
        log_path: null,
        target_kind: "improve",
        target_ref: null,
        metadata_json: "{}",
      });
      recordImproveRun(db, {
        id: "run-a",
        startedAt: startA,
        completedAt: endA,
        stashDir: "/tmp/stash",
        dryRun: false,
        profile: null,
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: true,
        result: fixtureResult({
          schemaVersion: 1,
          ok: true,
          scope: { mode: "all" },
          dryRun: false,
          actions: [
            { ref: "memory:a", mode: "reflect", result: { ok: true } },
            { ref: "memory:b", mode: "distill", result: { outcome: "queued" } },
          ],
          memoryInference: { considered: 4, writtenFacts: 2, skippedNoFacts: 1 },
          orphansPurged: 2,
          lintSummary: { fixed: 1, flagged: 0 },
        }),
      });
      recordImproveRun(db, {
        id: "run-b",
        startedAt: startB,
        completedAt: endB,
        stashDir: "/tmp/stash",
        dryRun: false,
        profile: null,
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: true,
        result: fixtureResult({
          schemaVersion: 1,
          ok: true,
          scope: { mode: "all" },
          dryRun: false,
          actions: [{ ref: "memory:z", mode: "distill", result: { outcome: "llm_failed" } }],
        }),
      });
    } finally {
      db.close();
    }
    return { startA, endA, startB, endB };
  }

  test("default mode omits runs[]", () => {
    seedTwoRuns();
    const result = akmHealth({ since: "7d" });
    expect(result.runs).toBeUndefined();
  });

  test("--detail per-run returns runs[] with the right shape", () => {
    seedTwoRuns();
    const result = akmHealth({ since: "7d", detail: "per-run" });
    expect(result.runs).toBeDefined();
    expect(result.runs?.length).toBe(2);
    const ids = result.runs?.map((r) => r.id) ?? [];
    expect(ids).toContain("run-a");
    expect(ids).toContain("run-b");
  });

  test("--detail per-run rows are ordered newest first", () => {
    const { startA, startB } = seedTwoRuns();
    expect(new Date(startB).getTime()).toBeGreaterThan(new Date(startA).getTime());
    const result = akmHealth({ since: "7d", detail: "per-run" });
    expect(result.runs?.[0].id).toBe("run-b");
    expect(result.runs?.[1].id).toBe("run-a");
  });

  test("per-run summary fields parity with window aggregator (one row)", () => {
    // Seed a single run, then compare aggregator output vs runs[0].
    const startA = new Date(Date.now() - 60_000).toISOString();
    const endA = new Date(Date.now() - 30_000).toISOString();
    const db = openStateDatabase();
    try {
      upsertTaskHistory(db, {
        task_id: "akm-improve",
        status: "completed",
        started_at: startA,
        completed_at: endA,
        failed_at: null,
        log_path: null,
        target_kind: "improve",
        target_ref: null,
        metadata_json: "{}",
      });
      recordImproveRun(db, {
        id: "run-parity",
        startedAt: startA,
        completedAt: endA,
        stashDir: "/tmp/stash",
        dryRun: false,
        profile: null,
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: true,
        result: fixtureResult({
          schemaVersion: 1,
          ok: true,
          scope: { mode: "all" },
          dryRun: false,
          actions: [
            { ref: "memory:a", mode: "reflect", result: { ok: true } },
            { ref: "memory:b", mode: "reflect-failed", result: { ok: false, error: "boom" } },
            { ref: "memory:c", mode: "distill", result: { outcome: "queued" } },
          ],
          consolidation: {
            schemaVersion: 1,
            ok: true,
            processed: 2,
            merged: 1,
            deleted: 0,
            promoted: ["lesson:a"],
            contradicted: 0,
            warnings: [],
            durationMs: 120,
          },
          memoryInference: { considered: 8, writtenFacts: 4, skippedNoFacts: 2 },
          memoryInferenceDurationMs: 30,
          graphExtraction: {
            considered: 5,
            extracted: 3,
            totalEntities: 10,
            totalRelations: 4,
            written: true,
            quality: {
              consideredFiles: 5,
              extractedFiles: 3,
              entityCount: 10,
              relationCount: 4,
              extractionCoverage: 0.6,
              density: 0.4,
            },
            telemetry: { cacheHits: 3, cacheMisses: 1, truncationCount: 0, failureCount: 0 },
          },
          graphExtractionDurationMs: 25,
        }),
      });
    } finally {
      db.close();
    }
    const aggregate = akmHealth({ since: "7d" });
    const perRun = akmHealth({ since: "7d", detail: "per-run" });
    const row = perRun.runs?.[0];
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.actions).toEqual(aggregate.improve.actions);
    expect(row.consolidation.processed).toBe(aggregate.improve.consolidation.processed);
    expect(row.consolidation.promoted).toBe(aggregate.improve.consolidation.promoted);
    expect(row.memoryInference.considered).toBe(aggregate.improve.memoryInference.considered);
    expect(row.memoryInference.written).toBe(aggregate.improve.memoryInference.written);
    expect(row.memoryInference.yieldRate).toBe(aggregate.improve.memoryInference.yieldRate);
    expect(row.graphExtraction.entities).toBe(aggregate.improve.graphExtraction.entities);
    expect(row.graphExtraction.cacheHitRate).toBe(aggregate.improve.graphExtraction.cacheHitRate);
  }, 30_000);

  test("invalid --detail value raises UsageError", () => {
    expect(() => akmHealth({ since: "7d", detail: "bogus" as unknown as "brief" })).toThrow(
      /Invalid value for --detail/,
    );
  });
});

// ── Phase 3: window-compare ──────────────────────────────────────────────────
describe("akm health --window-compare / --windows", () => {
  test("--window-compare 1h returns two windows named current and prior", () => {
    const result = akmHealth({ windowCompare: "1h" });
    expect(result.windows?.length).toBe(2);
    expect(result.windows?.[0].name).toBe("current");
    expect(result.windows?.[1].name).toBe("prior");
    // chronologically current > prior
    expect(new Date(result.windows?.[0].since ?? "").getTime()).toBeGreaterThan(
      new Date(result.windows?.[1].since ?? "").getTime(),
    );
  });

  test("explicit --windows supports multiple named windows", () => {
    const now = Date.now();
    const w1Since = new Date(now - 3 * 60 * 60 * 1000).toISOString();
    const w1Until = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    const w2Since = new Date(now - 1 * 60 * 60 * 1000).toISOString();
    const result = akmHealth({
      windows: [
        { name: "baseline", since: w1Since, until: w1Until },
        { name: "post-fix", since: w2Since },
      ],
    });
    expect(result.windows?.length).toBe(2);
    expect(result.windows?.[0].name).toBe("baseline");
    expect(result.windows?.[1].name).toBe("post-fix");
  });

  test("deltas computed correctly for known seeded values", () => {
    const now = Date.now();
    const earlySince = new Date(now - 6 * 60 * 60 * 1000).toISOString();
    const earlyEnd = new Date(now - 4 * 60 * 60 * 1000).toISOString();
    const lateSince = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    const lateEnd = new Date(now - 30 * 60 * 1000).toISOString();

    const db = openStateDatabase();
    try {
      // Earlier window: 2 distill llm_failed
      recordImproveRun(db, {
        id: "run-early",
        startedAt: earlySince,
        completedAt: earlyEnd,
        stashDir: "/tmp/stash",
        dryRun: false,
        profile: null,
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: true,
        result: fixtureResult({
          schemaVersion: 1,
          ok: true,
          scope: { mode: "all" },
          dryRun: false,
          actions: [
            { ref: "memory:a", mode: "distill", result: { outcome: "llm_failed" } },
            { ref: "memory:b", mode: "distill", result: { outcome: "llm_failed" } },
          ],
        }),
      });
      // Later window: 4 distill llm_failed (100% increase)
      recordImproveRun(db, {
        id: "run-late",
        startedAt: lateSince,
        completedAt: lateEnd,
        stashDir: "/tmp/stash",
        dryRun: false,
        profile: null,
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: true,
        result: fixtureResult({
          schemaVersion: 1,
          ok: true,
          scope: { mode: "all" },
          dryRun: false,
          actions: [
            { ref: "memory:a", mode: "distill", result: { outcome: "llm_failed" } },
            { ref: "memory:b", mode: "distill", result: { outcome: "llm_failed" } },
            { ref: "memory:c", mode: "distill", result: { outcome: "llm_failed" } },
            { ref: "memory:d", mode: "distill", result: { outcome: "llm_failed" } },
          ],
        }),
      });
    } finally {
      db.close();
    }

    const result = akmHealth({
      windows: [
        { name: "early", since: earlySince, until: new Date(now - 3 * 60 * 60 * 1000).toISOString() },
        { name: "late", since: new Date(now - 3 * 60 * 60 * 1000).toISOString() },
      ],
    });
    expect(result.deltas).toBeDefined();
    const delta = result.deltas?.["improve.actions.distill.llmFailed"];
    expect(delta?.from).toBe(2);
    expect(delta?.to).toBe(4);
    expect(delta?.pctChange).toBe(100);
  });

  // Regression guard: deltas must read chronologically — `from` is the
  // earliest window, `to` is the latest. The Phase-3 agent originally
  // used windowResults array order (windows[0] → windows[N-1]), which
  // meant `--window-compare 24h` produced from=current, to=prior — a
  // backwards reading. Fix sorts by `since` before computing deltas
  // independent of the user-specified array order.
  test("delta direction is chronological: from = earliest window, to = latest, regardless of windows[] order", () => {
    const now = Date.now();
    const earliestSince = new Date(now - 6 * 60 * 60 * 1000).toISOString();
    const earliestUntil = new Date(now - 4 * 60 * 60 * 1000).toISOString();
    const latestSince = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    const latestRunStart = new Date(now - 90 * 60 * 1000).toISOString();
    const earliestRunStart = new Date(now - 5 * 60 * 60 * 1000).toISOString();

    const db = openStateDatabase();
    try {
      // Earliest window: 5 llm_failed (the regression we'd want to see
      // disappear over time).
      recordImproveRun(db, {
        id: "run-early-buggy",
        startedAt: earliestRunStart,
        completedAt: earliestRunStart,
        stashDir: "/tmp/stash",
        dryRun: false,
        profile: null,
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: true,
        result: fixtureResult({
          schemaVersion: 1,
          ok: true,
          scope: { mode: "all" },
          dryRun: false,
          actions: Array.from({ length: 5 }, () => ({
            ref: "memory:x",
            mode: "distill",
            result: { outcome: "llm_failed" },
          })),
        }),
      });
      // Latest window: 0 failures (the fix landed).
      recordImproveRun(db, {
        id: "run-late-clean",
        startedAt: latestRunStart,
        completedAt: latestRunStart,
        stashDir: "/tmp/stash",
        dryRun: false,
        profile: null,
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: true,
        result: fixtureResult({
          schemaVersion: 1,
          ok: true,
          scope: { mode: "all" },
          dryRun: false,
          actions: [{ ref: "memory:x", mode: "distill", result: { outcome: "queued" } }],
        }),
      });
    } finally {
      db.close();
    }

    // Pass windows in REVERSE chronological order (latest first, mimicking
    // what --window-compare 24h produces). Deltas should still read
    // earliest→latest, not array-order.
    const result = akmHealth({
      windows: [
        { name: "current", since: latestSince },
        { name: "prior", since: earliestSince, until: earliestUntil },
      ],
    });

    const delta = result.deltas?.["improve.actions.distill.llmFailed"];
    expect(delta).toBeDefined();
    // earliest window had 5 llm_failed; latest had 0. Chronological reading:
    // from = 5 (earliest), to = 0 (latest), pctChange = -100% (improvement).
    expect(delta?.from).toBe(5);
    expect(delta?.to).toBe(0);
    expect(delta?.pctChange).toBe(-100);
  });

  test("delta uses '+inf' when from is 0 and to is positive", () => {
    const now = Date.now();
    const earlySince = new Date(now - 6 * 60 * 60 * 1000).toISOString();
    const lateStart = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    const lateEnd = new Date(now - 30 * 60 * 1000).toISOString();

    const db = openStateDatabase();
    try {
      recordImproveRun(db, {
        id: "run-late-only",
        startedAt: lateStart,
        completedAt: lateEnd,
        stashDir: "/tmp/stash",
        dryRun: false,
        profile: null,
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: true,
        result: fixtureResult({
          schemaVersion: 1,
          ok: true,
          scope: { mode: "all" },
          dryRun: false,
          actions: [{ ref: "memory:x", mode: "distill", result: { outcome: "llm_failed" } }],
        }),
      });
    } finally {
      db.close();
    }

    const result = akmHealth({
      windows: [
        { name: "early", since: earlySince, until: new Date(now - 3 * 60 * 60 * 1000).toISOString() },
        { name: "late", since: new Date(now - 3 * 60 * 60 * 1000).toISOString() },
      ],
    });
    expect(result.deltas?.["improve.actions.distill.llmFailed"]?.pctChange).toBe("+inf");
  });

  test("mutually exclusive flags throw UsageError", () => {
    expect(() =>
      akmHealth({
        windowCompare: "1h",
        windows: [{ name: "x", since: new Date().toISOString() }],
      }),
    ).toThrow(/mutually exclusive/);
  });

  test("duplicate window names throw UsageError", () => {
    expect(() =>
      akmHealth({
        windows: [
          { name: "dup", since: new Date(Date.now() - 7200_000).toISOString() },
          { name: "dup", since: new Date(Date.now() - 3600_000).toISOString() },
        ],
      }),
    ).toThrow(/duplicate name/);
  });

  test("more than 4 windows throws UsageError", () => {
    const now = Date.now();
    expect(() =>
      akmHealth({
        windows: [
          { name: "w1", since: new Date(now - 5 * 3600_000).toISOString() },
          { name: "w2", since: new Date(now - 4 * 3600_000).toISOString() },
          { name: "w3", since: new Date(now - 3 * 3600_000).toISOString() },
          { name: "w4", since: new Date(now - 2 * 3600_000).toISOString() },
          { name: "w5", since: new Date(now - 1 * 3600_000).toISOString() },
        ],
      }),
    ).toThrow(/at most 4/);
  });

  test("invalid --window-compare duration throws UsageError", () => {
    expect(() => akmHealth({ windowCompare: "not-a-duration" })).toThrow();
  });
});
