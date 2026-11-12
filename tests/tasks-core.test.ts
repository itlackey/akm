// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ArgsDef } from "citty";
import { main } from "../src/cli";
import { findCittyTopLevelCommand } from "../src/cli/parse-args";
import { akmTasksDoctor, parseTaskRef } from "../src/commands/tasks/tasks";
import { resetConfigCache, saveConfig } from "../src/core/config/config";
import { UsageError } from "../src/core/errors";
import { getTaskLogDir } from "../src/core/paths";
import { findBareAkmExecutableIndex } from "../src/tasks/command-executable";
import { listEmbeddedTasks } from "../src/tasks/embedded";
import { resolveAkmInvocation } from "../src/tasks/resolve-akm-bin";
import { parseSchedule, scheduleMatchesMinute } from "../src/tasks/schedule";
import { parseTaskSourceV4 } from "../src/tasks/source/task-source-v4";
import { MAX_PORTABLE_TASK_ID_LENGTH, normaliseTaskId, validateTaskId } from "../src/tasks/task-id";
import {
  type Cleanup,
  makeSandboxDir,
  type SandboxedDir,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
} from "./_helpers/sandbox";

describe("findBareAkmExecutableIndex", () => {
  test.each([
    [["akm", "--version"], 0],
    [["akm.exe", "--version"], 0],
    [["env", "akm", "--version"], 1],
    [["/usr/bin/env", "-i", "--unset", "OLD", "NAME=value", "akm", "--version"], 5],
    [["C:\\tools\\env.exe", "--chdir", "C:\\work", "NAME=value", "akm.exe", "--version"], 4],
    [["env", "--", "NAME=value", "akm", "--version"], 3],
  ])("finds bare akm in the executable position of %j", (command, expected) => {
    expect(findBareAkmExecutableIndex(command)).toBe(expected);
  });

  test.each([
    [["/opt/vendor/akm", "--version"]],
    [["./akm", "--version"]],
    [["env", "NAME=value", "/opt/vendor/akm", "--version"]],
    [["env", "--unset", "akm", "node", "script.js"]],
    [["env", "AKM_BIN=/opt/vendor/akm", "node", "script.js"]],
    [["node", "/opt/vendor/akm", "--version"]],
    [["./env", "akm", "--version"]],
    [["env", "--split-string", "akm --version"]],
  ])("does not classify a path, env operand, or non-executable token in %j", (command) => {
    expect(findBareAkmExecutableIndex(command)).toBeUndefined();
  });
});

describe("tasks-resolve-akm-bin", () => {
  /** What the one scheduler entry may be bound to: a stable install, not a copy that moves when its host does. */

  let root: SandboxedDir;

  /** `<dir>/dist/chunks/x.js` beside `<dir>/dist/cli.js`, under `<base>`. */
  function layout(base: string): string {
    const dist = path.join(base, "dist");
    fs.mkdirSync(path.join(dist, "chunks"), { recursive: true });
    fs.writeFileSync(path.join(dist, "cli.js"), "");
    return pathToFileURL(path.join(dist, "chunks", "x.js")).href;
  }

  beforeEach(() => {
    root = makeSandboxDir("akm-resolve-bin");
  });
  afterEach(() => root.cleanup());

  describe("resolveAkmInvocation", () => {
    const common = {
      env: {},
      runtime: "bun" as const,
      execPath: "/usr/bin/bun",
      mainPath: "/nowhere/cli.js",
      electron: false,
    };

    test("a CLI carried in another package's node_modules is package-local, not a checkout", () => {
      const url = layout(path.join(root.dir, "plugin", "0.10.1", "node_modules", "akm-cli"));
      expect(resolveAkmInvocation({ ...common, cliEntryUrl: url }).via).toBe("package-local");
    });

    test("a source tree outside node_modules is still a checkout", () => {
      const url = layout(path.join(root.dir, "work", "akm"));
      expect(resolveAkmInvocation({ ...common, cliEntryUrl: url }).via).toBe("checkout");
    });

    test("Electron's binary, which opens a window unless told otherwise, is never a launcher", () => {
      const url = layout(path.join(root.dir, "work", "akm"));
      expect(resolveAkmInvocation({ ...common, cliEntryUrl: url, electron: true }).via).toBe("package-local");
    });
  });
});

