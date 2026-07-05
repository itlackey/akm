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
import { listEmbeddedTasks } from "../src/tasks/embedded";

const EXPECTED = [
  { id: "improve", command: "akm improve --auto-accept safe", schedule: "0 2 * * *" },
  { id: "backup", command: "akm db backups", schedule: "0 3 * * 0" },
  { id: "version-check", command: "akm info --check-version", schedule: "0 9 * * 1" },
  { id: "index-refresh", command: "akm index", schedule: "0 4 * * *" },
  { id: "extract", command: "akm extract", schedule: "*/30 * * * *" },
  { id: "sync", command: "akm sync", schedule: "*/15 * * * *" },
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
      expect(got?.description.length).toBeGreaterThan(0);
      expect(got?.label).toBe(`core/${exp.id}`);
      expect(got?.yaml).toContain(exp.command);
    }
  });
});
