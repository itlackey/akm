// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What `akm run`, `akm task run`, `akm task explain` and `akm doctor` do with tasks, measured through the real CLI
 * with real processes: a step's output size, why a step failed, what an agent step is given, retries, timeouts, tasks
 * of the same name in two bundles, the flags before and after a task's ref, `--resume`, a run whose akm was killed,
 * a working folder that cannot be made, and the messages of a start.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { harnessCalls, writeFakeHarness } from "../../_helpers/engine-stubs";
import { makeLauncherDist } from "../../_helpers/launcher-dist";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  type SandboxedDir,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../../_helpers/sandbox";

const CLI = path.resolve(import.meta.dir, "../../../src/cli.ts");
const environment = () => ({ ...process.env, NO_COLOR: "1", BUN_TEST: undefined, AKM_EVENT_SOURCE: undefined });
setDefaultTimeout(120_000);
const posix = process.platform === "linux";
let storage: IsolatedAkmStorage;
let bins: SandboxedDir;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  bins = makeSandboxDir("akm-tasks-run-fixes-bin");
  writeSandboxConfig({ semanticSearchMode: "off" });
});
afterEach(() => {
  bins.cleanup();
  storage.cleanup();
});

function akm(args: string[], env: Record<string, string | undefined> = {}): SpawnSyncReturns<string> {
  return spawnSync("bun", [CLI, ...args], { encoding: "utf8", env: { ...environment(), ...env }, timeout: 120_000 });
}
const akmJson = (args: string[], env?: Record<string, string | undefined>) => akm([...args, "--format", "json"], env);
const result = (run: SpawnSyncReturns<string>) => JSON.parse(run.stdout).result;
/** The error envelope a failed command writes on stderr, after any notice. */
const errorOf = (run: SpawnSyncReturns<string>) => JSON.parse(run.stderr.slice(run.stderr.indexOf("{")));

function write(relative: string, content: string, mode?: number): string {
  const file = path.join(storage.stashDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode === undefined ? undefined : { mode });
  return file;
}
const v5 = (body: string) => `version: 5-beta.1\n${body}`;

/** The rows of `akm task history` for one task. */
const history = (id: string, extra: string[] = []) =>
  JSON.parse(akmJson(["task", "history", id, ...extra]).stdout).rows;

describe.skipIf(!posix)("a step's output size", () => {
  test("a version 5 step that prints a million and a half lines completes", () => {
    write("tasks/big.yml", v5("exec: seq 1 1500000 >&2\n"));
    const run = akmJson(["run", "tasks/big"]);
    expect(run.status, run.stderr).toBe(0);
    expect(result(run).status).toBe("completed");
  });

  test("a version 4 task that prints a million and a half lines completes with the command's exit code", () => {
    write("tasks/big.yml", "version: 4\nshell: sh\nrun: seq 1 1500000 >&2\n");
    const run = akmJson(["task", "run", "big"]);
    expect(run.status, run.stderr).toBe(0);
    expect(result(run)).toMatchObject({ status: "completed", detail: { exitCode: 0 } });
  });
});

describe.skipIf(!posix)("a version 4 steps task whose agent prints a million and a half lines", () => {
  test("completes", () => {
    const bin = path.join(bins.dir, "printer");
    fs.writeFileSync(bin, "#!/bin/sh\ncat >/dev/null\nseq 1 1500000\n", { mode: 0o755 });
    writeSandboxConfig({ harnesses: { claude: { platform: "claude", bin } } });
    write("tasks/talk.yml", "version: 4\nsteps:\n  - name: ask\n    prompt: Hi.\n");
    const run = akmJson(["task", "run", "talk"]);
    expect(run.status, run.stderr).toBe(0);
    expect(result(run).status).toBe("completed");
  });
});

