// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm task sync` schedule-drift detection (0.8.4 hotfix).
 *
 * Before the fix, sync classified any task already present in the scheduler as
 * "unchanged" without comparing its cron line, so a changed `schedule:` in the
 * .yml never reached the crontab. These tests drive the real `akmTasksSync`
 * with an injected cron backend (in-memory crontab) and assert that a changed
 * schedule is detected and reinstalled.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmTasksAdd, akmTasksDisable, akmTasksSync, akmTasksSyncPlan } from "../src/commands/tasks/tasks";
import { loadConfig, resetConfigCache, saveConfig } from "../src/core/config/config";
import { isSchedulerRefEnabled, schedulerEnabledRefs, setSchedulerRefEnabled } from "../src/tasks/activation-config";
import { CRON_BACKEND, type CronExec, type CronExecResult, listBlocks } from "../src/tasks/backends/cron";
import type { SchedulerBackend } from "../src/tasks/backends/types";
import type { Cleanup } from "./_helpers/sandbox";
import { sandboxStashDir, sandboxXdgConfigHome, sandboxXdgStateHome, writeSandboxConfig } from "./_helpers/sandbox";

let cleanup: Cleanup = () => {};
let stashDir = "";
let tasksDir = "";

function memoryExec(initial = ""): CronExec & { current: () => string } {
  let store = initial;
  return {
    read: (): CronExecResult => ({ status: 0, stdout: store, stderr: "" }),
    write: (content: string): CronExecResult => {
      store = content;
      return { status: 0, stdout: "", stderr: "" };
    },
    current: () => store,
  };
}

function writeTask(id: string, schedule: string, enabled = true): void {
  fs.writeFileSync(
    path.join(tasksDir, `${id}.yml`),
    `version: 4\nrun: echo ${id}\nname: ${id}\nschedule:\n  - cron: "${schedule}"\n`,
    "utf8",
  );
  setSchedulerRefEnabled(`stash//tasks/${id}`, enabled);
}

