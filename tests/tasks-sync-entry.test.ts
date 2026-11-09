// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm task sync`, `task prune` and `task doctor` against the one scheduler
 * entry: install, keep, rebind, remove; the akm 0.9 per-task rows removed in the
 * same operation; an installation that moves its locations left alone. The
 * backend is an in-memory fake, so no OS scheduler is reached.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmTasksDoctor, akmTasksPrune, akmTasksSync, akmTasksSyncPlan } from "../src/commands/tasks/tasks";
import { saveConfig } from "../src/core/config/config";
import type { DispatchEntry, EntryChange, LegacyRow, SchedulerBackend } from "../src/tasks/backends/types";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

let storage: IsolatedAkmStorage;
/** The installation's default locations: only HOME resolves them. */
const DEFAULT_ENV = { HOME: "/home/nobody", PATH: "/usr/bin:/bin" };

interface FakeState {
  entry?: DispatchEntry;
  legacy: LegacyRow[];
  applied: EntryChange[];
}

function fakeBackend(state: FakeState): SchedulerBackend {
  return {
    name: "cron",
    inspect: () => ({ ...(state.entry ? { entry: state.entry } : {}), legacy: state.legacy }),
    apply(change) {
      state.applied.push(change);
      if (change.entry === null) delete state.entry;
      else if (change.entry !== undefined) state.entry = change.entry;
      state.legacy = state.legacy.filter((row) => !change.removeLegacy.includes(row.id));
    },
  };
}

const launcher =
  (...argv: string[]) =>
  () => ({ argv });

function configure(enabled: string[] | undefined): void {
  saveConfig({
    semanticSearchMode: "off",
    defaultBundle: "stash",
    bundles: { stash: { path: storage.stashDir, writable: true } },
    ...(enabled ? { scheduler: { enabled } } : {}),
  });
}

let state: FakeState;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  state = { legacy: [], applied: [] };
});

afterEach(() => {
  storage.cleanup();
});

describe("task sync: the one entry", () => {
  test("installs the entry with the launcher and the PATH of the invoking shell when a task is enabled", async () => {
    configure(["stash//tasks/a"]);

    const result = await akmTasksSync(
      { backend: fakeBackend(state), launcher: launcher("/opt/akm"), env: DEFAULT_ENV },
      {},
    );

    expect(result).toEqual({ backend: "cron", entry: "installed", removedLegacy: [], keptLegacy: [] });
    expect(state.entry).toEqual({ launcher: ["/opt/akm"], path: "/usr/bin:/bin" });
    expect(state.applied).toHaveLength(1);
  });

  test("a second sync changes nothing, and keeps the launcher and PATH it has, even from a different shell", async () => {
    configure(["stash//tasks/a"]);
    const deps = { backend: fakeBackend(state), env: DEFAULT_ENV };
    await akmTasksSync({ ...deps, launcher: launcher("/opt/akm") }, {});

    const again = await akmTasksSync(
      { backend: deps.backend, launcher: launcher("/elsewhere/akm"), env: { HOME: "/home/nobody", PATH: "/bin" } },
      {},
    );

    expect(again.entry).toBe("unchanged");
    expect(state.applied).toHaveLength(1);
    expect(state.entry).toEqual({ launcher: ["/opt/akm"], path: "/usr/bin:/bin" });
  });

  test("--rebind points the entry at this akm and PATH; a rebind to what is installed writes nothing", async () => {
    configure(["stash//tasks/a"]);
    state.entry = { launcher: ["/old/akm"], path: "/usr/bin" };
    const deps = { backend: fakeBackend(state), launcher: launcher("/new/akm"), env: DEFAULT_ENV };

    const rebound = await akmTasksSync(deps, { rebind: true });
    expect(rebound.entry).toBe("updated");
    expect(state.entry).toEqual({ launcher: ["/new/akm"], path: "/usr/bin:/bin" });

    const writes = state.applied.length;
    expect((await akmTasksSync(deps, { rebind: true })).entry).toBe("unchanged");
    expect(state.applied).toHaveLength(writes);
  });

  test("warns once when it writes a source-checkout launcher", async () => {
    configure(["stash//tasks/a"]);

    const result = await akmTasksSync(
      {
        backend: fakeBackend(state),
        launcher: () => ({ argv: ["/usr/bin/bun", "/work/akm/src/cli.ts"], via: "checkout" }),
        env: DEFAULT_ENV,
      },
      {},
    );

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toContain("source checkout");
    expect(result.warnings?.[0]).toContain("akm task sync --rebind");
  });

  test("removes the entry when no task is enabled, and does nothing when there is none", async () => {
    configure([]);
    state.entry = { launcher: ["/opt/akm"] };
    const deps = { backend: fakeBackend(state), env: DEFAULT_ENV };

    expect((await akmTasksSync(deps, {})).entry).toBe("removed");
    expect(state.entry).toBeUndefined();

    const writes = state.applied.length;
    expect((await akmTasksSync(deps, {})).entry).toBe("absent");
    expect(state.applied).toHaveLength(writes);
  });

  test("a config that has never chosen (no scheduler.enabled) schedules nothing", async () => {
    configure(undefined);
    state.entry = { launcher: ["/opt/akm"] };

    const result = await akmTasksSync({ backend: fakeBackend(state), env: DEFAULT_ENV }, {});

    expect(result.entry).toBe("removed");
  });
});

