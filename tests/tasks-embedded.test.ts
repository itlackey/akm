// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Embedded task registry — asserts the 5 bundled `core/` templates and the 5
 * bundled `improve/` templates are present with the exact ids and default
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
import { describe, expect, test } from "bun:test";
import type { ArgsDef } from "citty";
import { main } from "../src/cli";
import { findCittyTopLevelCommand } from "../src/cli/parse-args";
import { listEmbeddedTasks } from "../src/tasks/embedded";
import { parseTaskSourceV4 } from "../src/tasks/source/task-source-v4";

const EXPECTED = [
  { id: "improve", category: "core", schedule: "0 2 * * *", enabled: true },
  { id: "version-check", category: "core", schedule: "0 9 * * 1", enabled: true },
  { id: "index-refresh", category: "core", schedule: "0 4 * * *", enabled: true },
  { id: "extract", category: "core", schedule: "*/30 * * * *", enabled: true },
  { id: "sync", category: "core", schedule: "*/15 * * * *", enabled: true },
  { id: "akm-improve-frequent", category: "improve", schedule: "40 * * * *", enabled: true },
  { id: "akm-improve-consolidate", category: "improve", schedule: "20 */4 * * *", enabled: true },
  { id: "akm-improve-nightly", category: "improve", schedule: "15 2 * * *", enabled: true },
  { id: "akm-improve-catchup", category: "improve", schedule: "0 4 * * *", enabled: false },
  { id: "akm-graph-refresh-weekly", category: "improve", schedule: "10 3 * * 0", enabled: true },
] as const;

describe("embedded task registry", () => {
  test("enumerates all 10 templates", () => {
    const tasks = listEmbeddedTasks();
    expect(tasks.length).toBe(10);
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
    expect(improveTasks.length).toBe(5);
    for (const task of improveTasks) expect(task.command).toContain("--skip-if-locked");
  });

  // #957: scheduled improve runs should fail loudly (exit 78) rather than
  // silently degrade when an engine/credential is unavailable — the whole
  // point of a nightly job is that nobody is watching it fail quietly.
  test("every scheduled improve template requires available engines (#957)", () => {
    const scheduledImproveTasks = listEmbeddedTasks().filter(
      (t) => t.label === "core/improve" || t.label.startsWith("improve/"),
    );
    expect(scheduledImproveTasks.length).toBe(6);
    for (const task of scheduledImproveTasks) expect(task.command).toContain("--require-engines");
  });

  test("every enabled embedded command resolves to a real top-level CLI command", () => {
    const topLevelArgs = main.args as ArgsDef;
    const topLevelCommands = main.subCommands ?? {};

    for (const embedded of listEmbeddedTasks()) {
      const task = parseTaskSourceV4({
        filePath: `embedded:${embedded.id}`,
        yaml: embedded.yaml,
      });
      const scheduleDisabled = task.schedule.length > 0 && task.schedule.every((entry) => !entry.enabled);
      if (scheduleDisabled || task.target.kind !== "run") continue;

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
