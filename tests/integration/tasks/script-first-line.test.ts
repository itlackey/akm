// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * How a script is run: its `#!` first line decides, then its extension. Each script runs through `akm run`, a version 5
 * `run:` step and a version 4 frozen task, and the exit code and standard output equal running the file directly.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../../_helpers/sandbox";

const CLI = path.resolve(import.meta.dir, "../../../src/cli.ts");
const environment = () => ({ ...process.env, NO_COLOR: "1", BUN_TEST: undefined, AKM_EVENT_SOURCE: undefined });
let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});
afterEach(() => storage.cleanup());

function akm(args: string[]) {
  return spawnSync("bun", [CLI, ...args, "--format", "json"], { encoding: "utf8", env: environment(), timeout: 60000 });
}

function write(relative: string, content: string, mode = 0o755): string {
  const file = path.join(storage.stashDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
  return file;
}

interface Outcome {
  code: number;
  stdout: string;
}

/** The exit code the failed run reports: version 5 and version 4 tasks say it in their error. */
function failedCode(run: ReturnType<typeof akm>): number {
  const text = `${run.stdout}${run.stderr}`;
  return Number(/exit code (\d+)/.exec(text)?.[1] ?? run.status);
}

const throughRun = (name: string): Outcome => {
  const run = spawnSync("bun", [CLI, "run", `scripts/${name}`], {
    encoding: "utf8",
    env: environment(),
    timeout: 60000,
  });
  return { code: run.status ?? -1, stdout: run.stdout };
};

const throughV5Step = (name: string): Outcome => {
  write("tasks/v5.yml", `version: 5-beta.1\nrun: scripts/${name}\n`);
  const run = akm(["run", "tasks/v5"]);
  return run.status === 0
    ? { code: 0, stdout: JSON.parse(run.stdout).result.result }
    : { code: failedCode(run), stdout: "" };
};

/** A frozen task's run log, which holds the script's output and, when it could not start, why. */
const v4Log = (run: ReturnType<typeof akm>): string => fs.readFileSync(JSON.parse(run.stdout).result.log, "utf8");

const throughV4Task = (name: string): Outcome => {
  write("tasks/v4.yml", `version: 4\nuses: scripts/${name}\n`);
  const run = akm(["task", "run", "v4"]);
  const stdout = /--- stdout ---\n([\s\S]*?)(?:\n--- |$)/.exec(v4Log(run))?.[1] ?? "";
  return { code: JSON.parse(run.stdout).result.detail.exitCode, stdout };
};

const entryPoints = { "akm run": throughRun, "a v5 run: step": throughV5Step, "a v4 frozen task": throughV4Task };

const scripts: ReadonlyArray<{ name: string; text: string; direct: (file: string) => string[] }> = [
  { name: "stop.sh", text: "#!/bin/bash -e\nfalse\necho still-running\n", direct: (f) => [f] },
  { name: "unset.sh", text: '#!/usr/bin/env -S bash -eu\necho "$NOT_SET"\necho reached\n', direct: (f) => [f] },
  { name: "env-python.py", text: "#!/usr/bin/env python3\nprint('from python')\n", direct: (f) => [f] },
  { name: "unmarked.py", text: "print('from python')\n", direct: (f) => ["python3", f] },
  { name: "bun-first-line.sh", text: '#!/usr/bin/env bun\necho "[$#]"\n', direct: (f) => [f] },
];

describe.skipIf(process.platform !== "linux")("a script's first line decides how it runs", () => {
  for (const script of scripts) {
    for (const [entry, run] of Object.entries(entryPoints)) {
      test(`${script.name} through ${entry} gives what running the file directly gives`, () => {
        const file = write(`scripts/${script.name}`, script.text);
        const [program, ...rest] = script.direct(file);
        const direct = spawnSync(program as string, rest, { encoding: "utf8" });
        const outcome = run(script.name);
        expect(outcome.code).toBe(direct.status as number);
        if (direct.status === 0) expect(outcome.stdout.trim()).toContain(direct.stdout.trim());
      });
    }
  }

  test("a first line naming a program that is not there is reported as the script's, with its first line", () => {
    write("scripts/missing.sh", "#!/nonexistent/prog\necho hi\n");
    write("tasks/v5.yml", "version: 5-beta.1\nrun: scripts/missing.sh\n");
    write("tasks/v4.yml", "version: 4\nuses: scripts/missing.sh\n");
    const runs = [
      spawnSync("bun", [CLI, "run", "scripts/missing.sh"], { encoding: "utf8", env: environment() }),
      akm(["run", "tasks/v5"]),
      akm(["task", "run", "v4"]),
    ];
    for (const [index, run] of runs.entries()) {
      expect(run.status).not.toBe(0);
      const text = `${run.stdout}${run.stderr}${index === 2 ? v4Log(run) : ""}`;
      expect(text).toContain("scripts/missing.sh");
      expect(text).toContain("#!/nonexistent/prog");
      expect(text).not.toContain("add its directory to PATH");
    }
  });

  test("a script with no first line and an extension akm has no program for says to add a first line", () => {
    write("scripts/data.xyz", "data\n");
    const run = spawnSync("bun", [CLI, "run", "scripts/data.xyz"], { encoding: "utf8", env: environment() });
    expect(run.status).not.toBe(0);
    expect(`${run.stdout}${run.stderr}`).not.toContain("Task definitions support");
  });
});
