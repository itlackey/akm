/**
 * Tests for the legacy `.md` task file warning (release-blocker fix for 0.8.0).
 *
 * In 0.8.0, task definitions are read exclusively from pure `.yml` files. Any
 * leftover `.md` task files from 0.7.x are silently skipped by `akm tasks list`
 * and `akm tasks sync`, which makes scheduled tasks vanish without operator
 * notice. This fix emits a single grouped stderr warning that lists the
 * affected files and points at the migration doc. It does NOT auto-migrate.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  _resetLegacyMdTaskWarningStateForTests,
  akmTasksDoctor,
  akmTasksHistory,
  akmTasksList,
  akmTasksRemove,
  akmTasksRun,
  akmTasksSetEnabled,
  akmTasksShow,
} from "../src/commands/tasks/tasks";
import { runCliCapture } from "./_helpers/cli";

let stashDir: string;
let xdgConfig: string;
let xdgData: string;
let xdgState: string;
const origEnv = {
  AKM_STASH_DIR: process.env.AKM_STASH_DIR,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
};

beforeEach(() => {
  stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-tasks-md-warn-"));
  xdgConfig = fs.mkdtempSync(path.join(os.tmpdir(), "akm-tasks-md-warn-cfg-"));
  xdgData = fs.mkdtempSync(path.join(os.tmpdir(), "akm-tasks-md-warn-data-"));
  xdgState = fs.mkdtempSync(path.join(os.tmpdir(), "akm-tasks-md-warn-state-"));
  process.env.AKM_STASH_DIR = stashDir;
  process.env.XDG_CONFIG_HOME = xdgConfig;
  process.env.XDG_DATA_HOME = xdgData;
  process.env.XDG_STATE_HOME = xdgState;
  fs.mkdirSync(path.join(stashDir, "tasks"), { recursive: true });
  _resetLegacyMdTaskWarningStateForTests();
});

afterEach(() => {
  for (const dir of [stashDir, xdgConfig, xdgData, xdgState]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const [k, v] of Object.entries(origEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function captureStderr(fn: () => Promise<void> | void): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  // Replace stderr.write with a capture function. The cast mirrors the
  // bivariant signature of Writable.write.
  (process.stderr as unknown as { write: (s: string | Uint8Array) => boolean }).write = (s: string | Uint8Array) => {
    chunks.push(typeof s === "string" ? s : Buffer.from(s).toString("utf8"));
    return true;
  };
  return Promise.resolve(fn())
    .finally(() => {
      (process.stderr as unknown as { write: typeof orig }).write = orig;
    })
    .then(() => chunks.join(""));
}

describe("akm tasks list: legacy .md task file warning", () => {
  test("emits a single grouped stderr warning when .md task files are present", async () => {
    const tasksRoot = path.join(stashDir, "tasks");
    fs.writeFileSync(path.join(tasksRoot, "daily-backup.md"), "# legacy 0.7.x task\n", "utf8");
    fs.writeFileSync(path.join(tasksRoot, "nightly-report.md"), "# legacy 0.7.x task\n", "utf8");
    // One valid .yml task so we also confirm it still shows up in the result.
    fs.writeFileSync(path.join(tasksRoot, "ok.yml"), ['schedule: "@daily"', "command: echo hi", ""].join("\n"), "utf8");

    const stderr = await captureStderr(async () => {
      const result = await akmTasksList();
      expect(result.tasks.map((t) => t.id)).toEqual(["ok"]);
    });

    expect(stderr).toContain("2 task file(s) use the legacy .md format");
    expect(stderr).toContain("AKM 0.8.0 requires tasks as pure .yml");
    expect(stderr).toContain("docs/migration/v0.7-to-v0.8.md");
    expect(stderr).toContain("tasks/daily-backup.md");
    expect(stderr).toContain("tasks/nightly-report.md");
  });

  test("does not emit a warning when no .md task files exist", async () => {
    const tasksRoot = path.join(stashDir, "tasks");
    fs.writeFileSync(path.join(tasksRoot, "ok.yml"), ['schedule: "@daily"', "command: echo hi", ""].join("\n"), "utf8");

    const stderr = await captureStderr(async () => {
      await akmTasksList();
    });

    expect(stderr).toBe("");
  });

  test("warning is de-duplicated within a single process across repeat calls", async () => {
    const tasksRoot = path.join(stashDir, "tasks");
    fs.writeFileSync(path.join(tasksRoot, "old.md"), "x", "utf8");

    const stderr = await captureStderr(async () => {
      await akmTasksList();
      await akmTasksList();
      await akmTasksList();
    });

    // The warning header must appear exactly once even though we called list
    // three times — operators should not see the same wall of text repeated.
    const occurrences = stderr.split("WARNING:").length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("legacy .md task file warning fires from all task subcommands", () => {
  test("akm tasks show warns about legacy .md files before resolving the task", async () => {
    const tasksRoot = path.join(stashDir, "tasks");
    fs.writeFileSync(path.join(tasksRoot, "legacy.md"), "# legacy\n", "utf8");

    const stderr = await captureStderr(async () => {
      await expect(akmTasksShow("legacy")).rejects.toBeDefined();
    });

    expect(stderr).toContain("legacy .md format");
    expect(stderr).toContain("tasks/legacy.md");
  });

  test("akm tasks run warns about legacy .md files before runTask", async () => {
    const tasksRoot = path.join(stashDir, "tasks");
    fs.writeFileSync(path.join(tasksRoot, "legacy.md"), "# legacy\n", "utf8");

    const stderr = await captureStderr(async () => {
      // The task does not exist as .yml so runTask will fail; we only assert the
      // warning emerges before that error.
      await expect(akmTasksRun("legacy")).rejects.toBeDefined();
    });

    expect(stderr).toContain("legacy .md format");
    expect(stderr).toContain("tasks/legacy.md");
  });

  test("akm tasks remove warns about legacy .md files before resolving", async () => {
    const tasksRoot = path.join(stashDir, "tasks");
    fs.writeFileSync(path.join(tasksRoot, "legacy.md"), "# legacy\n", "utf8");

    const stderr = await captureStderr(async () => {
      await expect(akmTasksRemove("legacy")).rejects.toBeDefined();
    });

    expect(stderr).toContain("legacy .md format");
  });

  test("akm tasks set-enabled warns about legacy .md files before resolving", async () => {
    const tasksRoot = path.join(stashDir, "tasks");
    fs.writeFileSync(path.join(tasksRoot, "legacy.md"), "# legacy\n", "utf8");

    const stderr = await captureStderr(async () => {
      await expect(akmTasksSetEnabled("legacy", false)).rejects.toBeDefined();
    });

    expect(stderr).toContain("legacy .md format");
  });

  test("akm tasks history warns about legacy .md files", async () => {
    const tasksRoot = path.join(stashDir, "tasks");
    fs.writeFileSync(path.join(tasksRoot, "legacy.md"), "# legacy\n", "utf8");

    const stderr = await captureStderr(async () => {
      await akmTasksHistory({ limit: 1 });
    });

    expect(stderr).toContain("legacy .md format");
  });

  test("akm tasks doctor warns about legacy .md files", async () => {
    const tasksRoot = path.join(stashDir, "tasks");
    fs.writeFileSync(path.join(tasksRoot, "legacy.md"), "# legacy\n", "utf8");

    const stderr = await captureStderr(async () => {
      await akmTasksDoctor();
    });

    expect(stderr).toContain("legacy .md format");
  });
});

describe("singular `akm task` alias", () => {
  test("`akm task list` resolves to the same `tasks` command group", async () => {
    const tasksRoot = path.join(stashDir, "tasks");
    fs.writeFileSync(path.join(tasksRoot, "ok.yml"), ['schedule: "@daily"', "command: echo hi", ""].join("\n"), "utf8");

    // `task` is a citty meta.alias for `tasks` in 0.8 (flip primary in 0.9).
    const result = await runCliCapture(["task", "list", "--format=json"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { tasks: Array<{ id: string }> };
    expect(parsed.tasks.map((t) => t.id)).toContain("ok");
  });
});
