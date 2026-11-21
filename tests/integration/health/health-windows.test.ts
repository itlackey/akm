// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm health --window-compare` over a real state.db: which rows land in which window, and what counts as a failed
 * agent dispatch. The current window is the hour before `now`, the prior window the hour before that.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import os from "node:os";
import { akmHealth } from "../../../src/commands/health";
import { recordImproveRunResult } from "../../../src/commands/improve/improve-result-file";
import { appendEvent } from "../../../src/core/events";
import { processIdentity } from "../../../src/core/file-lock";
import type { AkmImproveResult } from "../../../src/core/improve-types";
import { openStateDatabase } from "../../../src/core/state-db";
import { upsertTaskHistory } from "../../../src/storage/repositories/task-history-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

const MINUTE = 60_000;
let storage: IsolatedAkmStorage;
let now: number;
const at = (ms: number) => new Date(ms).toISOString();

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  now = Date.now();
  writeSandboxConfig({ semanticSearchMode: "off", improve: { enabled: false } });
});
afterEach(() => storage.cleanup());

function task(row: {
  id: string;
  minutesAgo: number;
  status: "completed" | "failed" | "active";
  kind: string;
  detail?: Record<string, unknown> | null;
  finished?: boolean;
  owner?: object;
}): void {
  const startedAt = now - row.minutesAgo * MINUTE;
  const db = openStateDatabase();
  try {
    upsertTaskHistory(db, {
      task_id: row.id,
      status: row.status,
      started_at: at(startedAt),
      completed_at: row.status === "completed" || row.finished ? at(startedAt + 1000) : null,
      failed_at: row.status === "failed" ? at(startedAt + 1000) : null,
      log_path: null,
      target_kind: row.kind,
      target_ref: null,
      metadata_json: JSON.stringify({
        metadataVersion: 2,
        durationMs: 1000,
        detail: row.detail ?? null,
        ...(row.owner ? { owner: row.owner } : {}),
      }),
    });
  } finally {
    db.close();
  }
}

function improveRun(id: string, minutesAgo: number, actions: unknown[]): void {
  const result = {
    schemaVersion: 2,
    ok: true,
    strategy: "default",
    scope: { mode: "all" },
    dryRun: false,
    memorySummary: { eligible: 0, derived: 0 },
    plannedRefs: [],
    actions,
  } as AkmImproveResult;
  recordImproveRunResult(storage.stashDir, id, result, at(now - minutesAgo * MINUTE));
}

const invoked = (minutesAgo: number) =>
  appendEvent(
    { eventType: "improve_invoked", ref: "improve:all:all", metadata: {} },
    { now: () => now - minutesAgo * MINUTE },
  );

async function windows() {
  const result = await akmHealth({ windowCompare: "1h", now: () => now, readOnly: true, probe: false });
  const byName = (name: string) => {
    const found = result.windows?.find((w) => w.name === name);
    if (!found) throw new Error(`no window named ${name}`);
    return found;
  };
  return { current: byName("current"), prior: byName("prior") };
}

describe("akm health --window-compare puts each row in the window it started in", () => {
  test("task rows count in the hour they started, and nowhere else", async () => {
    task({ id: "now-a", minutesAgo: 30, status: "failed", kind: "shell" });
    task({ id: "now-b", minutesAgo: 40, status: "failed", kind: "shell" });
    task({ id: "before-a", minutesAgo: 90, status: "completed", kind: "shell" });
    task({ id: "before-b", minutesAgo: 100, status: "completed", kind: "shell" });
    const { current, prior } = await windows();
    expect(current.metrics.taskFailRate).toBe(1);
    expect(prior.metrics.taskFailRate).toBe(0);
  });

  test("the prior window is the hour before the current one, not the current one again", async () => {
    task({ id: "failed-now", minutesAgo: 30, status: "failed", kind: "shell" });
    const { current, prior } = await windows();
    expect(current.metrics.taskFailRate).toBe(1);
    expect(prior.metrics.taskFailRate).toBeNull();
    expect(prior.since).toBe(at(now - 2 * 60 * MINUTE));
    expect(prior.until).toBe(current.since);
  });

  test("a row that started exactly at a window's boundary is in the window that begins there", async () => {
    task({ id: "on-the-boundary", minutesAgo: 60, status: "failed", kind: "shell" });
    task({ id: "just-after", minutesAgo: 59, status: "completed", kind: "shell" });
    task({ id: "just-before", minutesAgo: 61, status: "completed", kind: "shell" });
    const { current, prior } = await windows();
    expect(current.metrics.taskFailRate).toBe(0.5);
    expect(prior.metrics.taskFailRate).toBe(0);
  });

  test("a row older than both windows is in neither", async () => {
    task({ id: "aged", minutesAgo: 3 * 60, status: "failed", kind: "shell" });
    const { current, prior } = await windows();
    expect(current.metrics.taskFailRate).toBeNull();
    expect(prior.metrics.taskFailRate).toBeNull();
  });

  test("improve events count in the hour they were written, and nowhere else", async () => {
    invoked(30);
    invoked(90);
    invoked(100);
    const { current, prior } = await windows();
    expect(current.improve.invoked).toBe(1);
    expect(prior.improve.invoked).toBe(2);
  });
});

describe("what akm health counts as a failed agent dispatch", () => {
  test.each([
    "improve",
    "shell",
    "workflow",
    "script",
  ])("a failed %s row is a failed task, not an agent dispatch", async (kind) => {
    task({ id: "failed", minutesAgo: 30, status: "failed", kind, detail: { reason: "non_zero_exit" } });
    const { current } = await windows();
    expect(current.metrics.taskFailRate).toBe(1);
    expect(current.metrics.agentFailureRate).toBeNull();
  });

  test("a command row that ran and recorded detail without a reason is a dispatch that did not fail", async () => {
    task({ id: "ran", minutesAgo: 90, status: "completed", kind: "command", detail: { exitCode: 0 } });
    task({ id: "timed-out", minutesAgo: 30, status: "failed", kind: "command", detail: { reason: "timeout" } });
    const { current, prior } = await windows();
    expect(prior.metrics.agentFailureRate).toBe(0);
    expect(current.metrics.agentFailureRate).toBe(1);
    expect(current.metrics.agentFailureReasonCounts).toEqual({ timeout: 1 });
  });
});

describe("what akm health counts in an improve run", () => {
  test("a distill that needs review is counted as rejected, in the window of its run", async () => {
    improveRun("needs-review", 20, [{ mode: "distill", ref: "knowledge/x", result: { outcome: "review_needed" } }]);
    improveRun("rejected", 25, [{ mode: "distill", ref: "knowledge/y", result: { outcome: "quality_rejected" } }]);
    const { current, prior } = await windows();
    expect(current.improve.actions.distill.judgeRejected).toBe(2);
    expect(prior.improve.actions.distill.judgeRejected).toBe(0);
  });
});

describe("what akm health counts as a stuck run", () => {
  test("an attempt whose row records that it finished is not stuck, whatever its status says", async () => {
    const identity = processIdentity(process.pid);
    const dead = { pid: 2 ** 22 - 1, host: os.hostname(), bootId: identity?.bootId, startTime: "1" };
    task({ id: "stuck", minutesAgo: 30, status: "active", kind: "shell", owner: dead });
    task({ id: "finished", minutesAgo: 30, status: "active", kind: "shell", owner: dead, finished: true });
    const result = await akmHealth({ since: at(now - 60 * MINUTE), now: () => now, readOnly: true, probe: false });
    expect(result.metrics.stuckActiveRuns).toBe(1);
  });
});
