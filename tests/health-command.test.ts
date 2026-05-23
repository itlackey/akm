import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmHealth, parseHealthSince } from "../src/commands/health";
import { appendEvent } from "../src/core/events";
import { openStateDatabase, upsertTaskHistory } from "../src/core/state-db";
import type { SessionLogEntry } from "../src/integrations/session-logs";

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
  test("reports deterministic improve metrics from improve_completed events", () => {
    const now = new Date().toISOString();
    appendEvent({ eventType: "improve_invoked", ref: "improve:all:all", metadata: { dryRun: false } });
    appendEvent({ eventType: "improve_skipped", ref: "memory:alpha", metadata: { reason: "reflect_cooldown" } });
    appendEvent({
      eventType: "improve_completed",
      ref: "improve:all:all",
      metadata: {
        completedAt: now,
        plannedRefs: 4,
        reflectActions: 2,
        distillActions: 1,
        distillSkippedActions: 1,
        memoryPruneActions: 1,
        memoryInferenceActions: 1,
        graphExtractionActions: 1,
        errorActions: 0,
        reflectsWithErrorContext: 3,
        coverageGapCount: 2,
        executionLogCandidateCount: 5,
        evalCasesWritten: 7,
        deadUrlCount: 1,
        memoryEligible: 6,
        memoryDerived: 2,
        memoryCleanupPruneCandidates: 3,
        memoryCleanupContradictionCandidates: 1,
        memoryCleanupBeliefStateTransitions: 2,
        memoryCleanupConsolidationCandidates: 4,
        memoryCleanupArchived: 2,
        memoryCleanupWarnings: 1,
        consolidationProcessed: 2,
        consolidationDurationMs: 120,
        memoryInferenceWrites: 5,
        memoryInferenceDurationMs: 80,
        graphExtractionExtractedFiles: 9,
        graphExtractionDurationMs: 40,
      },
    });

    const result = akmHealth({ since: "7d" });

    expect(result.improve.invoked).toBe(1);
    expect(result.improve.completed).toBe(1);
    expect(result.improve.skipped).toBe(1);
    expect(result.improve.skipReasons.reflect_cooldown).toBe(1);
    expect(result.improve.plannedRefs).toBe(4);
    expect(result.improve.actions.reflect).toBe(2);
    expect(result.improve.actions.distill).toBe(1);
    expect(result.improve.actions.distillSkipped).toBe(1);
    expect(result.improve.reflectsWithErrorContext).toBe(3);
    expect(result.improve.memorySummary).toEqual({ eligible: 6, derived: 2 });
    expect(result.improve.consolidation).toEqual({ ran: true, processed: 2, durationMs: 120 });
    expect(result.improve.memoryInference).toEqual({ ran: true, writes: 5, durationMs: 80 });
    expect(result.improve.graphExtraction).toEqual({ ran: true, extractedFiles: 9, durationMs: 40 });
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
