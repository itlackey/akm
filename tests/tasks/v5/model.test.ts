// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The design's "Checked before anything runs", as the reference program's check-only tests state it, against akm's
 * real checker (`checkTaskV5`) reading real bundles.
 *
 * Two things differ from the reference because akm already owns the rule:
 *  - a refusal is akm's error code and a phrase of its message (`TASK_SOURCE_INVALID/<rule>` names the phrase), not the
 *    reference's own code;
 *  - a duration is `--timeout`'s: whole numbers only (`2h`, not `1.5h`), and an input's value is converted by the shared
 *    input contract (text for a string input stays text).
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseTaskSource } from "../../../src/tasks/source/parse-task-source";
import { rule, useWorlds, type World, type WorldSpec, world } from "./world";

useWorlds();

const SHAPE = "TASK_SOURCE_INVALID/SHAPE";
const BAD_RUN = "TASK_SOURCE_INVALID/BAD_RUN";
const BAD_OPTION = "TASK_SOURCE_INVALID/BAD_OPTION";
const DUPLICATE_STEP = "TASK_SOURCE_INVALID/DUPLICATE_STEP";
const NAME_CLASH = "TASK_SOURCE_INVALID/NAME_CLASH";
const BAD_ENV_NAME = "TASK_SOURCE_INVALID/BAD_ENV_NAME";
const BAD_REFERENCE = "TASK_SOURCE_INVALID/BAD_REFERENCE";
const UNKNOWN_REFERENCE = "TASK_SOURCE_INVALID/UNKNOWN_REFERENCE";
const SECRET_IN_FILE = "TASK_SOURCE_INVALID/SECRET_IN_FILE";
const VALUE_IN_EXEC = "TASK_SOURCE_INVALID/VALUE_IN_EXEC";
const LOOP = "TASK_SOURCE_INVALID/LOOP";
const MISSING_INPUT = "INPUT_BINDING_INVALID/missing";
const BAD_VALUE = "INPUT_BINDING_INVALID/value";
const UNKNOWN_INPUT = "UNKNOWN_FLAG";
const NO_SUCH_ASSET = "ASSET_NOT_FOUND";
const NO_SUCH_BINDING = "FILE_NOT_FOUND";
const BAD_FLAG = "INVALID_FLAG_VALUE";

/** Declares inputs the short way for these tests: null means required, anything else is the default. */
const inputs = (spec: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(spec).map(([name, value]) => [name, value === null ? { required: true } : { default: value }]),
  );
const odd = (task: object) => task;
/** Checks `tasks/t` in a world that also has `tasks/u`, and says what was refused. */
const lint = (task: object, spec: WorldSpec = {}, check: (w: World) => Promise<unknown> = (w) => w.check("tasks/t")) =>
  rule(check(world({ ...spec, tasks: { "tasks/t": task, "tasks/u": { exec: "true" }, ...spec.tasks } })));

