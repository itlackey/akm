import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmTasksAdd, akmTasksDoctor, akmTasksSync } from "../src/commands/tasks/tasks";
import { bundleSourceId } from "../src/core/config/config-sources";
import type { AkmConfig } from "../src/core/config/config-types";
import type { SchedulerBackend, SchedulerInstallOptions } from "../src/tasks/backends/types";
import {
  resolveScheduledTaskContext,
  schedulerContextDescriptor,
  writeSchedulerContextDescriptor,
} from "../src/tasks/scheduler-invocation";
import { withIsolatedAkmStorage, writeSandboxConfig } from "./_helpers/sandbox";

function completeSchedulerBackend(options: {
  binding: readonly string[];
  contextPath: string;
  /** #846: resolved path of the "stash" bundle this fixture's entry belongs to. */
  ownerBundlePath?: string;
  onInstall?: (installOptions: SchedulerInstallOptions | undefined) => void;
}): SchedulerBackend {
  const invocation = ["task", "run", "ping", "--bundle", "stash", "--scheduled"] as const;
  const installed = {
    id: "ping",
    nativeId: "ping",
    signature: "installed",
    target: "stash",
    binding: [...options.binding],
    contextPath: options.contextPath,
    ...(options.ownerBundlePath !== undefined ? { ownerBundlePath: options.ownerBundlePath } : {}),
    invocation,
  };
  return {
    name: "cron",
    install(_task, installOptions) {
      options.onInstall?.(installOptions);
    },
    uninstall() {},
    setEnabled() {},
    list: () => [installed],
    expectedSignature: () => "expected",
  };
}

