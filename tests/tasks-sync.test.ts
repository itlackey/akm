// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm task sync` schedule-drift detection (0.8.4 hotfix).
 *
 * Before the fix, sync classified any task already present in the scheduler as
 * "unchanged" without comparing its cron line, so a changed `schedule:` in the
 * .yml never reached the crontab. These tests drive the real `akmTasksSync`
 * with an injected cron backend (in-memory crontab) and assert that a changed
 * schedule is detected and reinstalled.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmTasksAdd, akmTasksDisable, akmTasksSync } from "../src/commands/tasks/tasks";
import { loadConfig, resetConfigCache, saveConfig } from "../src/core/config/config";
import { isSchedulerRefEnabled, schedulerEnabledRefs, setSchedulerRefEnabled } from "../src/tasks/activation-config";
import { CRON_BACKEND, type CronExec, type CronExecResult } from "../src/tasks/backends/cron";
import type { SchedulerBackend } from "../src/tasks/backends/types";
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

function memoryExec(initial = ""): CronExec & { current: () => string } {
  let store = initial;
  return {
    read: (): CronExecResult => ({ status: 0, stdout: store, stderr: "" }),
    write: (content: string): CronExecResult => {
      store = content;
      return { status: 0, stdout: "", stderr: "" };
    },
    current: () => store,
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

describe("akmTasksSync — schedule drift", () => {
  const backendFor = (exec: CronExec) => {
    // #846: belongsToBundle now confirms a primary-bundle entry's owning
    // path from its own scheduler-context descriptor. This backend never
    // routes through the real launcher-eligibility path (no
    // `schedulerRuntime` deps injected), so install operations fall back to
    // CRON_BACKEND's own default context — write that descriptor for real,
    // matching it exactly, so it resolves on the next sync.
    writeSchedulerContextDescriptor(schedulerContextDescriptor(resolveScheduledTaskContext()));
    return CRON_BACKEND({
      exec,
      fs: { ensureDir() {} },
      logDir: "/var/log/akm",
      akmArgv: ["/usr/local/bin/akm"],
      envPath: false,
    });
  };

  const backendForPath = (exec: CronExec, envPath: string) => {
    // PATH no longer lives in the descriptor (it is the crontab's `PATH=`
    // header), so the same descriptor serves every ambient PATH.
    writeSchedulerContextDescriptor(schedulerContextDescriptor(resolveScheduledTaskContext()));
    return CRON_BACKEND({
      exec,
      fs: { ensureDir() {} },
      logDir: "/var/log/akm",
      akmArgv: ["/usr/local/bin/akm"],
      envPath,
    });
  };

  test("installs missing, then reports unchanged on a no-op re-sync", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *");
    writeTask("beta", "0 2 * * *");

    const first = await akmTasksSync({ backend });
    expect(first.installed.sort()).toEqual(["alpha", "beta"]);
    expect(first.updated).toEqual([]);

    const second = await akmTasksSync({ backend });
    expect(second.installed).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.unchanged.sort()).toEqual(["alpha", "beta"]);
    expect(exec.current()).toContain("task run alpha --bundle stash --scheduled");
    expect(exec.current()).toContain("task run beta --bundle stash --scheduled");
  });

  test("adding one task preserves existing bindings captured under a different ambient PATH", async () => {
    const exec = memoryExec();
    writeTask("alpha", "*/15 * * * *");
    await akmTasksSync({ backend: backendForPath(exec, "/captured/bin:/usr/bin") });
    const alphaBefore = exec.current().match(/# akm:task alpha BEGIN[\s\S]*?# akm:task alpha END/)?.[0];

    writeTask("beta", "0 2 * * *");
    const result = await akmTasksSync({ backend: backendForPath(exec, "/ambient/bin:/usr/bin") });

    expect(result.installed).toEqual(["beta"]);
    expect(result.updated).toEqual([]);
    expect(result.unchanged).toEqual(["alpha"]);
    expect(exec.current().match(/# akm:task alpha BEGIN[\s\S]*?# akm:task alpha END/)?.[0]).toBe(alphaBefore);
    // The one managed PATH line follows the latest write; alpha's row does not.
    expect(exec.current()).toContain("PATH=/ambient/bin:/usr/bin");
    expect(exec.current()).not.toContain("PATH=/captured/bin:/usr/bin");
  });

  test("sync restores a locally enabled task that was manually disabled in crontab", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *", true);
    await akmTasksSync({ backend });
    exec.write(exec.current().replace(/^([^#\n].*task run alpha.*)$/m, "# akm:disabled $1"));

    writeTask("beta", "0 2 * * *");
    const result = await akmTasksSync({ backend });

    expect(result.installed).toEqual(["beta"]);
    expect(result.updated).toEqual(["alpha"]);
    expect(result.unchanged).toEqual([]);
    expect(exec.current()).not.toContain("# akm:disabled */15 * * * *");
  });

  test("detects a changed schedule and reinstalls it (the bug fix)", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *");
    writeTask("beta", "0 2 * * *");
    await akmTasksSync({ backend });

    // Edit beta's schedule on disk, as `akm task` never rewrites it.
    writeTask("beta", "45 */6 * * *");

    const result = await akmTasksSync({ backend });
    expect(result.updated).toEqual(["beta"]);
    expect(result.unchanged).toEqual(["alpha"]);
    expect(result.installed).toEqual([]);
    // The crontab now carries the new schedule, not the stale one.
    expect(exec.current()).toContain("45 */6 * * * /usr/local/bin/akm --scheduler-context");
    expect(exec.current()).toContain("task run beta --bundle");
    expect(exec.current()).not.toContain("0 2 * * * /usr/local/bin/akm");
  });

  test("removing local activation unschedules the task without editing source", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *", true);
    await akmTasksSync({ backend });
    expect(exec.current()).not.toContain("# akm:disabled");

    writeTask("alpha", "*/15 * * * *", false);
    const result = await akmTasksSync({ backend });
    expect(result.removed).toEqual(["alpha"]);
    expect(exec.current()).not.toContain("task run alpha --bundle");
  });

  test("`akm task disable` also removes a granted, installed binding", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *", true);
    await akmTasksSync({ backend });
    expect(exec.current()).not.toContain("# akm:disabled");

    const disabled = await akmTasksDisable("alpha", {}, { backend });
    expect(disabled.sync.removed).toEqual(["alpha"]);
    expect(exec.current()).not.toContain("task run alpha --bundle");
  });

  test("`akm task add --disabled` does not re-grant or reinstall the task it just disabled", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *", true);
    await akmTasksSync({ backend });
    expect(exec.current()).toContain("task run alpha --bundle stash --scheduled");

    const result = await akmTasksAdd(
      { id: "alpha", schedule: "0 3 * * *", command: "echo replacement", disabled: true, force: true },
      { backend, commitBoundary() {} },
    );

    expect(result.enabled).toBe(false);
    expect(isSchedulerRefEnabled(loadConfig(), "stash//tasks/alpha")).toBe(false);
    expect(exec.current()).not.toContain("task run alpha --bundle stash --scheduled");
  });

  test("a config without scheduler.enabled takes the installed rows with a backing file as the host's choice", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    writeTask("orphan", "*/5 * * * *", true);
    await akmTasksSync({ backend });
    expect(exec.current()).toContain("task run orphan");

    // A pre-0.9.17 config has no list at all: the installed row is the choice.
    const { scheduler: _dropped, ...withoutList } = loadConfig();
    saveConfig(withoutList);
    resetConfigCache();
    expect(schedulerEnabledRefs(loadConfig())).toBeUndefined();

    const result = await akmTasksSync({ backend });
    expect(result.removed).not.toContain("orphan");
    expect(exec.current()).toContain("task run orphan");
    expect(schedulerEnabledRefs(loadConfig())).toContain("stash//tasks/orphan");

    // An explicit empty list is a choice, not a missing one.
    saveConfig({ ...loadConfig(), scheduler: { enabled: [] } });
    resetConfigCache();
    const removed = await akmTasksSync({ backend });
    expect(removed.removed).toEqual(["orphan"]);
    expect(exec.current()).not.toContain("task run orphan");
    expect(schedulerEnabledRefs(loadConfig())).toEqual([]);
  });

  test("an installed row with no backing file is removed, not adopted as a choice", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    writeTask("ghost", "*/5 * * * *", true);
    await akmTasksSync({ backend });
    expect(exec.current()).toContain("task run ghost");

    const { scheduler: _dropped, ...withoutList } = loadConfig();
    saveConfig(withoutList);
    resetConfigCache();
    fs.rmSync(path.join(tasksDir, "ghost.yml"));

    const result = await akmTasksSync({ backend });
    expect(result.removed).toEqual(["ghost"]);
    expect(exec.current()).not.toContain("task run ghost");
    expect(schedulerEnabledRefs(loadConfig())).toEqual([]);
  });

  test("removes orphaned scheduler entries with no backing file", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *");
    writeTask("gamma", "0 5 * * *");
    await akmTasksSync({ backend });

    fs.rmSync(path.join(tasksDir, "gamma.yml"));
    const result = await akmTasksSync({ backend });
    expect(result.removed).toEqual(["gamma"]);
    expect(exec.current()).not.toContain("task run gamma");
    expect(exec.current()).toContain("task run alpha");
  });

  // #867: degrades — the unversioned task is reported and excluded rather
  // than installed, and never poisons a sync where it's the only source.
  test("reports an unversioned task instead of installing it", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    fs.writeFileSync(
      path.join(tasksDir, "legacy.yml"),
      'schedule: "@hourly"\ncommand: akm improve --profile quick --auto-accept safe\nenabled: true\n',
      "utf8",
    );
    setSchedulerRefEnabled("stash//tasks/legacy", true);

    const result = await akmTasksSync({ backend });
    expect(result.installed).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.reason).toMatch(/version is required and must be 4/);
    expect(exec.current()).toBe("");
  });

  // A malformed native artifact does not prove its logical owner. Even when
  // its marker resembles the desired task, sync must not overwrite it. This
  // is the only configured bundle, so the sync (unscoped) reports the
  // failure on an otherwise-empty plan instead of installing/updating
  // anything — never a whole-sync throw, and the crontab stays untouched.
  test("preserves the crontab and reports a scheduler invocation without a context descriptor", async () => {
    const exec = memoryExec(
      [
        "# akm:task alpha BEGIN",
        "# akm:disabled */15 * * * * /usr/local/bin/akm tasks run alpha >> /var/log/akm/alpha.log 2>&1",
        "# akm:task alpha END",
        "",
      ].join("\n"),
    );
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *", true);
    const prior = exec.current();

    const result = await akmTasksSync({ backend });

    expect(result.installed).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.failures.some((failure) => /native scheduler artifact|unproven owner/i.test(failure.reason))).toBe(
      true,
    );
    expect(exec.current()).toBe(prior);
  });

  test("preserves the crontab and reports a pre-rename `tasks run` artifact with unproven ownership", async () => {
    const exec = memoryExec(
      [
        "# akm:task alpha BEGIN",
        `*/15 * * * * /usr/local/bin/akm --scheduler-context /var/lib/akm/context/one.json tasks run alpha --scheduled >> /var/log/akm/alpha.log 2>&1`,
        "# akm:task alpha END",
        "",
      ].join("\n"),
    );
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *", true);
    const prior = exec.current();

    const result = await akmTasksSync({ backend });

    expect(result.installed).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.failures.some((failure) => /native scheduler artifact|unproven owner/i.test(failure.reason))).toBe(
      true,
    );
    expect(exec.current()).toBe(prior);
  });

  // A pre-#867 crontab entry (written by an older akm, before `--bundle` was
  // added to the installed invocation) is still akm's own proven owner: it
  // sits inside the `# akm:task alpha BEGIN/END` markers and carries a valid
  // `--scheduler-context` descriptor for task "alpha". Sync must reconcile
  // it to the current invocation shape, not refuse the whole run.
  test("reconciles a pre-`--bundle` native entry instead of refusing it as an unproven owner", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *");
    await akmTasksSync({ backend });
    const before = exec.current();
    const stripped = before.replace(/--bundle\s+\S+\s+/, "");
    expect(stripped).not.toBe(before);
    exec.write(stripped);

    const result = await akmTasksSync({ backend });

    expect(result.updated).toEqual(["alpha"]);
    expect(exec.current()).toContain("task run alpha --bundle");
  });

  test("a failed replacement leaves the prior native definition active", async () => {
    let store = "";
    let failNextWrite = false;
    const exec: CronExec & { current: () => string } = {
      read: () => ({ status: 0, stdout: store, stderr: "" }),
      write(content) {
        store = content;
        if (failNextWrite) {
          failNextWrite = false;
          return { status: 1, stdout: "", stderr: "injected replacement failure" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      current: () => store,
    };
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *");
    await akmTasksSync({ backend });
    const prior = exec.current();
    writeTask("alpha", "45 */6 * * *");
    failNextWrite = true;

    await expect(akmTasksSync({ backend })).rejects.toThrow("injected replacement failure");

    expect(exec.current()).toBe(prior);
    expect(exec.current()).toContain("*/15 * * * *");
    expect(exec.current()).not.toContain("45 */6 * * *");
  });
});

// U2: writes (and therefore scheduler state) are only ever defined for
// filesystem/git sources (adaptConfiguredSource, src/core/write-source.ts).
// An enabled website/npm bundle must not crash unscoped `akm task sync`, and
// a scoped sync naming one must fail with a clear usage error rather than
// the write-target ConfigError that used to escape from resolveWriteTarget.
describe("akmTasksSync — website/npm bundles cannot carry scheduler state", () => {
  const backendFor = (exec: CronExec) => {
    writeSchedulerContextDescriptor(schedulerContextDescriptor(resolveScheduledTaskContext()));
    return CRON_BACKEND({
      exec,
      fs: { ensureDir() {} },
      logDir: "/var/log/akm",
      akmArgv: ["/usr/local/bin/akm"],
      envPath: false,
    });
  };

  beforeEach(() => {
    writeSandboxConfig({
      bundles: {
        stash: { path: stashDir, writable: true },
        docs: { website: { url: "https://example.test/docs/" } },
      },
      defaultBundle: "stash",
    });
  });

  test("unscoped sync installs the filesystem bundle's task and skips the enabled website bundle", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *");

    const result = await akmTasksSync({ backend });

    expect(result.installed).toEqual(["alpha"]);
    expect(exec.current()).toContain("task run alpha --bundle stash --scheduled");
  });

  test("scoped sync against the website bundle fails with a clear usage error, not a write-target ConfigError", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *");

    await expect(akmTasksSync({ backend }, "docs")).rejects.toThrow(
      /Bundle "docs" has kind "website"; task scheduling is only supported for filesystem and git bundles\./,
    );
  });
});

