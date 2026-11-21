// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm migrate apply <workflow-file>...`: a workflow file named on the command line becomes a new version 5 task
 * file, after the check a start makes of it, and stays where it is. A workflow that cannot convert is left as it is
 * and reported with what to change. `akm doctor` lists the workflow files that remain.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { main } from "../../scripts/akm-migrate/main";
import { applyTaskFilesV5Migration, inspectTaskFilesV5Migration } from "../../scripts/akm-migrate/task-migrate";
import { collectWorkflowFilesAdvisory } from "../../src/commands/health/workflow-files";
import { resetConfigCache } from "../../src/core/config/config";
import { checkTaskV5 } from "../../src/tasks/v5/check";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

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

const workflow = (name: string, text: string): string => put(`workflows/${name}.md`, text);
const read = (file: string): string => fs.readFileSync(file, "utf8");
const taskFile = (name: string): string => path.join(storage.stashDir, "tasks", `${name}.yml`);

const WEEKLY = [
  "---",
  "type: workflow",
  "description: The weekly report.",
  "when_to_use: When a weekly report is due.",
  "tags: [report, weekly]",
  "params:",
  "  week: { type: string, description: The ISO week, default: 2026-W01 }",
  "  dry_run: { type: boolean, default: false }",
  "defaults: { harness: claude, timeout: 10m }",
  "steps:",
  "  - id: collect",
  "    unit:",
  "      model: fast",
  "      timeout: 90s",
  "      retry: { max: 2, on: [timeout] }",
  "      output:",
  "        type: object",
  "        properties: { count: { type: integer } }",
  "        required: [count]",
  "  - id: write",
  "    inputs: [steps.collect.output]",
  "---",
  "",
  "# Weekly",
  "",
  "## collect",
  "",
  "Collect the numbers for {{ week }}.",
  "",
  "### gate",
  "",
  "The numbers must be complete.",
  "",
  "## write",
  "",
  "Write the report from the numbers.",
  "",
].join("\n");

const withStep = (id: string, unit: string[], body: string): string =>
  ["---", "steps:", `  - id: ${id}`, ...unit, "---", "", `## ${id}`, "", body, ""].join("\n");

async function convert(file: string) {
  const status = await applyTaskFilesV5Migration([file]);
  return { status, file: status.files[0] as NonNullable<(typeof status.files)[number]> };
}

