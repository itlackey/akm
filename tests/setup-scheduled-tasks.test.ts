// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { _setClackForTests } from "../src/cli/clack";
import { akmTasksSync, type TasksSyncResult } from "../src/commands/tasks/tasks";
import { loadConfig, resetConfigCache, saveConfig } from "../src/core/config/config";
import { deleteAssetFromSource, writeAssetToSource } from "../src/core/write-source";
import { buildSetupSteps } from "../src/setup/setup";
import {
  _setScheduledTasksEnvForTests,
  listSetupTaskDefinitions,
  type PreparedSetupTask,
  prepareSetupTaskDefinitions,
  stepScheduledTasks,
} from "../src/setup/steps/tasks";
import { schedulerEnabledRefs, setSchedulerRefEnabled } from "../src/tasks/activation-config";
import { CRON_BACKEND, type CronExec, type CronExecResult } from "../src/tasks/backends/cron";
import { listEmbeddedTasks } from "../src/tasks/embedded";
import type { SchedulerBackendInspection } from "../src/tasks/scheduler-binding";
import {
  resolveScheduledTaskContext,
  schedulerContextDescriptor,
  writeSchedulerContextDescriptor,
} from "../src/tasks/scheduler-invocation";
import { withIsolatedAkmStorage, writeSandboxConfig } from "./_helpers/sandbox";
import { overrideSeam } from "./_helpers/seams";

const state = {
  multiselectReturn: [] as string[],
  textReturns: [] as string[],
  confirmReturn: false,
  confirmCalls: 0,
  multiselectCalls: 0,
  multiselectConfig: undefined as
    | { initialValues?: string[]; options: Array<{ value: string; label: string; hint?: string }> }
    | undefined,
  notes: [] as Array<{ message: string; title?: string }>,
  logs: [] as Array<{ level: "info" | "success" | "warn"; message: string }>,
  events: [] as string[],
  onConfirm: undefined as (() => void) | undefined,
};

function resetClack() {
  state.multiselectReturn = [];
  state.textReturns = [];
  state.confirmReturn = false;
  state.confirmCalls = 0;
  state.multiselectCalls = 0;
  state.multiselectConfig = undefined;
  state.notes = [];
  state.logs = [];
  state.events = [];
  state.onConfirm = undefined;
  overrideSeam(_setScheduledTasksEnvForTests, { isCiEnvironment: () => false, detectServerDefault: () => false });
  overrideSeam(_setClackForTests, {
    isCancel: () => false,
    cancel: () => {},
    multiselect: async (config: {
      initialValues?: string[];
      options: Array<{ value: string; label: string; hint?: string }>;
    }) => {
      state.multiselectCalls += 1;
      state.multiselectConfig = { initialValues: config.initialValues, options: config.options };
      return state.multiselectReturn;
    },
    text: async () => state.textReturns.shift() ?? "",
    select: async () => "",
    confirm: async () => {
      state.confirmCalls += 1;
      state.events.push("confirm");
      state.onConfirm?.();
      return state.confirmReturn;
    },
    spinner: () => ({ start: () => {}, stop: () => {} }),
    log: {
      info: (message: string) => state.logs.push({ level: "info", message }),
      success: (message: string) => state.logs.push({ level: "success", message }),
      warn: (message: string) => state.logs.push({ level: "warn", message }),
      step: () => {},
    },
    intro: () => {},
    outro: () => {},
    note: (message: string, title?: string) => state.notes.push({ message, title }),
  });
}

const EMPTY_SYNC_RESULT: TasksSyncResult = {
  installed: [],
  updated: [],
  removed: [],
  unchanged: [],
  skipped: [],
  backend: "cron",
  failures: [],
};

const EMPTY_INSPECTION: SchedulerBackendInspection = { installed: [], artifacts: [] };
function makeDeps(
  installed: Array<{ id: string; schedule: string; enabled: boolean; description?: string }>,
  syncResult: TasksSyncResult = EMPTY_SYNC_RESULT,
  options: { inspection?: SchedulerBackendInspection } = {},
) {
  const calls = {
    prepared: [] as PreparedSetupTask[][],
    syncCalls: 0,
    inspectInstalledCalls: 0,
  };
  const deps = {
    list: () => installed,
    prepare: async (tasks: PreparedSetupTask[]) => {
      state.events.push("prepare");
      calls.prepared.push(tasks);
      return tasks.length;
    },
    sync: async () => {
      state.events.push("sync");
      calls.syncCalls += 1;
      return syncResult;
    },
    inspectInstalled: async () => {
      calls.inspectInstalledCalls += 1;
      return options.inspection ?? EMPTY_INSPECTION;
    },
  };
  return { deps, calls };
}

