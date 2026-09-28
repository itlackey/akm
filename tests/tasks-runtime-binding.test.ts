import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmTasksAdd, akmTasksDoctor, akmTasksSync } from "../src/commands/tasks/tasks";
import { bundleSourceId } from "../src/core/config/config-sources";
import type { AkmConfig } from "../src/core/config/config-types";
import type { SchedulerBackend, SchedulerInstallOptions } from "../src/tasks/backends/types";
import { withIsolatedAkmStorage, writeSandboxConfig } from "./_helpers/sandbox";

function completeSchedulerBackend(options: {
  binding: readonly string[];
  onInstall?: (installOptions: SchedulerInstallOptions | undefined) => void;
}): SchedulerBackend {
  const invocation = ["task", "run", "ping", "--bundle", "stash", "--scheduled"] as const;
  const installed = {
    id: "ping",
    nativeId: "ping",
    signature: "installed",
    target: "stash",
    binding: [...options.binding],
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
        onInstall: (options) => installs.push(options),
      });

      await akmTasksSync({ backend });
      expect(installs[0]).toEqual({ binding: ["/old/node", "/old/dist/akm"] });

      await akmTasksSync(
        { backend, schedulerRuntime: () => ({ binding: ["/new/node", "/new/dist/akm"] }) },
        undefined,
        { rebind: true },
      );
      expect(installs[1]).toEqual({ binding: ["/new/node", "/new/dist/akm"] });
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
      });

      const result = await akmTasksSync(
        {
          backend,
          schedulerRuntime: () => ({
            binding: ["/repo/bun", "/repo/src/cli.ts"],
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
      const invocation = ["task", "run", "ping", "--bundle", "stash", "--scheduled"] as const;
      const sign = (options?: SchedulerInstallOptions) => JSON.stringify([options?.binding, options?.environment]);
      let bound: SchedulerInstallOptions = { binding: ["/old/node", "/old/dist/akm"] };
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
            invocation,
          },
        ],
        expectedSignature: (_binding, options) => sign(options),
      };
      const checkoutRuntime = () => ({ binding: ["/repo/bun", "/repo/src/cli.ts"], via: "checkout" as const });

      const first = await akmTasksSync({ backend, schedulerRuntime: checkoutRuntime }, undefined, { rebind: true });
      expect(first.updated).toEqual(["ping"]);
      expect(first.warnings).toHaveLength(1);

      const second = await akmTasksSync({ backend, schedulerRuntime: checkoutRuntime }, undefined, { rebind: true });
      expect(second.unchanged).toEqual(["ping"]);
      expect(second.warnings).toBeUndefined();

      const third = await akmTasksSync(
        {
          backend,
          schedulerRuntime: () => ({ binding: ["/other/bun", "/other/src/cli.ts"], via: "checkout" as const }),
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
      });

      const result = await akmTasksSync(
        {
          backend,
          schedulerRuntime: () => ({
            binding: ["/usr/local/bin/node", "/usr/local/lib/node_modules/akm-cli/dist/akm"],
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
        onInstall: (options) => installs.push(options),
      });

      await akmTasksAdd(
        { id: "ping", schedule: "@daily", command: "echo ping", force: true, rebind: true },
        { backend, schedulerRuntime: () => ({ binding: ["/new/node", "/new/dist/akm"] }) },
      );

      expect(installs[0]).toEqual({ binding: ["/new/node", "/new/dist/akm"] });
    } finally {
      storage.cleanup();
    }
  });

  test("a schedule edit keeps the installed launcher", async () => {
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
        onInstall: (options) => installs.push(options),
      });

      await akmTasksSync({ backend, schedulerRuntime: () => ({ binding: ["/new/akm"] }) });
      expect(installs).toEqual([{ binding: ["/current/akm"] }]);
    } finally {
      storage.cleanup();
    }
  });

  test("doctor groups current backend bindings and reports remediation for unhealthy bindings", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      fs.mkdirSync(storage.stashDir, { recursive: true });
      // Rows written before 0.9.17-alpha.7 name a descriptor; one that cannot be read is flagged.
      const contextPath = path.join(storage.stashDir, "legacy-context.json");
      fs.writeFileSync(contextPath, JSON.stringify({ version: 1, environment: { AKM_BUNDLE_DIR: storage.stashDir } }));
      const missingContextPath = path.join(storage.stashDir, "gone-context.json");
      const backend: SchedulerBackend = {
        name: "cron",
        install() {},
        uninstall() {},
        setEnabled() {},
        list: () => [
          { id: "alpha", binding: [process.execPath] },
          { id: "beta", binding: [process.execPath] },
          { id: "legacy", binding: [process.execPath], contextPath },
          { id: "orphaned", binding: [process.execPath], contextPath: missingContextPath },
        ],
      };
      const result = await akmTasksDoctor({
        backend,
        resolveInvocation: () => ({ argv: [process.execPath], via: "standalone" }),
      });

      expect(result.bindings).toContainEqual({ argv: [process.execPath], taskIds: ["alpha", "beta"], status: ["ok"] });
      expect(result.bindings).toContainEqual({
        argv: [process.execPath],
        contextPath,
        taskIds: ["legacy"],
        status: ["ok"],
      });
      expect(result.bindings).toContainEqual({
        argv: [process.execPath],
        contextPath: missingContextPath,
        taskIds: ["orphaned"],
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
      const checkout = [process.execPath, path.join(process.cwd(), "src", "cli.ts")];
      // Inside this repository's work tree, but not an akm entry point.
      const other = [process.execPath, path.join(process.cwd(), "tests", "tasks-runtime-binding.test.ts")];
      const backend: SchedulerBackend = {
        name: "cron",
        install() {},
        uninstall() {},
        setEnabled() {},
        list: () => [
          { id: "dev", binding: checkout },
          { id: "stable", binding: other },
        ],
      };

      const result = await akmTasksDoctor({ backend, resolveInvocation: () => ({ argv: other, via: "npm" }) });

      expect(result.bindings).toContainEqual({ argv: checkout, taskIds: ["dev"], status: ["checkout"] });
      expect(result.bindings).toContainEqual({ argv: other, taskIds: ["stable"], status: ["ok"] });
      expect(result.remediation).toBe("akm task sync --rebind");
    } finally {
      storage.cleanup();
    }
  });
});
