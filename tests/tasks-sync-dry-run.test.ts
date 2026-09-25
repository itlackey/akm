// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm task sync --dry-run` (#849): preview a scheduler reconcile plan
 * without ever touching the OS scheduler.
 *
 * Reuses the same in-memory cron backend fixture as tests/integration/
 * tasks-sync.test.ts (a real `CRON_BACKEND` wired to a fake `CronExec` that
 * stores the "crontab" in a JS string instead of shelling out), so these
 * tests exercise the exact production code path (`akmTasksSyncPlan` →
 * `finalizeSchedulerSyncPlan` → `renderSchedulerSyncPlanPreview`) while
 * guaranteeing zero interaction with any real crontab/plist/schtasks state.
 *
 * The ABSOLUTE SAFETY REQUIREMENT this file exists to prove: `--dry-run`
 * must never write. That is asserted directly against the fake `CronExec`
 * (its `write` is a spy — a call count of 0 after a dry run is the load-
 * bearing assertion), not merely inferred from "the returned result looked
 * like a preview".
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmTasksSync, akmTasksSyncPlan } from "../src/commands/tasks/tasks";
import { taskSyncDryRunExitCode, taskValidateExitCode } from "../src/commands/tasks/tasks-cli";
import { loadConfig, resetConfigCache, saveConfig } from "../src/core/config/config";
import { shapeForCommand } from "../src/output/shapes";
import { schedulerEnabledRefs, setSchedulerRefEnabled } from "../src/tasks/activation-config";
import { CRON_BACKEND, type CronExec, type CronExecResult } from "../src/tasks/backends/cron";
import {
  resolveScheduledTaskContext,
  schedulerContextDescriptor,
  writeSchedulerContextDescriptor,
} from "../src/tasks/scheduler-invocation";
import type { Cleanup } from "./_helpers/sandbox";
import { sandboxStashDir, sandboxXdgConfigHome, sandboxXdgStateHome, writeSandboxConfig } from "./_helpers/sandbox";

let cleanup: Cleanup = () => {};
let stashDir = "";
let tasksDir = "";

/** A `CronExec` whose `write` is a spy: proves dry-run never calls it. */
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

function writeTask(id: string, schedule: string, enabled = true): void {
  fs.writeFileSync(
    path.join(tasksDir, `${id}.yml`),
    `version: 4\nrun: echo ${id}\nname: ${id}\nschedule:\n  - cron: "${schedule}"\n`,
    "utf8",
  );
  setSchedulerRefEnabled(`stash//tasks/${id}`, enabled);
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
  writeSandboxConfig({ bundles: { stash: { path: stashDir, writable: true } }, defaultBundle: "stash" });
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
  stashDir = "";
  tasksDir = "";
});

const backendFor = (exec: CronExec) => {
  // Mirrors tests/integration/tasks-sync.test.ts's `backendFor`: write a
  // real scheduler-context descriptor matching CRON_BACKEND's default
  // context so belongsToBundle can resolve the installed entries' owner.
  writeSchedulerContextDescriptor(schedulerContextDescriptor(resolveScheduledTaskContext(), ""));
  return CRON_BACKEND({
    exec,
    fs: { ensureDir() {} },
    logDir: "/var/log/akm",
    akmArgv: ["/usr/local/bin/akm"],
    envPath: false,
  });
};