describe("task sync: akm 0.9 per-task rows", () => {
  const ours = (id: string): LegacyRow => ({ id, environment: { AKM_BUNDLE_DIR: "" } });

  test("every row this installation wrote goes in the same operation that installs the entry", async () => {
    configure(["stash//tasks/a"]);
    state.legacy = [
      { id: "a", environment: { AKM_BUNDLE_DIR: storage.stashDir } },
      { id: "b", environment: {} },
    ];

    const result = await akmTasksSync(
      { backend: fakeBackend(state), launcher: launcher("/opt/akm"), env: DEFAULT_ENV },
      {},
    );

    expect(result.entry).toBe("installed");
    expect(result.removedLegacy).toEqual(["a", "b"]);
    expect(state.applied).toEqual([
      { entry: { launcher: ["/opt/akm"], path: "/usr/bin:/bin" }, removeLegacy: ["a", "b"] },
    ]);
    expect(state.legacy).toEqual([]);
  });

  test("a row that names another installation is left, and reported", async () => {
    configure(["stash//tasks/a"]);
    state.legacy = [
      { id: "mine", environment: { AKM_BUNDLE_DIR: storage.stashDir } },
      { id: "sandbox-bundle", environment: { AKM_BUNDLE_DIR: "/tmp/some-other-stash" } },
      { id: "sandbox-state", environment: { AKM_STATE_DIR: "/tmp/elsewhere" } },
    ];

    const result = await akmTasksSync(
      { backend: fakeBackend(state), launcher: launcher("/opt/akm"), env: DEFAULT_ENV },
      {},
    );

    expect(result.removedLegacy).toEqual(["mine"]);
    expect(result.keptLegacy.map((kept) => kept.id)).toEqual(["sandbox-bundle", "sandbox-state"]);
    expect(result.warnings?.join("\n")).toContain("sandbox-bundle");
    expect(state.legacy.map((row) => row.id)).toEqual(["sandbox-bundle", "sandbox-state"]);
  });

  test("legacy rows are removed even when no task is enabled, with the entry left absent", async () => {
    configure([]);
    state.legacy = [ours("a")].map((row) => ({ ...row, environment: {} }));

    const result = await akmTasksSync({ backend: fakeBackend(state), env: DEFAULT_ENV }, {});

    expect(result).toMatchObject({ entry: "absent", removedLegacy: ["a"] });
  });

  test("--dry-run says what would happen and writes nothing", async () => {
    configure(["stash//tasks/a"]);
    state.legacy = [{ id: "a", environment: {} }];

    const preview = await akmTasksSyncPlan(
      { backend: fakeBackend(state), launcher: launcher("/opt/akm"), env: DEFAULT_ENV },
      {},
    );

    expect(preview).toMatchObject({ entry: "installed", removedLegacy: ["a"], hasRemovals: true, failures: [] });
    expect(state.applied).toEqual([]);
    expect(state.entry).toBeUndefined();
  });
});

