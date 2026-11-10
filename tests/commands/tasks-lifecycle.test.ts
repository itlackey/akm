// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  akmTasksAdd,
  akmTasksDisable,
  akmTasksEnable,
  akmTasksHistory,
  akmTasksRun,
} from "../../src/commands/tasks/tasks";
import { loadConfig } from "../../src/core/config/config";
import { ConfigError, UsageError } from "../../src/core/errors";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../src/core/warn";
import { isSchedulerRefEnabled, setSchedulerRefEnabled } from "../../src/tasks/activation-config";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

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
});

afterEach(() => {
  storage.cleanup();
});

describe("task lifecycle", () => {
  test("add writes the task and enables its ref (dispatch reads both next minute)", async () => {
    const result = await akmTasksAdd({ id: "ready", schedule: "0 3 * * *", command: "echo ready" });

    expect(result.enabled).toBe(true);
    expect(isSchedulerRefEnabled(loadConfig(), "stash//tasks/ready")).toBe(true);
    expect(fs.readFileSync(result.path, "utf8")).toContain("0 3 * * *");
  });

  test("add --disabled writes source and leaves activation absent", async () => {
    const result = await akmTasksAdd({ id: "quiet", schedule: "0 3 * * *", command: "echo quiet", disabled: true });

    expect(result.enabled).toBe(false);
    expect(fs.readFileSync(result.path, "utf8")).not.toMatch(/\benabled\s*:/);
    expect(isSchedulerRefEnabled(loadConfig(), "stash//tasks/quiet")).toBe(false);
  });

  test("add --disabled revokes an existing grant before publishing replacement source", async () => {
    writeTask("quiet-force", taskYaml("echo old", "0 2 * * *"));
    setSchedulerRefEnabled("stash//tasks/quiet-force", true);
    let commits = 0;

    const result = await akmTasksAdd(
      { id: "quiet-force", schedule: "0 3 * * *", command: "echo replacement", disabled: true, force: true },
      {
        commitBoundary() {
          commits += 1;
          expect(isSchedulerRefEnabled(loadConfig(), "stash//tasks/quiet-force")).toBe(false);
        },
      },
    );

    expect(result.enabled).toBe(false);
    expect(commits).toBe(1);
  });

  test("add refuses an existing task without --force", async () => {
    writeTask("taken", taskYaml("echo old", "0 2 * * *"));
    await expect(akmTasksAdd({ id: "taken", schedule: "0 3 * * *", command: "echo new" })).rejects.toMatchObject({
      code: "RESOURCE_ALREADY_EXISTS",
    });
  });

  test("add validates the schedule with the one cron grammar", async () => {
    await expect(akmTasksAdd({ id: "bad", schedule: "0 25 * * *", command: "echo x" })).rejects.toMatchObject({
      code: "INVALID_FLAG_VALUE",
    });
    await expect(akmTasksAdd({ id: "reboot", schedule: "@reboot", command: "echo x" })).rejects.toBeInstanceOf(
      UsageError,
    );
    expect(fs.existsSync(path.join(storage.stashDir, "tasks", "bad.yml"))).toBe(false);
  });

  test("enable and disable edit scheduler.enabled, and report the sync that follows", async () => {
    writeTask("toggle", taskYaml("echo t", "@daily"));

    const enabled = await akmTasksEnable("toggle");
    expect(enabled).toMatchObject({ ref: "stash//tasks/toggle", enabled: true, changed: true });
    expect(isSchedulerRefEnabled(loadConfig(), "stash//tasks/toggle")).toBe(true);
    expect((await akmTasksEnable("toggle")).changed).toBe(false);

    const disabled = await akmTasksDisable("toggle");
    expect(disabled).toMatchObject({ ref: "stash//tasks/toggle", enabled: false, changed: true });
    expect(isSchedulerRefEnabled(loadConfig(), "stash//tasks/toggle")).toBe(false);
  });

  // Issue 11: a workflow task's `timeoutMs` is its whole-run bound (the task
  // runner turns it into the abort signal `akm workflow run --timeout-ms` uses),
  // so `--timeout-ms` is no longer refused alongside `--workflow`. Connection,
  // harness and model stay prompt-only — a workflow's come from its frozen plan.
  test("add accepts --timeout-ms on a workflow task and records it in the YAML", async () => {
    const workflowsDir = path.join(storage.stashDir, "workflows");
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.writeFileSync(
      path.join(workflowsDir, "nightly.md"),
      "---\ntype: workflow\nsteps:\n  - id: run\n---\n\n## run\n\nRun nightly.\n",
      "utf8",
    );

    const result = await akmTasksAdd({
      id: "nightly-wf",
      schedule: "@daily",
      workflow: "workflows/nightly",
      timeoutMs: 900_000,
    });

    expect(result.target).toMatchObject({ kind: "uses", uses: { kind: "workflow", ref: "workflows/nightly" } });
    expect(fs.readFileSync(result.path, "utf8")).toContain("timeout: 900000");
  });

  test("add still refuses --harness on a workflow task", async () => {
    const workflowsDir = path.join(storage.stashDir, "workflows");
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.writeFileSync(path.join(workflowsDir, "nightly.md"), "# Nightly\n", "utf8");

    await expect(
      akmTasksAdd({ id: "nightly-engine", schedule: "@daily", workflow: "workflows/nightly", harness: "reviewer" }),
    ).rejects.toMatchObject({ code: "INVALID_FLAG_VALUE" });
  });

  // P4 FLIP: `renderTaskYaml` now authors `version: 4` (sub-step (b)), so a
  // github-action-shaped --workflow value hits task source v4's OWN
  // `classifyTaskSourceV4Uses` shape check first (row B-11, unchanged by
  // §3.1's deletion of the v3 locator grammar) rather than v3's generic
  // trailing classification throw this test previously pinned.
  test("add rejects a remote-action-shaped workflow before source mutation", async () => {
    await expect(
      akmTasksAdd({ id: "remote", schedule: "@daily", workflow: "owner/repository/action@v1" }),
    ).rejects.toThrow(/GitHub Action targets were removed/i);
    expect(fs.existsSync(path.join(storage.stashDir, "tasks", "remote.yml"))).toBe(false);
  });

  test("add rejects an unresolved workflow before source mutation", async () => {
    await expect(
      akmTasksAdd({ id: "unresolved", schedule: "@daily", workflow: "workflows/does-not-exist" }),
    ).rejects.toThrow(/not found|not present|no workflow assets/i);
    expect(fs.existsSync(path.join(storage.stashDir, "tasks", "unresolved.yml"))).toBe(false);
  });

  test("add rejects argv arrays instead of silently joining them", async () => {
    await expect(
      akmTasksAdd({
        id: "backup",
        schedule: "0 3 * * 0",
        command: ["akm", "db", "backups"],
      }),
    ).rejects.toThrow(/shell string|argv arrays/i);
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
      harnesses: { reviewer: { platform: "opencode", bin: "fake-agent" } },
    });

    const warnings: unknown[][] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args);
    });
    let result: Awaited<ReturnType<typeof akmTasksAdd>>;
    try {
      result = await akmTasksAdd({ id: "prompt-shape", schedule: "@daily", prompt });
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
      harnesses: { reviewer: { platform: "opencode", bin: "fake-agent" } },
    });

    const result = await akmTasksAdd({
      id: "inline-prompt",
      schedule: "@daily",
      prompt: "Review the latest changes carefully.",
    });

    expect(result.target).toMatchObject({
      kind: "uses",
      uses: { kind: "builtin-command", ref: "akm/command" },
      command: { kind: "inline", content: "Review the latest changes carefully." },
    });
  });

  test.each([
    ["harness", { harness: "reviewer" }],
    ["connection", { connection: "lab" }],
  ])("add writes a prompt task's --%s into the task, with --model", async (key, where) => {
    writeSandboxConfig({
      bundles: { stash: { path: storage.stashDir, writable: true } },
      defaultBundle: "stash",
      semanticSearchMode: "off",
      harnesses: { reviewer: { platform: "opencode", bin: "fake-agent" } },
      connections: { lab: { endpoint: "http://lab.invalid/v1", models: { fast: "m" } } },
    });

    const result = await akmTasksAdd({
      id: `where-${key}`,
      schedule: "@daily",
      prompt: "Review the latest changes carefully.",
      model: "fast",
      ...where,
    });

    const written = fs.readFileSync(result.path, "utf8");
    expect(written).toContain(`${key}: ${Object.values(where)[0]}`);
    expect(written).toContain("model: fast");
    expect(written).not.toMatch(/\bengine\s*:/);
  });
});
describe("task commands name the flag they take when a bundle does not resolve", () => {
  const failure = (run: () => Promise<unknown>): Promise<unknown> =>
    run().then(
      () => undefined,
      (error: unknown) => error,
    );

  test("--bundle naming no configured bundle is reported as --bundle by add, history and run", async () => {
    const errors = await Promise.all([
      failure(() => akmTasksAdd({ id: "x", schedule: "0 3 * * *", command: "echo x", target: "ghost" })),
      failure(() => akmTasksHistory({ target: "ghost" })),
      failure(() => akmTasksRun("x", { target: "ghost" })),
    ]);
    for (const error of errors) {
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).message).toContain(
        '--bundle must reference a source name from your config. No source named "ghost" is configured',
      );
      expect((error as UsageError).message).not.toContain("--target");
    }
  });

  test("a read-only --bundle for add points at --bundle, not --target", async () => {
    const readOnly = makeSandboxDir("akm-task-readonly-");
    try {
      writeSandboxConfig({
        bundles: {
          stash: { path: storage.stashDir, writable: true },
          frozen: { path: readOnly.dir, writable: false },
        },
        defaultBundle: "stash",
      });

      const error = await failure(() =>
        akmTasksAdd({ id: "x", schedule: "0 3 * * *", command: "echo x", target: "frozen" }),
      );
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).hint()).toContain("or pass --bundle to a different source");
      expect((error as ConfigError).hint()).not.toContain("--target");
    } finally {
      readOnly.cleanup();
    }
  });

  test("a bundle taken from a task ref or a workflow ref is not blamed on any flag", async () => {
    const run = await failure(() => akmTasksRun("ghost//tasks/x"));
    expect(run).toBeInstanceOf(UsageError);
    expect((run as UsageError).message).toContain(
      `The task ref's bundle must reference a source name from your config. No source named "ghost" is configured`,
    );

    const add = await failure(() =>
      akmTasksAdd({ id: "y", schedule: "0 3 * * *", workflow: "ghost//workflows/deploy" }),
    );
    expect(add).toBeInstanceOf(UsageError);
    expect((add as UsageError).message).toContain(`Bundle "ghost" is not configured`);
    for (const error of [run, add]) {
      expect((error as UsageError).message).not.toContain("--target");
      expect((error as UsageError).message).not.toContain("--bundle");
    }
  });
});
