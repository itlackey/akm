// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `reconcileOnVersionChange` with an injected `runTool` — no real
 * `akm-migrate` spawn, no real akm home. `stateDir` is an explicit
 * dependency (never `getStateDir()`), so a plain scratch directory is
 * enough; no sandbox/env isolation is needed.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLockPayload, releaseLock, tryAcquireLockSync } from "../../src/core/file-lock";
import {
  describeHostLocalReconciliation,
  reconcileOnVersionChange,
  type VersionReconcileToolResult,
} from "../../src/core/version-reconcile";
import { _resetWarnOnceForTests } from "../../src/core/warn";

const roots: string[] = [];

function scratchStateDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-version-reconcile-"));
  roots.push(root);
  return root;
}

function lockPathFor(stateDir: string): string {
  return path.join(stateDir, "locks", "version-reconcile.lock");
}

afterEach(() => {
  _resetWarnOnceForTests();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function toolResult(overrides: Partial<VersionReconcileToolResult> & { plan?: Record<string, unknown> } = {}) {
  const { plan, ...rest } = overrides;
  return {
    status: 0,
    stdout: plan ? JSON.stringify(plan) : "",
    stderr: "",
    ...rest,
  };
}

describe("reconcileOnVersionChange", () => {
  test("a stamp matching the running version needs no spawn", async () => {
    const stateDir = scratchStateDir();
    fs.writeFileSync(
      path.join(stateDir, "version-reconcile.json"),
      JSON.stringify({ version: "1.2.3", reconciledAt: "2026-01-01T00:00:00.000Z" }),
    );
    const runTool = mock(() => Promise.resolve(toolResult()));

    const result = await reconcileOnVersionChange({ version: "1.2.3", runTool, stateDir, now: () => new Date() });

    expect(result).toEqual({ outcome: "up-to-date" });
    expect(runTool).not.toHaveBeenCalled();
  });

  test("no stamp spawns apply --host-local and writes the stamp on current", async () => {
    const stateDir = scratchStateDir();
    const runTool = mock(() =>
      Promise.resolve(toolResult({ plan: { schemaVersion: 1, mode: "host-local", status: "current", blockers: [] } })),
    );

    const result = await reconcileOnVersionChange({ version: "1.2.3", runTool, stateDir, now: () => new Date() });

    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool).toHaveBeenCalledWith(["apply", "--host-local"]);
    expect(result.outcome).toBe("reconciled");
    const stamp = JSON.parse(fs.readFileSync(path.join(stateDir, "version-reconcile.json"), "utf8"));
    expect(stamp.version).toBe("1.2.3");
    expect(typeof stamp.reconciledAt).toBe("string");
  });

  test("a ready plan also writes the stamp (apply already converged everything)", async () => {
    const stateDir = scratchStateDir();
    const runTool = mock(() =>
      Promise.resolve(toolResult({ plan: { schemaVersion: 1, mode: "host-local", status: "ready", blockers: [] } })),
    );

    const result = await reconcileOnVersionChange({ version: "9.9.9", runTool, stateDir, now: () => new Date() });

    expect(result.outcome).toBe("reconciled");
    const stamp = JSON.parse(fs.readFileSync(path.join(stateDir, "version-reconcile.json"), "utf8"));
    expect(stamp.version).toBe("9.9.9");
  });

  test("blocked: no version stamp is written, and a second call within 10 minutes does not spawn again", async () => {
    const stateDir = scratchStateDir();
    const runTool = mock(() =>
      Promise.resolve(
        toolResult({
          plan: { schemaVersion: 1, mode: "host-local", status: "blocked", blockers: ["bind scheduler activation x"] },
        }),
      ),
    );
    let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    const now = () => new Date(nowMs);

    const first = await reconcileOnVersionChange({ version: "1.2.3", runTool, stateDir, now });
    expect(first.outcome).toBe("blocked");
    if (first.outcome === "blocked") expect(first.blocker).toBe("bind scheduler activation x");
    expect(runTool).toHaveBeenCalledTimes(1);

    const stamp = JSON.parse(fs.readFileSync(path.join(stateDir, "version-reconcile.json"), "utf8"));
    expect(stamp.version).toBeUndefined();
    expect(typeof stamp.lastAttemptAt).toBe("string");
    expect(stamp.lastStatus).toContain("bind scheduler activation x");

    // A second invocation five minutes later (< the 10-minute backoff) must
    // not spawn the tool again.
    nowMs += 5 * 60 * 1000;
    const second = await reconcileOnVersionChange({ version: "1.2.3", runTool, stateDir, now });
    expect(second.outcome).toBe("blocked");
    expect(runTool).toHaveBeenCalledTimes(1);
  });

  test("lock held elsewhere and the stamp becomes current: no spawn", async () => {
    const stateDir = scratchStateDir();
    fs.mkdirSync(path.dirname(lockPathFor(stateDir)), { recursive: true });
    const ownership = tryAcquireLockSync(lockPathFor(stateDir), createLockPayload({ component: "test-other-process" }));
    if (!ownership) throw new Error("test setup: could not acquire the lock");
    const runTool = mock(() =>
      Promise.resolve(toolResult({ plan: { schemaVersion: 1, status: "current", blockers: [] } })),
    );

    // The "other process" finishes and writes the stamp shortly after.
    setTimeout(() => {
      fs.writeFileSync(
        path.join(stateDir, "version-reconcile.json"),
        JSON.stringify({ version: "1.2.3", reconciledAt: new Date().toISOString() }),
      );
    }, 15);

    const result = await reconcileOnVersionChange({
      version: "1.2.3",
      runTool,
      stateDir,
      now: () => new Date(),
      pollIntervalMs: 5,
      maxWaitMs: 500,
    });

    expect(result).toEqual({ outcome: "up-to-date" });
    expect(runTool).not.toHaveBeenCalled();
    releaseLock(ownership);
  });

  test("lock held and the stamp stays stale: warns, never throws", async () => {
    const stateDir = scratchStateDir();
    fs.mkdirSync(path.dirname(lockPathFor(stateDir)), { recursive: true });
    const ownership = tryAcquireLockSync(lockPathFor(stateDir), createLockPayload({ component: "test-other-process" }));
    if (!ownership) throw new Error("test setup: could not acquire the lock");
    const runTool = mock(() => Promise.resolve(toolResult()));

    const result = await reconcileOnVersionChange({
      version: "1.2.3",
      runTool,
      stateDir,
      now: () => new Date(),
      pollIntervalMs: 5,
      maxWaitMs: 30,
    });

    expect(result).toEqual({ outcome: "lock-unavailable" });
    expect(runTool).not.toHaveBeenCalled();
    releaseLock(ownership);
  });

  test("a spawn failure is reported, not thrown, and never claims a version", async () => {
    const stateDir = scratchStateDir();
    const runTool = mock(() => Promise.reject(new Error("ENOENT: akm-migrate not found")));

    const result = await reconcileOnVersionChange({ version: "1.2.3", runTool, stateDir, now: () => new Date() });

    expect(result.outcome).toBe("spawn-failed");
    const stamp = JSON.parse(fs.readFileSync(path.join(stateDir, "version-reconcile.json"), "utf8"));
    expect(stamp.version).toBeUndefined();
    expect(stamp.lastStatus).toContain("spawn failed");
  });
});

describe("describeHostLocalReconciliation", () => {
  test("summarizes only the sections that actually changed something", () => {
    const notes = describeHostLocalReconciliation({
      schemaVersion: 1,
      mode: "host-local",
      status: "current",
      blockers: [],
      configLegacySourceShape: { applied: false },
      configRetiredKeys: { applied: true, removed: ["llm"] },
      stateMigrations: { applied: ["2026-09-01-events-index"] },
      schedulerActivation: { applied: [{ kind: "task", ref: "stash//tasks/nightly", sourceId: "x" }], warnings: [] },
      staleTxns: { recovered: [] },
    });

    expect(notes).toEqual([
      "1 retired config key(s) removed",
      "1 state.db migration(s) applied",
      "1 scheduler grant(s) carried forward",
    ]);
  });

  test("an all-current plan with nothing applied summarizes to nothing", () => {
    expect(
      describeHostLocalReconciliation({
        schemaVersion: 1,
        mode: "host-local",
        status: "current",
        blockers: [],
        configLegacySourceShape: { applied: false },
        configRetiredKeys: { applied: false },
        stateMigrations: { applied: [] },
        schedulerActivation: { applied: [], warnings: [] },
        staleTxns: { recovered: [] },
      }),
    ).toEqual([]);
  });
});