beforeEach(() => {
  let chain: Cleanup = () => {};
  chain = sandboxXdgConfigHome(chain).cleanup;
  chain = sandboxXdgStateHome(chain).cleanup;
  const stash = sandboxStashDir(chain);
  stashDir = stash.dir;
  cleanup = stash.cleanup;
  tasksDir = path.join(stashDir, "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  writeSandboxConfig({ bundles: { stash: { path: stashDir, writable: true } }, defaultBundle: "stash" });
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
  stashDir = "";
  tasksDir = "";
});

describe("akmTasksSync — schedule drift", () => {
  const backendFor = (exec: CronExec) => {
    return CRON_BACKEND({
      exec,
      fs: { ensureDir() {} },
      logDir: "/var/log/akm",
      akmArgv: ["/usr/local/bin/akm"],
      envPath: false,
    });
  };

  const backendForPath = (exec: CronExec, envPath: string) => {
    return CRON_BACKEND({
      exec,
      fs: { ensureDir() {} },
      logDir: "/var/log/akm",
      akmArgv: ["/usr/local/bin/akm"],
      envPath,
    });
  };

  test("installs missing, then reports unchanged on a no-op re-sync", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *");
    writeTask("beta", "0 2 * * *");

    const first = await akmTasksSync({ backend });
    expect(first.installed.sort()).toEqual(["alpha", "beta"]);
    expect(first.updated).toEqual([]);

    const second = await akmTasksSync({ backend });
    expect(second.installed).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.unchanged.sort()).toEqual(["alpha", "beta"]);
    expect(exec.current()).toContain("task run alpha --bundle stash --scheduled");
    expect(exec.current()).toContain("task run beta --bundle stash --scheduled");
  });

  test("adding one task preserves existing bindings captured under a different ambient PATH", async () => {
    const exec = memoryExec();
    writeTask("alpha", "*/15 * * * *");
    await akmTasksSync({ backend: backendForPath(exec, "/captured/bin:/usr/bin") });
    const alphaBefore = exec.current().match(/# akm:task alpha BEGIN[\s\S]*?# akm:task alpha END/)?.[0];

    writeTask("beta", "0 2 * * *");
    const result = await akmTasksSync({ backend: backendForPath(exec, "/ambient/bin:/usr/bin") });

    expect(result.installed).toEqual(["beta"]);
    expect(result.updated).toEqual([]);
    expect(result.unchanged).toEqual(["alpha"]);
    expect(exec.current().match(/# akm:task alpha BEGIN[\s\S]*?# akm:task alpha END/)?.[0]).toBe(alphaBefore);
    // The one managed PATH line follows the latest write; alpha's row does not.
    expect(exec.current()).toContain("PATH=/ambient/bin:/usr/bin");
    expect(exec.current()).not.toContain("PATH=/captured/bin:/usr/bin");
  });

  test("sync restores a locally enabled task that was manually disabled in crontab", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *", true);
    await akmTasksSync({ backend });
    exec.write(exec.current().replace(/^([^#\n].*task run alpha.*)$/m, "# akm:disabled $1"));

    writeTask("beta", "0 2 * * *");
    const result = await akmTasksSync({ backend });

    expect(result.installed).toEqual(["beta"]);
    expect(result.updated).toEqual(["alpha"]);
    expect(result.unchanged).toEqual([]);
    expect(exec.current()).not.toContain("# akm:disabled */15 * * * *");
  });

  test("detects a changed schedule and reinstalls it (the bug fix)", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *");
    writeTask("beta", "0 2 * * *");
    await akmTasksSync({ backend });

    // Edit beta's schedule on disk, as `akm task` never rewrites it.
    writeTask("beta", "45 */6 * * *");

    const result = await akmTasksSync({ backend });
    expect(result.updated).toEqual(["beta"]);
    expect(result.unchanged).toEqual(["alpha"]);
    expect(result.installed).toEqual([]);
    // The crontab now carries the new schedule, not the stale one.
    expect(exec.current()).toContain("45 */6 * * * /usr/local/bin/akm task run beta --bundle stash --scheduled");
    expect(exec.current()).toContain("task run beta --bundle");
    expect(exec.current()).not.toContain("0 2 * * * /usr/local/bin/akm");
  });

  test("removing local activation unschedules the task without editing source", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *", true);
    await akmTasksSync({ backend });
    expect(exec.current()).not.toContain("# akm:disabled");

    writeTask("alpha", "*/15 * * * *", false);
    const result = await akmTasksSync({ backend });
    expect(result.removed).toEqual(["alpha"]);
    expect(exec.current()).not.toContain("task run alpha --bundle");
  });

  test("`akm task disable` also removes a granted, installed binding", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *", true);
    await akmTasksSync({ backend });
    expect(exec.current()).not.toContain("# akm:disabled");

    const disabled = await akmTasksDisable("alpha", {}, { backend });
    expect(disabled.sync.removed).toEqual(["alpha"]);
    expect(exec.current()).not.toContain("task run alpha --bundle");
  });

  test("`akm task add --disabled` does not re-grant or reinstall the task it just disabled", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *", true);
    await akmTasksSync({ backend });
    expect(exec.current()).toContain("task run alpha --bundle stash --scheduled");

    const result = await akmTasksAdd(
      { id: "alpha", schedule: "0 3 * * *", command: "echo replacement", disabled: true, force: true },
      { backend, commitBoundary() {} },
    );

    expect(result.enabled).toBe(false);
    expect(isSchedulerRefEnabled(loadConfig(), "stash//tasks/alpha")).toBe(false);
    expect(exec.current()).not.toContain("task run alpha --bundle stash --scheduled");
  });

  test("a config without scheduler.enabled takes the installed rows with a backing file as the host's choice", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    writeTask("orphan", "*/5 * * * *", true);
    await akmTasksSync({ backend });
    expect(exec.current()).toContain("task run orphan");

    // A pre-0.9.17 config has no list at all: the installed row is the choice.
    const { scheduler: _dropped, ...withoutList } = loadConfig();
    saveConfig(withoutList);
    resetConfigCache();
    expect(schedulerEnabledRefs(loadConfig())).toBeUndefined();

    const result = await akmTasksSync({ backend });
    expect(result.removed).not.toContain("orphan");
    expect(exec.current()).toContain("task run orphan");
    expect(schedulerEnabledRefs(loadConfig())).toContain("stash//tasks/orphan");

    // An explicit empty list is a choice, not a missing one.
    saveConfig({ ...loadConfig(), scheduler: { enabled: [] } });
    resetConfigCache();
    const removed = await akmTasksSync({ backend });
    expect(removed.removed).toEqual(["orphan"]);
    expect(exec.current()).not.toContain("task run orphan");
    expect(schedulerEnabledRefs(loadConfig())).toEqual([]);
  });

  test("an installed row with no backing file is removed, not adopted as a choice", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    writeTask("ghost", "*/5 * * * *", true);
    await akmTasksSync({ backend });
    expect(exec.current()).toContain("task run ghost");

    const { scheduler: _dropped, ...withoutList } = loadConfig();
    saveConfig(withoutList);
    resetConfigCache();
    fs.rmSync(path.join(tasksDir, "ghost.yml"));

    const result = await akmTasksSync({ backend });
    expect(result.removed).toEqual(["ghost"]);
    expect(exec.current()).not.toContain("task run ghost");
    expect(schedulerEnabledRefs(loadConfig())).toEqual([]);
  });

  test("removes orphaned scheduler entries with no backing file", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *");
    writeTask("gamma", "0 5 * * *");
    await akmTasksSync({ backend });

    fs.rmSync(path.join(tasksDir, "gamma.yml"));
    const result = await akmTasksSync({ backend });
    expect(result.removed).toEqual(["gamma"]);
    expect(exec.current()).not.toContain("task run gamma");
    expect(exec.current()).toContain("task run alpha");
  });

  // #867: degrades — the unversioned task is reported and excluded rather
  // than installed, and never poisons a sync where it's the only source.
  test("reports an unversioned task instead of installing it", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    fs.writeFileSync(
      path.join(tasksDir, "legacy.yml"),
      'schedule: "@hourly"\ncommand: akm improve --profile quick --auto-accept safe\nenabled: true\n',
      "utf8",
    );
    setSchedulerRefEnabled("stash//tasks/legacy", true);

    const result = await akmTasksSync({ backend });
    expect(result.installed).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.reason).toMatch(/version is required and must be 4/);
    expect(exec.current()).toBe("");
  });

  // A row inside akm's own markers that this akm cannot parse (a pre-rename
  // `tasks run` spelling, with or without a descriptor) is akm's to rewrite:
  // the source says what the row should be.
  test.each([
    [
      "a pre-rename `tasks run` row with no descriptor",
      "# akm:disabled */15 * * * * /usr/local/bin/akm tasks run alpha >> /var/log/akm/alpha.log 2>&1",
    ],
    [
      "a pre-rename `tasks run` row with a descriptor",
      "*/15 * * * * /usr/local/bin/akm --scheduler-context /var/lib/akm/context/one.json tasks run alpha --scheduled >> /var/log/akm/alpha.log 2>&1",
    ],
  ])("an akm-marked row it cannot parse (%s) is rewritten from its source", async (_label, row) => {
    const exec = memoryExec(["# akm:task alpha BEGIN", row, "# akm:task alpha END", ""].join("\n"));
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *", true);

    const result = await akmTasksSync({ backend });

    expect(result.installed).toEqual(["alpha"]);
    expect(result.failures).toEqual([]);
    expect(exec.current().match(/# akm:task alpha BEGIN/g)).toHaveLength(1);
    expect(exec.current()).toContain("task run alpha --bundle stash --scheduled");
    expect(exec.current()).not.toContain("tasks run alpha");
  });

  // A pre-#867 crontab entry (written by an older akm, before `--bundle` was
  // added to the installed invocation) is still akm's own: it sits inside
  // the `# akm:task alpha BEGIN/END` markers and runs the primary stash. Sync
  // must reconcile it to the current invocation shape, not refuse the run.
  test("reconciles a pre-`--bundle` native entry instead of refusing it as an unproven owner", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *");
    await akmTasksSync({ backend });
    const before = exec.current();
    const stripped = before.replace(/--bundle\s+\S+\s+/, "");
    expect(stripped).not.toBe(before);
    exec.write(stripped);

    const result = await akmTasksSync({ backend });

    expect(result.updated).toEqual(["alpha"]);
    expect(exec.current()).toContain("task run alpha --bundle");
  });

  test("a failed crontab write is reported, and the prior crontab stays active", async () => {
    let store = "";
    let failNextWrite = false;
    const exec: CronExec & { current: () => string } = {
      read: () => ({ status: 0, stdout: store, stderr: "" }),
      write(content) {
        store = content;
        if (failNextWrite) {
          failNextWrite = false;
          return { status: 1, stdout: "", stderr: "injected replacement failure" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      current: () => store,
    };
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *");
    await akmTasksSync({ backend });
    const prior = exec.current();
    writeTask("alpha", "45 */6 * * *");
    failNextWrite = true;

    const result = await akmTasksSync({ backend });

    expect(result.updated).toEqual([]);
    expect(result.failures).toEqual([
      expect.objectContaining({
        ref: "stash//tasks/alpha",
        reason: expect.stringContaining("injected replacement failure"),
      }),
    ]);
    expect(exec.current()).toBe(prior);
    expect(exec.current()).toContain("*/15 * * * *");
    expect(exec.current()).not.toContain("45 */6 * * *");
  });

  test("a row whose source stops compiling is left installed and the failure reported", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *");
    writeTask("beta", "0 2 * * *");
    await akmTasksSync({ backend });
    const alphaRow = exec.current().match(/# akm:task alpha BEGIN[\s\S]*?# akm:task alpha END/)?.[0];
    fs.writeFileSync(path.join(tasksDir, "alpha.yml"), "version: 4\nrun: [unterminated\n", "utf8");
    writeTask("beta", "30 2 * * *");

    const result = await akmTasksSync({ backend });

    expect(result.removed).toEqual([]);
    expect(result.updated).toEqual(["beta"]);
    expect(result.failures).toEqual([expect.objectContaining({ ref: "stash//tasks/alpha" })]);
    expect(exec.current().match(/# akm:task alpha BEGIN[\s\S]*?# akm:task alpha END/)?.[0]).toBe(alphaRow);
  });

  test("re-adding a task with fewer schedules removes the row of the schedule it dropped", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    fs.writeFileSync(
      path.join(tasksDir, "alpha.yml"),
      'version: 4\nrun: echo alpha\nschedule:\n  - cron: "0 1 * * *"\n  - cron: "0 2 * * *"\n',
      "utf8",
    );
    setSchedulerRefEnabled("stash//tasks/alpha", true);
    expect((await akmTasksSync({ backend })).installed).toHaveLength(2);

    await akmTasksAdd(
      { id: "alpha", schedule: "0 3 * * *", command: "echo alpha", force: true },
      { backend, commitBoundary() {} },
    );

    expect(exec.current().match(/# akm:task \S+ BEGIN/g)).toEqual(["# akm:task alpha BEGIN"]);
    expect(exec.current()).toContain("0 3 * * * /usr/local/bin/akm");
  });

  test("symlinks in a bundle are followed, never refused", async () => {
    // A root CLAUDE.md -> AGENTS.md pair is what adapter detection keys on, so
    // pin the adapter: this is about how sync reads the bundle.
    writeSandboxConfig({
      bundles: { stash: { path: stashDir, components: { main: { root: ".", adapter: "akm", writable: true } } } },
      defaultBundle: "stash",
    });
    const exec = memoryExec();
    const backend = backendFor(exec);
    fs.writeFileSync(path.join(stashDir, "AGENTS.md"), "agents\n");
    fs.symlinkSync(path.join(stashDir, "AGENTS.md"), path.join(stashDir, "CLAUDE.md"));
    const sources = fs.mkdtempSync(path.join(os.tmpdir(), "akm-tasks-sync-linked-"));
    try {
      fs.writeFileSync(path.join(sources, "nightly.yml"), 'version: 4\nrun: echo nightly\nschedule: "0 1 * * *"\n');
      fs.symlinkSync(path.join(sources, "nightly.yml"), path.join(tasksDir, "nightly.yml"));
      fs.symlinkSync(path.join(sources, "missing.yml"), path.join(tasksDir, "dangling.yml"));
      setSchedulerRefEnabled("stash//tasks/nightly", true);

      const result = await akmTasksSync({ backend });

      expect(result.failures).toEqual([]);
      expect(result.installed).toEqual(["nightly"]);
    } finally {
      fs.rmSync(sources, { recursive: true, force: true });
    }
  });
});

// U2: writes (and therefore scheduler state) are only ever defined for
// filesystem/git sources (adaptConfiguredSource, src/core/write-source.ts).
// An enabled website/npm bundle must not crash unscoped `akm task sync`, and
// a scoped sync naming one must fail with a clear usage error rather than
// the write-target ConfigError that used to escape from resolveWriteTarget.
// Rows written by 0.9.0 – 0.9.17-alpha.6 name a `--scheduler-context`
// descriptor. The first sync after upgrading rewrites each one in place — an
// update that keeps its launcher and schedule — and never adds or removes a
// row: the task set and its times do not change.
describe("akmTasksSync — rows written before 0.9.17-alpha.7 (`--scheduler-context`)", () => {
  const LAUNCHER = "/home/u/.bun/bin/bun /home/u/.bun/lib/node_modules/akm-cli/dist/akm";
  const backendFor = (exec: CronExec) =>
    CRON_BACKEND({
      exec,
      fs: { ensureDir() {} },
      logDir: "/var/log/akm",
      akmArgv: ["/usr/local/bin/akm"],
      envPath: false,
    });

  /** A descriptor exactly as 0.9.17-alpha.6 wrote it: JSON naming the working stash. */
  function writeLegacyDescriptor(bundleDir: string): string {
    const file = path.join(stashDir, ".legacy-context", "e89838da.json");
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, environment: { AKM_BUNDLE_DIR: bundleDir } })}\n`, {
      mode: 0o600,
    });
    return file;
  }

  function legacyBlock(id: string, cron: string, bundle: string, context: string): string {
    return [
      `# akm:task ${id} BEGIN`,
      `${cron} ${LAUNCHER} --scheduler-context ${context} task run ${id} --bundle ${bundle} --scheduled > /var/log/akm/${id}.log 2>&1`,
      `# akm:task ${id} END`,
    ].join("\n");
  }

  const byId = (rows: Array<{ id: string; body: string }>) => [...rows].sort((a, b) => a.id.localeCompare(b.id));

  test("a configured bundle's rows are updates that keep each launcher and schedule and drop the descriptor", async () => {
    writeTask("alpha", "*/15 * * * *");
    writeTask("beta", "0 2 * * *");
    const context = writeLegacyDescriptor(stashDir);
    const exec = memoryExec(
      `${legacyBlock("alpha", "*/15 * * * *", "stash", context)}\n${legacyBlock("beta", "0 2 * * *", "stash", context)}\n`,
    );
    const backend = backendFor(exec);

    const preview = await akmTasksSyncPlan({ backend });
    expect(preview.adds).toEqual([]);
    expect(preview.removes).toEqual([]);
    expect(preview.failures).toEqual([]);
    expect(preview.updates.map((update) => update.id).sort()).toEqual(["alpha", "beta"]);
    expect(exec.current()).toContain("--scheduler-context");

    const result = await akmTasksSync({ backend });
    expect(result.installed).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.updated.sort()).toEqual(["alpha", "beta"]);
    expect(byId(listBlocks(exec.current()))).toEqual([
      {
        id: "alpha",
        body: `*/15 * * * * ${LAUNCHER} task run alpha --bundle stash --scheduled > /var/log/akm/alpha.log 2>&1`,
      },
      {
        id: "beta",
        body: `0 2 * * * ${LAUNCHER} task run beta --bundle stash --scheduled > /var/log/akm/beta.log 2>&1`,
      },
    ]);
    expect((await akmTasksSync({ backend })).unchanged.sort()).toEqual(["alpha", "beta"]);
    // The descriptor it no longer references is left where it is, and no new one is written.
    expect(fs.readdirSync(path.dirname(context))).toEqual([path.basename(context)]);
  });

  test("the env-selected stash's rows carry AKM_BUNDLE_DIR inline, and its --scheduler-context rows are updates too", async () => {
    // No configured bundle: the working stash comes from AKM_BUNDLE_DIR alone.
    const configPath = path.join(process.env.XDG_CONFIG_HOME ?? "", "akm", "config.json");
    fs.writeFileSync(configPath, `${JSON.stringify({ configVersion: "0.9.0", semanticSearchMode: "off" })}\n`);
    resetConfigCache();
    const bundle = path.basename(stashDir).toLowerCase();
    for (const [id, cron] of [
      ["alpha", "*/15 * * * *"],
      ["beta", "0 2 * * *"],
    ] as const) {
      fs.writeFileSync(path.join(tasksDir, `${id}.yml`), `version: 4\nrun: echo ${id}\nschedule: "${cron}"\n`);
      setSchedulerRefEnabled(`${bundle}//tasks/${id}`, true);
    }
    const context = writeLegacyDescriptor(stashDir);
    const exec = memoryExec(`${legacyBlock("alpha", "*/15 * * * *", bundle, context)}\n`);
    const backend = backendFor(exec);

    const preview = await akmTasksSyncPlan({ backend });
    expect(preview.removes).toEqual([]);
    expect(preview.failures).toEqual([]);
    expect(preview.updates.map((update) => update.id)).toEqual(["alpha"]);
    expect(preview.adds.map((add) => add.id)).toEqual(["beta"]);

    const result = await akmTasksSync({ backend });
    expect(result.failures).toEqual([]);
    expect(result.updated).toEqual(["alpha"]);
    expect(result.installed).toEqual(["beta"]);
    const inline = `AKM_BUNDLE_DIR=${path.resolve(stashDir)}`;
    expect(byId(listBlocks(exec.current()))).toEqual([
      {
        id: "alpha",
        body: `*/15 * * * * ${inline} ${LAUNCHER} task run alpha --bundle ${bundle} --scheduled > /var/log/akm/alpha.log 2>&1`,
      },
      {
        id: "beta",
        body: `0 2 * * * ${inline} /usr/local/bin/akm task run beta --bundle ${bundle} --scheduled > /var/log/akm/beta.log 2>&1`,
      },
    ]);
    expect((await akmTasksSync({ backend })).unchanged.sort()).toEqual(["alpha", "beta"]);
  });
});

