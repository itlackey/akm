// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `scheduled-startup-failures` advisory for `akm health` (upgrade-D/D2).
 * Integration-classified: it queries a real `task_history` table
 * (`openStateDatabase`), which `tests/commands/health/upgrade-advisories.test.ts`
 * — covering `version-reconcile` and `scheduler-grants` with injected seams
 * and a fake `db` — deliberately avoids.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { collectUpgradeAdvisories } from "../../../src/commands/health/upgrade-advisories";
import { openStateDatabase } from "../../../src/core/state-db";
import { upsertTaskHistory } from "../../../src/storage/repositories/task-history-repository";
import type { SchedulerBackend } from "../../../src/tasks/backends/types";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

const SINCE = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

const noBackend: SchedulerBackend = {
  name: "cron",
  install: () => {},
  uninstall: () => {},
  setEnabled: () => {},
  list: () => [],
};

async function scheduledStartupFailures() {
  const db = openStateDatabase();
  try {
    const results = await collectUpgradeAdvisories({
      db,
      since: SINCE,
      stateDir: storage.stateDir,
      cliVersion: "1.2.3",
      probe: false,
      backend: noBackend,
    });
    const found = results.find((check) => check.name === "scheduled-startup-failures");
    if (!found) throw new Error("expected a scheduled-startup-failures advisory");
    return found;
  } finally {
    db.close();
  }
}

function seedFailedRun(overrides: { taskId: string; exitCode: number; logPath?: string | null }): void {
  const db = openStateDatabase();
  try {
    upsertTaskHistory(db, {
      task_id: overrides.taskId,
      status: "failed",
      started_at: new Date().toISOString(),
      completed_at: null,
      failed_at: new Date().toISOString(),
      log_path: overrides.logPath ?? null,
      target_kind: "improve",
      target_ref: null,
      metadata_json: JSON.stringify({ durationMs: 5, detail: { exitCode: overrides.exitCode } }),
    });
  } finally {
    db.close();
  }
}

describe("scheduled-startup-failures advisory (upgrade-D/D2)", () => {
  test("pass: no task_history rows at all", async () => {
    const check = await scheduledStartupFailures();
    expect(check.status).toBe("pass");
  });

  test("pass: a failed run with an ordinary (non-startup-class) exit code", async () => {
    seedFailedRun({ taskId: "akm-improve", exitCode: 143 });
    const check = await scheduledStartupFailures();
    expect(check.status).toBe("pass");
  });

  test("warn: a failed run with exit 78 (config) names the task id and the first error line", async () => {
    const logPath = path.join(storage.dataDir, "startup-failure.log");
    fs.writeFileSync(logPath, "starting up\nError: config invalid: missing engines.default\nmore output\n");
    seedFailedRun({ taskId: "akm-improve", exitCode: 78, logPath });
    const check = await scheduledStartupFailures();
    expect(check.status).toBe("warn");
    expect(check.message).toContain("akm-improve");
    expect(check.message).toContain("Error: config invalid: missing engines.default");
    expect(check.message).toContain("akm migrate status");
    expect(check.evidence).toMatchObject({ count: 1, taskIds: ["akm-improve"] });
  });

  test("warn: exit 2 (usage) and exit 70 (internal) both count as startup-class", async () => {
    seedFailedRun({ taskId: "usage-fail", exitCode: 2 });
    seedFailedRun({ taskId: "internal-fail", exitCode: 70 });
    const check = await scheduledStartupFailures();
    expect(check.status).toBe("warn");
    expect(check.evidence).toMatchObject({ count: 2 });
    expect(check.message).toContain("usage-fail");
    expect(check.message).toContain("internal-fail");
  });
});
