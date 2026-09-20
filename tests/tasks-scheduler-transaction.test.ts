// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmTasksAdd, akmTasksSync } from "../src/commands/tasks/tasks";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import { akmIndex } from "../src/indexer/indexer";
import { setSchedulerRefEnabled } from "../src/tasks/activation-config";
import type { SchedulerBackend } from "../src/tasks/backends/types";
import type { ScheduleBackend } from "../src/tasks/schedule";
import {
  assertSchedulerMutationArtifact,
  compileTaskSchedulerBindings,
  type SchedulerBinding,
  type SchedulerMutationExpectation,
  schedulerBindingNativeId,
  schedulerNativeArtifactKey,
} from "../src/tasks/scheduler-binding";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "./_helpers/sandbox";

type StoredBinding = Readonly<{ binding: SchedulerBinding; fingerprint: string }>;
type FakeSnapshot = Readonly<{
  nativeIds: readonly string[];
  artifacts: readonly Record<string, unknown>[];
  stored: ReadonlyMap<string, StoredBinding>;
}>;
type FakeRollbackGuard = Readonly<{
  nativeId: string;
  allowed: readonly Readonly<
    { state: "absent" } | { state: "present"; bindingId?: string; invocation?: readonly string[]; fingerprint?: string }
  >[];
}>;

let storage: IsolatedAkmStorage;

function taskYaml(run: string, schedule: string): string {
  return `version: 4\nrun: ${run}\nschedule: "${schedule}"\n`;
}

function writeTask(id: string, run: string, schedule: string): void {
  const file = path.join(storage.stashDir, "tasks", `${id}.yml`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, taskYaml(run, schedule));
  setSchedulerRefEnabled("task", `stash//tasks/${id}`, true);
}

function binding(id: string, schedule: string): SchedulerBinding {
  const [compiled] = compileTaskSchedulerBindings({
    id,
    qualifiedRef: `stash//tasks/${id}`,
    schedules: [{ cron: schedule, source: "akm.schedule", ordinal: 0 }],
  });
  if (!compiled) throw new Error("missing compiled binding");
  return compiled;
}

function signature(value: SchedulerBinding): string {
  return JSON.stringify([value.cron, value.enabled, value.invocation]);
}

