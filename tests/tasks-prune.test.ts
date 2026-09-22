// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm task prune` (#851): reclaim installed scheduler entries `sync` can
 * never see because their own `--scheduler-context` descriptor doesn't
 * resolve to a live bundle (#846's `belongsToBundle` deliberately excludes
 * them rather than guessing ownership).
 *
 * Mirrors tests/integration/tasks-sync-dry-run.test.ts's harness: a real
 * `CRON_BACKEND` wired to an in-memory `CronExec`, so these tests exercise
 * the exact production path (`akmTasksPrune` -> `buildSchedulerRemoveOperation`
 * -> `applySchedulerTransaction`) with zero interaction with any real
 * crontab/plist/schtasks state.
 *
 * ABSOLUTE SAFETY REQUIREMENTS this file exists to prove:
 *   1. Default invocation (no --yes, no --id) makes ZERO scheduler writes —
 *      proven against the fake exec's write-call spy.
 *   2. A confirmed prune (--yes) DOES write — the control test that makes
 *      (1) meaningful instead of an unfired spy.
 *   3. An entry that still resolves to a live bundle is NEVER removed, even
 *      when named explicitly via --id.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmTasksPrune, akmTasksSync } from "../src/commands/tasks/tasks";
import { taskPruneExitCode } from "../src/commands/tasks/tasks-cli";
import { makeBundleRef } from "../src/core/asset/asset-ref";
import { setSchedulerRefEnabled } from "../src/tasks/activation-config";
import { CRON_BACKEND, type CronExec, type CronExecResult } from "../src/tasks/backends/cron";
import { compileTaskSchedulerBindings } from "../src/tasks/scheduler-binding";
import {
  resolveScheduledTaskContext,
  schedulerContextDescriptor,
  schedulerContextPath,
  writeSchedulerContextDescriptor,
} from "../src/tasks/scheduler-invocation";
import type { Cleanup } from "./_helpers/sandbox";
import { sandboxStashDir, sandboxXdgConfigHome, sandboxXdgStateHome } from "./_helpers/sandbox";

let cleanup: Cleanup = () => {};
let stashDir = "";
let tasksDir = "";

/** A `CronExec` whose `write` is a spy: proves prune's write behavior exactly. */
function spyingMemoryExec(initial = ""): CronExec & { current: () => string; writeCalls: number } {
  let store = initial;
  let writeCalls = 0;
  return {
    read: (): CronExecResult => ({ status: 0, stdout: store, stderr: "" }),
    write: (content: string): CronExecResult => {
      writeCalls += 1;
      store = content;
      return { status: 0, stdout: "", stderr: "" };
    },
    current: () => store,
    get writeCalls() {
      return writeCalls;
    },
  };
}

function writeTask(id: string, schedule: string): void {
  fs.writeFileSync(
    path.join(tasksDir, `${id}.yml`),
    `version: 4\nrun: echo ${id}\nname: ${id}\nschedule:\n  - cron: "${schedule}"\n`,
    "utf8",
  );
  setSchedulerRefEnabled("task", makeBundleRef(path.basename(stashDir).toLowerCase(), `tasks/${id}`), true);
}

