// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Experimental `steps:` in task source v4: grammar, rejections, and that existing selectors are untouched. */

import { describe, expect, test } from "bun:test";
import { parseTaskSourceV4 } from "../../src/tasks/source/task-source-v4";

const parse = (yaml: string) => parseTaskSourceV4({ yaml, filePath: "tasks/t.yml" });
const rejects = (yaml: string, text: string) => expect(() => parse(yaml)).toThrow(text);

const FULL = `
version: 4
name: Plan
inputs:
  site: { type: string, default: "x" }
schedule: "30 6 * * *"
timeout: 10m
harness: scheduled
shell: bash
env: { LOG_LEVEL: info }
steps:
  - name: sync-docs
    run: bun scripts/sync.ts
  - name: fetch
    run: bun scripts/fetch.ts
    env: { REGION: eu }
    retries: 1
    timeout: 2m
  - name: write-plan
    prompt: commands/lab/write-plan
    harness: scheduled
    expect: [title, actions]
  - name: say
    prompt: Summarize the plan in one line.
  - name: notify
    task: tasks/notify
`;

describe("task source v4 steps (Experimental)", () => {
  test("parses the full example", () => {
    const doc = parse(FULL);
    expect(doc.target.kind).toBe("steps");
    if (doc.target.kind !== "steps") return;
    expect(doc.target.shell).toBe("bash");
    expect(doc.target.steps.map((step) => `${step.name}:${step.kind}`)).toEqual([
      "sync-docs:run",
      "fetch:run",
      "write-plan:prompt",
      "say:prompt",
      "notify:task",
    ]);
    const [, fetch, plan, say, notify] = doc.target.steps;
    expect(fetch).toMatchObject({ retries: 1, timeout: "2m", env: { REGION: "eu" } });
    expect(plan).toMatchObject({
      prompt: { kind: "ref", ref: "commands/lab/write-plan" },
      expect: ["title", "actions"],
    });
    expect(say).toMatchObject({ prompt: { kind: "inline", content: "Summarize the plan in one line." } });
    expect(notify).toMatchObject({ ref: "tasks/notify" });
    expect(doc.schedule).toHaveLength(1);
  });

  test("exactly one of uses, run, steps", () => {
    rejects("version: 4\nrun: echo\nsteps:\n  - { name: a, run: echo }\n", "requires exactly one executable selector");
    rejects(
      "version: 4\nuses: commands/x\nsteps:\n  - { name: a, run: echo }\n",
      "requires exactly one executable selector",
    );
    rejects("version: 4\n", "requires exactly one executable selector");
  });

  test("task-level keys that mean nothing next to steps are rejected", () => {
    for (const extra of ["output: { type: object }", "maxRetries: 1", "maxSteps: 3"]) {
      rejects(`version: 4\nsteps:\n  - { name: a, run: echo }\n${extra}\n`, "not legal next to steps");
    }
  });

  test("step shape rules", () => {
    rejects("version: 4\nsteps: []\n", "must be a list of 1 to 32 steps");
    rejects("version: 4\nsteps:\n  - { name: a }\n", "exactly one of run, prompt or task");
    rejects("version: 4\nsteps:\n  - { name: a, run: x, task: tasks/y }\n", "exactly one of run, prompt or task");
    rejects("version: 4\nsteps:\n  - { name: a, run: x, expect: [k] }\n", "legal only on a prompt step");
    rejects(
      "version: 4\nsteps:\n  - { name: a, run: x }\n  - { name: a, run: y }\n",
      "duplicates an earlier step name",
    );
    rejects("version: 4\nsteps:\n  - { name: 'a b', run: x }\n", "must be 1-64 letters");
    rejects("version: 4\nsteps:\n  - { name: a, run: x, retries: 9 }\n", "integer from 0 to 5");
    rejects("version: 4\nsteps:\n  - { name: a, prompt: x, expect: [] }\n", "non-empty list of distinct");
    rejects("version: 4\nsteps:\n  - { name: a, task: commands/y }\n", "canonical tasks/ ref");
    rejects("version: 4\nsteps:\n  - { name: a, prompt: scripts/y.sh }\n", "names a non-command asset");
    rejects("version: 4\nsteps:\n  - { name: a, run: x, bogus: 1 }\n", "unsupported field");
    const many = Array.from({ length: 33 }, (_, i) => `  - { name: s${i}, run: x }`).join("\n");
    rejects(`version: 4\nsteps:\n${many}\n`, "must be a list of 1 to 32 steps");
  });

  test("an input named resume is rejected only next to steps", () => {
    rejects(
      "version: 4\ninputs:\n  resume: { type: boolean, default: false }\nsteps:\n  - { name: a, run: x }\n",
      "--resume",
    );
    const doc = parse("version: 4\ninputs:\n  resume: { type: boolean, default: false }\nrun: echo\n");
    expect(doc.target.kind).toBe("run");
  });

  test("existing run and uses tasks parse as before", () => {
    expect(parse("version: 4\nrun: echo hi\n").target.kind).toBe("run");
    expect(parse("version: 4\nuses: commands/review\n").target.kind).toBe("uses");
  });
});
