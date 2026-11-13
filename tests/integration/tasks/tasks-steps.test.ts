// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Experimental `steps:` tasks: real `sh` steps, a fake agent, the real history and lock. */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { releaseLock } from "../../../src/core/file-lock";
import { tryAcquireRunLock } from "../../../src/core/run-lock";
import { openStateDatabase } from "../../../src/core/state-db";
import { decodeTaskHistoryMetadata } from "../../../src/storage/repositories/task-history-repository";
import { runTask } from "../../../src/tasks/run/run-task";
import { readTaskHistory } from "../../../src/tasks/run/task-history";
import type { TaskRunResult } from "../../../src/tasks/run/task-result";
import { taskHistory } from "../../../src/workspace/activity";
import { makeSandboxDir } from "../../_helpers/sandbox";

const sandbox = makeSandboxDir("akm-tasks-steps");
const root = sandbox.dir;
const bundleDir = path.join(root, "stash");
const stateDir = path.join(root, "state");
const logDir = path.join(root, "cache", "tasks", "logs");
const configDir = path.join(root, "cfg");
const work = path.join(root, "work");
const KEYS = ["AKM_CONFIG_DIR", "AKM_CACHE_DIR", "AKM_DATA_DIR", "AKM_STATE_DIR"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  for (const dir of [bundleDir, stateDir, configDir, work, path.join(root, "cache"), path.join(root, "data")]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(bundleDir, "tasks"), { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  process.env.AKM_DATA_DIR = path.join(root, "data");
  process.env.AKM_CONFIG_DIR = configDir;
  process.env.AKM_CACHE_DIR = path.join(root, "cache");
  process.env.AKM_STATE_DIR = stateDir;
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ configVersion: "0.9.0", harnesses: { opencode: { platform: "opencode" } } }),
  );
});
afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});
afterAll(() => sandbox.cleanup());

const write = (id: string, body: string) => fs.writeFileSync(path.join(bundleDir, "tasks", `${id}.yml`), body);
const run = (id: string, extra: Record<string, unknown> = {}): Promise<TaskRunResult> =>
  runTask(id, { bundleDir, logDir, ...extra });
const file = (name: string) => path.join(work, name);
const read = (name: string) => fs.readFileSync(file(name), "utf8");

type Reply = { ok: true; exitCode: 0; stdout: string; stderr: ""; durationMs: 1 };
const reply = (stdout: string): Reply => ({ ok: true, exitCode: 0, stdout, stderr: "", durationMs: 1 });

