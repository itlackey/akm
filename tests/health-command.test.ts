import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmHealth, parseHealthSince } from "../src/commands/health";
import type { AkmImproveResult } from "../src/commands/improve";
import { appendEvent } from "../src/core/events";
import { openStateDatabase, recordImproveRun, upsertTaskHistory } from "../src/core/state-db";
import type { SessionLogEntry } from "../src/integrations/session-logs";

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

describe("parseHealthSince", () => {
  test("accepts duration shorthand", () => {
    const since = parseHealthSince("2d");
    expect(typeof since).toBe("string");
    expect(Number.isNaN(new Date(since).getTime())).toBe(false);
  });
});

describe("akmHealth", () => {
  test("reports invoked/completed/skipped from the events stream", () => {
    const now = new Date().toISOString();
    appendEvent({ eventType: "improve_invoked", ref: "improve:all:all", metadata: { dryRun: false } });
    appendEvent({ eventType: "improve_skipped", ref: "memory:alpha", metadata: { reason: "reflect_cooldown" } });
    appendEvent({
      eventType: "improve_completed",
      ref: "improve:all:all",
      metadata: { completedAt: now },
    });

    const result = akmHealth({ since: "7d" });

    expect(result.schemaVersion).toBe(2);
    expect(result.improve.invoked).toBe(1);
    expect(result.improve.completed).toBe(1);
    expect(result.improve.skipped).toBe(1);
    expect(result.improve.skipReasons.reflect_cooldown).toBe(1);
  });

  test("reports rich improve metrics from improve_runs (Phase 1)", () => {
    const startA = new Date(Date.now() - 60_000).toISOString();
    const endA = new Date(Date.now() - 30_000).toISOString();
    const startB = new Date(Date.now() - 25_000).toISOString();
    const endB = new Date(Date.now() - 10_000).toISOString();
    const startDry = new Date(Date.now() - 9_000).toISOString();
    const endDry = new Date(Date.now() - 5_000).toISOString();

    // Wall-time rows in task_history for task_id='akm-improve'.
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

      // Real improve_run row with rich envelope fields.
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
          memorySummary: { eligible: 4, derived: 2 },
          plannedRefs: [{ ref: "memory:a" }, { ref: "memory:b" }, { ref: "memory:c" }],
          actions: [
            { ref: "memory:a", mode: "reflect", result: { ok: true } },
            { ref: "memory:b", mode: "reflect-failed", result: { ok: false, error: "boom" } },
            { ref: "memory:c", mode: "distill", result: { outcome: "queued" } },
            { ref: "memory:d", mode: "distill", result: { outcome: "llm_failed" } },
            { ref: "memory:e", mode: "distill", result: { outcome: "quality_rejected" } },
            { ref: "memory:f", mode: "memory-inference", result: { ok: true } },
            { ref: "memory:g", mode: "graph-extraction", result: { ok: true } },
          ],
          consolidation: {
            schemaVersion: 1,
            ok: true,
            shape: "consolidate-result",
            dryRun: false,
            previewOnly: false,
            target: "/tmp/stash",
            processed: 3,
            merged: 1,
            deleted: 2,
            promoted: ["lesson:foo", "lesson:bar"],
            contradicted: 1,
            warnings: [],
            durationMs: 200,
          },
          memoryInference: {
            considered: 10,
            splitParents: 3,
            writtenFacts: 6,
            skippedNoFacts: 1,
          },
          graphExtraction: {
            considered: 8,
            extracted: 5,
            totalEntities: 25,
            totalRelations: 15,
            written: true,
            quality: {
              consideredFiles: 8,
              extractedFiles: 5,
              entityCount: 25,
              relationCount: 15,
              extractionCoverage: 0.625,
              density: 0.05,
            },
            telemetry: {
              cacheHits: 6,
              cacheMisses: 2,
              truncationCount: 1,
              failureCount: 0,
            },
          },
          memoryInferenceDurationMs: 50,
          graphExtractionDurationMs: 70,
          reflectsWithErrorContext: 1,
        }),
      });

      // Second real run — should aggregate.
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
          memorySummary: { eligible: 1, derived: 0 },
          plannedRefs: [{ ref: "memory:z" }],
          actions: [{ ref: "memory:z", mode: "distill", result: { outcome: "queued" } }],
        }),
      });

      // Dry-run row — MUST be excluded.
      recordImproveRun(db, {
        id: "run-dry",
        startedAt: startDry,
        completedAt: endDry,
        stashDir: "/tmp/stash",
        dryRun: true,
        profile: null,
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: true,
        result: fixtureResult({
          schemaVersion: 1,
          ok: true,
          scope: { mode: "all" },
          dryRun: true,
          memorySummary: { eligible: 999, derived: 999 },
          plannedRefs: new Array(999).fill({ ref: "memory:dry" }),
          actions: [{ ref: "memory:dry", mode: "distill", result: { outcome: "queued" } }],
        }),
      });
    } finally {
      db.close();
    }

    const result = akmHealth({ since: "7d" });

    // Dry-run was excluded — plannedRefs is 3 + 1, not 999+.
    expect(result.improve.plannedRefs).toBe(4);

    // Reflect outcome split.
    expect(result.improve.actions.reflect.ok).toBe(1);
    expect(result.improve.actions.reflect.failed).toBe(1);

    // Distill outcome split (run-a: queued/llmFailed/qualityRejected, run-b: queued).
    expect(result.improve.actions.distill.queued).toBe(2);
    expect(result.improve.actions.distill.llmFailed).toBe(1);
    expect(result.improve.actions.distill.qualityRejected).toBe(1);

    // Action mode counts.
    expect(result.improve.actions.memoryInference).toBe(1);
    expect(result.improve.actions.graphExtraction).toBe(1);

    // Consolidation outcomes.
    expect(result.improve.consolidation.processed).toBe(3);
    expect(result.improve.consolidation.promoted).toBe(2);
    expect(result.improve.consolidation.merged).toBe(1);
    expect(result.improve.consolidation.deleted).toBe(2);
    expect(result.improve.consolidation.contradicted).toBe(1);

    // Memory inference: 6/10 = 0.6 yield rate.
    expect(result.improve.memoryInference.considered).toBe(10);
    expect(result.improve.memoryInference.written).toBe(6);
    expect(result.improve.memoryInference.splitParents).toBe(3);
    expect(result.improve.memoryInference.skippedNoFacts).toBe(1);
    expect(result.improve.memoryInference.yieldRate).toBe(0.6);
    // Legacy alias for the v1 shape.
    expect(result.improve.memoryInference.writes).toBe(result.improve.memoryInference.written);

    // Graph extraction quality.
    expect(result.improve.graphExtraction.entities).toBe(25);
    expect(result.improve.graphExtraction.relations).toBe(15);
    expect(result.improve.graphExtraction.cacheHits).toBe(6);
    expect(result.improve.graphExtraction.cacheMisses).toBe(2);
    expect(result.improve.graphExtraction.cacheHitRate).toBe(0.75);
    expect(result.improve.graphExtraction.truncations).toBe(1);
    expect(result.improve.graphExtraction.failures).toBe(0);

    // Wall-time stats from task_history.
    expect(result.improve.wallTime.count).toBe(2);
    expect(result.improve.wallTime.minMs).toBeGreaterThan(0);
    expect(result.improve.wallTime.maxMs).toBeGreaterThanOrEqual(result.improve.wallTime.minMs);
    expect(result.improve.wallTime.medianMs).toBeGreaterThan(0);

    // Schema bumped.
    expect(result.schemaVersion).toBe(2);
  });

  test("createUnknownImproveMetrics-like shape when nothing recorded", () => {
    const result = akmHealth({ since: "7d" });
    expect(result.improve.actions.reflect).toEqual({ ok: 0, failed: 0, cooldown: 0, skipped: 0 });
    expect(result.improve.actions.distill).toEqual({
      queued: 0,
      llmFailed: 0,
      qualityRejected: 0,
      configDisabled: 0,
      skipped: 0,
    });
    expect(result.improve.consolidation.ran).toBe(false);
    expect(result.improve.memoryInference.yieldRate).toBe(0);
    expect(result.improve.graphExtraction.cacheHitRate).toBe(0);
    expect(result.improve.wallTime).toEqual({ count: 0, medianMs: 0, p95Ms: 0, minMs: 0, maxMs: 0 });
  });

  test("derives task and log metrics from task_history", () => {
    const logDir = makeTempDir("akm-health-logs-");
    const okLog = path.join(logDir, "ok.log");
    fs.writeFileSync(okLog, "ok\n", "utf8");
    const db = openStateDatabase();
    try {
      upsertTaskHistory(db, {
        task_id: "ok-task",
        status: "completed",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        failed_at: null,
        log_path: okLog,
        target_kind: "prompt",
        target_ref: null,
        metadata_json: JSON.stringify({ durationMs: 10, detail: { exitCode: 0 }, profile: "opencode" }),
      });
      upsertTaskHistory(db, {
        task_id: "failed-task",
        status: "failed",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        failed_at: new Date().toISOString(),
        log_path: path.join(logDir, "missing.log"),
        target_kind: "prompt",
        target_ref: null,
        metadata_json: JSON.stringify({
          durationMs: 20,
          detail: { exitCode: 2, reason: "non_zero_exit", error: "boom" },
          profile: "opencode",
        }),
      });
    } finally {
      db.close();
    }

    const result = akmHealth({ since: "7d" });

    expect(result.metrics.taskFailRate).toBe(0.5);
    expect(result.metrics.agentFailureRate).toBe(0.5);
    expect(result.metrics.logBackingRate).toBe(0.5);
    expect(result.hardChecks.some((check) => check.name === "task-log-backing" && check.status === "fail")).toBe(true);
  });

  test("passes requested since window through to session log candidates", () => {
    const seen: number[] = [];
    const getExecutionLogCandidatesFn = (sinceDays = 7): SessionLogEntry[] => {
      seen.push(sinceDays);
      return [];
    };

    akmHealth({ since: "12h", getExecutionLogCandidatesFn });

    expect(seen).toEqual([1]);
  });

  test("heuristic-only advisories do not degrade overall status", () => {
    const getExecutionLogCandidatesFn = (): SessionLogEntry[] => [
      {
        topic: "failed again",
        frequency: 2,
        source: "claude-code",
        isFailurePattern: true,
      },
    ];

    const result = akmHealth({ since: "7d", getExecutionLogCandidatesFn });

    expect(result.status).toBe("pass");
    expect(result.advisories.some((check) => check.name === "session-log-failures" && check.status === "warn")).toBe(
      true,
    );
  });
});

