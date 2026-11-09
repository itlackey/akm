// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * 0.10 does not convert a task source below version 4: akm 0.9.32 did, and is the floor. `akm migrate status|apply`
 * must say so, with the recipe, instead of reporting a clean plan for a task that cannot run.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runMigration } from "../../scripts/akm-migrate/run-migrate";
import { resetConfigCache } from "../../src/core/config/config";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  resetConfigCache();
  writeSandboxConfig({ defaultBundle: "primary", bundles: { primary: { path: storage.stashDir, writable: true } } });
});

afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

function writeTask(name: string, yaml: string): string {
  const dir = path.join(storage.stashDir, "tasks");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, yaml);
  return file;
}

for (const apply of [false, true]) {
  test(`${apply ? "apply" : "status"}: a version 3 task is a blocker that names the 0.9.32 recipe`, async () => {
    const file = writeTask("old.yml", "version: 3\nid: old\nschedule: []\n");

    const plan = await runMigration({ apply });

    expect(plan.status).toBe("blocked");
    const line = plan.blockers.find((blocker) => blocker.includes(file));
    expect(line).toContain("version 3");
    expect(line).toContain("npm i -g akm-cli@0.9.32 && akm migrate apply && akm task sync");
  });

  test(`${apply ? "apply" : "status"}: a version 4 task is no blocker`, async () => {
    writeTask("current.yml", "version: 4\nid: current\n");

    const plan = await runMigration({ apply });

    expect(plan.blockers).toEqual([]);
  });
}
