// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Integration: reads real isolated state/index databases, without network or harness probes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmHealth } from "../../../src/commands/health";
import { buildPerRunSummaries } from "../../../src/commands/health/task-runs";
import { recordImproveRunResult, recordTerminatedImproveRun } from "../../../src/commands/improve/improve-result-file";
import type { AkmImproveResult } from "../../../src/core/improve-types";
import { getDbPath } from "../../../src/core/paths";
import { openStateDatabase } from "../../../src/core/state-db";
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
  recordImproveRunResult(storage.stashDir, id, result, at(startedAt));
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

  test.each([true, false])("a completed processing failure warns even when the outer ok is %s", async (ok) => {
    improve("failed", now - 120_000, {
      ok,
      actions: [
        {
          mode: "reflect-failed",
          ref: "knowledge/fixture",
          result: { ok: false, error: "Synthetic processing failure" },
        },
      ],
    });
    const result = await health();
    expect(result.runs?.[0]?.ok).toBe(ok);
    expect(result.improve.actions.reflect.failed).toBe(1);
    expect(result.advisories.find((c) => c.name === "improve-failures")).toMatchObject({
      status: "warn",
      evidence: { failedRuns: 1, runIds: ["failed"] },
    });
    expect(result.status).toBe("warn");
  });

  test.each(["distill", "error"] as const)("a completed %s failure warns despite outer ok", async (mode) => {
    improve("failed", now - 120_000, {
      actions: [
        {
          mode,
          ref: "knowledge/fixture",
          result:
            mode === "distill"
              ? { schemaVersion: 1, ok: false, outcome: "llm_failed", inputRef: "knowledge/fixture", proposalRef: "" }
              : { ok: false, error: "Synthetic processing failure" },
        },
      ],
    });
    const result = await health();
    expect(result.runs?.[0]?.ok).toBe(true);
    expect(result.advisories.find((c) => c.name === "improve-failures")).toMatchObject({
      status: "warn",
      evidence: { failedRuns: 1, runIds: ["failed"] },
    });
  });

  test("a completed consolidation with failed chunks warns despite outer ok", async () => {
    improve("failed", now - 120_000, {
      consolidation: {
        schemaVersion: 1,
        ok: true,
        shape: "consolidate-result",
        dryRun: false,
        previewOnly: false,
        target: "all",
        processed: 1,
        merged: 0,
        deleted: 0,
        promoted: [],
        contradicted: 0,
        failedChunks: 1,
        totalChunks: 1,
        warnings: [],
        durationMs: 10,
      },
    });
    const result = await health();
    expect(result.improve.consolidation.failedChunks).toBe(1);
    expect(result.advisories.find((c) => c.name === "improve-failures")).toMatchObject({
      status: "warn",
      evidence: { failedRuns: 1, runIds: ["failed"] },
    });
  });

  test.each([
    "exception",
    "budget_exhausted",
  ])("a recorded %s warns even though its result is incomplete", async (reason) => {
    recordTerminatedImproveRun(storage.stashDir, "terminated", at(now - 120_000), reason, { strategy: "default" });
    const result = await health();
    expect(result.runs?.[0]).toMatchObject({ ok: false, resultComplete: false });
    expect(result.advisories.find((c) => c.name === "improve-failures")).toMatchObject({
      status: "warn",
      evidence: { failedRuns: 1, runIds: ["terminated"] },
    });
    expect(result.status).toBe("warn");
  });

  test.each([
    "SIGINT",
    "SIGTERM",
    "SIGHUP",
  ])("%s is reported as interrupted, not assumed cancelled or failed", async (reason) => {
    recordTerminatedImproveRun(storage.stashDir, "interrupted", at(now - 120_000), reason, { strategy: "default" });
    const result = await health();
    expect(result.advisories.find((c) => c.name === "improve-failures")).toMatchObject({
      status: "unknown",
      evidence: { failedRuns: 0, interruptedRuns: 1, interruptedRunIds: ["interrupted"] },
    });
  });

  test("an interruption cannot hide a recorded processing failure", async () => {
    improve("failed", now - 120_000, {
      ok: false,
      terminated: { reason: "SIGTERM", at: at(now - 110_000) },
      actions: [{ mode: "error", ref: "knowledge/fixture", result: { ok: false, error: "Synthetic failure" } }],
    });
    const result = await health();
    expect(result.advisories.find((c) => c.name === "improve-failures")).toMatchObject({
      status: "warn",
      evidence: { failedRuns: 1, interruptedRuns: 0 },
    });
  });

  test.each([
    0, 1,
  ])("memory inference distinguishes no-change from unusable results (%s failures)", async (failures) => {
    improve("inference", now - 120_000, {
      memoryInference: {
        considered: 1,
        cacheHits: 0,
        retryAttempts: 0,
        splitParents: 0,
        writtenFacts: 0,
        noChange: 1 - failures,
        skippedNoFacts: failures,
        skippedChildExists: 0,
        skippedAborted: 0,
        unaccounted: 0,
        htmlErrorCount: 0,
        scopeSynced: 0,
        writtenPaths: [],
      },
    });
    const result = await health();
    expect(result.advisories.find((c) => c.name === "improve-failures")).toMatchObject({
      status: failures ? "warn" : "pass",
      evidence: { failedRuns: failures },
    });
  });

  test("no-work successes and normal quality decisions are not failures", async () => {
    improve("no-work", now - 180_000, { skipped: { reason: "lock-held" } });
    improve("quality", now - 120_000, {
      actions: [
        {
          mode: "distill",
          ref: "knowledge/fixture",
          result: {
            schemaVersion: 1,
            ok: false,
            outcome: "quality_rejected",
            inputRef: "knowledge/fixture",
            proposalRef: "",
          },
        },
      ],
    });
    const result = await health();
    expect(result.advisories.find((c) => c.name === "improve-failures")).toMatchObject({
      status: "pass",
      evidence: { failedRuns: 0 },
    });
    expect(result.status).toBe("pass");
  });

  test("failed improve runs outside the reporting window do not warn", async () => {
    improve("historical", now - 2 * DAY, { ok: false });
    recordTerminatedImproveRun(storage.stashDir, "old-exception", at(now - 2 * DAY), "exception", {
      strategy: "default",
    });
    improve("dry-run", now - 120_000, { ok: false, dryRun: true });
    const result = await health();
    expect(result.runs).toEqual([]);
    expect(result.status).toBe("pass");
  });

  test("a failed persisted run still warns when its result envelope is unreadable", async () => {
    improve("corrupt-failure", now - 120_000, { ok: false });
    const db = openStateDatabase();
    try {
      db.run("UPDATE improve_runs SET result_json = ? WHERE id = ?", "{invalid", "corrupt-failure");
    } finally {
      db.close();
    }
    const result = await health();
    expect(result.improve.resultRows).toMatchObject({ included: 0, skipped: { invalid: 1 } });
    expect(result.advisories.find((c) => c.name === "improve-failures")).toMatchObject({
      status: "warn",
      evidence: { failedRuns: 1, runIds: ["corrupt-failure"] },
    });
  });
});
