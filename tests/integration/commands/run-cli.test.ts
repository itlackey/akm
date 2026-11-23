// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Exercises real isolated index/state databases and harmless echo/shell children.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { GLOBAL_OUTPUT_ARGS } from "../../../src/cli/shared";
import { runAssetCommand } from "../../../src/commands/run-cli";
import { readEvents } from "../../../src/core/events";
import { _resetWarnOnceForTests } from "../../../src/core/warn";
import { akmIndex } from "../../../src/indexer/indexer";
import { readTaskHistory } from "../../../src/tasks/run/task-history";
import { getWorkflowStatus, listWorkflowRuns } from "../../../src/workflows/runtime/runs";
import { runCliCapture } from "../../_helpers/cli";
import { bashValue, ENV_HASH_CASES } from "../../_helpers/env-hash-cases";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";
import { snapshotTree } from "../../_helpers/snapshot-tree";

let storage: IsolatedAkmStorage;
function write(ref: string, content: string, root = storage.stashDir): void {
  const file = path.join(root, ref);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function stable(stdout: string) {
  const result = JSON.parse(stdout);
  delete result.durationMs;
  return result;
}
const workflow = `---
type: workflow
params:
  label: { type: string }
  tags: { type: array, items: { type: string } }
  region: { type: string }
steps:
  - id: first
    unit:
      exec:
        command: ["sh", "-c", "printf first"]
  - id: second
    unit:
      exec:
        command: ["sh", "-c", "printf second"]
---
## first
Execute first.
## second
Execute second.
`;

beforeEach(async () => {
  storage = withIsolatedAkmStorage();
  // Codex takes its prompt on stdin: the stand-in prints its arguments, then what it was given.
  const fakeCodex = path.join(storage.root, "fake-codex");
  fs.writeFileSync(fakeCodex, '#!/bin/sh\nprintf "%s\\n" "$*"\ncat\n', { mode: 0o755 });
  // Fails its first call and answers the second, counting calls in `flaky-calls`.
  const flakyCodex = path.join(storage.root, "flaky-codex");
  const calls = path.join(storage.root, "flaky-calls");
  fs.writeFileSync(
    flakyCodex,
    `#!/bin/sh\necho x >> "${calls}"\ncat > /dev/null\n[ "$(wc -l < "${calls}")" -ge 2 ] || exit 1\necho answered\n`,
    { mode: 0o755 },
  );
  writeSandboxConfig({
    semanticSearchMode: "off",
    defaultBundle: "fixture",
    bundles: { fixture: { path: storage.stashDir, components: { main: { root: ".", adapter: "akm" } } } },
    harnesses: {
      reviewer: { platform: "codex", bin: fakeCodex, args: [] },
      flaky: { platform: "codex", bin: flakyCodex, args: [] },
    },
  });
  write("commands/review.md", "---\ntype: command\nharness: reviewer\n---\nReview: [$ARGUMENTS]\n");
  write("commands/flaky.md", "---\ntype: command\nharness: flaky\n---\nTry: [$ARGUMENTS]\n");
  write("env/e.env", "A=1\n");
  write("agents/reviewer.md", "---\ntype: agent\n---\nCareful reviewer.\n");
  write("knowledge/note.md", "---\ntype: knowledge\n---\nA note.\n");
  write(
    "tasks/check.yml",
    "version: 4\nrun: printf task-ok\nshell: sh\ninputs:\n  label: { type: string, required: true }\n",
  );
  write("workflows/check.md", workflow);
  await akmIndex({ stashDir: storage.stashDir, full: true });
});
afterEach(() => storage.cleanup());

describe("additive akm run", () => {
  test("command arguments and output match the original entry, with no extra asset usage", async () => {
    const flags = ["commands/review", "--arguments", "  --literal=$ARGUMENTS\nline 2  ", "--harness", "reviewer"];
    const legacy = await runCliCapture(["command", ...flags]);
    const before = readEvents({ type: "show" }).events.length;
    const run = await runCliCapture(["run", ...flags]);
    expect(run.code, run.stderr).toBe(0);
    expect(stable(run.stdout)).toEqual(stable(legacy.stdout));
    const after = readEvents({ type: "show" }).events.length;
    expect(after - before).toBe(1);
    expect(JSON.parse(run.stdout).stdout).toContain("  --literal=$ARGUMENTS\nline 2  ");
  });

  test("agent prompt and stdin retain literal input and legacy output", async () => {
    const prompt = "literal $ARGUMENTS {{json}}\nsecond line";
    const flags = ["agents/reviewer", "--prompt", prompt, "--harness", "reviewer"];
    const legacy = await runCliCapture(["agent", ...flags]);
    const run = await runCliCapture(["run", ...flags]);
    expect(run.code, run.stderr).toBe(0);
    expect(stable(run.stdout)).toEqual(stable(legacy.stdout));
    const read = fs.readFileSync;
    const mock = spyOn(fs, "readFileSync").mockImplementation(((file: unknown, ...rest: unknown[]) =>
      file === 0 ? prompt : Reflect.apply(read, fs, [file, ...rest])) as typeof fs.readFileSync);
    try {
      const stdin = await runCliCapture(["run", "agents/reviewer", "--prompt-stdin", "--harness", "reviewer"]);
      expect(stdin.code, stdin.stderr).toBe(0);
      expect(stable(stdin.stdout)).toEqual(stable(run.stdout));
    } finally {
      mock.mockRestore();
    }
  });

  test("dry-run remains read-only and resolves options before the positional ref correctly", async () => {
    const before = snapshotTree(storage.root);
    const run = await runCliCapture(["run", "--arguments", "commands/review", "commands/review", "--dry-run"]);
    const legacy = await runCliCapture(["command", "--arguments", "commands/review", "commands/review", "--dry-run"]);
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual(JSON.parse(legacy.stdout));
    expect(JSON.parse(run.stdout).shape).toBe("command-dry-run");
    expect(snapshotTree(storage.root)).toEqual(before);
  });

  test("command arguments containing config flag text remain literal input", async () => {
    const result = await runCliCapture(["run", "commands/review", "--arguments=--config"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).stdout).toContain("Review: [--config]");
  });

  test("task inputs, scheduled marker, history and qualified bundle ownership are preserved without an index", async () => {
    const other = path.join(storage.root, "other");
    write(
      "tasks/check.yml",
      "version: 4\nrun: printf other-task\nshell: sh\ninputs:\n  label: { type: string, required: true }\n",
      other,
    );
    writeSandboxConfig({
      bundles: {
        fixture: { path: storage.stashDir },
        other: { path: other, components: { main: { root: ".", adapter: "akm" } } },
      },
    });
    const run = await runCliCapture(["run", "other//tasks/check", "--label=001", "--scheduled"]);
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ shape: "task-run", result: { status: "completed" } });
    const history = await runCliCapture(["task", "history", "check", "--bundle", "other"]);
    expect(history.code, history.stderr).toBe(0);
    expect(fs.readFileSync(JSON.parse(history.stdout).rows[0].log, "utf8")).toContain("other-task");
    expect(history.stdout).toContain("check");
    const selected = await runCliCapture(["run", "tasks/check", "--bundle", "other", "--label=002"]);
    expect(selected.code, selected.stderr).toBe(0);
    expect(fs.readFileSync(JSON.parse(selected.stdout).result.log, "utf8")).toContain("other-task");
    const conflict = await runCliCapture(["run", "fixture//tasks/check", "--bundle", "other", "--label=x"]);
    expect(conflict.code).toBe(2);
    expect(conflict.stderr).toContain("conflicts");
    const invalid = await runCliCapture(["run", "other//tasks/check", "--missing=1"]);
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain("missing");
  });

  test("a task found in another bundle runs from that bundle, not from a same-named task in the default one", async () => {
    const other = path.join(storage.root, "other");
    write("tasks/only-there.yml", "version: 4\nrun: printf from-other\nshell: sh\n", other);
    write("tasks/both.yml", "version: 4\nrun: printf from-other\nshell: sh\n", other);
    write("tasks/both.yml", "version: 4\nrun: printf from-fixture\nshell: sh\n");
    writeSandboxConfig({
      bundles: {
        fixture: { path: storage.stashDir },
        other: { path: other, components: { main: { root: ".", adapter: "akm" } } },
      },
    });
    const only = await runCliCapture(["run", "tasks/only-there"]);
    expect(only.code, only.stderr).toBe(0);
    expect(fs.readFileSync(JSON.parse(only.stdout).result.log, "utf8")).toContain("from-other");
    const both = await runCliCapture(["run", "tasks/both"]);
    expect(both.code, both.stderr).toBe(0);
    expect(fs.readFileSync(JSON.parse(both.stdout).result.log, "utf8")).toContain("from-fixture");
    const named = await runCliCapture(["run", "other//tasks/both"]);
    expect(named.code, named.stderr).toBe(0);
    expect(fs.readFileSync(JSON.parse(named.stdout).result.log, "utf8")).toContain("from-other");
  });

  test("workflow parameters, limits, frozen ID continuation and existing lifecycle operations remain available", async () => {
    const run = await runCliCapture([
      "run",
      "workflows/check",
      "--label=001",
      "--tags=one",
      "--tags=two",
      "--region=authored-config",
      "--max-steps",
      "1",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(result).toMatchObject({ shape: "workflow-run", stepsProcessed: 1 });
    const id = result.run.id;
    const changedParams = await runCliCapture(["run", id, "--label=changed"]);
    expect(changedParams.code).toBe(2);
    expect(changedParams.stderr).toContain("existing run id");
    expect((await getWorkflowStatus(id)).run.params).toEqual({
      label: "001",
      tags: ["one", "two"],
      region: "authored-config",
    });
    write("workflows/check.md", "invalid replacement: frozen run must survive");
    const resumed = await runCliCapture(["run", id]);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(JSON.parse(resumed.stdout).run.status).toBe("completed");
    const status = await runCliCapture(["workflow", "status", id]);
    expect(status.code, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).run.status).toBe("completed");
  });

  test("--env and --secret reach a task and a workflow step, and the secret is scrubbed from what akm records", async () => {
    write("env/prod.env", "INJECTED_REGION=eu-west\n");
    write("secrets/deploy", "injected-secret-value\n");
    const printBoth = 'printf "%s %s" "$INJECTED_REGION" "$INJECTED_PLAIN"';
    write("tasks/env.yml", `version: 4\nrun: ${printBoth}\nshell: sh\n`);
    write(
      "workflows/env.md",
      `---\ntype: workflow\nsteps:\n  - id: only\n    unit:\n      exec:\n        command: ${JSON.stringify(["sh", "-c", printBoth])}\n---\n## only\nPrint.\n`,
    );
    const flags = ["--env", "env/prod", "--secret=secrets/deploy:INJECTED_PLAIN"];
    try {
      const task = await runCliCapture(["run", "tasks/env", ...flags]);
      expect(task.code, task.stderr).toBe(0);
      expect(fs.readFileSync(JSON.parse(task.stdout).result.log, "utf8")).toContain("eu-west [REDACTED]");
      expect(readEvents({ type: "secret_access" }).events.at(-1)).toMatchObject({
        ref: "secrets/deploy",
        metadata: { var: "INJECTED_PLAIN" },
      });

      const run = await runCliCapture(["run", "workflows/env", ...flags]);
      expect(run.code, run.stderr).toBe(0);
      const journal = JSON.stringify(await getWorkflowStatus(JSON.parse(run.stdout).run.id));
      expect(journal).toContain("eu-west");
      expect(journal).not.toContain("injected-secret-value");
    } finally {
      delete process.env.INJECTED_REGION;
      delete process.env.INJECTED_PLAIN;
    }
  });

  test("a malformed --secret or a missing env asset stops the run before it starts", async () => {
    for (const flags of [
      ["--secret", "secrets/deploy"],
      ["--env", "env/absent"],
    ]) {
      const result = await runCliCapture(["run", "tasks/check", "--label", "x", ...flags]);
      expect(result.code).not.toBe(0);
      expect(result.stdout).not.toContain("task-ok");
    }
    expect(readTaskHistory({ id: "check" })).toEqual([]);
  });

  test("dispatch follows adapter type rather than a native-looking path prefix", async () => {
    const componentRoot = path.join(storage.root, "standalone");
    write("scripts/deep/nightly.yml", "version: 4\nrun: printf standalone\nshell: sh\n", componentRoot);
    writeSandboxConfig({
      bundles: {
        fixture: { path: storage.stashDir },
        standalone: { path: componentRoot, components: { main: { root: ".", adapter: "akm-task" } } },
      },
    });
    const result = await runCliCapture(["run", "standalone//scripts/deep/nightly"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      shape: "task-run",
      result: { id: "scripts/deep/nightly", status: "completed" },
    });
  });

  test("native task nonzero exits retain the original exit mapping", async () => {
    write("tasks/unavailable.yml", "version: 4\nrun: exit 78\nshell: sh\n");
    const legacy = await runCliCapture(["task", "run", "tasks/unavailable"]);
    const run = await runCliCapture(["run", "tasks/unavailable"]);
    expect(run.code).toBe(78);
    expect(legacy.code).toBe(78);
    expect(JSON.parse(run.stdout)).toMatchObject({
      shape: "task-run",
      ok: false,
      exitCode: 78,
      result: { status: "failed", detail: { exitCode: 78 } },
    });
  });

  for (const flags of [
    ["commands/review", "--prompt", "ignored"],
    ["agents/reviewer", "--arguments", "ignored"],
    ["commands/review", "extra"],
    ["commands/review", "--", "--child-flag"],
    ["commands/review", "--arguments", "x", "--"],
    ["agents/reviewer", "--prompt", "x", "--harness", "reviewer", "--"],
    ["agents/reviewer", "--prompt", "x", "--harness", "reviewer", "--", "extra"],
    ["agents/reviewer", "--prompt", "x", "--prompt-stdin"],
    ["workflows/check", "--new"],
    ["workflows/check", "--", "extra"],
    ["tasks/check", "--", "extra"],
    ["knowledge/note"],
    ["commands/review#section"],
  ]) {
    test(`rejects unsupported inputs without execution: ${flags.join(" ")}`, async () => {
      const result = await runCliCapture(["run", ...flags]);
      expect(result.code, result.stderr).toBe(2);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).ok).toBe(false);
      expect((await listWorkflowRuns()).runs).toHaveLength(0);
    });
  }
});

