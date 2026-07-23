// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmTasksAdd, akmTasksSetEnabled, akmTasksSync } from "../../../src/commands/tasks/tasks";
import type { TaskBackend } from "../../../src/tasks/backends";
import type { ScheduleBackend } from "../../../src/tasks/schedule";
import type { TaskDocument } from "../../../src/tasks/schema";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let backendName: ScheduleBackend;
let installed: Map<string, TaskDocument | undefined>;
let installCalls: TaskDocument[];
let enabledCalls: Array<{ id: string; enabled: boolean }>;
let uninstallCalls: string[];
let failInstall: ((task: TaskDocument) => boolean) | undefined;
let setEnabledError: Error | undefined;
let uninstallError: Error | undefined;

const backend: TaskBackend = {
  get name() {
    return backendName;
  },
  install(task) {
    installCalls.push(task);
    if (failInstall?.(task)) throw new Error(`install failed for ${task.id}`);
    installed.set(task.id, task);
  },
  uninstall(id) {
    uninstallCalls.push(id);
    if (uninstallError) throw uninstallError;
    installed.delete(id);
  },
  setEnabled(id, enabled) {
    enabledCalls.push({ id, enabled });
    if (setEnabledError) throw setEnabledError;
    const task = installed.get(id);
    if (task) installed.set(id, { ...task, enabled });
  },
  list() {
    return [...installed.keys()].map((id) => ({ id }));
  },
};

function writeTask(id: string, yaml: string): string {
  const filePath = path.join(storage.stashDir, "tasks", `${id}.yml`);
  fs.writeFileSync(filePath, yaml, "utf8");
  return filePath;
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  fs.mkdirSync(path.join(storage.stashDir, "tasks"), { recursive: true });
  backendName = "cron";
  installed = new Map();
  installCalls = [];
  enabledCalls = [];
  uninstallCalls = [];
  failInstall = undefined;
  setEnabledError = undefined;
  uninstallError = undefined;
});

afterEach(() => {
  storage.cleanup();
});