describe("a step is one akm command", () => {
  test("a step is exactly one command, run: takes only a ref, and an option belongs to its command", async () => {
    const spec = {
      assets: { "scripts/x.sh": "true\n", "agents/a": "You review.\n" },
      commands: { "commands/c": "C $ARGUMENTS" },
    };
    const refusal = (task: object) => lint(task, spec);
    // run: is the known path: a ref and nothing else
    expect(await refusal({ run: "bun scripts/x.sh" })).toBe(BAD_RUN);
    expect(await refusal({ run: "wc -l" })).toBe(BAD_RUN);
    expect(await refusal({ run: "/usr/local/bin/tool.sh" })).toBe(BAD_RUN);
    expect(await refusal({ run: "knowledge/notes.md" })).toBe(BAD_RUN);
    expect(await refusal({ run: "workflows/nightly" })).toBe(BAD_RUN);
    // one command
    expect(await refusal({})).toBe(SHAPE);
    expect(await refusal({ run: "scripts/x.sh", exec: "true" })).toBe(SHAPE);
    expect(await refusal({ exec: "true", prompt: "Hi." })).toBe(SHAPE);
    expect(await refusal({ run: "scripts/x.sh", prompt: "Hi." })).toBe(SHAPE);
    expect(await refusal({ run: "agents/a" })).toBe(SHAPE);
    expect(await refusal({ exec: "true", steps: [{ name: "a", exec: "true" }] })).toBe(SHAPE);
    expect(await refusal({ steps: [{ name: "a" }] })).toBe(SHAPE);
    // options
    expect(await refusal({ exec: "true", args: ["x"] })).toBe(BAD_OPTION);
    expect(await refusal({ prompt: "Hi.", args: ["x"] })).toBe(BAD_OPTION);
    expect(await refusal({ run: "commands/c", args: ["x"] })).toBe(BAD_OPTION);
    expect(await refusal({ run: "scripts/x.sh", args: { date: "x" } })).toBe(BAD_OPTION);
    expect(await refusal({ run: "scripts/x.sh", args: ["--date", { when: "x" }] })).toBe(BAD_OPTION);
    expect(await refusal({ exec: "true", arguments: "x" })).toBe(BAD_OPTION);
    // text where text belongs, a list where a list belongs
    expect(await refusal({ run: "commands/c", arguments: ["x"] })).toBe(BAD_OPTION);
    expect(await refusal({ prompt: ["Hi."] })).toBe(BAD_OPTION);
    expect(await refusal({ exec: ["true"] })).toBe(BAD_OPTION);
    expect(await refusal({ run: ["scripts/x.sh"] })).toBe(BAD_OPTION);
    expect(await refusal({ exec: "true", env: { LOG_LEVEL: "info" } })).toBe(BAD_OPTION);
    expect(await refusal({ exec: "true", secret: "secrets/x:TOKEN" })).toBe(BAD_OPTION);
    expect(await refusal({ exec: "true", inherit: "HOME" })).toBe(BAD_OPTION);
    expect(await refusal({ prompt: "Hi.", arguments: "x" })).toBe(BAD_OPTION);
    expect(await refusal({ exec: "true", expect: ["a"] })).toBe(BAD_OPTION);
    expect(await refusal({ exec: "true", secret: ["secrets/x"] })).toBe(BAD_OPTION);
    expect(await refusal({ exec: "true", env: [{ "secrets/x": "TOKEN" }] })).toBe(BAD_ENV_NAME);
    expect(await refusal({ exec: "true", inherit: ["not a name"] })).toBe(BAD_ENV_NAME);
    // and what is allowed
    for (const task of [
      { run: "scripts/x.sh" },
      { run: "commands/c", arguments: "x" },
      { run: "agents/a", prompt: "Hi." },
      { run: "tasks/u" },
      { exec: "true" },
      { prompt: "Hi." },
    ]) {
      expect(await refusal(task)).toBe("no error");
    }
  });

  test("a ref to something that does not exist is refused before anything runs", async () => {
    for (const run of ["scripts/missing.sh", "commands/missing", "tasks/missing", "agents/missing"]) {
      const step = { name: "x", run, ...(run.startsWith("agents") ? { prompt: "Hi." } : {}) };
      expect(await lint({ steps: [{ name: "first", exec: "true" }, step] })).toBe(NO_SUCH_ASSET);
    }
  });

  test("a ref is read from the bundle that holds the task that names it, in this bundle or another", async () => {
    const spec = {
      assets: {
        "scripts/mine.sh": "true\n",
        "team//scripts/theirs.sh": "true\n",
        "team//agents/helper": "You help.\n",
      },
      tasks: {
        "team//tasks/inner": {
          steps: [
            { name: "a", run: "scripts/theirs.sh" },
            { name: "b", run: "agents/helper", prompt: "Hi." },
            { name: "c", run: "tasks/leaf" },
          ],
        },
        "team//tasks/leaf": { exec: "true" },
      },
    };
    expect(
      await lint(
        {
          steps: [
            { name: "a", run: "scripts/mine.sh" },
            { name: "b", run: "team//scripts/theirs.sh" },
            { name: "c", run: "team//tasks/inner" },
          ],
        },
        spec,
      ),
    ).toBe("no error");
    expect(await lint({ steps: [{ name: "a", run: "team//scripts/mine.sh" }] }, spec)).toBe(NO_SUCH_ASSET);
    expect(await lint({ steps: [{ name: "a", run: "scripts/theirs.sh" }] }, spec)).toBe(NO_SUCH_ASSET);
    expect(await lint({ run: "other//scripts/mine.sh" }, spec)).toBe(BAD_FLAG);
  });

  test("a step does not run a version 4 task, and the message names akm migrate apply", async () => {
    const w = world({ tasks: { "tasks/t": { run: "tasks/old" } } });
    fs.writeFileSync(path.join(w.scratch, "stash", "tasks", "old.yml"), "version: 4\nrun: echo hi\nshell: sh\n");
    const failure = await w.check("tasks/t").catch((error: Error & { code?: string }) => error);
    expect((failure as { code?: string }).code).toBe("TASK_SOURCE_INVALID");
    expect((failure as Error).message).toContain("akm migrate apply");
  });
});

