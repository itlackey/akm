// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The design's rules for running a task, as the reference program's tests state them, against akm's real runner
 * (`runTask`) running real processes in a real bundle. An agent is a function standing in for the agent program.
 *
 * What differs from the reference, because akm already owns the rule:
 *  - the clean list is `--clean`'s, which keeps `PWD`, and the marker for a removed secret is `[REDACTED]`;
 *  - an input is given as the command line gives it: text, converted by the shared input contract;
 *  - `expect:` is akm's own, which asks an agent whose reply fails the check once more, so a step that retries does so
 *    after both asks;
 *  - a refusal is akm's error code and a phrase of its message (`rule`, in `./world.ts`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bashValue, ENV_HASH_CASES } from "../../../_helpers/env-hash-cases";
import { rule, useWorlds, world } from "./world";

useWorlds();

let scratch: string;
beforeEach(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "akm-v5-run-")));
});
afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

const SHOW_STATE = 'cat "$AKM_TASK_STATE"';
const at = (name: string) => path.join(scratch, name);
const count = (name: string) => `echo x >> "${at(name)}"`;
const fixedOrFail = (then: string) => `test -f "${at("fixed")}" && ${then}`;
const ran = (name: string) =>
  fs.existsSync(at(name)) ? fs.readFileSync(at(name), "utf8").trim().split("\n").length : 0;
const fix = () => fs.writeFileSync(at("fixed"), "");
/** Declares inputs the short way for these tests: null means required, anything else is the default. */
const inputs = (spec: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(spec).map(([name, value]) => [name, value === null ? { required: true } : { default: value }]),
  );
const message = (attempt: Promise<unknown>) =>
  attempt.then(
    () => "no error",
    (error: Error) => error.message,
  );
const json = (text: unknown) => JSON.parse(String(text));

const RUN_FAILED = "RUN_FAILED";
const LOCKED = "LOCKED";
const NOTHING_TO_RESUME = "INVALID_FLAG_VALUE";
const MISSING_INPUT = "INPUT_BINDING_INVALID/missing";
const BAD_VALUE = "INPUT_BINDING_INVALID/value";
const UNKNOWN_INPUT = "UNKNOWN_FLAG";
const LOOP = "TASK_SOURCE_INVALID/LOOP";

describe("a step is one akm command", () => {
  test("run: a script by its ref, with the interpreter its extension names, in this bundle or another", async () => {
    const w = world({
      assets: {
        "scripts/show.sh": 'printf "home:"; cat "$AKM_TASK_STATE"\n',
        "team//scripts/show.sh": "printf team\n",
      },
      tasks: {
        "tasks/one": { inputs: inputs({ date: "today" }), run: "scripts/show.sh" },
        "tasks/steps": {
          steps: [
            { name: "mine", run: "scripts/show.sh" },
            { name: "theirs", run: "team//scripts/show.sh" },
            { name: "look", exec: SHOW_STATE },
          ],
        },
      },
    });
    expect(await w.start("tasks/one")).toBe('home:{\n  "date": "today"\n}');
    const state = json(await w.start("tasks/steps"));
    expect([state.mine, state.theirs]).toEqual(["home:{}", "team"]);
  });

  test("run: a script is run in place: it finds the files beside it", async () => {
    const w = world({
      assets: {
        "scripts/uses-sibling.sh": '. "$(dirname "$0")/sibling.sh"; printf "%s" "$FROM_SIBLING"\n',
        "scripts/sibling.sh": "FROM_SIBLING=found\n",
      },
      tasks: { "tasks/t": { run: "scripts/uses-sibling.sh" } },
    });
    expect(await w.start("tasks/t")).toBe("found");
  });

  test("run: a prompt asset, given arguments: where it says $ARGUMENTS; nothing else in the asset is touched", async () => {
    const prompts: string[] = [];
    const w = world({
      commands: { "commands/review": "Review this for ${reviewer}:\n$ARGUMENTS\nEnd." },
      tasks: {
        "tasks/t": {
          steps: [
            { name: "diff", exec: "printf the-diff" },
            { name: "review", run: "commands/review", arguments: "Diff: ${diff}" },
            { name: "bare", run: "commands/review" },
          ],
        },
      },
      agent: ({ prompt }) => (prompts.push(prompt), "ok"),
    });
    await w.start("tasks/t");
    expect(prompts.map((prompt) => prompt.trim())).toEqual([
      "Review this for ${reviewer}:\nDiff: the-diff\nEnd.",
      "Review this for ${reviewer}:\n\nEnd.",
    ]);
  });

  test("prompt: text written in the task; beside run: <agent ref> it is that agent's prompt", async () => {
    const prompts: string[] = [];
    const w = world({
      assets: { "agents/reviewer": "You review." },
      tasks: {
        "tasks/t": {
          inputs: inputs({ date: "today", settings: { loud: true } }),
          steps: [
            { name: "fetch", exec: "printf status-ok" },
            { name: "plan", prompt: "Plan for ${date}:\n${fetch}\nSettings: ${settings}" },
            { name: "review", run: "agents/reviewer", prompt: "Review ${plan}" },
          ],
        },
        "tasks/one": { prompt: "Say hello." },
      },
      agent: ({ prompt }) => (prompts.push(prompt), "the-reply"),
    });
    await w.start("tasks/t");
    expect(await w.start("tasks/one")).toBe("the-reply");
    expect(prompts[0]).toBe('Plan for today:\nstatus-ok\nSettings: {"loud":true}');
    expect(prompts[1]).toContain("Review the-reply");
    expect(prompts[2]).toBe("Say hello.");
  });

  test("a task's exec: and prompt: steps run with experimental.exec unset", async () => {
    const w = world({
      tasks: {
        "tasks/t": {
          steps: [
            { name: "a", exec: "printf one" },
            { name: "b", prompt: "Hi." },
          ],
        },
      },
      agent: () => "two",
    });
    expect(await w.start("tasks/t")).toBe("two");
  });

  test("exec: any shell line, run as written; ${…} that is not a state entry is the shell's", async () => {
    const w = world({ tasks: { "tasks/t": { exec: 'printf "%s" "${HOME:+home-is-set}" | tr a-z A-Z' } } });
    expect(await w.start("tasks/t")).toBe("HOME-IS-SET");
  });

  test("a step that runs a version 4 task is refused before anything runs, naming akm migrate apply", async () => {
    const w = world({
      tasks: {
        "tasks/t": {
          steps: [
            { name: "first", exec: count("first") },
            { name: "old", run: "tasks/old" },
          ],
        },
      },
    });
    fs.writeFileSync(path.join(w.scratch, "stash", "tasks", "old.yml"), "version: 4\nrun: echo hi\n");
    expect(await message(w.start("tasks/t"))).toContain("akm migrate apply");
    expect(ran("first")).toBe(0);
  });
});

