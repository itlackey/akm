// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getMigrationApplyJournalPath, inspectMigrationState } from "../../src/core/migration-backup";
import { getConfigPath, getStateDbPathInDataDir } from "../../src/core/paths";
import { openStateDatabase } from "../../src/core/state-db";
import { openStateDbAtCeiling, PRE_CUTOVER_STATE_CEILING } from "../_fixtures/migration/seed-rows";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

// These refs are frozen 0.8 migration inputs. Do not run the ref-literal codemod
// over this file; successful post-migration assertions deliberately use 0.9 refs.

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => storage.cleanup());

function seedMigration(workflowRef: string, createWorkflow = true): { prepared: string; taskPath: string } {
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
  if (createWorkflow) fs.writeFileSync(path.join(storage.stashDir, "workflows", "upgrade-noop.md"), "# Noop\n");
  const taskPath = path.join(storage.stashDir, "tasks", "upgrade-workflow.yml");
  fs.writeFileSync(
    taskPath,
    `schedule: "@daily"\nworkflow: ${workflowRef}\nparams: '{"source":"published"}'\nenabled: true\n`,
  );
  return { prepared, taskPath };
}

test("migrate apply rewrites a persisted 0.8 workflow target and leaves current task bytes unchanged", async () => {
  const { prepared, taskPath } = seedMigration("workflow:upgrade-noop");
  const currentTaskPath = path.join(storage.stashDir, "tasks", "manual-current.yml");
  const currentTask = 'version: 2\nschedule: "@daily"\nworkflow: workflows/upgrade-noop\nenabled: true\n';
  fs.writeFileSync(currentTaskPath, currentTask);

  const applied = await runCliCapture(["migrate", "apply", "--config", prepared]);
  expect(applied.code, applied.stderr).toBe(0);
  expect(fs.readFileSync(taskPath, "utf8")).toContain("workflow: workflows/upgrade-noop");
  expect(fs.readFileSync(taskPath, "utf8")).not.toContain("workflow: workflow:upgrade-noop");
  expect(fs.readFileSync(currentTaskPath, "utf8")).toBe(currentTask);
});

test("an unresolvable persisted workflow target fails before task mutation and restores core artifacts", async () => {
  const { prepared, taskPath } = seedMigration("workflow:missing", false);
  const originalTask = fs.readFileSync(taskPath);
  const originalConfig = fs.readFileSync(getConfigPath());

  const applied = await runCliCapture(["migrate", "apply", "--config", prepared]);
  expect(applied.code).not.toBe(0);
  expect(applied.stderr).toMatch(/workflow:missing.*not found/i);
  expect(applied.stderr).toMatch(/upgrade-workflow\.yml.*rerun `akm migrate apply`/i);
  expect(fs.readFileSync(taskPath)).toEqual(originalTask);
  expect(fs.readFileSync(getConfigPath())).toEqual(originalConfig);
  expect(inspectMigrationState().state.status).toBe("old");
  expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(false);
});

test("a crash after task mutation resumes the journaled forward phase idempotently", async () => {
  const { prepared, taskPath } = seedMigration("workflow:upgrade-noop");
  const child = Bun.spawn(["bun", "src/cli.ts", "migrate", "apply", "--config", prepared], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: { ...process.env, AKM_TEST_MIGRATION_CRASH_GAP: "tasks" },
    stdout: "pipe",
    stderr: "pipe",
  });
  await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);

  expect(JSON.parse(fs.readFileSync(getMigrationApplyJournalPath(), "utf8")).phase).toBe("tasks-prepared");
  const migratedTask = fs.readFileSync(taskPath, "utf8");
  expect(migratedTask).toContain("workflow: workflows/upgrade-noop");

  const resumed = await runCliCapture(["migrate", "apply"]);
  expect(resumed.code, resumed.stderr).toBe(0);
  expect(fs.readFileSync(taskPath, "utf8")).toBe(migratedTask);
  expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(false);
});

test("migrate status and apply repair a legacy task after core artifacts are already current", async () => {
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(
    getConfigPath(),
    `${JSON.stringify({
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      bundles: { stash: { path: storage.stashDir, writable: true } },
      defaultBundle: "stash",
    })}\n`,
    { mode: 0o600 },
  );
  openStateDatabase().close();
  fs.mkdirSync(path.join(storage.stashDir, "tasks"), { recursive: true });
  fs.mkdirSync(path.join(storage.stashDir, "workflows"), { recursive: true });
  fs.writeFileSync(path.join(storage.stashDir, "workflows", "upgrade-noop.md"), "# Noop\n");
  const taskPath = path.join(storage.stashDir, "tasks", "upgrade-workflow.yml");
  fs.writeFileSync(taskPath, 'schedule: "@daily"\nworkflow: workflow:upgrade-noop\nenabled: true\n');

  const status = await runCliCapture(["migrate", "status"]);
  expect(status.code, status.stderr).toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({ status: "ready" });
  expect(fs.readFileSync(taskPath, "utf8")).toContain("workflow: workflow:upgrade-noop");

  const applied = await runCliCapture(["migrate", "apply"]);
  expect(applied.code, applied.stderr).toBe(0);
  expect(fs.readFileSync(taskPath, "utf8")).toContain("workflow: workflows/upgrade-noop");
  expect(inspectMigrationState()).toMatchObject({
    config: { status: "current" },
    state: { status: "current" },
    workflow: { status: "missing" },
  });
});