describe("inputs", () => {
  test("a required one must be given, an undeclared one is refused, a default applies", async () => {
    const w = world({ tasks: { "tasks/t": { inputs: inputs({ queue: null, limit: 10 }), exec: "true" } } });
    expect(await rule(w.check("tasks/t", {}))).toBe(MISSING_INPUT);
    expect(await rule(w.check("tasks/t", { queue: "a", colour: "red" }))).toBe(UNKNOWN_INPUT);
    expect(await rule(w.check("tasks/t", { queue: "mail" }))).toBe("no error");
  });

  test("an input may not be named like a flag of akm run", async () => {
    for (const name of ["env", "secret", "cwd", "timeout", "resume", "scheduled", "inherit"]) {
      expect(await lint({ exec: "true", inputs: { [name]: { default: "x" } } })).toBe(NAME_CLASH);
    }
    // the other flags have a hyphen, which no input name has
    for (const name of ["skip-if-locked", "max-retries"]) {
      expect(await lint({ exec: "true", inputs: { [name]: { default: "x" } } })).toBe(BAD_OPTION);
    }
    expect(await lint({ exec: "true", inputs: { environment: { default: "x" }, max_retries: { default: 1 } } })).toBe(
      "no error",
    );
  });

  test("a value is converted to its input's type, from the command line or from a calling step's args:; one that cannot be is refused before anything runs", async () => {
    const w = world({
      tasks: {
        "tasks/typed": {
          inputs: {
            n: { type: "number", required: true },
            on: { type: "boolean", default: false },
            s: { type: "string", default: "" },
          },
          exec: "true",
        },
        "tasks/count": { exec: "printf 12" },
        "tasks/literal": {
          steps: [
            { name: "a", exec: "true" },
            { name: "t", run: "tasks/typed", args: ["--n", "7", "--on", "true", "--s", 3] },
          ],
        },
        "tasks/from-step": {
          steps: [
            { name: "c", run: "tasks/count" },
            { name: "t", run: "tasks/typed", args: ["--n", "${c}"] },
          ],
        },
        "tasks/not-a-number": {
          steps: [
            { name: "a", exec: "true" },
            { name: "t", run: "tasks/typed", args: ["--n", "seven"] },
          ],
        },
        "tasks/schemas": {
          inputs: { i: { type: "integer", required: true }, o: { type: "object", default: {} } },
          exec: "true",
        },
      },
    });
    expect(await rule(w.check("tasks/typed", { n: "10", on: "true", s: "x" }))).toBe("no error");
    expect(await rule(w.check("tasks/typed", { n: "2.5", on: "false" }))).toBe("no error");
    expect(await rule(w.check("tasks/typed", { n: 4 }))).toBe("no error");
    expect(await rule(w.check("tasks/typed", { n: 4, s: true }))).toBe(BAD_VALUE);
    for (const values of [{ n: "ten" }, { n: "" }, { n: "1", on: "yes" }, { n: "1", on: "TRUE" }] as Record<
      string,
      string
    >[]) {
      expect(await rule(w.check("tasks/typed", values))).toBe(BAD_VALUE);
    }
    // a declaration is a JSON schema, as today: an integer must be whole; another type takes the value as given
    expect(await rule(w.check("tasks/schemas", { i: "3", o: '{"a":1}' }))).toBe("no error");
    expect(await rule(w.check("tasks/schemas", { i: "2.5" }))).toBe(BAD_VALUE);
    // a calling step's args: give strings and numbers; literals are checked at lint, the rest when the step runs
    expect(await rule(w.check("tasks/literal"))).toBe("no error");
    expect(await rule(w.check("tasks/from-step"))).toBe("no error");
    expect(await rule(w.check("tasks/not-a-number"))).toBe(BAD_VALUE);
  });
});