describe("a run has one state", () => {
  test("it starts as the inputs, and each step's result is added under its name", async () => {
    const w = world({
      tasks: {
        "tasks/plan": {
          inputs: inputs({ date: null, out_root: "/stash/inbox/plan" }),
          steps: [
            { name: "fetch", exec: "printf status-ok" },
            { name: "look", exec: SHOW_STATE },
          ],
        },
      },
    });
    expect(json(await w.start("tasks/plan", { date: "2026-11-19" }))).toEqual({
      date: "2026-11-19",
      out_root: "/stash/inbox/plan",
      fetch: "status-ok",
    });
  });

  test("inputs: a required one must be given, an undeclared one is refused, a default applies", async () => {
    const w = world({
      tasks: { "tasks/t": { inputs: inputs({ queue: null, limit: 10 }), exec: `${count("t")}; ${SHOW_STATE}` } },
    });
    expect(await rule(w.start("tasks/t", {}))).toBe(MISSING_INPUT);
    expect(await rule(w.start("tasks/t", { queue: "a", colour: "red" }))).toBe(UNKNOWN_INPUT);
    expect(ran("t")).toBe(0);
    expect(json(await w.start("tasks/t", { queue: "mail" }))).toEqual({ queue: "mail", limit: 10 });
  });

  test("a caller of runTask that gives its inputs as flags keeps them, a list input repeating its flag", async () => {
    const w = world({
      tasks: {
        "tasks/t": {
          inputs: { who: { type: "string", required: true }, tags: { type: "array", items: { type: "string" } } },
          exec: SHOW_STATE,
        },
      },
    });
    const state = json(
      await w.startWithInputFlags("tasks/t", [
        { name: "who", value: "me" },
        { name: "tags", value: "a" },
        { name: "tags", value: "b" },
      ]),
    );
    expect(state).toEqual({ who: "me", tags: ["a", "b"] });
  });

  test("the state file is a copy with no size limit, gone when the step ends", async () => {
    const w = world({
      tasks: {
        "tasks/t": {
          inputs: inputs({ date: "today" }),
          steps: [
            {
              name: "tamper",
              exec: `echo '{"date":"changed"}' > "$AKM_TASK_STATE"; printf '%s' "$AKM_TASK_STATE" > "${at("state-path")}"`,
            },
            { name: "big", exec: "head -c 3000000 /dev/zero | tr '\\0' 'a'; echo noise >&2" },
            {
              name: "size",
              exec: 'printf "%s " "$(wc -c < "$AKM_TASK_STATE")"; grep -c changed "$AKM_TASK_STATE"; true',
            },
          ],
        },
      },
    });
    const result = (await w.start("tasks/t")) as string;
    const [bytes, changed] = result.trim().split(/\s+/).map(Number);
    expect(bytes).toBeGreaterThan(3_000_000);
    expect(changed).toBe(0);
    const tampered = fs.readFileSync(at("state-path"), "utf8");
    expect([fs.existsSync(tampered), fs.existsSync(path.dirname(tampered))]).toEqual([false, false]);
  });

  test("standard error is not a result", async () => {
    const w = world({ tasks: { "tasks/t": { exec: "printf out; echo noise >&2" } } });
    expect(await w.start("tasks/t")).toBe("out");
  });

  test("${name} is filled in once: text a value brings in is not scanned again", async () => {
    let prompt = "";
    const w = world({
      tasks: {
        "tasks/t": {
          inputs: inputs({ date: "today" }),
          steps: [
            { name: "fetch", exec: "printf '$%s' '{date}'" },
            { name: "plan", prompt: "Got: ${fetch}" },
          ],
        },
      },
      agent: (input) => {
        prompt = input.prompt;
        return "ok";
      },
    });
    await w.start("tasks/t");
    expect(prompt).toBe("Got: ${date}");
  });

  test("an agent that gives no reply has failed; expect: finds the object in a reply with prose around it", async () => {
    const reply = 'Here is the plan.\n```json\n{"status":"red","markdown":"# Plan {draft}"}\n```\nDone.';
    const agent = (answer: string) =>
      world({
        tasks: { "tasks/t": { prompt: "Plan.", expect: ["status", "markdown"] }, "tasks/free": { prompt: "Say hi." } },
        agent: () => answer,
      });
    expect(await agent(reply).start("tasks/t")).toEqual({ status: "red", markdown: "# Plan {draft}" });
    expect(await rule(agent('{"status":"red"}').start("tasks/t"))).toBe(RUN_FAILED);
    expect(await rule(agent("No object here.").start("tasks/t"))).toBe(RUN_FAILED);
    expect(await rule(agent("").start("tasks/free"))).toBe(RUN_FAILED);
    expect(await rule(agent("  \n").start("tasks/free"))).toBe(RUN_FAILED);
  });

  test("expect: asks an agent whose reply fails the check once more, with what failed", async () => {
    const prompts: string[] = [];
    const replies = ["no object here", '{"title":"x"}'];
    const w = world({
      tasks: { "tasks/t": { prompt: "Write.", expect: ["title"] } },
      agent: ({ prompt }) => (prompts.push(prompt), replies.shift() as string),
    });
    expect(await w.start("tasks/t")).toEqual({ title: "x" });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Write.");
    expect(prompts[1]).toContain("failed the check");
    const { readTaskHistory } = await import("../../../../src/tasks/run/task-history");
    const [row] = readTaskHistory({ id: "t", limit: 1 });
    const agent = row?.steps?.[0]?.agent;
    expect(agent?.engine).toEqual(expect.any(String));
    expect(agent).not.toHaveProperty("reason");
  });

  test("expect: an agent whose two replies both fail the check has its agent fact recorded", async () => {
    const w = world({
      tasks: { "tasks/t": { prompt: "Write.", expect: ["title"] } },
      agent: () => "no object here",
    });
    expect(await rule(w.start("tasks/t"))).toBe(RUN_FAILED);
    const { readTaskHistory } = await import("../../../../src/tasks/run/task-history");
    const [row] = readTaskHistory({ id: "t", limit: 1 });
    expect(row?.steps?.[0]?.agent?.engine).toEqual(expect.any(String));
  });

  test("args: on a script are its arguments: each item is one argument as written, with no shell, and a ${name} item is that state entry", async () => {
    const w = world({
      assets: { "scripts/show.sh": 'for arg in "$@"; do printf "[%s]" "$arg"; done\n' },
      tasks: {
        "tasks/one": { run: "scripts/show.sh", args: ["poll", "--config", "a b.json", "--pretty", 3] },
        "tasks/steps": {
          inputs: inputs({ date: "today", settings: { loud: true } }),
          steps: [
            { name: "risky", exec: `printf '%s' '--x; echo x >> "${at("ran")}" $(echo x >> "${at("ran")}")'` },
            { name: "show", run: "scripts/show.sh", args: ["--date", "${date}", "${settings}", "${risky}", "$HOME"] },
          ],
        },
      },
    });
    expect(await w.start("tasks/one")).toBe("[poll][--config][a b.json][--pretty][3]");
    expect(await w.start("tasks/steps")).toBe(
      `[--date][today][{"loud":true}][--x; echo x >> "${at("ran")}" $(echo x >> "${at("ran")}")][$HOME]`,
    );
    expect(ran("ran")).toBe(0);
  });

  test("a step runs another task: args: are its input flags, and its result comes back under the step's name", async () => {
    const w = world({
      tasks: {
        "tasks/post": { inputs: inputs({ message: null, channel: "general" }), exec: SHOW_STATE },
        "tasks/daily": {
          inputs: inputs({ settings: { loud: true } }),
          steps: [
            { name: "summary", exec: "printf the-summary" },
            { name: "post_summary", run: "tasks/post", args: ["--message", "${summary}"] },
            { name: "post_line", run: "tasks/post", args: ["--message", "line-one", "--channel", "ops"] },
            { name: "post_settings", run: "tasks/post", args: ["--message", "${settings}"] },
            { name: "look", exec: SHOW_STATE },
          ],
        },
        "tasks/wrap": { run: "tasks/post", args: ["--message", "fixed"] },
      },
    });
    const state = json(await w.start("tasks/daily"));
    expect(json(state.post_summary)).toEqual({ message: "the-summary", channel: "general" });
    expect(json(state.post_line)).toEqual({ message: "line-one", channel: "ops" });
    expect(json(state.post_settings).message).toEqual({ loud: true });
    expect(json(await w.start("tasks/wrap")).message).toBe("fixed");
  });

  test("a task's result is its last step's, also when the last step runs a task with steps", async () => {
    const w = world({
      tasks: {
        "tasks/make-summary": {
          steps: [
            { name: "gather", exec: "printf numbers" },
            { name: "summarise", exec: "printf the-summary" },
          ],
        },
        "tasks/weekly": {
          steps: [
            { name: "report", run: "tasks/make-summary" },
            { name: "notify", exec: "printf notified" },
          ],
        },
        "tasks/archive": { steps: [{ name: "report", run: "tasks/make-summary" }] },
      },
    });
    expect(await w.start("tasks/weekly")).toBe("notified");
    expect(await w.start("tasks/archive")).toBe("the-summary");
  });

  test("tasks that run each other in a loop are refused before anything runs", async () => {
    const w = world({
      tasks: {
        "tasks/self": {
          steps: [
            { name: "a", exec: count("self") },
            { name: "again", run: "tasks/self" },
          ],
        },
        "tasks/a": {
          steps: [
            { name: "a", exec: count("a") },
            { name: "b", run: "tasks/b" },
          ],
        },
        "tasks/b": {
          steps: [
            { name: "b", exec: count("b") },
            { name: "c", run: "tasks/c" },
          ],
        },
        "tasks/c": { run: "tasks/a" },
      },
    });
    expect(await rule(w.start("tasks/self"))).toBe(LOOP);
    expect(await rule(w.start("tasks/a"))).toBe(LOOP);
    expect(ran("self") + ran("a") + ran("b")).toBe(0);
  });
});