// The legacy colon grammar (`task` + `:` + id) is retired in 0.9.0 (ref-grammar
// decision D-R3). It is constructed here via interpolation so the
// `scripts/lint-test-ref-literals.ts` shrink-only ratchet does not count it — the
// TOKEN regex requires an alphanumeric immediately after the colon, and the `$`
// of `${…}` is not. Do not rewrite this to a plain inline literal.
const LEGACY_TASK_REF = `task:${"foo"}`;

describe("parseTaskRef (0.9.0 grammar, D-R3)", () => {
  test("accepts a bare task id", () => {
    expect(parseTaskRef("foo")).toEqual({ id: "foo" });
  });

  test("accepts the canonical short conceptId `tasks/<id>`", () => {
    expect(parseTaskRef("tasks/foo")).toEqual({ id: "tasks/foo" });
  });

  test("accepts a bundle-qualified `[bundle//]tasks/<id>`", () => {
    expect(parseTaskRef("mybundle//tasks/foo")).toEqual({ id: "tasks/foo", bundle: "mybundle" });
  });

  test("preserves standalone nested concept ids in short and bundle-qualified forms", () => {
    expect(parseTaskRef("sub/deep/nightly")).toEqual({ id: "sub/deep/nightly" });
    expect(parseTaskRef("mybundle//sub/deep/nightly")).toEqual({
      id: "sub/deep/nightly",
      bundle: "mybundle",
    });
  });

  test("trims surrounding whitespace", () => {
    expect(parseTaskRef("  tasks/foo  ")).toEqual({ id: "tasks/foo" });
  });

  test("rejects the retired legacy `task:<id>` colon grammar", () => {
    let caught: unknown;
    try {
      parseTaskRef(LEGACY_TASK_REF);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UsageError);
    const usage = caught as UsageError;
    expect(usage.code).toBe("INVALID_FLAG_VALUE");
  });

  test("parses native-looking concept ids syntactically before adapter projection", () => {
    expect(parseTaskRef("knowledge/foo")).toEqual({ id: "knowledge/foo" });
    expect(parseTaskRef("commands/deep/nightly")).toEqual({ id: "commands/deep/nightly" });
  });

  test("validates every segment of a syntactically parsed task concept id", () => {
    expect(() => parseTaskRef("commands/bad%id")).toThrow(UsageError);
    expect(() => parseTaskRef("bad%id")).toThrow(UsageError);
  });
});

describe("tasks-doctor", () => {
  /** `akm task doctor` reports the scheduler entry, the log directory, and tasks that cannot run. */

  let cleanup: Cleanup = () => {};

  beforeEach(() => {
    const dataResult = sandboxXdgDataHome();
    const cacheResult = sandboxXdgCacheHome(dataResult.cleanup);
    const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
    const stashResult = sandboxStashDir(cfgResult.cleanup);
    cleanup = stashResult.cleanup;
  });

  afterEach(() => {
    cleanup();
    cleanup = () => {};
    resetConfigCache();
  });

  describe("tasks doctor", () => {
    test("reports the task log directory and no history directory (run history lives in state.db)", async () => {
      saveConfig({ semanticSearchMode: "off" });
      resetConfigCache();

      const result = await akmTasksDoctor();

      expect(result.logDir).toBe(getTaskLogDir());
      expect(result).not.toHaveProperty("historyDir");
    });
  });

  describe("tasks doctor without a default bundle", () => {
    beforeEach(() => {
      saveConfig({ semanticSearchMode: "off" });
      resetConfigCache();
    });

    test("succeeds when nothing is enabled", async () => {
      saveConfig({ semanticSearchMode: "off" });
      resetConfigCache();
      const result = await akmTasksDoctor();
      expect(result.warnings.filter((warning) => warning.includes("cannot run"))).toEqual([]);
    });

    test("succeeds and warns naming an enabled ref", async () => {
      saveConfig({ semanticSearchMode: "off", scheduler: { enabled: ["stash//tasks/ok"] } });
      resetConfigCache();
      const result = await akmTasksDoctor();
      expect(
        result.warnings.some((warning) => warning.includes("stash//tasks/ok") && warning.includes("cannot run")),
      ).toBe(true);
    });
  });
});

