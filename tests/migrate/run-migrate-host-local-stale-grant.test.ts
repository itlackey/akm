// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `runMigration({ apply: true, hostLocal: true })` — what `reconcileOnVersionChange`
 * and `akm upgrade` run unattended — must never rebind a scheduler grant whose
 * `sourceId` is present but stale. Only an explicit, human-typed command may do
 * that (see `docs architecture` note on authority-bearing records).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import path from "node:path";
import { runMigration } from "../../scripts/akm-migrate/run-migrate";
import { loadConfig, resetConfigCache } from "../../src/core/config/config";
import { bundleSourceId, filesystemBundleSourceId } from "../../src/core/config/config-sources";
import { schedulerActivations } from "../../src/tasks/activation-config";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  resetConfigCache();
});

afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

test("apply --host-local leaves a grant with a stale sourceId unchanged", async () => {
  const staleSourceId = filesystemBundleSourceId(path.join(storage.stashDir, "..", "different-origin"));
  writeSandboxConfig({
    defaultBundle: "team",
    bundles: { team: { path: storage.stashDir, writable: true } },
    scheduler: { enabled: [{ kind: "task", ref: "team//tasks/nightly", sourceId: staleSourceId }] },
  });
  const currentSourceId = bundleSourceId(loadConfig(), "team");
  expect(currentSourceId).not.toBe(staleSourceId);

  const plan = await runMigration({ apply: true, hostLocal: true });

  expect(plan.status).toBe("current");
  expect(plan.configSchedulerSourceIds && "applied" in plan.configSchedulerSourceIds).toBe(true);
  expect((plan.configSchedulerSourceIds as { applied: boolean }).applied).toBe(false);

  resetConfigCache();
  expect(schedulerActivations(loadConfig())).toEqual([
    { kind: "task", ref: "team//tasks/nightly", sourceId: staleSourceId },
  ]);
});