describe("a clean environment", () => {
  const host = {
    ...process.env,
    CUSTOM_PROFILE: "work",
    GITHUB_TOKEN: "canary-host-token",
    OPENCODE_CONFIG_DIR: "/etc/opencode",
    AKM_LAUNCHER_PATH: "/x/akm",
    LC_ALL: "C",
  };
  const names = (output: unknown) =>
    String(output)
      .trim()
      .split("\n")
      .map((line) => line.split("=")[0]);

  test("a command sees what --clean keeps, akm's locations and what it is given, and nothing else; an agent sees akm's environment as it is", async () => {
    let agentEnv: Record<string, string> = {};
    const w = world({
      host,
      tasks: {
        "tasks/t": {
          env: [{ LOG_LEVEL: "info" }],
          steps: [
            { name: "ask", prompt: "Hi." },
            { name: "env", exec: "env" },
          ],
        },
      },
      agent: (input) => {
        agentEnv = input.env;
        return "ok";
      },
    });
    const seen = names(await w.start("tasks/t"));
    for (const name of [
      "PATH",
      "HOME",
      "LC_ALL",
      "AKM_DATA_DIR",
      "AKM_STATE_DIR",
      "AKM_CACHE_DIR",
      "AKM_CONFIG_DIR",
      "LOG_LEVEL",
      "AKM_TASK_STATE",
      "AKM_EVENT_SOURCE",
    ]) {
      expect(seen).toContain(name);
    }
    for (const name of ["CUSTOM_PROFILE", "GITHUB_TOKEN", "OPENCODE_CONFIG_DIR", "AKM_BUNDLE_DIR"])
      expect(seen).not.toContain(name);
    expect([agentEnv.LOG_LEVEL, agentEnv.GITHUB_TOKEN, agentEnv.CUSTOM_PROFILE, agentEnv.OPENCODE_CONFIG_DIR]).toEqual([
      "info",
      "canary-host-token",
      "work",
      "/etc/opencode",
    ]);
    expect(agentEnv.AKM_LAUNCHER_PATH).toBeUndefined(); // set by akm's own launcher, not the user's
    expect(agentEnv.AKM_STATE_DIR).toBeDefined();
    expect(agentEnv.AKM_TASK_STATE).toBeUndefined(); // an agent is not pointed at the state file
  });

  test("a step's AKM_EVENT_SOURCE is the one in akm's own environment, else the run's source", async () => {
    const tasks = { "tasks/t": { exec: 'printf "%s" "$AKM_EVENT_SOURCE"' } };
    expect(await world({ host: { ...host, AKM_EVENT_SOURCE: "improve" }, tasks }).start("tasks/t")).toBe("improve");
    expect(await world({ host: { ...host, AKM_EVENT_SOURCE: undefined }, tasks }).start("tasks/t")).toBe("task");
  });

  test("a step's AKM_TASK_REF is the ref of the task it runs in, the innermost one for a nested task", async () => {
    const tasks = {
      "tasks/t": { exec: 'printf "%s" "$AKM_TASK_REF"' },
      "tasks/outer": { steps: [{ name: "inner", run: "tasks/t" }] },
    };
    const ref = await world({ host, tasks }).start("tasks/t");
    expect(ref).toEndWith("//tasks/t");
    expect(await world({ host, tasks }).start("tasks/outer")).toContain(ref);
  });

  test("inherit: lets a named variable through, for the task or for one step", async () => {
    const w = world({
      host,
      tasks: {
        "tasks/t": {
          inherit: ["OPENCODE_CONFIG_DIR"],
          steps: [
            { name: "a", exec: 'printf "%s|%s" "$OPENCODE_CONFIG_DIR" "$CUSTOM_PROFILE"', inherit: ["CUSTOM_PROFILE"] },
            { name: "b", exec: 'printf "%s|%s" "$OPENCODE_CONFIG_DIR" "$CUSTOM_PROFILE"' },
            { name: "look", exec: SHOW_STATE },
          ],
        },
      },
    });
    const state = json(await w.start("tasks/t"));
    expect([state.a, state.b]).toEqual(["/etc/opencode|work", "/etc/opencode|"]);
  });

  test("env: an env asset by ref or a variable set inline; the step's wins over the task's", async () => {
    const w = world({
      envAssets: { "env/lab": { REGION: "eu-west", LOG_LEVEL: "warn" } },
      tasks: {
        "tasks/t": {
          env: ["env/lab", { LOG_LEVEL: "info", PATH: `/opt/tools:${process.env.PATH}` }],
          steps: [
            {
              name: "a",
              exec: 'printf "%s|%s|%s" "$REGION" "$LOG_LEVEL" "${PATH%%:*}"',
              env: [{ LOG_LEVEL: "debug" }],
            },
            { name: "b", exec: 'printf "%s|%s" "$REGION" "$LOG_LEVEL"' },
            { name: "look", exec: SHOW_STATE },
          ],
        },
      },
    });
    const state = json(await w.start("tasks/t"));
    expect([state.a, state.b]).toEqual(["eu-west|debug|/opt/tools", "eu-west|info"]);
  });

  for (const c of ENV_HASH_CASES) {
    test(`env: binding reads a # in an env value as the file's author wrote it: ${c.name}`, async () => {
      const w = world({
        assets: { "env/hash": c.text },
        tasks: {
          "tasks/t": {
            env: ["env/hash"],
            steps: [
              { name: "a", exec: `printf '%s' "$${c.key}"` },
              { name: "look", exec: SHOW_STATE },
            ],
          },
        },
      });
      expect(json(await w.start("tasks/t")).a).toBe(c.value);
      if (c.bash) expect(bashValue(c.text, c.key)).toBe(c.value);
    });
  }

  test("akm run --env and --secret reach every step of the run and of the tasks it runs, and win", async () => {
    const seen: { prompt: string; env: Record<string, string> }[] = [];
    const show = 'echo "token=[$EXTRA_TOKEN] region=[$REGION]"';
    const w = world({
      envAssets: { "env/flag": { REGION: "flag" } },
      secrets: { "secrets/x": "canary-cli-secret" },
      tasks: {
        "tasks/inner": {
          env: [{ REGION: "inner-task" }],
          steps: [
            { name: "show", exec: show, env: [{ REGION: "inner-step" }] },
            { name: "ask", prompt: "Inner saw: ${show}" },
          ],
        },
        "tasks/outer": {
          env: [{ REGION: "outer-task" }],
          steps: [
            { name: "inner", run: "tasks/inner" },
            { name: "own", exec: show },
            { name: "ask", prompt: "Outer saw: ${own}" },
            { name: "look", exec: SHOW_STATE },
          ],
        },
      },
      agent: (input) => (seen.push(input), "ok"),
    });
    const state = json(await w.start("tasks/outer", {}, { env: ["env/flag"], secret: ["secrets/x:EXTRA_TOKEN"] }));
    expect(state.own).toBe("token=[[REDACTED]] region=[flag]\n");
    expect(seen.map((input) => [input.env.EXTRA_TOKEN, input.env.REGION])).toEqual([
      ["canary-cli-secret", "flag"],
      ["canary-cli-secret", "flag"],
    ]);
    expect(seen.map((input) => input.prompt)).toEqual([
      "Inner saw: token=[[REDACTED]] region=[flag]\n",
      "Outer saw: token=[[REDACTED]] region=[flag]\n",
    ]);
    // Without the flags, each task's own env: applies, and the caller's does not pass to the task it runs.
    seen.length = 0;
    const plain = json(await w.start("tasks/outer"));
    expect(plain.own).toBe("token=[] region=[outer-task]\n");
    expect(seen[0]?.prompt).toBe("Inner saw: token=[] region=[inner-step]\n");
    expect(seen[0]?.env.REGION).toBe("inner-task");
  });
});