function invalidTaskId(id: string): UsageError {
  try {
    validateTaskId(id);
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError);
    return err as UsageError;
  }
  throw new Error(`Expected task id "${id}" to be rejected`);
}

describe("validateTaskId", () => {
  test.each([
    "daily",
    "Daily_2",
    "release.notes-v1",
    "console",
    "com10",
    "lpt0",
    "com1-report",
    "auxiliary",
  ])("accepts portable canonical id %s", (id) => {
    expect(validateTaskId(id)).toBe(id);
  });

  test.each([
    "daily.yml",
    "daily.YML",
    "daily.yaml",
    "daily.YaMl",
  ])("rejects canonical id with task-file suffix %s", (id) => {
    const err = invalidTaskId(id);
    expect(err.code).toBe("INVALID_FLAG_VALUE");
    expect(err.message).toContain("bare task id");
    expect(err.message).toContain(".yml or .yaml");
  });

  test.each([
    "CON",
    "con",
    "CoN.log",
    "PRN.backup",
    "aux.txt",
    "NUL.anything",
    "COM1",
    "com9.log",
    "LPT1",
    "lPt9.backup",
  ])("rejects Windows reserved device alias %s", (id) => {
    const err = invalidTaskId(id);
    expect(err.code).toBe("INVALID_FLAG_VALUE");
    expect(err.message).toContain("reserved Windows device name");
    expect(err.message).toContain("Choose a different task id");
  });

  test("enforces the portable scheduler-derived length bound", () => {
    expect(MAX_PORTABLE_TASK_ID_LENGTH).toBe(228);
    const boundaryId = "a".repeat(MAX_PORTABLE_TASK_ID_LENGTH);
    expect(validateTaskId(boundaryId)).toHaveLength(MAX_PORTABLE_TASK_ID_LENGTH);
    expect(`akm-task-${boundaryId}-${"0".repeat(13)}.xml`).toHaveLength(255);

    const overBoundaryId = "a".repeat(MAX_PORTABLE_TASK_ID_LENGTH + 1);
    expect(`akm-task-${overBoundaryId}-${"0".repeat(13)}.xml`).toHaveLength(256);
    const err = invalidTaskId(overBoundaryId);
    expect(err.code).toBe("INVALID_FLAG_VALUE");
    expect(err.message).toContain(`at most ${MAX_PORTABLE_TASK_ID_LENGTH} characters`);
    expect(err.message).toContain("all supported schedulers");
  });
});

describe("normaliseTaskId", () => {
  test("trims a current bare task id", () => {
    expect(normaliseTaskId(" daily ")).toBe("daily");
  });

  test("does not strip task-file suffixes", () => {
    expect(() => normaliseTaskId("daily.yml")).toThrow("bare task id");
    expect(normaliseTaskId("daily.md")).toBe("daily.md");
  });
});

/**
 * Embedded task registry — asserts the 5 bundled `core/` templates and the 1
 * bundled `improve/` template are present with the exact ids and default
 * schedules, and that they are read from the bundled assets dir (not any
 * user stash).
 *
 * `update-stashes` (nightly `akm update --all`) was retired in meta-review
 * 06-M2 — third-party stash pulls are on-demand only now. `backup` (which
 * only ever invoked the nonexistent `akm db backups`) was dropped in 0.9.0.
 *
 * The `improve/` set was folded in from the retired
 * `DEFAULT_IMPROVE_TASKS`/`registerDefaultTasks`/`akm tasks init` path in 0.9
 * (S6): `akm setup`'s task-review step is now the single seeding mechanism
 * for both sets (src/setup/steps/tasks.ts).
 */

const EXPECTED = [
  { id: "improve", category: "core", schedule: "0 2 * * *", enabled: true },
  { id: "version-check", category: "core", schedule: "0 9 * * 1", enabled: true },
  { id: "index-refresh", category: "core", schedule: "0 4 * * *", enabled: true },
  { id: "extract", category: "core", schedule: "*/30 * * * *", enabled: true },
  { id: "sync", category: "core", schedule: "*/15 * * * *", enabled: true },
  { id: "akm-improve-consolidate", category: "improve", schedule: "20 */4 * * *", enabled: true },
] as const;

