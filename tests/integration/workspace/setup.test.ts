// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** `setup.detect` and `setup.apply` of `src/workspace/setup.ts` against a sandbox: the child is the real `akm setup`. */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmExtract, resolveStandaloneExtractPlan } from "../../../src/commands/improve/extract";
import { loadConfig } from "../../../src/core/config/config";
import { getConfigPath } from "../../../src/core/paths";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../../src/core/warn";
import { setup, tasks } from "../../../src/workspace";
import { change } from "../../../src/workspace/config";
import { ctx, expectUsage, fakeCrontab, useSandbox } from "./workspace-behaviour-helpers";

useSandbox();
// Detection reads the home directory, which is the machine's own unless a test gives it another.
let realHome: string | undefined;
beforeEach(() => {
  realHome = process.env.HOME;
  process.env.HOME = path.join(ctx.storage.root, "home");
  fs.mkdirSync(process.env.HOME);
});
afterEach(() => {
  process.env.HOME = realHome;
  _resetWarnOnceForTests();
  _setWarnSinkForTests();
});

const library = () => path.join(ctx.storage.root, "library");
const savedConfig = () => JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
/** A `claude` on PATH for this test, which setup's detection finds as an installed agent program. */
function claudeOnPath() {
  const bin = path.join(ctx.storage.root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\necho 2.1.283\n", { mode: 0o755 });
  const before = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${before}`;
  return () => {
    process.env.PATH = before;
  };
}

type Detected = Awaited<ReturnType<typeof setup.detect>>;

describe("setup.apply", () => {
  test("creates the library and the config, and a second run changes nothing", async () => {
    const dir = library();
    const first = (await setup.apply({ dir })) as Detected;
    expect(first.stashDir).toBe(dir);
    expect(fs.existsSync(path.join(dir, "knowledge"))).toBe(true);
    const config = savedConfig();
    expect(Object.values(config.bundles)).toContainEqual(expect.objectContaining({ path: dir, writable: true }));
    expect(config.defaultBundle).toBeDefined();

    const before = fs.readFileSync(getConfigPath(), "utf8");
    await setup.apply({ dir });
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
  });

  test("learning off writes only the switch: no task, no placement, nothing routed", async () => {
    const restore = claudeOnPath();
    const cron = fakeCrontab();
    try {
      const after = await setup.apply({ dir: library(), harness: ["claude"], learning: { on: false } });
      const config = savedConfig();
      expect(config.improve).toEqual({ enabled: false });
      expect(config.improve.connection).toBeUndefined();
      expect(config.improve.harness).toBeUndefined();
      expect(config.harnesses.claude.modelWork).toBeUndefined();
      expect(after.enabled).toEqual(["claude"]);
      expect(after.learning).toEqual({ on: false, harness: "claude", scheduled: false });
      expect(tasks.list().tasks).toEqual([]);
      expect(fs.existsSync(cron.file)).toBe(false);
    } finally {
      cron.restore();
      restore();
    }
  });

  test("a standalone extract makes no model call while learning is off", async () => {
    await setup.apply({ dir: library(), learning: { on: false } });
    change({
      set: { "connections.lab.endpoint": "http://localhost:1/v1", "connections.lab.models.fast": "m" },
      unset: [],
    });
    const plan = resolveStandaloneExtractPlan(loadConfig(), {});
    expect(plan).toMatchObject({ enabled: false, runner: null });
    const fetched = spyOn(globalThis, "fetch");
    const result = await akmExtract({ type: "claude", config: loadConfig(), resolvedPlan: plan, dryRun: true });
    expect(result).toMatchObject({ ok: true, sessionsProcessed: 0, sessionsSkipped: 0 });
    expect(fetched).not.toHaveBeenCalled();
    fetched.mockRestore();
  });

  test("learning on through akm itself writes the connection, removes the switch and enables the improve task", async () => {
    const cron = fakeCrontab();
    try {
      await setup.apply({ dir: library(), learning: { on: false } });
      const after = await setup.apply({
        dir: library(),
        connection: { endpoint: "http://localhost:1234", model: "qwen", apiKeyEnv: "LAB_KEY" },
        learning: { on: true },
      });
      const config = savedConfig();
      expect(config.connections.default).toMatchObject({
        endpoint: "http://localhost:1234/v1",
        apiKey: "$LAB_KEY",
        models: { fast: "qwen", balanced: "qwen", reasoning: "qwen" },
      });
      expect(config.improve.connection).toBe("default");
      expect(config.improve.harness).toBeUndefined();
      expect(config.improve.enabled).toBeUndefined();
      expect(config.scheduler.enabled).toEqual([expect.stringMatching(/\/\/tasks\/improve$/)]);
      expect(fs.readFileSync(cron.file, "utf8")).toContain("improve");
      expect(after.learning).toEqual({ on: true, harness: null, scheduled: true });
      expect(after.connection).toBe("default");
      expect(after.modelCalls.description).toContain('connection "default"');
      expect(tasks.list().tasks).toEqual([expect.objectContaining({ id: "improve", enabled: true })]);

      // Off again writes the switch; the schedule and the connection stay.
      const off = await setup.apply({ dir: library(), learning: { on: false } });
      expect(off.learning).toEqual({ on: false, harness: null, scheduled: true });
      expect(savedConfig().improve.enabled).toBe(false);
      expect(tasks.list().tasks[0]?.enabled).toBe(true);
      expect(savedConfig().connections.default.apiKey).toBe("$LAB_KEY");
    } finally {
      cron.restore();
    }
  });

  test("learning reads on wherever model calls already run, and a new endpoint keeps no old key", async () => {
    await setup.apply({ dir: library() });
    change({
      set: {
        "connections.default.endpoint": "http://old:1/v1",
        "connections.default.apiKey": "$OLD_KEY",
        "connections.default.models.fast.model": "x",
        "connections.default.models.fast.temperature": "0.2",
      },
      unset: [],
    });
    // No improve task and no switch: a session-end extract would still call the model, so learning is on.
    expect((await setup.detect()).learning).toEqual({ on: true, harness: null, scheduled: false });
    await setup.apply({ dir: library(), connection: { endpoint: "http://new:1", model: "m" } });
    const connection = savedConfig().connections.default;
    // As `akm setup`: the old endpoint's key is not sent to the new one, and an alias keeps its request fields.
    expect(connection.apiKey).toBeUndefined();
    expect(connection.models).toEqual({ fast: { model: "m", temperature: 0.2 }, balanced: "m", reasoning: "m" });
    expect(savedConfig().improve).toBeUndefined();
  });

  test("saving with learning on gives an already-on setup its improve task, and keeps an improve connection of its own", async () => {
    const cron = fakeCrontab();
    try {
      await setup.apply({ dir: library() });
      change({
        set: {
          "connections.default.endpoint": "http://old:1/v1",
          "connections.other.endpoint": "http://other:1/v1",
          "connections.other.models.fast": "m",
          "connections.other.models.balanced": "m",
          "connections.other.models.reasoning": "m",
          "improve.connection": "other",
        },
        unset: [],
      });
      // On already (akm's model calls run), but nothing is scheduled.
      expect((await setup.detect()).learning.on).toBe(true);
      expect(tasks.list().tasks).toEqual([]);
      await setup.apply({ dir: library(), learning: { on: true } });
      expect(tasks.list().tasks).toEqual([expect.objectContaining({ id: "improve", enabled: true })]);
      expect(fs.readFileSync(cron.file, "utf8")).toContain("improve");
      expect(savedConfig().improve.connection).toBe("other");
      // A save with it already enabled changes nothing.
      const before = fs.readFileSync(getConfigPath(), "utf8");
      await setup.apply({ dir: library(), learning: { on: true } });
      expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    } finally {
      cron.restore();
    }
  });

  test("learning off leaves the schedule alone", async () => {
    const cron = fakeCrontab();
    try {
      const dir = library();
      await setup.apply({ dir });
      change({ set: { "connections.default.endpoint": "http://old:1/v1" }, unset: [] });
      await setup.apply({ dir, learning: { on: true } });
      const scheduled = fs.readFileSync(cron.file, "utf8");
      await setup.apply({ dir, learning: { on: false } });
      expect(tasks.list().tasks).toEqual([expect.objectContaining({ id: "improve", enabled: true })]);
      expect(fs.readFileSync(cron.file, "utf8")).toBe(scheduled);
    } finally {
      cron.restore();
    }
  });

  test("learning on an enabled agent writes improve.harness to its entry and no connection", async () => {
    const restore = claudeOnPath();
    fs.writeFileSync(path.join(ctx.storage.root, "bin", "codex"), "#!/bin/sh\necho 1\n", { mode: 0o755 });
    const cron = fakeCrontab();
    try {
      const after = await setup.apply({
        dir: library(),
        harness: ["claude", "codex"],
        connection: { endpoint: "http://localhost:1/v1", model: "m" },
        learning: { on: true, harness: "codex" },
      });
      // Several agents leave one default harness, named `default`; the other keeps its platform name.
      expect(Object.keys(savedConfig().harnesses).sort()).toEqual(["codex", "default"]);
      expect(savedConfig().harnesses.default.platform).toBe("claude");
      expect(savedConfig().improve.harness).toBe("codex");
      expect(savedConfig().improve.connection).toBeUndefined();
      expect(after.learning).toEqual({ on: true, harness: "codex", scheduled: true });
      expect(after.modelCalls.platform).toBe("codex");
    } finally {
      cron.restore();
      restore();
    }
  });

  test("learning on with no connection and no agent stays off, with one warning", async () => {
    const warned: string[] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warned.push(String(args[0]));
    });
    const cron = fakeCrontab();
    try {
      const after = await setup.apply({ dir: library(), learning: { on: true } });
      expect(after.learning.on).toBe(false);
      expect(warned.some((line) => line.includes("no connection to learn through"))).toBe(true);
      expect(tasks.list().tasks).toEqual([]);
    } finally {
      cron.restore();
    }
  });

  test("learning on an agent that is not enabled is ignored with a warning", async () => {
    const warned: string[] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warned.push(String(args[0]));
    });
    const restore = claudeOnPath();
    const cron = fakeCrontab();
    try {
      const after = await setup.apply({
        dir: library(),
        harness: ["claude"],
        learning: { on: true, harness: "codex" },
      });
      expect(after.learning.on).toBe(false);
      expect(savedConfig().improve.harness).toBeUndefined();
      expect(warned.some((line) => line.includes("codex is not enabled"))).toBe(true);
    } finally {
      cron.restore();
      restore();
    }
  });

  test("a key is only ever the name of a variable", async () => {
    await expectUsage(
      () =>
        setup.apply({
          dir: library(),
          connection: { endpoint: "http://localhost:1/v1", model: "m", apiKeyEnv: "sk-abc-123456" },
          learning: { on: true },
        }),
      undefined,
      "variable",
    );
    await expectUsage(
      () => setup.apply({ dir: library(), connection: { endpoint: "ftp://x", model: "m" } }),
      undefined,
      "http",
    );
    expect(fs.existsSync(getConfigPath()) ? JSON.stringify(savedConfig()) : "").not.toContain("sk-abc");
  });

  test("an agent program on PATH is not enabled unless named, in one write", async () => {
    const restore = claudeOnPath();
    try {
      const after = await setup.apply({ dir: library() });
      expect(savedConfig().harnesses).toBeUndefined();
      expect(after.modelCalls.platform).toBeNull();
      expect(after.harnesses.map((item) => item.platform)).toContain("claude");
    } finally {
      restore();
    }
  });

  test("a harness already configured is left as it is", async () => {
    await setup.apply({ dir: library(), harness: ["claude"] });
    const before = fs.readFileSync(getConfigPath(), "utf8");
    await setup.apply({ dir: library() });
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
  });

  test("an unknown field is ignored with one warning", async () => {
    const warned: string[] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warned.push(String(args[0]));
    });
    await setup.apply({ dir: library(), endpoint: "http://localhost:1/v1" } as never);
    await setup.apply({ dir: library(), endpoint: "http://localhost:1/v1" } as never);
    expect(warned.filter((line) => line.includes('unknown field "endpoint"'))).toHaveLength(1);
    expect(JSON.stringify(savedConfig())).not.toContain("localhost:1");
  });

  test("refuses a relative directory and an unknown agent program", async () => {
    await expectUsage(() => setup.apply({ dir: "library" }), undefined, "absolute");
    await expectUsage(() => setup.apply({ dir: library(), harness: ["nonesuch"] }), "INVALID_FLAG_VALUE");
  });
});

describe("setup.detect", () => {
  test("suggests the library the config already has", async () => {
    const dir = library();
    await setup.apply({ dir });
    expect((await setup.detect()).stashDir).toBe(dir);
  });

  test("reports the library location and agent programs without writing or contacting anything", async () => {
    const restore = claudeOnPath();
    const fetched = spyOn(globalThis, "fetch");
    try {
      const found = await setup.detect();
      expect(path.isAbsolute(found.stashDir)).toBe(true);
      expect(found.harnesses.map((item) => item.platform)).toContain("claude");
      expect(fetched).not.toHaveBeenCalled();
      expect(fs.existsSync(getConfigPath())).toBe(false);
    } finally {
      fetched.mockRestore();
      restore();
    }
  });
});