describe("every ${name} is checked before anything runs", () => {
  const spec: WorldSpec = {
    commands: { "commands/c": "C $ARGUMENTS" },
    assets: { "scripts/x.sh": "true\n" },
    tasks: { "tasks/post": { inputs: inputs({ message: null }), exec: "true" } },
  };
  const steps = (last: object[]) => ({
    inputs: inputs({ date: "x" }),
    steps: [{ name: "summary", exec: "true" }, ...last, { name: "later", exec: "true" }],
  });
  const refusal = (last: object[]) => lint(steps(last), spec);

  test("in args:, a name is an input or an earlier step and a whole item, and a task's args: are --<name> <value> pairs", async () => {
    expect(await refusal([{ name: "p", run: "tasks/post", args: ["--message", "${nothing}"] }])).toBe(
      UNKNOWN_REFERENCE,
    );
    expect(await refusal([{ name: "p", run: "tasks/post", args: ["--message", "${later}"] }])).toBe(UNKNOWN_REFERENCE);
    expect(await refusal([{ name: "p", run: "tasks/post", args: ["--message", "see ${summary}"] }])).toBe(
      BAD_REFERENCE,
    );
    expect(await refusal([{ name: "p", run: "scripts/x.sh", args: ["--date=${date}"] }])).toBe(BAD_REFERENCE);
    expect(await refusal([{ name: "p", run: "scripts/x.sh", args: ["${nothing}"] }])).toBe(UNKNOWN_REFERENCE);
    expect(await refusal([{ name: "p", run: "tasks/post", args: [] }])).toBe(MISSING_INPUT);
    expect(await refusal([{ name: "p", run: "tasks/post" }])).toBe(MISSING_INPUT);
    expect(await refusal([{ name: "p", run: "tasks/post", args: ["--message", "hi", "--colour", "red"] }])).toBe(
      UNKNOWN_INPUT,
    );
    // an undeclared input is refused even when its value is only known when the step runs
    expect(await refusal([{ name: "p", run: "tasks/post", args: ["--message", "hi", "--colour", "${summary}"] }])).toBe(
      UNKNOWN_INPUT,
    );
    expect(await refusal([{ name: "p", run: "tasks/post", args: ["hi"] }])).toBe(BAD_OPTION);
    expect(await refusal([{ name: "p", run: "tasks/post", args: ["--message"] }])).toBe(BAD_OPTION);
    expect(await refusal([{ name: "p", run: "tasks/post", args: ["--message", "hi", "more"] }])).toBe(BAD_OPTION);
    expect(await refusal([{ name: "p", run: "tasks/post", args: ["${summary}", "hi"] }])).toBe(BAD_OPTION);
  });

  test("in prompt: and arguments: a name is an input or an earlier step; in an exec: command or an env: value never", async () => {
    expect(await refusal([{ name: "a", prompt: "Use ${later}" }])).toBe(UNKNOWN_REFERENCE);
    expect(await refusal([{ name: "a", prompt: "Your home is ${HOME}" }])).toBe(UNKNOWN_REFERENCE);
    expect(await refusal([{ name: "a", run: "commands/c", arguments: "${nothing}" }])).toBe(UNKNOWN_REFERENCE);
    expect(await refusal([{ name: "a", exec: 'bun x.ts --date "${date}"' }])).toBe(VALUE_IN_EXEC);
    expect(await refusal([{ name: "a", exec: 'echo "${later}"' }])).toBe(VALUE_IN_EXEC);
    expect(await refusal([{ name: "a", exec: "true", env: [{ WHEN: "${date}" }] }])).toBe(BAD_REFERENCE);
  });

  test("an exec: command keeps the shell's own ${…}, and a name used where it is allowed is accepted", async () => {
    expect(await refusal([{ name: "a", exec: 'printf "%s" "${HOME:+home-is-set}"' }])).toBe("no error");
    expect(
      await refusal([
        { name: "a", prompt: "Use ${summary} on ${date}" },
        { name: "p", run: "tasks/post", args: ["--message", "${a}"] },
        { name: "s", run: "scripts/x.sh", args: ["${a}", "--date", "${date}"] },
      ]),
    ).toBe("no error");
  });

  test("two steps the same, or a step named like an input, are refused", async () => {
    expect(
      await lint({
        steps: [
          { name: "a", exec: "true" },
          { name: "a", exec: "true" },
        ],
      }),
    ).toBe(DUPLICATE_STEP);
    expect(await lint({ inputs: inputs({ report: "x" }), steps: [{ name: "report", exec: "true" }] })).toBe(NAME_CLASH);
  });
});

