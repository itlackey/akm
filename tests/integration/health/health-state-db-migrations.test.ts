// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `state-db-migrations` hard check. Every state.db open applies pending
 * migrations, health's own open included, so a pending migration is not a
 * failure to report: the check passes and names what health's open applied. A
 * state.db below the 0.9.32 floor is the one refusal: health reports it as a
 * failing check naming what is pending, and the command never exits 78.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { EXIT_CODES } from "../../../src/cli/shared";
import { akmHealth } from "../../../src/commands/health";
import { resetConfigCache } from "../../../src/core/config/config";
import { STATE_BASELINE_IDS, STATE_MIGRATIONS } from "../../../src/core/state/migrations";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { openDatabase } from "../../../src/storage/database";
import { runCliCapture } from "../../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  resetConfigCache();
});

afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

/** A state.db whose ledger stops one short of the 0.9.32 floor. */
function seedBelowFloor(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const seeded = openDatabase(file);
  seeded.exec(
    "CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))",
  );
  for (const id of STATE_BASELINE_IDS.slice(0, -1))
    seeded.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(id);
  seeded.close();
}

function findHardCheck(result: Awaited<ReturnType<typeof akmHealth>>, name: string) {
  const found = result.hardChecks.find((check) => check.name === name);
  if (!found) throw new Error(`expected a hard check named ${name}`);
  return found;
}

test("health's own open of a state.db that does not exist yet applies the whole ledger and reports it", async () => {
  const result = await akmHealth();

  const check = findHardCheck(result, "state-db-migrations");
  expect(check.status).toBe("pass");
  const applied = check.evidence?.applied as string[];
  expect(applied[0]).toBe(STATE_MIGRATIONS[0]?.id);
  expect(applied.at(-1)).toBe(STATE_MIGRATIONS.at(-1)?.id);
  expect(check.evidence?.pending).toEqual([]);
});

test("a state.db below the floor is a failing check in the report, not a crash, and is left as it was", async () => {
  const file = getStateDbPath();
  seedBelowFloor(file);

  const { code, stdout } = await runCliCapture(["health", "--format", "json"]);
  expect(code).not.toBe(EXIT_CODES.CONFIG);

  const parsed = JSON.parse(stdout) as { hardChecks?: Array<{ name: string; status: string }> };
  expect(parsed.hardChecks?.find((c) => c.name === "state-db-migrations")?.status).toBe("fail");
  const db = openDatabase(file, { readonly: true });
  expect((db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count).toBe(
    STATE_BASELINE_IDS.length - 1,
  );
  db.close();
});

test("a current, freshly-created state.db reports pass with no pending migrations", async () => {
  openStateDatabase(getStateDbPath()).close();

  const result = await akmHealth();
  const check = findHardCheck(result, "state-db-migrations");
  expect(check.status).toBe("pass");
  expect(check.evidence?.pending).toEqual([]);
});
