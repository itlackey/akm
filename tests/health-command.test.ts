import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type AkmHealthOptions, akmHealth, parseHealthSince } from "../src/commands/health";
import type { AkmImproveResult } from "../src/commands/improve/improve";
import { resolveDataContext } from "../src/core/context";
import { type AppendEventInput, appendEvent } from "../src/core/events";
import { openStateDatabase, recordImproveRun, upsertTaskHistory } from "../src/core/state-db";
import type { SessionLogEntry } from "../src/integrations/session-logs";
import { runCliCapture } from "./_helpers/cli";

function fixtureResult(partial: Record<string, unknown>): AkmImproveResult {
  return partial as unknown as AkmImproveResult;
}

// C2 env-threading: each test resolves its data context ONCE (from the tmpdir
// created in beforeEach) and threads the explicit stateDbPath into every DB
// open, event append, and akmHealth call. The leaves never re-read
// process.env.XDG_DATA_HOME, so a parallel test file mutating that global can
// no longer redirect this test's state.db open/migrate to a wrong or
// just-deleted tmpdir — the #553/#554/#499 flake root cause. The in-process
// CLI tests (runCliCapture) still resolve env at CLI startup, which is the
// single-resolution boundary and is race-free.
let dataDir = "";
let stateDbPath = "";

/** Open the current test's state.db by explicit path (no env read). */
function openDb() {
  return openStateDatabase(stateDbPath);
}

/** Append an event to the current test's state.db by explicit path. */
function emit(input: AppendEventInput): void {
  appendEvent(input, { dbPath: stateDbPath });
}

/** Run akmHealth with the current test's data context threaded in. */
function health(options: AkmHealthOptions = {}): ReturnType<typeof akmHealth> {
  return akmHealth({ ...options, dataContext: resolveDataContext({ dataDir }) });
}

/**
 * Re-resolve the threaded data context from the CURRENT process.env. The
 * in-process CLI tests below intentionally re-pin XDG_DATA_HOME after
 * beforeEach and drive the real CLI (which resolves env at its own boundary);
 * the seeding openDb() must therefore target that re-pinned dir, not the
 * beforeEach one. Call this immediately after re-pinning the env.
 */