describe("secrets are never state", () => {
  test("a secret a command prints is removed before it enters the state, so no prompt can carry it", async () => {
    let prompt = "";
    let agentEnv: Record<string, string> = {};
    const w = world({
      envAssets: { "env/lab": { GITEA_TOKEN: "${secrets/gitea}", HOOK: "${secrets/hook}", REGION: "eu-west" } },
      secrets: {
        "secrets/gitea": "canary-bound-in-asset",
        "secrets/hook": "canary-bound-plain-name",
        "secrets/deploy": "canary-named-in-step",
      },
      tasks: {
        "tasks/plan": {
          env: ["env/lab"],
          steps: [
            {
              name: "fetch",
              exec: 'echo "gitea=$GITEA_TOKEN hook=$HOOK deploy=$DEPLOY region=$REGION"',
              secret: ["secrets/deploy:DEPLOY"],
            },
            { name: "plan", prompt: "Write the plan from: ${fetch}" },
            { name: "look", exec: `${SHOW_STATE}; echo "deploy-here=[$DEPLOY]"` },
          ],
        },
      },
      agent: (input) => {
        prompt = input.prompt;
        agentEnv = input.env;
        return "the plan";
      },
    });
    const result = (await w.start("tasks/plan")) as string;
    expect(prompt).toBe("Write the plan from: gitea=[REDACTED] hook=[REDACTED] deploy=[REDACTED] region=eu-west\n");
    for (const text of [prompt, result]) {
      for (const canary of ["canary-bound-in-asset", "canary-bound-plain-name", "canary-named-in-step"]) {
        expect(text).not.toContain(canary);
      }
    }
    // The task's env: reaches the agent step's process; another step's secret: does not.
    expect([agentEnv.GITEA_TOKEN, agentEnv.DEPLOY]).toEqual(["canary-bound-in-asset", undefined]);
    expect(result).toContain("deploy-here=[]");
  });

  test("a variable whose name marks a credential is a secret, as today, with PAT; a short value is left alone", async () => {
    const w = world({
      tasks: {
        "tasks/t": {
          env: [
            {
              AZURE_DEVOPS_PAT: "canary-pat-value",
              GITEA_PASS: "canary-pass-value",
              BASIC_AUTH: "canary-auth-value",
              PGPASSWORD: "canary-pg-value",
              LLM_API_KEY: "local",
              NOTIFY_URL: "https://hooks.example/canary-url",
              KEYBOARD: "canary-not-a-key",
            },
          ],
          exec: 'echo "$AZURE_DEVOPS_PAT $GITEA_PASS $BASIC_AUTH $PGPASSWORD $LLM_API_KEY $NOTIFY_URL $KEYBOARD"',
        },
      },
    });
    expect(String(await w.start("tasks/t")).trim()).toBe(
      "[REDACTED] [REDACTED] [REDACTED] [REDACTED] local https://hooks.example/canary-url canary-not-a-key",
    );
  });

  test("a variable that reaches a step through inherit: or --inherit is a secret when its name marks a credential", async () => {
    const host = {
      ...process.env,
      INHERITED_TOKEN: "canary-inherited-token",
      OTHER_PASS: "canary-other-pass",
      SHORT_TOKEN: "short",
    };
    const show = 'printf "%s %s %s" "$INHERITED_TOKEN" "$OTHER_PASS" "$SHORT_TOKEN"';
    const w = world({
      host,
      tasks: {
        "tasks/t": {
          inherit: ["INHERITED_TOKEN", "SHORT_TOKEN"],
          steps: [{ name: "a", exec: show, inherit: ["OTHER_PASS"] }],
        },
        "tasks/inner": { exec: show },
        "tasks/outer": { steps: [{ name: "i", run: "tasks/inner" }] },
      },
    });
    expect(await w.start("tasks/t")).toBe("[REDACTED] [REDACTED] short");
    expect(await w.start("tasks/outer", {}, { inherit: ["INHERITED_TOKEN", "OTHER_PASS"] })).toBe(
      "[REDACTED] [REDACTED] ",
    );
  });

  test("every secret value a run can set is known when it starts: one set only for a later step, or in a task it runs, is removed from an earlier result", async () => {
    const prompts: string[] = [];
    const w = world({
      secrets: {
        "secrets/top": "canary-top-value",
        "secrets/late": "canary-late-value",
        "secrets/inner": "canary-inner-value",
        "secrets/bound": "canary-bound-value",
        "secrets/flag": "canary-flag-value",
      },
      envAssets: { "env/late": { BOUND: "${secrets/bound}" } },
      tasks: {
        "tasks/inner": {
          steps: [
            { name: "x", exec: "printf canary-top-value" },
            { name: "xa", prompt: "${x}" },
            { name: "y", exec: "printf canary-inner-value", secret: ["secrets/inner:INNER"] },
          ],
        },
        "tasks/t": {
          secret: ["secrets/top:TOP"],
          steps: [
            {
              name: "first",
              exec: "printf 'canary-late-value canary-inner-value canary-bound-value canary-flag-value'",
            },
            { name: "mid", run: "tasks/inner" },
            { name: "ask", prompt: "${first}|${mid}" },
            { name: "late", exec: "true", secret: ["secrets/late:LATE"], env: ["env/late"] },
            { name: "look", exec: SHOW_STATE },
          ],
        },
      },
      agent: ({ prompt }) => (prompts.push(prompt), "ok"),
    });
    await w.start("tasks/t", {}, { secret: ["secrets/flag:FLAG"] });
    expect(prompts).toEqual(["[REDACTED]", "[REDACTED] [REDACTED] [REDACTED] [REDACTED]|[REDACTED]"]);
  });

  test("a secret value is gone from the run's history and log, as from its result", async () => {
    const w = world({
      secrets: { "secrets/deploy": "canary-in-history" },
      tasks: {
        "tasks/t": {
          steps: [
            {
              name: "fetch",
              exec: "printf canary-in-history; echo canary-in-history >&2; false",
              secret: ["secrets/deploy:DEPLOY"],
            },
          ],
        },
      },
    });
    expect(await message(w.start("tasks/t"))).toBe("step fetch: non_zero_exit: exit code 1: [REDACTED]");
    const { readTaskHistory } = await import("../../../../src/tasks/run/task-history");
    const [row] = readTaskHistory({ id: "t", limit: 1 });
    expect(JSON.stringify(row)).not.toContain("canary-in-history");
    expect(fs.readFileSync(row?.log as string, "utf8")).not.toContain("canary-in-history");
  });
});

describe("every run has a working folder", () => {
  test("every step of a run works in the run's own folder, not in the bundle; a task it runs has its own", async () => {
    const seen: { cwd: string; files: string[] }[] = [];
    const w = world({
      assets: { "scripts/write.sh": "echo status > status.txt; pwd\n" },
      tasks: {
        "tasks/inner": { exec: "pwd; ls" },
        "tasks/outer": {
          steps: [
            { name: "write", run: "scripts/write.sh" },
            { name: "ask", prompt: "Read status.txt." },
            { name: "inner", run: "tasks/inner" },
            { name: "look", exec: SHOW_STATE },
          ],
        },
      },
      agent: ({ cwd }) => (seen.push({ cwd, files: fs.readdirSync(cwd) }), "ok"),
    });
    const root = fs.realpathSync(path.join(w.scratch, "stash"));
    const state = json(await w.start("tasks/outer"));
    const folder = state.write.trim();
    expect(folder).not.toBe(root);
    expect(seen[0]).toEqual({ cwd: folder, files: ["status.txt"] });
    const [innerFolder, ...innerFiles] = state.inner.trim().split("\n");
    expect([innerFolder === folder, innerFolder === root, innerFiles]).toEqual([false, false, []]);
    expect([fs.existsSync(folder), fs.existsSync(innerFolder)]).toEqual([false, false]);
  });

  test("the folder is kept while a failed run can be resumed, and removed when it succeeds", async () => {
    const w = world({
      tasks: {
        "tasks/t": {
          steps: [
            { name: "write", exec: `echo kept > note.txt; pwd > "${at("where")}"` },
            { name: "read", exec: fixedOrFail("cat note.txt") },
          ],
        },
      },
    });
    expect(await rule(w.start("tasks/t"))).toBe(RUN_FAILED);
    const folder = fs.readFileSync(at("where"), "utf8").trim();
    expect(fs.readdirSync(folder)).toEqual(["note.txt"]);
    fix();
    expect(await w.resume("tasks/t")).toBe("kept\n");
    expect(fs.existsSync(folder)).toBe(false);
  });

  test("cwd: on the task, --cwd for the run, or cwd: on a step names the folder instead; akm does not remove it", async () => {
    const cwds: string[] = [];
    const w = world({
      tasks: {
        "tasks/inner": { exec: "pwd" },
        "tasks/in-bundle": {
          cwd: ".",
          steps: [
            { name: "here", exec: "pwd" },
            { name: "ask", prompt: "Hi." },
          ],
        },
        "tasks/in-sub": {
          cwd: "sub",
          steps: [
            { name: "here", exec: "pwd" },
            { name: "there", exec: "pwd", cwd: at("one-step") },
            { name: "inner", run: "tasks/inner" },
            { name: "look", exec: SHOW_STATE },
          ],
        },
      },
      agent: ({ cwd }) => (cwds.push(cwd), "ok"),
    });
    const root = fs.realpathSync(path.join(w.scratch, "stash"));
    await w.start("tasks/in-bundle");
    expect(cwds).toEqual([root]);
    const named = json(await w.start("tasks/in-sub"));
    const sub = path.join(root, "sub");
    expect([named.here.trim(), named.there.trim()]).toEqual([sub, at("one-step")]);
    expect([sub, root]).not.toContain(named.inner.trim()); // the task it runs says nothing, so it gets a folder of its own
    const flagged = json(await w.start("tasks/in-sub", {}, { cwd: at("elsewhere") }));
    expect([flagged.here.trim(), flagged.there.trim()]).toEqual([at("elsewhere"), at("one-step")]);
    expect(flagged.inner.trim()).not.toBe(at("elsewhere")); // --cwd names the folder of the task that was started
    expect([sub, at("elsewhere"), at("one-step")].map((dir) => fs.existsSync(dir))).toEqual([true, true, true]);
  });

  test("akm makes a folder that cwd: or --cwd names if it is not there, and never removes it; lint makes nothing", async () => {
    const made: boolean[] = [];
    const w = world({
      commands: { "commands/c": "C $ARGUMENTS" },
      tasks: {
        "tasks/plain": { exec: "pwd" },
        "tasks/named": { cwd: at("made/by-task"), exec: "pwd" },
        "tasks/step": { steps: [{ name: "b", exec: "pwd", cwd: at("made/by-step") }] },
        "tasks/prompt-asset": { steps: [{ name: "p", run: "commands/c", cwd: at("made/by-prompt-asset") }] },
        "tasks/lint-only": { cwd: at("made/by-lint"), exec: "pwd" },
      },
      agent: ({ cwd }) => {
        made.push(fs.existsSync(cwd));
        return "ok";
      },
    });
    const where = async (run: Promise<unknown>) => path.basename(((await run) as string).trim());
    expect(await where(w.start("tasks/plain", {}, { cwd: at("made/by-flag") }))).toBe("by-flag");
    expect(await where(w.start("tasks/named"))).toBe("by-task");
    expect(await where(w.start("tasks/step"))).toBe("by-step");
    await w.start("tasks/prompt-asset");
    expect(made).toEqual([true]);
    await w.lint("tasks/lint-only");
    expect(fs.readdirSync(at("made")).sort()).toEqual(["by-flag", "by-prompt-asset", "by-step", "by-task"]);
  });

  test("a folder that cannot be made, named by the task or by a step, refuses the start", async () => {
    fs.writeFileSync(at("a-file"), "");
    const w = world({
      tasks: {
        "tasks/run": { cwd: path.join(at("a-file"), "under"), exec: count("run") },
        "tasks/step": { steps: [{ name: "a", exec: count("step"), cwd: path.join(at("a-file"), "under") }] },
      },
    });
    for (const ref of ["tasks/run", "tasks/step"]) expect(await rule(w.start(ref))).toBe("INVALID_FLAG_VALUE");
    expect(ran("run") + ran("step")).toBe(0);
    expect(w.history()).toEqual([]); // refused: no run was recorded
  });

  test("when a run of a task succeeds, the folders kept for its earlier failed runs are removed, and no folder cwd: or --cwd names", async () => {
    const w = world({
      tasks: {
        "tasks/t": {
          steps: [
            { name: "w", exec: `pwd >> "${at("where")}"; echo x > note` },
            { name: "r", exec: fixedOrFail("true") },
          ],
        },
        "tasks/other": {
          steps: [
            { name: "w", exec: `pwd >> "${at("other-where")}"` },
            { name: "r", exec: "false" },
          ],
        },
        "tasks/named": { cwd: at("kept"), steps: [{ name: "r", exec: fixedOrFail("true") }] },
      },
    });
    for (const ref of ["tasks/t", "tasks/t", "tasks/other", "tasks/named", "tasks/named"]) {
      expect(await rule(w.start(ref))).toBe(RUN_FAILED);
    }
    expect(await rule(w.start("tasks/t", {}, { cwd: at("flagged") }))).toBe(RUN_FAILED);
    const folders = fs.readFileSync(at("where"), "utf8").trim().split("\n");
    const other = fs.readFileSync(at("other-where"), "utf8").trim();
    expect(folders.length).toBe(3);
    expect(folders.slice(0, 2).map((dir) => fs.existsSync(dir))).toEqual([true, true]);
    fix();
    await w.start("tasks/t");
    expect(folders.slice(0, 2).map((dir) => fs.existsSync(dir))).toEqual([false, false]); // the failed runs akm made folders for
    expect(fs.existsSync(at("flagged"))).toBe(true); // a folder --cwd named
    expect(fs.existsSync(other)).toBe(true); // another task's failed run
    await w.start("tasks/named");
    expect(fs.existsSync(at("kept"))).toBe(true);
    expect(w.history().map((run) => run.status)).toEqual([
      "discarded",
      "discarded",
      "failed",
      "discarded",
      "discarded",
      "discarded",
      "succeeded",
      "succeeded",
    ]);
  });
});

