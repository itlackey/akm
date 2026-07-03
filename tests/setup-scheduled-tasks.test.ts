// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `stepScheduledTasks` — the `akm setup` Scheduled Tasks step (issue #512).
 *
 * Drives the step through a stubbed clack multiselect/text prompt and injected
 * fake task primitives so the diff logic (add / enable / disable / no-op) and
 * the copy-on-enable + sync behaviour are verified without touching the OS
 * scheduler or git.
 *
 * The clack prompt surface is swapped through the `src/cli/clack` seam
 * (`overrideSeam` + `_setClackForTests` — restored automatically by the
 * preload after every test); the task primitives and git-sync helper are
 * passed in via `stepScheduledTasks(deps)`.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { _setClackForTests } from "../src/cli/clack";
import * as setupModule from "../src/setup/setup";
import { overrideSeam } from "./_helpers/seams";

const CANCEL = Symbol("clack:cancel");

const state = {
  multiselectReturn: [] as string[],
  textReturns: [] as string[],
  multiselectConfig: undefined as
    | { initialValues?: string[]; options: Array<{ value: string; label: string; hint?: string }> }
    | undefined,
};

function resetClack() {
  state.multiselectReturn = [];
  state.textReturns = [];
  state.multiselectConfig = undefined;
  overrideSeam(_setClackForTests, {
    isCancel: (v: unknown) => v === CANCEL,
    cancel: () => {},
    multiselect: async (config: {
      initialValues?: string[];
      options: Array<{ value: string; label: string; hint?: string }>;
    }) => {
      state.multiselectConfig = { initialValues: config.initialValues, options: config.options };
      return state.multiselectReturn;
    },
    text: async () => state.textReturns.shift() ?? "",
    select: async () => "",
    confirm: async () => false,
    spinner: () => ({ start: () => {}, stop: () => {} }),
    log: { info: () => {}, success: () => {}, warn: () => {}, step: () => {} },
    intro: () => {},
    outro: () => {},
    note: () => {},
  });
}

// ── Fake task primitives injected into the step ──────────────────────────────
function makeDeps(installed: Array<{ id: string; enabled: boolean }>) {
  const calls = {
    added: [] as Array<{ id: string; schedule: string; command?: string | string[] }>,
    enabled: [] as Array<{ id: string; enabled: boolean }>,
    syncCalls: 0,
    gitSyncCalls: 0,
  };
  const deps = {
    list: async () =>
      ({ tasks: installed }) as Awaited<ReturnType<typeof import("../src/commands/tasks/tasks").akmTasksList>>,
    add: async (input: { id: string; schedule: string; command?: string | string[] }) => {
      calls.added.push({ id: input.id, schedule: input.schedule, command: input.command });
      return { id: input.id } as Awaited<ReturnType<typeof import("../src/commands/tasks/tasks").akmTasksAdd>>;
    },
    setEnabled: async (id: string, enabled: boolean) => {
      calls.enabled.push({ id, enabled });
      return { id, enabled, backend: "cron" };
    },
    sync: async () => {
      calls.syncCalls += 1;
      return { installed: [], updated: [], removed: [], unchanged: [], skipped: [], backend: "cron" as const };
    },
    gitSync: (() => {
      calls.gitSyncCalls += 1;
      return { committed: true, pushed: false, skipped: false, output: "" };
    }) as unknown as typeof import("../src/sources/providers/git").saveGitStash,
  };
  return { deps, calls };
}

describe("stepScheduledTasks", () => {
  beforeEach(resetClack);

  test("lists all 7 embedded tasks with id, description, and schedule in the multiselect", async () => {
    const { deps } = makeDeps([]);
    await setupModule.stepScheduledTasks(deps);
    const opts = state.multiselectConfig?.options ?? [];
    expect(opts.length).toBe(7);
    const improve = opts.find((o) => o.value === "improve");
    expect(improve?.label).toBe("core/improve");
    expect(improve?.hint).toContain("Run improve pipeline nightly");
    expect(improve?.hint).toContain("0 2 * * *");
    expect(improve?.hint).toContain("not installed");
  });

  test("pre-checks already-installed enabled tasks; disabled/absent are not pre-checked", async () => {
    const { deps } = makeDeps([
      { id: "improve", enabled: true },
      { id: "backup", enabled: false },
    ]);
    state.multiselectReturn = ["improve"]; // leave selection unchanged
    await setupModule.stepScheduledTasks(deps);
    expect(state.multiselectConfig?.initialValues).toEqual(["improve"]);
    const opts = state.multiselectConfig?.options ?? [];
    expect(opts.find((o) => o.value === "backup")?.hint).toContain("disabled");
    expect(opts.find((o) => o.value === "improve")?.hint).toContain("enabled");
  });

  test("checking a previously-absent task copies template, installs, and syncs", async () => {
    const { deps, calls } = makeDeps([]);
    state.multiselectReturn = ["sync"];
    state.textReturns = ["*/15 * * * *"]; // accept default schedule
    await setupModule.stepScheduledTasks(deps);
    expect(calls.added).toEqual([{ id: "sync", schedule: "*/15 * * * *", command: "akm sync" }]);
    expect(calls.syncCalls).toBe(1);
    expect(calls.gitSyncCalls).toBe(1);
    expect(calls.enabled).toEqual([]);
  });

  test("edited schedule is validated and persisted into the add call", async () => {
    const { deps, calls } = makeDeps([]);
    state.multiselectReturn = ["extract"];
    state.textReturns = ["0 5 * * *"]; // user edits the schedule
    await setupModule.stepScheduledTasks(deps);
    expect(calls.added).toEqual([{ id: "extract", schedule: "0 5 * * *", command: "akm extract" }]);
  });

  test("unchecking a previously-enabled task disables it (no add, keeps file)", async () => {
    const { deps, calls } = makeDeps([{ id: "improve", enabled: true }]);
    state.multiselectReturn = []; // uncheck improve
    await setupModule.stepScheduledTasks(deps);
    expect(calls.enabled).toEqual([{ id: "improve", enabled: false }]);
    expect(calls.added).toEqual([]);
    expect(calls.syncCalls).toBe(0);
  });

  test("re-checking a present-but-disabled task re-enables it", async () => {
    const { deps, calls } = makeDeps([{ id: "backup", enabled: false }]);
    state.multiselectReturn = ["backup"];
    await setupModule.stepScheduledTasks(deps);
    expect(calls.enabled).toEqual([{ id: "backup", enabled: true }]);
    expect(calls.added).toEqual([]);
  });

  test("no state change produces no add/enable/disable/sync calls", async () => {
    const { deps, calls } = makeDeps([{ id: "improve", enabled: true }]);
    state.multiselectReturn = ["improve"]; // unchanged
    await setupModule.stepScheduledTasks(deps);
    expect(calls.added).toEqual([]);
    expect(calls.enabled).toEqual([]);
    expect(calls.syncCalls).toBe(0);
    expect(calls.gitSyncCalls).toBe(0);
  });
});

describe("scheduled-tasks step registration", () => {
  test("is interactive-only (not nonInteractive) so --yes / init skip it", () => {
    const { steps } = setupModule.buildSetupSteps({
      online: false,
      semanticSearchOutcome: { mode: "off", prepareAssets: false },
    });
    const step = steps.find((s) => s.id === "scheduled-tasks");
    expect(step).toBeDefined();
    expect(step?.label).toBe("Scheduled Tasks");
    expect(step?.nonInteractive).toBeFalsy();
    expect(steps[steps.length - 1]?.id).toBe("scheduled-tasks");
  });
});