// A second installation (another config dir) sharing this crontab writes rows
// that name a bundle of the same name; they are its rows, not this one's (#846).
describe("akmTasksSync — rows another installation wrote", () => {
  test("a row that reads another config (inline AKM_CONFIG_DIR) is left alone, and its id is reported as taken", async () => {
    writeTask("backup", "0 3 * * *");
    writeTask("nightly", "0 4 * * *", false);
    const foreignRow =
      "0 3 * * * AKM_CONFIG_DIR=/opt/b/config /usr/local/bin/akm task run nightly --bundle stash --scheduled > /var/log/akm/nightly.log 2>&1";
    const exec = memoryExec(["# akm:task nightly BEGIN", foreignRow, "# akm:task nightly END", ""].join("\n"));
    const backend = CRON_BACKEND({
      exec,
      fs: { ensureDir() {} },
      logDir: "/var/log/akm",
      akmArgv: ["/usr/local/bin/akm"],
      envPath: false,
    });

    const preview = await akmTasksSyncPlan({ backend });
    expect(preview.removes).toEqual([]);
    expect(preview.adds.map((add) => add.id)).toEqual(["backup"]);
    await akmTasksSync({ backend });
    expect(exec.current()).toContain(foreignRow);

    // Enabling a task with that id here collides instead of taking the row over.
    setSchedulerRefEnabled("stash//tasks/nightly", true);
    const collision = await akmTasksSync({ backend });
    expect(collision.failures).toEqual([
      expect.objectContaining({ ref: "stash//tasks/nightly", reason: expect.stringContaining("already scheduled") }),
    ]);
    expect(exec.current()).toContain(foreignRow);
  });

  test("a flat bundle whose task files are all v2/v3 keeps its row until `akm migrate apply` converts them", async () => {
    const flat = fs.mkdtempSync(path.join(os.tmpdir(), "akm-sync-flat-"));
    try {
      fs.writeFileSync(path.join(flat, "weekly.yml"), "version: 3\nrun: echo weekly\nakm:\n  schedule: '0 5 * * 0'\n");
      writeSandboxConfig({ bundles: { flat: { path: flat, writable: true } }, defaultBundle: "flat" });
      resetConfigCache();
      setSchedulerRefEnabled("flat//weekly", true);
      const row = [
        "# akm:task weekly BEGIN",
        "0 5 * * 0 /usr/local/bin/akm task run weekly --bundle flat --scheduled > /var/log/akm/weekly.log 2>&1",
        "# akm:task weekly END",
        "",
      ].join("\n");
      const exec = memoryExec(row);
      const backend = CRON_BACKEND({
        exec,
        fs: { ensureDir() {} },
        logDir: "/var/log/akm",
        akmArgv: ["/usr/local/bin/akm"],
        envPath: false,
      });

      const result = await akmTasksSync({ backend });
      expect(result.removed).toEqual([]);
      expect(result.failures).toEqual([
        expect.objectContaining({ ref: "flat//weekly", reason: expect.stringContaining("akm migrate apply") }),
      ]);
      expect(exec.current()).toBe(row);
    } finally {
      fs.rmSync(flat, { recursive: true, force: true });
    }
  });
});