// The CHANGELOG advertises `akm health` as a runtime/CI monitoring command:
// callers chain `akm health && deploy`, which requires non-zero exit on a hard
// failure (and a parseable JSON envelope on stdout for diagnostics). These
// tests spawn the real CLI so the exit code is observable to the OS, then
// assert that (a) stdout is still valid JSON and (b) the exit code matches the
// `status` discriminant in the envelope.
describe("akm health CLI exit code", () => {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const cliPath = path.join(repoRoot, "src", "cli.ts");

  function spawnAkmHealth(envOverrides: Record<string, string>): { stdout: string; status: number } {
    const result = spawnSync("bun", [cliPath, "health", "--format", "json"], {
      encoding: "utf8",
      timeout: 30_000,
      cwd: repoRoot,
      env: {
        ...process.env,
        AKM_STASH_DIR: undefined,
        ...envOverrides,
      },
    });
    return { stdout: result.stdout ?? "", status: result.status ?? 1 };
  }

  test("exits 0 when health passes (no failing checks)", () => {
    const xdgCache = makeTempDir("akm-health-cache-cli-");
    const xdgConfig = makeTempDir("akm-health-config-cli-");
    const xdgData = makeTempDir("akm-health-data-cli-");
    const xdgState = makeTempDir("akm-health-state-cli-");
    const home = makeTempDir("akm-health-home-cli-");
    const { stdout, status } = spawnAkmHealth({
      HOME: home,
      XDG_CACHE_HOME: xdgCache,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: xdgData,
      XDG_STATE_HOME: xdgState,
    });
    // stdout must be valid JSON regardless of exit code so monitors can parse.
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("pass");
    expect(status).toBe(0);
  });

  test("exits non-zero (1) when status is 'fail' due to missing task log", () => {
    const xdgCache = makeTempDir("akm-health-cache-cli-fail-");
    const xdgConfig = makeTempDir("akm-health-config-cli-fail-");
    const xdgData = makeTempDir("akm-health-data-cli-fail-");
    const xdgState = makeTempDir("akm-health-state-cli-fail-");
    const home = makeTempDir("akm-health-home-cli-fail-");

    // Seed state.db with a task_history row that references a log_path that
    // does NOT exist on disk. That forces the deterministic `task-log-backing`
    // hardCheck to fail, which sets overall status="fail".
    process.env.XDG_CACHE_HOME = xdgCache;
    process.env.XDG_CONFIG_HOME = xdgConfig;
    process.env.XDG_DATA_HOME = xdgData;
    process.env.XDG_STATE_HOME = xdgState;
    const db = openStateDatabase();
    try {
      upsertTaskHistory(db, {
        task_id: "missing-log-task",
        status: "failed",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        failed_at: new Date().toISOString(),
        log_path: path.join(makeTempDir("akm-health-missing-"), "definitely-missing.log"),
        target_kind: "prompt",
        target_ref: null,
        metadata_json: JSON.stringify({ durationMs: 5, detail: { exitCode: 1 }, profile: "opencode" }),
      });
    } finally {
      db.close();
    }

    const { stdout, status } = spawnAkmHealth({
      HOME: home,
      XDG_CACHE_HOME: xdgCache,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: xdgData,
      XDG_STATE_HOME: xdgState,
    });
    // Exit code must propagate AFTER JSON is flushed, so stdout is still
    // parseable JSON for monitoring scripts.
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("fail");
    expect(status).toBe(1);
  });
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
  });

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
