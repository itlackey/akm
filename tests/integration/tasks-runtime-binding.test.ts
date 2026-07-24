import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  akmTasksAdd,
  akmTasksDoctor,
  akmTasksSetEnabled,
  akmTasksSync,
  prepareSchedulerRuntime,
} from "../../src/commands/tasks/tasks";
import type { TaskBackend } from "../../src/tasks/backends";
import type { TaskInstallOptions } from "../../src/tasks/backends/types";
import { schedulerContextDescriptor, writeSchedulerContextDescriptor } from "../../src/tasks/scheduler-invocation";
import { withIsolatedAkmStorage } from "../_helpers/sandbox";

function writeTask(stashDir: string): void {
  fs.mkdirSync(path.join(stashDir, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(stashDir, "tasks", "ping.yml"), 'version: 2\nschedule: "@daily"\ncommand: echo ping\n');
}

describe("scheduler runtime binding", () => {
  test("source creation refuses without explicit rebind", () => {
    const storage = withIsolatedAkmStorage();
    const sourceCandidate = () => ({
      argv: ["/usr/bin/bun", "/repo/src/cli.ts"],
      via: "checkout" as const,
      kind: "checkout" as const,
      eligible: false,
    });

    try {
      expect(() =>
        prepareSchedulerRuntime(false, "create scheduler entry", {
          resolveInvocation: sourceCandidate,
          writeDescriptor: () => "/unused/context.json",
        }),
      ).toThrow("Refusing to create scheduler entry from an ineligible checkout invocation");
      const packageLocalError = (() => {
        try {
          prepareSchedulerRuntime(false, "create scheduler entry", {
            resolveInvocation: () => ({
              argv: ["/usr/bin/node", "/project/node_modules/akm-cli/dist/akm"],
              via: "package-local",
              kind: "package-local",
              eligible: false,
            }),
            writeDescriptor: () => "/unused/context.json",
          });
        } catch (error) {
          return error;
        }
        throw new Error("expected package-local scheduler binding to be refused");
      })() as Error & { hint(): string | undefined };
      expect(packageLocalError.message).toContain("ineligible package-local invocation");
      expect(packageLocalError.hint()).toContain("npm-global ownership could not be verified");
      expect(
        prepareSchedulerRuntime(true, "create scheduler entry", {
          resolveInvocation: sourceCandidate,
          writeDescriptor: () => "/data/context.json",
        }),
      ).toEqual({ binding: ["/usr/bin/bun", "/repo/src/cli.ts"], contextPath: "/data/context.json" });
    } finally {
      storage.cleanup();
    }
  });

  test("ordinary sync preserves binding and --rebind replaces it", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      writeTask(storage.stashDir);
      const installs: Array<TaskInstallOptions | undefined> = [];
      const backend: TaskBackend = {
        name: "cron",
        install(_task, options) {
          installs.push(options);
        },
        uninstall() {},
        setEnabled() {},
        list: () => [
          {
            id: "ping",
            signature: "installed",
            binding: ["/old/node", "/old/dist/akm"],
            contextPath: "/old/context.json",
          },
        ],
        expectedSignature: () => "expected",
      };

      await akmTasksSync({ backend });
      expect(installs[0]).toMatchObject({
        binding: ["/old/node", "/old/dist/akm"],
        contextPath: "/old/context.json",
      });

      await akmTasksSync(
        {
          backend,
          schedulerRuntime: () => ({ binding: ["/new/node", "/new/dist/akm"], contextPath: "/new/context.json" }),
        },
        undefined,
        { rebind: true },
      );
      expect(installs[1]).toMatchObject({
        binding: ["/new/node", "/new/dist/akm"],
        contextPath: "/new/context.json",
      });
    } finally {
      storage.cleanup();
    }
  });

  test("add --force never replaces an existing binding", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      writeTask(storage.stashDir);
      const installs: Array<TaskInstallOptions | undefined> = [];
      const backend: TaskBackend = {
        name: "cron",
        install(_task, options) {
          installs.push(options);
        },
        uninstall() {},
        setEnabled() {},
        list: () => [
          {
            id: "ping",
            binding: ["/old/node", "/old/dist/akm"],
            contextPath: "/old/context.json",
          },
        ],
      };

      await akmTasksAdd(
        { id: "ping", schedule: "@daily", command: "echo ping", force: true, rebind: true },
        {
          backend,
          schedulerRuntime: () => ({ binding: ["/new/node", "/new/dist/akm"], contextPath: "/new/context.json" }),
        },
      );

      expect(installs[0]).toMatchObject({
        binding: ["/old/node", "/old/dist/akm"],
        contextPath: "/old/context.json",
      });
    } finally {
      storage.cleanup();
    }
  });

  test("enable and disable preserve unreadable legacy definitions via native toggle", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      writeTask(storage.stashDir);
      const toggles: Array<{ id: string; enabled: boolean }> = [];
      const backend: TaskBackend = {
        name: "cron",
        install() {
          throw new Error("must not reinstall");
        },
        uninstall() {},
        setEnabled(id, enabled) {
          toggles.push({ id, enabled });
        },
        list: () => [{ id: "ping" }],
      };

      await akmTasksSetEnabled("ping", false, {
        backend,
        schedulerRuntime: () => {
          throw new Error("must not derive caller binding");
        },
      });
      expect(toggles).toEqual([{ id: "ping", enabled: false }]);
    } finally {
      storage.cleanup();
    }
  });

  test("legacy entries remain installed until explicit migration", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      writeTask(storage.stashDir);
      const installs: Array<TaskInstallOptions | undefined> = [];
      const backend: TaskBackend = {
        name: "cron",
        install(_task, options) {
          installs.push(options);
        },
        uninstall() {},
        setEnabled() {},
        list: () => [{ id: "ping", signature: "legacy", binding: ["/legacy/akm"] }],
        expectedSignature: () => "expected",
      };

      const ordinary = await akmTasksSync({ backend });
      expect(ordinary.skipped[0]?.reason).toContain("tasks sync --rebind");
      expect(installs).toEqual([]);

      await akmTasksSync(
        { backend, schedulerRuntime: () => ({ binding: ["/current/akm"], contextPath: "/current/context.json" }) },
        undefined,
        { rebind: true },
      );
      expect(installs[0]).toMatchObject({ binding: ["/current/akm"], contextPath: "/current/context.json" });
    } finally {
      storage.cleanup();
    }
  });

  test("doctor groups actual backend bindings and reports remediation", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      fs.mkdirSync(storage.stashDir, { recursive: true });
      const contextPath = writeSchedulerContextDescriptor(schedulerContextDescriptor());
      const tamperedContextPath = writeSchedulerContextDescriptor(
        schedulerContextDescriptor(undefined, `${process.env.PATH ?? ""}${path.delimiter}/tampered`),
      );
      fs.writeFileSync(
        tamperedContextPath,
        fs.readFileSync(tamperedContextPath, "utf8").replace("/tampered", "/modified"),
        { mode: 0o600 },
      );
      const backend: TaskBackend = {
        name: "cron",
        install() {},
        uninstall() {},
        setEnabled() {},
        list: () => [
          { id: "alpha", binding: [process.execPath], contextPath },
          { id: "beta", binding: [process.execPath], contextPath },
          { id: "tampered", binding: [process.execPath], contextPath: tamperedContextPath },
          { id: "legacy", binding: ["akm"] },
        ],
      };
      const result = await akmTasksDoctor(
        {},
        {
          backend,
          resolveInvocation: () => ({
            argv: [process.execPath],
            via: "standalone",
            kind: "standalone",
            eligible: true,
          }),
        },
      );

      expect(result.bindings).toContainEqual({
        argv: [process.execPath],
        contextPath,
        taskIds: ["alpha", "beta"],
        status: ["ok"],
      });
      expect(result.bindings).toContainEqual({
        argv: [process.execPath],
        contextPath: tamperedContextPath,
        taskIds: ["tampered"],
        status: ["invalid-context"],
      });
      expect(result.bindings).toContainEqual({
        argv: ["akm"],
        taskIds: ["legacy"],
        status: ["legacy", "path-selected"],
      });
      expect(result.caller.kind).toBe("standalone");
      expect(result.remediation).toBe("akm tasks sync --rebind");
    } finally {
      storage.cleanup();
    }
  });
});