// An unscoped (multi-bundle) sync must isolate one bundle's own anomaly: one
// bundle's `tasks/` root being a symlink (or any other whole-bundle
// source-collection failure) must not throw out of `buildSchedulerSyncPlan`'s
// per-bundle loop and abort every OTHER selected bundle's sync too. A scoped
// sync naming exactly that bundle is a different case: its one failure IS the
// whole operation, so it rethrows instead of being caught and reported.
describe("akmTasksSync — one bundle's poisoned source set does not cost every OTHER bundle its sync", () => {
  const backendFor = (exec: CronExec) => {
    writeSchedulerContextDescriptor(schedulerContextDescriptor(resolveScheduledTaskContext()));
    return CRON_BACKEND({
      exec,
      fs: { ensureDir() {} },
      logDir: "/var/log/akm",
      akmArgv: ["/usr/local/bin/akm"],
      envPath: false,
    });
  };

  function makePoisonedBundle(): { poisonedDir: string; cleanup: () => void } {
    const poisonedDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-tasks-sync-poisoned-"));
    const poisonedTasksTarget = fs.mkdtempSync(path.join(os.tmpdir(), "akm-tasks-sync-poisoned-target-"));
    // A `tasks/` root that is itself a symlink: SchedulerSourceCollector's
    // constructor throws for this bundle (guarded reads require a
    // no-follow owner) — a whole-bundle source-collection failure, not a
    // single source's.
    fs.symlinkSync(poisonedTasksTarget, path.join(poisonedDir, "tasks"));
    return {
      poisonedDir,
      cleanup: () => {
        fs.rmSync(poisonedDir, { recursive: true, force: true });
        fs.rmSync(poisonedTasksTarget, { recursive: true, force: true });
      },
    };
  }

  test("the healthy bundle still installs its task; the poisoned bundle is reported, not thrown", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    const poisoned = makePoisonedBundle();

    try {
      writeSandboxConfig({
        bundles: {
          stash: { path: stashDir, writable: true },
          poisoned: { path: poisoned.poisonedDir, writable: true },
        },
        defaultBundle: "stash",
      });
      writeTask("alpha", "*/15 * * * *");

      const result = await akmTasksSync({ backend });

      expect(result.installed).toEqual(["alpha"]);
      expect(exec.current()).toContain("task run alpha --bundle stash --scheduled");
      expect(result.failures.some((failure) => failure.path === "poisoned" && /symbolic/i.test(failure.reason))).toBe(
        true,
      );
    } finally {
      poisoned.cleanup();
    }
  });

  test("a sync scoped to the poisoned bundle rethrows its original usage error instead of reporting it", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    const poisoned = makePoisonedBundle();

    try {
      writeSandboxConfig({
        bundles: {
          stash: { path: stashDir, writable: true },
          poisoned: { path: poisoned.poisonedDir, writable: true },
        },
        defaultBundle: "stash",
      });

      await expect(akmTasksSync({ backend }, "poisoned")).rejects.toMatchObject({
        name: "UsageError",
        code: "PATH_ESCAPE_VIOLATION",
      });
    } finally {
      poisoned.cleanup();
    }
  });

  test("an unscoped sync whose only write-capable bundle is poisoned returns a plan reporting it, instead of throwing", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    const poisoned = makePoisonedBundle();

    try {
      writeSandboxConfig({
        bundles: {
          poisoned: { path: poisoned.poisonedDir, writable: true },
        },
        defaultBundle: "poisoned",
      });

      const result = await akmTasksSync({ backend });

      expect(result.installed).toEqual([]);
      expect(result.failures.some((failure) => failure.path === "poisoned" && /symbolic/i.test(failure.reason))).toBe(
        true,
      );
    } finally {
      poisoned.cleanup();
    }
  });

  test("a scoped sync against an unconfigured bundle rethrows the original usage error, not a config error", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);

    await expect(akmTasksSync({ backend }, "nope")).rejects.toMatchObject({
      name: "UsageError",
      code: "INVALID_FLAG_VALUE",
    });
  });
});