describe.skipIf(!posix)("why a task failed", () => {
  test("a version 4 task that timed out, exited non-zero or could not start says so in its detail", () => {
    write("tasks/slow.yml", "version: 4\nshell: sh\nrun: sleep 5\ntimeout: 1000\n");
    write("tasks/nope.yml", "version: 4\nshell: sh\nrun: \"sh -c 'echo nope >&2; exit 3'\"\n");
    write("scripts/missing.sh", "#!/nonexistent/prog\necho hi\n", 0o755);
    write("tasks/missing.yml", "version: 4\nuses: scripts/missing.sh\n");
    expect(result(akmJson(["task", "run", "slow"])).detail).toMatchObject({ reason: "timeout" });
    expect(result(akmJson(["task", "run", "nope"])).detail).toEqual({
      exitCode: 3,
      reason: "non_zero_exit",
      error: "exit code 3: nope",
    });
    expect(result(akmJson(["task", "run", "missing"])).detail).toMatchObject({ reason: "spawn_error" });
  });

  test("a version 5 agent step's reason is akm's message and the harness's own, as plain text", () => {
    const bin = writeFakeHarness(bins.dir, "fake-codex", ["partial"], {
      exitCode: 3,
      stderr: "\x1b[91mError: \x1b[0mboom\n",
    });
    const empty = writeFakeHarness(bins.dir, "fake-claude", [""]);
    writeSandboxConfig({
      harnesses: { codex: { platform: "codex", bin }, claude: { platform: "claude", bin: empty } },
    });
    write("tasks/fails.yml", v5("harness: codex\nprompt: Hi.\n"));
    write("tasks/empty.yml", v5("harness: claude\nprompt: Hi.\n"));
    const failed = result(akmJson(["run", "tasks/fails"])).detail.error as string;
    expect(failed).toMatch(/^\(only\): non_zero_exit: .*exited with code 3: Error: boom$/);
    expect(failed).not.toContain("\x1b");
    const emptied = result(akmJson(["run", "tasks/empty"])).detail.error as string;
    expect(emptied).toMatch(/^\(only\): parse_error: .*returned no answer\.$/);
    const db = path.join(process.env.XDG_STATE_HOME as string, "akm", "state.db");
    const stored = spawnSync("sqlite3", ["-readonly", db, "select metadata_json from task_history"], {
      encoding: "utf8",
    });
    expect(stored.stdout).not.toContain("\\u001b");
  });

  test("a step that dispatched an agent records the engine, and why it failed", () => {
    const empty = writeFakeHarness(bins.dir, "fake-claude", [""]);
    writeSandboxConfig({ harnesses: { claude: { platform: "claude", bin: empty } } });
    write("tasks/agent.yml", v5("steps:\n  - name: ask\n    prompt: Hi.\n  - name: after\n    exec: 'true'\n"));
    akmJson(["run", "tasks/agent"]);
    const [row] = history("agent");
    expect(row.steps[0].agent).toEqual({ engine: "claude", reason: "parse_error" });
    expect(row.steps[1].agent).toBeUndefined();
  });
});

describe.skipIf(!posix)("what a version 5 agent step is given", () => {
  test("it runs in akm's environment as it is, and a script step starts clean", () => {
    const bin = writeFakeHarness(bins.dir, "fake-claude", ["ok"]);
    writeSandboxConfig({ harnesses: { claude: { platform: "claude", bin } } });
    write(
      "tasks/env.yml",
      v5("steps:\n  - name: ask\n    prompt: Hi.\n  - name: look\n    exec: 'printf %s \"[$MY_PROVIDER_KEY]\"'\n"),
    );
    // Started through the real launcher, which sets AKM_LAUNCHER_PATH and AKM_LAUNCHER_NODE for akm.
    const dist = makeLauncherDist();
    let run: SpawnSyncReturns<string>;
    try {
      run = spawnSync(process.execPath, [dist.launcher, "run", "tasks/env", "--format", "json"], {
        encoding: "utf8",
        timeout: 120_000,
        env: { ...environment(), MY_PROVIDER_KEY: "from-akm-env", CLAUDE_CONFIG_DIR: "/somewhere/else" },
      });
    } finally {
      dist.cleanup();
    }
    expect(run.status, run.stderr).toBe(0);
    const [call] = harnessCalls(bin);
    expect(call?.env.MY_PROVIDER_KEY).toBe("from-akm-env");
    expect(call?.env.CLAUDE_CONFIG_DIR).toBe("/somewhere/else");
    // The variables akm's own launcher set are not the user's: a nested akm gets them from its own launcher.
    expect(call?.env.AKM_LAUNCHER_PATH).toBeUndefined();
    expect(call?.env.AKM_LAUNCHER_NODE).toBeUndefined();
    expect(result(run).result).toBe("[]");
  });
});