describe("task sync: an installation that moves its locations", () => {
  test.each([
    ["AKM_CONFIG_DIR", { AKM_CONFIG_DIR: "/srv/akm/config" }, "config"],
    ["AKM_STATE_DIR", { AKM_STATE_DIR: "/srv/akm/state" }, "state"],
    ["AKM_BUNDLE_DIR", { AKM_BUNDLE_DIR: "/srv/akm/stash" }, "bundle"],
    ["XDG_DATA_HOME", { XDG_DATA_HOME: "/srv/xdg/data" }, "data"],
  ])("%s: never writes the OS scheduler, and says to run `akm task dispatch` from its own supervisor", async (_name, moved, location) => {
    configure(["stash//tasks/a"]);
    state.legacy = [{ id: "a", environment: {} }];
    let inspected = false;
    const backend: SchedulerBackend = {
      ...fakeBackend(state),
      inspect: () => {
        inspected = true;
        return { legacy: state.legacy };
      },
    };

    const result = await akmTasksSync(
      { backend, launcher: launcher("/opt/akm"), env: { ...DEFAULT_ENV, ...moved } },
      {
        rebind: true,
      },
    );

    expect(result.entry).toBe("unmanaged");
    expect(result.warnings?.[0]).toContain(location);
    expect(result.warnings?.[0]).toContain("akm task dispatch");
    expect(inspected).toBe(false);
    expect(state.applied).toEqual([]);
  });

  test("any AKM_*_DIR variable makes the installation non-default (AKM_CACHE_DIR)", async () => {
    configure(["stash//tasks/a"]);
    const result = await akmTasksSync(
      { backend: fakeBackend(state), launcher: launcher("/opt/akm"), env: { ...DEFAULT_ENV, AKM_CACHE_DIR: "/srv/c" } },
      {},
    );
    expect(result.entry).toBe("unmanaged");
  });
});

describe("task sync: the default installation, as every 0.9.32 and 0.10 row names it", () => {
  test("AKM_BUNDLE_DIR equal to the configured default bundle does not move the installation", async () => {
    configure(["stash//tasks/a"]);
    state.legacy = [{ id: "a", environment: { AKM_BUNDLE_DIR: storage.stashDir } }];

    const result = await akmTasksSync(
      {
        backend: fakeBackend(state),
        launcher: launcher("/opt/akm"),
        env: { ...DEFAULT_ENV, AKM_BUNDLE_DIR: storage.stashDir },
      },
      {},
    );

    expect(result).toMatchObject({ entry: "installed", removedLegacy: ["a"] });
    expect(state.entry).toBeDefined();
  });

  test("AKM_BUNDLE_DIR naming some other directory still does", async () => {
    configure(["stash//tasks/a"]);
    const result = await akmTasksSync(
      {
        backend: fakeBackend(state),
        launcher: launcher("/opt/akm"),
        env: { ...DEFAULT_ENV, AKM_BUNDLE_DIR: path.join(storage.root, "elsewhere") },
      },
      {},
    );
    expect(result.entry).toBe("unmanaged");
    expect(result.warnings?.[0]).toContain("bundle");
  });
});

describe("task sync: an akm carried inside another package or app", () => {
  const carried = () => ({
    argv: ["/usr/bin/bun", "/cache/akm/0.10.1/node_modules/akm-cli/dist/cli.js"],
    via: "package-local",
  });

  test("never writes the entry, and says so without telling the user to install akm or calling it a checkout", async () => {
    configure(["stash//tasks/a"]);

    const result = await akmTasksSync({ backend: fakeBackend(state), launcher: carried, env: DEFAULT_ENV }, {});

    expect(result.entry).toBe("unmanaged");
    expect(state.applied).toEqual([]);
    const message = result.warnings?.join("\n") ?? "";
    expect(message).toContain("/cache/akm/0.10.1/node_modules/akm-cli/dist/cli.js");
    expect(message).toContain("akm task dispatch");
    expect(message).not.toMatch(/install/i);
    expect(message).not.toContain("checkout");
  });

  test("an entry that is already installed is left alone by a sync from it, and is removed when no task is enabled", async () => {
    state.entry = { launcher: ["/opt/akm"] };
    configure(["stash//tasks/a"]);
    expect((await akmTasksSync({ backend: fakeBackend(state), launcher: carried, env: DEFAULT_ENV }, {})).entry).toBe(
      "unchanged",
    );
    configure([]);
    expect((await akmTasksSync({ backend: fakeBackend(state), launcher: carried, env: DEFAULT_ENV }, {})).entry).toBe(
      "removed",
    );
  });
});

