// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { shouldBypassConfigStartup } from "../../../src/cli";
import { buildTaskRunId, openLogsDatabase, queryTaskLogs } from "../../../src/core/logs-db";
import { openStateDatabase } from "../../../src/core/state-db";
import type { SpawnFn } from "../../../src/core/subprocess";
import {
  decodeTaskHistoryMetadata,
  finalizeTaskHistoryAttempt,
  getTaskHistoryRuns,
  reserveTaskHistoryAttempt,
} from "../../../src/storage/repositories/task-history-repository";
import { runTask } from "../../../src/tasks/run/run-task";
import { readTaskHistory } from "../../../src/tasks/run/task-history";
import { runCliCapture } from "../../_helpers/cli";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const INVALID_TASK_ID = "_invalid-task-id";

let storage: IsolatedAkmStorage;
let tasksDir: string;
let logDir: string;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  tasksDir = path.join(storage.stashDir, "tasks");
  logDir = path.join(storage.cacheDir, "akm", "tasks", "logs");
  fs.mkdirSync(tasksDir, { recursive: true });
});

afterEach(() => {
  storage.cleanup();
});

function writeTask(id: string, yaml: string): void {
  fs.writeFileSync(path.join(tasksDir, `${id}.yml`), yaml, "utf8");
}

function writeRawConfig(contents: string): void {
  fs.writeFileSync(path.join(storage.configDir, "akm", "config.json"), contents, "utf8");
}

function capturedSchedulerContext(): Record<string, string> {
  return {
    AKM_BUNDLE_DIR: storage.stashDir,
    AKM_CONFIG_DIR: path.join(storage.configDir, "akm"),
    AKM_DATA_DIR: path.join(storage.dataDir, "akm"),
    AKM_CACHE_DIR: path.join(storage.cacheDir, "akm"),
    AKM_STATE_DIR: path.join(storage.stateDir, "akm"),
  };
}

async function captureThrown(run: () => Promise<unknown>): Promise<unknown> {
  let thrown: unknown;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeDefined();
  return thrown;
}

function assertNoAttempt(taskId: string): void {
  const stateDb = openStateDatabase();
  try {
    expect(getTaskHistoryRuns(stateDb, taskId)).toEqual([]);
  } finally {
    stateDb.close();
  }
  expect(readTaskHistory({ id: taskId })).toEqual([]);

  const logsDb = openLogsDatabase();
  try {
    expect(queryTaskLogs(logsDb, { taskId })).toEqual([]);
  } finally {
    logsDb.close();
  }
  expect(fs.existsSync(path.join(logDir, taskId))).toBe(false);
}

function assertRecordedDispatchFailure(input: {
  taskId: string;
  forbidden?: readonly string[];
  expectedAttempts?: number;
}): void {
  const stateDb = openStateDatabase();
  let rows: ReturnType<typeof getTaskHistoryRuns>;
  try {
    rows = getTaskHistoryRuns(stateDb, input.taskId);
  } finally {
    stateDb.close();
  }
  expect(rows).toHaveLength(input.expectedAttempts ?? 1);
  for (const row of rows) {
    expect(row).toMatchObject({ status: "failed", failed_at: row.completed_at });
    expect(decodeTaskHistoryMetadata(row.metadata_json)).toMatchObject({
      metadataVersion: 2,
      detail: { reason: "task_dispatch_failed", error: "INTERNAL" },
    });
    if (row.log_path === null) throw new Error("expected a post-dispatch log path");
    const fileLog = fs.readFileSync(row.log_path, "utf8");
    expect(fileLog).toContain("reason=task_dispatch_failed code=INTERNAL");
    for (const forbidden of input.forbidden ?? []) {
      expect(`${JSON.stringify(row)}\n${fileLog}`).not.toContain(forbidden);
    }
  }
}

const successfulSpawn: SpawnFn = () => ({
  exitCode: 0,
  exited: Promise.resolve(0),
  stdout: null,
  stderr: null,
  kill() {},
});