function writeTask(stashDir: string): void {
  fs.mkdirSync(path.join(stashDir, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(stashDir, "tasks", "ping.yml"), 'version: 4\nrun: echo ping\nschedule: "@daily"\n');
}

function configureStash(stashDir: string): void {
  const base = {
    configVersion: "0.9.0",
    semanticSearchMode: "off",
    bundles: { stash: { path: stashDir, writable: true } },
    defaultBundle: "stash",
  } as AkmConfig;
  writeSandboxConfig({
    ...base,
    scheduler: { enabled: [{ kind: "task", ref: "stash//tasks/ping", sourceId: bundleSourceId(base, "stash") }] },
  });
}

describe("scheduler runtime binding", () => {
  test("ordinary sync preserves binding and --rebind replaces it", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      configureStash(storage.stashDir);
      writeTask(storage.stashDir);
      const installs: Array<SchedulerInstallOptions | undefined> = [];
      const backend = completeSchedulerBackend({
        binding: ["/old/node", "/old/dist/akm"],
        contextPath: "/old/context.json",
        ownerBundlePath: path.resolve(storage.stashDir),
        onInstall: (options) => installs.push(options),
      });

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

  test("sync --rebind warns once when it writes a source-checkout launcher", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      configureStash(storage.stashDir);
      writeTask(storage.stashDir);
      const backend = completeSchedulerBackend({
        binding: ["/old/node", "/old/dist/akm"],
        contextPath: "/old/context.json",
        ownerBundlePath: path.resolve(storage.stashDir),
      });

      const result = await akmTasksSync(
        {
          backend,
          schedulerRuntime: () => ({
            binding: ["/repo/bun", "/repo/src/cli.ts"],
            contextPath: "/new/context.json",
            via: "checkout",
          }),
        },
        undefined,
        { rebind: true },
      );

      expect(result.warnings).toHaveLength(1);
      expect(result.warnings?.[0]).toContain("source checkout");
      expect(result.warnings?.[0]).toContain("/repo/bun /repo/src/cli.ts");
      expect(result.warnings?.[0]).toContain("--rebind");
    } finally {
      storage.cleanup();
    }
  });

  test("a repeated --rebind to the launcher already installed changes nothing and does not warn (#868 residue)", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      configureStash(storage.stashDir);
      writeTask(storage.stashDir);
      const ownerBundlePath = path.resolve(storage.stashDir);
      const invocation = ["task", "run", "ping", "--bundle", "stash", "--scheduled"] as const;
      const sign = (options?: SchedulerInstallOptions) => JSON.stringify([options?.binding, options?.contextPath]);
      let bound: SchedulerInstallOptions = {
        binding: ["/old/node", "/old/dist/akm"],
        contextPath: "/old/context.json",
      };
      const backend: SchedulerBackend = {
        name: "cron",
        install(_task, installOptions) {
          if (installOptions) bound = installOptions;
        },
        uninstall() {},
        setEnabled() {},
        list: () => [
          {
            id: "ping",
            nativeId: "ping",
            signature: sign(bound),
            target: "stash",
            binding: [...(bound.binding ?? [])],
            contextPath: bound.contextPath ?? "",
            ownerBundlePath,
            invocation,
          },
        ],
        expectedSignature: (_binding, options) => sign(options),
      };
      const checkoutRuntime = () => ({
        binding: ["/repo/bun", "/repo/src/cli.ts"],
        contextPath: "/new/context.json",
        via: "checkout" as const,
      });

      const first = await akmTasksSync({ backend, schedulerRuntime: checkoutRuntime }, undefined, { rebind: true });
      expect(first.updated).toEqual(["ping"]);
      expect(first.warnings).toHaveLength(1);

      const second = await akmTasksSync({ backend, schedulerRuntime: checkoutRuntime }, undefined, { rebind: true });
      expect(second.unchanged).toEqual(["ping"]);
      expect(second.warnings).toBeUndefined();

      const third = await akmTasksSync(
        {
          backend,
          schedulerRuntime: () => ({
            binding: ["/other/bun", "/other/src/cli.ts"],
            contextPath: "/other/context.json",
            via: "checkout" as const,
          }),
        },
        undefined,
        { rebind: true },
      );
      expect(third.warnings).toHaveLength(1);
      expect(third.warnings?.[0]).toContain("/other/bun /other/src/cli.ts");
    } finally {
      storage.cleanup();
    }
  });

  test("sync --rebind emits no warning when the launcher is not a source checkout", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      configureStash(storage.stashDir);
      writeTask(storage.stashDir);
      const backend = completeSchedulerBackend({
        binding: ["/old/node", "/old/dist/akm"],
        contextPath: "/old/context.json",
        ownerBundlePath: path.resolve(storage.stashDir),
      });

      const result = await akmTasksSync(
        {
          backend,
          schedulerRuntime: () => ({
            binding: ["/usr/local/bin/node", "/usr/local/lib/node_modules/akm-cli/dist/akm"],
            contextPath: "/new/context.json",
            via: "npm",
          }),
        },
        undefined,
        { rebind: true },
      );

      expect(result.warnings).toBeUndefined();
    } finally {
      storage.cleanup();
    }
  });

  test("add --force --rebind explicitly replaces an existing runtime binding", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      configureStash(storage.stashDir);
      writeTask(storage.stashDir);
      const installs: Array<SchedulerInstallOptions | undefined> = [];
      const backend = completeSchedulerBackend({
        binding: ["/old/node", "/old/dist/akm"],
        contextPath: "/old/context.json",
        ownerBundlePath: path.resolve(storage.stashDir),
        onInstall: (options) => installs.push(options),
      });

      await akmTasksAdd(
        { id: "ping", schedule: "@daily", command: "echo ping", force: true, rebind: true },
        {
          backend,
          schedulerRuntime: () => ({ binding: ["/new/node", "/new/dist/akm"], contextPath: "/new/context.json" }),
        },
      );

      expect(installs[0]).toMatchObject({
        binding: ["/new/node", "/new/dist/akm"],
        contextPath: "/new/context.json",
      });
    } finally {
      storage.cleanup();
    }
  });

  test("a schedule edit keeps the installed launcher and writes the current descriptor", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      configureStash(storage.stashDir);
      writeTask(storage.stashDir);
      fs.writeFileSync(
        path.join(storage.stashDir, "tasks", "ping.yml"),
        'version: 4\nrun: echo ping\nschedule: "@hourly"\n',
      );
      const installs: Array<SchedulerInstallOptions | undefined> = [];
      const backend = completeSchedulerBackend({
        binding: ["/current/akm"],
        contextPath: "/current/context.json",
        ownerBundlePath: path.resolve(storage.stashDir),
        onInstall: (options) => installs.push(options),
      });

      await akmTasksSync({
        backend,
        schedulerRuntime: () => ({ binding: ["/new/akm"], contextPath: "/new/context.json" }),
      });
      expect(installs).toEqual([{ binding: ["/current/akm"], contextPath: "/new/context.json" }]);
    } finally {
      storage.cleanup();
    }
  });

  test("doctor groups current backend bindings and reports remediation for unhealthy bindings", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      fs.mkdirSync(storage.stashDir, { recursive: true });
      const contextPath = writeSchedulerContextDescriptor(schedulerContextDescriptor());
      const tamperedContextPath = writeSchedulerContextDescriptor(
        schedulerContextDescriptor({
          ...resolveScheduledTaskContext(),
          AKM_CACHE_DIR: path.join(storage.stashDir, "cache-tampered"),
        }),
      );
      fs.writeFileSync(
        tamperedContextPath,
        fs.readFileSync(tamperedContextPath, "utf8").replace("cache-tampered", "cache-modified"),
        { mode: 0o600 },
      );
      const backend: SchedulerBackend = {
        name: "cron",
        install() {},
        uninstall() {},
        setEnabled() {},
        list: () => [
          { id: "alpha", binding: [process.execPath], contextPath },
          { id: "beta", binding: [process.execPath], contextPath },
          { id: "tampered", binding: [process.execPath], contextPath: tamperedContextPath },
        ],
      };
      const result = await akmTasksDoctor({
        backend,
        resolveInvocation: () => ({ argv: [process.execPath], via: "standalone" }),
      });

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
      expect(result.caller.via).toBe("standalone");
      expect(result.remediation).toBe("akm task sync --rebind");
    } finally {
      storage.cleanup();
    }
  });

  test("doctor flags a source-checkout launcher, not every path inside a git work tree", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      fs.mkdirSync(storage.stashDir, { recursive: true });
      const contextPath = writeSchedulerContextDescriptor(schedulerContextDescriptor());
      const checkout = [process.execPath, path.join(process.cwd(), "src", "cli.ts")];
      // Inside this repository's work tree, but not an akm entry point.
      const other = [process.execPath, path.join(process.cwd(), "tests", "tasks-runtime-binding.test.ts")];
      const backend: SchedulerBackend = {
        name: "cron",
        install() {},
        uninstall() {},
        setEnabled() {},
        list: () => [
          { id: "dev", binding: checkout, contextPath },
          { id: "stable", binding: other, contextPath },
        ],
      };

      const result = await akmTasksDoctor({ backend, resolveInvocation: () => ({ argv: other, via: "npm" }) });

      expect(result.bindings).toContainEqual({ argv: checkout, contextPath, taskIds: ["dev"], status: ["checkout"] });
      expect(result.bindings).toContainEqual({ argv: other, contextPath, taskIds: ["stable"], status: ["ok"] });
      expect(result.remediation).toBe("akm task sync --rebind");
    } finally {
      storage.cleanup();
    }
  });
});