beforeEach(() => {
  let chain: Cleanup = () => {};
  chain = sandboxXdgConfigHome(chain).cleanup;
  chain = sandboxXdgStateHome(chain).cleanup;
  const stash = sandboxStashDir(chain);
  stashDir = stash.dir;
  cleanup = stash.cleanup;
  tasksDir = path.join(stashDir, "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
  stashDir = "";
  tasksDir = "";
});

const backendFor = (exec: CronExec) => {
  // Same default-context wiring tasks-sync(-dry-run).test.ts use: install
  // operations that don't pass their own contextPath fall back to this one,
  // and it resolves to THIS sandbox's stash dir, so a plain `akmTasksSync`
  // install is always alive/live from prune's point of view.
  writeSchedulerContextDescriptor(schedulerContextDescriptor(resolveScheduledTaskContext(), ""));
  return CRON_BACKEND({
    exec,
    fs: { ensureDir() {} },
    logDir: "/var/log/akm",
    akmArgv: ["/usr/local/bin/akm"],
    envPath: false,
  });
};

/** Install one synthetic orphan entry directly through the backend, bypassing sync's own bundle scope. */
async function installOrphan(backend: ReturnType<typeof CRON_BACKEND>, id: string, contextPath: string): Promise<void> {
  const bundleName = path.basename(stashDir).toLowerCase();
  const bindings = compileTaskSchedulerBindings({
    id,
    qualifiedRef: makeBundleRef(bundleName, `tasks/${id}`),
    schedules: [{ cron: "0 3 * * *", source: `${id}.yml:0`, ordinal: 0 }],
  });
  const binding = bindings[0];
  if (!binding) throw new Error(`invariant: compileTaskSchedulerBindings produced no binding for ${id}`);
  await backend.install(binding, { contextPath });
}

/** An absolute path to a scheduler-context descriptor file that has never been written. */
function missingContextPath(): string {
  return path.join(os.tmpdir(), `akm-t851-missing-context-${Math.random().toString(36).slice(2)}.json`);
}

/** A written, valid descriptor whose AKM_BUNDLE_DIR points at a directory that does not exist. */
function deadBundleContextPath(): string {
  const context = resolveScheduledTaskContext();
  const deadDir = path.join(os.tmpdir(), `akm-t851-dead-bundle-${Math.random().toString(36).slice(2)}`);
  const descriptor = schedulerContextDescriptor({ ...context, AKM_BUNDLE_DIR: deadDir }, "");
  return writeSchedulerContextDescriptor(descriptor) ?? schedulerContextPath(descriptor);
}

describe("akmTasksPrune", () => {
  test("previews invalid-context and dead-bundle-path orphans with ZERO writes (no --yes)", async () => {
    const exec = spyingMemoryExec();
    const backend = backendFor(exec);
    writeTask("alive", "*/15 * * * *");
    await akmTasksSync({ backend });
    await installOrphan(backend, "ghost", missingContextPath());
    await installOrphan(backend, "stale", deadBundleContextPath());
    const writesBeforePrune = exec.writeCalls;

    const result = await akmTasksPrune({ backend });

    expect(result.dryRun).toBe(true);
    expect(result.removed).toEqual([]);
    const removedIds = result.preview.removes.map((op) => op.id).sort();
    expect(removedIds).toEqual(["ghost", "stale"]);
    const byId = new Map(result.preview.removes.map((op) => [op.id, op.reason]));
    expect(byId.get("ghost")).toBe("invalid-context");
    expect(byId.get("stale")).toBe("dead-bundle-path");
    expect(result.preview.hasRemovals).toBe(true);
    expect(taskPruneExitCode(result)).not.toBeUndefined();

    // ABSOLUTE SAFETY REQUIREMENT 1: zero durable writes from the preview call itself.
    expect(exec.writeCalls).toBe(writesBeforePrune);
    expect(exec.current()).toContain("task run alive");
    expect(exec.current()).toContain("task run ghost");
    expect(exec.current()).toContain("task run stale");
  });

  test("no candidates: dry-run reports nothing to prune and exits clean", async () => {
    const exec = spyingMemoryExec();
    const backend = backendFor(exec);
    writeTask("alive", "*/15 * * * *");
    await akmTasksSync({ backend });
    const writesBeforePrune = exec.writeCalls;

    const result = await akmTasksPrune({ backend });

    expect(result.preview.removes).toEqual([]);
    expect(result.preview.hasRemovals).toBe(false);
    expect(taskPruneExitCode(result)).toBeUndefined();
    expect(exec.writeCalls).toBe(writesBeforePrune);
  });

  test("CONTROL: --yes actually writes and removes exactly the orphans, never the live entry", async () => {
    const exec = spyingMemoryExec();
    const backend = backendFor(exec);
    writeTask("alive", "*/15 * * * *");
    await akmTasksSync({ backend });
    await installOrphan(backend, "ghost", missingContextPath());
    await installOrphan(backend, "stale", deadBundleContextPath());
    const writesBeforePrune = exec.writeCalls;

    const result = await akmTasksPrune({ backend }, { yes: true });

    expect(result.dryRun).toBe(false);
    expect([...result.removed].sort()).toEqual(["ghost", "stale"]);
    // The unfired-spy problem: prove the write path was actually exercised.
    expect(exec.writeCalls).toBeGreaterThan(writesBeforePrune);
    expect(exec.current()).not.toContain("task run ghost");
    expect(exec.current()).not.toContain("task run stale");
    // ABSOLUTE SAFETY REQUIREMENT 3: the live bundle's own entry survives.
    expect(exec.current()).toContain("task run alive");
  });

  test("--id narrows removal to exactly the named orphan", async () => {
    const exec = spyingMemoryExec();
    const backend = backendFor(exec);
    writeTask("alive", "*/15 * * * *");
    await akmTasksSync({ backend });
    await installOrphan(backend, "ghost", missingContextPath());
    await installOrphan(backend, "stale", deadBundleContextPath());

    const result = await akmTasksPrune({ backend }, { yes: true, id: ["ghost"] });

    expect(result.removed).toEqual(["ghost"]);
    expect(exec.current()).not.toContain("task run ghost");
    // Untouched, even though it is also a valid orphan candidate.
    expect(exec.current()).toContain("task run stale");
    expect(exec.current()).toContain("task run alive");
  });

  test("ABSOLUTE SAFETY REQUIREMENT: --id naming a live bundle's own entry is refused, never removed", async () => {
    const exec = spyingMemoryExec();
    const backend = backendFor(exec);
    writeTask("alive", "*/15 * * * *");
    await akmTasksSync({ backend });
    const writesBeforePrune = exec.writeCalls;

    await expect(akmTasksPrune({ backend }, { yes: true, id: ["alive"] })).rejects.toThrow(
      /not an orphaned prune candidate/i,
    );

    expect(exec.writeCalls).toBe(writesBeforePrune);
    expect(exec.current()).toContain("task run alive");
  });

  test("--id naming an unknown id is refused", async () => {
    const exec = spyingMemoryExec();
    const backend = backendFor(exec);
    writeTask("alive", "*/15 * * * *");
    await akmTasksSync({ backend });

    await expect(akmTasksPrune({ backend }, { yes: true, id: ["does-not-exist"] })).rejects.toThrow(
      /not an orphaned prune candidate/i,
    );
  });
});