describe.skipIf(!posix)("retries print one result", () => {
  test("--max-retries on an agent run prints one document, with the attempts", () => {
    const bin = writeFakeHarness(bins.dir, "fake-claude", ["nope"], { exitCode: 1 });
    writeSandboxConfig({ harnesses: { claude: { platform: "claude", bin } } });
    write("agents/reviewer.md", "---\ntype: agent\n---\nA careful reader.\n");
    expect(akm(["index", "--full"]).status).toBe(0);
    const run = akmJson(["run", "agents/reviewer", "--harness", "claude", "--max-retries", "2", "--prompt", "x"]);
    expect(run.status).toBe(1);
    const document = JSON.parse(run.stdout);
    expect(document.attempts).toBe(3);
    expect(harnessCalls(bin)).toHaveLength(3);
  });

  test("--max-retries on a command run prints one document, with the attempts", () => {
    const bin = writeFakeHarness(bins.dir, "fake-claude", ["nope"], { exitCode: 1 });
    writeSandboxConfig({ harnesses: { claude: { platform: "claude", bin } } });
    write("commands/greet.md", "---\ntype: command\n---\nSay hello.\n");
    expect(akm(["index", "--full"]).status).toBe(0);
    const run = akmJson(["run", "commands/greet", "--harness", "claude", "--max-retries", "1"]);
    expect(run.status).toBe(1);
    expect(JSON.parse(run.stdout).attempts).toBe(2);
    expect(harnessCalls(bin)).toHaveLength(2);
  });

  test("an empty prompt is refused before any harness is started, as a value of --prompt", () => {
    const bin = writeFakeHarness(bins.dir, "fake-claude", ["ok"]);
    writeSandboxConfig({ harnesses: { claude: { platform: "claude", bin } } });
    const run = akm(["agent", "--prompt", ""]);
    expect(run.status).toBe(2);
    expect(harnessCalls(bin)).toHaveLength(0);
  });
});