describe("a prose workflow", () => {
  test("becomes a task file that passes the check a start makes, and the workflow stays", async () => {
    const file = workflow("weekly", WEEKLY);
    const before = read(file);
    const { status, file: result } = await convert(file);

    expect(result).toMatchObject({ status: "converted", reason: "workflow-converted", taskFile: taskFile("weekly") });
    expect(status.status).toBe("current");
    expect(read(file)).toBe(before);
    const document = await checkTaskV5({ ref: "tasks/weekly", bundle: { name: "stash", dir: storage.stashDir } });
    expect(document.steps.map((step) => step.name)).toEqual(["collect", "write"]);
  });

  test("`akm-migrate status <workflow>` reports the conversion and writes nothing", async () => {
    const file = workflow("weekly", WEEKLY);
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await main(["status", file]);
      const plan = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(plan.taskFilesV5).toEqual([
        expect.objectContaining({ filePath: file, status: "converted", taskFile: taskFile("weekly") }),
      ]);
    } finally {
      log.mockRestore();
    }
    expect(fs.existsSync(taskFile("weekly"))).toBe(false);
  });

  test("keeps its description, tags, lock, inputs, defaults, step options and expected keys", async () => {
    const { file } = await convert(workflow("weekly", WEEKLY));
    const task = parseYaml(read(taskFile("weekly")));

    expect(task).toMatchObject({
      version: "5-beta.1",
      description: "The weekly report.",
      when_to_use: "When a weekly report is due.",
      tags: ["report", "weekly"],
      lock: true,
      harness: "claude",
      timeout: "10m",
      inputs: {
        week: { type: "string", description: "The ISO week", default: "2026-W01" },
        dry_run: { type: "boolean", default: false },
      },
    });
    expect(task.steps[0]).toMatchObject({
      name: "collect",
      model: "fast",
      timeout: "90s",
      "max-retries": 2,
      expect: ["count"],
    });
    expect(file.notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Step collect: its output schema is not checked any more beyond the required keys"),
        expect.stringContaining("Step collect: retry.on"),
        expect.stringContaining("Step collect: its `### gate` rubric"),
      ]),
    );
  });

  test("a step's prompt is its text byte for byte, then the run inputs and the earlier results it was given", async () => {
    await convert(workflow("weekly", WEEKLY));
    const task = parseYaml(read(taskFile("weekly")));
    const inputs = "## Run inputs\n- week: ${week}\n- dry_run: ${dry_run}";

    expect(task.steps[0].prompt).toBe(`Collect the numbers for {{ week }}.\n\n${inputs}`);
    expect(task.steps[1].prompt).toBe(
      `Write the report from the numbers.\n\n${inputs}\n\n## Declared inputs\n### steps.collect.output\n\${collect}`,
    );
  });

  test("a preview converts the same file an apply does and writes nothing", async () => {
    const file = workflow("weekly", WEEKLY);
    const preview = await inspectTaskFilesV5Migration([file]);
    expect(preview.status).toBe("ready");
    expect(fs.existsSync(taskFile("weekly"))).toBe(false);
    const applied = await applyTaskFilesV5Migration([file]);
    expect(applied.files).toEqual(preview.files);
    expect(applied.applied).toBe(1);
  });

  test("an exec step of plain words becomes exec:, with cwd and inherit", async () => {
    const file = workflow(
      "run",
      withStep(
        "go",
        ["    unit:", "      exec: { command: [echo, hello-world, a=b], cwd: work, pass_env: [HOME] }"],
        "Run it.",
      ),
    );
    const { file: result } = await convert(file);
    expect(parseYaml(read(taskFile("run"))).steps[0]).toEqual({
      name: "go",
      exec: "echo hello-world a=b",
      cwd: "work",
      inherit: ["HOME"],
    });
    expect(result.notes?.join(" ")).toContain("AKM_PARAMS");
  });

  test("lists the task files that name the workflow, and leaves them as they are", async () => {
    const runner = put("tasks/nightly.yml", "version: 4\nuses: workflows/weekly\n");
    const other = put("tasks/other.yml", "version: 4\nrun: echo workflows/weekly-extra\n");
    const { file } = await convert(workflow("weekly", WEEKLY));
    expect(file.notes?.join(" ")).toContain(runner);
    expect(file.notes?.join(" ")).not.toContain(other);
    expect(read(runner)).toBe("version: 4\nuses: workflows/weekly\n");
  });
});