describe("stepScheduledTasks", () => {
  beforeEach(resetClack);

  test("reviews every setup-managed task with schedule and enabled state", async () => {
    const { deps, calls } = makeDeps([]);
    state.confirmReturn = true;

    await stepScheduledTasks(deps);

    const options = state.multiselectConfig?.options ?? [];
    expect(options).toHaveLength(10);
    expect(options.find((option) => option.value === "backup")).toBeUndefined();
    expect(options.find((option) => option.value === "improve")?.hint).toContain("0 2 * * *");
    expect(options.find((option) => option.value === "improve")?.hint).toContain("not prepared");
    expect(options.find((option) => option.value === "akm-improve-frequent")?.hint).toContain("40 * * * *");
    expect(state.notes).toHaveLength(1);
    expect(state.notes[0]?.title).toBe("Task Schedule Review");
    expect(state.notes[0]?.message.split("\n")).toHaveLength(10);
    expect(state.notes[0]?.message).toContain("core/improve: disabled | 0 2 * * *");
    expect(state.notes[0]?.message).toContain("improve/akm-improve-frequent: disabled | 40 * * * *");
    expect(calls.prepared[0]).toHaveLength(10);
    expect(calls.prepared[0]?.every((task) => task.enabled === false)).toBe(true);
  });

  test("preselects the server-suggested nightly sweep on a detected server install", async () => {
    overrideSeam(_setScheduledTasksEnvForTests, { isCiEnvironment: () => false, detectServerDefault: () => true });
    const { deps } = makeDeps([]);
    state.confirmReturn = true;

    await stepScheduledTasks(deps);

    expect(state.multiselectConfig?.initialValues).toEqual(["akm-improve-nightly"]);
  });

  test("preserves existing schedules and includes custom definitions in the review", async () => {
    const { deps, calls } = makeDeps([
      { id: "improve", schedule: "30 1 * * *", enabled: true },
      { id: "team-review", schedule: "@daily", enabled: false, description: "Review team changes" },
    ]);
    state.multiselectReturn = ["improve"];
    state.confirmReturn = true;

    await stepScheduledTasks(deps);

    expect(state.multiselectConfig?.initialValues).toEqual(["improve"]);
    expect(state.multiselectConfig?.options.find((option) => option.value === "improve")?.hint).toContain("30 1 * * *");
    expect(calls.prepared[0]?.find((task) => task.task.id === "improve")?.schedule).toBe("30 1 * * *");
    expect(state.notes[0]?.message).toContain("team-review: disabled | @daily | Review team changes");
  });

  test("does not mutate task files or the scheduler before the activation confirmation", async () => {
    const { deps, calls } = makeDeps([]);
    state.multiselectReturn = ["sync"];
    state.textReturns = ["*/15 * * * *"];
    state.confirmReturn = true;
    state.onConfirm = () => {
      expect(state.notes).toHaveLength(1);
      // The read-only inventory used to pre-check the review has already run by now, but nothing
      // that mutates task files or scheduler state has.
      expect(calls.inspectInstalledCalls).toBe(1);
      expect(calls.prepared).toHaveLength(0);
      expect(calls.syncCalls).toBe(0);
    };

    await stepScheduledTasks(deps);

    expect(state.events).toEqual(["confirm", "prepare", "sync"]);
    expect(calls.syncCalls).toBe(1);
    expect(calls.prepared[0]?.find((task) => task.task.id === "sync")).toMatchObject({
      schedule: "*/15 * * * *",
      enabled: true,
      installed: false,
    });
  });

  test("confirmed activation performs one scheduler sync", async () => {
    const { deps, calls } = makeDeps([{ id: "improve", schedule: "0 2 * * *", enabled: true }]);
    state.multiselectReturn = ["improve"];
    state.confirmReturn = true;

    await stepScheduledTasks(deps);

    expect(state.confirmCalls).toBe(1);
    expect(calls.syncCalls).toBe(1);
  });

  // Reviewer finding: carry-forward must run after the operator's confirmation
  // and before `prepare` revokes every managed ref the operator left unchecked, so a grant carried
  // forward for a ref the operator just deselected is still removed by that same `prepare` call.
  test("reports every skipped task and no activation success for a partial sync", async () => {
    const { deps } = makeDeps([], {
      ...EMPTY_SYNC_RESULT,
      installed: ["improve"],
      skipped: [{ id: "version-check", reason: "runtime binding is stale" }],
    });
    state.confirmReturn = true;

    await stepScheduledTasks(deps);

    expect(state.logs).toContainEqual({
      level: "warn",
      message: 'Task "version-check" was not activated: runtime binding is stale',
    });
    expect(state.logs.some((entry) => entry.level === "success" && entry.message.includes("activated"))).toBe(false);
    expect(state.logs.at(-1)?.message).toContain("installed `akm setup`");
    expect(state.logs.at(-1)?.message).toContain("akm task sync --rebind");
    expect(state.logs.at(-1)?.message).toContain("activation was incomplete");
  });

  test("reports all-skipped activation as a failure without success", async () => {
    const { deps } = makeDeps([], {
      ...EMPTY_SYNC_RESULT,
      skipped: [
        { id: "improve", reason: "cannot resolve installed runtime" },
        { id: "sync", reason: "scheduler context descriptor is invalid" },
      ],
    });
    state.confirmReturn = true;

    await stepScheduledTasks(deps);

    expect(state.logs.filter((entry) => entry.message.includes("was not activated"))).toHaveLength(2);
    expect(state.logs.some((entry) => entry.level === "success" && entry.message.includes("activated"))).toBe(false);
    expect(state.logs.at(-1)?.message).toContain("No task schedules were activated");
    expect(state.logs.at(-1)?.message).toContain("akm task sync --rebind");
  });

  test("list failures stop review before prompts or mutations", async () => {
    const { deps, calls } = makeDeps([]);
    const error = new Error("Cannot review malformed task definition");

    await expect(stepScheduledTasks({ ...deps, list: () => Promise.reject(error) })).rejects.toBe(error);

    expect(state.multiselectCalls).toBe(0);
    expect(state.confirmCalls).toBe(0);
    expect(calls.prepared).toHaveLength(0);
    expect(calls.syncCalls).toBe(0);
  });

  test("declined activation leaves task files and scheduler unchanged", async () => {
    const { deps, calls } = makeDeps([]);
    state.multiselectReturn = ["extract"];
    state.textReturns = ["0 5 * * *"];
    state.confirmReturn = false;

    await stepScheduledTasks(deps);

    expect(calls.prepared).toHaveLength(0);
    expect(calls.syncCalls).toBe(0);
    expect(state.events).toEqual(["confirm"]);
  });

  test("non-interactive setup neither prepares definitions nor mutates the scheduler", async () => {
    const { deps, calls } = makeDeps([]);

    await stepScheduledTasks(deps, { nonInteractive: true });

    expect(calls.prepared).toHaveLength(0);
    expect(calls.syncCalls).toBe(0);
    expect(state.multiselectCalls).toBe(0);
    expect(state.confirmCalls).toBe(0);
  });

  test("CI setup neither prepares definitions nor mutates the scheduler", async () => {
    const { deps, calls } = makeDeps([]);
    overrideSeam(_setScheduledTasksEnvForTests, { isCiEnvironment: () => true });

    await stepScheduledTasks(deps);

    expect(calls.prepared).toHaveLength(0);
    expect(calls.syncCalls).toBe(0);
    expect(state.multiselectCalls).toBe(0);
    expect(state.confirmCalls).toBe(0);
  });
});

