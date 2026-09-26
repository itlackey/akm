// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmTasksAdd, akmTasksSync } from "../../src/commands/tasks/tasks";
import { loadConfig } from "../../src/core/config/config";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../src/core/warn";
import { isSchedulerRefEnabled, setSchedulerRefEnabled } from "../../src/tasks/activation-config";
import type { SchedulerBackend } from "../../src/tasks/backends/types";
import type { ScheduleBackend } from "../../src/tasks/schedule";
import { compileTaskSchedulerBindings, type SchedulerBinding } from "../../src/tasks/scheduler-binding";
import { writeSchedulerContextDescriptor } from "../../src/tasks/scheduler-invocation";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let backendName: ScheduleBackend;
let installed: Map<string, SchedulerBinding | undefined>;
let installCalls: SchedulerBinding[];
let uninstallCalls: string[];
let failInstall: ((task: SchedulerBinding) => boolean) | undefined;
let installedContextPath: string;

function nativeBinding(id: string, cron: string, enabled = true): SchedulerBinding {
  return {
    id,
    logicalSource: { kind: "task", ref: `stash//tasks/${id}` },
    cron,
    source: "akm.schedule",
    ordinal: 0,
    enabled,
    invocation: ["task", "run", id, "--bundle", "stash", "--scheduled"],
  };
}

function backendSignature(task: SchedulerBinding): string {
  return JSON.stringify([task.cron, task.enabled, task.invocation]);
}

const backend: SchedulerBackend = {
  get name() {
    return backendName;
  },
  install(task: SchedulerBinding) {
    installCalls.push(task);
    if (failInstall?.(task)) throw new Error(`install failed for ${task.id}`);
    installed.set(task.id, task);
  },
  uninstall(id: string) {
    uninstallCalls.push(id);
    installed.delete(id);
  },
  setEnabled(id: string, enabled: boolean) {
    const task = installed.get(id);
    if (task) installed.set(id, { ...task, enabled });
  },
  list() {
    return [...installed.keys()].map((id) => {
      const stored = installed.get(id);
      return {
        id,
        binding: ["/test/akm"],
        contextPath: installedContextPath,
        ...(stored?.invocation.includes("--bundle")
          ? { target: stored.invocation[stored.invocation.indexOf("--bundle") + 1] }
          : {}),
        ...(stored ? { invocation: stored.invocation } : {}),
        ...(stored ? { signature: backendSignature(stored) } : {}),
      };
    });
  },
  expectedSignature(task: SchedulerBinding) {
    return backendSignature(task);
  },
};

function writeTask(id: string, yaml: string): string {
  const filePath = path.join(storage.stashDir, "tasks", `${id}.yml`);
  fs.writeFileSync(filePath, yaml, "utf8");
  return filePath;
}

function taskYaml(run: string, schedule: string, name?: string): string {
  return ["version: 4", `run: ${run}`, ...(name ? [`name: ${name}`] : []), "schedule:", `  - cron: "${schedule}"`].join(
    "\n",
  );
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({
    bundles: { stash: { path: storage.stashDir, writable: true } },
    defaultBundle: "stash",
  });
  fs.mkdirSync(path.join(storage.stashDir, "tasks"), { recursive: true });
  backendName = "cron";
  installed = new Map();
  installCalls = [];
  uninstallCalls = [];
  failInstall = undefined;
  installedContextPath = "/test/context.json";
});

afterEach(() => {
  storage.cleanup();
});