describe("every run is isolated", () => {
  test("many runs of one task at the same moment do not see each other", async () => {
    const w = world({
      tasks: {
        "tasks/t": {
          inputs: inputs({ who: null }),
          steps: [
            { name: "mine", exec: `sleep 0.2; sed -n 's/.*"who": "\\(.*\\)".*/\\1/p' "$AKM_TASK_STATE" | tr -d '\\n'` },
            { name: "look", exec: SHOW_STATE },
          ],
        },
      },
    });
    const who = ["a", "b", "c", "d", "e", "f"];
    const results = await Promise.all(who.map((name) => w.start("tasks/t", { who: name })));
    expect(results.map((result) => json(result))).toEqual(who.map((name) => ({ who: name, mine: name })));
  });

  test("a task that a step runs has its own state", async () => {
    const w = world({
      tasks: {
        "tasks/inner": { exec: SHOW_STATE },
        "tasks/outer": {
          inputs: inputs({ date: "today" }),
          steps: [
            { name: "first", exec: "printf one" },
            { name: "inner", run: "tasks/inner" },
            { name: "look", exec: SHOW_STATE },
          ],
        },
      },
    });
    expect(json(await w.start("tasks/outer")).inner).toBe("{}");
  });

  test("resume continues the most recent failed run: same state, finished steps not run again", async () => {
    const w = world({
      tasks: {
        "tasks/t": {
          inputs: inputs({ date: null }),
          steps: [
            { name: "fetch", exec: `${count("fetch")}; printf fetched` },
            { name: "save", exec: `${count("save")}; ${fixedOrFail("printf saved")}` },
            { name: "look", exec: SHOW_STATE },
          ],
        },
      },
    });
    expect(await rule(w.start("tasks/t", { date: "2026-11-19" }))).toBe(RUN_FAILED);
    expect(w.history().at(-1)).toMatchObject({ status: "failed", hasState: true });
    fix();
    expect(json(await w.resume("tasks/t"))).toEqual({ date: "2026-11-19", fetch: "fetched", save: "saved" });
    expect([ran("fetch"), ran("save")]).toEqual([1, 2]);
    expect(w.history().at(-1)).toMatchObject({ status: "succeeded", hasState: false });
    expect(await rule(w.resume("tasks/t"))).toBe(NOTHING_TO_RESUME);
  });

  test("resume starts again inside a task that failed part-way; that run is resumed only through its caller", async () => {
    const w = world({
      tasks: {
        "tasks/purge-cache": {
          steps: [
            { name: "status", exec: `${count("status")}; printf warm` },
            { name: "purge", exec: `${count("purge")}; ${fixedOrFail("printf purged")}` },
          ],
        },
        "tasks/deploy": {
          steps: [
            { name: "build", exec: count("build") },
            { name: "purge-cache", run: "tasks/purge-cache" },
            { name: "look", exec: SHOW_STATE },
          ],
        },
      },
    });
    expect(await rule(w.start("tasks/deploy"))).toBe(RUN_FAILED);
    expect(await rule(w.resume("tasks/purge-cache"))).toBe(NOTHING_TO_RESUME);
    fix();
    expect(json(await w.resume("tasks/deploy"))["purge-cache"]).toBe("purged");
    expect([ran("build"), ran("status"), ran("purge")]).toEqual([1, 1, 2]);
  });

  test("with two failed runs, resume takes the most recent, and the other is left as it was until a run of the task succeeds", async () => {
    const w = world({
      tasks: { "tasks/t": { inputs: inputs({ who: null }), steps: [{ name: "work", exec: fixedOrFail(SHOW_STATE) }] } },
    });
    expect(await rule(w.start("tasks/t", { who: "first" }))).toBe(RUN_FAILED);
    expect(await rule(w.start("tasks/t", { who: "second" }))).toBe(RUN_FAILED);
    expect(w.history().map((run) => run.status)).toEqual(["failed", "failed"]);
    fix();
    expect(json(await w.resume("tasks/t"))).toEqual({ who: "second" });
    expect(w.history().map((run) => run.status)).toEqual(["discarded", "succeeded"]);
    expect(await rule(w.resume("tasks/t"))).toBe(NOTHING_TO_RESUME);
  });

  test("a failed run is not resumed by two starts at once", async () => {
    const w = world({
      tasks: { "tasks/t": { steps: [{ name: "work", exec: `${count("work")}; sleep 0.3; ${fixedOrFail("true")}` }] } },
    });
    expect(await rule(w.start("tasks/t"))).toBe(RUN_FAILED);
    fix();
    expect(await Promise.all([rule(w.resume("tasks/t")), rule(w.resume("tasks/t"))])).toEqual(["no error", LOCKED]);
    expect(ran("work")).toBe(2);
  });
});