describe("task lifecycle failure handling", () => {
  test("sync disables an installed task whose filesystem-derived id is invalid", async () => {
    writeTask("manual task", 'version: 2\nschedule: "@daily"\ncommand: echo unsafe\n');
    installed.set("manual task", undefined);

    const result = await akmTasksSync({ backend });

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.id).toBe("manual task");
    expect(result.skipped[0]?.reason).toContain('Task id "manual task" is invalid');
    expect(enabledCalls).toEqual([{ id: "manual task", enabled: false }]);
    expect(installCalls).toEqual([]);
  });

  test("sync disables an installed task whose schedule is unsupported by the backend", async () => {
    backendName = "schtasks";
    writeTask("monthly", 'version: 2\nschedule: "0 0 1 * *"\ncommand: echo monthly\n');
    installed.set("monthly", undefined);

    const result = await akmTasksSync({ backend });

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.id).toBe("monthly");
    expect(enabledCalls).toEqual([{ id: "monthly", enabled: false }]);
    expect(installCalls).toEqual([]);
  });

  test("add --force trusts a rejected install to preserve prior scheduler state and restores only source", async () => {
    const priorYaml = [
      "version: 2",
      'schedule: "0 2 * * *"',
      "command: echo prior",
      "enabled: false",
      "name: Prior task",
    ].join("\n");
    const taskPath = writeTask("nightly", priorYaml);
    const priorTask: TaskDocument = {
      version: 2,
      schemaVersion: 2,
      id: "nightly",
      schedule: "0 2 * * *",
      enabled: false,
      target: { kind: "command", cmd: ["echo", "prior"] },
      name: "Prior task",
      source: { path: taskPath },
    };
    installed.set("nightly", priorTask);
    failInstall = (task) => task.schedule === "0 3 * * *";

    await expect(
      akmTasksAdd(
        {
          id: "nightly",
          schedule: "0 3 * * *",
          command: "echo replacement",
          force: true,
        },
        { backend },
      ),
    ).rejects.toThrow("install failed for nightly");

    expect(fs.readFileSync(taskPath, "utf8")).toBe(priorYaml);
    expect(installCalls.map((task) => ({ schedule: task.schedule, enabled: task.enabled }))).toEqual([
      { schedule: "0 3 * * *", enabled: true },
    ]);
    expect(enabledCalls).toEqual([]);
    expect(uninstallCalls).toEqual([]);
    expect(installed.get("nightly")).toMatchObject({ schedule: "0 2 * * *", enabled: false });
  });

  test("set-enabled trusts a rejected install to preserve prior scheduler state and restores only source", async () => {
    const priorYaml = 'version: 2\nschedule: "@daily"\ncommand: echo prior\nenabled: true';
    const taskPath = writeTask("toggle", priorYaml);
    installed.set("toggle", {
      version: 2,
      schemaVersion: 2,
      id: "toggle",
      schedule: "@daily",
      enabled: true,
      target: { kind: "command", cmd: ["echo", "prior"] },
      source: { path: taskPath },
    });
    failInstall = (task) => !task.enabled;

    await expect(akmTasksSetEnabled("toggle", false, { backend })).rejects.toThrow("install failed for toggle");

    expect(fs.readFileSync(taskPath, "utf8")).toBe(priorYaml);
    expect(installCalls.map((task) => task.enabled)).toEqual([false]);
    expect(enabledCalls).toEqual([]);
    expect(uninstallCalls).toEqual([]);
    expect(installed.get("toggle")?.enabled).toBe(true);
  });

  test("add does not uninstall an orphaned prior scheduler entry when replacement install rejects", async () => {
    const taskPath = path.join(storage.stashDir, "tasks", "orphaned.yml");
    installed.set("orphaned", {
      version: 2,
      schemaVersion: 2,
      id: "orphaned",
      schedule: "0 2 * * *",
      enabled: true,
      target: { kind: "command", cmd: ["echo", "native-prior"] },
      source: { path: taskPath },
    });
    failInstall = (task) => task.schedule === "0 3 * * *";

    await expect(
      akmTasksAdd(
        {
          id: "orphaned",
          schedule: "0 3 * * *",
          command: "echo replacement",
        },
        { backend },
      ),
    ).rejects.toThrow("install failed for orphaned");

    expect(fs.existsSync(taskPath)).toBe(false);
    expect(installCalls.map((task) => task.schedule)).toEqual(["0 3 * * *"]);
    expect(enabledCalls).toEqual([]);
    expect(uninstallCalls).toEqual([]);
    expect(installed.get("orphaned")).toMatchObject({ schedule: "0 2 * * *", enabled: true });
  });

  test("add --force restores exact prior bytes after a partial source write throws", async () => {
    const priorYaml = [
      "version: 2",
      'schedule: "0 2 * * *"',
      "command: echo prior",
      "enabled: true # exact prior bytes",
    ].join("\n");
    const taskPath = writeTask("nightly", priorYaml);
    let writeCalls = 0;

    await expect(
      akmTasksAdd(
        {
          id: "nightly",
          schedule: "0 3 * * *",
          command: "echo replacement",
          force: true,
        },
        {
          backend,
          async writeAsset(_source, _config, ref, content) {
            writeCalls += 1;
            if (writeCalls === 1) {
              fs.writeFileSync(taskPath, "version: 2\nschedule:", "utf8");
              throw new Error("partial source write failed");
            }
            fs.writeFileSync(taskPath, content, "utf8");
            return { path: taskPath, ref: `${ref.type}:${ref.name}` };
          },
        },
      ),
    ).rejects.toThrow("partial source write failed");

    expect(writeCalls).toBe(2);
    expect(fs.readFileSync(taskPath, "utf8")).toBe(priorYaml);
    expect(installCalls).toEqual([]);
    expect(uninstallCalls).toEqual([]);
  });

  test("add removes a newly created partial source file when its write throws", async () => {
    const taskPath = path.join(storage.stashDir, "tasks", "partial.yml");
    let deleteCalls = 0;

    await expect(
      akmTasksAdd(
        {
          id: "partial",
          schedule: "@daily",
          command: "echo partial",
        },
        {
          backend,
          async writeAsset() {
            fs.writeFileSync(taskPath, "version: 2\nschedule:", "utf8");
            throw new Error("partial source write failed");
          },
          async deleteAsset(_source, _config, ref) {
            deleteCalls += 1;
            fs.unlinkSync(taskPath);
            return { path: taskPath, ref: `${ref.type}:${ref.name}` };
          },
        },
      ),
    ).rejects.toThrow("partial source write failed");

    expect(deleteCalls).toBe(1);
    expect(fs.existsSync(taskPath)).toBe(false);
    expect(installCalls).toEqual([]);
    expect(uninstallCalls).toEqual([]);
  });

  test("add does not compensate an unmutated source when its write rejects before creating a file", async () => {
    const taskPath = path.join(storage.stashDir, "tasks", "unwritten.yml");
    let deleteCalls = 0;
    let failure: unknown;

    try {
      await akmTasksAdd(
        {
          id: "unwritten",
          schedule: "@daily",
          command: "echo unwritten",
        },
        {
          backend,
          async writeAsset() {
            throw new Error("source write rejected");
          },
          async deleteAsset() {
            deleteCalls += 1;
            throw new Error("unexpected source delete");
          },
        },
      );
    } catch (err) {
      failure = err;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(AggregateError);
    expect((failure as Error).message).toBe("source write rejected");
    expect(deleteCalls).toBe(0);
    expect(fs.existsSync(taskPath)).toBe(false);
    expect(installCalls).toEqual([]);
    expect(uninstallCalls).toEqual([]);
  });

  test("install rejection aggregates source rollback failure without touching a valid prior entry", async () => {
    const priorYaml = 'version: 2\nschedule: "0 2 * * *"\ncommand: echo prior\nenabled: true\n';
    const taskPath = writeTask("nightly", priorYaml);
    installed.set("nightly", {
      version: 2,
      schemaVersion: 2,
      id: "nightly",
      schedule: "0 2 * * *",
      enabled: true,
      target: { kind: "command", cmd: ["echo", "prior"] },
      source: { path: taskPath },
    });
    failInstall = () => true;
    let writeCalls = 0;
    let failure: unknown;

    try {
      await akmTasksAdd(
        {
          id: "nightly",
          schedule: "0 3 * * *",
          command: "echo replacement",
          force: true,
        },
        {
          backend,
          async writeAsset(_source, _config, ref, content) {
            writeCalls += 1;
            if (writeCalls === 2) throw new Error("source restore failed");
            fs.writeFileSync(taskPath, content, "utf8");
            return { path: taskPath, ref: `${ref.type}:${ref.name}` };
          },
        },
      );
    } catch (err) {
      failure = err;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error) => String(error))).toEqual([
      "Error: install failed for nightly",
      "Error: source restore failed",
    ]);
    expect(installCalls.map((task) => task.schedule)).toEqual(["0 3 * * *"]);
    expect(enabledCalls).toEqual([]);
    expect(uninstallCalls).toEqual([]);
    expect(installed.get("nightly")).toMatchObject({ schedule: "0 2 * * *", enabled: true });
  });

  test("commit failure disables the replacement when restoring the prior scheduler definition fails", async () => {
    const priorYaml = 'version: 2\nschedule: "0 2 * * *"\ncommand: echo prior\nenabled: true\n';
    const taskPath = writeTask("nightly", priorYaml);
    installed.set("nightly", {
      version: 2,
      schemaVersion: 2,
      id: "nightly",
      schedule: "0 2 * * *",
      enabled: true,
      target: { kind: "command", cmd: ["echo", "prior"] },
      source: { path: taskPath },
    });
    failInstall = (task) => task.schedule === "0 2 * * *";
    let commitCalls = 0;
    let failure: unknown;

    try {
      await akmTasksAdd(
        {
          id: "nightly",
          schedule: "0 3 * * *",
          command: "echo replacement",
          force: true,
        },
        {
          backend,
          commitBoundary() {
            commitCalls += 1;
            if (commitCalls === 1) throw new Error("commit boundary failed");
          },
        },
      );
    } catch (err) {
      failure = err;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error) => String(error))).toEqual([
      "Error: commit boundary failed",
      "Error: install failed for nightly",
    ]);
    expect(commitCalls).toBe(2);
    expect(fs.readFileSync(taskPath, "utf8")).toBe(priorYaml);
    expect(installCalls.map((task) => task.schedule)).toEqual(["0 3 * * *", "0 2 * * *"]);
    expect(enabledCalls).toEqual([{ id: "nightly", enabled: false }]);
    expect(uninstallCalls).toEqual([]);
    expect(installed.get("nightly")).toMatchObject({ schedule: "0 3 * * *", enabled: false });
  });

  test("commit failure uninstalls the replacement and aggregates a failed fail-safe disable", async () => {
    const priorYaml = 'version: 2\nschedule: "0 2 * * *"\ncommand: echo prior\nenabled: true\n';
    const taskPath = writeTask("nightly", priorYaml);
    installed.set("nightly", {
      version: 2,
      schemaVersion: 2,
      id: "nightly",
      schedule: "0 2 * * *",
      enabled: true,
      target: { kind: "command", cmd: ["echo", "prior"] },
      source: { path: taskPath },
    });
    failInstall = (task) => task.schedule === "0 2 * * *";
    setEnabledError = new Error("disable failed for nightly");
    let commitCalls = 0;
    let failure: unknown;

    try {
      await akmTasksAdd(
        {
          id: "nightly",
          schedule: "0 3 * * *",
          command: "echo replacement",
          force: true,
        },
        {
          backend,
          commitBoundary() {
            commitCalls += 1;
            if (commitCalls === 1) throw new Error("commit boundary failed");
          },
        },
      );
    } catch (err) {
      failure = err;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error) => String(error))).toEqual([
      "Error: commit boundary failed",
      "Error: install failed for nightly",
      "Error: disable failed for nightly",
    ]);
    expect(commitCalls).toBe(2);
    expect(fs.readFileSync(taskPath, "utf8")).toBe(priorYaml);
    expect(installCalls.map((task) => task.schedule)).toEqual(["0 3 * * *", "0 2 * * *"]);
    expect(enabledCalls).toEqual([{ id: "nightly", enabled: false }]);
    expect(uninstallCalls).toEqual(["nightly"]);
    expect(installed.has("nightly")).toBe(false);
  });

  test("add --force restores the prior definition and installed state when the commit boundary fails", async () => {
    const priorYaml = 'version: 2\nschedule: "0 2 * * *"\ncommand: echo prior\nenabled: false\n';
    const taskPath = writeTask("nightly", priorYaml);
    installed.set("nightly", {
      version: 2,
      schemaVersion: 2,
      id: "nightly",
      schedule: "0 2 * * *",
      enabled: false,
      target: { kind: "command", cmd: ["echo", "prior"] },
      source: { path: taskPath },
    });
    let commitCalls = 0;

    await expect(
      akmTasksAdd(
        {
          id: "nightly",
          schedule: "0 3 * * *",
          command: "echo replacement",
          force: true,
        },
        {
          backend,
          commitBoundary() {
            commitCalls += 1;
            if (commitCalls === 1) throw new Error("commit boundary failed");
          },
        },
      ),
    ).rejects.toThrow("commit boundary failed");

    expect(commitCalls).toBe(2);
    expect(fs.readFileSync(taskPath, "utf8")).toBe(priorYaml);
    expect(installCalls.map((task) => ({ schedule: task.schedule, enabled: task.enabled }))).toEqual([
      { schedule: "0 3 * * *", enabled: true },
      { schedule: "0 2 * * *", enabled: false },
    ]);
    expect(installed.get("nightly")).toMatchObject({ schedule: "0 2 * * *", enabled: false });
  });

  test.each([
    ["enable", false, true],
    ["disable", true, false],
  ])("%s restores the exact definition and scheduler state when commit fails", async (_verb, before, after) => {
    const yaml = [
      "version: 2",
      'schedule: "@daily"',
      "command: echo keep",
      `enabled: ${before} # preserve this comment`,
      "",
    ].join("\n");
    const taskPath = writeTask("toggle", yaml);
    installed.set("toggle", {
      version: 2,
      schemaVersion: 2,
      id: "toggle",
      schedule: "@daily",
      enabled: before,
      target: { kind: "command", cmd: ["echo", "keep"] },
      source: { path: taskPath },
    });
    let commitCalls = 0;

    await expect(
      akmTasksSetEnabled("toggle", after, {
        backend,
        commitBoundary() {
          commitCalls += 1;
          if (commitCalls === 1) throw new Error("commit boundary failed");
        },
      }),
    ).rejects.toThrow("commit boundary failed");

    expect(commitCalls).toBe(2);
    expect(fs.readFileSync(taskPath, "utf8")).toBe(yaml);
    expect(installCalls.map((task) => task.enabled)).toEqual([after, before]);
    expect(installed.get("toggle")?.enabled).toBe(before);
  });

  test.each([
    "missing",
    "installed",
  ])("sync refuses the enabled published 0.8 backup task when its scheduler entry is %s", async (schedulerState) => {
    const yaml = [
      'schedule: "0 3 * * 0"',
      "command: akm db backups",
      "enabled: true",
      "description: Weekly config/DB backup",
      "",
    ].join("\n");
    const taskPath = writeTask("backup", yaml);
    if (schedulerState === "installed") {
      installed.set("backup", {
        version: 2,
        schemaVersion: 2,
        id: "backup",
        schedule: "0 3 * * 0",
        enabled: true,
        target: { kind: "command", cmd: ["akm", "db", "backups"] },
        description: "Weekly config/DB backup",
        source: { path: taskPath },
      });
    }

    const result = await akmTasksSync({ backend });

    expect(result.installed).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ id: "backup" });
    expect(result.skipped[0]?.reason).toContain("akm db backups");
    expect(result.skipped[0]?.reason).toContain("akm backup create");
    expect(installCalls).toEqual([]);
    expect(enabledCalls).toEqual(schedulerState === "installed" ? [{ id: "backup", enabled: false }] : []);
    expect(fs.readFileSync(taskPath, "utf8")).toBe(yaml);
  });

  test("add refuses the obsolete bare-self backup command before source or scheduler mutation", async () => {
    const taskRoot = path.join(storage.stashDir, "tasks");
    fs.rmSync(taskRoot, { recursive: true });
    let writeCalls = 0;
    let commitCalls = 0;
    let failure: unknown;

    try {
      await akmTasksAdd(
        {
          id: "backup",
          schedule: "0 3 * * 0",
          command: ["akm", "db", "backups"],
        },
        {
          backend,
          async writeAsset(_source, _config, ref) {
            writeCalls += 1;
            return { path: "/unexpected", ref: `${ref.type}:${ref.name}` };
          },
          commitBoundary() {
            commitCalls += 1;
          },
        },
      );
    } catch (err) {
      failure = err;
    }

    expect(writeCalls).toBe(0);
    expect(installCalls).toEqual([]);
    expect(enabledCalls).toEqual([]);
    expect(uninstallCalls).toEqual([]);
    expect(commitCalls).toBe(0);
    expect(fs.existsSync(taskRoot)).toBe(false);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("akm db backups");
  });

  test("add leaves an explicit retained AKM backup command operator-owned", async () => {
    const result = await akmTasksAdd(
      {
        id: "retained-backup",
        schedule: "0 3 * * 0",
        command: ["/opt/retained-0.8/akm", "db", "backups"],
      },
      { backend },
    );

    expect(result.target).toEqual({
      kind: "command",
      cmd: ["/opt/retained-0.8/akm", "db", "backups"],
    });
    expect(installCalls).toHaveLength(1);
  });

  test("sync installs an explicit retained AKM backup command", async () => {
    const yaml = [
      "version: 2",
      'schedule: "0 3 * * 0"',
      'command: ["/opt/retained-0.8/akm", "db", "backups"]',
      "enabled: true",
      "",
    ].join("\n");
    writeTask("retained-backup", yaml);

    const result = await akmTasksSync({ backend });

    expect(result.skipped).toEqual([]);
    expect(result.installed).toEqual(["retained-backup"]);
    expect(installCalls).toHaveLength(1);
  });

  test("enable permits an explicit retained AKM backup command", async () => {
    const yaml = [
      "version: 2",
      'schedule: "0 3 * * 0"',
      'command: ["./akm", "db", "backups"]',
      "enabled: false",
      "",
    ].join("\n");
    const taskPath = writeTask("retained-backup", yaml);

    const result = await akmTasksSetEnabled("retained-backup", true, { backend });

    expect(result.enabled).toBe(true);
    expect(fs.readFileSync(taskPath, "utf8")).toContain("enabled: true");
    expect(installCalls).toHaveLength(1);
  });

  test("enable refuses the obsolete backup command without changing its disabled definition", async () => {
    const yaml = [
      'schedule: "0 3 * * 0"',
      "command: akm db backups",
      "enabled: false",
      "description: Disabled legacy backup listing task",
      "",
    ].join("\n");
    const taskPath = writeTask("backup", yaml);

    await expect(akmTasksSetEnabled("backup", true, { backend })).rejects.toThrow("akm db backups");

    expect(fs.readFileSync(taskPath, "utf8")).toBe(yaml);
    expect(installCalls).toEqual([]);
    expect(enabledCalls).toEqual([]);
  });
});