describe("steps tasks: running", () => {
  test("steps run in order, see AKM_PARAMS and AKM_STEPS, never AKM_INPUTS; history records each step", async () => {
    write(
      "plan",
      `version: 4
inputs:
  site: { type: string, default: "example.org" }
steps:
  - name: first
    run: printf 'one' ; printf '%s' "$AKM_STEPS" > ${file("steps-1")}; printf '%s' "$AKM_PARAMS" > ${file("params-1")}
  - name: second
    run: printf '%s|%s' "$AKM_STEPS" "\${AKM_INPUTS-unset}" > ${file("steps-2")}; echo two
`,
    );
    const result = await run("plan");
    expect(result.status).toBe("completed");
    expect(read("steps-1")).toBe("{}");
    expect(read("params-1")).toBe('{"site":"example.org"}');
    expect(read("steps-2")).toBe('{"first":"one"}|unset');
    expect(result.steps?.map((s) => [s.name, s.status, s.summary])).toEqual([
      ["first", "completed", "one"],
      ["second", "completed", "two"],
    ]);
    expect(result.steps?.every((s) => s.result === undefined)).toBe(true);
    const [stored] = readTaskHistory({ id: "plan", limit: 1 });
    expect(stored?.target).toEqual({ kind: "steps" });
    expect(stored?.steps).toHaveLength(2);
  });

  test("Desktop's task history read carries the steps without their stored results", async () => {
    write("shown", "version: 4\nsteps:\n  - { name: a, run: 'printf keep' }\n  - { name: b, run: 'false' }\n");
    await run("shown");
    const { runs } = taskHistory({ taskId: "shown" });
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.steps?.map((step) => [step.name, step.status])).toEqual([
      ["a", "completed"],
      ["b", "failed"],
    ]);
    expect(JSON.stringify(runs[0]?.steps)).not.toContain("result");
  });

  test("a failed step stops the run, later steps are skipped, retries rerun the step", async () => {
    write(
      "flaky",
      `version: 4
steps:
  - name: retried
    retries: 1
    run: echo x >> ${file("count")}; test "$(wc -l < ${file("count")})" -ge 2
  - name: boom
    run: echo oops >&2; exit 3
  - name: never
    run: touch ${file("never")}
`,
    );
    const result = await run("flaky");
    expect(result.status).toBe("failed");
    expect(result.detail).toEqual({ reason: "step_failed", error: "boom: exit code 3" });
    expect(result.steps?.map((s) => [s.name, s.status, s.attempts])).toEqual([
      ["retried", "completed", 2],
      ["boom", "failed", 1],
      ["never", "skipped", 0],
    ]);
    expect(fs.existsSync(file("never"))).toBe(false);
  });

  test("--resume restarts at the failed step and reuses earlier results", async () => {
    write(
      "resumable",
      `version: 4
steps:
  - name: expensive
    run: echo run >> ${file("expensive")}; printf 'big-result'
  - name: gate
    run: test -f ${file("ok")} && printf '%s' "$AKM_STEPS" > ${file("seen")}
`,
    );
    expect((await run("resumable")).status).toBe("failed");
    const [failed] = readTaskHistory({ id: "resumable", limit: 1 });
    expect(failed?.steps?.[0]?.result).toBe("big-result");
    fs.writeFileSync(file("ok"), "");
    const resumed = await run("resumable", { inputFlags: [{ name: "resume", value: true }] });
    expect(resumed.status).toBe("completed");
    expect(resumed.steps?.map((s) => s.status)).toEqual(["reused", "completed"]);
    expect(read("expensive").trim().split("\n")).toHaveLength(1);
    expect(read("seen")).toBe('{"expensive":"big-result"}');
  });

  test("--resume refuses with nothing to resume or after the steps changed", async () => {
    write("fresh", "version: 4\nsteps:\n  - { name: a, run: 'true' }\n");
    await expect(run("fresh", { inputFlags: [{ name: "resume", value: true }] })).rejects.toThrow(
      "no failed steps run",
    );
    write("changes", "version: 4\nsteps:\n  - { name: a, run: 'false' }\n");
    expect((await run("changes")).status).toBe("failed");
    write("changes", "version: 4\nsteps:\n  - { name: b, run: 'false' }\n");
    await expect(run("changes", { inputFlags: [{ name: "resume", value: true }] })).rejects.toThrow(
      "changed its steps",
    );
  });

  test("--resume stays an ordinary input flag for a task without steps", async () => {
    write("plain", "version: 4\nrun: 'true'\n");
    await expect(run("plain", { inputFlags: [{ name: "resume", value: true }] })).rejects.toThrow(/resume/);
    write("declared", "version: 4\ninputs:\n  resume: { type: boolean, default: false }\nrun: 'true'\n");
    expect((await run("declared", { inputFlags: [{ name: "resume", value: true }] })).status).toBe("completed");
  });

  test("a step that exceeds its timeout fails with timeout", async () => {
    write("slow", "version: 4\nsteps:\n  - { name: sleepy, run: 'sleep 5', timeout: 0 }\n");
    // timeout 0 is the v4 "no limit"; use a real bound via the task-level key instead.
    write("slow", "version: 4\ntimeout: 1\nsteps:\n  - { name: sleepy, run: 'sleep 5' }\n");
    const result = await run("slow");
    expect(result.status).toBe("failed");
    expect(result.steps?.[0]?.reason).toBe("timeout");
  });
});