describe("a lock, when the task asks", () => {
  test("lock: true lets one run of a task go at a time; a start that finds the lock taken starts nothing", async () => {
    const work = (name: string) => `sleep 0.2; ${count(name)}; ${SHOW_STATE}`;
    const w = world({
      tasks: {
        "tasks/publish": {
          lock: true,
          inputs: inputs({ who: null }),
          steps: [{ name: "work", exec: work("publish") }],
        },
        "tasks/other": { lock: true, exec: work("other") },
      },
    });
    const outcomes = await Promise.all([
      rule(w.start("tasks/publish", { who: "first" })),
      rule(w.start("tasks/publish", { who: "second" })),
      rule(w.start("tasks/other")),
    ]);
    expect(outcomes).toEqual(["no error", LOCKED, "no error"]);
    expect([ran("publish"), ran("other")]).toEqual([1, 1]);
    expect(w.history().map((run) => [run.task, run.status])).toEqual([
      ["tasks/publish", "succeeded"],
      ["tasks/other", "succeeded"],
    ]);
    expect(await rule(w.resume("tasks/publish"))).toBe(NOTHING_TO_RESUME);
    expect(json(await w.start("tasks/publish", { who: "third" }))).toEqual({ who: "third" });
  });

  test("a task without lock: is not locked", async () => {
    const w = world({ tasks: { "tasks/t": { exec: "sleep 0.2; printf ok" } } });
    expect(await Promise.all([w.start("tasks/t"), w.start("tasks/t")])).toEqual(["ok", "ok"]);
  });

  test("the lock is the task's whoever starts the run: a step that finds it taken fails, and resuming the caller tries again", async () => {
    const w = world({
      tasks: {
        "tasks/publish": { lock: true, exec: `sleep 0.3; ${count("publish")}` },
        "tasks/nightly": {
          steps: [
            { name: "prep", exec: count("prep") },
            { name: "publish", run: "tasks/publish" },
            { name: "report", exec: count("report") },
          ],
        },
      },
    });
    const direct = w.start("tasks/publish");
    await Bun.sleep(100);
    expect(await rule(w.start("tasks/nightly"))).toBe(RUN_FAILED);
    expect(w.history().map((run) => [run.task, run.status])).toEqual([
      ["tasks/publish", "running"],
      ["tasks/nightly", "failed"],
    ]);
    expect(await rule(w.resume("tasks/nightly"))).toBe(RUN_FAILED);
    await direct;
    await w.resume("tasks/nightly");
    expect([ran("prep"), ran("publish"), ran("report")]).toEqual([1, 2, 1]);
  });

  test("the lock is released when a run fails, and resuming a run takes the lock like starting one", async () => {
    const w = world({
      tasks: { "tasks/t": { lock: true, exec: `sleep 0.2; ${count("t")}; ${fixedOrFail("printf done")}` } },
    });
    expect(await rule(w.start("tasks/t"))).toBe(RUN_FAILED);
    expect(await rule(w.start("tasks/t"))).toBe(RUN_FAILED);
    fix();
    const going = w.start("tasks/t");
    await Bun.sleep(100);
    expect(await rule(w.resume("tasks/t"))).toBe(LOCKED);
    expect(await going).toBe("done");
    expect(ran("t")).toBe(3);
  });

  test("a scheduled start that finds the lock taken has not failed: nothing starts, nothing is recorded; --skip-if-locked does the same", async () => {
    const w = world({
      tasks: {
        "tasks/publish": { lock: true, exec: `sleep 0.2; ${count("publish")}; printf done` },
        "tasks/nightly": { steps: [{ name: "publish", run: "tasks/publish" }] },
      },
    });
    const going = w.start("tasks/publish");
    await Bun.sleep(100);
    expect(await w.start("tasks/publish", {}, { scheduled: true })).toBeUndefined();
    expect(await w.start("tasks/publish", {}, { skipIfLocked: true })).toBeUndefined();
    expect(await rule(w.start("tasks/publish"))).toBe(LOCKED);
    // A step that finds the lock taken has failed, however its own run was started.
    expect(await rule(w.start("tasks/nightly", {}, { scheduled: true }))).toBe(RUN_FAILED);
    expect(await going).toBe("done");
    expect(ran("publish")).toBe(1);
    expect(w.history().map((run) => [run.task, run.status])).toEqual([
      ["tasks/publish", "succeeded"],
      ["tasks/nightly", "failed"],
    ]);
    expect(await w.start("tasks/publish", {}, { scheduled: true })).toBe("done");
  });
});

describe("timeout: and max-retries:, as the flags", () => {
  /** A command that fails until it has run `good` times. */
  const flaky = (name: string, good: number) =>
    `${count(name)}; test "$(wc -l < "${at(name)}")" -ge ${good} && printf ok`;

  test("timeout: on a step is that step's limit: the command is stopped, with what it started, and the step has failed", async () => {
    const w = world({
      tasks: {
        "tasks/t": {
          steps: [
            { name: "quick", exec: "printf ok", timeout: "5s" },
            {
              name: "slow",
              exec: `(sleep 0.6; ${count("left-behind")}) & sleep 5; ${count("late")}`,
              timeout: "200ms",
            },
            { name: "after", exec: count("after") },
          ],
        },
      },
    });
    const began = Date.now();
    expect(await message(w.start("tasks/t"))).toBe("step slow: timeout");
    expect(Date.now() - began).toBeLessThan(2500);
    expect(w.history()[0]?.steps.map((step) => step.status)).toEqual(["completed", "failed", "pending"]);
    await Bun.sleep(700);
    expect([ran("left-behind"), ran("late"), ran("after")]).toEqual([0, 0, 0]);
  });

  test("an agent step has its limit too, and is told when it is reached", async () => {
    let told = false;
    const w = world({
      tasks: { "tasks/t": { prompt: "think", timeout: "150ms" } },
      agent: ({ signal }) =>
        new Promise(
          (resolve) => (
            signal.addEventListener("abort", () => (told = true)), setTimeout(() => resolve("too late"), 3000)
          ),
        ),
    });
    expect(await message(w.start("tasks/t"))).toBe("step (only): timeout: agent timed out");
    expect(told).toBe(true);
  });

  test("timeout: at the top of a task is each step's default, as today: it is not the whole run's limit, and a step's own wins", async () => {
    const step = (name: string) => ({ name, exec: `sleep 0.25; ${count(name)}` });
    const w = world({
      tasks: {
        "tasks/each": { timeout: "700ms", steps: [step("a"), step("b"), step("c")] },
        "tasks/short": { timeout: "150ms", steps: [{ name: "s", exec: "sleep 0.5; printf ok" }] },
        "tasks/own": { timeout: "150ms", steps: [{ name: "s", exec: "sleep 0.3; printf ok", timeout: "5s" }] },
        "tasks/one": { timeout: "100ms", exec: "sleep 0.25; printf done" },
      },
    });
    await w.start("tasks/each");
    expect([ran("a"), ran("b"), ran("c")]).toEqual([1, 1, 1]);
    expect(await message(w.start("tasks/short"))).toBe("step s: timeout");
    expect(await w.start("tasks/own")).toBe("ok");
    expect(await message(w.start("tasks/one"))).toBe("step (only): timeout");
  });

  test("akm run --timeout limits the whole run, and a step's own limit does not lift it", async () => {
    const step = (name: string) => ({ name, exec: `sleep 0.25; ${count(name)}` });
    const w = world({
      tasks: {
        "tasks/three": { steps: [step("a"), step("b"), step("c")] },
        "tasks/own": { steps: [{ name: "s", exec: "sleep 0.5; printf ok", timeout: "5s" }] },
        "tasks/free": { exec: "sleep 0.3; printf done" },
      },
    });
    expect(await message(w.start("tasks/three", {}, { timeout: "650ms" }))).toBe("step c: timeout");
    expect([ran("a"), ran("b"), ran("c")]).toEqual([1, 1, 0]);
    expect(await message(w.start("tasks/own", {}, { timeout: "150ms" }))).toBe("step s: timeout");
    expect(await w.start("tasks/free", {}, { timeout: "5s" })).toBe("done");
    expect(await rule(w.start("tasks/free", {}, { timeout: "soon" }))).toBe("INVALID_FLAG_VALUE");
  });

  test("a step that runs a task limits that whole run, with its own timeout: or its task's; the task it runs keeps its own steps' limits", async () => {
    const w = world({
      tasks: {
        "tasks/slow": { timeout: "5s", exec: "sleep 0.3; printf done" },
        "tasks/hasty": { timeout: "100ms", exec: "sleep 0.25; printf done" },
        "tasks/cut-short": { steps: [{ name: "call", run: "tasks/slow", timeout: "150ms" }] },
        "tasks/by-default": { timeout: "150ms", steps: [{ name: "call", run: "tasks/slow" }] },
        "tasks/patient": { steps: [{ name: "call", run: "tasks/hasty", timeout: "5s" }] },
        "tasks/calls-slow": { steps: [{ name: "call", run: "tasks/slow" }] },
      },
    });
    expect(await rule(w.start("tasks/cut-short"))).toBe(RUN_FAILED);
    expect(await rule(w.start("tasks/by-default"))).toBe(RUN_FAILED);
    expect(await rule(w.start("tasks/patient"))).toBe(RUN_FAILED);
    expect(await w.start("tasks/calls-slow")).toBe("done");
    expect(await rule(w.start("tasks/calls-slow", {}, { timeout: "100ms" }))).toBe(RUN_FAILED);
  });

  test("max-retries: a step that fails is run again, that many more times and no more", async () => {
    const w = world({
      tasks: {
        "tasks/enough": { steps: [{ name: "s", exec: flaky("enough", 3), "max-retries": 2 }] },
        "tasks/short": { steps: [{ name: "s", exec: flaky("short", 3), "max-retries": 1 }] },
        "tasks/none": { exec: flaky("none", 2) },
      },
    });
    expect(await w.start("tasks/enough")).toBe("ok");
    expect(await rule(w.start("tasks/short"))).toBe(RUN_FAILED);
    expect(await rule(w.start("tasks/none"))).toBe(RUN_FAILED);
    expect([ran("enough"), ran("short"), ran("none")]).toEqual([3, 2, 1]);
  });

  test("max-retries: at the top of a task is every step's default, and a step's own wins", async () => {
    const w = world({
      tasks: {
        "tasks/t": {
          "max-retries": 1,
          steps: [
            { name: "a", exec: flaky("a", 2) },
            { name: "b", exec: flaky("b", 2) },
            { name: "c", exec: flaky("c", 2), "max-retries": 0 },
          ],
        },
        "tasks/one": { "max-retries": 1, exec: flaky("one", 2) },
      },
    });
    expect(await message(w.start("tasks/t"))).toBe("step c: non_zero_exit: exit code 1");
    expect([ran("a"), ran("b"), ran("c")]).toEqual([2, 2, 1]);
    expect(await w.start("tasks/one")).toBe("ok");
  });

  test("a step is run again whatever made it fail: no reply, a reply expect: refuses, or its limit", async () => {
    const replies = ["", "no object here", "no object here either", '{"title": "x"}'];
    const w = world({
      tasks: {
        "tasks/agent": { steps: [{ name: "write", prompt: "write", expect: ["title"], "max-retries": 2 }] },
        "tasks/limited": {
          steps: [
            {
              name: "s",
              exec: `${count("limited")}; test "$(wc -l < "${at("limited")}")" -ge 2 || sleep 5; printf ok`,
              timeout: "200ms",
              "max-retries": 1,
            },
          ],
        },
      },
      agent: () => replies.shift() as string,
    });
    expect(await w.start("tasks/agent")).toEqual({ title: "x" });
    expect(replies).toEqual([]);
    expect(await w.start("tasks/limited")).toBe("ok");
    expect(ran("limited")).toBe(2);
  });

  test("an expect: step records the agent fact of its last dispatch: the corrective dispatch that fails, not the refused reply before it", async () => {
    const replies = ["no object here"];
    const w = world({
      tasks: { "tasks/t": { steps: [{ name: "write", prompt: "write", expect: ["title"], timeout: "300ms" }] } },
      agent: () => (replies.length > 0 ? (replies.shift() as string) : new Promise<string>(() => {})),
    });
    expect(await message(w.start("tasks/t"))).toBe("step write: timeout: agent timed out");
    const { readTaskHistory } = await import("../../../../src/tasks/run/task-history");
    const [row] = readTaskHistory({ id: "t", limit: 1 });
    expect(row?.steps?.[0]?.agent).toMatchObject({ reason: "timeout" });
  });

  test("a step with no timeout: has a limit of 30 minutes; the top of its task or the step sets another", async () => {
    const limits: Record<string, number | null | undefined> = {};
    let which = "";
    const w = world({
      tasks: {
        "tasks/plain": { prompt: "Hi." },
        "tasks/top": { timeout: "10m", prompt: "Hi." },
        "tasks/step": { steps: [{ name: "a", prompt: "Hi.", timeout: "2m" }] },
        "tasks/caller": { steps: [{ name: "c", run: "tasks/plain" }] },
      },
      agent: ({ timeoutMs }) => {
        limits[which] = timeoutMs;
        return "ok";
      },
    });
    const limit = async (ref: string) => {
      which = ref;
      await w.start(ref);
      return limits[ref] as number;
    };
    const inRange = (value: number, low: number, high: number) => value > low && value <= high;
    expect(inRange(await limit("tasks/plain"), 1_790_000, 1_800_000)).toBe(true);
    expect(inRange(await limit("tasks/top"), 590_000, 600_000)).toBe(true);
    expect(inRange(await limit("tasks/step"), 110_000, 120_000)).toBe(true);
    expect(inRange(await limit("tasks/caller"), 1_790_000, 1_800_000)).toBe(true);
  });
});

