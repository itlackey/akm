// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `assetEngineKeys` step: `engine:` on commands, agents, workflows and task
 * sources becomes `connection:` or `harness:` by the kind of thing the name is
 * now, under one backup per run. The pure planner is tested on its own; the step
 * runs through `runMigration` against an isolated bundle.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { planEngineKeyFile, type ResolveEngineKey } from "../../scripts/akm-migrate/migrate/engine-key-planner";
import { runMigration } from "../../scripts/akm-migrate/run-migrate";
import { resetConfigCache } from "../../src/core/config/config";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

describe("planEngineKeyFile", () => {
  const resolve: ResolveEngineKey = (engine) =>
    engine === "lab" ? { key: "connection", name: "default" } : { key: "harness", name: engine };
  const plan = (role: "command" | "workflow" | "task", text: string) =>
    planEngineKeyFile({ filePath: "/x", bytes: Buffer.from(text), mode: 0o644, role, writable: true }, resolve);
  const after = (outcome: ReturnType<typeof plan>): string => {
    if (outcome.status !== "changed") throw new Error(`expected a change, got ${outcome.status}`);
    return outcome.after.toString("utf8");
  };

  test("rewrites only the key and the name, leaving comments, quoting, order and line endings as written", () => {
    const text =
      '---\r\nname: review # who reviews\r\nakm:\r\n  "engine": "lab"   # the model\r\n  model: fast\r\n---\r\n\r\nBody mentions engine: lab and stays.\r\n';
    const outcome = plan("command", text);

    expect(after(outcome)).toBe(
      '---\r\nname: review # who reviews\r\nakm:\r\n  "connection": "default"   # the model\r\n  model: fast\r\n---\r\n\r\nBody mentions engine: lab and stays.\r\n',
    );
    expect(outcome).toMatchObject({ rewrites: [{ at: "akm.engine", from: "engine: lab", to: "connection: default" }] });
  });

  test("a command takes the top-level key as well as akm.engine; a workflow takes defaults, unit and map unit", () => {
    expect(after(plan("command", "---\nengine: claude\nakm:\n  engine: lab\n---\nbody\n"))).toBe(
      "---\nharness: claude\nakm:\n  connection: default\n---\nbody\n",
    );
    const workflow = [
      "---",
      "type: workflow",
      "defaults:",
      "  engine: lab",
      "steps:",
      "  - id: one",
      "    unit: { engine: claude }",
      "  - id: two",
      "    map:",
      "      over: items",
      "      unit:",
      "        engine: lab",
      "---",
      "",
    ].join("\n");
    const outcome = plan("workflow", workflow);
    expect(after(outcome)).toBe(
      workflow
        .replace("defaults:\n  engine: lab", "defaults:\n  connection: default")
        .replace("{ engine: claude }", "{ harness: claude }")
        .replace("unit:\n        engine: lab", "unit:\n        connection: default"),
    );
    expect(outcome).toMatchObject({
      rewrites: [{ at: "defaults.engine" }, { at: "steps[0].unit.engine" }, { at: "steps[1].map.unit.engine" }],
    });
  });

  test("a task source takes its top-level engine, and a markdown body or other key is never read as one", () => {
    expect(after(plan("task", "version: 4\nrun: echo\nengine: claude\n"))).toBe(
      "version: 4\nrun: echo\nharness: claude\n",
    );
    expect(plan("command", "---\nname: x\ntags: [engine]\n---\nengine: lab\n").status).toBe("unchanged");
    expect(
      plan("workflow", "---\ntype: workflow\nsteps:\n  - id: one\n    unit: { exec: { command: [a] } }\n---\n").status,
    ).toBe("unchanged");
  });

  test("a task source older than v4 is left for the task step and reported, with its bytes untouched", () => {
    for (const text of [
      "version: 2\nrun: echo\nengine: claude\n",
      "version: 3\nrun: echo\nengine: claude\n",
      "run: echo\nengine: claude\n",
    ]) {
      const outcome = plan("task", text);
      expect(outcome).toMatchObject({ status: "skipped" });
      expect((outcome as { reason: string }).reason).toContain("convert it to v4 first");
    }
    // A v2 file with no engine key is no concern of this step.
    expect(plan("task", "version: 2\nrun: echo\n").status).toBe("unchanged");
  });

  test("leaves an engine that does not name one, and a place that also names a connection or a harness, as written", () => {
    expect(plan("command", "---\nengine: null\n---\n").status).toBe("skipped");
    const both = plan("command", "---\nengine: lab\nconnection: other\n---\n");
    expect(both).toMatchObject({ status: "skipped" });
    expect((both as { reason: string }).reason).toContain("also names a connection or a harness");
  });

  test("a name that resolves with a note carries the note", () => {
    const outcome = planEngineKeyFile(
      { filePath: "/x", bytes: Buffer.from("---\nengine: ghost\n---\n"), mode: 0o644, role: "command", writable: true },
      (engine) => ({ key: "harness", name: engine, note: "check it" }),
    );
    expect(outcome).toMatchObject({ status: "changed", notes: ["engine: check it"] });
  });

  test("a file in a read-only bundle is reported, not rewritten", () => {
    const outcome = planEngineKeyFile(
      { filePath: "/x", bytes: Buffer.from("---\nengine: lab\n---\n"), mode: 0o644, role: "command", writable: false },
      resolve,
    );
    expect(outcome).toMatchObject({ status: "skipped" });
    expect((outcome as { reason: string }).reason).toContain("read-only");
  });
});