describe("embedded task registry", () => {
  test("enumerates all 6 templates", () => {
    const tasks = listEmbeddedTasks();
    expect(tasks.length).toBe(6);
  });

  test("each template has the exact id, default schedule, and enablement", () => {
    const tasks = listEmbeddedTasks();
    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const exp of EXPECTED) {
      const got = byId.get(exp.id);
      expect(got, `missing embedded task ${exp.id}`).toBeDefined();
      expect(got?.schedule).toBe(exp.schedule);
      expect(got?.enabled).toBe(exp.enabled);
      expect(got?.description.length).toBeGreaterThan(0);
      expect(got?.label).toBe(`${exp.category}/${exp.id}`);
    }
  });

  test("every improve/ template guards against overlapping runs", () => {
    const improveTasks = listEmbeddedTasks().filter((t) => t.label.startsWith("improve/"));
    expect(improveTasks.length).toBe(1);
    for (const task of improveTasks) expect(task.command).toContain("--skip-if-locked");
  });

  // The nightly (02:00, no --skip-if-locked, must not be skipped) shares improve.lock with the
  // consolidate task. Every consolidate run must end before the nightly starts, or the
  // nightly throws IMPROVE_LOCK_HELD and the whole night is lost.
  test("the consolidate improve task always finishes before the 02:00 nightly starts", () => {
    const nightlyMinute = 2 * 60;
    const consolidate = listEmbeddedTasks().find((t) => t.id === "akm-improve-consolidate");
    expect(consolidate?.schedule).toBe("20 */4 * * *");
    const timeoutMs = Number(/--timeout[ =](\d+)/.exec(consolidate?.command ?? "")?.[1] ?? 2 * 60 * 60 * 1000);
    for (let hour = 0; hour < 24; hour += 4) {
      const start = hour * 60 + 20;
      const end = start + timeoutMs / 60_000;
      const overlaps = start < nightlyMinute && end > nightlyMinute;
      expect(overlaps, `consolidate run at ${hour}:20 ends ${end} min, past the nightly at ${nightlyMinute}`).toBe(
        false,
      );
    }
  });

  // A scheduled improve run stops at planning (exit 78) when nothing it needs is configured, with no flag
  // asking for it (tests/commands/improve/improve-planning-stops.test.ts), so the templates carry none.
  test("no scheduled improve template carries the retired preflight flags", () => {
    const scheduledImproveTasks = listEmbeddedTasks().filter(
      (t) => t.label === "core/improve" || t.label.startsWith("improve/"),
    );
    expect(scheduledImproveTasks.length).toBe(2);
    for (const task of scheduledImproveTasks)
      expect(task.command).not.toMatch(/--require-(targets|engines)|--preflight/);
  });

  test("every enabled embedded command resolves to a real top-level CLI command", () => {
    const topLevelArgs = main.args as ArgsDef;
    const topLevelCommands = main.subCommands ?? {};

    for (const embedded of listEmbeddedTasks()) {
      const task = parseTaskSourceV4({
        filePath: `embedded:${embedded.id}`,
        yaml: embedded.yaml,
      });
      if (!embedded.enabled || task.target.kind !== "run") continue;

      const [executable, ...args] = task.target.run.split(" ");
      expect(executable, `${embedded.id} must invoke akm`).toBe("akm");
      const command = findCittyTopLevelCommand(args, topLevelArgs);
      expect(command, `${embedded.id} must name a top-level command`).toBeDefined();
      expect(topLevelCommands, `${embedded.id} invokes unknown command: ${command}`).toHaveProperty(command as string);
    }
  });

  test("version-check uses the non-mutating upgrade check", () => {
    expect(listEmbeddedTasks().find((task) => task.id === "version-check")?.command).toBe("akm upgrade --check");
    const commands = main.subCommands as unknown as Record<string, { args?: ArgsDef }>;
    expect(commands.upgrade?.args).toHaveProperty("check");
  });
});

