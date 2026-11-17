// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** A state.db that is absent or behind on migrations is reported as unavailable, never as an empty queue or zeros. */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../../src/core/config/config";
import { STATE_MIGRATIONS } from "../../../src/core/state/migrations";
import { getStateDbPath } from "../../../src/core/state-db";
import { openDatabase } from "../../../src/storage/database";
import { runMigrations } from "../../../src/storage/sqlite-migrations";
import { activity, assets, proposals } from "../../../src/workspace";
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

async function reads() {
  return [
    await proposals.list({ status: "pending" }),
    await activity.pulse(),
    await assets.improvement({ ref: "stash//lessons/rg" }),
  ];
}

test("no state.db: proposals, pulse and asset improvement say it is absent", async () => {
  expect(fs.existsSync(getStateDbPath())).toBe(false);
  for (const result of await reads()) expect(result).toEqual({ available: false, reason: "absent" });
});

test("a state.db behind on migrations: the same reads say it needs migration", async () => {
  const file = getStateDbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const seeded = openDatabase(file);
  runMigrations(seeded, STATE_MIGRATIONS.slice(0, STATE_MIGRATIONS.length - 1));
  seeded.close();
  for (const result of await reads()) expect(result).toEqual({ available: false, reason: "needs-migration" });
});