describe("the step", () => {
  let storage: IsolatedAkmStorage;
  const stash = (): string => storage.stashDir;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    resetConfigCache();
  });
  afterEach(() => {
    resetConfigCache();
    storage.cleanup();
  });

  function write(relative: string, text: string): string {
    const file = path.join(stash(), relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  }

  function configure(extra: Record<string, unknown> = {}): void {
    writeSandboxConfig({
      defaultBundle: "primary",
      bundles: {
        primary: { path: stash(), writable: true, components: { main: { root: ".", adapter: "akm" } } },
      },
      connections: { lab: { endpoint: "http://lab:8080/v1", models: { fast: "m" } } },
      harnesses: { claude: {} },
      ...extra,
    });
  }

  const FILES = {
    command: ["commands/review.md", "---\nname: review\nakm:\n  engine: lab\n---\nReview it.\n"],
    agent: ["agents/helper.md", "---\nname: helper\nengine: claude\n---\nHelp.\n"],
    workflow: [
      "workflows/nightly.md",
      "---\ntype: workflow\ndefaults:\n  engine: lab\nsteps:\n  - id: one\n    unit: { engine: claude }\n---\n",
    ],
    task: ["tasks/daily.yml", "version: 4\nrun: echo hi\nengine: lab\n"],
    untouched: ["knowledge/engine-notes.md", "---\ntitle: engines\nengine: postgres\n---\nBody.\n"],
  } as const;

  test("rewrites a command, an agent, a workflow and a task source by the kind of name, and leaves other assets alone", async () => {
    configure();
    for (const [relative, text] of Object.values(FILES)) write(relative, text);

    const plan = await runMigration({ apply: true });

    expect(plan.failedSteps).toBeUndefined();
    const summary = plan.assetEngineKeys;
    expect(summary).toMatchObject({ changed: 4, skipped: 0, applied: 4 });
    expect(fs.readFileSync(path.join(stash(), FILES.command[0]), "utf8")).toBe(
      "---\nname: review\nakm:\n  connection: lab\n---\nReview it.\n",
    );
    expect(fs.readFileSync(path.join(stash(), FILES.agent[0]), "utf8")).toBe(
      "---\nname: helper\nharness: claude\n---\nHelp.\n",
    );
    expect(fs.readFileSync(path.join(stash(), FILES.workflow[0]), "utf8")).toBe(
      "---\ntype: workflow\ndefaults:\n  connection: lab\nsteps:\n  - id: one\n    unit: { harness: claude }\n---\n",
    );
    expect(fs.readFileSync(path.join(stash(), FILES.task[0]), "utf8")).toBe(
      "version: 4\nrun: echo hi\nconnection: lab\n",
    );
    expect(fs.readFileSync(path.join(stash(), FILES.untouched[0]), "utf8")).toBe(FILES.untouched[1]);

    // One backup directory per run holds every original.
    const backup = summary?.backupPath as string;
    const backedUp = fs
      .readdirSync(path.join(backup, "files"))
      .map((name) => fs.readFileSync(path.join(backup, "files", name), "utf8"));
    expect(backedUp.sort()).toEqual([FILES.command[1], FILES.agent[1], FILES.workflow[1], FILES.task[1]].sort());

    // Nothing is left to do.
    resetConfigCache();
    const again = await runMigration({ apply: false });
    expect(again.assetEngineKeys).toMatchObject({ changed: 0 });
    expect(again.status).toBe("current");
  });

  test("--dry-run and status list the files and change none", async () => {
    configure();
    for (const [relative, text] of Object.values(FILES)) write(relative, text);

    for (const apply of [false]) {
      const plan = await runMigration({ apply });
      expect(plan.status).toBe("ready");
      expect(plan.assetEngineKeys?.changed).toBe(4);
      expect(plan.assetEngineKeys?.files.map((file) => path.relative(stash(), file.filePath)).sort()).toEqual(
        [FILES.agent[0], FILES.command[0], FILES.task[0], FILES.workflow[0]].sort(),
      );
      expect(plan.assetEngineKeys?.files.find((file) => file.filePath.endsWith("review.md"))?.rewrites).toEqual([
        { at: "akm.engine", from: "engine: lab", to: "connection: lab" },
      ]);
    }
    expect(fs.readFileSync(path.join(stash(), FILES.command[0]), "utf8")).toBe(FILES.command[1]);
  });

  test("a v2 task source still on disk is listed as skipped and left as written", async () => {
    configure();
    const file = write("tasks/old.yml", "version: 2\nrun: echo hi\nengine: lab\n");

    const plan = await runMigration({ apply: false });

    expect(plan.assetEngineKeys).toMatchObject({ changed: 0, skipped: 1 });
    expect(plan.assetEngineKeys?.files[0]).toMatchObject({ filePath: file });
    expect(plan.assetEngineKeys?.files[0]?.reason).toContain("convert it to v4 first");
    expect(fs.readFileSync(file, "utf8")).toBe("version: 2\nrun: echo hi\nengine: lab\n");
  });

  test("a name that is neither a connection nor a harness becomes harness: with a note", async () => {
    configure();
    write("agents/ghost.md", "---\nname: ghost\nengine: nowhere\n---\nBoo.\n");

    const plan = await runMigration({ apply: true });

    expect(fs.readFileSync(path.join(stash(), "agents/ghost.md"), "utf8")).toBe(
      "---\nname: ghost\nharness: nowhere\n---\nBoo.\n",
    );
    const row = plan.assetEngineKeys?.files[0];
    expect(row?.notes?.join("\n")).toContain('engine "nowhere" is neither a configured connection nor a harness');
  });

  test("a file in a read-only bundle is skipped and left as written", async () => {
    configure({
      bundles: {
        primary: {
          path: stash(),
          writable: false,
          components: { main: { root: ".", adapter: "akm", writable: false } },
        },
      },
    });
    write(FILES.command[0], FILES.command[1]);

    const plan = await runMigration({ apply: true });

    expect(plan.assetEngineKeys).toMatchObject({ changed: 0, skipped: 1 });
    expect(plan.assetEngineKeys?.files[0]?.reason).toContain("read-only");
    expect(fs.readFileSync(path.join(stash(), FILES.command[0]), "utf8")).toBe(FILES.command[1]);
  });

  test("an engine the conversion renamed is written under its new name, in the same run", async () => {
    // `lab` is the default LLM engine, so it becomes `default`; the engine that was called `default` becomes `legacy-default`.
    writeSandboxConfig({
      defaultBundle: "primary",
      bundles: {
        primary: { path: stash(), writable: true, components: { main: { root: ".", adapter: "akm" } } },
      },
      engines: {
        lab: { kind: "llm", endpoint: "http://lab:8080/v1/chat/completions", model: "qwen3-32b" },
        default: { kind: "llm", endpoint: "http://old:8080/v1/chat/completions", model: "old-model" },
        claude: { kind: "agent", platform: "claude" },
      },
      defaults: { llmEngine: "lab" },
    });
    write("commands/a.md", "---\nname: a\nakm:\n  engine: lab\n---\nA.\n");
    write("commands/b.md", "---\nname: b\nakm:\n  engine: default\n---\nB.\n");
    write("commands/c.md", "---\nname: c\nakm:\n  engine: claude\n---\nC.\n");

    const plan = await runMigration({ apply: true });

    expect(plan.failedSteps).toBeUndefined();
    expect(fs.readFileSync(path.join(stash(), "commands/a.md"), "utf8")).toContain("connection: default");
    expect(fs.readFileSync(path.join(stash(), "commands/b.md"), "utf8")).toContain("connection: legacy-default");
    expect(fs.readFileSync(path.join(stash(), "commands/c.md"), "utf8")).toContain("harness: claude");
  });

  test("the assets wait when the config step failed: nothing is rewritten and the step is absent from the plan", async () => {
    // A credentials.json akm cannot write stops the config step.
    fs.writeFileSync(path.join(process.env.XDG_CONFIG_HOME ?? "", "akm", "credentials.json"), "not json");
    writeSandboxConfig({
      defaultBundle: "primary",
      bundles: { primary: { path: stash(), writable: true, components: { main: { root: ".", adapter: "akm" } } } },
      engines: {
        lab: { kind: "llm", endpoint: "http://lab:8080/v1/chat/completions", model: "m", apiKey: "sk-literal" },
      },
      defaults: { llmEngine: "lab" },
    });
    const file = write("commands/review.md", "---\nname: review\nakm:\n  engine: lab\n---\nReview it.\n");

    const plan = await runMigration({ apply: true });

    expect(plan.failedSteps?.some((failure) => failure.step === "configFile")).toBe(true);
    expect(plan.assetEngineKeys).toBeUndefined();
    expect(fs.readFileSync(file, "utf8")).toContain("engine: lab");
  });

  test("a bundle with no engine keys is current, and a config with no bundle is no error", async () => {
    configure();
    write("commands/clean.md", "---\nname: clean\n---\nClean.\n");
    expect((await runMigration({ apply: false })).assetEngineKeys).toMatchObject({ changed: 0, skipped: 0, files: [] });
  });
});