function fakeBackend(
  name: ScheduleBackend,
  initial: readonly SchedulerBinding[] = [],
  failure?: Readonly<{ kind: "install" | "uninstall"; id: string }>,
  rollbackFailureId?: string,
  concurrentRollbackDriftId?: string,
): SchedulerBackend & {
  stored: Map<string, StoredBinding>;
  calls: string[];
  inspectionCalls: number;
  splitReadCalls: number;
  snapshotCalls: number;
  restoreCalls: number;
  lastRollbackGuards: readonly FakeRollbackGuard[] | undefined;
} {
  const stored = new Map(
    initial.map((item) => [schedulerBindingNativeId(item), { binding: item, fingerprint: signature(item) }]),
  );
  const calls: string[] = [];
  let inspectionCalls = 0;
  let splitReadCalls = 0;
  let snapshotCalls = 0;
  let restoreCalls = 0;
  let lastRollbackGuards: readonly FakeRollbackGuard[] | undefined;

  const inspection = () => {
    const installed = [...stored.values()].map(({ binding: item, fingerprint }) => ({
      id: item.id,
      nativeId: schedulerBindingNativeId(item),
      binding: ["/test/akm"],
      contextPath: "/test/context.json",
      signature: fingerprint,
      target: "stash",
      // #846: this fixture's entries are always this file's own primary
      // ("stash") bundle — record its resolved path so belongsToBundle's
      // path-scoped check recognizes them as such.
      ownerBundlePath: path.resolve(storage.stashDir),
      invocation: item.invocation,
    }));
    const artifacts = [...stored.values()].map(({ binding: item, fingerprint }) => ({
      nativeId: schedulerBindingNativeId(item),
      bindingId: item.id,
      invocation: item.invocation,
      fingerprint,
    }));
    return { installed, artifacts };
  };

  const backend = {
    name,
    inspectBindings() {
      inspectionCalls += 1;
      return inspection();
    },
    list() {
      splitReadCalls += 1;
      return inspection().installed;
    },
    listNativeArtifacts() {
      splitReadCalls += 1;
      return inspection().artifacts;
    },
    expectedSignature(item: SchedulerBinding) {
      return signature(item);
    },
    snapshotBindings(nativeIds: readonly string[]): FakeSnapshot {
      snapshotCalls += 1;
      return Object.freeze({
        nativeIds: Object.freeze([...nativeIds]),
        artifacts: Object.freeze(
          inspection().artifacts.filter((artifact) =>
            nativeIds.some(
              (nativeId) => schedulerNativeArtifactKey(nativeId) === schedulerNativeArtifactKey(artifact.nativeId),
            ),
          ),
        ),
        stored: new Map(stored),
      });
    },
    restoreBindings(snapshot: FakeSnapshot, guards?: readonly FakeRollbackGuard[]) {
      restoreCalls += 1;
      lastRollbackGuards = guards;
      const errors: unknown[] = [];
      for (const nativeId of snapshot.nativeIds) {
        try {
          if (nativeId === rollbackFailureId) throw new Error(`rollback failed for ${nativeId}`);
          if (guards !== undefined) {
            const current = stored.get(nativeId);
            const guard = guards?.find((candidate) => candidate.nativeId === nativeId);
            if (!guard) throw new Error(`missing rollback CAS guard for ${nativeId}`);
            const matches = guard.allowed.some((allowed) =>
              allowed.state === "absent"
                ? current === undefined
                : current !== undefined &&
                  allowed.bindingId === current.binding.id &&
                  JSON.stringify(allowed.invocation) === JSON.stringify(current.binding.invocation) &&
                  allowed.fingerprint === current.fingerprint,
            );
            if (!matches) throw new Error(`rollback CAS rejected concurrent drift for ${nativeId}`);
          }
          const prior = snapshot.stored.get(nativeId);
          if (prior) stored.set(nativeId, prior);
          else stored.delete(nativeId);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, "partial rollback failure");
    },
    install(item: SchedulerBinding, _options?: unknown, expected?: unknown) {
      calls.push(`install:${item.id}:${expected === undefined ? "missing-cas" : "cas"}`);
      if (expected !== undefined) {
        const current = stored.get(schedulerBindingNativeId(item));
        assertSchedulerMutationArtifact(
          current
            ? {
                nativeId: schedulerBindingNativeId(current.binding),
                bindingId: current.binding.id,
                invocation: current.binding.invocation,
                fingerprint: current.fingerprint,
              }
            : undefined,
          expected as SchedulerMutationExpectation,
        );
      }
      if (failure?.kind === "install" && failure.id === item.id) {
        if (concurrentRollbackDriftId) {
          const prior = stored.get(concurrentRollbackDriftId);
          if (prior) stored.set(concurrentRollbackDriftId, { ...prior, fingerprint: "concurrent-foreign-bytes" });
        }
        throw new Error(`install failed for ${item.id}`);
      }
      stored.set(schedulerBindingNativeId(item), { binding: item, fingerprint: signature(item) });
    },
    uninstall(nativeId: string, expected?: unknown) {
      calls.push(`remove:${nativeId}:${expected === undefined ? "missing-cas" : "cas"}`);
      if (failure?.kind === "uninstall" && failure.id === nativeId) throw new Error(`remove failed for ${nativeId}`);
      stored.delete(nativeId);
    },
    setEnabled() {},
  } as unknown as SchedulerBackend & {
    stored: Map<string, StoredBinding>;
    calls: string[];
    inspectionCalls: number;
    splitReadCalls: number;
    snapshotCalls: number;
    restoreCalls: number;
    lastRollbackGuards: readonly FakeRollbackGuard[] | undefined;
  };
  Object.defineProperties(backend, {
    stored: { value: stored },
    calls: { value: calls },
    inspectionCalls: { get: () => inspectionCalls },
    splitReadCalls: { get: () => splitReadCalls },
    snapshotCalls: { get: () => snapshotCalls },
    restoreCalls: { get: () => restoreCalls },
    lastRollbackGuards: { get: () => lastRollbackGuards },
  });
  return backend;
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({
    bundles: { stash: { path: storage.stashDir, writable: true } },
    defaultBundle: "stash",
    defaults: { engine: "fixture" },
    engines: { fixture: { kind: "agent", platform: "claude", bin: "/bin/true" } },
  });
  fs.mkdirSync(path.join(storage.stashDir, "tasks"), { recursive: true });
});

afterEach(() => storage.cleanup());