describe("tasks that run each other", () => {
  test("a loop, directly or through other tasks, is refused before anything runs", async () => {
    const w = world({
      tasks: {
        "tasks/self": {
          steps: [
            { name: "a", exec: "true" },
            { name: "again", run: "tasks/self" },
          ],
        },
        "tasks/a": {
          steps: [
            { name: "a", exec: "true" },
            { name: "b", run: "tasks/b" },
          ],
        },
        "tasks/b": {
          steps: [
            { name: "b", exec: "true" },
            { name: "c", run: "tasks/c" },
          ],
        },
        "tasks/c": { run: "tasks/a" },
      },
    });
    for (const ref of ["tasks/self", "tasks/a", "tasks/b", "tasks/c"]) expect(await rule(w.check(ref))).toBe(LOOP);
  });
});

describe("secrets, env and what they name", () => {
  test("a task file names a secret only by its ref, in secret:", async () => {
    const post = { tasks: { "tasks/mail": { inputs: inputs({ to: null, key: "none" }), exec: "true" } } };
    expect(await lint({ exec: "true", env: [{ TOKEN: "${secrets/mail-key}" }] })).toBe(SECRET_IN_FILE);
    expect(await lint({ prompt: "Use ${secrets/mail-key}" })).toBe(SECRET_IN_FILE);
    expect(await lint({ exec: 'curl -H "${secrets/mail-key}"' })).toBe(SECRET_IN_FILE);
    expect(await lint({ run: "tasks/mail", args: ["--to", "ops", "--key", "${secrets/mail-key}"] }, post)).toBe(
      SECRET_IN_FILE,
    );
    expect(
      await lint({ run: "scripts/x.sh", args: ["${secrets/mail-key}"] }, { assets: { "scripts/x.sh": "true\n" } }),
    ).toBe(SECRET_IN_FILE);
  });

  test("an env: or secret: names what exists, written as the flags are", async () => {
    const known = {
      secrets: { "secrets/mail-key": "x", "team//secrets/mail-key": "y" },
      envAssets: { "env/mail": { REGION: "eu" } },
    };
    expect(await lint({ exec: "true", secret: ["secrets/mail-key:MAIL_KEY"] }, known)).toBe("no error");
    expect(await lint({ exec: "true", secret: ["team//secrets/mail-key:MAIL_KEY"], env: ["env/mail"] }, known)).toBe(
      "no error",
    );
    expect(await lint({ exec: "true", secret: ["secrets/mail-key:not a name"] }, known)).toBe(BAD_OPTION);
    expect(await lint({ exec: "true", secret: ["secrets/missing:MAIL_KEY"] }, known)).toBe(NO_SUCH_ASSET);
    expect(await lint({ exec: "true", env: ["env/missing"] }, known)).toBe(NO_SUCH_ASSET);
    expect(await lint({ exec: "true", env: ["AWS_PROFILE=work"] }, known)).toBe(BAD_FLAG);
    expect(await lint({ steps: [{ name: "a", exec: "true", env: ["env/missing"] }] }, known)).toBe(NO_SUCH_ASSET);
  });

  test("a secret named under env: is refused, and told where it goes", async () => {
    const w = world({
      secrets: { "secrets/token": "v" },
      tasks: { "tasks/t": { exec: "true", env: ["secrets/token:TOKEN"] } },
    });
    const failure = await w.check("tasks/t").catch((error: Error & { code?: string }) => error);
    expect((failure as { code?: string }).code).toBe("TASK_SOURCE_INVALID");
    expect((failure as Error).message).toContain("a secret goes under secret:");
  });

  test("a --env or --secret that names nothing, a malformed --secret, or an env asset binding a missing secret is refused before anything runs", async () => {
    const w = world({
      envAssets: { "env/bad": { TOKEN: "${secrets/missing}" }, "env/ok": { REGION: "x" } },
      secrets: { "secrets/x": "v" },
      tasks: { "tasks/t": { steps: [{ name: "a", exec: "true" }] }, "tasks/bound": { env: ["env/bad"], exec: "true" } },
    });
    expect(await rule(w.check("tasks/t", {}, { env: ["env/missing"] }))).toBe(NO_SUCH_ASSET);
    expect(await rule(w.check("tasks/t", {}, { env: ["env/bad"] }))).toBe(NO_SUCH_BINDING);
    expect(await rule(w.check("tasks/t", {}, { secret: ["secrets/missing:TOKEN"] }))).toBe(NO_SUCH_ASSET);
    expect(await rule(w.check("tasks/t", {}, { secret: ["secrets/x"] }))).toBe(BAD_FLAG);
    expect(await rule(w.check("tasks/t", {}, { secret: ["secrets/x:not a name"] }))).toBe(BAD_FLAG);
    expect(await rule(w.check("tasks/t", {}, { inherit: ["not a name"] }))).toBe(BAD_FLAG);
    expect(await rule(w.check("tasks/t", {}, { timeout: "soon" }))).toBe(BAD_FLAG);
    expect(await rule(w.check("tasks/t", {}, { maxRetries: -1 }))).toBe(BAD_FLAG);
    expect(await rule(w.check("tasks/bound"))).toBe(NO_SUCH_BINDING);
    expect(
      await rule(
        w.check(
          "tasks/t",
          {},
          { env: ["env/ok"], secret: ["secrets/x:TOKEN"], inherit: ["HOME"], timeout: "90s", maxRetries: 2 },
        ),
      ),
    ).toBe("no error");
  });
});

