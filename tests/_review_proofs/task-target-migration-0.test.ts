// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// PROOF: a single drifted (dangling) persisted 0.8 `workflow:` task target
// blocks the ENTIRE 0.9 migration, pre-backup, and there is no aggregation, so
// N drifted tasks must be repaired one at a time. Modeled on the known-good
// harness in tests/integration/task-target-ref-migration.test.ts.

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getMigrationApplyJournalPath, inspectMigrationState } from "../../src/core/migration-backup";
import { getConfigPath, getStateDbPathInDataDir } from "../../src/core/paths";
import { openStateDbAtCeiling, PRE_CUTOVER_STATE_CEILING } from "../_fixtures/migration/seed-rows";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => storage.cleanup());

/** Seed a realistic 0.8.x install with a prepared 0.9 config and a fresh pre-cutover state.db. */
function seed(): { prepared: string } {
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(
    getConfigPath(),
    `${JSON.stringify({ configVersion: "0.8.0", stashDir: storage.stashDir, sources: [] })}\n`,
    { mode: 0o600 },
  );
  const prepared = path.join(storage.root, "prepared-0.9.json");
  fs.writeFileSync(
    prepared,
    `${JSON.stringify({
      configVersion: "0.9.0",
      stashDir: storage.stashDir,
      sources: [],
      semanticSearchMode: "off",
    })}\n`,
    { mode: 0o600 },
  );
  openStateDbAtCeiling(getStateDbPathInDataDir(), PRE_CUTOVER_STATE_CEILING).close();
  fs.mkdirSync(path.join(storage.stashDir, "tasks"), { recursive: true });
  fs.mkdirSync(path.join(storage.stashDir, "workflows"), { recursive: true });
  return { prepared };
}

test("a single drifted version:1 scheduled task with a deleted workflow blocks the ENTIRE migration; only manual repair unblocks it", async () => {
  const { prepared } = seed();
  // A perfectly ordinary 0.8 scheduled task whose workflow was deleted/renamed
  // months ago. Harmless drift in 0.8 (it only fails when it fires).
  const taskPath = path.join(storage.stashDir, "tasks", "nightly.yml");
  const originalTask = "version: 1\nschedule: '0 2 * * *'\nworkflow: workflow:ship\nenabled: true\n";
  fs.writeFileSync(taskPath, originalTask);
  // NO workflows/ship.{md,yaml,yml} exists.

  const configBefore = fs.readFileSync(getConfigPath());

  const blocked = await runCliCapture(["migrate", "apply", "--config", prepared]);

  // The whole upgrade is refused because of one dangling task target.
  expect(blocked.code).not.toBe(0);
  expect(blocked.stderr).toMatch(/workflow:ship.*not found/i);
  expect(blocked.stderr).toMatch(/nightly\.yml/);
  expect(blocked.stderr).toMatch(/rerun `akm migrate apply`/i);

  // Failed pre-backup / pre-cutover: nothing mutated, no forward journal, DB still old.
  expect(fs.readFileSync(taskPath, "utf8")).toBe(originalTask);
  expect(fs.readFileSync(getConfigPath())).toEqual(configBefore);
  expect(inspectMigrationState().state.status).toBe("old");
  expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(false);

  // The ONLY way to proceed is to hand-restore the missing workflow file.
  fs.writeFileSync(path.join(storage.stashDir, "workflows", "ship.md"), "# Ship\n");

  const ok = await runCliCapture(["migrate", "apply", "--config", prepared]);
  expect(ok.code, ok.stderr).toBe(0);
  const migrated = fs.readFileSync(taskPath, "utf8");
  expect(migrated).toContain("workflow: workflows/ship");
  expect(migrated).not.toContain("workflow: workflow:ship");
});

test("no aggregation: with two drifted tasks the planner reports only the first and stops", async () => {
  const { prepared } = seed();
  // Two independent drifted tasks. Neither workflow exists.
  fs.writeFileSync(path.join(storage.stashDir, "tasks", "a-drift.yml"), "version: 1\nworkflow: workflow:alpha\n");
  fs.writeFileSync(path.join(storage.stashDir, "tasks", "z-drift.yml"), "version: 1\nworkflow: workflow:omega\n");

  const blocked = await runCliCapture(["migrate", "apply", "--config", prepared]);
  expect(blocked.code).not.toBe(0);

  // Fails on the first file alphabetically; the second is never surfaced. A user
  // must fix a-drift.yml, re-run, discover z-drift.yml, and repeat.
  expect(blocked.stderr).toMatch(/a-drift\.yml/);
  expect(blocked.stderr).not.toMatch(/z-drift\.yml/);
});