function repinDataContext(): void {
  ({ dataDir, stateDbPath } = resolveDataContext({ env: process.env }));
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
  const xdgData = makeTempDir("akm-health-data-");
  process.env.XDG_DATA_HOME = xdgData;
  process.env.XDG_STATE_HOME = makeTempDir("akm-health-state-");
  // getDataDir(XDG_DATA_HOME) appends the `akm` subdir; resolve the explicit
  // data context here so DB/event/health paths are threaded, not env-read.
  ({ dataDir, stateDbPath } = resolveDataContext({ env: process.env }));
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
    emit({ eventType: "improve_invoked", ref: "improve:all:all", metadata: { dryRun: false } });
    emit({ eventType: "improve_skipped", ref: "memory:alpha", metadata: { reason: "reflect_cooldown" } });
    emit({
      eventType: "improve_completed",
      ref: "improve:all:all",
      metadata: { completedAt: now },
    });

    const result = health({ since: "7d" });

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
    const db = openDb();
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

    const result = health({ since: "7d" });

    // Dry-run was excluded — plannedRefs is 3 + 1, not 999+.
    expect(result.improve.plannedRefs).toBe(4);

    // 2026-05-27: profileFilteredRefs aggregation. Fixtures above don't
    // populate this field, so the metric stays at 0 — but it must exist
    // on the result so consumers can read it. Regression for the planner
    // pre-filter (0e9f283) whose envelope field was written but never
    // surfaced through the metric (audit found 774/24h invisible).
    expect(result.improve.profileFilteredRefs).toBe(0);

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

    // Memory inference: the fixture envelope omits the `cacheHits` field,
    // so it counts as a legacy (pre-2026-05-26) envelope and is excluded
    // from the yield aggregate (freshAttempts/yieldRate=0). Totals still
    // include it. See the legacy-gating regression test below.
    expect(result.improve.memoryInference.considered).toBe(10);
    expect(result.improve.memoryInference.cacheHits).toBe(0);
    expect(result.improve.memoryInference.freshAttempts).toBe(0);
    expect(result.improve.memoryInference.written).toBe(6);
    expect(result.improve.memoryInference.splitParents).toBe(3);
    expect(result.improve.memoryInference.skippedNoFacts).toBe(1);
    expect(result.improve.memoryInference.yieldRate).toBe(0);
    expect(result.improve.memoryInference.yieldEligibleRuns).toBe(0);
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

    // Per-phase wall-time aggregation (2026-05-26). Only run-a has phase
    // durations on its envelope (consolidation=200, memoryInf=50, graph=70);
    // run-b omits them and must NOT inflate counts to 2.
    expect(result.improve.wallTime.byPhase.consolidation.count).toBe(1);
    expect(result.improve.wallTime.byPhase.consolidation.totalMs).toBe(200);
    expect(result.improve.wallTime.byPhase.consolidation.medianMs).toBe(200);
    expect(result.improve.wallTime.byPhase.memoryInference.count).toBe(1);
    expect(result.improve.wallTime.byPhase.memoryInference.totalMs).toBe(50);
    expect(result.improve.wallTime.byPhase.graphExtraction.count).toBe(1);
    expect(result.improve.wallTime.byPhase.graphExtraction.totalMs).toBe(70);

    // Schema bumped.
    expect(result.schemaVersion).toBe(2);
  });

  test("manual run row with distinct started_at<completed_at and no task_history yields wallTime from the row delta (#499)", () => {
    const start = new Date(Date.now() - 60_000).toISOString();
    const end = new Date(Date.now() - 45_000).toISOString(); // 15s row delta
    const db = openDb();
    try {
      // No task_history interval — this is a manually-invoked `akm improve`.
      recordImproveRun(db, {
        id: "run-manual",
        startedAt: start,
        completedAt: end,
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
          plannedRefs: [{ ref: "memory:m" }],
          actions: [{ ref: "memory:m", mode: "distill", result: { outcome: "queued" } }],
        }),
      });
    } finally {
      db.close();
    }

    const result = health({ since: "7d" });

    // wallTime comes from the row's own (completed_at - started_at) delta (15s),
    // NOT from any task_history join (there is none).
    expect(result.improve.wallTime.count).toBe(1);
    expect(result.improve.wallTime.minMs).toBe(15_000);
    expect(result.improve.wallTime.maxMs).toBe(15_000);
  });

  test("legacy row with started_at==completed_at falls back to containing task_history interval duration (#499)", () => {
    const taskStart = new Date(Date.now() - 60_000).toISOString();
    const taskEnd = new Date(Date.now() - 38_000).toISOString(); // 22s interval
    // Legacy/backfill row: started_at == completed_at, falling inside the task interval.
    const stamp = new Date(Date.now() - 50_000).toISOString();
    const db = openDb();
    try {
      upsertTaskHistory(db, {
        task_id: "akm-improve",
        status: "completed",
        started_at: taskStart,
        completed_at: taskEnd,
        failed_at: null,
        log_path: null,
        target_kind: "improve",
        target_ref: null,
        metadata_json: "{}",
      });
      recordImproveRun(db, {
        id: "run-legacy",
        startedAt: stamp,
        completedAt: stamp,
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
          plannedRefs: [{ ref: "memory:l" }],
          actions: [{ ref: "memory:l", mode: "distill", result: { outcome: "queued" } }],
        }),
      });
    } finally {
      db.close();
    }

    const result = health({ since: "7d" });

    // Row delta is 0, so wallTime is sourced from the containing task interval (22s).
    expect(result.improve.wallTime.count).toBe(1);
    expect(result.improve.wallTime.minMs).toBe(22_000);
    expect(result.improve.wallTime.maxMs).toBe(22_000);
  });

  test("reflect content-policy guard hits are counted separately from failed (Pattern A)", () => {
    const start = new Date(Date.now() - 60_000).toISOString();
    const end = new Date(Date.now() - 30_000).toISOString();
    const db = openDb();
    try {
      recordImproveRun(db, {
        id: "run-guard",
        startedAt: start,
        completedAt: end,
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
          plannedRefs: [],
          actions: [
            // Pre-2026-05-26 these would have all been "reflect-failed".
            { ref: "memory:a", mode: "reflect", result: { ok: true } },
            {
              ref: "memory:b",
              mode: "reflect-failed",
              result: { ok: false, reason: "parse_error", error: "missing required ref field" },
            },
            {
              ref: "memory:c",
              mode: "reflect-guard-rejected",
              result: {
                ok: false,
                reason: "content_policy_reject",
                error: "Reflect rejected: EXCESSIVE_SHRINKAGE — proposed body is 12% of source",
              },
            },
            {
              ref: "memory:d",
              mode: "reflect-guard-rejected",
              result: {
                ok: false,
                reason: "content_policy_reject",
                error: "Reflect rejected: EXCESSIVE_EXPANSION — proposed body is 380% of source",
              },
            },
          ],
        }),
      });
    } finally {
      db.close();
    }

    const result = health({ since: "7d" });
    // The two guard hits MUST land in guardRejected, NOT failed. The user's
    // dashboards depend on "failed = LLM faults only" semantics.
    expect(result.improve.actions.reflect.ok).toBe(1);
    expect(result.improve.actions.reflect.failed).toBe(1);
    expect(result.improve.actions.reflect.guardRejected).toBe(2);
  });

  test("distill outcome:skipped surfaces as actions.distill.deferred with skipReason breakdown", () => {
    const start = new Date(Date.now() - 60_000).toISOString();
    const end = new Date(Date.now() - 30_000).toISOString();
    const db = openDb();
    try {
      recordImproveRun(db, {
        id: "run-deferred",
        startedAt: start,
        completedAt: end,
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
          plannedRefs: [],
          actions: [
            {
              ref: "lesson:a",
              mode: "distill",
              result: {
                outcome: "skipped",
                skipReason: "recursive_lesson_input",
                message: "Distill refuses lesson inputs",
              },
            },
            {
              ref: "knowledge:b",
              mode: "distill",
              result: {
                outcome: "skipped",
                message: "D-1: LLM resolved destination conflict as NOOP — existing content kept",
              },
            },
            {
              ref: "knowledge:c",
              mode: "distill",
              result: { outcome: "skipped", skipReason: "cooldown", message: "proposal cooldown" },
            },
            { ref: "knowledge:d", mode: "distill", result: { outcome: "queued" } },
          ],
        }),
      });
    } finally {
      db.close();
    }

    const result = health({ since: "7d" });
    // Pre-fix: deferred would be 0 (silently dropped by missing case "skipped").
    expect(result.improve.actions.distill.deferred).toBe(3);
    expect(result.improve.actions.distill.queued).toBe(1);
    expect(result.improve.actions.distill.deferredByReason).toEqual({
      recursive_lesson_input: 1,
      conflict_noop: 1,
      cooldown: 1,
    });
  });

  test("reflect-skipped actions are aggregated by sub-reason", () => {
    // Tuning-reasons investigation §Q1: pre-fix the rollup discarded
    // result.reason for reflect-skipped, so 18/18 type-filter+raw-wiki skips
    // were a single opaque scalar in `akm health`. Mirror the
    // `distill.deferredByReason` shape (commit d1273d0).
    const start = new Date(Date.now() - 60_000).toISOString();
    const end = new Date(Date.now() - 30_000).toISOString();
    const db = openDb();
    try {
      recordImproveRun(db, {
        id: "run-reflect-skipped",
        startedAt: start,
        completedAt: end,
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
          plannedRefs: [],
          actions: [
            { ref: "script:a", mode: "reflect-skipped", result: { ok: true, reason: "type-filter" } },
            { ref: "script:b", mode: "reflect-skipped", result: { ok: true, reason: "type-filter" } },
            { ref: "wiki:articles/raw/x", mode: "reflect-skipped", result: { ok: true, reason: "raw-wiki" } },
            {
              ref: "memory:foo.derived",
              mode: "reflect-skipped",
              result: { ok: true, reason: "derived-memory-reflect-skipped" },
            },
            { ref: "memory:bar", mode: "reflect-skipped", result: { ok: true, reason: "unsupported_type" } },
          ],
        }),
      });
    } finally {
      db.close();
    }

    const result = health({ since: "7d" });
    expect(result.improve.actions.reflect.skipped).toBe(5);
    expect(result.improve.actions.reflect.skippedByReason).toEqual({
      "type-filter": 2,
      "raw-wiki": 1,
      "derived-memory-reflect-skipped": 1,
      unsupported_type: 1,
    });
    // Totals must match scalar.
    const total = Object.values(result.improve.actions.reflect.skippedByReason).reduce((a, b) => a + b, 0);
    expect(total).toBe(result.improve.actions.reflect.skipped);
  });

  test("distill.qualityRejected splits into judgeRejected + validatorRejected", () => {
    // Metrics-taxonomy review §1b: in live 7d data 29/29 of qualityRejected
    // were validation_failed (deterministic lint), not LLM-judge rejections.
    // The split lets dashboards distinguish prompt-tuning levers from
    // validator-config levers. Legacy `qualityRejected` is preserved as the
    // sum for back-compat.
    const start = new Date(Date.now() - 60_000).toISOString();
    const end = new Date(Date.now() - 30_000).toISOString();
    const db = openDb();
    try {
      recordImproveRun(db, {
        id: "run-distill-split",
        startedAt: start,
        completedAt: end,
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
          plannedRefs: [],
          actions: [
            { ref: "knowledge:a", mode: "distill", result: { outcome: "quality_rejected" } },
            { ref: "knowledge:b", mode: "distill", result: { outcome: "review_needed" } },
            { ref: "knowledge:c", mode: "distill", result: { outcome: "validation_failed" } },
            { ref: "knowledge:d", mode: "distill", result: { outcome: "validation_failed" } },
            { ref: "knowledge:e", mode: "distill", result: { outcome: "validation_failed" } },
          ],
        }),
      });
    } finally {
      db.close();
    }

    const result = health({ since: "7d" });
    expect(result.improve.actions.distill.judgeRejected).toBe(2);
    expect(result.improve.actions.distill.validatorRejected).toBe(3);
    // Sum invariant: legacy qualityRejected == judge + validator.
    expect(result.improve.actions.distill.qualityRejected).toBe(
      result.improve.actions.distill.judgeRejected + result.improve.actions.distill.validatorRejected,
    );
    expect(result.improve.actions.distill.qualityRejected).toBe(5);
  });

  test("consolidation.judgedNoAction and skipReasons are aggregated", () => {
    // Tuning-reasons investigation §Q2: 78/119 (66%) of consolidate memories
    // had no LLM verdict and were a pure silent drop. The new
    // `judgedNoAction` counter surfaces them; `skipReasons` turns the
    // free-text warnings bag into a typed histogram.
    const start = new Date(Date.now() - 60_000).toISOString();
    const end = new Date(Date.now() - 30_000).toISOString();
    const db = openDb();
    try {
      recordImproveRun(db, {
        id: "run-consolidate-tuning",
        startedAt: start,
        completedAt: end,
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
          plannedRefs: [],
          actions: [],
          consolidation: {
            processed: 119,
            merged: 0,
            deleted: 2,
            promoted: [],
            contradicted: 0,
            failedChunks: 0,
            totalChunks: 3,
            judgedNoAction: 78,
            skipReasons: [
              { ref: "memory:a", skips: [{ op: "promote", reason: "dedup_pending_proposal" }] },
              { ref: "memory:b", skips: [{ op: "promote", reason: "dedup_pending_proposal" }] },
              { ref: "memory:c", skips: [{ op: "delete", reason: "captureMode_hot_refused" }] },
              { ref: "memory:d", skips: [{ op: "delete", reason: "captureMode_hot_refused" }] },
              // Multi-reason ref: one entry whose skips[] carries two ops.
              // Health must aggregate BOTH reasons (today it counted one/ref).
              {
                ref: "memory:e",
                skips: [
                  { op: "merge", reason: "merge_missing_description" },
                  { op: "merge", reason: "merge_sanitization_failed" },
                ],
              },
            ],
            warnings: [],
            durationMs: 37771,
          },
        }),
      });
    } finally {
      db.close();
    }

    const result = health({ since: "7d" });
    expect(result.improve.consolidation.judgedNoAction).toBe(78);
    expect(result.improve.consolidation.skipReasons).toEqual({
      dedup_pending_proposal: 2,
      captureMode_hot_refused: 2,
      merge_missing_description: 1,
      merge_sanitization_failed: 1,
    });
  });

  test("createUnknownImproveMetrics-like shape when nothing recorded", () => {
    const result = health({ since: "7d" });
    expect(result.improve.actions.reflect).toEqual({
      ok: 0,
      failed: 0,
      cooldown: 0,
      skipped: 0,
      guardRejected: 0,
      skippedByReason: {},
    });
    expect(result.improve.actions.distill).toEqual({
      queued: 0,
      llmFailed: 0,
      qualityRejected: 0,
      judgeRejected: 0,
      validatorRejected: 0,
      configDisabled: 0,
      skipped: 0,
      skippedByReason: {},
      deferred: 0,
      deferredByReason: {},
    });
    expect(result.improve.consolidation.ran).toBe(false);
    expect(result.improve.memoryInference.yieldRate).toBe(0);
    expect(result.improve.graphExtraction.cacheHitRate).toBe(0);
    expect(result.improve.wallTime).toEqual({
      count: 0,
      medianMs: 0,
      p95Ms: 0,
      minMs: 0,
      maxMs: 0,
      byPhase: {
        consolidation: { count: 0, totalMs: 0, medianMs: 0, p95Ms: 0 },
        memoryInference: { count: 0, totalMs: 0, medianMs: 0, p95Ms: 0 },
        graphExtraction: { count: 0, totalMs: 0, medianMs: 0, p95Ms: 0 },
      },
    });
  });

  test("derives task and log metrics from task_history", () => {
    const logDir = makeTempDir("akm-health-logs-");
    const okLog = path.join(logDir, "ok.log");
    fs.writeFileSync(okLog, "ok\n", "utf8");
    const db = openDb();
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

    const result = health({ since: "7d" });

    expect(result.metrics.taskFailRate).toBe(0.5);
    expect(result.metrics.agentFailureRate).toBe(0.5);
    expect(result.metrics.logBackingRate).toBe(0.5);
    expect(result.hardChecks.some((check) => check.name === "task-log-backing" && check.status === "fail")).toBe(true);
  });

  test("now clock seam pins active-run staleness deterministically", () => {
    // An active row whose started_at is anchored to real now so it falls inside
    // the (un-seamed) `since` query window, while the pinned read clock drives
    // the ACTIVE_RUN_WARN_MS (15min) staleness comparison deterministically.
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const db = openDb();
    try {
      upsertTaskHistory(db, {
        task_id: "active-task",
        status: "active",
        started_at: startedAt,
        completed_at: null,
        failed_at: null,
        log_path: null,
        target_kind: "prompt",
        target_ref: null,
        metadata_json: JSON.stringify({ durationMs: 0, profile: "opencode" }),
      });
    } finally {
      db.close();
    }

    // Pin the read clock 5 minutes after start (< 15min warn threshold). With
    // the real wall-clock this row would already read as stuck; the pinned
    // clock proves the seam — not Date.now() — drives the staleness comparison.
    // Stub the session-log scan: this test asserts the clock seam against
    // task_history rows, not real on-disk session logs. Without the stub the
    // `since: "30d"` window makes getExecutionLogCandidates scan ~30 days of
    // the host's real harness logs (multi-second, machine-dependent) and the
    // test blows the default 5s timeout — unrelated to what it verifies.
    const result = health({
      since: "30d",
      now: () => startedAtMs + 5 * 60 * 1000,
      getExecutionLogCandidatesFn: () => [],
    });
    expect(result.metrics.stuckActiveRuns).toBe(0);
  });

  test("omitting now defaults to real wall-clock (additive seam)", () => {
    // A row started ~20min before real now must read as stuck without passing
    // `now`, proving the default path is identical to calling Date.now().
    const startedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const db = openDb();
    try {
      upsertTaskHistory(db, {
        task_id: "active-task-default",
        status: "active",
        started_at: startedAt,
        completed_at: null,
        failed_at: null,
        log_path: null,
        target_kind: "prompt",
        target_ref: null,
        metadata_json: JSON.stringify({ durationMs: 0, profile: "opencode" }),
      });
    } finally {
      db.close();
    }

    // Same rationale as above: stub the real session-log scan so the wide
    // `since: "30d"` window does not scan the host's logs and time out. The
    // default `now` path (omitted here) is still exercised against the DB row.
    const result = health({ since: "30d", getExecutionLogCandidatesFn: () => [] });
    expect(result.metrics.stuckActiveRuns).toBe(1);
  });

  test("passes requested since window through to session log candidates", () => {
    const seen: number[] = [];
    const getExecutionLogCandidatesFn = (sinceDays = 7): SessionLogEntry[] => {
      seen.push(sinceDays);
      return [];
    };

    health({ since: "12h", getExecutionLogCandidatesFn });

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

    const result = health({ since: "7d", getExecutionLogCandidatesFn });

    // session-log-failures is informational only (never warns) as of v0.8.1 —
    // it reports raw keyword matches, not LLM-validated extraction outcomes.
    // The overall status must still be pass (heuristic advisories don't degrade).
    expect(result.status).toBe("pass");
    expect(result.advisories.some((check) => check.name === "session-log-failures" && check.status === "pass")).toBe(
      true,
    );
  });

  // Regression guard for the 2026-05-25 yield-rate inflation: as the
  // memory-inference cache warmed, `considered` grew (cache hits still
  // count toward considered) while fresh LLM calls — and therefore
  // `writtenFacts` — stayed flat. The legacy formula
  // `written / considered` collapsed toward 0 and looked like a
  // regression even though per-attempt productivity was unchanged. New
  // formula divides by `freshAttempts = considered - cacheHits` so the
  // rate reflects the rate model output succeeded for the calls that
  // actually hit the LLM, independent of cache state.
  test("memoryInference.yieldRate uses freshAttempts (considered - cacheHits), not considered", () => {
    const start = new Date(Date.now() - 60_000).toISOString();
    const end = new Date(Date.now() - 30_000).toISOString();
    const db = openDb();
    try {
      recordImproveRun(db, {
        id: "run-cache-heavy",
        startedAt: start,
        completedAt: end,
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
          // 20 considered, 18 absorbed by cache, 2 fresh LLM calls, 1 produced
          // a write. Legacy formula would report yield = 1/20 = 5%. New formula:
          // freshAttempts = 20 - 18 = 2; yield = 1/2 = 50%.
          memoryInference: {
            considered: 20,
            cacheHits: 18,
            splitParents: 1,
            writtenFacts: 1,
            skippedNoFacts: 1,
          },
        }),
      });
    } finally {
      db.close();
    }

    const result = health({ since: "7d" });
    expect(result.improve.memoryInference.considered).toBe(20);
    expect(result.improve.memoryInference.cacheHits).toBe(18);
    expect(result.improve.memoryInference.freshAttempts).toBe(2);
    expect(result.improve.memoryInference.written).toBe(1);
    expect(result.improve.memoryInference.yieldRate).toBe(0.5);
  });
});