describe("akmTasksSyncPlan — dry-run", () => {
  test("previews adds with zero writes and hasRemovals: false on an empty scheduler", async () => {
    const exec = spyingMemoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *");
    writeTask("beta", "0 2 * * *");

    const preview = await akmTasksSyncPlan({ backend }, undefined, {});

    expect(preview.dryRun).toBe(true);
    expect(preview.backend).toBe("cron");
    expect(preview.adds.map((op) => op.id).sort()).toEqual(["alpha", "beta"]);
    expect(preview.updates).toEqual([]);
    expect(preview.removes).toEqual([]);
    expect(preview.hasRemovals).toBe(false);

    // ABSOLUTE SAFETY REQUIREMENT: zero durable writes.
    expect(exec.writeCalls).toBe(0);
    expect(exec.current()).toBe("");
  });

  test("previews an update for a drifted schedule with zero writes", async () => {
    const exec = spyingMemoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *");
    await akmTasksSync({ backend });
    const afterInstall = exec.current();
    expect(exec.writeCalls).toBe(1);

    writeTask("alpha", "45 */6 * * *");
    const preview = await akmTasksSyncPlan({ backend }, undefined, {});

    expect(preview.adds).toEqual([]);
    expect(preview.updates.map((op) => op.id)).toEqual(["alpha"]);
    expect(preview.updates[0]?.installedFingerprint).toContain("*/15 * * * *");
    expect(preview.updates[0]?.expectedFingerprint).toContain("45 */6 * * *");
    expect(preview.updates[0]?.installedFingerprint).not.toBe(preview.updates[0]?.expectedFingerprint);
    expect(preview.removes).toEqual([]);
    expect(preview.hasRemovals).toBe(false);

    // The install above is the ONLY write; dry-run must not add a second one,
    // and the crontab content must be byte-identical to before the dry run.
    expect(exec.writeCalls).toBe(1);
    expect(exec.current()).toBe(afterInstall);
  });

  test("previews a removal with its owning bundle, zero writes, and hasRemovals: true", async () => {
    const exec = spyingMemoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *");
    writeTask("gamma", "0 5 * * *");
    await akmTasksSync({ backend });
    const afterInstall = exec.current();
    const writesAfterInstall = exec.writeCalls;
    expect(writesAfterInstall).toBeGreaterThan(0);

    fs.rmSync(path.join(tasksDir, "gamma.yml"));
    const preview = await akmTasksSyncPlan({ backend }, undefined, {});

    expect(preview.adds).toEqual([]);
    expect(preview.updates).toEqual([]);
    expect(preview.removes).toHaveLength(1);
    const removal = preview.removes[0]!;
    expect(removal.id).toBe("gamma");
    expect(removal.kind).toBe("remove");
    expect(typeof removal.nativeId).toBe("string");
    // Owning-bundle attribution (#846 data, threaded onto the remove op for
    // #849): this is a primary-bundle sync, so the removal's owner is the
    // resolved path of the same stash the sync is scoped to.
    expect(removal.ownerBundlePath).toBe(path.resolve(stashDir));
    expect(preview.hasRemovals).toBe(true);

    // ABSOLUTE SAFETY REQUIREMENT: the orphaned entry is still present in
    // the "crontab" afterward — dry-run computed the removal but never
    // applied it.
    expect(exec.writeCalls).toBe(writesAfterInstall);
    expect(exec.current()).toBe(afterInstall);
    expect(exec.current()).toContain("task run gamma");
  });

  test("a config without scheduler.enabled plans no removals and writes nothing on --dry-run", async () => {
    const exec = spyingMemoryExec();
    const backend = backendFor(exec);
    writeTask("orphan", "*/15 * * * *");
    await akmTasksSync({ backend });
    const afterInstall = exec.current();
    const writesAfterInstall = exec.writeCalls;
    expect(afterInstall).toContain("task run orphan");

    // A pre-0.9.17 config has no list at all: the installed row is the choice.
    const { scheduler: _dropped, ...withoutList } = loadConfig();
    saveConfig(withoutList);
    resetConfigCache();

    const preview = await akmTasksSyncPlan({ backend });
    expect(preview.removes).toEqual([]);
    expect(preview.hasRemovals).toBe(false);
    // Dry-run never writes: the scheduler is untouched and the list is still unwritten.
    expect(exec.writeCalls).toBe(writesAfterInstall);
    expect(exec.current()).toBe(afterInstall);
    expect(schedulerEnabledRefs(loadConfig())).toBeUndefined();

    // An explicit empty list is a choice: the same state now plans the removal.
    saveConfig({ ...loadConfig(), scheduler: { enabled: [] } });
    resetConfigCache();
    const previewEmpty = await akmTasksSyncPlan({ backend });
    expect(previewEmpty.removes.map((op) => op.id)).toEqual(["orphan"]);
    expect(previewEmpty.hasRemovals).toBe(true);
  });

  test("reports unchanged with hasRemovals: false and zero writes on a no-op re-sync", async () => {
    const exec = spyingMemoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *");
    await akmTasksSync({ backend });
    expect(exec.writeCalls).toBe(1);

    const preview = await akmTasksSyncPlan({ backend }, undefined, {});

    expect(preview.adds).toEqual([]);
    expect(preview.updates).toEqual([]);
    expect(preview.removes).toEqual([]);
    expect(preview.unchanged).toEqual(["alpha"]);
    expect(preview.hasRemovals).toBe(false);
    expect(exec.writeCalls).toBe(1);
  });

  test("a real (non-dry-run) sync DOES write — the control for the zero-write assertions above", async () => {
    const exec = spyingMemoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *");

    await akmTasksSync({ backend });

    expect(exec.writeCalls).toBe(1);
    expect(exec.current()).toContain("task run alpha");
  });

  // Real-world crash regression: an installed cron entry whose invocation
  // lacks `--bundle` (the pre-`--bundle` shape written by older akm
  // releases, mirroring tests/integration/tasks-sync.test.ts's "reconciles a
  // pre-`--bundle` native entry instead of refusing it as an unproven owner")
  // is now correctly recognized as akm-owned, so `akmTasksSyncPlan` computes
  // a real preview for it instead of throwing "unproven owner" — and that
  // preview is `Object.freeze`d by `renderSchedulerPlanPreview`. Routing it
  // through `shapeForCommand`, exactly as `akm task sync --dry-run`'s CLI
  // leaf does via `output()`, must not crash on the frozen result.
  test("previews a pre-`--bundle` native entry through the CLI output path without crashing", async () => {
    const exec = spyingMemoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *");
    await akmTasksSync({ backend });
    const stripped = exec.current().replace(/--bundle\s+\S+\s+/, "");
    expect(stripped).not.toBe(exec.current());
    exec.write(stripped);
    const beforePreview = exec.current();

    const preview = await akmTasksSyncPlan({ backend }, undefined, {});

    expect(preview.updates.map((op) => op.id)).toEqual(["alpha"]);
    expect(Object.isFrozen(preview)).toBe(true);

    let shaped: Record<string, unknown> | undefined;
    expect(() => {
      shaped = shapeForCommand("task-sync-dry-run", preview, "normal") as Record<string, unknown>;
    }).not.toThrow();
    expect(shaped?.shape).toBe("task-sync-dry-run");
    expect(shaped?.schemaVersion).toBe(1);

    // Still zero durable writes.
    expect(exec.current()).toBe(beforePreview);
  });
});

