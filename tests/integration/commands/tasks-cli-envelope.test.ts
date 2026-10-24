// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS6 characterization test for the `akm task` command family. Pins the full
 * JSON envelope (stdout payload shape + the {ok:false,…} error envelope on
 * stderr / exit code) for representative subcommands, proving the extraction of
 * the family from cli.ts into src/commands/tasks-cli.ts and the migration of the
 * leaf handlers onto `defineJsonCommand` is byte-identical. Only the
 * scheduler-free subcommands are exercised (`doctor`, the bare-group default,
 * and the `run` not-found error path) so the test never touches the host OS
 * scheduler. The CLI reads an isolated stash through AKM_BUNDLE_DIR via the
 * in-process harness.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../../src/core/config/config";
import { setSchedulerRefEnabled } from "../../../src/tasks/activation-config";
import { runCliStatusWithBundleDir as runCli, runCliCapture } from "../../_helpers/cli";
import { makeSandboxDir, type SandboxedDir, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const disposers: SandboxedDir[] = [];

afterEach(() => {
  for (const d of disposers.splice(0)) d.cleanup();
});

function makeStashDir(): string {
  const d = makeSandboxDir("akm-tasks-envelope-");
  disposers.push(d);
  fs.mkdirSync(path.join(d.dir, "tasks"), { recursive: true });
  return d.dir;
}

function writeLocallyDisabledCommandTask(stashDir: string): void {
  // P4 (docs/plans/specs/p4-deletions-closeout.md §3.2.7, row B-22, F-A2.18)
  // DELETED run-task.ts's shouldSkipUnactivatedTask entirely — task source v4
  // has no document-level enabled/disabled concept. Scheduling activation is
  // host-local config, and its absence must not prevent manual dispatch.
  fs.writeFileSync(
    path.join(stashDir, "tasks", "disabled-command.yml"),
    ["version: 4", "run: exit 0", "schedule:", "  - cron: '@daily'", ""].join("\n"),
  );
}

describe("akm task — JSON envelope snapshot (WS6)", () => {
  // Owner ruling 12, canonical bare-group behavior: bare `akm task` used to
  // run doctor implicitly. It is now a usage error naming the subcommands —
  // the next test covers the explicit `akm task doctor` this replaces.
  test("bare `akm task` → usage-error envelope, exit 2", async () => {
    const stash = makeStashDir();
    const { stderr, status } = await runCli(["task"], stash);
    expect(status).toBe(2);
    const env = JSON.parse(stderr.trim());
    expect(env.ok).toBe(false);
    expect(env.code).toBe("MISSING_REQUIRED_ARGUMENT");
    expect(env.error).toContain("`akm task` requires a subcommand");
    expect(env.error).toContain("doctor");
  });

  test("tasks doctor: success envelope reports the active scheduler backend", async () => {
    const stash = makeStashDir();
    const { stdout, status } = await runCli(["task", "doctor"], stash);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.shape).toBe("task-doctor");
    expect(typeof env.backend).toBe("string");
    expect(Array.isArray(env.warnings)).toBe(true);
  });

  test("tasks run: unknown id → {ok:false} not-found envelope on stderr", async () => {
    const stash = makeStashDir();
    const { stderr, status } = await runCli(["task", "run", "does-not-exist"], stash);
    expect(status).toBe(1);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("ASSET_NOT_FOUND");
  });

  test("tasks run manually executes a schedule-disabled task", async () => {
    const stash = makeStashDir();
    writeLocallyDisabledCommandTask(stash);

    const { stdout, status } = await runCli(["task", "run", "disabled-command"], stash);

    expect(status).toBe(0);
    expect(JSON.parse(stdout).result.status).toBe("completed");
  });

  test("native akm projects only bare or tasks/<id> refs and rejects other native-looking dirs", async () => {
    const stash = makeStashDir();
    fs.writeFileSync(
      path.join(stash, "tasks", "nightly.yml"),
      ["version: 4", 'run: "exit 0"', 'schedule: "@daily"', ""].join("\n"),
    );

    const canonical = await runCli(["task", "run", "tasks/nightly"], stash);
    expect(canonical.status, canonical.stderr).toBe(0);
    expect(JSON.parse(canonical.stdout).result.id).toBe("nightly");

    const ambiguous = await runCli(["task", "run", "commands/nightly"], stash);
    expect(ambiguous.status).toBe(2);
    expect(JSON.parse(ambiguous.stderr)).toMatchObject({ ok: false, code: "INVALID_FLAG_VALUE" });
  });

  test("a non-task component adapter cannot claim a task-shaped public ref", async () => {
    const storage = withIsolatedAkmStorage();
    const bundle = makeSandboxDir("akm-workflow-component");
    disposers.push(bundle);
    try {
      saveConfig({
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        defaultBundle: "stash",
        bundles: {
          stash: { path: storage.stashDir, writable: true },
          workflows: {
            path: bundle.dir,
            components: { main: { root: ".", adapter: "akm-workflow", writable: false } },
          },
        },
      });

      const result = await runCliCapture(["task", "run", "tasks/nightly", "--bundle", "workflows", "--scheduled"]);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, code: "INVALID_FLAG_VALUE" });
    } finally {
      storage.cleanup();
    }
  });

  test.each([
    ["flat component", "."],
    ["nested component", "components/scheduled"],
  ] as const)("a real scheduled CLI invocation resolves an akm-task %s", async (_label, componentRoot) => {
    const storage = withIsolatedAkmStorage();
    const bundle = makeSandboxDir("akm-task-component");
    disposers.push(bundle);
    try {
      const taskRoot = path.join(bundle.dir, componentRoot);
      fs.mkdirSync(taskRoot, { recursive: true });
      fs.writeFileSync(
        path.join(taskRoot, "standalone.yml"),
        ["version: 4", 'run: "exit 0"', 'schedule: "@daily"', ""].join("\n"),
      );
      saveConfig({
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        defaultBundle: "stash",
        bundles: {
          stash: { path: storage.stashDir, writable: true },
          scheduled: {
            path: bundle.dir,
            components: { main: { root: componentRoot, adapter: "akm-task", writable: false } },
          },
        },
      });
      setSchedulerRefEnabled("scheduled//standalone", true);

      const { code, stdout, stderr } = await runCliCapture([
        "task",
        "run",
        "standalone",
        "--bundle",
        "scheduled",
        "--scheduled",
      ]);

      expect(code, stderr).toBe(0);
      expect(JSON.parse(stdout).result).toMatchObject({ id: "standalone", status: "completed" });
    } finally {
      storage.cleanup();
    }
  });

  test("a real bundle-qualified scheduled invocation preserves a deep akm-task id in history", async () => {
    const storage = withIsolatedAkmStorage();
    const bundle = makeSandboxDir("akm-task-deep-component");
    disposers.push(bundle);
    try {
      const componentRoot = "components/scheduled";
      const taskId = "sub/deep/nightly";
      const taskRoot = path.join(bundle.dir, componentRoot);
      fs.mkdirSync(path.join(taskRoot, "sub", "deep"), { recursive: true });
      fs.writeFileSync(
        path.join(taskRoot, `${taskId}.yml`),
        ["version: 4", 'run: "exit 0"', 'schedule: "@daily"', ""].join("\n"),
      );
      saveConfig({
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        defaultBundle: "stash",
        bundles: {
          stash: { path: storage.stashDir, writable: true },
          scheduled: {
            path: bundle.dir,
            components: { main: { root: componentRoot, adapter: "akm-task", writable: false } },
          },
        },
      });
      setSchedulerRefEnabled(`scheduled//${taskId}`, true);

      const run = await runCliCapture(["task", "run", taskId, "--bundle", "scheduled", "--scheduled"]);
      expect(run.code, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout).result).toMatchObject({ id: taskId, status: "completed" });

      const history = await runCliCapture(["task", "history", "--id", `scheduled//${taskId}`]);
      expect(history.code, history.stderr).toBe(0);
      expect(JSON.parse(history.stdout).rows[0]).toMatchObject({ id: taskId, status: "completed" });

      // #911: a positional id means the same as --id instead of being
      // silently discarded (which answered with every task's newest rows).
      const positional = await runCliCapture(["task", "history", `scheduled//${taskId}`, "--limit", "1"]);
      expect(positional.code, positional.stderr).toBe(0);
      expect(JSON.parse(positional.stdout).rows).toEqual(JSON.parse(history.stdout).rows.slice(0, 1));

      const conflict = await runCliCapture(["task", "history", "other-task", "--id", `scheduled//${taskId}`]);
      expect(conflict.code).toBe(2);
      expect(`${conflict.stdout}${conflict.stderr}`).toContain("two task ids");
    } finally {
      storage.cleanup();
    }
  });

  test("a standalone task whose first component is tasks keeps that component in runtime identity", async () => {
    const storage = withIsolatedAkmStorage();
    const bundle = makeSandboxDir("akm-task-native-prefix-component");
    disposers.push(bundle);
    try {
      const taskId = "tasks/nightly";
      fs.mkdirSync(path.join(bundle.dir, "tasks"), { recursive: true });
      fs.writeFileSync(
        path.join(bundle.dir, `${taskId}.yml`),
        ["version: 4", 'run: "exit 0"', 'schedule: "@daily"', ""].join("\n"),
      );
      saveConfig({
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        defaultBundle: "stash",
        bundles: {
          stash: { path: storage.stashDir, writable: true },
          scheduled: {
            path: bundle.dir,
            components: { main: { root: ".", adapter: "akm-task", writable: false } },
          },
        },
      });
      setSchedulerRefEnabled(`scheduled//${taskId}`, true);

      const run = await runCliCapture(["task", "run", taskId, "--bundle", "scheduled", "--scheduled"]);
      expect(run.code, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout).result).toMatchObject({ id: taskId, status: "completed" });

      const history = await runCliCapture(["task", "history", "--id", `scheduled//${taskId}`]);
      expect(history.code, history.stderr).toBe(0);
      expect(JSON.parse(history.stdout).rows[0]).toMatchObject({ id: taskId, status: "completed" });
    } finally {
      storage.cleanup();
    }
  });

  test.each([
    "commands/nightly",
    "scripts/deep/nightly",
    "workflows/release/nightly",
    "knowledge/ops/nightly",
  ])("a standalone native-looking concept %s round-trips through CLI and history", async (taskId) => {
    const storage = withIsolatedAkmStorage();
    const bundle = makeSandboxDir("akm-task-native-looking-component");
    disposers.push(bundle);
    try {
      fs.mkdirSync(path.dirname(path.join(bundle.dir, `${taskId}.yml`)), { recursive: true });
      fs.writeFileSync(
        path.join(bundle.dir, `${taskId}.yml`),
        ["version: 4", 'run: "exit 0"', 'schedule: "@daily"', ""].join("\n"),
      );
      saveConfig({
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        defaultBundle: "stash",
        bundles: {
          stash: { path: storage.stashDir, writable: true },
          scheduled: {
            path: bundle.dir,
            components: { main: { root: ".", adapter: "akm-task", writable: false } },
          },
        },
      });
      setSchedulerRefEnabled(`scheduled//${taskId}`, true);

      const run = await runCliCapture(["task", "run", taskId, "--bundle", "scheduled", "--scheduled"]);
      expect(run.code, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout).result).toMatchObject({ id: taskId, status: "completed" });

      const history = await runCliCapture(["task", "history", "--id", `scheduled//${taskId}`]);
      expect(history.code, history.stderr).toBe(0);
      expect(JSON.parse(history.stdout).rows[0]).toMatchObject({ id: taskId, status: "completed" });
    } finally {
      storage.cleanup();
    }
  });

  test("task add help advertises --prompt as inline text only", async () => {
    const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
    const result = spawnSync("bun", [path.join(repoRoot, "src", "cli.ts"), "task", "add", "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, AKM_BUNDLE_DIR: undefined },
    });
    const help = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    expect(result.status).toBe(0);
    expect(help).toMatch(/--prompt.*inline text/i);
    expect(help).not.toMatch(/--prompt.*asset ref like|--prompt.*or \.\/.*\.md/i);
  });
});