// A backend-wide incoherent or duplicate native inspection can't be
// attributed to any one bundle, so it must still hard-fail the whole sync —
// even when the bundle whose desired set happens to finalize first would
// otherwise succeed.
describe("akmTasksSync — an incoherent backend inspection still hard-fails the whole sync", () => {
  test("a duplicate native artifact across two bundles' installed rows throws, not reported per bundle", async () => {
    const secondDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-tasks-sync-second-"));
    fs.mkdirSync(path.join(secondDir, "tasks"), { recursive: true });
    try {
      writeSandboxConfig({
        bundles: {
          stash: { path: stashDir, writable: true },
          other: { path: secondDir, writable: true },
        },
        defaultBundle: "stash",
      });

      const duplicateNativeId = "dup-native-id";
      const artifacts = [
        {
          nativeId: duplicateNativeId,
          bindingId: "a",
          invocation: ["task", "run", "a", "--bundle", "stash", "--scheduled"],
          fingerprint: "fingerprint-a",
        },
        {
          nativeId: duplicateNativeId,
          bindingId: "b",
          invocation: ["task", "run", "b", "--bundle", "other", "--scheduled"],
          fingerprint: "fingerprint-b",
        },
      ];
      const backend: SchedulerBackend = {
        name: "cron",
        install() {},
        uninstall() {},
        setEnabled() {},
        list: () => [],
        listNativeArtifacts: () => artifacts,
        inspectBindings: () => ({ installed: [], artifacts }),
      };

      await expect(akmTasksSync({ backend })).rejects.toMatchObject({
        name: "UsageError",
        code: "RESOURCE_ALREADY_EXISTS",
      });
    } finally {
      fs.rmSync(secondDir, { recursive: true, force: true });
    }
  });
});

