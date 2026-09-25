// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `runMigration({ apply, hostLocal: true })` — `akm-migrate apply|status
 * --host-local` — must reconcile config.json/state.db/scheduler
 * grants/$DATA/txn only, and must never rewrite bundle content: task
 * v2/v3/v4 sources, dead `.akm` residue, and writer relocation stay
 * reachable only through a full `apply`.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runMigration } from "../../scripts/akm-migrate/run-migrate";
import { resetConfigCache } from "../../src/core/config/config";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let taskV2Path: string;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  resetConfigCache();
  writeSandboxConfig({
    defaultBundle: "primary",
    bundles: { primary: { path: storage.stashDir, writable: true } },
    // A retired top-level key: host-local mode must still lift it, exactly
    // like the full plan does (step 2 of `akm-migrate help`).
    llm: { model: "gpt-4" },
  });
  taskV2Path = path.join(storage.stashDir, "tasks", "demo.yml");
  fs.mkdirSync(path.dirname(taskV2Path), { recursive: true });
  fs.writeFileSync(taskV2Path, "version: 2\nschedule: '@daily'\ncommand: /bin/echo ok\n");
});

afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

test("apply --host-local reconciles host-local state but never rewrites bundle content", async () => {
  const before = fs.readFileSync(taskV2Path, "utf8");

  const plan = await runMigration({ apply: true, hostLocal: true });

  expect(plan.mode).toBe("host-local");
  // Skipped sections are absent, not empty.
  expect(plan.taskV3Migration).toBeUndefined();
  expect(plan.taskV4Migration).toBeUndefined();
  expect(plan.deadResidue).toBeUndefined();
  expect(plan.writerRelocation).toBeUndefined();
  expect(plan.backupPath).toBeUndefined();
  expect(plan.taskV4BackupPath).toBeUndefined();
  // Host-local sections did run.
  expect(plan.configRetiredKeys && "applied" in plan.configRetiredKeys).toBe(true);
  expect(plan.stateMigrations).toBeDefined();
  expect(plan.schedulerActivation).toBeDefined();
  expect(plan.staleTxns && "recovered" in plan.staleTxns).toBe(true);

  // The task v2 file — bundle content — was never touched.
  expect(fs.readFileSync(taskV2Path, "utf8")).toBe(before);

  // The retired top-level key was lifted from config.json (host-local IS
  // config.json).
  const rawConfig = JSON.parse(fs.readFileSync(path.join(storage.configDir, "akm", "config.json"), "utf8")) as Record<
    string,
    unknown
  >;
  expect(rawConfig.llm).toBeUndefined();
});

test("status --host-local is read-only and reports the same skipped/present sections", async () => {
  const before = fs.readFileSync(taskV2Path, "utf8");

  const plan = await runMigration({ apply: false, hostLocal: true });

  expect(plan.mode).toBe("host-local");
  expect(plan.taskV3Migration).toBeUndefined();
  expect(plan.taskV4Migration).toBeUndefined();
  expect(plan.deadResidue).toBeUndefined();
  expect(plan.writerRelocation).toBeUndefined();
  expect(plan.configRetiredKeys && "pending" in plan.configRetiredKeys).toBe(true);
  expect(plan.staleTxns && "pending" in plan.staleTxns).toBe(true);

  expect(fs.readFileSync(taskV2Path, "utf8")).toBe(before);
  const rawConfig = JSON.parse(fs.readFileSync(path.join(storage.configDir, "akm", "config.json"), "utf8")) as Record<
    string,
    unknown
  >;
  expect(rawConfig.llm).toEqual({ model: "gpt-4" });
});