describe("akmTasksSync — website/npm bundles cannot carry scheduler state", () => {
  const backendFor = (exec: CronExec) => {
    return CRON_BACKEND({
      exec,
      fs: { ensureDir() {} },
      logDir: "/var/log/akm",
      akmArgv: ["/usr/local/bin/akm"],
      envPath: false,
    });
  };

  beforeEach(() => {
    writeSandboxConfig({
      bundles: {
        stash: { path: stashDir, writable: true },
        docs: { website: { url: "https://example.test/docs/" } },
      },
      defaultBundle: "stash",
    });
  });

  test("unscoped sync installs the filesystem bundle's task and skips the enabled website bundle", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *");

    const result = await akmTasksSync({ backend });

    expect(result.installed).toEqual(["alpha"]);
    expect(exec.current()).toContain("task run alpha --bundle stash --scheduled");
  });

  test("scoped sync against the website bundle fails with a clear usage error, not a write-target ConfigError", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    writeTask("alpha", "*/15 * * * *");

    await expect(akmTasksSync({ backend }, "docs")).rejects.toThrow(
      /Bundle "docs" has kind "website"; task scheduling is only supported for filesystem and git bundles\./,
    );
  });
});

// An unscoped (multi-bundle) sync must isolate one bundle's own anomaly: one
// bundle whose `tasks/` cannot be listed must not abort every OTHER selected
// bundle's sync. A scoped sync naming exactly that bundle is a different case:
// its one failure IS the whole operation, so it rethrows instead of reporting.
describe("akmTasksSync — one bundle's poisoned source set does not cost every OTHER bundle its sync", () => {
  const backendFor = (exec: CronExec) => {
    return CRON_BACKEND({
      exec,
      fs: { ensureDir() {} },
      logDir: "/var/log/akm",
      akmArgv: ["/usr/local/bin/akm"],
      envPath: false,
    });
  };

  function makePoisonedBundle(): { poisonedDir: string; cleanup: () => void } {
    const poisonedDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-tasks-sync-poisoned-"));
    // A `tasks` entry that is a regular file: listing it fails for the whole
    // bundle, not for a single source.
    fs.writeFileSync(path.join(poisonedDir, "tasks"), "not a directory\n");
    return { poisonedDir, cleanup: () => fs.rmSync(poisonedDir, { recursive: true, force: true }) };
  }

  test("the healthy bundle still installs its task; the poisoned bundle is reported, not thrown", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    const poisoned = makePoisonedBundle();

    try {
      writeSandboxConfig({
        bundles: {
          stash: { path: stashDir, writable: true },
          poisoned: { path: poisoned.poisonedDir, writable: true },
        },
        defaultBundle: "stash",
      });
      writeTask("alpha", "*/15 * * * *");

      const result = await akmTasksSync({ backend });

      expect(result.installed).toEqual(["alpha"]);
      expect(exec.current()).toContain("task run alpha --bundle stash --scheduled");
      expect(
        result.failures.some(
          (failure) => failure.path === "poisoned" && /ENOTDIR|not a directory/i.test(failure.reason),
        ),
      ).toBe(true);
    } finally {
      poisoned.cleanup();
    }
  });

  test("a sync scoped to the poisoned bundle rethrows its error instead of reporting it", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    const poisoned = makePoisonedBundle();

    try {
      writeSandboxConfig({
        bundles: {
          stash: { path: stashDir, writable: true },
          poisoned: { path: poisoned.poisonedDir, writable: true },
        },
        defaultBundle: "stash",
      });

      await expect(akmTasksSync({ backend }, "poisoned")).rejects.toThrow(/ENOTDIR|not a directory/i);
    } finally {
      poisoned.cleanup();
    }
  });

  test("an unscoped sync whose only write-capable bundle is poisoned returns a plan reporting it, instead of throwing", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);
    const poisoned = makePoisonedBundle();

    try {
      writeSandboxConfig({
        bundles: {
          poisoned: { path: poisoned.poisonedDir, writable: true },
        },
        defaultBundle: "poisoned",
      });

      const result = await akmTasksSync({ backend });

      expect(result.installed).toEqual([]);
      expect(
        result.failures.some(
          (failure) => failure.path === "poisoned" && /ENOTDIR|not a directory/i.test(failure.reason),
        ),
      ).toBe(true);
    } finally {
      poisoned.cleanup();
    }
  });

  test("a scoped sync against an unconfigured bundle rethrows the original usage error, not a config error", async () => {
    const exec = memoryExec();
    const backend = backendFor(exec);

    await expect(akmTasksSync({ backend }, "nope")).rejects.toMatchObject({
      name: "UsageError",
      code: "INVALID_FLAG_VALUE",
    });
  });
});