describe("tasks run attempt observability", () => {
  test("bypasses startup config only for task run with an id", () => {
    expect(shouldBypassConfigStartup(["bun", "cli.ts", "task", "run", "nightly"])).toBe(true);
    expect(
      shouldBypassConfigStartup(["bun", "cli.ts", "--format", "json", "task", "run", "nightly", "--scheduled"]),
    ).toBe(true);
    expect(shouldBypassConfigStartup(["bun", "cli.ts", "task", "run", "--format", "md", "nightly"])).toBe(true);
    expect(shouldBypassConfigStartup(["bun", "cli.ts", "task", "run"])).toBe(false);
    expect(shouldBypassConfigStartup(["bun", "cli.ts", "task", "list"])).toBe(false);
  });

  for (const [label, config, code] of [
    ["malformed", '{"configVersion":', "INVALID_CONFIG_FILE"],
    ["schema-invalid", '{"configVersion":"0.9.0","bundles":{"primary":{"path":42}}}', "INVALID_CONFIG_FILE"],
  ] as const) {
    test(`${label} config fails before task-history or log mutation`, async () => {
      writeRawConfig(config);
      writeTask("config-preflight", "version: 4\nrun: echo safe\n");

      const result = await withEnv(capturedSchedulerContext(), () =>
        runCliCapture(["task", "run", "config-preflight", "--scheduled"]),
      );

      expect(result.code).toBe(78);
      expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, code });
      assertNoAttempt("config-preflight");
    });
  }

  test("v2, malformed, future, unresolved, and missing sources create no attempts", async () => {
    writeTask("legacy", "version: 2\nschedule: '@daily'\ncommand: echo legacy\n");
    writeTask("malformed", "version: 4\nrun: [unterminated\n");
    writeTask("future", "version: 99\nrun: echo future\n");
    writeTask("unresolved", "version: 4\nuses: scripts/does-not-exist\n");

    // Exit code + envelope `code` per case, ground-truthed by probing the
    // actual CLI output before pinning:
    //   - legacy/future: TASK_SCHEMA_VERSION_UNSUPPORTED (usage, exit 2)
    //   - malformed: TASK_SOURCE_INVALID (usage, exit 2)
    //   - unresolved/missing: ASSET_NOT_FOUND (not-found, exit 1)
    const cases = [
      { taskId: "legacy", status: 2, code: "TASK_SCHEMA_VERSION_UNSUPPORTED" },
      { taskId: "malformed", status: 2, code: "TASK_SOURCE_INVALID" },
      { taskId: "future", status: 2, code: "TASK_SCHEMA_VERSION_UNSUPPORTED" },
      { taskId: "unresolved", status: 1, code: "ASSET_NOT_FOUND" },
      { taskId: "missing", status: 1, code: "ASSET_NOT_FOUND" },
    ] as const;
    for (const { taskId, status, code } of cases) {
      const result = await runCliCapture(["task", "run", taskId]);
      expect(result.code).toBe(status);
      expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, code });
      assertNoAttempt(taskId);
    }
  });

  test("invalid ids are rejected without even a sentinel attempt", async () => {
    const hostileId = "../../HOSTILE-ID-SECRET-SENTINEL";
    const result = await runCliCapture(["task", "run", hostileId]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, code: "INVALID_FLAG_VALUE" });
    assertNoAttempt(INVALID_TASK_ID);

    const thrown = await captureThrown(() => runTask("../DIRECT-RUNNER-HOSTILE-ID", { bundleDir: storage.stashDir }));
    expect(thrown).toMatchObject({ code: "INVALID_FLAG_VALUE" });
    assertNoAttempt(INVALID_TASK_ID);
  });

  test("only the first finalizer can replace an active reservation", () => {
    const startedAt = "2026-07-13T11:59:00.000Z";
    const firstCompletedAt = "2026-07-13T12:00:00.000Z";
    const secondCompletedAt = "2026-07-13T12:01:00.000Z";
    const stateDb = openStateDatabase();
    try {
      expect(
        reserveTaskHistoryAttempt(stateDb, {
          task_id: "single-finalizer",
          status: "active",
          started_at: startedAt,
          completed_at: null,
          failed_at: null,
          log_path: null,
          target_kind: null,
          target_ref: null,
          metadata_json: JSON.stringify({ metadataVersion: 2, durationMs: 0, detail: null }),
        }),
      ).toBe(true);
      expect(
        finalizeTaskHistoryAttempt(stateDb, {
          task_id: "single-finalizer",
          status: "completed",
          started_at: startedAt,
          completed_at: firstCompletedAt,
          failed_at: null,
          log_path: "/first.log",
          target_kind: "command",
          target_ref: null,
          metadata_json: JSON.stringify({ metadataVersion: 2, durationMs: 60_000, detail: { exitCode: 0 } }),
        }),
      ).toBe(true);
      expect(
        finalizeTaskHistoryAttempt(stateDb, {
          task_id: "single-finalizer",
          status: "failed",
          started_at: startedAt,
          completed_at: secondCompletedAt,
          failed_at: secondCompletedAt,
          log_path: "/second.log",
          target_kind: "command",
          target_ref: null,
          metadata_json: JSON.stringify({ metadataVersion: 2, durationMs: 120_000, detail: { exitCode: 1 } }),
        }),
      ).toBe(false);

      const [row] = getTaskHistoryRuns(stateDb, "single-finalizer");
      expect(row).toMatchObject({
        status: "completed",
        completed_at: firstCompletedAt,
        failed_at: null,
        log_path: "/first.log",
      });
    } finally {
      stateDb.close();
    }
  });

  test("post-dispatch failures reserve distinct same-millisecond attempts", async () => {
    const instant = new Date("2026-07-13T12:00:00.123Z");
    const dispatchError = new Error("native dispatch failed");
    writeTask("same-millisecond", "version: 4\nrun: echo dispatch\n");
    const spawnFn: SpawnFn = () => {
      throw dispatchError;
    };

    const attempts = await Promise.allSettled([
      runTask("same-millisecond", { bundleDir: storage.stashDir, logDir, now: () => instant, spawnFn }),
      runTask("same-millisecond", { bundleDir: storage.stashDir, logDir, now: () => instant, spawnFn }),
    ]);

    expect(attempts.map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
    expect(attempts.map((attempt) => (attempt.status === "fulfilled" ? attempt.value.status : "rejected"))).toEqual([
      "failed",
      "failed",
    ]);

    const stateDb = openStateDatabase();
    let rows: ReturnType<typeof getTaskHistoryRuns>;
    try {
      rows = getTaskHistoryRuns(stateDb, "same-millisecond");
    } finally {
      stateDb.close();
    }
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe("failed");
      expect(decodeTaskHistoryMetadata(row.metadata_json)).toMatchObject({ detail: { exitCode: 1 } });
    }
    expect(new Set(rows.map(({ started_at }) => started_at)).size).toBe(2);
    const runIds = new Set(rows.map((row) => buildTaskRunId(row.task_id, row.started_at)));
    const logsDb = openLogsDatabase();
    try {
      expect(new Set(queryTaskLogs(logsDb, { taskId: "same-millisecond" }).map(({ run_id }) => run_id))).toEqual(
        runIds,
      );
    } finally {
      logsDb.close();
    }
  });

  test("a thrown prepared-command dispatch records one failure without source or error text", async () => {
    const promptSecret = "PROMPT-SECRET-SENTINEL";
    const errorSecret = "DISPATCH-ERROR-SECRET-SENTINEL";
    writeTask(
      "dispatch-throws",
      ["version: 4", "uses: akm/command", "with:", `  content: ${promptSecret}`, "engine: opencode"].join("\n"),
    );
    writeRawConfig(
      JSON.stringify({
        configVersion: "0.9.0",
        engines: { opencode: { kind: "agent", platform: "opencode" } },
        defaults: { engine: "opencode" },
      }),
    );
    const dispatchError = new Error(errorSecret);

    const thrown = await captureThrown(() =>
      runTask("dispatch-throws", {
        bundleDir: storage.stashDir,
        logDir,
        runAgentImpl: async () => {
          throw dispatchError;
        },
      }),
    );

    expect(thrown).toBe(dispatchError);
    assertRecordedDispatchFailure({ taskId: "dispatch-throws", forbidden: [promptSecret, errorSecret] });
  });

  test("successful dispatch stays successful when the transitional log path is unwritable", async () => {
    writeTask("best-effort-log", "version: 4\nrun: echo success\n");
    const blockedLogDir = path.join(storage.root, "blocked-log-dir");
    fs.writeFileSync(blockedLogDir, "not a directory");

    const result = await runTask("best-effort-log", {
      bundleDir: storage.stashDir,
      logDir: blockedLogDir,
      spawnFn: successfulSpawn,
    });

    expect(result.status).toBe("completed");
    expect(readTaskHistory({ id: "best-effort-log" })[0]?.status).toBe("completed");
  });

  test("JSON CLI preflight errors stay intact when durable paths are unavailable", async () => {
    const blockedDataDir = path.join(storage.root, "blocked-data-dir");
    fs.writeFileSync(blockedDataDir, "not a directory");
    const result = await withEnv({ AKM_DATA_DIR: blockedDataDir }, () =>
      runCliCapture(["task", "run", "missing-json-error"]),
    );

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, code: "ASSET_NOT_FOUND" });
  });
});