describe("whole-set scheduler transaction and coherent inspection", () => {
  test.each([
    "cron",
    "launchd",
    "schtasks",
  ] as const)("task add uses one coherent %s inspection, an exact snapshot, and create CAS", async (name) => {
    const backend = fakeBackend(name);

    await akmTasksAdd({ id: "alpha", schedule: "0 1 * * *", command: "echo alpha" }, { backend });

    expect(backend.inspectionCalls).toBe(1);
    expect(backend.splitReadCalls).toBe(0);
    expect(backend.snapshotCalls).toBe(1);
    expect(backend.calls).toEqual(["install:alpha:cas"]);
  });

  test("task add replaces a hand-edited installed binding (unparseable ordinal) with a warning, skipping only its own CAS", async () => {
    const handEdited: SchedulerBinding = {
      id: "hand-edited-id",
      logicalSource: { kind: "task", ref: "stash//tasks/mytask" },
      cron: "0 3 * * *",
      source: "akm.schedule",
      ordinal: 0,
      enabled: true,
      invocation: ["task", "run", "mytask", "--bundle", "stash", "--scheduled"],
    };
    const backend = fakeBackend("cron", [handEdited]);

    const warnings: unknown[][] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args);
    });
    try {
      await akmTasksAdd({ id: "mytask", schedule: "0 4 * * *", command: "echo mytask" }, { backend });
    } finally {
      _setWarnSinkForTests(undefined);
      _resetWarnOnceForTests();
    }

    expect(backend.calls).toEqual(["remove:hand-edited-id:missing-cas", "install:mytask:cas"]);
    expect(backend.stored.has("hand-edited-id")).toBe(false);
    expect(backend.stored.has("mytask")).toBe(true);
    expect(
      warnings.some(
        (args) =>
          args.some((a) => String(a).includes("hand-edited-id")) &&
          args.some((a) => String(a).includes("could not be exactly parsed")),
      ),
    ).toBe(true);
  });

  test("task add reads an existing symlinked task source instead of refusing it (containment still enforced)", async () => {
    const realTarget = path.join(storage.stashDir, "tasks", ".mytask-real.yml");
    fs.writeFileSync(realTarget, 'version: 4\nrun: echo old\nschedule: "@daily"\n');
    const assetPath = path.join(storage.stashDir, "tasks", "mytask.yml");
    fs.symlinkSync(realTarget, assetPath);

    const backend = fakeBackend("cron");
    const result = await akmTasksAdd(
      { id: "mytask", schedule: "0 5 * * *", command: "echo new", force: true },
      { backend },
    );

    expect(result.id).toBe("mytask");
    expect(fs.readFileSync(assetPath, "utf8")).toContain("echo new");
  });

  test("task add retries a torn read once, then warns and proceeds rather than refusing", async () => {
    const assetPath = path.join(storage.stashDir, "tasks", "mytask.yml");
    fs.writeFileSync(assetPath, 'version: 4\nrun: echo old\nschedule: "@daily"\n');

    const openedPaths = new Map<number, string>();
    const realOpenSync = fs.openSync.bind(fs);
    const openSpy = spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      const fd = realOpenSync(...args);
      openedPaths.set(fd, String(args[0]));
      return fd;
    }) as typeof fs.openSync);
    let torn = false;
    const realReadFileSync = fs.readFileSync.bind(fs);
    const readSpy = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      const real = realReadFileSync(...args);
      const fd = args[0];
      if (!torn && typeof fd === "number" && openedPaths.get(fd) === assetPath && Buffer.isBuffer(real)) {
        torn = true;
        return real.subarray(0, real.byteLength - 1);
      }
      return real;
    }) as typeof fs.readFileSync);

    const warnings: unknown[][] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args);
    });

    let result: Awaited<ReturnType<typeof akmTasksAdd>>;
    try {
      const backend = fakeBackend("cron");
      result = await akmTasksAdd(
        { id: "mytask", schedule: "0 5 * * *", command: "echo new", force: true },
        { backend },
      );
    } finally {
      openSpy.mockRestore();
      readSpy.mockRestore();
      _setWarnSinkForTests(undefined);
      _resetWarnOnceForTests();
    }

    expect(result.id).toBe("mytask");
    expect(torn).toBe(true);
    expect(warnings.some((args) => args.some((a) => String(a).includes("retried once")))).toBe(true);
  });

  test("task add rejects a backend without coherent inspection before source write", async () => {
    let sourceWrites = 0;
    let installs = 0;
    const backend = {
      name: "cron",
      list: () => [],
      install() {
        installs += 1;
      },
      uninstall() {},
      setEnabled() {},
    } as unknown as SchedulerBackend;

    await expect(
      akmTasksAdd(
        { id: "alpha", schedule: "0 1 * * *", command: "echo alpha" },
        {
          backend,
          writeAsset: (async () => {
            sourceWrites += 1;
            return {};
          }) as never,
        },
      ),
    ).rejects.toThrow(/coherent inspection/i);
    expect(sourceWrites).toBe(0);
    expect(installs).toBe(0);
  });

  test.each([
    "cron",
    "launchd",
    "schtasks",
  ] as const)("task add %s CAS and rollback guard preserve an artifact appearing after snapshot", async (name) => {
    const backend = fakeBackend(name);
    const originalSnapshot = backend.snapshotBindings!.bind(backend);
    const foreign = binding("alpha", "59 23 * * *");
    backend.snapshotBindings = ((ids: readonly string[]) => {
      const snapshot = originalSnapshot(ids);
      backend.stored.set("alpha", { binding: foreign, fingerprint: "foreign-after-snapshot" });
      return snapshot;
    }) as never;

    await expect(
      akmTasksAdd({ id: "alpha", schedule: "0 1 * * *", command: "echo alpha" }, { backend }),
    ).rejects.toThrow(/changed|rollback|compare|absence|transaction/i);

    expect(backend.stored.get("alpha")?.fingerprint).toBe("foreign-after-snapshot");
    expect(fs.existsSync(path.join(storage.stashDir, "tasks", "alpha.yml"))).toBe(false);
    expect(backend.lastRollbackGuards).toBeDefined();
  });

  test("task add source-commit failure restores with exact backend rollback guards", async () => {
    const backend = fakeBackend("cron");

    await expect(
      akmTasksAdd(
        { id: "alpha", schedule: "0 1 * * *", command: "echo alpha" },
        {
          backend,
          commitBoundary: (() => {
            throw new Error("source commit failed");
          }) as never,
        },
      ),
    ).rejects.toThrow("source commit failed");

    expect(backend.calls).toEqual(["install:alpha:cas"]);
    expect(backend.restoreCalls).toBe(1);
    expect(backend.lastRollbackGuards?.map(({ nativeId }) => nativeId)).toEqual(["alpha"]);
    expect(fs.existsSync(path.join(storage.stashDir, "tasks", "alpha.yml"))).toBe(false);
  });

  test("task add absent-source CAS preserves a concurrent create before publication", async () => {
    const backend = fakeBackend("cron");
    const file = path.join(storage.stashDir, "tasks", "alpha.yml");
    const racer = "version: 4\nrun: echo racer\nschedule: '@hourly'\n";

    await expect(
      akmTasksAdd(
        { id: "alpha", schedule: "0 1 * * *", command: "echo desired" },
        {
          backend,
          schedulerRuntime() {
            fs.writeFileSync(file, racer);
            return { binding: ["/test/akm"], contextPath: "/test/context.json" };
          },
        },
      ),
    ).rejects.toThrow(/source|changed|appeared|compare|transaction/i);

    expect(fs.readFileSync(file, "utf8")).toBe(racer);
    expect(backend.calls).toEqual([]);
  });

  test.each([
    false,
    true,
  ])("task add rollback preserves a concurrent source owner after transaction publication (force=%s)", async (force) => {
    const file = path.join(storage.stashDir, "tasks", "alpha.yml");
    const prior = "version: 4\nrun: echo prior\nschedule: '0 1 * * *'\n";
    if (force) fs.writeFileSync(file, prior);
    const previousBinding = binding("alpha", "0 1 * * *");
    const backend = fakeBackend("cron", force ? [previousBinding] : [], { kind: "install", id: "alpha" });
    const racer = "version: 4\nrun: echo concurrent\nschedule: '@hourly'\n";
    const install = backend.install.bind(backend);
    backend.install = ((...args: Parameters<SchedulerBackend["install"]>) => {
      fs.writeFileSync(file, racer);
      return install(...args);
    }) as SchedulerBackend["install"];

    let caught: unknown;
    try {
      await akmTasksAdd({ id: "alpha", schedule: "15 1 * * *", command: "echo desired", force }, { backend });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect(String(caught)).toMatch(/rollback|source|transaction/i);
    expect(fs.readFileSync(file, "utf8")).toBe(racer);
  });

  test.each(
    (["cron", "launchd", "schtasks"] as const).flatMap((name) => [[name, false] as const, [name, true] as const]),
  )("task add %s rejects a successful final native mutation that races its published source (force=%s)", async (name, force) => {
    const file = path.join(storage.stashDir, "tasks", "alpha.yml");
    const prior = taskYaml("echo prior", "0 1 * * *");
    if (force) fs.writeFileSync(file, prior);
    const backend = fakeBackend(name, force ? [binding("alpha", "0 1 * * *")] : []);
    const racer = taskYaml("echo racer", "59 23 * * *");
    const install = backend.install.bind(backend);
    backend.install = ((...args: Parameters<SchedulerBackend["install"]>) => {
      const result = install(...args);
      fs.writeFileSync(file, racer);
      return result;
    }) as SchedulerBackend["install"];

    let caught: unknown;
    try {
      await akmTasksAdd({ id: "alpha", schedule: "15 1 * * *", command: "echo desired", force }, { backend });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect(String(caught)).toMatch(/source|changed|rollback|transaction/i);
    expect(fs.readFileSync(file, "utf8")).toBe(racer);
    expect(backend.restoreCalls).toBe(0);
  });

  test.each([
    "cron",
    "launchd",
    "schtasks",
  ] as const)("task sync %s rejects source deletion after its successful final install and rolls native state back", async (name) => {
    writeTask("alpha", "echo alpha", "0 1 * * *");
    const file = path.join(storage.stashDir, "tasks", "alpha.yml");
    const backend = fakeBackend(name);
    const install = backend.install.bind(backend);
    backend.install = ((...args: Parameters<SchedulerBackend["install"]>) => {
      const result = install(...args);
      fs.rmSync(file);
      return result;
    }) as SchedulerBackend["install"];

    await expect(akmTasksSync({ backend })).rejects.toThrow(/source|changed|read set|snapshot/i);

    expect(fs.existsSync(file)).toBe(false);
    expect(backend.stored.size).toBe(0);
    expect(backend.restoreCalls).toBe(1);
  });

  test.each([
    "cron",
    "launchd",
    "schtasks",
  ] as const)("task sync %s revalidates a multi-schedule source after its successful middle install", async (name) => {
    const file = path.join(storage.stashDir, "tasks", "alpha.yml");
    fs.writeFileSync(file, 'version: 4\nrun: echo alpha\nschedule:\n  - cron: "0 1 * * *"\n  - cron: "0 2 * * *"\n');
    setSchedulerRefEnabled("task", "stash//tasks/alpha", true);
    const backend = fakeBackend(name);
    const raced = taskYaml("echo raced", "59 23 * * *");
    const install = backend.install.bind(backend);
    let installs = 0;
    backend.install = ((...args: Parameters<SchedulerBackend["install"]>) => {
      const result = install(...args);
      installs += 1;
      if (installs === 1) fs.writeFileSync(file, raced);
      return result;
    }) as SchedulerBackend["install"];

    await expect(akmTasksSync({ backend })).rejects.toThrow(/source|changed|read set|snapshot/i);

    expect(backend.stored.size).toBe(0);
    expect(backend.restoreCalls).toBe(1);
  });

  test.each([
    "cron",
    "launchd",
    "schtasks",
  ] as const)("task add %s revalidates its mutation receipt after the final commit boundary", async (name) => {
    const file = path.join(storage.stashDir, "tasks", "alpha.yml");
    const racer = taskYaml("echo commit-racer", "59 23 * * *");
    const backend = fakeBackend(name);
    let caught: unknown;

    try {
      await akmTasksAdd(
        { id: "alpha", schedule: "0 1 * * *", command: "echo desired" },
        {
          backend,
          commitBoundary() {
            fs.writeFileSync(file, racer);
          },
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect(String(caught)).toMatch(/source|changed|rollback|transaction/i);
    expect(fs.readFileSync(file, "utf8")).toBe(racer);
    expect(backend.restoreCalls).toBe(0);
  });

  test("task add --force updates the primary and removes a stale ordinal with exact CAS", async () => {
    fs.writeFileSync(
      path.join(storage.stashDir, "tasks", "alpha.yml"),
      'version: 4\nrun: echo old\nschedule:\n  - cron: "0 1 * * *"\n  - cron: "0 2 * * *"\n',
    );
    const previous = compileTaskSchedulerBindings({
      id: "alpha",
      qualifiedRef: "stash//tasks/alpha",
      schedules: [
        { cron: "0 1 * * *", source: "akm.schedule[0]", ordinal: 0 },
        { cron: "0 2 * * *", source: "akm.schedule[1]", ordinal: 1 },
      ],
    });
    const backend = fakeBackend("cron", previous);

    await akmTasksAdd({ id: "alpha", schedule: "15 1 * * *", command: "echo new", force: true }, { backend });

    expect(backend.calls).toEqual([
      "remove:alpha:cas",
      `remove:${schedulerBindingNativeId(previous[1]!)}:cas`,
      "install:alpha:cas",
    ]);
    expect(backend.inspectionCalls).toBe(1);
    expect(backend.splitReadCalls).toBe(0);
  });

  test("task add --force source CAS rejects a replacement racer after snapshot before quiescing", async () => {
    const file = path.join(storage.stashDir, "tasks", "alpha.yml");
    const prior = taskYaml("echo prior", "0 1 * * *");
    const racer = taskYaml("echo racer", "59 23 * * *");
    fs.writeFileSync(file, prior);
    const backend = fakeBackend("cron", [binding("alpha", "0 1 * * *")]);
    const snapshot = backend.snapshotBindings!.bind(backend);
    backend.snapshotBindings = ((ids: readonly string[]) => {
      const frozen = snapshot(ids);
      fs.writeFileSync(file, racer);
      return frozen;
    }) as never;

    await expect(
      akmTasksAdd({ id: "alpha", schedule: "15 1 * * *", command: "echo desired", force: true }, { backend }),
    ).rejects.toThrow(/source|changed|transaction|compare/i);

    expect(fs.readFileSync(file, "utf8")).toBe(racer);
    expect(backend.calls).toEqual([]);
  });

  test("task add --force restores old source and bindings when publication writes then throws", async () => {
    const file = path.join(storage.stashDir, "tasks", "alpha.yml");
    const prior = taskYaml("echo prior", "0 1 * * *");
    fs.writeFileSync(file, prior);
    const oldBinding = binding("alpha", "0 1 * * *");
    const backend = fakeBackend("cron", [oldBinding]);

    await expect(
      akmTasksAdd(
        { id: "alpha", schedule: "15 1 * * *", command: "echo desired", force: true },
        {
          backend,
          writeAsset: (async (_source: unknown, _config: unknown, _ref: unknown, source: string) => {
            fs.writeFileSync(file, source);
            throw new Error("injected publication failure");
          }) as never,
        },
      ),
    ).rejects.toThrow("injected publication failure");

    expect(fs.readFileSync(file, "utf8")).toBe(prior);
    expect(backend.calls).toEqual(["remove:alpha:cas"]);
    expect(backend.restoreCalls).toBe(1);
    expect(backend.stored.get("alpha")?.binding).toEqual(oldBinding);
  });

  test("uses one coherent backend inspection instead of separate list and artifact reads", async () => {
    writeTask("alpha", "echo alpha", "0 1 * * *");
    const backend = fakeBackend("cron");

    await akmTasksSync({ backend });

    expect(backend.inspectionCalls).toBe(1);
    expect(backend.splitReadCalls).toBe(0);
  });

  test.each([
    ["appearance", () => writeTask("beta", "echo beta", "0 2 * * *")],
    ["disappearance", () => fs.rmSync(path.join(storage.stashDir, "tasks", "alpha.yml"))],
    ["byte drift", () => writeTask("alpha", "echo changed", "30 1 * * *")],
  ] as const)("rejects desired source %s between projection and runtime preparation", async (_label, mutate) => {
    writeTask("alpha", "echo alpha", "0 1 * * *");
    const backend = fakeBackend("cron");

    await expect(
      akmTasksSync({
        backend,
        schedulerRuntime() {
          mutate();
          return { binding: ["/test/akm"], contextPath: "/test/context.json" };
        },
      }),
    ).rejects.toThrow(/source|changed|read set|snapshot/i);

    expect(backend.stored.size).toBe(0);
    expect(backend.snapshotCalls).toBe(0);
    expect(backend.calls).toEqual([]);
  });

  test("scheduler source CAS includes a transitive script consumed during dry projection", async () => {
    const script = path.join(storage.stashDir, "scripts", "owned.sh");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, "#!/bin/sh\necho original\n");
    fs.writeFileSync(
      path.join(storage.stashDir, "tasks", "alpha.yml"),
      'version: 4\nuses: scripts/owned.sh\nschedule: "0 1 * * *"\n',
    );
    setSchedulerRefEnabled("task", "stash//tasks/alpha", true);
    const backend = fakeBackend("cron");

    await expect(
      akmTasksSync({
        backend,
        schedulerRuntime() {
          fs.writeFileSync(script, "#!/bin/sh\necho raced\n");
          return { binding: ["/test/akm"], contextPath: "/test/context.json" };
        },
      }),
    ).rejects.toThrow(/source|asset|changed|read set|snapshot/i);

    expect(backend.calls).toEqual([]);
    expect(backend.snapshotCalls).toBe(0);
  });

  test("scheduler source CAS includes a workflow consumed during dry projection", async () => {
    const workflow = path.join(storage.stashDir, "workflows", "owned.yml");
    fs.mkdirSync(path.dirname(workflow), { recursive: true });
    // #867: steps require an `id` to compile at all — the fixture omitted
    // it, so pre-#867 this test's rejection was (accidentally) the task's
    // own "missing required key \"id\"" failure, not the CAS/race check the
    // test is actually about. Degrading no longer treats that per-source
    // parse failure as a whole-set rejection, which surfaced the gap: the
    // fixture must compile successfully so the race genuinely reaches the
    // CAS assertion.
    fs.writeFileSync(
      workflow,
      "name: owned\non: { workflow_dispatch: null }\njobs: { main: { runs-on: [self-hosted], steps: [{ id: run, run: echo original }] } }\n",
    );
    fs.writeFileSync(
      path.join(storage.stashDir, "tasks", "alpha.yml"),
      'version: 4\nuses: workflows/owned\nschedule: "0 1 * * *"\n',
    );
    setSchedulerRefEnabled("task", "stash//tasks/alpha", true);
    const backend = fakeBackend("cron");

    await expect(
      akmTasksSync({
        backend,
        schedulerRuntime() {
          fs.writeFileSync(
            workflow,
            "name: owned\non: { workflow_dispatch: null }\njobs: { main: { runs-on: [self-hosted], steps: [{ id: run, run: echo raced }] } }\n",
          );
          return { binding: ["/test/akm"], contextPath: "/test/context.json" };
        },
      }),
    ).rejects.toThrow(/source|workflow|changed|read set|snapshot/i);

    expect(backend.calls).toEqual([]);
    expect(backend.snapshotCalls).toBe(0);
  });

  test.each([
    "command",
    "persona",
  ] as const)("scheduler source CAS includes a transitive %s consumed during command projection", async (kind) => {
    const command = path.join(storage.stashDir, "commands", "review.md");
    const persona = path.join(storage.stashDir, "agents", "reviewer.md");
    fs.mkdirSync(path.dirname(command), { recursive: true });
    fs.mkdirSync(path.dirname(persona), { recursive: true });
    fs.writeFileSync(command, "---\nname: review\ntype: command\n---\nReview exactly.\n");
    fs.writeFileSync(persona, "---\nname: reviewer\ntype: agent\n---\nBe exact.\n");
    fs.writeFileSync(
      path.join(storage.stashDir, "tasks", "alpha.yml"),
      [
        "version: 4",
        "uses: akm/command",
        "with:",
        "  ref: commands/review",
        "agent: agents/reviewer",
        'schedule: "0 1 * * *"',
        "",
      ].join("\n"),
    );
    setSchedulerRefEnabled("task", "stash//tasks/alpha", true);
    await akmIndex({ stashDir: storage.stashDir, full: true });
    const backend = fakeBackend("cron");
    const raced = kind === "command" ? command : persona;

    await expect(
      akmTasksSync({
        backend,
        schedulerRuntime() {
          fs.writeFileSync(raced, `---\nname: raced\ntype: ${kind === "command" ? "command" : "agent"}\n---\nRaced.\n`);
          return { binding: ["/test/akm"], contextPath: "/test/context.json" };
        },
      }),
    ).rejects.toThrow(/source|asset|changed|read set|snapshot/i);

    expect(backend.calls).toEqual([]);
    expect(backend.snapshotCalls).toBe(0);
  });

  test.each([
    "cron",
    "launchd",
    "schtasks",
  ] as const)("%s restores an earlier create when a later create fails", async (name) => {
    writeTask("alpha", "echo alpha", "0 1 * * *");
    writeTask("beta", "echo beta", "0 2 * * *");
    const backend = fakeBackend(name, [], { kind: "install", id: "beta" });

    await expect(akmTasksSync({ backend })).rejects.toThrow("install failed for beta");

    expect(backend.stored.size).toBe(0);
    expect(backend.snapshotCalls).toBe(1);
    expect(backend.restoreCalls).toBe(1);
    expect(backend.calls).toEqual(["install:alpha:cas", "install:beta:cas"]);
  });

  test.each([
    "cron",
    "launchd",
    "schtasks",
  ] as const)("%s restores an earlier update when a later update fails", async (name) => {
    const alpha = binding("alpha", "0 1 * * *");
    const beta = binding("beta", "0 2 * * *");
    writeTask("alpha", "echo alpha", "15 1 * * *");
    writeTask("beta", "echo beta", "15 2 * * *");
    const backend = fakeBackend(name, [alpha, beta], { kind: "install", id: "beta" });

    await expect(akmTasksSync({ backend })).rejects.toThrow("install failed for beta");

    expect(backend.stored.get("alpha")?.binding.cron).toBe("0 1 * * *");
    expect(backend.stored.get("beta")?.binding.cron).toBe("0 2 * * *");
    expect(backend.restoreCalls).toBe(1);
    expect(backend.calls).toEqual(["install:alpha:cas", "install:beta:cas"]);
  });

  test.each([
    "cron",
    "launchd",
    "schtasks",
  ] as const)("%s restores an earlier removal when a later removal fails", async (name) => {
    const alpha = binding("alpha", "0 1 * * *");
    const beta = binding("beta", "0 2 * * *");
    const backend = fakeBackend(name, [alpha, beta], { kind: "uninstall", id: "beta" });

    await expect(akmTasksSync({ backend })).rejects.toThrow("remove failed for beta");

    expect([...backend.stored.keys()].sort()).toEqual(["alpha", "beta"]);
    expect(backend.restoreCalls).toBe(1);
    expect(backend.calls).toEqual(["remove:alpha:cas", "remove:beta:cas"]);
  });

  test.each([
    "cron",
    "launchd",
    "schtasks",
  ] as const)("%s restores a mixed create/update/remove plan exactly", async (name) => {
    const update = binding("update", "0 1 * * *");
    const remove = binding("remove", "0 2 * * *");
    writeTask("create", "echo create", "0 3 * * *");
    writeTask("update", "echo update", "15 1 * * *");
    const backend = fakeBackend(name, [update, remove], { kind: "uninstall", id: "remove" });

    await expect(akmTasksSync({ backend })).rejects.toThrow("remove failed for remove");

    expect([...backend.stored.keys()].sort()).toEqual(["remove", "update"]);
    expect(backend.stored.get("update")?.binding.cron).toBe("0 1 * * *");
    expect(backend.restoreCalls).toBe(1);
  });

  test("aggregates the primary mutation error with best-effort rollback failures", async () => {
    writeTask("alpha", "echo alpha", "0 1 * * *");
    writeTask("beta", "echo beta", "0 2 * * *");
    const backend = fakeBackend("cron", [], { kind: "install", id: "beta" }, "alpha");

    let caught: unknown;
    try {
      await akmTasksSync({ backend });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors.map(String)).toEqual([
      "Error: install failed for beta",
      expect.stringContaining("partial rollback failure"),
    ]);
    expect(backend.restoreCalls).toBe(1);
  });

  test.each([
    "cron",
    "launchd",
    "schtasks",
  ] as const)("%s rollback CAS preserves a concurrent same-native edit and reports incomplete rollback", async (name) => {
    const alpha = binding("alpha", "0 1 * * *");
    writeTask("alpha", "echo alpha", "15 1 * * *");
    writeTask("beta", "echo beta", "0 2 * * *");
    const backend = fakeBackend(name, [alpha], { kind: "install", id: "beta" }, undefined, "alpha");

    let caught: unknown;
    try {
      await akmTasksSync({ backend });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect(String(caught)).toMatch(/rollback|transaction/i);
    expect(backend.stored.get("alpha")?.fingerprint).toBe("concurrent-foreign-bytes");
    expect(backend.lastRollbackGuards?.map((guard) => guard.nativeId).sort()).toEqual(["alpha", "beta"]);
  });

  test("fails closed before mutation when a custom backend lacks coherent inspection", async () => {
    writeTask("alpha", "echo alpha", "0 1 * * *");
    let installs = 0;
    const backend = {
      name: "cron",
      list: () => [],
      install: () => {
        installs += 1;
      },
      uninstall() {},
      setEnabled() {},
    } as unknown as SchedulerBackend;

    await expect(akmTasksSync({ backend })).rejects.toThrow(/coherent inspection/i);
    expect(installs).toBe(0);
  });

  test("fails closed before mutation when a custom backend lacks an exact transaction snapshot", async () => {
    writeTask("alpha", "echo alpha", "0 1 * * *");
    const complete = fakeBackend("cron");
    let installs = 0;
    const backend = {
      name: "cron",
      inspectBindings: complete.inspectBindings,
      expectedSignature: complete.expectedSignature,
      list: complete.list,
      install: () => {
        installs += 1;
      },
      uninstall() {},
      setEnabled() {},
    } as unknown as SchedulerBackend;

    await expect(akmTasksSync({ backend })).rejects.toThrow(/snapshot and restore/i);
    expect(installs).toBe(0);
  });

  test("transaction snapshot validation rejects duplicate artifacts for one normalized native key", async () => {
    const prior = binding("alpha", "0 1 * * *");
    writeTask("alpha", "echo alpha", "15 1 * * *");
    const backend = fakeBackend("cron", [prior]);
    const originalSnapshot = backend.snapshotBindings!.bind(backend);
    backend.snapshotBindings = ((ids: readonly string[]) => {
      const snapshot = originalSnapshot(ids) as unknown as FakeSnapshot;
      return Object.freeze({
        ...snapshot,
        artifacts: Object.freeze([...snapshot.artifacts, ...snapshot.artifacts]),
      });
    }) as never;

    await expect(akmTasksSync({ backend })).rejects.toThrow(/cardinality|duplicate|exactly one|collision/i);
    expect(backend.calls).toEqual([]);
    expect(backend.stored.get("alpha")?.binding.cron).toBe("0 1 * * *");
  });
});
