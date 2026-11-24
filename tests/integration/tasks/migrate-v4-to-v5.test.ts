// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm migrate apply <task-file>...`: a version 4 task file named on the command line becomes version 5 by the
 * design's "Names" table, after the check a start makes of it. A file that is not named, or cannot convert, stays as
 * it is. The pure planner is `scripts/akm-migrate/migrate/task-to-v5.ts`; the step is `task-migrate.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { main } from "../../../scripts/akm-migrate";
import { planTaskToV5File } from "../../../scripts/akm-migrate/migrate/task-to-v5";
import { runMigration } from "../../../scripts/akm-migrate/run-migrate";
import {
  applyTaskFilesMigration,
  applyTaskFilesV5Migration,
  inspectTaskFilesV5Migration,
} from "../../../scripts/akm-migrate/task-migrate";
import { resetConfigCache } from "../../../src/core/config/config";
import { parseTaskSource } from "../../../src/tasks/source/parse-task-source";
import { checkTaskV5 } from "../../../src/tasks/v5/check";
import { TASK_SOURCE_V5_VERSION } from "../../../src/tasks/v5/source";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({});
  resetConfigCache();
});

afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

function put(relative: string, text: string): string {
  const file = path.join(storage.stashDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o640 });
  return file;
}

const task = (name: string, text: string): string => put(`tasks/${name}.yml`, text);
const read = (file: string): string => fs.readFileSync(file, "utf8");
/** The version a v5 file's document holds, read the way every reader reads it. */
function versionOf(file: string): string | undefined {
  const parsed = parseTaskSource({ yaml: read(file), filePath: file });
  return parsed.version === 4 ? undefined : parsed.v5.version;
}

/** The planner's output for a v4 task text, parsed. */
function convert(text: string): {
  out: Record<string, unknown> & { steps?: Record<string, unknown>[] };
  notes: readonly string[];
} {
  const outcome = planTaskToV5File({
    filePath: path.join(storage.stashDir, "tasks", "t.yml"),
    bytes: Buffer.from(text),
    mode: 0o640,
    writable: true,
  });
  if (outcome.status !== "converted") throw new Error(`not converted: ${outcome.reason} ${outcome.detail ?? ""}`);
  return { out: parseYaml(outcome.after.toString("utf8")), notes: outcome.notes };
}

function blockedReason(text: string): string {
  const outcome = planTaskToV5File({
    filePath: path.join(storage.stashDir, "tasks", "t.yml"),
    bytes: Buffer.from(text),
    mode: 0o640,
    writable: true,
  });
  expect(outcome.status).toBe("blocked");
  return `${outcome.reason}: ${outcome.detail ?? ""}`;
}

describe("the Names table", () => {
  test("version: 4 becomes the one beta this build reads", () => {
    expect(convert("version: 4\nrun: echo hi\n").out.version).toBe(TASK_SOURCE_V5_VERSION);
  });

  test("a task's uses: <ref> becomes run: <ref>", () => {
    expect(convert("version: 4\nuses: commands/report\n").out).toMatchObject({ run: "commands/report" });
    expect(convert("version: 4\nuses: scripts/report.sh\n").out).toMatchObject({ run: "scripts/report.sh" });
  });

  test("uses: akm/command with a ref becomes run: plus arguments:", () => {
    const { out } = convert(
      "version: 4\nuses: akm/command\nwith:\n  ref: commands/report\n  arguments: the weekly one\n",
    );
    expect(out).toMatchObject({ run: "commands/report", arguments: "the weekly one" });
    expect(out.uses).toBeUndefined();
    expect(out.with).toBeUndefined();
  });

  test("uses: akm/command with content becomes prompt:", () => {
    const { out } = convert("version: 4\nuses: akm/command\nwith:\n  content: |\n    Write the plan.\n    Be brief.\n");
    expect(out.prompt).toBe("Write the plan.\nBe brief.\n");
    expect(out.run).toBeUndefined();
  });

  test("a task's run: <shell line> becomes exec:, as written, and working-directory: becomes cwd:", () => {
    const line = "wc -l < plan.md | tee out.txt && echo 'done: ok'";
    const { out } = convert(`version: 4\nshell: sh\nworking-directory: work\nrun: ${JSON.stringify(line)}\n`);
    expect(out).toMatchObject({ exec: line, cwd: "work" });
    expect(out.run).toBeUndefined();
    expect(out.shell).toBeUndefined();
    expect(out["working-directory"]).toBeUndefined();
  });

  test("a task's maxRetries becomes max-retries; harness, connection, model, timeout, inputs and schedule are as written", () => {
    const { out } = convert(
      [
        "version: 4",
        "name: weekly",
        "description: d",
        "tags: [a]",
        "inputs:",
        "  date: { type: string, required: true }",
        "uses: commands/report",
        "harness: claude",
        "connection: lab",
        "model: m1",
        "timeout: 20m",
        "maxRetries: 2",
        "schedule:",
        "  - cron: '@daily'",
        "    inputs: { date: x }",
        "",
      ].join("\n"),
    );
    expect(out).toMatchObject({
      name: "weekly",
      description: "d",
      tags: ["a"],
      inputs: { date: { type: "string", required: true } },
      harness: "claude",
      connection: "lab",
      model: "m1",
      timeout: "20m",
      "max-retries": 2,
      schedule: [{ cron: "@daily", inputs: { date: "x" } }],
    });
    expect(out.maxRetries).toBeUndefined();
  });

  test("a steps: task: run -> exec, prompt ref -> run, prompt text -> prompt, task -> run, retries -> max-retries", () => {
    const { out } = convert(
      [
        "version: 4",
        "steps:",
        "  - name: a",
        "    run: ./fetch.sh --all",
        "    retries: 2",
        "    timeout: 5m",
        "  - name: b",
        "    prompt: commands/summarize",
        "    harness: claude",
        "    expect: [title]",
        "  - name: c",
        "    prompt: Write the plan for me.",
        "  - name: d",
        "    task: tasks/child",
        "",
      ].join("\n"),
    );
    expect(out.steps).toEqual([
      { name: "a", exec: "./fetch.sh --all", "max-retries": 2, timeout: "5m" },
      { name: "b", run: "commands/summarize", harness: "claude", expect: ["title"] },
      { name: "c", prompt: "Write the plan for me." },
      { name: "d", run: "tasks/child" },
    ]);
  });

  test("working-directory on a steps: task becomes the task's cwd:", () => {
    expect(convert("version: 4\nworking-directory: w\nsteps:\n  - name: a\n    run: ls\n").out.cwd).toBe("w");
  });

  test("an env: map becomes a list with one NAME: value entry per variable, on a task and on a step", () => {
    const { out } = convert(
      "version: 4\nenv:\n  LEVEL: info\n  N: 3\nsteps:\n  - name: a\n    run: ls\n    env:\n      FLAG: true\n",
    );
    expect(out.env).toEqual([{ LEVEL: "info" }, { N: 3 }]);
    expect(out.steps?.[0]?.env).toEqual([{ FLAG: true }]);
  });

  test("a shell line that is exactly `akm exec --env <ref>... -- <rest>` becomes env: refs and exec: <rest>", () => {
    const { out } = convert(
      "version: 4\nenv:\n  X: 1\nrun: akm exec --env env/lab --env team//env/deploy -- ./go.sh --now\n",
    );
    expect(out.exec).toBe("./go.sh --now");
    expect(out.env).toEqual(["env/lab", "team//env/deploy", { X: 1 }]);
  });

  test("any other shell line that mentions akm exec stays exec:, unchanged", () => {
    for (const line of [
      "akm exec --env env/lab --secret secrets/k:K -- ./go.sh",
      "echo hi && akm exec --env env/lab -- ./go.sh",
      "akm exec --env env/lab ./go.sh",
    ]) {
      const { out } = convert(`version: 4\nrun: ${JSON.stringify(line)}\n`);
      expect(out.exec).toBe(line);
      expect(out.env).toBeUndefined();
    }
  });
});

describe("lock", () => {
  test("a steps: task is written with lock: true", () => {
    expect(convert("version: 4\nsteps:\n  - name: a\n    run: ls\n").out.lock).toBe(true);
  });

  test("a task that is one command is written without a lock", () => {
    for (const text of ["version: 4\nrun: ls\n", "version: 4\nuses: commands/x\n"]) {
      expect(convert(text).out.lock).toBeUndefined();
    }
  });
});

describe("comments", () => {
  function convertedText(text: string): string {
    const outcome = planTaskToV5File({
      filePath: path.join(storage.stashDir, "tasks", "t.yml"),
      bytes: Buffer.from(text),
      mode: 0o640,
      writable: true,
    });
    if (outcome.status !== "converted") throw new Error(`not converted: ${outcome.reason}`);
    return outcome.after.toString("utf8");
  }

  test("a comment stays on the key it was on, under that key's version 5 name, and inside values kept as written", () => {
    const text = convertedText(
      [
        "# Nightly fetch.",
        "",
        "version: 4",
        "description: Fetch it # why",
        "inputs:",
        "  # the day to fetch",
        "  day: { type: string }",
        "# where it runs",
        "working-directory: w",
        "maxRetries: 2 # twice is enough",
        "run: ./fetch.sh",
        "# end of file",
        "",
      ].join("\n"),
    );
    expect(text).toBe(
      [
        "# Nightly fetch.",
        "",
        `version: ${TASK_SOURCE_V5_VERSION}`,
        "description: Fetch it # why",
        "inputs:",
        "  # the day to fetch",
        "  day: { type: string }",
        "# where it runs",
        "cwd: w",
        "max-retries: 2 # twice is enough",
        "exec: ./fetch.sh",
        "",
        "# end of file",
        "",
      ].join("\n"),
    );
  });

  test("a step's comments stay on that step, under its keys' version 5 names", () => {
    const text = convertedText(
      [
        "version: 4",
        "# the steps",
        "steps:",
        "  # first, fetch",
        "  - name: a",
        "    run: ./fetch.sh # the fetcher",
        "    retries: 1 # once more",
        "  - name: b",
        "    # the child does the rest",
        "    task: tasks/child",
        "",
      ].join("\n"),
    );
    expect(text).toBe(
      [
        `version: ${TASK_SOURCE_V5_VERSION}`,
        "lock: true",
        "# the steps",
        "steps:",
        "  # first, fetch",
        "  - name: a",
        "    exec: ./fetch.sh # the fetcher",
        "    max-retries: 1 # once more",
        "  - name: b",
        "    # the child does the rest",
        "    run: tasks/child",
        "",
      ].join("\n"),
    );
  });

  test("a comment on a key version 5 drops goes with it", () => {
    expect(convertedText("version: 4\nshell: bash # needs bash\nrun: ls\n")).not.toContain("needs bash");
  });
});

describe("what to change by hand", () => {
  test("a steps: task's shell steps are reported as having received AKM_PARAMS and AKM_STEPS", () => {
    const { notes } = convert(
      "version: 4\nsteps:\n  - name: a\n    run: ls\n  - name: b\n    run: pwd\n  - name: c\n    prompt: Hello there.\n",
    );
    expect(notes[0]).toMatch(/Steps a, b .*AKM_PARAMS.*AKM_STEPS.*\$AKM_TASK_STATE/);
    expect(notes.filter((note) => note.includes("AKM_PARAMS"))).toHaveLength(1);
  });

  test("a prompt step is reported with what v4 appended to it: the values when there are inputs, earlier results after the first step", () => {
    const { notes } = convert(
      [
        "version: 4",
        "inputs:",
        "  date: { type: string, required: true }",
        "steps:",
        "  - name: a",
        "    prompt: First.",
        "  - name: b",
        "    prompt: commands/second",
        "",
      ].join("\n"),
    );
    expect(notes).toEqual([
      expect.stringMatching(/^Step a: .*the task's values appended/),
      expect.stringMatching(/^Step b: .*the task's values and the earlier steps' results appended/),
    ]);
  });

  test("a first prompt step of a task with no inputs had nothing appended and is not reported", () => {
    expect(convert("version: 4\nsteps:\n  - name: a\n    prompt: First.\n").notes).toEqual([]);
  });

  test("shell: bash is dropped and reported; shell: sh is not", () => {
    expect(convert("version: 4\nshell: bash\nrun: ls\n").notes).toEqual([expect.stringMatching(/shell: bash/)]);
    expect(convert("version: 4\nshell: sh\nrun: ls\n").notes).toEqual([]);
  });

  test("a task that is one command has nothing to change by hand", () => {
    expect(convert("version: 4\nrun: ls\n").notes).toEqual([]);
  });
});

describe("a file that cannot convert", () => {
  test.each([
    ["uses: workflows/...", "version: 4\nuses: workflows/x\n"],
    ["output", "version: 4\nuses: commands/x\noutput: { type: object }\n"],
    ["agent", "version: 4\nuses: commands/x\nagent: agents/a\n"],
    ["engine", "version: 4\nuses: commands/x\nengine: lab\n"],
    ["inference", "version: 4\nuses: commands/x\ninference: { temperature: 0 }\n"],
    ["tools", "version: 4\nuses: commands/x\ntools: [a]\n"],
    ["redact", "version: 4\nuses: commands/x\nredact: [TOKEN]\n"],
    ["maxSteps", "version: 4\nuses: commands/x\nmaxSteps: 3\n"],
    ["shell: zsh", "version: 4\nshell: zsh\nrun: ls\n"],
  ])("%s has no version 5 form", (key, text) => {
    expect(blockedReason(text)).toContain(`no-version-5-form: version 5 has no form for ${key}`);
  });

  test("it is left untouched on disk and reported with the reason", async () => {
    const text = "version: 4\nuses: commands/x\noutput: { type: object }\n";
    const file = task("blocked", text);
    const status = await applyTaskFilesV5Migration([file]);
    expect(read(file)).toBe(text);
    expect(status.status).toBe("blocked");
    expect(status.files).toEqual([
      expect.objectContaining({ filePath: file, status: "blocked", reason: "no-version-5-form" }),
    ]);
    expect(status.blockers[0]).toContain("output");
  });

  test("a file that is not under a bundle's tasks folder is reported, not read", async () => {
    const outside = path.join(storage.root, "outside.yml");
    fs.writeFileSync(outside, "version: 4\nrun: ls\n");
    const status = await applyTaskFilesV5Migration([outside]);
    expect(status.files).toEqual([expect.objectContaining({ status: "blocked", reason: "not-a-task-file" })]);
    expect(read(outside)).toBe("version: 4\nrun: ls\n");
  });

  test("a file already at version 5 is skipped and unchanged", async () => {
    const text = `version: ${TASK_SOURCE_V5_VERSION}\nexec: ls\n`;
    const file = task("done", text);
    const status = await applyTaskFilesV5Migration([file]);
    expect(status.files).toEqual([expect.objectContaining({ status: "skipped", reason: "already-v5" })]);
    expect(status.status).toBe("current");
    expect(read(file)).toBe(text);
  });
});

describe("the check a start makes", () => {
  test("a converted file is written only after it passes, and passes checkTaskV5 as written", async () => {
    put("commands/report.md", "Write the report.\n");
    put("scripts/fetch.sh", "#!/bin/sh\necho hi\n");
    put("env/lab.env", "A=1\n");
    const file = task(
      "weekly",
      [
        "version: 4",
        "inputs:",
        "  date: { type: string, default: today }",
        "env:",
        "  LEVEL: info",
        "steps:",
        "  - name: a",
        "    run: akm exec --env env/lab -- echo ok",
        "  - name: b",
        "    prompt: commands/report",
        "  - name: c",
        "    prompt: Say it again.",
        "",
      ].join("\n"),
    );
    const status = await applyTaskFilesV5Migration([file]);
    expect(status.files).toEqual([expect.objectContaining({ filePath: file, status: "converted" })]);
    expect(versionOf(file)).toBe(TASK_SOURCE_V5_VERSION);
    await checkTaskV5({ ref: "tasks/weekly", bundle: { name: "stash", dir: storage.stashDir } });
  });

  test("a file the checker refuses is not written, and the reason is the checker's", async () => {
    const text = "version: 4\nuses: commands/missing\n";
    const file = task("nothing", text);
    const status = await applyTaskFilesV5Migration([file]);
    expect(read(file)).toBe(text);
    expect(status.files).toEqual([
      expect.objectContaining({
        status: "blocked",
        reason: "version-5-check-failed",
        detail: expect.stringContaining("commands/missing"),
      }),
    ]);
    expect(status.applied).toBeUndefined();
  });

  test("a prompt that holds ${name} that is no input or step is refused, not rewritten", async () => {
    const text = "version: 4\nsteps:\n  - name: a\n    prompt: Use ${HOME} here.\n";
    const file = task("literal", text);
    const status = await applyTaskFilesV5Migration([file]);
    expect(read(file)).toBe(text);
    expect(status.files[0]).toMatchObject({ status: "blocked", reason: "version-5-check-failed" });
  });

  test("a task that runs a version 4 task is refused until that task is named too", async () => {
    const parent = task("parent", "version: 4\nsteps:\n  - name: a\n    task: tasks/child\n");
    const child = task("child", "version: 4\nrun: ls\n");
    const alone = await applyTaskFilesV5Migration([parent]);
    expect(alone.files[0]).toMatchObject({ status: "blocked", reason: "version-5-check-failed" });
    expect(alone.files[0]?.detail).toContain("version 4 task");
    expect(read(parent)).toContain("version: 4");

    const both = await applyTaskFilesV5Migration([parent, child]);
    expect(both.files.map((file) => file.status)).toEqual(["converted", "converted"]);
    await checkTaskV5({ ref: "tasks/parent", bundle: { name: "stash", dir: storage.stashDir } });
  });

  test("a parent is refused when the version 4 task it runs cannot convert", async () => {
    const parent = task("parent", "version: 4\nsteps:\n  - name: a\n    task: tasks/child\n");
    const child = task("child", "version: 4\nuses: commands/x\noutput: { type: object }\n");
    const status = await applyTaskFilesV5Migration([parent, child]);
    expect(status.files.map((file) => file.status)).toEqual(["blocked", "blocked"]);
    expect(read(parent)).toContain("version: 4");
  });
});

describe("only named files change", () => {
  test("`apply` with no files leaves every version 4 file as it is and reports no version 5 section", async () => {
    const text = "version: 4\nrun: ls\n";
    const file = task("quiet", text);
    const plan = await runMigration({ apply: true });
    expect(read(file)).toBe(text);
    expect(plan.taskFilesV5).toBeUndefined();
    expect(plan.taskFiles?.changed).toBe(0);
  });

  test("a named file converts and an unnamed one beside it does not", async () => {
    const named = task("named", "version: 4\nrun: ls\n");
    const other = "version: 4\nrun: pwd\n";
    const unnamed = task("unnamed", other);
    const plan = await runMigration({ apply: true, taskFiles: [named] });
    expect(versionOf(named)).toBe(TASK_SOURCE_V5_VERSION);
    expect(read(unnamed)).toBe(other);
    expect(plan.taskFilesV5).toEqual([expect.objectContaining({ filePath: named, status: "converted" })]);
    expect(plan.taskFilesV5BackupPath).toBeDefined();
  });

  test("the converted file's original is backed up", async () => {
    const text = "version: 4\nrun: ls\n";
    const file = task("kept", text);
    const status = await applyTaskFilesV5Migration([file]);
    const backups = fs.readdirSync(path.join(status.backupPath as string, "files"));
    expect(backups).toHaveLength(1);
    expect(read(path.join(status.backupPath as string, "files", backups[0] as string))).toBe(text);
  });

  test("a named version 3 file is converted to version 5 in the one run, as the preview says", async () => {
    const file = task("old", "version: 3\nuses: commands/report\nakm:\n  schedule: '@daily'\n");
    put("commands/report.md", "Report.\n");
    const preview = await runMigration({ apply: false, taskFiles: [file] });
    expect(preview.taskFilesV5).toEqual([expect.objectContaining({ status: "converted" })]);
    expect(read(file)).toContain("version: 3");

    const applied = await runMigration({ apply: true, taskFiles: [file] });
    expect(applied.taskFilesV5).toEqual(preview.taskFilesV5);
    expect(versionOf(file)).toBe(TASK_SOURCE_V5_VERSION);
  });
});

describe("the preview is the apply", () => {
  test("a dangling link or a loop in the bundle, inside a folder or at the top, does not stop the check of a valid conversion", async () => {
    put("commands/r.md", "R.\n");
    put("scripts/ok.sh", "#!/bin/sh\ntrue\n");
    fs.symlinkSync(path.join(storage.stashDir, "nowhere"), path.join(storage.stashDir, "scripts", "z.sh"));
    fs.symlinkSync("loop-b", path.join(storage.stashDir, "scripts", "loop-a"));
    fs.symlinkSync("loop-a", path.join(storage.stashDir, "scripts", "loop-b"));
    fs.symlinkSync(path.join(storage.stashDir, "nowhere"), path.join(storage.stashDir, "dangling"));
    fs.symlinkSync("top-b", path.join(storage.stashDir, "top-a"));
    fs.symlinkSync("top-a", path.join(storage.stashDir, "top-b"));
    const file = task("links", "version: 4\nsteps:\n  - name: a\n    run: ls\n  - name: b\n    prompt: commands/r\n");
    const preview = await inspectTaskFilesV5Migration([file]);
    expect(preview.status).toBe("ready");
  });

  test("it reports what apply does, writes nothing, and calls the same conversion", async () => {
    put("commands/r.md", "R.\n");
    const text = "version: 4\nsteps:\n  - name: a\n    run: ls\n  - name: b\n    prompt: commands/r\n";
    const file = task("same", text);
    const preview = await inspectTaskFilesV5Migration([file]);
    expect(preview.status).toBe("ready");
    expect(read(file)).toBe(text);
    expect(preview.backupPath).toBeUndefined();

    const applied = await applyTaskFilesV5Migration([file]);
    expect(applied.files).toEqual(preview.files);
    expect(applied.files[0]?.notes?.length).toBeGreaterThan(0);
  });

  test("an unnamed run of the version 4 step still plans version 4 only", async () => {
    const file = task("plain", "version: 3\nuses: commands/report\nakm:\n  schedule: '@daily'\n");
    const status = await applyTaskFilesMigration();
    expect(status.applied).toBe(1);
    expect(read(file)).toContain("version: 4");
  });
});

describe("the command line", () => {
  test("`apply` takes task files and --dry-run, and no other flag", async () => {
    await expect(main(["apply", "--force", "x.yml"])).rejects.toThrow(/`apply` does not accept --force/);
  });
});
