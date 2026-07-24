// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { _setClackForTests } from "../src/cli/clack";
import type { TasksSyncResult } from "../src/commands/tasks/tasks";
import { deleteAssetFromSource, writeAssetToSource } from "../src/core/write-source";
import { buildSetupSteps } from "../src/setup/setup";
import {
  listSetupTaskDefinitions,
  type PreparedSetupTask,
  prepareSetupTaskDefinitions,
  stepScheduledTasks,
} from "../src/setup/steps/tasks";
import { listEmbeddedTasks } from "../src/tasks/embedded";
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
};

function makeDeps(
  installed: Array<{ id: string; schedule: string; enabled: boolean; description?: string }>,
  syncResult: TasksSyncResult = EMPTY_SYNC_RESULT,
) {
  const calls = {
    prepared: [] as PreparedSetupTask[][],
    syncCalls: 0,
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
    expect(options).toHaveLength(5);
    expect(options.find((option) => option.value === "backup")).toBeUndefined();
    expect(options.find((option) => option.value === "improve")?.hint).toContain("0 2 * * *");
    expect(options.find((option) => option.value === "improve")?.hint).toContain("not prepared");
    expect(state.notes).toHaveLength(1);
    expect(state.notes[0]?.title).toBe("Task Schedule Review");
    expect(state.notes[0]?.message.split("\n")).toHaveLength(5);
    expect(state.notes[0]?.message).toContain("core/improve: disabled | 0 2 * * *");
    expect(calls.prepared[0]).toHaveLength(5);
    expect(calls.prepared[0]?.every((task) => task.enabled === false)).toBe(true);
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
    expect(state.logs.at(-1)?.message).toContain("akm tasks sync --rebind");
    expect(state.logs.at(-1)?.message).toContain("activation was incomplete");
  });

  test("reports all-skipped activation as a failure without success", async () => {
    const { deps } = makeDeps([], {
      ...EMPTY_SYNC_RESULT,
      skipped: [
        { id: "improve", reason: "cannot resolve installed runtime" },
        { id: "sync", reason: "legacy scheduler entry" },
      ],
    });
    state.confirmReturn = true;

    await stepScheduledTasks(deps);

    expect(state.logs.filter((entry) => entry.message.includes("was not activated"))).toHaveLength(2);
    expect(state.logs.some((entry) => entry.level === "success" && entry.message.includes("activated"))).toBe(false);
    expect(state.logs.at(-1)?.message).toContain("No task schedules were activated");
    expect(state.logs.at(-1)?.message).toContain("akm tasks sync --rebind");
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
});

function managedPlans(ids: string[]): PreparedSetupTask[] {
  const selected = new Set(ids);
  return listEmbeddedTasks()
    .filter((task) => selected.has(task.id))
    .map((task) => ({ task, schedule: task.schedule, enabled: true, installed: false }));
}

describe("task definition preparation", () => {
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
      const original = 'version: 2\nschedule: "0 1 * * *"\ncommand: akm improve\nenabled: false';
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
