// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { shouldBypassConfigStartup } from "../../src/cli";
import { akmTasksRun } from "../../src/commands/tasks/tasks";
import { buildTaskRunId, openLogsDatabase, queryTaskLogs } from "../../src/core/logs-db";
import { createMigrationBackup } from "../../src/core/migration-backup";
import { openStateDatabase } from "../../src/core/state-db";
import {
  decodeTaskHistoryMetadata,
  finalizeTaskHistoryAttempt,
  getTaskHistoryRuns,
  reserveTaskHistoryAttempt,
} from "../../src/storage/repositories/task-history-repository";
import { readTaskHistory, runTask } from "../../src/tasks/runner";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage } from "../_helpers/sandbox";

const INVALID_TASK_ID = "_invalid-task-id";

let storage: IsolatedAkmStorage;
let tasksDir: string;
let logDir: string;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  tasksDir = path.join(storage.stashDir, "tasks");
  logDir = path.join(storage.cacheDir, "akm", "tasks", "logs");
  fs.mkdirSync(tasksDir, { recursive: true });
  createMigrationBackup();
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
    AKM_STASH_DIR: storage.stashDir,
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

function assertRecordedFailure(input: {
  taskId: string;
  reason: string;
  errorCode: string;
  forbidden?: readonly string[];
}): void {
  const stateDb = openStateDatabase();
  let row: ReturnType<typeof getTaskHistoryRuns>[number];
  try {
    const rows = getTaskHistoryRuns(stateDb, input.taskId);
    expect(rows).toHaveLength(1);
    row = rows[0]!;
  } finally {
    stateDb.close();
  }

  expect(row.status).toBe("failed");
  expect(row.completed_at).not.toBeNull();
  expect(row.failed_at).toBe(row.completed_at);
  expect(row.target_kind).toBeNull();
  expect(row.target_ref).toBeNull();
  expect(row.log_path).not.toBeNull();

  const metadata = decodeTaskHistoryMetadata(row.metadata_json);
  expect(metadata).toMatchObject({
    metadataVersion: 2,
    detail: { reason: input.reason, error: input.errorCode },
  });
  expect(metadata.durationMs).toBeGreaterThanOrEqual(0);

  const historyResult = readTaskHistory({ id: input.taskId });
  expect(historyResult).toHaveLength(1);
  expect(historyResult[0]!.status).toBe("failed");
  expect(historyResult[0]!.target).toEqual({ kind: "unknown" });

  if (row.log_path === null) throw new Error("expected a per-run log path");
  expect(fs.existsSync(row.log_path)).toBe(true);
  const fileLog = fs.readFileSync(row.log_path, "utf8");
  const expectedLine = `[akm tasks] status=failed reason=${input.reason} code=${input.errorCode}`;
  expect(fileLog).toBe(`${expectedLine}\n`);

  const logsDb = openLogsDatabase();
  let logRows: ReturnType<typeof queryTaskLogs>;
  try {
    logRows = queryTaskLogs(logsDb, { runId: buildTaskRunId(input.taskId, row.started_at) });
  } finally {
    logsDb.close();
  }
  expect(logRows).toHaveLength(1);
  expect(logRows[0]).toMatchObject({
    task_id: input.taskId,
    level: "error",
    line: expectedLine,
  });

  const durable = `${JSON.stringify(row)}\n${fileLog}\n${JSON.stringify(logRows)}`;
  for (const forbidden of input.forbidden ?? []) expect(durable).not.toContain(forbidden);
}

