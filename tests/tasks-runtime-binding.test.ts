import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmTasksAdd, akmTasksDoctor, akmTasksSync } from "../src/commands/tasks/tasks";
import type { SchedulerBackend, SchedulerInstallOptions } from "../src/tasks/backends/types";
import { schedulerContextDescriptor, writeSchedulerContextDescriptor } from "../src/tasks/scheduler-invocation";
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
  const artifact = {
    nativeId: "ping",
    bindingId: "ping",
    invocation,
    fingerprint: "installed",
  };
  return {
    name: "cron",
    install(_task, installOptions) {
      options.onInstall?.(installOptions);
    },
    uninstall() {},
    setEnabled() {},
    list: () => [installed],
    listNativeArtifacts: () => [artifact],
    inspectBindings: () => ({ installed: [installed], artifacts: [artifact] }),
    snapshotBindings: (nativeIds) => ({ nativeIds: [...nativeIds], artifacts: [artifact] }),
    restoreBindings() {},
    expectedSignature: () => "expected",
  };
}

function writeTask(stashDir: string): void {
  fs.mkdirSync(path.join(stashDir, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(stashDir, "tasks", "ping.yml"), 'version: 4\nrun: echo ping\nschedule: "@daily"\n');
}

function configureStash(stashDir: string): void {
  writeSandboxConfig({
    bundles: { stash: { path: stashDir, writable: true } },
    defaultBundle: "stash",
    scheduler: { enabled: [{ kind: "task", ref: "stash//tasks/ping" }] },
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

  test("sync --rebind warns once when the resolved runtime is ineligible", async () => {
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
            eligible: false,
            kind: "checkout",
          }),
        },
        undefined,
        { rebind: true },
      );

      expect(result.warnings).toBeDefined();
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings?.[0]).toContain("ineligible checkout invocation");
      expect(result.warnings?.[0]).toContain("/repo/bun /repo/src/cli.ts");
      expect(result.warnings?.[0]).toContain("--rebind");
    } finally {
      storage.cleanup();
    }
  });

  test("a second --rebind sync to the SAME invocation emits no warning (#868 residue)", async () => {
    // Models an image-baked install's periodic `akm task sync --rebind`: once
    // the entries actually carry the resolved (ineligible) invocation, a
    // later rebind to that same invocation changes nothing and must not nag
    // on every run.
    const storage = withIsolatedAkmStorage();
    try {
      configureStash(storage.stashDir);
      writeTask(storage.stashDir);
      const ownerBundlePath = path.resolve(storage.stashDir);
      const invocation = ["task", "run", "ping", "--bundle", "stash", "--scheduled"] as const;
      let bound: SchedulerInstallOptions | undefined;
      const entry = () => ({
        id: "ping",
        nativeId: "ping",
        signature: "installed",
        target: "stash",
        binding: bound?.binding ? [...bound.binding] : ["/old/node", "/old/dist/akm"],
        contextPath: bound?.contextPath ?? "/old/context.json",
        ownerBundlePath,
        invocation,
      });
      const artifact = () => ({ nativeId: "ping", bindingId: "ping", invocation, fingerprint: "installed" });
      const backend: SchedulerBackend = {
        name: "cron",
        install(_task, installOptions) {
          bound = installOptions;
        },
        uninstall() {},
        setEnabled() {},
        list: () => [entry()],
        listNativeArtifacts: () => [artifact()],
        inspectBindings: () => ({ installed: [entry()], artifacts: [artifact()] }),
        snapshotBindings: (nativeIds) => ({ nativeIds: [...nativeIds], artifacts: [artifact()] }),
        restoreBindings() {},
        expectedSignature: () => "expected",
      };
      const ineligibleRuntime = () => ({
        binding: ["/repo/bun", "/repo/src/cli.ts"],
        contextPath: "/new/context.json",
        eligible: false,
        kind: "checkout" as const,
      });

      const first = await akmTasksSync({ backend, schedulerRuntime: ineligibleRuntime }, undefined, {
        rebind: true,
      });
      expect(first.warnings).toHaveLength(1);

      // The entries now carry the same invocation just bound above — a
      // second rebind pass is a true no-op and must not warn.
      const second = await akmTasksSync({ backend, schedulerRuntime: ineligibleRuntime }, undefined, {
        rebind: true,
      });
      expect(second.warnings).toBeUndefined();

      // A rebind to a genuinely DIFFERENT invocation is a real change and
      // must still warn, even though a prior rebind already occurred.
      const third = await akmTasksSync(
        {
          backend,
          schedulerRuntime: () => ({
            binding: ["/other/bun", "/other/src/cli.ts"],
            contextPath: "/other/context.json",
            eligible: false,
            kind: "checkout" as const,
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

  test("sync --rebind emits no warning when the resolved runtime is eligible", async () => {
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
            eligible: true,
            kind: "npm",
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

  test("a schedule edit reinstall uses the current binding and descriptor", async () => {
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
        schedulerRuntime: () => {
          throw new Error("must not derive caller binding");
        },
      });
      expect(installs).toEqual([{ binding: ["/current/akm"], contextPath: "/current/context.json" }]);
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
        schedulerContextDescriptor(undefined, `${process.env.PATH ?? ""}${path.delimiter}/tampered`),
      );
      fs.writeFileSync(
        tamperedContextPath,
        fs.readFileSync(tamperedContextPath, "utf8").replace("/tampered", "/modified"),
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
        resolveInvocation: () => ({
          argv: [process.execPath],
          via: "standalone",
          kind: "standalone",
          eligible: true,
        }),
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
      expect(result.caller.kind).toBe("standalone");
      expect(result.remediation).toBe("akm task sync --rebind");
    } finally {
      storage.cleanup();
    }
  });

  test("doctor trusts an eligible npm binding over the checkout path heuristic", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      fs.mkdirSync(storage.stashDir, { recursive: true });
      const contextPath = writeSchedulerContextDescriptor(schedulerContextDescriptor());
      // This path has a Git ancestor, matching an npm launcher that resolves through a linked checkout.
      const argv = [process.execPath, path.join(process.cwd(), "tests", "tasks-runtime-binding.test.ts")];
      const backend: SchedulerBackend = {
        name: "cron",
        install() {},
        uninstall() {},
        setEnabled() {},
        list: () => [{ id: "stable", binding: argv, contextPath }],
      };

      const result = await akmTasksDoctor({
        backend,
        resolveInvocation: () => ({ argv, via: "npm", kind: "npm", eligible: true }),
      });

      expect(result.bindings).toEqual([{ argv, contextPath, taskIds: ["stable"], status: ["ok"] }]);
      expect(result.remediation).toBeUndefined();
    } finally {
      storage.cleanup();
    }
  });
});