function managedPlans(ids: string[]): PreparedSetupTask[] {
  const selected = new Set(ids);
  return listEmbeddedTasks()
    .filter((task) => selected.has(task.id))
    .map((task) => ({ task, schedule: task.schedule, enabled: true, installed: false }));
}

describe("task definition preparation", () => {
  test("setup accepts and preserves every valid schedule in a multi-schedule task", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      writeSandboxConfig({ bundles: { stash: { path: storage.stashDir } }, defaultBundle: "stash" });
      const taskDir = path.join(storage.stashDir, "tasks");
      const filePath = path.join(taskDir, "improve.yml");
      const original = [
        "version: 4",
        "run: akm improve",
        "schedule:",
        "  - cron: '0 1 * * *'",
        "  - cron: '30 13 * * 1,2,3,4,5'",
        "",
      ].join("\n");
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(filePath, original, "utf8");

      const listed = listSetupTaskDefinitions() as Array<{
        id: string;
        schedule: string;
        schedules: readonly string[];
        enabled: boolean;
      }>;
      expect(listed).toEqual([
        {
          id: "improve",
          schedule: "0 1 * * *",
          schedules: ["0 1 * * *", "30 13 * * 1,2,3,4,5"],
          enabled: false,
        },
      ]);

      const embedded = listEmbeddedTasks().find((task) => task.id === "improve");
      expect(embedded).toBeDefined();
      await prepareSetupTaskDefinitions(
        [{ task: embedded!, schedule: listed[0]!.schedule, enabled: true, installed: true }],
        { commitBoundary: () => {} },
      );

      const updated = fs.readFileSync(filePath, "utf8");
      expect(updated).toBe(original);
      expect(updated).not.toContain("enabled:");
      expect(updated).toContain("cron: '0 1 * * *'");
      expect(updated).toContain("cron: '30 13 * * 1,2,3,4,5'");
      expect(schedulerEnabledRefs(loadConfig())).toContain("stash//tasks/improve");
    } finally {
      storage.cleanup();
    }
  });

  test("malformed custom tasks fail closed before review and preserve their bytes", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      writeSandboxConfig({ bundles: { stash: { path: storage.stashDir } }, defaultBundle: "stash" });
      const taskDir = path.join(storage.stashDir, "tasks");
      const filePath = path.join(taskDir, "broken.yml");
      const invalid = "version: 2\nenabled: true\n";
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(filePath, invalid, "utf8");

      expect(() => listSetupTaskDefinitions()).toThrow(/Cannot review task definition.*broken\.yml.*Fix or remove/s);
      expect(fs.readFileSync(filePath, "utf8")).toBe(invalid);
    } finally {
      storage.cleanup();
    }
  });

  test("restores all managed files when a write fails", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      writeSandboxConfig({ bundles: { stash: { path: storage.stashDir } }, defaultBundle: "stash" });
      const plans = managedPlans(["improve", "sync"]);
      let writes = 0;

      await expect(
        prepareSetupTaskDefinitions(plans, {
          writeAsset: async (...args) => {
            const result = await writeAssetToSource(...args);
            writes += 1;
            if (writes === 2) throw new Error("injected write failure");
            return result;
          },
          deleteAsset: deleteAssetFromSource,
          commitBoundary: () => {},
        }),
      ).rejects.toThrow("injected write failure");

      expect(fs.existsSync(path.join(storage.stashDir, "tasks", "improve.yml"))).toBe(false);
      expect(fs.existsSync(path.join(storage.stashDir, "tasks", "sync.yml"))).toBe(false);
    } finally {
      storage.cleanup();
    }
  });

  test("restores original bytes and existence when the commit boundary fails", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      writeSandboxConfig({ bundles: { stash: { path: storage.stashDir } }, defaultBundle: "stash" });
      const taskDir = path.join(storage.stashDir, "tasks");
      const improvePath = path.join(taskDir, "improve.yml");
      const syncPath = path.join(taskDir, "sync.yml");
      const original = "version: 4\nrun: akm improve\nschedule:\n  - cron: '0 1 * * *'\n";
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(improvePath, original, "utf8");
      let commits = 0;

      await expect(
        prepareSetupTaskDefinitions(managedPlans(["improve", "sync"]), {
          writeAsset: writeAssetToSource,
          deleteAsset: deleteAssetFromSource,
          commitBoundary: () => {
            commits += 1;
            if (commits === 1) throw new Error("injected commit failure");
          },
        }),
      ).rejects.toThrow("injected commit failure");

      expect(fs.readFileSync(improvePath, "utf8")).toBe(original);
      expect(fs.existsSync(syncPath)).toBe(false);
      expect(commits).toBe(2);
    } finally {
      storage.cleanup();
    }
  });
});