describe("taskSyncDryRunExitCode — CLI exit-code contract", () => {
  test("is EXIT_CODES.GENERAL (non-zero) when the plan has removals", () => {
    expect(taskSyncDryRunExitCode({ hasRemovals: true })).toBe(1);
  });

  test("is undefined (leaves the default success exit code) when the plan has no removals", () => {
    expect(taskSyncDryRunExitCode({ hasRemovals: false })).toBeUndefined();
  });

  // #867: task sync degrades — a source that fails to parse/prepare no
  // longer rejects the whole desired set, but its presence must still fail
  // the CLI's exit code so the breakage stays visible.
  test("is EXIT_CODES.GENERAL (non-zero) when the plan has failures, even with no removals", () => {
    expect(taskSyncDryRunExitCode({ hasRemovals: false, failures: [{ path: "tasks/bad.yml", reason: "boom" }] })).toBe(
      1,
    );
  });

  test("is undefined when the plan has no removals and no failures", () => {
    expect(taskSyncDryRunExitCode({ hasRemovals: false, failures: [] })).toBeUndefined();
  });
});

// #907: `akm task validate`'s exit-code contract — only current-schema
// `valid` succeeds; migration-required and invalid inputs are non-zero.
describe("taskValidateExitCode — CLI exit-code contract", () => {
  test("is undefined (leaves the default success exit code) for 'valid'", () => {
    expect(taskValidateExitCode({ outcome: "valid" })).toBeUndefined();
  });

  test("is EXIT_CODES.GENERAL (non-zero) for 'blocked'", () => {
    expect(taskValidateExitCode({ outcome: "blocked" })).toBe(1);
  });

  test("is EXIT_CODES.GENERAL (non-zero) for 'invalid'", () => {
    expect(taskValidateExitCode({ outcome: "invalid" })).toBe(1);
  });

  test("is EXIT_CODES.GENERAL (non-zero) for 'not-a-task'", () => {
    expect(taskValidateExitCode({ outcome: "not-a-task" })).toBe(1);
  });
});

// #867: `akm task sync` degrades — a task/workflow that fails to
// parse/prepare is excluded and reported, never poisons the whole set.
describe("akmTasksSync / akmTasksSyncPlan — degrade on a bad source (#867)", () => {
  function writeUnconvertibleV2Task(id: string): void {
    // A genuinely unmigratable v2 shape (a bare, non-`akm` executable with
    // no path and no `env` wrapper) — still blocked after #867's fix, and
    // used here to prove the OTHER good tasks still sync.
    fs.writeFileSync(
      path.join(tasksDir, `${id}.yml`),
      `version: 2\nschedule: '*/15 * * * *'\ncommand: echo unconvertible\n`,
      "utf8",
    );
    setSchedulerRefEnabled(`stash//tasks/${id}`, true);
  }

  test("akmTasksSyncPlan --dry-run reconciles the tasks that parse and reports the one that doesn't", async () => {
    const exec = spyingMemoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *");
    writeUnconvertibleV2Task("broken");

    const preview = await akmTasksSyncPlan({ backend }, undefined, {});

    expect(preview.adds.map((op) => op.id)).toEqual(["alpha"]);
    expect(preview.failures).toHaveLength(1);
    expect(preview.failures[0]?.path).toContain("broken.yml");
    expect(taskSyncDryRunExitCode(preview)).toBe(1);
    // ABSOLUTE SAFETY REQUIREMENT still holds even when the plan has failures.
    expect(exec.writeCalls).toBe(0);
  });

  test("akmTasksSync reconciles the tasks that parse and reports the one that doesn't", async () => {
    const exec = spyingMemoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *");
    writeUnconvertibleV2Task("broken");

    const result = await akmTasksSync({ backend });

    expect(result.installed).toEqual(["alpha"]);
    // #906: the live-sync envelope must report failures under the same
    // `failures` key the `--dry-run` preview uses above — no separate
    // `failed` name for the same concept.
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.path).toContain("broken.yml");
    expect(exec.writeCalls).toBe(1);
    expect(exec.current()).toContain("task run alpha");
  });
});
