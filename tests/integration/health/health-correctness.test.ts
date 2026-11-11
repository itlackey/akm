// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Integration: reads real isolated state/index databases, without network or harness probes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmHealth } from "../../../src/commands/health";
import { buildPerRunSummaries } from "../../../src/commands/health/task-runs";
import type { AkmImproveResult } from "../../../src/core/improve-types";
import { getDbPath } from "../../../src/core/paths";
import { openStateDatabase } from "../../../src/core/state-db";
import { recordImproveRun } from "../../../src/storage/repositories/improve-runs-repository";
import { type TaskHistoryRow, upsertTaskHistory } from "../../../src/storage/repositories/task-history-repository";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let now: number;
const at = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  now = Date.now();
  writeSandboxConfig({
    semanticSearchMode: "off",
    improve: { enabled: false },
    defaultBundle: "fixture",
    bundles: {
      fixture: { path: storage.stashDir, writable: true, components: { main: { root: ".", adapter: "akm" } } },
    },
  });
  fs.mkdirSync(path.join(storage.root, "bin"));
  const db = openStateDatabase();
  db.close();
});
afterEach(() => storage.cleanup());

const health = (since = at(now - DAY)) =>
  withEnv({ PATH: path.join(storage.root, "bin") }, () =>
    akmHealth({ since, now: () => now, readOnly: true, probe: false, groupBy: "run" }),
  );

function task(taskId: string, startedAt: number, status = "active"): void {
  const row: TaskHistoryRow = {
    task_id: taskId,
    status,
    started_at: at(startedAt),
    completed_at: status === "completed" ? at(startedAt + 10_000) : null,
    failed_at: null,
    log_path: null,
    target_kind: "shell",
    target_ref: null,
    metadata_json: JSON.stringify({ metadataVersion: 2, durationMs: 10_000, detail: null }),
  };
  const db = openStateDatabase();
  try {
    upsertTaskHistory(db, row);
  } finally {
    db.close();
  }
}

function improve(id: string, startedAt: number, overrides: Partial<AkmImproveResult> = {}): void {
  const result: AkmImproveResult = {
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
  const db = openStateDatabase();
  try {
    recordImproveRun(db, {
      id,
      startedAt: at(startedAt),
      completedAt: at(startedAt + 10_000),
      stashDir: storage.stashDir,
      dryRun: result.dryRun,
      strategy: result.strategy,
      scopeMode: "all",
      scopeValue: null,
      guidance: null,
      ok: result.ok,
      result,
    });
  } finally {
    db.close();
  }
}

describe("health reporting correctness", () => {
  test("still-active runs do not disappear outside the history lookback", async () => {
    task("stuck", now - 2 * DAY);
    task("recent", now - 60_000);
    task("old-completed", now - 3 * DAY, "completed");
    const short = await health();
    const wide = await health(at(now - 7 * DAY));
    expect(short.metrics.stuckActiveRuns).toBe(1);
    expect(wide.metrics.stuckActiveRuns).toBe(1);
    expect(short.hardChecks.find((c) => c.name === "active-runs")).toMatchObject({
      status: "warn",
      evidence: {
        stuckActiveTasks: [{ taskId: "stuck", ageMs: 2 * DAY }],
      },
    });
    expect(short.hardChecks.find((c) => c.name === "task-history-read")?.evidence?.rows).toBe(1);
    expect(short.metrics.taskFailRate).toBe(0);
    expect(short.status).toBe("warn");
  });

  test.each(["auto", "off"] as const)("an unreadable index fails overall health in %s mode", async (mode) => {
    writeSandboxConfig({ semanticSearchMode: mode });
    fs.writeFileSync(getDbPath(), "synthetic invalid sqlite bytes");
    const result = await health();
    expect(result.hardChecks.find((c) => c.name === "semantic-search")).toMatchObject({ status: "fail" });
    expect(result.status).toBe("fail");
    expect(result.ok).toBe(false);
  });

  test("a fresh installation without an index is not treated as corrupt", async () => {
    writeSandboxConfig({ semanticSearchMode: "auto" });
    const result = await health();
    expect(result.hardChecks.find((c) => c.name === "semantic-search")?.status).toBe("unknown");
    expect(result.status).toBe("pass");
  });

  test.each(["improve", "akm-improve", "akm-improve-default"])("attributes scheduled %s runs", (taskId) => {
    const start = now - 120_000;
    task(taskId, start, "completed");
    improve("scheduled", start);
    const db = openStateDatabase();
    try {
      expect(buildPerRunSummaries(db, at(now - DAY), at(now))[0]?.taskId).toBe(taskId);
    } finally {
      db.close();
    }
  });

  test("an unrelated task does not claim a manual improve run", () => {
    const start = now - 120_000;
    task("backup", start, "completed");
    improve("manual", start);
    const db = openStateDatabase();
    try {
      expect(buildPerRunSummaries(db, at(now - DAY), at(now))[0]?.taskId).toBe("manual");
    } finally {
      db.close();
    }
  });

  test("a completed failed improve run warns even with no scheduled task", async () => {
    improve("failed", now - 120_000, {
      ok: false,
      actions: [
        {
          mode: "reflect-failed",
          ref: "knowledge/fixture",
          result: { ok: false, error: "Synthetic processing failure" },
        },
      ],
    });
    const result = await health();
    expect(result.runs?.[0]?.ok).toBe(false);
    expect(result.improve.actions.reflect.failed).toBe(1);
    expect(result.advisories.find((c) => c.name === "improve-failures")).toMatchObject({
      status: "warn",
      evidence: { failedRuns: 1, runIds: ["failed"] },
    });
    expect(result.status).toBe("warn");
  });

  test("no-work successes and cancelled runs do not produce failed-processing warnings", async () => {
    improve("no-work", now - 180_000, { skipped: { reason: "lock-held" } });
    improve("cancelled", now - 120_000, { ok: false, terminated: { reason: "SIGTERM", at: at(now - 110_000) } });
    const result = await health();
    expect(result.advisories.find((c) => c.name === "improve-failures")).toMatchObject({
      status: "pass",
      evidence: { failedRuns: 0 },
    });
    expect(result.status).toBe("pass");
  });

  test("failed improve runs outside the reporting window do not warn", async () => {
    improve("historical", now - 2 * DAY, { ok: false });
    const result = await health();
    expect(result.runs).toEqual([]);
    expect(result.status).toBe("pass");
  });
});
