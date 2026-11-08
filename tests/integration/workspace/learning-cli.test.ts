// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** `akm info` learning, `akm setup --learning`, `akm proposal new --if-learning` and `setup.apply` for learning alone. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getConfigPath } from "../../../src/core/paths";
import { resolveAkmInvocation } from "../../../src/tasks/resolve-akm-bin";
import { setup } from "../../../src/workspace";
import { runCli } from "../../../src/workspace/cli-child";
import { change } from "../../../src/workspace/config";
import { ctx, fakeCrontab, type Json, useSandbox } from "./workspace-behaviour-helpers";

useSandbox();
let realHome: string | undefined;
beforeEach(() => {
  realHome = process.env.HOME;
  process.env.HOME = path.join(ctx.storage.root, "home");
  fs.mkdirSync(process.env.HOME);
});
afterEach(() => {
  process.env.HOME = realHome;
});

const library = () => path.join(ctx.storage.root, "library");
const connect = () =>
  change({
    set: {
      "connections.lab.endpoint": "http://localhost:1/v1",
      "connections.lab.models.fast": "m",
      "connections.lab.models.balanced": "m",
      "connections.lab.models.reasoning": "m",
    },
    unset: [],
  });
/** Every file under the sandbox, with its content, so a test can prove nothing changed. */
function snapshot(): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      // SQLite sidecars change when anything opens a database; their bytes are not akm's state.
      else if (!/-(shm|wal)$/.test(entry.name)) files[full] = fs.readFileSync(full, "utf8");
    }
  };
  walk(ctx.storage.root);
  return files;
}
const akmJson = (args: string[]): Json => {
  const [bin, ...prefix] = resolveAkmInvocation().argv;
  return JSON.parse(
    execFileSync(bin!, [...prefix, ...args, "--format=json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
  );
};

describe("akm info learning", () => {
  test("reports on, agent and scheduled, and writes nothing", async () => {
    const cron = fakeCrontab();
    try {
      await setup.apply({ dir: library() });
      connect();
      const before = snapshot();
      const info = await runCli(["info"]);
      expect(info.learning).toEqual({ on: true, agent: null, scheduled: false });
      expect(snapshot()).toEqual(before);
      expect(fs.existsSync(cron.file)).toBe(false);

      await runCli(["setup", "--learning", "on"]);
      expect((await runCli(["info"])).learning).toEqual({ on: true, agent: null, scheduled: true });
      await runCli(["setup", "--learning", "off"]);
      const off = snapshot();
      expect((await runCli(["info"])).learning).toEqual({ on: false, agent: null, scheduled: false });
      expect(snapshot()).toEqual(off);
    } finally {
      cron.restore();
    }
  });
});

describe("akm setup --learning", () => {
  test("alone it creates no library, enables no harness and needs no --yes", async () => {
    const result = await runCli(["setup", "--learning", "off"]);
    expect(result.learning).toMatchObject({ on: false, tasksEnabled: [], tasksDisabled: [], scheduled: false });
    expect((result.learning as Json).processes).toHaveLength(7);
    expect(fs.existsSync(library())).toBe(false);
    expect(fs.existsSync(path.join(ctx.storage.root, "home", ".claude"))).toBe(false);
    const config = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
    expect(config.bundles).toBeUndefined();
    expect(config.harnesses).toBeUndefined();
  });

  test("on schedules the task, reports what changed and keeps unrelated config", async () => {
    const cron = fakeCrontab();
    try {
      await setup.apply({ dir: library() });
      connect();
      change({ set: { "output.format": "yaml" }, unset: [] });
      await runCli(["setup", "--learning", "off"]);
      const result = (await runCli(["setup", "--learning", "on"])).learning as Json;
      expect(result).toMatchObject({ on: true, agent: null, tasksEnabled: ["improve"], scheduled: true });
      expect(result.processes).toHaveLength(7);
      expect(fs.readFileSync(cron.file, "utf8")).toContain("improve");
      const config = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
      expect(config.output.format).toBe("yaml");
      const off = (await runCli(["setup", "--learning", "off"])).learning as Json;
      expect(off).toMatchObject({ on: false, tasksDisabled: ["improve"], scheduled: false });
      expect(fs.readFileSync(cron.file, "utf8")).not.toContain("improve");
    } finally {
      cron.restore();
    }
  });

  test("on with nowhere to run it warns and stays off", async () => {
    await setup.apply({ dir: library() });
    const result = (await runCli(["setup", "--learning", "on"])).learning as Json;
    expect(result).toMatchObject({ on: false, scheduled: false });
  });

  test("on with no crontab on the host warns, keeps the config change and reports scheduled: false", async () => {
    await setup.apply({ dir: library() });
    connect();
    const realPath = process.env.PATH;
    // A PATH with the interpreter and nothing else: no `crontab`.
    const bin = path.join(ctx.storage.root, "nobin");
    fs.mkdirSync(bin);
    for (const name of ["bun", "node", "git", "sh"]) {
      const found = realPath?.split(path.delimiter).find((dir) => fs.existsSync(path.join(dir, name)));
      if (found) fs.symlinkSync(path.join(found, name), path.join(bin, name));
    }
    process.env.PATH = bin;
    try {
      const result = (await runCli(["setup", "--learning", "on"])).learning as Json;
      expect(result).toMatchObject({ on: true, scheduled: false, tasksEnabled: [] });
      const info = (await runCli(["info"])).learning as Json;
      expect(info.on).toBe(true);
    } finally {
      process.env.PATH = realPath;
    }
  });

  test("a value other than on or off, or a flag beside it, is a usage error", async () => {
    await expect(runCli(["setup", "--learning", "maybe"])).rejects.toThrow(/on. or .off/);
    await expect(runCli(["setup", "--learning", "on", "--harness", "claude"])).rejects.toThrow(/on its own/);
    await expect(runCli(["setup", "--learning", "on", "--dir", library()])).rejects.toThrow(/on its own/);
  });
});

/** A crontab whose `-` (write) fails when `failing` exists. */
function flakyCrontab() {
  const bin = path.join(ctx.storage.root, "flakybin");
  const file = path.join(ctx.storage.root, "crontab.txt");
  const failing = path.join(ctx.storage.root, "crontab-fails");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "crontab"),
    `#!/bin/sh\ncase "$1" in -l) [ -f "${file}" ] && cat "${file}" || exit 1;; -) if [ -f "${failing}" ]; then cat >/dev/null; echo denied >&2; exit 1; fi; cat > "${file}";; esac\n`,
    { mode: 0o755 },
  );
  const before = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${before}`;
  return {
    file,
    failWrites: (on: boolean) => (on ? fs.writeFileSync(failing, "") : fs.rmSync(failing, { force: true })),
    restore: () => {
      process.env.PATH = before;
    },
  };
}
const scheduledIn = async (result: Json) => {
  const info = (await runCli(["info"])).learning as Json;
  expect(info.scheduled).toBe(result.learning.scheduled);
  return info.scheduled as boolean;
};

describe("scheduled agrees between setup --learning and akm info", () => {
  test("a crontab that refuses writes: on is not scheduled, and a rerun retries", async () => {
    await setup.apply({ dir: library() });
    connect();
    const cron = flakyCrontab();
    try {
      cron.failWrites(true);
      const on = await runCli(["setup", "--learning", "on"]);
      expect(on.learning).toMatchObject({ on: true, scheduled: false, tasksEnabled: [] });
      expect(await scheduledIn(on)).toBe(false);
      cron.failWrites(false);
      const again = await runCli(["setup", "--learning", "on"]);
      expect(again.learning).toMatchObject({ scheduled: true });
      expect(await scheduledIn(again)).toBe(true);
      // Off cannot take the row out: the report does not claim it is gone, and a rerun retries.
      cron.failWrites(true);
      const off = await runCli(["setup", "--learning", "off"]);
      expect(off.learning).toMatchObject({ on: false, scheduled: true, tasksDisabled: [] });
      expect(await scheduledIn(off)).toBe(true);
      expect(fs.readFileSync(cron.file, "utf8")).toContain("improve");
      cron.failWrites(false);
      const retried = await runCli(["setup", "--learning", "off"]);
      expect(retried.learning).toMatchObject({ scheduled: false, tasksDisabled: ["improve"] });
      expect(await scheduledIn(retried)).toBe(false);
    } finally {
      cron.restore();
    }
  });

  test("no crontab: on and info agree", async () => {
    await setup.apply({ dir: library() });
    connect();
    const realPath = process.env.PATH;
    const bin = path.join(ctx.storage.root, "nobin2");
    fs.mkdirSync(bin);
    for (const name of ["bun", "node", "git", "sh"]) {
      const found = realPath?.split(path.delimiter).find((dir) => fs.existsSync(path.join(dir, name)));
      if (found) fs.symlinkSync(path.join(found, name), path.join(bin, name));
    }
    process.env.PATH = bin;
    try {
      expect(await scheduledIn(await runCli(["setup", "--learning", "on"]))).toBe(false);
    } finally {
      process.env.PATH = realPath;
    }
  });

  test("a malformed sibling task file breaks neither off nor info", async () => {
    const cron = fakeCrontab();
    try {
      await setup.apply({ dir: library() });
      connect();
      await runCli(["setup", "--learning", "on"]);
      fs.writeFileSync(path.join(library(), "tasks", "broken.yml"), "schedule: [unclosed\n  : :");
      expect((await runCli(["info"])).learning).toMatchObject({ scheduled: true });
      const off = await runCli(["setup", "--learning", "off"]);
      expect(off.learning).toMatchObject({ on: false, tasksDisabled: ["improve"], scheduled: false });
      expect(await scheduledIn(off)).toBe(false);
    } finally {
      cron.restore();
    }
  });

  test("--yes and --no-probe are ignored with a lone --learning", async () => {
    const result = await runCli(["setup", "--learning", "off", "--yes", "--no-probe"]);
    expect(result.learning).toMatchObject({ on: false });
    expect(fs.existsSync(library())).toBe(false);
  });
});

describe("learning on keeps where improve runs", () => {
  test("a harness-only config stays on, and off then on keeps improve.harness", async () => {
    const bin = path.join(ctx.storage.root, "hbin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\necho 2.1.283\n", { mode: 0o755 });
    const realPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${realPath}`;
    const cron = fakeCrontab();
    try {
      await setup.apply({ dir: library(), harness: ["claude"] });
      change({ set: { "improve.harness": "claude" }, unset: [] });
      expect((await runCli(["info"])).learning).toMatchObject({ on: true, agent: "claude" });
      await runCli(["setup", "--learning", "off"]);
      const on = await runCli(["setup", "--learning", "on"]);
      expect(on.learning).toMatchObject({ on: true, agent: "claude" });
      const config = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
      expect(config.improve.harness).toBe("claude");
      expect(JSON.stringify(config.improve.strategies ?? {})).not.toContain("false");
    } finally {
      cron.restore();
      process.env.PATH = realPath;
    }
  });

  test("two connections and no default: off then on keeps improve.connection", async () => {
    const cron = fakeCrontab();
    try {
      await setup.apply({ dir: library() });
      change({
        set: {
          "connections.a.endpoint": "http://localhost:1/v1",
          "connections.a.models.fast": "m",
          "connections.b.endpoint": "http://localhost:2/v1",
          "connections.b.models.fast": "m",
          "improve.connection": "a",
        },
        unset: [],
      });
      expect((await runCli(["info"])).learning).toMatchObject({ on: true });
      await runCli(["setup", "--learning", "off"]);
      const on = await runCli(["setup", "--learning", "on"]);
      expect(on.learning).toMatchObject({ on: true });
      expect(JSON.parse(fs.readFileSync(getConfigPath(), "utf8")).improve.connection).toBe("a");
    } finally {
      cron.restore();
    }
  });
});