describe("what a start gives, and what it checks before anything runs", () => {
  const flaky = (name: string, good: number) =>
    `${count(name)}; test "$(wc -l < "${at(name)}")" -ge ${good} && printf ok`;

  test("a --env or --secret that names nothing, a malformed --secret, or an env asset binding a missing secret is refused before anything runs", async () => {
    const w = world({
      envAssets: { "env/bad": { TOKEN: "${secrets/missing}" }, "env/ok": { REGION: "x" } },
      secrets: { "secrets/x": "v" },
      tasks: {
        "tasks/t": { steps: [{ name: "a", exec: count("t") }] },
        "tasks/bound": { env: ["env/bad"], exec: count("t") },
      },
    });
    expect(await rule(w.start("tasks/t", {}, { env: ["env/missing"] }))).not.toBe("no error");
    expect(await rule(w.start("tasks/t", {}, { env: ["env/bad"] }))).not.toBe("no error");
    expect(await rule(w.start("tasks/t", {}, { secret: ["secrets/missing:TOKEN"] }))).not.toBe("no error");
    expect(await rule(w.start("tasks/t", {}, { secret: ["secrets/x"] }))).not.toBe("no error");
    expect(await rule(w.start("tasks/t", {}, { secret: ["secrets/x:not a name"] }))).not.toBe("no error");
    expect(await rule(w.start("tasks/bound"))).not.toBe("no error");
    expect(ran("t")).toBe(0);
    expect(w.history()).toEqual([]);
    await w.start("tasks/t", {}, { env: ["env/ok"], secret: ["secrets/x:TOKEN"] });
    expect(ran("t")).toBe(1);
  });

  test("an optional input that is not given is empty text, in the state and in ${name}", async () => {
    const w = world({
      assets: { "scripts/show.sh": 'printf "[%s]" "$@"\n' },
      tasks: {
        "tasks/t": {
          inputs: { note: {}, kept: { default: 0 } },
          steps: [
            { name: "show", run: "scripts/show.sh", args: ["${note}"] },
            { name: "ask", prompt: "Note: [${note}]" },
            { name: "look", exec: SHOW_STATE },
          ],
        },
      },
      agent: ({ prompt }) => prompt,
    });
    expect(json(await w.start("tasks/t"))).toEqual({ note: "", kept: 0, show: "[]", ask: "Note: []" });
  });

  test("resume uses the --env, --secret, --cwd and --timeout of the first start; the limit counts again from the resume", async () => {
    const w = world({
      envAssets: { "env/first": { REGION: "first" } },
      secrets: { "secrets/x": "canary-resume" },
      tasks: {
        "tasks/t": {
          steps: [
            { name: "a", exec: "sleep 0.2; printf a" },
            {
              name: "b",
              exec: `test -f "${at("fixed")}" && sleep "$(cat "${at("delay")}")" && printf '%s|%s|%s' "$REGION" "\${#TOKEN}" "$(pwd)"`,
            },
          ],
        },
      },
    });
    const flags = { env: ["env/first"], secret: ["secrets/x:TOKEN"], cwd: at("named"), timeout: "600ms" };
    fs.writeFileSync(at("delay"), "1");
    expect(await rule(w.start("tasks/t", {}, flags))).toBe(RUN_FAILED);
    fix();
    // the limit is still there: step b, which takes a second, is stopped
    expect(await rule(w.resume("tasks/t"))).toBe(RUN_FAILED);
    expect(w.history().at(-1)?.status).toBe("failed");
    // and it counts again from the resume: more than 600ms after the first start, step b is given its time
    fs.writeFileSync(at("delay"), "0.1");
    await Bun.sleep(400);
    expect(await w.resume("tasks/t")).toBe(`first|${"canary-resume".length}|${fs.realpathSync(at("named"))}`);
  });

  test("--max-retries and --inherit given at the start are the default for every step of the run and of the tasks it runs", async () => {
    const host = { ...process.env, CUSTOM_PROFILE: "work", OPENCODE_CONFIG_DIR: "/etc/opencode" };
    const w = world({
      host,
      tasks: {
        "tasks/inner": {
          steps: [
            { name: "i", exec: flaky("inner", 2) },
            { name: "env", exec: 'printf "%s|%s" "$CUSTOM_PROFILE" "$OPENCODE_CONFIG_DIR"' },
          ],
        },
        "tasks/t": {
          inherit: ["OPENCODE_CONFIG_DIR"],
          steps: [
            { name: "a", exec: flaky("a", 3) },
            { name: "inner", run: "tasks/inner", "max-retries": 0 },
            { name: "b", exec: flaky("b", 2), "max-retries": 1 },
            { name: "mine", exec: 'printf "%s|%s" "$CUSTOM_PROFILE" "$OPENCODE_CONFIG_DIR"' },
            { name: "look", exec: SHOW_STATE },
          ],
        },
        "tasks/own": { "max-retries": 0, steps: [{ name: "a", exec: flaky("own", 2) }] },
        "tasks/step": { steps: [{ name: "a", exec: flaky("step", 2), "max-retries": 0 }] },
      },
    });
    expect(await rule(w.start("tasks/t"))).toBe(RUN_FAILED);
    const state = json(await w.start("tasks/t", {}, { maxRetries: 2, inherit: ["CUSTOM_PROFILE"] }));
    // the flag reaches the task it runs; the caller's inherit: does not
    expect([state.inner, state.mine]).toEqual(["work|", "work|/etc/opencode"]);
    expect([ran("a"), ran("inner")]).toEqual([3, 2]);
    // a step's own value wins, then its task's, then the flag
    expect(await rule(w.start("tasks/own", {}, { maxRetries: 5 }))).toBe(RUN_FAILED);
    expect(await rule(w.start("tasks/step", {}, { maxRetries: 5 }))).toBe(RUN_FAILED);
    expect([ran("own"), ran("step")]).toEqual([1, 1]);
    expect(await rule(w.start("tasks/t", {}, { maxRetries: -1 }))).toBe("INVALID_FLAG_VALUE");
    expect(await rule(w.start("tasks/t", {}, { inherit: ["not a name"] }))).toBe("INVALID_FLAG_VALUE");
  });

  test("a calling step's true binds as --name true does on the command line: text for a text input, true for a boolean one", async () => {
    const w = world({
      tasks: {
        "tasks/show": {
          inputs: { s: { type: "string", default: "" }, b: { type: "boolean", default: false }, u: { default: "" } },
          exec: SHOW_STATE,
        },
        "tasks/caller": {
          steps: [{ name: "a", run: "tasks/show", args: ["--s", true, "--b", true, "--u", true] }],
        },
      },
    });
    expect(json(await w.start("tasks/caller"))).toEqual({ s: "true", b: true, u: true });
    // only a bare flag, one given no value, is refused for a text input
    expect(await rule(w.start("tasks/show", { s: true }))).toBe(BAD_VALUE);
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
          exec: `${count("typed")}; ${SHOW_STATE}`,
        },
        "tasks/schemas": {
          inputs: { i: { type: "integer", required: true }, o: { type: "object", default: {} } },
          exec: SHOW_STATE,
        },
        "tasks/count": { exec: "printf 12" },
        "tasks/bad-count": { exec: "printf abc" },
        "tasks/literal": {
          steps: [
            { name: "a", exec: count("literal") },
            { name: "t", run: "tasks/typed", args: ["--n", "7", "--on", "true", "--s", 3] },
            { name: "look", exec: SHOW_STATE },
          ],
        },
        "tasks/from-step": {
          steps: [
            { name: "c", run: "tasks/count" },
            { name: "t", run: "tasks/typed", args: ["--n", "${c}"] },
          ],
        },
        "tasks/from-bad-step": {
          steps: [
            { name: "c", run: "tasks/bad-count" },
            { name: "t", run: "tasks/typed", args: ["--n", "${c}"] },
          ],
        },
        "tasks/not-a-number": {
          steps: [
            { name: "a", exec: count("literal") },
            { name: "t", run: "tasks/typed", args: ["--n", "seven"] },
          ],
        },
      },
    });
    expect(json(await w.start("tasks/typed", { n: "10", on: "true", s: "x" }))).toEqual({ n: 10, on: true, s: "x" });
    expect(json(await w.start("tasks/typed", { n: "2.5", on: "false" }))).toEqual({ n: 2.5, on: false, s: "" });
    expect(json(await w.start("tasks/typed", { n: 4 })).n).toBe(4);
    // a flag given no value is not the text "true": a text input refuses it
    expect(await rule(w.start("tasks/typed", { n: 4, s: true }))).toBe(BAD_VALUE);
    const refused = ran("typed");
    for (const values of [{ n: "ten" }, { n: "" }, { n: "1", on: "yes" }, { n: "1", on: "TRUE" }] as Record<
      string,
      string
    >[]) {
      expect(await rule(w.start("tasks/typed", values))).toBe(BAD_VALUE);
    }
    expect(ran("typed")).toBe(refused);
    expect(json(await w.start("tasks/schemas", { i: "3", o: '{"a":1}' }))).toEqual({ i: 3, o: { a: 1 } });
    expect(await rule(w.start("tasks/schemas", { i: "2.5" }))).toBe(BAD_VALUE);
    // a calling step's args: give strings and numbers; literals are checked first, the rest when the step runs
    expect(json(json(await w.start("tasks/literal")).t)).toEqual({ n: 7, on: true, s: "3" });
    expect(json(await w.start("tasks/from-step")).n).toBe(12);
    expect(await rule(w.start("tasks/from-bad-step"))).toBe(RUN_FAILED);
    expect(await rule(w.start("tasks/not-a-number"))).toBe(BAD_VALUE);
    expect(ran("literal")).toBe(1);
  });
});