describe("akm run scripts/<file>", () => {
  let out: string;
  const original = process.env.B5_OUT;
  beforeEach(() => {
    out = path.join(storage.root, "out.txt");
    process.env.B5_OUT = out;
    write("scripts/args.sh", 'for a in "$@"; do printf \'%s\\n\' "$a"; done > "$B5_OUT"\n');
  });
  afterEach(() => {
    if (original === undefined) delete process.env.B5_OUT;
    else process.env.B5_OUT = original;
  });
  const lines = () => fs.readFileSync(out, "utf8").split("\n").slice(0, -1);

  test("everything after the ref reaches the script unchanged, including -x, akm's own flag names and --", async () => {
    const result = await runCliCapture([
      "run",
      "scripts/args.sh",
      "a",
      "-x",
      "--y=1",
      "--timeout",
      "5",
      "--env",
      "e",
      "--",
      "--z",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(lines()).toEqual(["a", "-x", "--y=1", "--timeout", "5", "--env", "e", "--", "--z"]);
  });

  test("a script receives --help, -h, -q, --verbose, --bundle, --format, --config and -- as given", async () => {
    const tail = [
      "--help",
      "-h",
      "-q",
      "--verbose",
      "--bundle",
      "other",
      "--format",
      "json",
      "--config",
      "f",
      "--",
      "x",
    ];
    const result = await runCliCapture(["run", "scripts/args.sh", ...tail]);
    expect(result.code, result.stderr).toBe(0);
    expect(lines()).toEqual(tail);
  });

  test("every flag akm knows reaches the script as given when it comes after the ref", async () => {
    type Definition = { type: string; alias?: string };
    const known: Record<string, Definition> = {
      ...(runAssetCommand.args as Record<string, Definition>),
      ...GLOBAL_OUTPUT_ARGS,
    };
    const tails: string[][] = [["--help"], ["-h"], ["--version"], ["--unknown-flag", "v"]];
    for (const [name, definition] of Object.entries(known)) {
      if (definition.type === "positional") continue;
      const value = definition.type === "boolean" ? [] : ["v"];
      tails.push([`--${name}`, ...value], [`--${name}=v`]);
      if (definition.alias) tails.push([`-${definition.alias}`, ...value]);
    }
    expect(tails).toContainEqual(["--max-retries", "v"]);
    expect(tails).toContainEqual(["--format", "v"]);
    for (const tail of tails) {
      const result = await runCliCapture(["run", "scripts/args.sh", ...tail]);
      expect(result.code, `${tail.join(" ")}: ${result.stderr}`).toBe(0);
      expect(lines(), tail.join(" ")).toEqual(tail);
    }
  });

  test("a script's tail changes nothing akm itself prints: -q after the ref does not hide a warning", async () => {
    writeSandboxConfig({ improve: { stateGc: { collect: true } } }); // a key akm ignores, with a warning
    const stderrOf = async (...tail: string[]) => {
      _resetWarnOnceForTests();
      return (await runCliCapture(["run", "scripts/args.sh", ...tail])).stderr;
    };
    const bare = await stderrOf();
    expect(bare).toContain("Unknown config key");
    expect(await stderrOf("-q", "--verbose", "--help", "-h")).toBe(bare);
    // Before the ref the same flag is akm's.
    _resetWarnOnceForTests();
    expect((await runCliCapture(["run", "-q", "scripts/args.sh"])).stderr).not.toContain("Unknown config key");
  });

  test("a -- right after the ref is the script's argument, like every other token", async () => {
    expect((await runCliCapture(["run", "scripts/args.sh", "--", "x"])).code).toBe(0);
    expect(lines()).toEqual(["--", "x"]);
    expect((await runCliCapture(["run", "scripts/args.sh", "--"])).code).toBe(0);
    expect(lines()).toEqual(["--"]);
  });

  test("a broken config is reported for a script run, whose --help may be the script's own", async () => {
    fs.writeFileSync(path.join(process.env.XDG_CONFIG_HOME as string, "akm", "config.json"), "{ not json");
    const result = await runCliCapture(["run", "scripts/args.sh", "--help"]);
    expect(result.code).toBe(78);
    expect(result.stdout).not.toContain("USAGE");
  });

  test("--help after a ref that matches nothing is akm's", async () => {
    const result = await runCliCapture(["run", "scripts/missing.sh", "--help"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("USAGE");
  });

  test("--bundle after a script ref is the script's, and before it is akm's", async () => {
    const other = path.join(storage.root, "other");
    write("scripts/args.sh", 'printf mine > "$B5_OUT"\n', other);
    writeSandboxConfig({
      bundles: {
        fixture: { path: storage.stashDir, components: { main: { root: ".", adapter: "akm" } } },
        other: { path: other, components: { main: { root: ".", adapter: "akm" } } },
      },
    });
    expect((await runCliCapture(["run", "scripts/args.sh", "--bundle", "other"])).code).toBe(0);
    expect(lines()).toEqual(["--bundle", "other"]);
    expect((await runCliCapture(["run", "--bundle", "other", "scripts/args.sh"])).code).toBe(0);
    expect(fs.readFileSync(out, "utf8")).toBe("mine");
  });

  test("flags before the ref are akm's: --env injects and --cwd is where the script runs", async () => {
    write("env/vars.env", "B5_VAR=injected\n");
    write("scripts/where.sh", 'printf \'%s|%s\' "$B5_VAR" "$(pwd)" > "$B5_OUT"\n');
    const cwd = path.join(storage.root, "made", "nested");
    const result = await runCliCapture(["run", "--env", "env/vars", "--cwd", cwd, "scripts/where.sh"]);
    expect(result.code, result.stderr).toBe(0);
    expect(fs.readFileSync(out, "utf8")).toBe(`injected|${fs.realpathSync(cwd)}`);
  });

  for (const c of ENV_HASH_CASES) {
    test(`--env reads a # in an env value as the file's author wrote it: ${c.name}`, async () => {
      write("env/hash.env", c.text);
      write("scripts/show.sh", `printf '%s' "$${c.key}" > "$B5_OUT"\n`);
      const result = await runCliCapture(["run", "--env", "env/hash", "scripts/show.sh"]);
      expect(result.code, result.stderr).toBe(0);
      expect(fs.readFileSync(out, "utf8")).toBe(c.value);
      if (c.bash) expect(bashValue(c.text, c.key)).toBe(c.value);
    });
  }

  test("--cwd naming a file that exists is refused as not a folder", async () => {
    write("scripts/x.sh", "true\n");
    const file = path.join(storage.root, "afile");
    fs.writeFileSync(file, "x");
    const result = await runCliCapture(["run", "--cwd", file, "scripts/x.sh"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--cwd <path> is not a folder");
    expect(fs.readFileSync(file, "utf8")).toBe("x");
  });

  test("--clean starts without the parent's variables and --inherit keeps the named ones", async () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion in the script
    write("scripts/env.sh", 'printf \'%s|%s\' "${B5_OUT:-gone}" "${B5_KEEP:-gone}" > "$1"\n');
    process.env.B5_KEEP = "kept";
    try {
      expect((await runCliCapture(["run", "--clean", "scripts/env.sh", out])).code).toBe(0);
      expect(fs.readFileSync(out, "utf8")).toBe("gone|gone");
      expect((await runCliCapture(["run", "--inherit", "B5_KEEP", "scripts/env.sh", out])).code).toBe(0);
      expect(fs.readFileSync(out, "utf8")).toBe("gone|kept");
    } finally {
      delete process.env.B5_KEEP;
    }
  });

  test("a script of another bundle runs by its qualified ref", async () => {
    const other = path.join(storage.root, "other");
    write("scripts/hello.sh", 'printf other > "$B5_OUT"\n', other);
    writeSandboxConfig({
      bundles: {
        fixture: { path: storage.stashDir },
        other: { path: other, components: { main: { root: ".", adapter: "akm" } } },
      },
    });
    const result = await runCliCapture(["run", "other//scripts/hello.sh"]);
    expect(result.code, result.stderr).toBe(0);
    expect(fs.readFileSync(out, "utf8")).toBe("other");
  });

  test("a filesystem path is refused and nothing runs", async () => {
    for (const target of [path.join(storage.stashDir, "scripts/args.sh"), "./scripts/args.sh"]) {
      const result = await runCliCapture(["run", target, "a"]);
      expect(result.code).not.toBe(0);
    }
    expect(fs.existsSync(out)).toBe(false);
  });

  test("the script's exit status is akm's", async () => {
    write("scripts/seven.sh", "exit 7\n");
    expect((await runCliCapture(["run", "scripts/seven.sh"])).code).toBe(7);
  });

  test("--timeout stops the script at the limit and the status says so", async () => {
    write("scripts/slow.sh", "exec sleep 30\n");
    const started = Date.now();
    const result = await runCliCapture(["run", "--timeout", "500ms", "scripts/slow.sh"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("timed out after 500ms");
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  test("--max-retries runs a failing script exactly N more times and stops on success", async () => {
    write("scripts/fail.sh", 'echo x >> "$B5_OUT"; exit 3\n');
    const failing = await runCliCapture(["run", "--max-retries", "2", "scripts/fail.sh"]);
    expect(failing.code).toBe(3);
    expect(lines()).toHaveLength(3);
    fs.rmSync(out);
    write("scripts/flaky.sh", 'echo x >> "$B5_OUT"; [ "$(wc -l < "$B5_OUT")" -ge 2 ]\n');
    const flaky = await runCliCapture(["run", "--max-retries", "5", "scripts/flaky.sh"]);
    expect(flaky.code, flaky.stderr).toBe(0);
    expect(lines()).toHaveLength(2);
  });

  test("--max-retries and --cwd also apply to a command run", async () => {
    const cwd = path.join(storage.root, "command", "work");
    const result = await runCliCapture(["run", "commands/review", "--cwd", cwd, "--max-retries", "1"]);
    expect(result.code, result.stderr).toBe(0);
    expect(fs.statSync(cwd).isDirectory()).toBe(true);
  });

  test("--max-retries on a command stops at the first successful attempt", async () => {
    const result = await runCliCapture(["run", "commands/flaky", "--max-retries", "3"]);
    expect(result.code, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(storage.root, "flaky-calls"), "utf8").trim().split("\n")).toHaveLength(2);
  });

  test("a child's failure is akm's exit status even when the host had set 0", async () => {
    process.exitCode = 0;
    const result = await runCliCapture(["env", "run", "env/e", "--", "sh", "-c", "exit 5"]);
    expect(result.code, result.stderr).toBe(5);
  });

  test("a task's flags after the ref are akm's: --format text still renders text", async () => {
    const text = await runCliCapture(["run", "tasks/check", "--label=001", "--format", "text"]);
    expect(text.code, text.stderr).toBe(0);
    expect(() => JSON.parse(text.stdout)).toThrow();
    expect(JSON.parse((await runCliCapture(["run", "tasks/check", "--label=001"])).stdout).shape).toBe("task-run");
  });

  test("a declared value input takes the next token as its value whatever it starts with", async () => {
    write(
      "tasks/who.yml",
      'version: 4\nshell: sh\nrun: printf ok\ninputs:\n  who: { type: string, enum: ["-x"], required: true }\n',
    );
    const seen: string[] = [];
    for (const flags of [["--who", "-x"], ["--who=-x"]]) {
      const result = await runCliCapture(["run", "tasks/who", ...flags]);
      expect(result.code, result.stderr).toBe(0);
      seen.push(JSON.parse(result.stdout).result.status);
    }
    expect(seen).toEqual(["completed", "completed"]);
  });

  test("a task input error points at the task's declared inputs", async () => {
    const result = await runCliCapture(["run", "tasks/check"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr || result.stdout).hint).toContain("akm show tasks/<name>");
  });

  test("a version 4 task keeps its own flag parsing: a required input named timeout is satisfied by --timeout", async () => {
    write(
      "tasks/echo.yml",
      "version: 4\nshell: sh\nrun: printf ok\ninputs:\n  timeout: { type: string, required: true }\n",
    );
    const missing = await runCliCapture(["run", "tasks/echo"]);
    expect(missing.code).not.toBe(0);
    const given = await runCliCapture(["run", "tasks/echo", "--timeout=5s"]);
    expect(given.code, given.stderr).toBe(0);
    expect(JSON.parse(given.stdout)).toMatchObject({ shape: "task-run", result: { status: "completed" } });
  });
});
