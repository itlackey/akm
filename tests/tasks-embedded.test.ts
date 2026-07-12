// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Embedded core task registry — asserts the 6 bundled templates are present
 * with the exact ids, commands, and default schedules from issue #512, and
 * that they are read from the bundled assets dir (not any user stash).
 *
 * `update-stashes` (nightly `akm update --all`) was retired in meta-review
 * 06-M2 — third-party stash pulls are on-demand only now.
 */
import { describe, expect, test } from "bun:test";
import type { ArgsDef } from "citty";
import { main } from "../src/cli";
import { findCittyTopLevelCommand } from "../src/cli/parse-args";
import { listEmbeddedTasks } from "../src/tasks/embedded";
import { parseTaskDocument } from "../src/tasks/parser";

const EXPECTED = [
  { id: "improve", command: "akm improve --auto-accept safe", schedule: "0 2 * * *", enabled: true },
  { id: "backup", command: "akm db backups", schedule: "0 3 * * 0", enabled: false },
  { id: "version-check", command: "akm info --check-version", schedule: "0 9 * * 1", enabled: true },
  { id: "index-refresh", command: "akm index", schedule: "0 4 * * *", enabled: true },
  { id: "extract", command: "akm extract", schedule: "*/30 * * * *", enabled: true },
  { id: "sync", command: "akm sync", schedule: "*/15 * * * *", enabled: true },
] as const;

describe("embedded core task registry", () => {
  test("enumerates all 6 templates", () => {
    const tasks = listEmbeddedTasks();
    expect(tasks.length).toBe(6);
  });

  test("each template has the exact id, command, and default schedule", () => {
    const tasks = listEmbeddedTasks();
    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const exp of EXPECTED) {
      const got = byId.get(exp.id);
      expect(got, `missing embedded task ${exp.id}`).toBeDefined();
      expect(got?.command).toBe(exp.command);
      expect(got?.schedule).toBe(exp.schedule);
      expect(got?.enabled).toBe(exp.enabled);
      expect(got?.description.length).toBeGreaterThan(0);
      expect(got?.label).toBe(`core/${exp.id}`);
      expect(got?.yaml).toContain(exp.command);
    }
  });

  test("every enabled embedded command resolves to a real top-level CLI command", () => {
    const topLevelArgs = main.args as ArgsDef;
    const topLevelCommands = main.subCommands ?? {};

    for (const embedded of listEmbeddedTasks()) {
      const task = parseTaskDocument({
        id: embedded.id,
        filePath: `embedded:${embedded.id}`,
        yaml: embedded.yaml,
      });
      if (!task.enabled || task.target.kind !== "command") continue;

      const [executable, ...args] = task.target.cmd;
      expect(executable, `${embedded.id} must invoke akm`).toBe("akm");
      const command = findCittyTopLevelCommand(args, topLevelArgs);
      expect(command, `${embedded.id} must name a top-level command`).toBeDefined();
      expect(topLevelCommands, `${embedded.id} invokes unknown command: ${command}`).toHaveProperty(command as string);
    }
  });
});
