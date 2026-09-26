// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm health` used to let the managed `openStateDatabase` call throw when
 * state.db held a pending historical-destructive migration
 * (018-drop-dead-lane-schema) — the whole command crashed with a config-error
 * exit (78) instead of reporting. Bundlers (OpenPalm) grepped the refusal's
 * error text to detect this case; the `state-db-migrations` hard check is the
 * coupling this file pins the replacement for.
 *
 * Every state.db open now applies pending migrations (copying the file aside
 * first when one drops schema), health's own open included. So a pending
 * migration is no longer a failure to report: `state-db-migrations` passes and
 * names what health's open applied, and the command never exits 78.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runMigration } from "../../../scripts/akm-migrate/run-migrate";
import { EXIT_CODES } from "../../../src/cli/shared";
import { akmHealth } from "../../../src/commands/health";
import { resetConfigCache } from "../../../src/core/config/config";
import { STATE_MIGRATIONS } from "../../../src/core/state/migrations";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { openDatabase } from "../../../src/storage/database";
import { runMigrations } from "../../../src/storage/sqlite-migrations";
import { runCliCapture } from "../../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const BEFORE_018 = STATE_MIGRATIONS.slice(
  0,
  STATE_MIGRATIONS.findIndex((migration) => migration.id === "018-drop-dead-lane-schema"),
);

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  resetConfigCache();
});

afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

/** A state.db whose ledger stops exactly before 018 (mirrors migrate-state-migrations.test.ts). */
function seedBefore018(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const seeded = openDatabase(file);
  runMigrations(seeded, BEFORE_018);
  seeded.close();
}

function findHardCheck(result: Awaited<ReturnType<typeof akmHealth>>, name: string) {
  const found = result.hardChecks.find((check) => check.name === name);
  if (!found) throw new Error(`expected a hard check named ${name}`);
  return found;
}

test("health's own open applies a pending historical-destructive migration and reports it", async () => {
  const file = getStateDbPath();
  seedBefore018(file);

  const result = await akmHealth();

  const check = findHardCheck(result, "state-db-migrations");
  expect(check.status).toBe("pass");
  const applied = check.evidence?.applied as string[];
  expect(applied[0]).toBe("018-drop-dead-lane-schema");
  expect(applied.at(-1)).toBe(STATE_MIGRATIONS.at(-1)?.id);
  expect(check.evidence?.pending).toEqual([]);
  expect(check.evidence?.backupPath).toBe(`${file}.pre-018-drop-dead-lane-schema.bak`);
  expect(fs.existsSync(`${file}.pre-018-drop-dead-lane-schema.bak`)).toBe(true);
});

test("the CLI migrates a pending state.db and never exits 78", async () => {
  const file = getStateDbPath();
  seedBefore018(file);

  const { code, stdout } = await runCliCapture(["health", "--format", "json"]);
  expect(code).not.toBe(EXIT_CODES.CONFIG);

  const parsed = JSON.parse(stdout) as {
    hardChecks?: Array<{ name: string; status: string; evidence?: { applied?: string[] } }>;
  };
  const check = parsed.hardChecks?.find((c) => c.name === "state-db-migrations");
  expect(check?.status).toBe("pass");
  expect(check?.evidence?.applied?.[0]).toBe("018-drop-dead-lane-schema");
});

test("applying the pending migration flips the check back to pass", async () => {
  const file = getStateDbPath();
  seedBefore018(file);

  await runMigration({ apply: true });

  const result = await akmHealth();
  const check = findHardCheck(result, "state-db-migrations");
  expect(check.status).toBe("pass");
  expect(check.evidence?.pending).toEqual([]);
});

test("a current, freshly-created state.db reports pass with no pending migrations", async () => {
  openStateDatabase(getStateDbPath()).close();

  const result = await akmHealth();
  const check = findHardCheck(result, "state-db-migrations");
  expect(check.status).toBe("pass");
  expect(check.evidence?.pending).toEqual([]);
});
