// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** A task run's history says what it ran, and its recorded output is read from logs.db without creating it. */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import { resetConfigCache } from "../../../src/core/config/config";
import { buildTaskRunId, getLogsDbPath, insertTaskLogLines, openLogsDatabase } from "../../../src/core/logs-db";
import { openStateDatabase } from "../../../src/core/state-db";
import { upsertTaskHistory } from "../../../src/storage/repositories/task-history-repository";
import { activity } from "../../../src/workspace";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
beforeEach(() => {
  storage = withIsolatedAkmStorage();
  resetConfigCache();
});
afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

const startedAt = "2026-11-16T10:00:00.000Z";

test("a task that ran a command: its history names the target and its log lines are listed in order", async () => {
  const db = openStateDatabase();
  upsertTaskHistory(db, {
    task_id: "improve-nightly",
    status: "completed",
    started_at: startedAt,
    completed_at: "2026-11-16T10:01:00.000Z",
    failed_at: null,
    log_path: null,
    target_kind: "command",
    target_ref: null,
    metadata_json: JSON.stringify({ metadataVersion: 2, durationMs: 60000, detail: null, engine: "claude" }),
  });
  db.close();
  const logs = openLogsDatabase();
  insertTaskLogLines(logs, {
    taskId: "improve-nightly",
    runId: buildTaskRunId("improve-nightly", startedAt),
    ts: startedAt,
    lines: [
      { line: "[akm task] task=improve-nightly kind=command" },
      { stream: "stderr", level: "error", line: "warn" },
    ],
  });
  logs.close();

  const history = await activity.taskHistory({ taskId: "improve-nightly" });
  expect(history.runs[0]).toMatchObject({ targetKind: "command", targetRef: null, engine: "claude" });
  const log = await activity.taskRunLog({ taskId: "improve-nightly", startedAt });
  expect(log).toEqual({
    available: true,
    truncated: false,
    lines: [
      { stream: "stdout", level: "info", line: "[akm task] task=improve-nightly kind=command" },
      { stream: "stderr", level: "error", line: "warn" },
    ],
  });
});

test("with no logs.db the log is unavailable and nothing is created", async () => {
  expect(await activity.taskRunLog({ taskId: "t", startedAt })).toEqual({ available: false, reason: "absent" });
  expect(fs.existsSync(getLogsDbPath())).toBe(false);
});