// A disabled bundle's installed rows are removed one at a time
// (`inactiveBundleRemovalOperations`): a row this process can't safely
// attribute a removal for (no invocation, no exact fingerprint) must not
// cost every OTHER disabled-bundle row its own, otherwise-clean removal.
describe("akmTasksSync — inactive-bundle removal isolates one unattributable installed row", () => {
  test("the attributable row is removed; the unattributable row is reported instead of aborting both", async () => {
    writeSandboxConfig({
      bundles: {
        stash: { path: stashDir, writable: true },
        archived: { path: path.join(stashDir, "..", "archived"), writable: true, enabled: false },
      },
      defaultBundle: "stash",
    });

    const goodInvocation = ["task", "run", "good", "--bundle", "archived", "--scheduled"];
    const good = {
      id: "good",
      nativeId: "good",
      target: "archived",
      binding: ["/opt/akm"],
      contextPath: "/data/context.json",
      invocation: goodInvocation,
      signature: "sig-good",
    };
    const goodArtifact = { nativeId: "good", bindingId: "good", invocation: goodInvocation, fingerprint: "sig-good" };
    // No `invocation`: `buildSchedulerRemoveOperation` cannot prove an exact
    // native owner for this row and throws — the same throw sync's own
    // removal loop already isolates per binding, now also isolated here.
    const bad = {
      id: "bad",
      nativeId: "bad",
      target: "archived",
      binding: ["/opt/akm"],
      contextPath: "/data/context.json",
    };
    const badArtifact = { nativeId: "bad", bindingId: "bad", fingerprint: "sig-bad" };

    const installed = [good, bad];
    const artifacts = [goodArtifact, badArtifact];
    const backend: SchedulerBackend = {
      name: "cron",
      install() {},
      uninstall() {},
      setEnabled() {},
      list: () => installed,
      listNativeArtifacts: () => artifacts,
      inspectBindings: () => ({ installed, artifacts }),
      snapshotBindings: (ids) => ({
        nativeIds: [...ids],
        artifacts: artifacts.filter((a) => ids.includes(a.nativeId)),
      }),
      restoreBindings: () => {},
    };

    const result = await akmTasksSync({ backend });

    expect(result.removed).toEqual(["good"]);
    expect(
      result.failures.some(
        (failure) => failure.path === "bad" && /native scheduler artifact collision/i.test(failure.reason),
      ),
    ).toBe(true);
  });
});