describe("options", () => {
  test("cwd: takes no state entry, on the task or on a step", async () => {
    const steps = [{ name: "a", exec: "true" }];
    expect(await lint({ inputs: inputs({ out_root: "/tmp" }), cwd: "${out_root}", steps })).toBe(BAD_REFERENCE);
    expect(await lint({ steps: [...steps, { name: "b", exec: "true", cwd: "work/${a}" }] })).toBe(BAD_REFERENCE);
    expect(await lint({ cwd: "work", steps })).toBe("no error");
  });

  test("checking a task makes no folder that cwd: names", async () => {
    const made = path.join(os.tmpdir(), `akm-v5-never-made-${process.pid}`);
    const w = world({ tasks: { "tasks/t": { cwd: path.join(made, "by-check"), exec: "pwd" } } });
    await w.check("tasks/t");
    expect(fs.existsSync(made)).toBe(false);
  });

  test("a timeout: that is no duration, or a max-retries: that is no count, is refused before anything runs", async () => {
    expect(await lint({ exec: "true", timeout: "soon" })).toBe(BAD_OPTION);
    expect(await lint({ steps: [{ name: "a", exec: "true", timeout: 0 }] })).toBe(BAD_OPTION);
    expect(await lint({ steps: [{ name: "a", exec: "true", "max-retries": -1 }] })).toBe(BAD_OPTION);
    expect(await lint({ exec: "true", "max-retries": 1.5 })).toBe(BAD_OPTION);
    expect(await lint({ exec: "true", "max-retries": "2" })).toBe(BAD_OPTION);
    expect(
      await lint({
        timeout: "90s",
        "max-retries": 2,
        steps: [
          { name: "a", exec: "true", timeout: 30000, "max-retries": 0 },
          { name: "b", run: "tasks/u", timeout: "2h" },
        ],
      }),
    ).toBe("no error");
  });

  test("a step of a task with steps: needs a name of letters, digits, _ and -", async () => {
    expect(await lint({ steps: [{ exec: "true" }] })).toBe(BAD_OPTION);
    expect(await lint({ steps: [{ name: "", exec: "true" }] })).toBe(BAD_OPTION);
    expect(await lint({ steps: [{ name: "a b", exec: "true" }] })).toBe(BAD_OPTION);
    expect(await lint({ steps: [{ name: "a.b", exec: "true" }] })).toBe(BAD_OPTION);
    expect(await lint({ steps: [{ name: 5, exec: "true" }] })).toBe(BAD_OPTION);
    expect(
      await lint({
        steps: [
          { name: "ok", exec: "true" },
          { name: "Step_2-b", exec: "true" },
        ],
      }),
    ).toBe("no error");
    expect(await lint({ exec: "true" })).toBe("no error"); // one command, no steps:, needs none
  });

  test("a key of the wrong shape is refused, never a crash or a misreading", async () => {
    const bad = async (task: object) => expect(await lint(odd(task))).toBe(BAD_OPTION);
    await bad({ exec: "true", cwd: ["a"] });
    await bad({ cwd: ["a"], steps: [{ name: "a", exec: "true" }] });
    await bad({ steps: [{ name: "a", exec: "true", cwd: ["a"] }] });
    await bad({ prompt: "Hi.", expect: "status" });
    await bad({ prompt: "Hi.", expect: { status: 1 } });
    await bad({ steps: [{ name: "a", prompt: "Hi.", expect: "status" }] });
    await bad({ exec: "true", lock: "no" });
    await bad({ exec: "true", lock: 1 });
    await bad({ steps: [] });
    await bad({ steps: "a" });
    await bad({ steps: { a: { exec: "true" } } });
    await bad({ steps: ["true"] });
    await bad({ steps: [null] });
    await bad({ exec: "true", inputs: ["a"] });
    await bad({ exec: "true", inputs: [] });
    await bad({ exec: "true", inputs: "" });
    await bad({ exec: "true", inputs: "a" });
    await bad({ exec: "true", inputs: { a: null } });
    await bad({ exec: "true", inputs: { a: "x" } });
    await bad({ exec: "true", inputs: { a: { required: "no" } } });
    await bad({ exec: "true", env: [["A"]] });
    await bad({ exec: "true", env: [{ A: ["x"] }] });
    await bad({ prompt: "Hi.", model: ["m"] });
    expect(
      await lint({ exec: "true", lock: false, inputs: { a: { type: "number", required: true } }, cwd: "/work" }),
    ).toBe(MISSING_INPUT);
  });

  test("a key a command does not take, or a task does not take at the top, is warned about once and ignored", async () => {
    const w = world({
      tasks: {
        "tasks/t": odd({
          colour: "red",
          harness: "default",
          args: ["x"],
          steps: [
            { name: "a", exec: "printf one", flavour: "x", harness: "h", model: "m" },
            { name: "b", prompt: "Hi.", harness: "h", connection: "c", model: "m" },
            { name: "c", run: "tasks/one", model: "m" },
          ],
        }),
        "tasks/one": odd({ exec: "printf two", sparkle: true }),
        "tasks/agent": odd({ prompt: "Hi.", model: "m", sparkle: true }),
        "tasks/plain": odd({ exec: "true", model: "m" }),
        "tasks/v": odd({ schedule: "0 6 * * *", exec: "true" }),
      },
    });
    await w.check("tasks/t");
    await w.check("tasks/t");
    const text = w.warnings.join("\n");
    expect(w.warnings.filter((warning) => warning.includes(": colour:")).length).toBe(1);
    for (const key of ["colour", "args", "flavour", "a: harness", "a: model", "c: model", "tasks/one.yml: sparkle"])
      expect(text).toContain(key);
    for (const fine of ["t.yml: harness", "b: harness", "b: connection", "b: model", "t.yml: steps"])
      expect(text).not.toContain(fine);
    expect(w.warnings.length).toBe(7);
    // the same keys are warned about for a task that is one command, and none is refused
    await w.check("tasks/agent");
    expect(w.warnings.filter((warning) => warning.includes("tasks/agent")).length).toBe(1);
    await w.check("tasks/plain");
    expect(w.warnings.filter((warning) => warning.includes("tasks/plain.yml: model:")).length).toBe(1);
    // `version:` and `schedule:` are keys of a task file
    const before = w.warnings.length;
    await w.check("tasks/v");
    expect(w.warnings.length).toBe(before);
  });
});