describe("a workflow that cannot convert", () => {
  const XDG = "Create the folder `${XDG_CACHE_HOME:-$HOME/.cache}/akm/work` if needed.";

  test("a ${...} that is not an input or an earlier step blocks the file, naming the step and the token, with guidance", async () => {
    const file = workflow("curate", withStep("fetch", [], XDG));
    const { status, file: result } = await convert(file);

    expect(result).toMatchObject({ status: "blocked", reason: "unknown-reference" });
    expect(result.detail).toContain("step fetch");
    expect(result.detail).toContain("${XDG_CACHE_HOME:-$HOME/.cache}");
    expect(result.guidance).toContain("every ${...} in it names an input or an earlier step");
    expect(result.guidance).toContain("shell or environment variables into a script asset under scripts/");
    expect(result.guidance).toContain("a new step whose unit is an exec unit");
    expect(result.guidance).toContain("$AKM_TASK_STATE");
    expect(result.guidance).toContain("akm migrate apply workflows/curate.md");
    expect(status.status).toBe("blocked");
    expect(fs.existsSync(taskFile("curate"))).toBe(false);
    expect(read(file)).toContain("XDG_CACHE_HOME");
  });

  test("a ${name} that names a param converts", async () => {
    const file = workflow(
      "ok",
      [
        "---",
        "params:",
        "  x: { type: string }",
        "steps:",
        "  - id: a",
        "---",
        "",
        "## a",
        "",
        "Use ${x} here.",
        "",
      ].join("\n"),
    );
    expect((await convert(file)).file.status).toBe("converted");
  });

  test.each([
    ["fan-out", withStep("each", ["    map: { over: params.items }"], "Do one."), "step each: a fan-out"],
    [
      "child-workflow",
      withStep("sub", ["    unit:", "      workflow: workflows/other"], "Run it."),
      "step sub: a child workflow",
    ],
    ["engine", withStep("old", ["    unit:", "      engine: claude"], "Do it."), "step old: the retired engine: key"],
    [
      "exec-argv",
      withStep("go", ["    unit:", "      exec: { command: [sh, -c, echo hi | wc] }"], "Run it."),
      "step go: argument",
    ],
  ])("a %s blocks the file with guidance", async (reason, text, detail) => {
    const { file } = await convert(workflow("blocked", text));
    expect(file).toMatchObject({ status: "blocked", reason });
    expect(file.detail).toContain(detail);
    expect(file.guidance).toContain("akm migrate apply workflows/blocked.md");
    expect(fs.existsSync(taskFile("blocked"))).toBe(false);
  });

  test("an existing task file is never overwritten", async () => {
    const existing = put("tasks/weekly.yml", "version: 4\nrun: echo mine\n");
    const { file } = await convert(workflow("weekly", WEEKLY));
    expect(file).toMatchObject({ status: "blocked", reason: "task-file-exists" });
    expect(file.guidance).toContain("tasks/weekly.yml");
    expect(read(existing)).toBe("version: 4\nrun: echo mine\n");
  });

  test("a workflow the compiler refuses is reported with its errors", async () => {
    const { file } = await convert(workflow("bad", "no frontmatter\n"));
    expect(file).toMatchObject({ status: "blocked", reason: "invalid-workflow" });
    expect(file.detail).toBeTruthy();
  });

  test("a task the check refuses is blocked with the check's own message and guidance", async () => {
    const { file } = await convert(
      workflow(
        "bad-input",
        ["---", "params:", "  env: { type: string }", "steps:", "  - id: a", "---", "", "## a", "", "Go.", ""].join(
          "\n",
        ),
      ),
    );
    expect(file).toMatchObject({ status: "blocked", reason: "version-5-check-failed" });
    expect(file.detail).toContain("--env");
    expect(file.guidance).toContain("akm doctor explain tasks/bad-input");
    expect(fs.existsSync(taskFile("bad-input"))).toBe(false);
  });
});

describe("akm doctor", () => {
  test("lists the workflow files left in a writable bundle, says they are removed in 0.11 and names the command", () => {
    const file = workflow("weekly", WEEKLY);
    const advisory = collectWorkflowFilesAdvisory();
    expect(advisory).toMatchObject({ name: "workflow-files", status: "warn" });
    expect(advisory?.message).toContain(file);
    expect(advisory?.message).toContain("removed in 0.11");
    expect(advisory?.message).toContain("akm migrate apply <path>");
    expect(advisory?.evidence).toEqual({ files: [file] });
  });

  test("says nothing when no workflow file is left", () => {
    put("workflows/README.md", "About workflows.\n");
    expect(collectWorkflowFilesAdvisory()).toBeUndefined();
  });

  test("a bundle that cannot be read is unknown, not empty", () => {
    fs.writeFileSync(path.join(storage.configDir, "akm", "config.json"), "{ not json");
    resetConfigCache();
    expect(collectWorkflowFilesAdvisory()).toMatchObject({ status: "unknown", reason: "blocked" });
  });
});
