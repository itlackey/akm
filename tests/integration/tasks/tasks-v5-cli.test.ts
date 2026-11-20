// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Version 5 tasks through the real CLI: `akm run <task>` and `akm task run <task>` with their start flags, the task's
 * result in the output, `--resume`, the lock's exit codes, and a version 4 task's flags left as they were.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  type IsolatedAkmStorage,
  withIsolatedAkmStorage,
  writeSandboxConfig,
  writeWorkflowTestConfig,
} from "../../_helpers/sandbox";

const CLI = path.resolve(import.meta.dir, "../../../src/cli.ts");
/** The environment akm runs in: the isolated storage this test set up, which is read when a command starts. */
const environment = () => ({ ...process.env, NO_COLOR: "1", BUN_TEST: undefined, AKM_EVENT_SOURCE: undefined });
let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});
afterEach(() => storage.cleanup());

function akm(args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync("bun", [CLI, ...args, "--format", "json"], {
    encoding: "utf8",
    env: { ...environment(), ...env },
    timeout: 60000,
  });
}

function write(relative: string, content: string): void {
  const file = path.join(storage.stashDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

const out = (run: ReturnType<typeof akm>) => JSON.parse(run.stdout);

describe.skipIf(process.platform !== "linux")("version 5 tasks through the CLI", () => {
  test("akm run gives the task's result, with the inputs, --env, --secret, --cwd and --inherit it was started with", () => {
    write("env/lab.env", "REGION=eu-west\n");
    write("secrets/deploy", "canary-cli-secret");
    write(
      "tasks/show.yml",
      `version: 5-beta.1
inputs:
  who: { type: string, required: true }
exec: 'printf "%s|%s|%s|%s|%s" "$REGION" "$DEPLOY" "$KEPT" "$(pwd)" "$(grep -c who "$AKM_TASK_STATE")"'
`,
    );
    const cwd = path.join(storage.root, "named");
    const run = akm(
      [
        "run",
        "tasks/show",
        "--who",
        "me",
        "--env",
        "env/lab",
        "--secret",
        "secrets/deploy:DEPLOY",
        "--cwd",
        cwd,
        "--inherit",
        "KEPT",
      ],
      { KEPT: "inherited" },
    );
    expect(run.status).toBe(0);
    const { ok, result } = out(run);
    expect(ok).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.result).toBe(`eu-west|[REDACTED]|inherited|${fs.realpathSync(cwd)}|1`);
    expect(run.stdout).not.toContain("canary-cli-secret");
  });

  test("akm task run, which a scheduler runs, takes the same start flags", () => {
    write("env/lab.env", "REGION=eu-west\n");
    write("tasks/show.yml", `version: 5-beta.1\nexec: 'printf "%s" "$REGION"'\n`);
    const run = akm(["task", "run", "show", "--env", "env/lab", "--scheduled"]);
    expect(run.status).toBe(0);
    expect(out(run).result.result).toBe("eu-west");
  });

  test("a failed run exits 1 with the step that failed, and --resume continues at that step with the first start's flags", () => {
    const marker = path.join(storage.root, "fixed");
    write("env/lab.env", "REGION=eu-west\n");
    write(
      "tasks/flow.yml",
      `version: 5-beta.1
steps:
  - name: first
    exec: printf one
  - name: second
    exec: test -f ${marker} && printf '%s' "$REGION"
`,
    );
    const failed = akm(["run", "tasks/flow", "--env", "env/lab"]);
    expect(failed.status).toBe(1);
    expect(out(failed).result.detail.error).toBe("second: exit code 1");
    fs.writeFileSync(marker, "");
    const resumed = akm(["run", "tasks/flow", "--resume"]);
    expect(resumed.status).toBe(0);
    const { result } = out(resumed);
    expect(result.steps.map((step: { status: string }) => step.status)).toEqual(["reused", "completed"]);
    expect(result.result).toBe("eu-west");
    expect(akm(["run", "tasks/flow", "--resume"]).status).toBe(2);
  });

  test("a failed step's reason ends with the last line its program wrote to standard error", () => {
    const agent = path.join(storage.root, "agent");
    fs.writeFileSync(agent, "#!/bin/sh\necho starting >&2\necho 'model endpoint unreachable' >&2\nexit 1\n", {
      mode: 0o755,
    });
    writeSandboxConfig({ harnesses: { local: { platform: "claude", bin: agent, args: [] } } });
    write("tasks/ask.yml", "version: 5-beta.1\nsteps:\n  - name: ask\n    prompt: Hi.\n");
    write("tasks/fetch.yml", "version: 5-beta.1\nexec: echo 'no route to host' >&2; exit 7\n");
    const asked = akm(["run", "tasks/ask"]);
    expect(asked.status).toBe(1);
    expect(out(asked).result.detail.error).toMatch(/^ask: .+: model endpoint unreachable$/);
    expect(out(akm(["run", "tasks/fetch"])).result.detail.error).toBe("(only): exit code 7: no route to host");
  });

  test("a task whose steps changed since the failed run is refused for --resume, and the failed run is left as it was", () => {
    const marker = path.join(storage.root, "fixed");
    const flow = (steps: string[]) =>
      `version: 5-beta.1\nsteps:\n${steps.map((exec, index) => `  - name: s${index}\n    exec: ${exec}`).join("\n")}\n`;
    const original = flow(["printf one", `test -f ${marker} && printf two`]);
    write("tasks/flow.yml", original);
    expect(akm(["run", "tasks/flow"]).status).toBe(1);
    write("tasks/flow.yml", flow(["printf zero", "printf one", `test -f ${marker} && printf two`]));
    const refused = akm(["run", "tasks/flow", "--resume"]);
    expect(refused.status).toBe(2);
    expect(refused.stderr + refused.stdout).toContain("changed its steps");
    write("tasks/flow.yml", original);
    fs.writeFileSync(marker, "");
    const resumed = akm(["run", "tasks/flow", "--resume"]);
    expect(resumed.status).toBe(0);
    expect(out(resumed).result.steps.map((step: { status: string }) => step.status)).toEqual(["reused", "completed"]);
  });

  test("a run cut off while a step was running is resumed at that step", async () => {
    const marker = path.join(storage.root, "fixed");
    const started = path.join(storage.root, "started");
    write(
      "tasks/cut.yml",
      `version: 5-beta.1
steps:
  - name: a
    exec: printf one
  - name: b
    exec: 'test -f ${marker} || { touch ${started}; sleep 5; }; printf two'
`,
    );
    const holder = spawn("bun", [CLI, "run", "tasks/cut", "--format", "json"], { env: environment(), stdio: "ignore" });
    for (let tries = 0; tries < 100 && !fs.existsSync(started); tries++) await Bun.sleep(100);
    expect(fs.existsSync(started)).toBe(true);
    const gone = new Promise((resolve) => holder.once("exit", resolve));
    holder.kill("SIGKILL");
    await gone;
    fs.writeFileSync(marker, "");
    const resumed = akm(["run", "tasks/cut", "--resume"]);
    expect(resumed.status).toBe(0);
    expect(out(resumed).result.steps.map((step: { status: string }) => step.status)).toEqual(["reused", "completed"]);
    expect(out(resumed).result.result).toBe("two");
  });

  test("--timeout limits the run, --max-retries runs a failing step again", () => {
    const count = path.join(storage.root, "count");
    write("tasks/slow.yml", "version: 5-beta.1\nexec: sleep 5\n");
    write("tasks/flaky.yml", `version: 5-beta.1\nexec: 'echo x >> ${count}; false'\n`);
    const slow = akm(["run", "tasks/slow", "--timeout", "300ms"]);
    expect(slow.status).toBe(1);
    expect(out(slow).result.detail.error).toBe("(only): timeout");
    expect(akm(["run", "tasks/flaky", "--max-retries", "2"]).status).toBe(1);
    expect(fs.readFileSync(count, "utf8").trim().split("\n")).toHaveLength(3);
  });

  test("a start that is not valid is refused before anything runs, naming the flag", () => {
    const marker = path.join(storage.root, "ran");
    write("tasks/t.yml", `version: 5-beta.1\nexec: touch ${marker}\n`);
    // usage errors exit 2, a ref that names nothing exits 1
    for (const [flags, status] of [
      [["--timeout", "soon"], 2],
      [["--secret", "secrets/x"], 2],
      [["--nope", "1"], 2],
      [["--env", "env/missing"], 1],
    ] as const) {
      expect(akm(["run", "tasks/t", ...flags]).status).toBe(status);
    }
    expect(fs.existsSync(marker)).toBe(false);
  });

  test("lock: true exits 75 for a start that finds the lock taken, and 0 with --skip-if-locked or --scheduled", async () => {
    const started = path.join(storage.root, "started");
    write("tasks/held.yml", `version: 5-beta.1\nlock: true\nexec: touch ${started}; sleep 6\n`);
    const holder = spawn("bun", [CLI, "run", "tasks/held", "--format", "json"], {
      env: environment(),
      stdio: "ignore",
    });
    try {
      for (let tries = 0; tries < 100 && !fs.existsSync(started); tries++) await Bun.sleep(100);
      expect(fs.existsSync(started)).toBe(true);
      expect(akm(["run", "tasks/held"]).status).toBe(75);
      const skipped = akm(["run", "tasks/held", "--skip-if-locked"]);
      expect(skipped.status).toBe(0);
      expect(out(skipped).result.status).toBe("active");
      expect(akm(["task", "run", "held", "--scheduled"]).status).toBe(0);
    } finally {
      holder.kill();
    }
  });

  test("a version 4 task keeps its flag parsing: --timeout is one of its input flags", () => {
    write("tasks/old.yml", "version: 4\nrun: echo hi\n");
    const run = akm(["run", "tasks/old", "--timeout", "5s"]);
    expect(run.status).toBe(2);
    expect(run.stderr + run.stdout).toContain("timeout");
  });

  test("a version 5 task does not run a version 4 task, and a version 4 step does not run a version 5 task", () => {
    write("tasks/old.yml", "version: 4\nrun: echo hi\n");
    write("tasks/new.yml", "version: 5-beta.1\nexec: echo hi\n");
    write("tasks/calls-old.yml", "version: 5-beta.1\nrun: tasks/old\n");
    write("tasks/v4-calls-new.yml", "version: 4\nsteps:\n  - { name: a, task: tasks/new }\n");
    for (const task of ["tasks/calls-old", "tasks/v4-calls-new"]) {
      const run = akm(["run", task]);
      expect(run.status).not.toBe(0);
      expect(run.stderr + run.stdout).toContain("akm migrate apply");
    }
  });
});