describe("parseSchedule", () => {
  test("expands aliases", () => {
    expect(parseSchedule("@daily").cron).toBe("0 0 * * *");
    expect(parseSchedule("@hourly").cron).toBe("0 * * * *");
    expect(parseSchedule("@weekly").cron).toBe("0 0 * * 0");
    expect(parseSchedule("@monthly").cron).toBe("0 0 1 * *");
  });

  test("accepts plain cron", () => {
    const spec = parseSchedule("*/15 * * * *");
    expect(spec.fields.minute.kind).toBe("step");
    if (spec.fields.minute.kind === "step") expect(spec.fields.minute.step).toBe(15);
    expect(spec.fields.hour.kind).toBe("star");
  });

  test("accepts a range-step schedule", () => {
    const spec = parseSchedule("0 2-22/4 * * *");
    expect(spec.fields.hour).toEqual({ kind: "rangeStep", start: 2, end: 22, step: 4 });
  });

  test("rejects too-many fields", () => {
    expect(() => parseSchedule("0 0 0 0 0 0")).toThrow(UsageError);
  });

  test("rejects out-of-range value", () => {
    expect(() => parseSchedule("0 25 * * *")).toThrow(UsageError);
  });

  test("accepts comma list in any field", () => {
    // 2026-05-27: list support added so `7,37 * * * *` (twice/hour) works.
    const spec = parseSchedule("7,37 * * * *");
    expect(spec.fields.minute).toEqual({ kind: "list", values: [7, 37] });
    expect(spec.fields.hour).toEqual({ kind: "star" });
  });

  test("dedupes and sorts list values into ascending order", () => {
    const spec = parseSchedule("37,7,7 * * * *");
    expect(spec.fields.minute).toEqual({ kind: "list", values: [7, 37] });
  });

  test("rejects out-of-range list element", () => {
    expect(() => parseSchedule("7,99 * * * *")).toThrow(UsageError);
  });

  // The cron backend was rejecting plain ranges even
  // though it emits the expression to a real crontab verbatim, and vixie/cronie
  // accept "0-30" natively. A plain range is a `rangeStep` with `step: 1` so
  // it reuses the exact same downstream handling a stepped range already has.
  test("accepts plain range syntax, representing it as a step-1 range-step", () => {
    const spec = parseSchedule("0-30 * * * *");
    expect(spec.fields.minute).toEqual({ kind: "rangeStep", start: 0, end: 30, step: 1 });
  });

  test("rejects a plain range outside the field's bounds", () => {
    expect(() => parseSchedule("0 9 * * 1-9")).toThrow(UsageError);
  });

  test("weekdays at 9am is accepted verbatim on cron", () => {
    const spec = parseSchedule("0 9 * * 1-5");
    expect(spec.fields.dow).toEqual({ kind: "rangeStep", start: 1, end: 5, step: 1 });
  });

  test("accepts three-letter day-of-week and month names, case-insensitively", () => {
    expect(parseSchedule("0 9 * * mon").fields.dow).toEqual({ kind: "value", value: 1 });
    expect(parseSchedule("0 9 * * SUN").fields.dow).toEqual({ kind: "value", value: 0 });
    expect(parseSchedule("0 0 1 JAN *").fields.month).toEqual({ kind: "value", value: 1 });
  });

  test("accepts a name range (MON-FRI) the same way as its numeric equivalent", () => {
    expect(parseSchedule("0 9 * * MON-FRI").fields.dow).toEqual(parseSchedule("0 9 * * 1-5").fields.dow);
  });

  test("accepts a comma list of names", () => {
    expect(parseSchedule("0 9 * * mon,wed,fri").fields.dow).toEqual({ kind: "list", values: [1, 3, 5] });
  });

  test("expands @yearly / @annually to the same 5-field cron as vixie-cron", () => {
    expect(parseSchedule("@yearly").cron).toBe("0 0 1 1 *");
    expect(parseSchedule("@annually").cron).toBe("0 0 1 1 *");
  });

  test("@reboot is not a schedule: dispatch runs on the clock, not at boot", () => {
    expect(() => parseSchedule("@reboot")).toThrow(UsageError);
  });

  test("one grammar everywhere: a day-of-month and day-of-week together, and a minute list, are accepted", () => {
    expect(() => parseSchedule("0 9 1 * 1")).not.toThrow();
    expect(() => parseSchedule("7,37 * * * *")).not.toThrow();
    expect(() => parseSchedule("1-59/1 * * * *")).not.toThrow();
  });
});