describe("steps tasks: prompt steps and the reply check", () => {
  test("a prompt step receives values as text; expect re-asks once, then AKM_STEPS carries the parsed object", async () => {
    write(
      "agentic",
      `version: 4
harness: opencode
inputs:
  topic: { type: string, default: "tides" }
steps:
  - name: draft
    prompt: Write about the topic.
    expect: [title, actions]
  - name: use
    run: printf '%s' "$AKM_STEPS" > ${file("seen")}
`,
    );
    const prompts: string[] = [];
    const replies = ['{"title": "T"}', '```json\n{"title": "T", "actions": ["a"]}\n```'];
    const result = await run("agentic", {
      runAgentImpl: async (...args: unknown[]) => {
        prompts.push((args[1] as { dispatch: { prompt: string } }).dispatch.prompt);
        return reply(replies[prompts.length - 1] as string);
      },
    });
    expect(result.status).toBe("completed");
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("## Task values");
    expect(prompts[0]).toContain('"topic": "tides"');
    expect(prompts[0]).toContain("Respond with ONLY a JSON value matching this JSON Schema");
    expect(prompts[1]).toContain("the reply lacks: actions");
    expect(JSON.parse(read("seen"))).toEqual({ draft: { title: "T", actions: ["a"] } });
  });

  test("a reply that still fails the check fails the step with reply_check_failed", async () => {
    write("strict", "version: 4\nharness: opencode\nsteps:\n  - { name: draft, prompt: Say hi, expect: [k] }\n");
    let calls = 0;
    const result = await run("strict", {
      runAgentImpl: async () => {
        calls += 1;
        return reply("no json here");
      },
    });
    expect(calls).toBe(2);
    expect(result.status).toBe("failed");
    expect(result.steps?.[0]?.reason).toContain("reply_check_failed");
  });

  test("earlier results reach a later prompt step", async () => {
    write(
      "chain",
      `version: 4
harness: opencode
steps:
  - { name: a, run: printf 'alpha' }
  - { name: b, prompt: Continue }
`,
    );
    let prompt = "";
    await run("chain", {
      runAgentImpl: async (...args: unknown[]) => {
        prompt = (args[1] as { dispatch: { prompt: string } }).dispatch.prompt;
        return reply("done");
      },
    });
    expect(prompt).toContain("## Earlier steps");
    expect(prompt).toContain('"a": "alpha"');
  });
});

describe("steps tasks: task steps, overlap, history", () => {
  test("a task step checks and runs through the injected runner", async () => {
    write("caller", "version: 4\nsteps:\n  - { name: notify, task: tasks/notify }\n");
    const seen: string[] = [];
    const finished = {
      id: "notify",
      status: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 1000,
      log: "",
      target: { kind: "shell" },
    } as const;
    const result = await run("caller", {
      taskStepRunner: {
        check: async (ref: string) => void seen.push(`check ${ref}`),
        run: async (ref: string) => (seen.push(`run ${ref}`), finished),
      },
    });
    expect(seen).toEqual(["check stash//tasks/notify", "run stash//tasks/notify"]);
    expect(result.steps?.[0]).toMatchObject({ kind: "task", status: "completed", startedAt: finished.startedAt });
  });

  test("a run does not start while the previous one is alive: manual errors, scheduled skips without a history row", async () => {
    write("busy", "version: 4\nsteps:\n  - { name: a, run: 'true' }\n");
    const lockPath = path.join(stateDir, "locks", "task-busy.lock");
    const held = tryAcquireRunLock(lockPath, { label: "task" });
    expect(held.state).toBe("acquired");
    try {
      await expect(run("busy")).rejects.toThrow("still running");
      const skipped = await run("busy", { scheduled: true });
      expect(skipped.status).toBe("active");
      expect(skipped.detail).toEqual({ reason: "previous_run_active" });
      expect(readTaskHistory({ id: "busy", limit: 5 })).toHaveLength(0);
    } finally {
      if (held.state === "acquired") releaseLock(held.ownership);
    }
    expect((await run("busy")).status).toBe("completed");
  });

  test("a dead holder's lock is reclaimed", async () => {
    write("stale", "version: 4\nsteps:\n  - { name: a, run: 'true' }\n");
    fs.mkdirSync(path.join(stateDir, "locks"), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "locks", "task-stale.lock"),
      JSON.stringify({ pid: 2 ** 22 + 12345, lockId: "x" }),
    );
    expect((await run("stale")).status).toBe("completed");
  });

  test("history metadata with and without steps decodes; a malformed steps value is dropped", () => {
    const plain = decodeTaskHistoryMetadata({ metadataVersion: 2, durationMs: 1, detail: null });
    expect(plain.steps).toBeUndefined();
    const bad = decodeTaskHistoryMetadata({ metadataVersion: 2, durationMs: 1, detail: null, steps: "nope" });
    expect(bad.steps).toBeUndefined();
    const ok = decodeTaskHistoryMetadata({
      metadataVersion: 2,
      durationMs: 1,
      detail: null,
      steps: [{ name: "a", kind: "run", status: "completed", durationMs: 2, attempts: 1 }, { name: 3 }],
    });
    expect(ok.steps).toEqual([{ name: "a", kind: "run", status: "completed", durationMs: 2, attempts: 1 }]);
    openStateDatabase().close();
  });
});