describe("task lifecycle failure handling", () => {
  test("add writes the task, enables its ref, and installs its row", async () => {
    const result = await akmTasksAdd({ id: "ready", schedule: "0 3 * * *", command: "echo ready" }, { backend });

    expect(result.enabled).toBe(true);
    expect(isSchedulerRefEnabled(loadConfig(), "stash//tasks/ready")).toBe(true);
    expect(installed.get("ready")).toMatchObject({ cron: "0 3 * * *" });
  });

  test("an install that fails is reported by add; the task stays written and enabled for the next sync", async () => {
    failInstall = () => true;

    await expect(akmTasksAdd({ id: "late", schedule: "0 3 * * *", command: "echo late" }, { backend })).rejects.toThrow(
      /written to .*late\.yml and enabled, but it could not be scheduled: install failed for late/,
    );

    expect(fs.existsSync(path.join(storage.stashDir, "tasks", "late.yml"))).toBe(true);
    expect(isSchedulerRefEnabled(loadConfig(), "stash//tasks/late")).toBe(true);
    expect(installed.has("late")).toBe(false);
  });

  test("add --disabled writes source, leaves activation absent, and removes an orphaned binding", async () => {
    installedContextPath = writeSchedulerContextDescriptor();
    installed.set("quiet", nativeBinding("quiet", "0 2 * * *"));

    const result = await akmTasksAdd(
      { id: "quiet", schedule: "0 3 * * *", command: "echo quiet", disabled: true },
      { backend },
    );

    expect(result.enabled).toBe(false);
    expect(fs.readFileSync(result.path, "utf8")).not.toMatch(/\benabled\s*:/);
    expect(isSchedulerRefEnabled(loadConfig(), "stash//tasks/quiet")).toBe(false);
    expect(uninstallCalls).toEqual(["quiet"]);
    expect(installed.has("quiet")).toBe(false);
    expect(installCalls).toEqual([]);
  });

  test("add --disabled revokes an existing grant before publishing replacement source", async () => {
    writeTask("quiet-force", taskYaml("echo old", "0 2 * * *"));
    setSchedulerRefEnabled("stash//tasks/quiet-force", true);
    installedContextPath = writeSchedulerContextDescriptor();
    installed.set("quiet-force", nativeBinding("quiet-force", "0 2 * * *"));
    let commits = 0;

    const result = await akmTasksAdd(
      { id: "quiet-force", schedule: "0 3 * * *", command: "echo replacement", disabled: true, force: true },
      {
        backend,
        commitBoundary() {
          commits += 1;
          expect(isSchedulerRefEnabled(loadConfig(), "stash//tasks/quiet-force")).toBe(false);
        },
      },
    );

    expect(result.enabled).toBe(false);
    expect(commits).toBe(1);
    expect(uninstallCalls).toEqual(["quiet-force"]);
  });

  // Issue 11: a workflow task's `timeoutMs` is its whole-run bound (the task
  // runner turns it into the abort signal `akm workflow run --timeout` uses),
  // so `--timeout-ms` is no longer refused alongside `--workflow`. Engine and
  // model stay prompt-only — a workflow's engines come from its frozen plan.
  test("add accepts --timeout-ms on a workflow task and records it in the YAML", async () => {
    const workflowsDir = path.join(storage.stashDir, "workflows");
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.writeFileSync(
      path.join(workflowsDir, "nightly.yml"),
      [
        "name: nightly",
        "on: { workflow_dispatch: null }",
        "jobs:",
        "  main:",
        "    runs-on: [self-hosted]",
        "    steps:",
        "      - id: run",
        "        run: echo nightly",
      ].join("\n"),
      "utf8",
    );

    const result = await akmTasksAdd(
      { id: "nightly-wf", schedule: "@daily", workflow: "workflows/nightly", timeoutMs: 900_000 },
      { backend },
    );

    expect(result.target).toMatchObject({ kind: "uses", uses: { kind: "workflow", ref: "workflows/nightly" } });
    expect(fs.readFileSync(result.path, "utf8")).toContain("timeout: 900000");
  });

  test("add still refuses --engine on a workflow task", async () => {
    const workflowsDir = path.join(storage.stashDir, "workflows");
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.writeFileSync(path.join(workflowsDir, "nightly.md"), "# Nightly\n", "utf8");

    await expect(
      akmTasksAdd(
        { id: "nightly-engine", schedule: "@daily", workflow: "workflows/nightly", engine: "reviewer" },
        { backend },
      ),
    ).rejects.toMatchObject({ code: "INVALID_FLAG_VALUE" });
  });

  // P4 FLIP (docs/plans/specs/p4-deletions-closeout.md §3.2.6, row B-20;
  // implementer addition to §7.2, recorded in the commit body and the Review
  // log): `renderTaskYaml` now authors `version: 4` (sub-step (b)), so a
  // github-action-shaped --workflow value hits task source v4's OWN
  // `classifyTaskSourceV4Uses` shape check first (row B-11, unchanged by
  // §3.1's deletion of the v3 locator grammar) rather than v3's generic
  // trailing classification throw this test previously pinned.
  test("add rejects a remote-action-shaped workflow before source or scheduler mutation", async () => {
    await expect(
      akmTasksAdd({ id: "remote", schedule: "@daily", workflow: "owner/repository/action@v1" }, { backend }),
    ).rejects.toThrow(/GitHub Action targets were removed/i);
    expect(fs.existsSync(path.join(storage.stashDir, "tasks", "remote.yml"))).toBe(false);
    expect(installCalls).toEqual([]);
  });

  test("add rejects an unresolved workflow before source or scheduler mutation", async () => {
    await expect(
      akmTasksAdd({ id: "unresolved", schedule: "@daily", workflow: "workflows/does-not-exist" }, { backend }),
    ).rejects.toThrow(/not found|not present|no workflow assets/i);
    expect(fs.existsSync(path.join(storage.stashDir, "tasks", "unresolved.yml"))).toBe(false);
    expect(installCalls).toEqual([]);
  });

  test("sync reports an invalid filesystem-derived id and changes nothing", async () => {
    writeTask("manual task", taskYaml("echo unsafe", "@daily"));
    setSchedulerRefEnabled("stash//tasks/manual task", true);

    const result = await akmTasksSync({ backend });

    expect(result.failures).toEqual([expect.objectContaining({ ref: "stash//tasks/manual task" })]);
    expect(installCalls).toEqual([]);
    expect(uninstallCalls).toEqual([]);
  });

  test("a source the backend cannot schedule is reported and its installed row left as it is", async () => {
    backendName = "schtasks";
    installedContextPath = writeSchedulerContextDescriptor();
    writeTask("busy", taskYaml("echo busy", "1-59/1 * * * *"));
    setSchedulerRefEnabled("stash//tasks/busy", true);
    installed.set("busy", nativeBinding("busy", "0 * * * *"));

    const result = await akmTasksSync({ backend });

    expect(result.failures).toEqual([
      expect.objectContaining({ ref: "stash//tasks/busy", reason: expect.stringContaining("native triggers") }),
    ]);
    expect(installCalls).toEqual([]);
    expect(uninstallCalls).toEqual([]);
    expect(installed.get("busy")).toMatchObject({ cron: "0 * * * *" });
  });

  // #867: degrades — `b-invalid` is reported and excluded from the desired
  // set rather than poisoning the whole sync, so `a-valid` still installs.
  test("sync reconciles the rest of the desired set and reports a source that fails to parse", async () => {
    writeTask("a-valid", taskYaml("echo yes", "@daily"));
    // A version: 2 document is now rejected by the version router itself
    // (TASK_SCHEMA_VERSION_UNSUPPORTED, row B-15) before it ever reaches a
    // field-level parser — the old v3 parser's own "must be exactly 3"
    // wording this test used to assert is unreachable for a version: 2
    // document under any routing this phase produces.
    writeTask("b-invalid", 'version: 2\nschedule: "@daily"\ncommand: echo no\n');
    setSchedulerRefEnabled("stash//tasks/a-valid", true);
    setSchedulerRefEnabled("stash//tasks/b-invalid", true);
    let runtimeCalls = 0;

    const result = await akmTasksSync({
      backend,
      schedulerRuntime() {
        runtimeCalls += 1;
        return { binding: ["/test/akm"], contextPath: "/test/context.json" };
      },
    });

    expect(result.installed).toEqual(["a-valid"]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.reason).toMatch(/task schema version 2/i);
    expect(runtimeCalls).toBe(1);
    expect(installed.has("a-valid")).toBe(true);
  });

  test("add --force removes every stale higher-ordinal binding from the prior source", async () => {
    const priorYaml = [
      "version: 4",
      "run: echo prior",
      "schedule:",
      "  - cron: '0 1 * * *'",
      "  - cron: '0 2 * * *'",
      "  - cron: '0 3 * * *'",
      "",
    ].join("\n");
    writeTask("multi", priorYaml);
    const priorBindings = compileTaskSchedulerBindings({
      id: "multi",
      qualifiedRef: "stash//tasks/multi",
      schedules: [
        { cron: "0 1 * * *", source: "on.schedule[0].cron", ordinal: 0 },
        { cron: "0 2 * * *", source: "on.schedule[1].cron", ordinal: 1 },
        { cron: "0 3 * * *", source: "on.schedule[2].cron", ordinal: 2 },
      ],
    });
    for (const binding of priorBindings) installed.set(binding.id, binding);
    installedContextPath = writeSchedulerContextDescriptor();

    await akmTasksAdd({ id: "multi", schedule: "0 4 * * *", command: "echo replacement", force: true }, { backend });

    expect(uninstallCalls.sort()).toEqual(
      priorBindings
        .slice(1)
        .map((binding) => binding.id)
        .sort(),
    );
    expect([...installed.keys()]).toEqual(["multi"]);
    expect(installed.get("multi")).toMatchObject({ cron: "0 4 * * *", ordinal: 0 });
  });

  test("sync installs command arguments without obsolete-command handling", async () => {
    const yaml = ["version: 4", "run: akm db backups", 'schedule: "0 3 * * 0"', ""].join("\n");
    writeTask("backup", yaml);
    setSchedulerRefEnabled("stash//tasks/backup", true);

    const result = await akmTasksSync({ backend });

    expect(result.installed).toEqual(["backup"]);
    expect(result.skipped).toEqual([]);
    expect(installCalls[0]?.logicalSource).toEqual({ kind: "task", ref: "stash//tasks/backup" });
    expect(installCalls[0]?.invocation).toEqual(["task", "run", "backup", "--bundle", "stash", "--scheduled"]);
  });

  test("add rejects argv arrays instead of silently joining them", async () => {
    await expect(
      akmTasksAdd(
        {
          id: "backup",
          schedule: "0 3 * * 0",
          command: ["akm", "db", "backups"],
        },
        { backend },
      ),
    ).rejects.toThrow(/shell string|argv arrays/i);
    expect(installCalls).toHaveLength(0);
  });

  test.each([
    "agents/briefer",
    "stash//agents/briefer",
    "./prompts/review.md",
  ])("add warns on asset/path-shaped --prompt %s but still writes it as literal text", async (prompt) => {
    writeSandboxConfig({
      bundles: { stash: { path: storage.stashDir, writable: true } },
      defaultBundle: "stash",
      semanticSearchMode: "off",
      engines: { reviewer: { kind: "agent", platform: "opencode", bin: "fake-agent" } },
      defaults: { engine: "reviewer" },
    });

    const warnings: unknown[][] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args);
    });
    let result: Awaited<ReturnType<typeof akmTasksAdd>>;
    try {
      result = await akmTasksAdd({ id: "prompt-shape", schedule: "@daily", prompt }, { backend });
    } finally {
      _setWarnSinkForTests(undefined);
      _resetWarnOnceForTests();
    }

    expect(result.target).toMatchObject({
      kind: "uses",
      uses: { kind: "builtin-command", ref: "akm/command" },
      command: { kind: "inline", content: prompt },
    });
    expect(fs.existsSync(path.join(storage.stashDir, "tasks", "prompt-shape.yml"))).toBe(true);
    expect(
      warnings.some(
        (args) => args.some((a) => String(a).includes(prompt)) && args.some((a) => String(a).includes("--workflow")),
      ),
    ).toBe(true);
  });

  test("add keeps ordinary --prompt text as inline akm/command content", async () => {
    writeSandboxConfig({
      bundles: { stash: { path: storage.stashDir, writable: true } },
      defaultBundle: "stash",
      semanticSearchMode: "off",
      engines: { reviewer: { kind: "agent", platform: "opencode", bin: "fake-agent" } },
      defaults: { engine: "reviewer" },
    });

    const result = await akmTasksAdd(
      { id: "inline-prompt", schedule: "@daily", prompt: "Review the latest changes carefully." },
      { backend },
    );

    expect(result.target).toMatchObject({
      kind: "uses",
      uses: { kind: "builtin-command", ref: "akm/command" },
      command: { kind: "inline", content: "Review the latest changes carefully." },
    });
  });
});