describe("task prune", () => {
  const dead = path.join("/nonexistent", "akm-dead-bundle");

  test("lists akm 0.9 rows whose bundle directory is gone, and removes them only with --yes", async () => {
    state.legacy = [
      { id: "gone", environment: { AKM_BUNDLE_DIR: dead } },
      { id: "alive", environment: { AKM_BUNDLE_DIR: storage.stashDir } },
    ];
    const backend = fakeBackend(state);

    const preview = await akmTasksPrune({ backend }, {});
    expect(preview.dryRun).toBe(true);
    expect(preview.preview.removals).toEqual([{ id: "gone", reason: "dead-bundle-path" }]);
    expect(state.applied).toEqual([]);

    const done = await akmTasksPrune({ backend }, { yes: true });
    expect(done).toMatchObject({ dryRun: false, removed: ["gone"] });
    expect(state.legacy.map((row) => row.id)).toEqual(["alive"]);
  });

  test("--id refuses a row that is not an orphan candidate", async () => {
    state.legacy = [{ id: "alive", environment: { AKM_BUNDLE_DIR: storage.stashDir } }];
    await expect(akmTasksPrune({ backend: fakeBackend(state) }, { yes: true, id: ["alive"] })).rejects.toMatchObject({
      code: "INVALID_FLAG_VALUE",
    });
  });
});

describe("task doctor", () => {
  test("reports the entry with the enabled tasks it fires, and flags a missing launcher path", async () => {
    configure(["stash//tasks/a", "stash//tasks/b"]);
    const missing = path.join(storage.root, "no-such-akm");
    state.entry = { launcher: [missing] };

    const report = await akmTasksDoctor({ backend: fakeBackend(state), env: DEFAULT_ENV });

    expect(report.backend).toBe("cron");
    expect(report.bindings).toEqual([{ argv: [missing], taskIds: ["a", "b"], status: ["missing-path"] }]);
    expect(report.remediation).toBe("akm task sync --rebind");
  });

  test("an entry that is healthy has no remediation", async () => {
    configure(["stash//tasks/a"]);
    const real = path.join(storage.root, "akm-real");
    fs.writeFileSync(real, "#!/bin/sh\n", { mode: 0o755 });
    state.entry = { launcher: [real] };

    const report = await akmTasksDoctor({ backend: fakeBackend(state), env: DEFAULT_ENV });

    expect(report.bindings[0]?.status).toEqual(["ok"]);
    expect(report.remediation).toBeUndefined();
  });

  test("enabled tasks with no entry installed is a warning; legacy rows ask for a plain sync", async () => {
    configure(["stash//tasks/a"]);
    state.legacy = [{ id: "old", environment: {} }];

    const report = await akmTasksDoctor({ backend: fakeBackend(state), env: DEFAULT_ENV });

    expect(report.warnings.join("\n")).toContain("entry is not installed");
    expect(report.bindings).toEqual([{ argv: [], taskIds: ["old"], status: ["legacy"] }]);
    expect(report.remediation).toBe("akm task sync");
  });

  test("an enabled task that cannot run is a warning naming the task and why, for a bad schedule and for a missing file", async () => {
    fs.mkdirSync(path.join(storage.stashDir, "tasks"), { recursive: true });
    fs.writeFileSync(
      path.join(storage.stashDir, "tasks", "reboot.yml"),
      'version: 4\nrun: "true"\nschedule: "@reboot"\n',
    );
    fs.writeFileSync(path.join(storage.stashDir, "tasks", "fine.yml"), 'version: 4\nrun: "true"\nschedule: "@daily"\n');
    configure(["stash//tasks/reboot", "stash//tasks/gone", "stash//tasks/fine"]);
    state.entry = { launcher: [process.execPath] };

    const report = await akmTasksDoctor({ backend: fakeBackend(state), env: DEFAULT_ENV });

    const text = report.warnings.join("\n");
    expect(text).toContain("stash//tasks/reboot");
    expect(text).toContain("stash//tasks/gone");
    expect(text).not.toContain("stash//tasks/fine");
  });

  test("a non-default installation reports that it owns no entry and reads nothing from the OS", async () => {
    configure(["stash//tasks/a"]);
    let inspected = false;
    const backend: SchedulerBackend = {
      ...fakeBackend(state),
      inspect: () => {
        inspected = true;
        return { legacy: [] };
      },
    };

    const report = await akmTasksDoctor({ backend, env: { ...DEFAULT_ENV, AKM_STATE_DIR: "/srv/state" } });

    expect(inspected).toBe(false);
    expect(report.bindings).toEqual([]);
    expect(report.warnings.join("\n")).toContain("akm task dispatch");
  });
});
