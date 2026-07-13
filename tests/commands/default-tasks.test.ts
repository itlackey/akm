// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Issue #552: default improve task registration. These tests use fully
 * injected fakes for the scheduler-touching primitives (`list` / `add`) so
 * they NEVER write to a real stash or touch the host OS scheduler. They pin:
 *   - idempotency (run twice → identical task set, no duplicates),
 *   - the CI guard (CI=true registers nothing),
 *   - catchup is registered-but-unscheduled,
 *   - the server prompt gates only the nightly task.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_IMPROVE_TASKS,
  isCiEnvironment,
  type RegisterDefaultTasksDeps,
  registerDefaultTasks,
} from "../../src/commands/tasks/default-tasks";
import type { TasksAddInput, TasksAddResult, TasksListResult } from "../../src/commands/tasks/tasks";
import { parseSchedule, type ScheduleBackend } from "../../src/tasks/schedule";

/**
 * An in-memory fake of the task store: `add` records the call and appends to
 * the list `list` returns. Mirrors `akmTasksAdd`'s "throws if exists" contract
 * so we'd catch any accidental duplicate-create.
 */
function makeFakeDeps(): RegisterDefaultTasksDeps & { calls: TasksAddInput[] } {
  const store = new Map<string, TasksAddInput>();
  const calls: TasksAddInput[] = [];
  return {
    calls,
    async list(): Promise<TasksListResult> {
      return {
        tasks: [...store.values()].map((c) => ({
          id: c.id,
          ref: `task:${c.id}`,
          path: `/fake/${c.id}.yml`,
          schedule: c.schedule,
          enabled: c.disabled !== true,
          target: { kind: "command", cmd: [String(c.command)] },
        })),
        stale: [],
      };
    },
    async add(input: TasksAddInput): Promise<TasksAddResult> {
      if (store.has(input.id)) {
        throw new Error(`duplicate create for ${input.id} — registration is not idempotent`);
      }
      calls.push(input);
      store.set(input.id, input);
      return {
        id: input.id,
        ref: `task:${input.id}`,
        path: `/fake/${input.id}.yml`,
        stashDir: "/fake",
        schedule: input.schedule,
        enabled: input.disabled !== true,
        backend: "fake",
        target: { kind: "command", cmd: [String(input.command)] },
      };
    },
  };
}

const savedCi = process.env.CI;
beforeEach(() => {
  delete process.env.CI;
});
afterEach(() => {
  if (savedCi === undefined) delete process.env.CI;
  else process.env.CI = savedCi;
});

describe("registerDefaultTasks (#552)", () => {
  test("registers the full default set on a fresh install", async () => {
    const deps = makeFakeDeps();
    const result = await registerDefaultTasks({ serverInstall: true, deps });
    expect(result.skipped).toBe(false);
    expect(result.created.sort()).toEqual(DEFAULT_IMPROVE_TASKS.map((t) => t.id).sort());
    expect(result.existing).toEqual([]);
  });

  test("is idempotent — running twice yields the same set with no duplicates", async () => {
    const deps = makeFakeDeps();
    const first = await registerDefaultTasks({ serverInstall: true, deps });
    const second = await registerDefaultTasks({ serverInstall: true, deps });

    expect(first.created.length).toBe(DEFAULT_IMPROVE_TASKS.length);
    // Second run creates nothing and sees everything as already-present.
    expect(second.created).toEqual([]);
    expect(second.existing.sort()).toEqual(DEFAULT_IMPROVE_TASKS.map((t) => t.id).sort());

    // The fake throws on duplicate create, so reaching here proves no dupes.
    const ids = (await deps.list()).tasks.map((t) => t.id);
    expect(new Set(ids).size).toBe(DEFAULT_IMPROVE_TASKS.length);
  });

  test("CI=true registers nothing", async () => {
    process.env.CI = "true";
    const deps = makeFakeDeps();
    const result = await registerDefaultTasks({ serverInstall: true, deps });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("ci");
    expect(deps.calls).toHaveLength(0);
    expect((await deps.list()).tasks).toHaveLength(0);
  });

  test("catchup is registered but NOT scheduled (created disabled)", async () => {
    const deps = makeFakeDeps();
    await registerDefaultTasks({ serverInstall: true, deps });
    const catchup = deps.calls.find((c) => c.id === "akm-improve-catchup");
    expect(catchup).toBeDefined();
    expect(catchup?.disabled).toBe(true);
  });

  test("frequent / consolidate / graph-refresh are enabled regardless of server flag", async () => {
    const deps = makeFakeDeps();
    await registerDefaultTasks({ serverInstall: false, deps });
    const enabled = new Set(deps.calls.filter((c) => c.disabled !== true).map((c) => c.id));
    expect(enabled.has("akm-improve-frequent")).toBe(true);
    expect(enabled.has("akm-improve-consolidate")).toBe(true);
    expect(enabled.has("akm-graph-refresh-weekly")).toBe(true);
  });

  test("nightly task is gated on the server flag", async () => {
    const serverDeps = makeFakeDeps();
    await registerDefaultTasks({ serverInstall: true, deps: serverDeps });
    const serverNightly = serverDeps.calls.find((c) => c.id === "akm-improve-nightly");
    expect(serverNightly?.disabled).toBe(false);

    const laptopDeps = makeFakeDeps();
    await registerDefaultTasks({ serverInstall: false, deps: laptopDeps });
    const laptopNightly = laptopDeps.calls.find((c) => c.id === "akm-improve-nightly");
    expect(laptopNightly?.disabled).toBe(true);
  });

  test("each created task encodes its strategy in the command", async () => {
    const deps = makeFakeDeps();
    await registerDefaultTasks({ serverInstall: true, deps });
    for (const spec of DEFAULT_IMPROVE_TASKS) {
      const call = deps.calls.find((c) => c.id === spec.id);
      expect(String(call?.command)).toContain(`--strategy ${spec.strategy}`);
    }
  });

  test("every effective default schedule translates on every backend", async () => {
    const deps = makeFakeDeps();
    await registerDefaultTasks({ serverInstall: true, deps });

    for (const call of deps.calls) {
      for (const backend of ["cron", "launchd", "schtasks"] satisfies ScheduleBackend[]) {
        expect(() => parseSchedule(call.schedule, backend)).not.toThrow();
      }
    }
  });
});

describe("isCiEnvironment", () => {
  test("true for CI=true / CI=1, false for unset / 0 / false / empty", () => {
    expect(isCiEnvironment({ CI: "true" })).toBe(true);
    expect(isCiEnvironment({ CI: "1" })).toBe(true);
    expect(isCiEnvironment({})).toBe(false);
    expect(isCiEnvironment({ CI: "0" })).toBe(false);
    expect(isCiEnvironment({ CI: "false" })).toBe(false);
    expect(isCiEnvironment({ CI: "" })).toBe(false);
  });
});