describe("tasks run attempt observability", () => {
  test("bypasses startup config only for tasks run with an id", () => {
    expect(shouldBypassConfigStartup(["bun", "cli.ts", "tasks", "run", "nightly"])).toBe(true);
    expect(
      shouldBypassConfigStartup(["bun", "cli.ts", "--format", "json", "task", "run", "nightly", "--scheduled"]),
    ).toBe(true);

    expect(shouldBypassConfigStartup(["bun", "cli.ts", "tasks", "run"])).toBe(false);
    expect(shouldBypassConfigStartup(["bun", "cli.ts", "tasks", "list"])).toBe(false);
    expect(shouldBypassConfigStartup(["bun", "cli.ts", "health"])).toBe(false);
  });

  for (const [label, config] of [
    ["malformed", '{"configVersion":'],
    ["unsupported", '{"configVersion":"0.8.0"}'],
  ] as const) {
    test(`runs a scheduled config-independent command with ${label} config`, async () => {
      writeRawConfig(config);
      writeTask(
        "configless-command",
        [
          "version: 2",
          'schedule: "@daily"',
          `command: ${JSON.stringify([process.execPath, "-e", 'process.stdout.write("configless-command-ok")'])}`,
          "enabled: true",
          "",
        ].join("\n"),
      );

      const result = await withEnv(capturedSchedulerContext(), () =>
        runCliCapture(["tasks", "run", "configless-command", "--scheduled"]),
      );

      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        result: { id: "configless-command", status: "completed", detail: { exitCode: 0 } },
        exitCode: 0,
      });
      expect(readTaskHistory({ id: "configless-command" })[0]).toMatchObject({
        status: "completed",
        target: { kind: "command" },
        detail: { exitCode: 0 },
      });
    });
  }

  test("records a prompt config failure and preserves malformed-config classification", async () => {
    writeRawConfig('{"configVersion":');
    writeTask("config-prompt", 'version: 2\nschedule: "@daily"\nprompt: Review the task\n');

    const result = await withEnv(capturedSchedulerContext(), () =>
      runCliCapture(["tasks", "run", "config-prompt", "--scheduled"]),
    );

    expect(result.code).toBe(78);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, code: "INVALID_CONFIG_FILE" });
    assertRecordedFailure({
      taskId: "config-prompt",
      reason: "task_dispatch_failed",
      errorCode: "INVALID_CONFIG_FILE",
    });
  });

  test("records a workflow config failure and preserves unsupported-config classification", async () => {
    writeRawConfig('{"configVersion":"0.8.0"}');
    writeTask("config-workflow", 'version: 2\nschedule: "@daily"\nworkflow: workflows/config-dependent\n');

    const result = await withEnv(capturedSchedulerContext(), () =>
      runCliCapture(["tasks", "run", "config-workflow", "--scheduled"]),
    );

    expect(result.code).toBe(78);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, code: "UNSUPPORTED_CONFIG_VERSION" });
    assertRecordedFailure({
      taskId: "config-workflow",
      reason: "task_dispatch_failed",
      errorCode: "UNSUPPORTED_CONFIG_VERSION",
    });
  });

  test("records a config-dependent command failure and preserves its config exit", async () => {
    writeRawConfig('{"configVersion":"0.8.0"}');
    writeTask("config-command", 'version: 2\nschedule: "@daily"\ncommand: akm health\n');

    const result = await withEnv(capturedSchedulerContext(), () => akmTasksRun("config-command", { scheduled: true }));

    expect(result).toMatchObject({
      result: { id: "config-command", status: "failed", detail: { exitCode: 78 } },
      exitCode: 78,
    });
    expect(readTaskHistory({ id: "config-command" })[0]).toMatchObject({
      status: "failed",
      target: { kind: "command" },
      detail: { exitCode: 78 },
    });
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
      expect(decodeTaskHistoryMetadata(row!.metadata_json)).toMatchObject({
        durationMs: 60_000,
        detail: { exitCode: 0 },
      });
    } finally {
      stateDb.close();
    }
  });

  test("allocates distinct join identities for same-task attempts in the same millisecond", async () => {
    const instant = new Date("2026-07-13T12:00:00.123Z");

    const attempts = await Promise.allSettled([
      runTask("same-millisecond", { stashDir: storage.stashDir, logDir, now: () => instant }),
      runTask("same-millisecond", { stashDir: storage.stashDir, logDir, now: () => instant }),
    ]);

    expect(attempts.map((attempt) => attempt.status)).toEqual(["rejected", "rejected"]);
    const stateDb = openStateDatabase();
    let rows: ReturnType<typeof getTaskHistoryRuns>;
    try {
      rows = getTaskHistoryRuns(stateDb, "same-millisecond");
    } finally {
      stateDb.close();
    }
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.started_at)).size).toBe(2);
    expect(new Set(rows.map((row) => row.log_path)).size).toBe(2);

    const expectedRunIds = new Set(rows.map((row) => buildTaskRunId(row.task_id, row.started_at)));
    const logsDb = openLogsDatabase();
    try {
      const logRows = queryTaskLogs(logsDb, { taskId: "same-millisecond" });
      expect(new Set(logRows.map((row) => row.run_id))).toEqual(expectedRunIds);
    } finally {
      logsDb.close();
    }
  });

  test("allocates distinct join identities for invalid-id sentinel attempts in the same millisecond", async () => {
    const instant = new Date("2026-07-13T12:00:00.456Z");

    const attempts = await Promise.allSettled([
      runTask("../first-hostile-id", { stashDir: storage.stashDir, logDir, now: () => instant }),
      runTask("../second-hostile-id", { stashDir: storage.stashDir, logDir, now: () => instant }),
    ]);

    expect(attempts.map((attempt) => attempt.status)).toEqual(["rejected", "rejected"]);
    const stateDb = openStateDatabase();
    let rows: ReturnType<typeof getTaskHistoryRuns>;
    try {
      rows = getTaskHistoryRuns(stateDb, INVALID_TASK_ID);
    } finally {
      stateDb.close();
    }
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.started_at)).size).toBe(2);

    const expectedRunIds = new Set(rows.map((row) => buildTaskRunId(row.task_id, row.started_at)));
    const logsDb = openLogsDatabase();
    try {
      const logRows = queryTaskLogs(logsDb, { taskId: INVALID_TASK_ID });
      expect(new Set(logRows.map((row) => row.run_id))).toEqual(expectedRunIds);
    } finally {
      logsDb.close();
    }
  });

  test("keeps successful execution successful when the transitional log path is unwritable", async () => {
    writeTask("best-effort-log", 'version: 2\nschedule: "@daily"\nworkflow: workflows/noop\n');
    const blockedLogDir = path.join(storage.root, "blocked-log-dir");
    fs.writeFileSync(blockedLogDir, "not a directory");

    const result = await runTask("best-effort-log", {
      stashDir: storage.stashDir,
      logDir: blockedLogDir,
      now: () => new Date("2026-07-13T12:00:01.000Z"),
      startWorkflowRunImpl: async (ref, params = {}) => ({
        run: {
          id: "workflow-run",
          workflowRef: ref,
          workflowTitle: "Noop",
          status: "completed",
          params,
          createdAt: "2026-07-13T12:00:01.000Z",
          updatedAt: "2026-07-13T12:00:01.000Z",
          completedAt: "2026-07-13T12:00:01.000Z",
          currentStepId: null,
        },
        workflow: { ref, title: "Noop", steps: [] },
      }),
    });

    expect(result.status).toBe("completed");
    expect(readTaskHistory({ id: "best-effort-log" })[0]?.status).toBe("completed");
    const logsDb = openLogsDatabase();
    try {
      expect(queryTaskLogs(logsDb, { runId: buildTaskRunId(result.id, result.startedAt) }).length).toBeGreaterThan(0);
    } finally {
      logsDb.close();
    }
  });

  test("rethrows TEST_ISOLATION_MISSING from best-effort persistence", async () => {
    const thrown = await withEnv({ AKM_DATA_DIR: undefined, XDG_DATA_HOME: undefined }, () =>
      captureThrown(() => runTask("missing-original-error", { stashDir: storage.stashDir, logDir })),
    );

    expect(thrown).toMatchObject({ code: "TEST_ISOLATION_MISSING" });
  });

  test("keeps JSON CLI errors intact when all durable recording paths are unavailable", async () => {
    const blockedDataDir = path.join(storage.root, "blocked-data-dir");
    fs.writeFileSync(blockedDataDir, "not a directory");
    const result = await withEnv({ AKM_DATA_DIR: blockedDataDir }, () =>
      runCliCapture(["--json", "tasks", "run", "missing-json-error"]),
    );

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, code: "ASSET_NOT_FOUND" });
  });

  test("records a missing task file and preserves the not-found error", async () => {
    const result = await runCliCapture(["--json", "tasks", "run", "missing-task"]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, code: "ASSET_NOT_FOUND" });
    assertRecordedFailure({
      taskId: "missing-task",
      reason: "task_load_failed",
      errorCode: "ASSET_NOT_FOUND",
    });
  });

  test("records invalid YAML without persisting its source excerpt", async () => {
    const secret = "INVALID-YAML-SECRET-SENTINEL";
    writeTask("invalid-yaml", `version: 2\ncommand: [${secret}\n`);

    const result = await runCliCapture(["--json", "tasks", "run", "invalid-yaml"]);

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, code: "INVALID_FLAG_VALUE" });
    assertRecordedFailure({
      taskId: "invalid-yaml",
      reason: "task_parse_failed",
      errorCode: "INVALID_FLAG_VALUE",
      forbidden: [secret],
    });
  });

  test("records an unsupported future schema without normalizing it", async () => {
    writeTask("future-task", 'version: 99\nschedule: "@daily"\ncommand: echo future\n');

    const result = await runCliCapture(["--json", "tasks", "run", "future-task"]);

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, code: "TASK_SCHEMA_VERSION_UNSUPPORTED" });
    assertRecordedFailure({
      taskId: "future-task",
      reason: "task_parse_failed",
      errorCode: "TASK_SCHEMA_VERSION_UNSUPPORTED",
    });
  });

  test("records a thrown dispatch error without persisting prompt text or the error message", async () => {
    const promptSecret = "PROMPT-SECRET-SENTINEL";
    const errorSecret = "DISPATCH-ERROR-SECRET-SENTINEL";
    writeTask("dispatch-throws", `version: 2\nschedule: "@daily"\nprompt: ${promptSecret}\nengine: opencode\n`);
    fs.writeFileSync(
      path.join(storage.configDir, "akm", "config.json"),
      JSON.stringify({
        configVersion: "0.9.0",
        engines: { opencode: { kind: "agent", platform: "opencode" } },
        defaults: { engine: "opencode" },
      }),
    );
    const dispatchError = new Error(errorSecret);

    const thrown = await captureThrown(() =>
      runTask("dispatch-throws", {
        stashDir: storage.stashDir,
        logDir,
        runAgentImpl: async () => {
          throw dispatchError;
        },
      }),
    );

    expect(thrown).toBe(dispatchError);
    assertRecordedFailure({
      taskId: "dispatch-throws",
      reason: "task_dispatch_failed",
      errorCode: "INTERNAL",
      forbidden: [promptSecret, errorSecret],
    });
  });

  test("records a classified pre-dispatch failure without persisting the target ref", async () => {
    const targetSecret = "agents/PRE-DISPATCH-TARGET-SECRET";
    writeTask("wrong-workflow-ref", `version: 2\nschedule: "@daily"\nworkflow: ${targetSecret}\n`);

    const result = await runCliCapture(["--json", "tasks", "run", "wrong-workflow-ref"]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, code: "WORKFLOW_NOT_FOUND" });
    assertRecordedFailure({
      taskId: "wrong-workflow-ref",
      reason: "task_dispatch_failed",
      errorCode: "WORKFLOW_NOT_FOUND",
      forbidden: [targetSecret, "PRE-DISPATCH-TARGET-SECRET"],
    });
  });

  test("records an invalid CLI id under a safe sentinel and preserves the usage exit", async () => {
    const hostileId = "../../HOSTILE-ID-SECRET-SENTINEL";

    const result = await runCliCapture(["--json", "tasks", "run", hostileId]);

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, code: "INVALID_FLAG_VALUE" });
    assertRecordedFailure({
      taskId: INVALID_TASK_ID,
      reason: "invalid_task_id",
      errorCode: "INVALID_FLAG_VALUE",
      forbidden: [hostileId, "HOSTILE-ID-SECRET-SENTINEL"],
    });
  });

  test("the low-level runner also sanitizes an invalid id before persistence", async () => {
    const hostileId = "../DIRECT-RUNNER-HOSTILE-ID";

    const thrown = await captureThrown(() => runTask(hostileId, { stashDir: storage.stashDir, logDir }));

    expect(thrown).toMatchObject({ code: "INVALID_FLAG_VALUE" });
    assertRecordedFailure({
      taskId: INVALID_TASK_ID,
      reason: "invalid_task_id",
      errorCode: "INVALID_FLAG_VALUE",
      forbidden: [hostileId, "DIRECT-RUNNER-HOSTILE-ID"],
    });
  });
});