describe("scheduled-tasks step registration", () => {
  test("is not part of non-interactive setup steps", () => {
    const { steps } = buildSetupSteps({
      online: false,
      semanticSearchOutcome: { mode: "off", prepareAssets: false },
    });
    expect(steps.find((step) => step.id === "scheduled-tasks")).toBeUndefined();
    expect(steps[steps.length - 1]?.id).toBe("output");
  });
});

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

describe("stepScheduledTasks activation drives the real akmTasksSync", () => {
  beforeEach(resetClack);

  test("a config without scheduler.enabled takes the installed akm rows as the host's choice", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      writeSandboxConfig({ bundles: { stash: { path: storage.stashDir, writable: true } }, defaultBundle: "stash" });
      const taskDir = path.join(storage.stashDir, "tasks");
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(
        path.join(taskDir, "orphan.yml"),
        'version: 4\nrun: echo orphan\nname: orphan\nschedule:\n  - cron: "*/5 * * * *"\n',
        "utf8",
      );
      setSchedulerRefEnabled("stash//tasks/orphan", true);

      const exec = memoryExec();
      writeSchedulerContextDescriptor(schedulerContextDescriptor(resolveScheduledTaskContext(), ""));
      const backend = CRON_BACKEND({
        exec,
        fs: { ensureDir() {} },
        logDir: "/var/log/akm",
        akmArgv: ["/usr/local/bin/akm"],
        envPath: false,
      });
      await akmTasksSync({ backend });
      expect(exec.current()).toContain("task run orphan");

      // A pre-0.9.17 config has no list at all: the installed row IS the choice.
      const { scheduler: _dropped, ...withoutList } = loadConfig();
      saveConfig(withoutList);
      resetConfigCache();
      expect(schedulerEnabledRefs(loadConfig())).toBeUndefined();

      state.confirmReturn = true;
      await stepScheduledTasks({
        list: listSetupTaskDefinitions,
        prepare: prepareSetupTaskDefinitions,
        sync: (deps, bundleTarget, syncOptions) => akmTasksSync({ ...deps, backend }, bundleTarget, syncOptions),
        inspectInstalled: async () => backend.inspectBindings!({}),
      });

      expect(exec.current()).toContain("task run orphan");
      expect(schedulerEnabledRefs(loadConfig())).toContain("stash//tasks/orphan");

      // An explicit empty list is a choice, not a missing one: nothing is re-derived.
      saveConfig({ ...loadConfig(), scheduler: { enabled: [] } });
      resetConfigCache();
      await akmTasksSync({ backend });
      expect(exec.current()).not.toContain("task run orphan");
      expect(schedulerEnabledRefs(loadConfig())).toEqual([]);
    } finally {
      storage.cleanup();
    }
  });

  test("does not re-activate a task definition the operator deselects on a rerun", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      writeSandboxConfig({ bundles: { stash: { path: storage.stashDir, writable: true } }, defaultBundle: "stash" });

      const exec = memoryExec();
      writeSchedulerContextDescriptor(schedulerContextDescriptor(resolveScheduledTaskContext(), ""));
      const backend = CRON_BACKEND({
        exec,
        fs: { ensureDir() {} },
        logDir: "/var/log/akm",
        akmArgv: ["/usr/local/bin/akm"],
        envPath: false,
      });
      const deps = {
        list: listSetupTaskDefinitions,
        prepare: prepareSetupTaskDefinitions,
        sync: (
          deps: Parameters<typeof akmTasksSync>[0],
          bundleTarget?: string,
          syncOptions?: Parameters<typeof akmTasksSync>[2],
        ) => akmTasksSync({ ...deps, backend }, bundleTarget, syncOptions),
        inspectInstalled: async () => backend.inspectBindings!({}),
      };

      // First run: select the embedded `extract` task and activate it.
      state.multiselectReturn = ["extract"];
      state.confirmReturn = true;
      await stepScheduledTasks(deps);
      expect(exec.current()).toContain("task run extract");
      expect(schedulerEnabledRefs(loadConfig())).toContain("stash//tasks/extract");

      // Second run: leave `extract` unchecked. Its YAML stays prepared on disk; the choice is the list.
      resetClack();
      state.confirmReturn = true;

      await stepScheduledTasks(deps);

      expect(schedulerEnabledRefs(loadConfig())).not.toContain("stash//tasks/extract");
      expect(exec.current()).not.toContain("task run extract");
    } finally {
      storage.cleanup();
    }
  });
});