describe("setup.apply with learning", () => {
  test("learning alone creates no library; with dir or harness it still does", async () => {
    await setup.apply({ learning: { on: false } });
    expect(fs.existsSync(library())).toBe(false);
    expect(fs.existsSync(getConfigPath())).toBe(true);
    await setup.apply({ dir: library(), learning: { on: false } });
    expect(fs.existsSync(path.join(library(), "knowledge"))).toBe(true);
  });
});

describe("akm proposal new --if-learning", () => {
  test("exits 0 with skipped: learning-off and makes no proposal when learning is off", async () => {
    await setup.apply({ dir: library(), learning: { on: false } });
    const before = snapshot();
    const result = akmJson(["proposal", "new", "lesson", "x", "--task", "hi", "--if-learning"]);
    expect(result).toMatchObject({ ok: true, skipped: "learning-off" });
    expect(snapshot()).toEqual(before);
  });

  test("with learning on it carries on to the normal path", async () => {
    await setup.apply({ dir: library() });
    connect();
    let failure = "";
    try {
      akmJson(["proposal", "new", "lesson", "x", "--task", "hi", "--if-learning"]);
    } catch (error) {
      failure = String((error as { stdout?: string }).stdout ?? error);
    }
    // It reached the engine (which cannot answer here) instead of skipping.
    expect(failure).not.toContain("learning-off");
  });
});