// ── Folded from tests/health-command-window.test.ts ──────────────────────────
describe("health — window comparison", () => {
  // ── Phase 2: --group-by run ────────────────────────────────────────────────
  describe("akm health --group-by run", () => {
    function seedTwoRuns(): { startA: string; endA: string; startB: string; endB: string } {
      const startA = new Date(Date.now() - 60_000).toISOString();
      const endA = new Date(Date.now() - 30_000).toISOString();
      const startB = new Date(Date.now() - 25_000).toISOString();
      const endB = new Date(Date.now() - 10_000).toISOString();
      const db = openDb();
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
      const result = health({ since: "7d" });
      expect(result.runs).toBeUndefined();
    });

    test("--group-by run returns runs[] with the right shape", () => {
      seedTwoRuns();
      const result = health({ since: "7d", groupBy: "run" });
      expect(result.runs).toBeDefined();
      expect(result.runs?.length).toBe(2);
      const ids = result.runs?.map((r) => r.id) ?? [];
      expect(ids).toContain("run-a");
      expect(ids).toContain("run-b");
    });

    test("--group-by run rows are ordered newest first", () => {
      const { startA, startB } = seedTwoRuns();
      expect(new Date(startB).getTime()).toBeGreaterThan(new Date(startA).getTime());
      const result = health({ since: "7d", groupBy: "run" });
      expect(result.runs?.[0].id).toBe("run-b");
      expect(result.runs?.[1].id).toBe("run-a");
    });

    test("per-run summary fields parity with window aggregator (one row)", () => {
      // Seed a single run, then compare aggregator output vs runs[0].
      const startA = new Date(Date.now() - 60_000).toISOString();
      const endA = new Date(Date.now() - 30_000).toISOString();
      const db = openDb();
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
      const aggregate = health({ since: "7d" });
      const perRun = health({ since: "7d", groupBy: "run" });
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

    test("invalid --group-by value raises UsageError", () => {
      expect(() => health({ since: "7d", groupBy: "bogus" as unknown as "run" })).toThrow(
        /Invalid value for --group-by/,
      );
    });
  });

  // ── Phase 3: window-compare ────────────────────────────────────────────────
  describe("akm health --window-compare / --windows", () => {
    test("--window-compare 1h returns two windows named current and prior", () => {
      const result = health({ windowCompare: "1h" });
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
      const result = health({
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

      const db = openDb();
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

      const result = health({
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

      const db = openDb();
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
      const result = health({
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

      const db = openDb();
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

      const result = health({
        windows: [
          { name: "early", since: earlySince, until: new Date(now - 3 * 60 * 60 * 1000).toISOString() },
          { name: "late", since: new Date(now - 3 * 60 * 60 * 1000).toISOString() },
        ],
      });
      expect(result.deltas?.["improve.actions.distill.llmFailed"]?.pctChange).toBe("+inf");
    });

    test("mutually exclusive flags throw UsageError", () => {
      expect(() =>
        health({
          windowCompare: "1h",
          windows: [{ name: "x", since: new Date().toISOString() }],
        }),
      ).toThrow(/mutually exclusive/);
    });

    test("duplicate window names throw UsageError", () => {
      expect(() =>
        health({
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
        health({
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
      expect(() => health({ windowCompare: "not-a-duration" })).toThrow();
    });
  });
});

// ── Folded from tests/commands/health-distill-skipped-by-reason.test.ts ───────
//
// Health aggregator contract: `distill.skipped` is sub-bucketed by reason.
//
// Mirrors the existing `reflect.skippedByReason` histogram (commit `b3c2328`).
// Pre-2026-05-27, `mode === "distill-skipped"` actions were collapsed into a
// single counter even though improve.ts emits 7+ distinct reasons. On
// release/0.8.0 that meant 62 539 events over 7d had no sub-reason visibility
// — see `/tmp/akm-health-investigations/planner-profile-metrics-deep-analysis.md` §3.
//
// Backwards-compat: the scalar `distill.skipped` remains. The new
// `distill.skippedByReason` is additive; sum of its values MUST equal
// `distill.skipped`.
describe("health — distill skipReasons", () => {
  function insertImproveRun(result: Record<string, unknown>, tsIso: string): void {
    const db = openDb();
    try {
      recordImproveRun(db, {
        id: `run-${Math.random().toString(36).slice(2, 10)}`,
        startedAt: tsIso,
        completedAt: tsIso,
        stashDir: "/tmp/distill-skipreason-stash",
        dryRun: false,
        profile: null,
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: true,
        result: result as unknown as AkmImproveResult,
      });
    } finally {
      db.close();
    }
  }

  describe("akmHealth: distill.skippedByReason histogram", () => {
    test("collects sub-reasons from distill-skipped actions and totals match the scalar", () => {
      // Seed an improve_completed event so the run window is non-empty.
      const tsIso = new Date(Date.now() - 60_000).toISOString();
      emit({ eventType: "improve_completed", metadata: {} });

      insertImproveRun(
        {
          schemaVersion: 1,
          ok: true,
          plannedRefs: [],
          actions: [
            {
              ref: "memory:a",
              mode: "distill-skipped",
              result: { ok: true, reason: "no new signal since last proposal" },
            },
            {
              ref: "memory:b",
              mode: "distill-skipped",
              result: { ok: true, reason: "no new signal since last proposal" },
            },
            { ref: "memory:c", mode: "distill-skipped", result: { ok: true, reason: "pending proposal exists" } },
            { ref: "memory:d", mode: "distill-skipped", result: { ok: true, reason: "type-filter" } },
            {
              ref: "memory:e",
              mode: "distill-skipped",
              result: { ok: true, reason: "derived-memory-reflect-skipped" },
            },
            { ref: "memory:f", mode: "distill-skipped", result: { ok: true } }, // missing reason
          ],
        },
        tsIso,
      );

      const result = health({ since: "7d" });
      expect(result.improve.actions.distill.skipped).toBe(6);
      expect(result.improve.actions.distill.skippedByReason).toEqual({
        "no new signal since last proposal": 2,
        "pending proposal exists": 1,
        "type-filter": 1,
        "derived-memory-reflect-skipped": 1,
        unknown: 1,
      });
      // Invariant: sum of histogram == scalar.
      const sum = Object.values(result.improve.actions.distill.skippedByReason).reduce((a, b) => a + b, 0);
      expect(sum).toBe(result.improve.actions.distill.skipped);
    });

    test("scalar `distill.skipped` is preserved (backwards-compat)", () => {
      const tsIso = new Date(Date.now() - 60_000).toISOString();
      emit({ eventType: "improve_completed", metadata: {} });
      insertImproveRun(
        {
          schemaVersion: 1,
          ok: true,
          plannedRefs: [],
          actions: [{ ref: "memory:x", mode: "distill-skipped", result: { ok: true, reason: "distill signal-delta" } }],
        },
        tsIso,
      );

      const result = health({ since: "7d" });
      expect(result.improve.actions.distill.skipped).toBe(1);
    });
  });
});

// The CHANGELOG advertises `akm health` as a runtime/CI monitoring command:
// callers chain `akm health && deploy`, which requires non-zero exit on a hard
// failure (and a parseable JSON envelope on stdout for diagnostics). These
// tests drive the real CLI (in-process, via runCliCapture) so the exit code is
// observable, then assert that (a) stdout is still valid JSON and (b) the exit
// code matches the `status` discriminant in the envelope.
//
// Migrated from spawnSync("bun", [cli, ...]) to the in-process harness. The
// harness reads state.db from the XDG_* dirs in process.env at call time
// (state-db opens fresh per call), so the per-test dirs are pinned onto
// process.env (over the fresh dirs the beforeEach already installs) before both
// the seeding and the in-process run. afterEach restores the saved env.
describe("akm health CLI exit code", () => {
  test("exits 0 when health passes (no failing checks)", async () => {
    process.env.HOME = makeTempDir("akm-health-home-cli-");
    process.env.XDG_CACHE_HOME = makeTempDir("akm-health-cache-cli-");
    process.env.XDG_CONFIG_HOME = makeTempDir("akm-health-config-cli-");
    process.env.XDG_DATA_HOME = makeTempDir("akm-health-data-cli-");
    process.env.XDG_STATE_HOME = makeTempDir("akm-health-state-cli-");
    repinDataContext();

    const { stdout, code } = await runCliCapture(["health", "--format", "json"]);
    // stdout must be valid JSON regardless of exit code so monitors can parse.
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("pass");
    expect(code).toBe(0);
  });

  test("exits non-zero (1) when status is 'fail' due to missing task log", async () => {
    process.env.HOME = makeTempDir("akm-health-home-cli-fail-");
    process.env.XDG_CACHE_HOME = makeTempDir("akm-health-cache-cli-fail-");
    process.env.XDG_CONFIG_HOME = makeTempDir("akm-health-config-cli-fail-");
    process.env.XDG_DATA_HOME = makeTempDir("akm-health-data-cli-fail-");
    process.env.XDG_STATE_HOME = makeTempDir("akm-health-state-cli-fail-");
    repinDataContext();

    // Seed state.db with a task_history row that references a log_path that
    // does NOT exist on disk. That forces the deterministic `task-log-backing`
    // hardCheck to fail, which sets overall status="fail".
    const db = openDb();
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

    const { stdout, code } = await runCliCapture(["health", "--format", "json"]);
    // Exit code must propagate AFTER JSON is flushed, so stdout is still
    // parseable JSON for monitoring scripts.
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe("fail");
    expect(code).toBe(1);
  });
});

// ── WS2: --group-by run (replaces --detail per-run) ──────────────────────────
describe("akm health --group-by run", () => {
  function pinHealthEnv(label: string): void {
    process.env.HOME = makeTempDir(`akm-health-home-${label}-`);
    process.env.XDG_CACHE_HOME = makeTempDir(`akm-health-cache-${label}-`);
    process.env.XDG_CONFIG_HOME = makeTempDir(`akm-health-config-${label}-`);
    process.env.XDG_DATA_HOME = makeTempDir(`akm-health-data-${label}-`);
    process.env.XDG_STATE_HOME = makeTempDir(`akm-health-state-${label}-`);
    repinDataContext();
  }

  test("--group-by run emits a runs[] section", async () => {
    pinHealthEnv("gbrun");
    const db = openDb();
    try {
      const startA = new Date(Date.now() - 60_000).toISOString();
      const endA = new Date(Date.now() - 30_000).toISOString();
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
        id: "run-gb",
        startedAt: startA,
        completedAt: endA,
        stashDir: "/tmp/stash",
        dryRun: false,
        profile: null,
        scopeMode: "all",
        scopeValue: null,
        guidance: null,
        ok: true,
        result: fixtureResult({ schemaVersion: 1, ok: true, scope: { mode: "all" }, dryRun: false, actions: [] }),
      });
    } finally {
      db.close();
    }
    const { stdout } = await runCliCapture(["health", "--since", "7d", "--group-by", "run", "--format", "json"]);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed.runs)).toBe(true);
    expect(parsed.runs.length).toBe(1);
  });
});
