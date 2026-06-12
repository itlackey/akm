/**
 * Tests for logs.db (#579) — the dedicated task/run log database.
 *
 * Validates:
 *   1. Migration 001 creates task_logs + indices on a fresh DB; re-open is a no-op.
 *   2. insertTaskLogLines round-trip: rows queryable by task_id, run_id, stream,
 *      and time window, in emission order.
 *   3. getLoggedRunIds bulk membership check.
 *   4. ATTACH cross-db join: failed task_history row → its log lines by run_id.
 *   5. purgeOldTaskLogs deletes only rows older than retentionDays and is
 *      disabled for non-positive values.
 *
 * Each test runs inside an isolated storage root so `openLogsDatabase()` /
 * `openStateDatabase()` never touch the developer's real databases.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  attachStateDatabase,
  buildTaskRunId,
  getLoggedRunIds,
  getLogsDbPath,
  insertTaskLogLines,
  openLogsDatabase,
  openLogsDatabaseWithState,
  purgeOldTaskLogs,
  queryFailedRunLogLines,
  queryTaskLogs,
} from "../src/core/logs-db";
import { openStateDatabase, upsertTaskHistory } from "../src/core/state-db";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

function isoMinusDays(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

describe("openLogsDatabase", () => {
  test("creates logs.db in the data dir with the task_logs schema", () => {
    const db = openLogsDatabase();
    try {
      expect(fs.existsSync(getLogsDbPath())).toBe(true);
      expect(getLogsDbPath().startsWith(storage.dataDir)).toBe(true);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_logs'")
        .all() as Array<{ name: string }>;
      expect(tables).toHaveLength(1);
      const indices = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'task_logs' ORDER BY name")
        .all() as Array<{ name: string }>;
      const names = indices.map((row) => row.name);
      expect(names).toContain("idx_task_logs_ts");
      expect(names).toContain("idx_task_logs_task_id");
      expect(names).toContain("idx_task_logs_run_id");
    } finally {
      db.close();
    }
  });

  test("re-opening an already-migrated database is a no-op and keeps rows", () => {
    const ts = new Date().toISOString();
    const first = openLogsDatabase();
    try {
      insertTaskLogLines(first, { taskId: "t", runId: buildTaskRunId("t", ts), ts, lines: [{ line: "hello" }] });
    } finally {
      first.close();
    }
    const second = openLogsDatabase();
    try {
      expect(queryTaskLogs(second, { taskId: "t" })).toHaveLength(1);
    } finally {
      second.close();
    }
  });
});

describe("insertTaskLogLines / queryTaskLogs", () => {
  test("round-trip: rows queryable by task_id, run_id, and time window in emission order", () => {
    const startedAt = new Date().toISOString();
    const runId = buildTaskRunId("nightly", startedAt);
    const db = openLogsDatabase();
    try {
      const inserted = insertTaskLogLines(db, {
        taskId: "nightly",
        runId,
        ts: startedAt,
        lines: [
          { line: "[akm tasks] task=nightly kind=command cmd=echo hi" },
          { stream: "stdout", level: "info", line: "hi" },
          { stream: "stderr", level: "error", line: "boom" },
        ],
      });
      expect(inserted).toBe(3);
      // Another task's run must not leak into the filters below.
      insertTaskLogLines(db, {
        taskId: "other",
        runId: buildTaskRunId("other", startedAt),
        ts: startedAt,
        lines: [{ line: "unrelated" }],
      });

      const byTask = queryTaskLogs(db, { taskId: "nightly" });
      expect(byTask.map((row) => row.line)).toEqual([
        "[akm tasks] task=nightly kind=command cmd=echo hi",
        "hi",
        "boom",
      ]);
      expect(byTask[0].run_id).toBe(runId);
      expect(byTask[1].stream).toBe("stdout");
      expect(byTask[2].stream).toBe("stderr");
      expect(byTask[2].level).toBe("error");

      expect(queryTaskLogs(db, { runId })).toHaveLength(3);
      expect(queryTaskLogs(db, { runId, stream: "stderr" }).map((row) => row.line)).toEqual(["boom"]);
      expect(queryTaskLogs(db, { runId, limit: 1 }).map((row) => row.line)).toEqual([
        "[akm tasks] task=nightly kind=command cmd=echo hi",
      ]);

      // Time window: since is inclusive, until exclusive.
      expect(queryTaskLogs(db, { taskId: "nightly", since: startedAt })).toHaveLength(3);
      expect(queryTaskLogs(db, { taskId: "nightly", until: startedAt })).toHaveLength(0);
      expect(queryTaskLogs(db, { taskId: "nightly", since: isoMinusDays(1), until: isoMinusDays(0.5) })).toHaveLength(
        0,
      );
    } finally {
      db.close();
    }
  });

  test("empty line batch inserts nothing", () => {
    const db = openLogsDatabase();
    try {
      expect(insertTaskLogLines(db, { taskId: "t", runId: "t@x", ts: new Date().toISOString(), lines: [] })).toBe(0);
      expect(queryTaskLogs(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

describe("getLoggedRunIds", () => {
  test("returns only the run ids that have at least one log row", () => {
    const ts = new Date().toISOString();
    const db = openLogsDatabase();
    try {
      insertTaskLogLines(db, { taskId: "a", runId: "a@1", ts, lines: [{ line: "x" }] });
      insertTaskLogLines(db, { taskId: "b", runId: "b@1", ts, lines: [{ line: "y" }, { line: "z" }] });
      const logged = getLoggedRunIds(db, ["a@1", "b@1", "c@1"]);
      expect(logged).toEqual(new Set(["a@1", "b@1"]));
      expect(getLoggedRunIds(db, []).size).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("ATTACH cross-db join", () => {
  test("queryFailedRunLogLines joins a failed task_history row to its log lines by run_id", () => {
    const startedAt = new Date().toISOString();

    // Seed state.db with one failed and one completed run.
    const stateDb = openStateDatabase();
    try {
      upsertTaskHistory(stateDb, {
        task_id: "flaky",
        status: "failed",
        started_at: startedAt,
        completed_at: startedAt,
        failed_at: startedAt,
        log_path: null,
        target_kind: "prompt",
        target_ref: null,
        metadata_json: "{}",
      });
      upsertTaskHistory(stateDb, {
        task_id: "steady",
        status: "completed",
        started_at: startedAt,
        completed_at: startedAt,
        failed_at: null,
        log_path: null,
        target_kind: "prompt",
        target_ref: null,
        metadata_json: "{}",
      });
    } finally {
      stateDb.close();
    }

    // Seed logs.db with lines for both runs.
    const seedDb = openLogsDatabase();
    try {
      insertTaskLogLines(seedDb, {
        taskId: "flaky",
        runId: buildTaskRunId("flaky", startedAt),
        ts: startedAt,
        lines: [{ line: "starting" }, { stream: "stderr", level: "error", line: "exit_code=1" }],
      });
      insertTaskLogLines(seedDb, {
        taskId: "steady",
        runId: buildTaskRunId("steady", startedAt),
        ts: startedAt,
        lines: [{ line: "ok" }],
      });
    } finally {
      seedDb.close();
    }

    const joined = openLogsDatabaseWithState();
    try {
      const rows = queryFailedRunLogLines(joined);
      expect(rows.map((row) => row.line)).toEqual(["starting", "exit_code=1"]);
      expect(rows.every((row) => row.task_id === "flaky" && row.status === "failed")).toBe(true);
      expect(rows[0].run_id).toBe(buildTaskRunId("flaky", startedAt));

      // since filter excludes the run when the bound is after started_at.
      const future = new Date(Date.now() + 60_000).toISOString();
      expect(queryFailedRunLogLines(joined, { since: future })).toHaveLength(0);
      expect(queryFailedRunLogLines(joined, { limit: 1 }).map((row) => row.line)).toEqual(["starting"]);
    } finally {
      joined.close();
    }
  });

  test("attachStateDatabase throws (and does not create a file) when state.db is missing", () => {
    const db = openLogsDatabase();
    const bogus = path.join(storage.dataDir, "nope", "state.db");
    try {
      expect(() => attachStateDatabase(db, bogus)).toThrow(/does not exist/);
      expect(fs.existsSync(bogus)).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe("purgeOldTaskLogs", () => {
  test("deletes only rows older than retentionDays", () => {
    const db = openLogsDatabase();
    try {
      insertTaskLogLines(db, { taskId: "old", runId: "old@1", ts: isoMinusDays(120), lines: [{ line: "ancient" }] });
      insertTaskLogLines(db, { taskId: "new", runId: "new@1", ts: isoMinusDays(1), lines: [{ line: "fresh" }] });

      expect(purgeOldTaskLogs(db, 90)).toBe(1);
      const remaining = queryTaskLogs(db);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].line).toBe("fresh");
      // Second pass is a no-op.
      expect(purgeOldTaskLogs(db, 90)).toBe(0);
    } finally {
      db.close();
    }
  });

  test("non-positive or non-finite retention disables the purge", () => {
    const db = openLogsDatabase();
    try {
      insertTaskLogLines(db, { taskId: "old", runId: "old@1", ts: isoMinusDays(500), lines: [{ line: "keep" }] });
      expect(purgeOldTaskLogs(db, 0)).toBe(0);
      expect(purgeOldTaskLogs(db, -5)).toBe(0);
      expect(purgeOldTaskLogs(db, Number.NaN)).toBe(0);
      expect(queryTaskLogs(db)).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