describe.skipIf(!posix)("one timeout grammar and one limit", () => {
  test("a timeout above 24 days is refused naming the limit; 24 days runs", () => {
    write("scripts/ok.sh", "#!/bin/sh\nprintf ran\n", 0o755);
    const refused = akm(["run", "--timeout", "30d", "scripts/ok.sh"]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("2147483647");
    expect(refused.stdout).not.toContain("ran");
    expect(akm(["run", "--timeout", "24d", "scripts/ok.sh"]).stdout).toBe("ran");
    write("tasks/long.yml", v5("timeout: 30d\nexec: 'true'\n"));
    expect(akmJson(["run", "tasks/long"]).status).toBe(2);
  });

  test("a command asset and a version 4 task that runs one, each with timeout: 30s, complete", () => {
    const bin = writeFakeHarness(bins.dir, "fake-claude", ["hello"]);
    writeSandboxConfig({ harnesses: { claude: { platform: "claude", bin } } });
    write("commands/greet30.md", "---\ntype: command\ntimeout: 30s\n---\nSay hello.\n");
    write("tasks/greet.yml", "version: 4\nuses: commands/greet30\ntimeout: 30s\n");
    expect(akm(["index", "--full"]).status).toBe(0);
    const asset = akmJson(["run", "commands/greet30"]);
    expect(asset.status, asset.stderr).toBe(0);
    const task = akmJson(["task", "run", "greet"]);
    expect(task.status, task.stderr).toBe(0);
    expect(result(task).status).toBe("completed");
  });

  test("a version 4 timeout takes seconds, and fires after them", () => {
    write("tasks/short.yml", "version: 4\nshell: sh\nrun: sleep 20\ntimeout: 1s\n");
    const started = Date.now();
    const run = akmJson(["task", "run", "short"]);
    expect(result(run).detail.reason).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});

describe.skipIf(!posix)("a task is identified by its bundle and id", () => {
  test("two bundles with the same task name keep their own resume record, lock and history", () => {
    const other = makeSandboxDir("akm-tasks-run-fixes-two");
    try {
      writeSandboxConfig({
        defaultBundle: "stash",
        bundles: { stash: { path: storage.stashDir, writable: true }, two: { path: other.dir, writable: true } },
      });
      const marker = path.join(storage.root, "fixed");
      fs.mkdirSync(path.join(other.dir, "tasks"), { recursive: true });
      write("tasks/dup.yml", v5(`exec: 'test -f ${marker}'\n`));
      fs.writeFileSync(path.join(other.dir, "tasks", "dup.yml"), v5("exec: 'true'\n"));
      expect(akmJson(["run", "tasks/dup"]).status).toBe(1);
      // The other bundle's task has no failed run of its own to resume, and its success leaves this bundle's alone.
      const resumed = akmJson(["run", "two//tasks/dup", "--resume"]);
      expect(resumed.status).toBe(2);
      expect(akmJson(["run", "two//tasks/dup"]).status).toBe(0);
      fs.writeFileSync(marker, "");
      expect(akmJson(["run", "tasks/dup", "--resume"]).status).toBe(0);
      const rows = (bundle: string) => history("dup", ["--bundle", bundle]);
      expect(rows("two").map((row: { bundle: string }) => row.bundle)).toEqual(["two"]);
      expect(rows("stash").every((row: { bundle: string }) => row.bundle === "stash")).toBe(true);
      expect(rows("stash").length).toBe(2);
    } finally {
      other.cleanup();
    }
  });
});

describe.skipIf(!posix)("the flags before and after a task's ref", () => {
  test("a value input that starts with - is read from the next token by akm run, akm task run and akm task explain", () => {
    write(
      "tasks/who.yml",
      v5(
        'inputs:\n  who: { type: string, required: true }\nexec: \'printf %s "$(grep -o -- "-x" "$AKM_TASK_STATE")"\'\n',
      ),
    );
    expect(result(akmJson(["run", "tasks/who", "--who", "-x"])).result).toBe("-x");
    expect(result(akmJson(["task", "run", "who", "--who", "-x"])).result).toBe("-x");
    expect(akmJson(["task", "explain", "who", "--who", "-x"]).status).toBe(0);
    expect(akmJson(["doctor", "explain", "tasks/who", "--who", "-x"]).status).toBe(0);
  });

  test("start flags before the ref are read by akm task explain and akm doctor explain too", () => {
    write("env/a.env", "REGION=eu\n");
    write("tasks/envt.yml", v5("exec: 'true'\n"));
    expect(akmJson(["task", "explain", "--env", "env/a", "envt"]).status).toBe(0);
    expect(akmJson(["doctor", "explain", "--env", "env/a", "tasks/envt"]).status).toBe(0);
  });

  test("a version 4 value input that starts with - is read the same way by akm task run, explain and doctor explain", () => {
    write(
      "tasks/v4who.yml",
      'version: 4\nshell: sh\nrun: printf ok\ninputs:\n  who: { type: string, enum: ["-x"], required: true }\n',
    );
    expect(result(akmJson(["task", "run", "v4who", "--who", "-x"])).status).toBe("completed");
    expect(akmJson(["task", "explain", "v4who", "--who", "-x"]).status).toBe(0);
    expect(akmJson(["doctor", "explain", "tasks/v4who", "--who", "-x"]).status).toBe(0);
  });

  test("a flag that is no input is refused after the task is found, as the error envelope; one before the id is refused at once", () => {
    write("tasks/bool.yml", v5("inputs:\n  flag: { type: boolean }\nexec: 'true'\n"));
    const after = akmJson(["task", "run", "bool", "--flag", "-x"]);
    expect(after.status).toBe(2);
    expect(errorOf(after).code).toBe("UNKNOWN_FLAG");
    expect(akmJson(["task", "run", "-x", "bool"]).status).toBe(2);
    // A task that cannot be found is reported first.
    expect(errorOf(akmJson(["task", "run", "no-such-task", "--flag", "-x"])).code).toBe("ASSET_NOT_FOUND");
  });

  test("start flags before the ref of a version 5 task run as they do after it", () => {
    write("env/a.env", "REGION=eu\n");
    write("tasks/envt.yml", v5("exec: 'printf %s \"$REGION\"'\n"));
    expect(result(akmJson(["run", "--env", "env/a", "tasks/envt"])).result).toBe("eu");
    expect(
      result(akmJson(["run", "--timeout", "5s", "--max-retries", "0", "tasks/envt", "--env", "env/a"])).result,
    ).toBe("eu");
    expect(akmJson(["run", "tasks/envt", "--env", "env/a", "--max-retries", "0"]).status).toBe(0);
  });
});

describe.skipIf(!posix)("--resume", () => {
  const flow = (step: string) => v5(`steps:\n  - name: a\n    exec: echo A\n  - name: b\n    exec: ${step}\n`);

  test("refuses the inputs and flags it would drop, naming each", () => {
    write("tasks/failing.yml", v5("inputs:\n  mode: { type: string, default: x }\nexec: 'false'\n"));
    expect(akmJson(["run", "tasks/failing"]).status).toBe(1);
    const refused = akmJson([
      "run",
      "tasks/failing",
      "--resume",
      "--mode",
      "other",
      "--timeout",
      "1s",
      "--env",
      "env/nope",
    ]);
    expect(refused.status).toBe(2);
    for (const name of ["--mode", "--timeout", "--env"]) expect(refused.stderr + refused.stdout).toContain(name);
    expect(akmJson(["run", "tasks/failing", "--resume"]).status).toBe(1);
  });

  test("refuses a finished step whose definition changed, and runs when only the failed step changed", () => {
    const marker = path.join(storage.root, "fixed");
    write("tasks/chg.yml", flow(`test -f ${marker}`));
    expect(akmJson(["run", "tasks/chg"]).status).toBe(1);
    write("tasks/chg.yml", flow(`test -f ${marker}`).replace("echo A", "echo CHANGED"));
    const refused = akmJson(["run", "tasks/chg", "--resume"]);
    expect(refused.status).toBe(2);
    expect(errorOf(refused).error).toContain('step "a"');
    write("tasks/chg.yml", flow(`test -f ${marker} && echo B`));
    fs.writeFileSync(marker, "");
    expect(akmJson(["run", "tasks/chg", "--resume"]).status).toBe(0);
  });
});

describe.skipIf(!posix)("a run whose akm was killed", () => {
  test("shows as interrupted at once, and names the step that was running", async () => {
    const started = path.join(storage.root, "b-started");
    write(
      "tasks/killme.yml",
      v5(
        `steps:\n  - name: a\n    exec: echo A\n  - name: b\n    exec: touch ${started}; sleep 60\n  - name: c\n    exec: echo C\n`,
      ),
    );
    const child = spawn("bun", [CLI, "run", "tasks/killme", "--format", "json"], {
      env: environment(),
      stdio: "ignore",
    });
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(started) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fs.existsSync(started)).toBe(true);
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    const [shown] = history("killme");
    expect(shown.status).toBe("interrupted");
    // Any later task start settles the row and names the step.
    write("tasks/other.yml", v5("exec: 'true'\n"));
    akmJson(["run", "tasks/other"]);
    const [row] = history("killme");
    expect(row.status).toBe("interrupted");
    expect(row.detail).toEqual({ reason: "interrupted", error: "akm ended while step b was running" });
    expect(row.steps.map((step: { name: string; status: string }) => `${step.name}:${step.status}`)).toEqual([
      "a:completed",
      "b:failed",
      "c:skipped",
    ]);
    expect(row.steps[1].reason).toBe("interrupted");
    spawnSync("pkill", ["-f", `touch ${started}`]);
  });
});

describe.skipIf(!posix || process.getuid?.() === 0)("a working folder that cannot be made", () => {
  test("is refused before the run, by akm run and doctor explain, naming the folder", () => {
    write("tasks/basic.yml", v5("exec: 'true'\n"));
    const run = akmJson(["run", "tasks/basic", "--cwd", "/x/y"]);
    expect(run.status).toBe(2);
    expect(run.stderr + run.stdout).toMatch(/\/x\/y.*EACCES|EACCES.*\/x\/y/);
    const explained = akmJson(["doctor", "explain", "tasks/basic", "--cwd", "/x/y"]);
    expect(explained.status).toBe(2);
  });

  test("a scheduled run of a task whose cwd: cannot be made records task_load_failed with the usage code", () => {
    write("tasks/nocwd.yml", v5("cwd: /nonexistent-root/nope\nexec: 'true'\n"));
    akmJson(["task", "run", "nocwd", "--scheduled"]);
    const [row] = history("nocwd");
    expect(row.detail).toEqual({ reason: "task_load_failed", error: "INVALID_FLAG_VALUE" });
  });
});

describe.skipIf(!posix)("the messages of a start", () => {
  test("akm run --help lists --resume, and an akm flag a version 5 start does not take is named as that", () => {
    expect(akm(["run", "--help"]).stdout).toContain("--resume");
    write("tasks/basic.yml", v5("exec: 'true'\n"));
    const refused = akmJson(["run", "tasks/basic", "--clean"]);
    expect(refused.status).toBe(2);
    expect(refused.stderr + refused.stdout).toContain("--clean is not taken by a version 5 task start");
  });

  test("--max-retries 0 is accepted for a version 5 task, a script and an agent run", () => {
    write("tasks/basic.yml", v5("exec: 'true'\n"));
    write("scripts/ok.sh", "#!/bin/sh\ntrue\n", 0o755);
    expect(akmJson(["run", "tasks/basic", "--max-retries", "0"]).status).toBe(0);
    expect(akm(["run", "--max-retries", "0", "scripts/ok.sh"]).status).toBe(0);
  });

  test("a value input given no value is refused, and a boolean input still binds true", () => {
    write(
      "tasks/inp.yml",
      v5('inputs:\n  s: { type: string }\n  b: { type: boolean }\nexec: \'printf %s "$(cat "$AKM_TASK_STATE")"\'\n'),
    );
    const refused = akm(["run", "tasks/inp", "--format", "json", "--s"]);
    expect(refused.status).toBe(2);
    expect(JSON.parse(akm(["run", "tasks/inp", "--format", "json", "--b"]).stdout).result.result).toContain(
      '"b": true',
    );
  });
});

describe.skipIf(!posix)("help is plain text when it is not on a terminal", () => {
  test("akm import --help has no escape byte unless a color is forced", () => {
    const env = { NO_COLOR: undefined, TERM: undefined, FORCE_COLOR: undefined, CI: undefined };
    const plain = akm(["import", "--help"], env);
    expect(plain.stdout).toContain("USAGE");
    expect(`${plain.stdout}${plain.stderr}`).not.toContain("\x1b");
    expect(akm(["import", "--help"], { ...env, FORCE_COLOR: "1" }).stdout).toContain("\x1b");
  });
});

describe.skipIf(!posix)("root help is plain text when it is not on a terminal", () => {
  test("akm, akm --help and akm -h have no escape byte unless a color is forced", () => {
    const env = { NO_COLOR: undefined, TERM: undefined, FORCE_COLOR: undefined, CI: undefined };
    for (const args of [[], ["--help"], ["-h"]]) {
      const plain = akm(args, env);
      expect(plain.stdout, args.join(" ")).toContain("USAGE");
      expect(`${plain.stdout}${plain.stderr}`, args.join(" ")).not.toContain("\x1b");
      expect(akm(args, { ...env, FORCE_COLOR: "1" }).stdout, args.join(" ")).toContain("\x1b");
    }
  });
});

describe.skipIf(!posix)("one --max-retries parser", () => {
  test("akm workflow run refuses what akm run refuses, in the same words", () => {
    const refused = (args: string[]) => String(errorOf(akm(args)).error);
    write("scripts/none.sh", "#!/bin/sh\ntrue\n", 0o755);
    const viaRun = refused(["run", "--max-retries", "-1", "scripts/none.sh"]);
    const viaWorkflow = refused(["workflow", "run", "workflows/none", "--max-retries", "-1"]);
    expect(viaRun).toContain('Invalid --max-retries value: "-1". Must be a whole number, 0 or more.');
    expect(viaWorkflow).toContain('Invalid --max-retries value: "-1". Must be a whole number, 0 or more.');
    expect(refused(["workflow", "run", "workflows/none", "--max-retries", "0"])).not.toContain("--max-retries");
  });
});

describe.skipIf(!posix)("the scheduler report in akm doctor", () => {
  test("lists a connection and a harness of the same name once each, in its own kind", () => {
    writeSandboxConfig({
      connections: { default: { endpoint: "http://localhost:1/v1", models: { fast: "m" } } },
      harnesses: { default: { platform: "claude", bin: "/bin/true" } },
    });
    const { engine } = JSON.parse(akmJson(["task", "doctor"]).stdout);
    expect(engine.connections).toEqual(["default"]);
    expect(engine.harnesses).toEqual(["default"]);
  });

  test("survives an improve strategy it cannot resolve: checks are shown, the strategy error is named, the status is a warning", () => {
    writeSandboxConfig({ improve: { strategy: "quick" } });
    const run = akmJson(["doctor", "--no-probe"]);
    expect(run.status).toBe(4);
    const report = JSON.parse(run.stdout);
    expect(report.hardChecks.length).toBeGreaterThan(0);
    expect(report.scheduler.improveStrategy).toMatchObject({ name: "quick", code: "UNKNOWN_IMPROVE_STRATEGY" });
    expect(report.scheduler.improveStrategy.error).toContain("quick");
    expect(report.status).toBe("warn");
  });

  test("doctor explain checks each schedule entry's env and secrets, and reports a refusal under the entry", () => {
    write("tasks/sched.yml", v5("schedule:\n  - cron: \"0 3 * * *\"\n    env: [env/missing]\nexec: 'true'\n"));
    const run = akmJson(["doctor", "explain", "tasks/sched"]);
    // The preview says what the action says: `doctor scheduler sync` refuses the same entry.
    expect(run.status).toBe(1);
    const explained = JSON.parse(run.stdout);
    expect(explained.ok).toBe(false);
    const [entry] = explained.result?.schedule ?? explained.schedule;
    expect(entry.error).toContain("env/missing");
  });
});