describe("schedule entries", () => {
  test("an entry may have env:, secret: and timeout:, which are written as the flags are", async () => {
    const known = { secrets: { "secrets/x": "v" }, envAssets: { "env/ok": { REGION: "eu" } } };
    const entry = (extra: object) => ({ exec: "true", schedule: [{ cron: "0 6 * * *", ...extra }] });
    expect(await lint(entry({ env: ["env/ok"], secret: ["secrets/x:TOKEN"], timeout: "10m" }), known)).toBe("no error");
    expect(await lint(entry({ env: "env/ok" }), known)).toBe(BAD_OPTION);
    expect(await lint(entry({ env: [{ LOG_LEVEL: "info" }] }), known)).toBe(BAD_OPTION);
    expect(await lint(entry({ secret: ["secrets/x"] }), known)).toBe(BAD_OPTION);
    expect(await lint(entry({ timeout: "soon" }), known)).toBe(BAD_OPTION);
    expect(await lint(entry({ colour: "red" }), known)).toBe(BAD_OPTION);
  });
});

describe("version routing", () => {
  const parse =
    (version: string, command = 'exec: "true"') =>
    () =>
      parseTaskSource({ yaml: `version: ${version}\n${command}\n`, filePath: "/bundle/tasks/t.yml" });

  test("version: 5-beta.1, a YAML string, is read as version 5; this build's beta is the only one it reads", () => {
    expect(parse("5-beta.1")().version).toBe("5-beta");
    expect(parse("4", 'run: "true"')().version).toBe(4);
    for (const other of ["5-beta.2", "5-beta.0"]) {
      expect(parse(other)).toThrow(/this build reads only 5-beta\.1/);
      try {
        parse(other)();
      } catch (error) {
        expect((error as { code?: string }).code).toBe("TASK_SCHEMA_VERSION_UNSUPPORTED");
      }
    }
  });

  test("a version that is not a number and not a 5-beta.<n> keeps today's reading", () => {
    for (const version of ['"5"', "5-beta", "5-beta.x"]) {
      expect(parse(version, 'run: "true"')).toThrow(/task source v4/);
    }
  });
});