// A disabled bundle's rows are removed one at a time: one removal that fails
// is reported and never costs the other rows their own removal.
describe("akmTasksSync — one failing removal does not stop the others", () => {
  test("the removable row goes; the failing one is reported", async () => {
    writeSandboxConfig({
      bundles: {
        stash: { path: stashDir, writable: true },
        archived: { path: path.join(stashDir, "..", "archived"), writable: true, enabled: false },
      },
      defaultBundle: "stash",
    });
    const row = (id: string) => ({
      id,
      nativeId: id,
      target: "archived",
      binding: ["/opt/akm"],
      contextPath: "/data/context.json",
      invocation: ["task", "run", id, "--bundle", "archived", "--scheduled"],
      signature: `sig-${id}`,
    });
    const removed: string[] = [];
    const backend: SchedulerBackend = {
      name: "cron",
      install() {},
      uninstall(nativeId) {
        if (nativeId === "bad") throw new Error("injected uninstall failure");
        removed.push(nativeId);
      },
      setEnabled() {},
      list: () => [row("bad"), row("good")],
    };

    const result = await akmTasksSync({ backend });

    expect(result.removed).toEqual(["good"]);
    expect(removed).toEqual(["good"]);
    expect(result.failures).toEqual([{ path: "bad", reason: "injected uninstall failure" }]);
  });
});