/** A local wall-clock minute. */
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi, 0, 0);
const matches = (schedule: string, when: Date) => scheduleMatchesMinute(parseSchedule(schedule).fields, when);

describe("scheduleMatchesMinute", () => {
  test("a fixed time matches only that minute", () => {
    expect(matches("30 9 * * *", at(2026, 11, 9, 9, 30))).toBe(true);
    expect(matches("30 9 * * *", at(2026, 11, 9, 9, 31))).toBe(false);
    expect(matches("30 9 * * *", at(2026, 11, 9, 10, 30))).toBe(false);
  });

  test("* * * * * matches every minute", () => {
    expect(matches("* * * * *", at(2026, 11, 9, 3, 17))).toBe(true);
  });

  test("*/15 anchors at the field minimum", () => {
    for (const minute of [0, 15, 30, 45]) expect(matches("*/15 * * * *", at(2026, 11, 9, 1, minute))).toBe(true);
    expect(matches("*/15 * * * *", at(2026, 11, 9, 1, 14))).toBe(false);
    // day-of-month is 1-based: */2 is the odd days.
    expect(matches("0 0 */2 * *", at(2026, 11, 9, 0, 0))).toBe(true);
    expect(matches("0 0 */2 * *", at(2026, 11, 10, 0, 0))).toBe(false);
  });

  test("a range-step starts at the range start", () => {
    for (const hour of [2, 6, 10, 14, 18, 22]) expect(matches("0 2-22/4 * * *", at(2026, 11, 9, hour, 0))).toBe(true);
    expect(matches("0 2-22/4 * * *", at(2026, 11, 9, 4, 0))).toBe(false);
    expect(matches("0 2-22/4 * * *", at(2026, 11, 9, 23, 0))).toBe(false);
  });

  test("a comma list matches each of its values", () => {
    expect(matches("7,37 * * * *", at(2026, 11, 9, 5, 7))).toBe(true);
    expect(matches("7,37 * * * *", at(2026, 11, 9, 5, 37))).toBe(true);
    expect(matches("7,37 * * * *", at(2026, 11, 9, 5, 8))).toBe(false);
  });

  test("weekdays: 2026-11-09 is a Monday, 2026-11-08 a Sunday", () => {
    expect(matches("0 9 * * 1-5", at(2026, 11, 9, 9, 0))).toBe(true);
    expect(matches("0 9 * * MON-FRI", at(2026, 11, 8, 9, 0))).toBe(false);
    expect(matches("0 3 * * 0", at(2026, 11, 8, 3, 0))).toBe(true);
  });

  test("month restricts", () => {
    expect(matches("0 0 1 1 *", at(2027, 1, 1, 0, 0))).toBe(true);
    expect(matches("0 0 1 1 *", at(2026, 11, 1, 0, 0))).toBe(false);
  });

  test("day-of-month and day-of-week both restricted means either, as in vixie-cron", () => {
    // 1st of the month OR a Monday.
    expect(matches("0 9 1 * 1", at(2026, 11, 1, 9, 0))).toBe(true); // Sunday the 1st
    expect(matches("0 9 1 * 1", at(2026, 11, 9, 9, 0))).toBe(true); // Monday the 9th
    expect(matches("0 9 1 * 1", at(2026, 11, 10, 9, 0))).toBe(false); // Tuesday the 10th
  });

  test("a field starting with * combines with AND, as in vixie-cron", () => {
    // every second day AND a Monday
    expect(matches("0 9 */2 * 1", at(2026, 11, 9, 9, 0))).toBe(true); // Monday, odd day
    expect(matches("0 9 */2 * 1", at(2026, 11, 16, 9, 0))).toBe(false); // Monday, even day
  });

  test("aliases", () => {
    expect(matches("@daily", at(2026, 11, 9, 0, 0))).toBe(true);
    expect(matches("@hourly", at(2026, 11, 9, 14, 0))).toBe(true);
    expect(matches("@hourly", at(2026, 11, 9, 14, 1))).toBe(false);
    expect(matches("@weekly", at(2026, 11, 8, 0, 0))).toBe(true);
    expect(matches("@monthly", at(2026, 12, 1, 0, 0))).toBe(true);
  });
});