describe("the history of a run", () => {
  test("one row per run and per step, in the vocabulary a steps task has, with the kinds of version 5", async () => {
    const { readTaskHistory } = await import("../../../../src/tasks/run/task-history");
    const w = world({
      assets: { "scripts/s.sh": "printf s\n" },
      tasks: {
        "tasks/inner": { exec: "printf inner" },
        "tasks/t": {
          steps: [
            { name: "e", exec: "printf e" },
            { name: "s", run: "scripts/s.sh" },
            { name: "p", prompt: "Hi." },
            { name: "t", run: "tasks/inner" },
            { name: "boom", exec: "exit 3" },
            { name: "never", exec: "true" },
          ],
        },
      },
      agent: () => "ok",
    });
    expect(await message(w.start("tasks/t"))).toBe("step boom: non_zero_exit: exit code 3");
    const [outer] = readTaskHistory({ id: "t", limit: 1 });
    expect(outer?.status).toBe("failed");
    expect(outer?.steps?.map((step) => [step.name, step.kind, step.status])).toEqual([
      ["e", "exec", "completed"],
      ["s", "run", "completed"],
      ["p", "prompt", "completed"],
      ["t", "run", "completed"],
      ["boom", "exec", "failed"],
      ["never", "exec", "skipped"],
    ]);
    const [inner] = readTaskHistory({ id: "inner", limit: 1 });
    expect(inner?.status).toBe("completed");
    expect(inner?.run?.parent).toMatchObject({ task: "t", step: "t" });
  });

  test("the result of a run that succeeds is the task's result, and a failed run has none", async () => {
    const { runTask } = await import("../../../../src/tasks/run/run-task");
    const w = world({ tasks: { "tasks/ok": { exec: "printf fine" }, "tasks/bad": { exec: "printf partial; false" } } });
    const options = { bundleDir: path.join(w.scratch, "stash"), bundleName: "stash", adapterId: "akm" };
    const ok = await runTask("ok", options);
    expect(ok).toMatchObject({ status: "completed", result: "fine" });
    const bad = await runTask("bad", options);
    expect(bad.status).toBe("failed");
    expect(bad.result).toBeUndefined();
  });
});

describe("how a step fails", () => {
  test("a command killed by a signal has failed: the run stops there and says so", async () => {
    const w = world({
      tasks: {
        "tasks/t": {
          steps: [
            { name: "killed", exec: "kill -9 $$" },
            { name: "after", exec: count("after") },
          ],
        },
      },
    });
    expect(await rule(w.start("tasks/t"))).toBe(RUN_FAILED);
    expect(await message(w.start("tasks/t"))).toMatch(/^step killed: /);
    expect(w.history()[0]?.steps.map((step) => step.status)).toEqual(["failed", "pending"]);
    expect(ran("after")).toBe(0);
  });

  test("a command that exits 0 while a process it left behind still holds its output has failed, not succeeded", async () => {
    const holder = at("holder.pid");
    const w = world({
      tasks: {
        "tasks/t": {
          steps: [
            {
              name: "leaves-one",
              exec: `printf partial; setsid sh -c 'echo $$ > "${holder}"; exec sleep 30' & exit 0`,
            },
            { name: "after", exec: count("after") },
          ],
        },
      },
    });
    try {
      expect(await message(w.start("tasks/t"))).toMatch(/^step leaves-one: .*drain timed out/);
      expect(ran("after")).toBe(0);
    } finally {
      if (fs.existsSync(holder)) {
        try {
          process.kill(Number(fs.readFileSync(holder, "utf8").trim()), "SIGKILL");
        } catch {
          // the holder is already gone
        }
      }
    }
  }, 30_000);

  /** Tells the run akm is stopping, as a SIGTERM to akm does, once a step has written `started`. */
  async function stopRunOnceStarted(): Promise<void> {
    for (let tries = 0; tries < 200 && !fs.existsSync(at("started")); tries++) await Bun.sleep(25);
    expect(fs.existsSync(at("started"))).toBe(true);
    // The test runner's own SIGTERM listener would end this process, so only the run's listener, the last one, is called.
    const ours = process.listeners("SIGTERM").at(-1) as (() => void) | undefined;
    if (!ours) throw new Error("the run did not listen for SIGTERM");
    ours();
  }

  test("a run that is stopped does not start a step's retries", async () => {
    const w = world({
      tasks: {
        "tasks/t": {
          steps: [{ name: "slow", exec: `touch "${at("started")}"; ${count("attempts")}; sleep 30`, "max-retries": 3 }],
        },
      },
    });
    const finished = message(w.start("tasks/t"));
    await stopRunOnceStarted();
    expect(await finished).toMatch(/^step slow: /);
    await Bun.sleep(300);
    expect(ran("attempts")).toBe(1);
    const { readTaskHistory } = await import("../../../../src/tasks/run/task-history");
    expect(readTaskHistory({ id: "t", limit: 1 })[0]?.steps?.map((step) => step.attempts)).toEqual([1]);
  });

  test("a step that runs a task the run was stopped in has failed, and nothing after it runs", async () => {
    const w = world({
      tasks: {
        "tasks/slow": { exec: `touch "${at("started")}"; sleep 30` },
        "tasks/t": {
          steps: [
            { name: "call", run: "tasks/slow" },
            { name: "after", exec: count("after") },
          ],
        },
      },
    });
    const finished = rule(w.start("tasks/t"));
    await stopRunOnceStarted();
    expect(await finished).toBe(RUN_FAILED);
    await Bun.sleep(300);
    expect(ran("after")).toBe(0);
  });
});
