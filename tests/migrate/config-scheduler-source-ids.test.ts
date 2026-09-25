// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  applyConfigSchedulerSourceIdMigration,
  findConfigSchedulerSourceIdMigration,
} from "../../scripts/akm-migrate/migrate/config-scheduler-source-ids";
import { deriveBundleId } from "../../src/core/bundle-id";
import { loadConfig, resetConfigCache } from "../../src/core/config/config";
import { bundleSourceId, filesystemBundleSourceId } from "../../src/core/config/config-sources";
import { getConfigPath } from "../../src/core/paths";
import { schedulerActivations } from "../../src/tasks/activation-config";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => storage.cleanup());

function writeLegacyConfig(): void {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      bundles: { team: { path: storage.stashDir } },
      defaultBundle: "team",
      scheduler: {
        enabled: [
          { kind: "task", ref: "team//tasks/nightly" },
          { kind: "task", ref: "removed//tasks/stale" },
        ],
      },
    }),
  );
  resetConfigCache();
}

describe("scheduler source-id config migration", () => {
  test("runtime rejects the old grant shape and points to akm-migrate", () => {
    writeLegacyConfig();
    expect(() => loadConfig()).toThrow(/sourceId/);
    try {
      loadConfig();
    } catch (error) {
      expect((error as { hint(): string | undefined }).hint()).toMatch(/akm migrate apply/);
    }
  });

  test("preview is read-only; apply binds live bundles and removes orphaned grants", () => {
    writeLegacyConfig();
    const before = fs.readFileSync(getConfigPath(), "utf8");
    const plan = findConfigSchedulerSourceIdMigration(getConfigPath());
    expect(plan.changes.map((change) => [change.kind, change.ref])).toEqual([
      ["bind", "team//tasks/nightly"],
      ["drop", "removed//tasks/stale"],
    ]);
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);

    expect(applyConfigSchedulerSourceIdMigration(getConfigPath()).applied).toBe(true);
    resetConfigCache();
    const config = loadConfig();
    expect(schedulerActivations(config)).toEqual([
      { kind: "task", ref: "team//tasks/nightly", sourceId: bundleSourceId(config, "team") },
    ]);
    expect(findConfigSchedulerSourceIdMigration(getConfigPath()).changes).toEqual([]);
  });

  test("leaves a grant with a present but stale sourceId untouched", () => {
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const staleSourceId = filesystemBundleSourceId(path.join(storage.stashDir, "..", "different-origin"));
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        bundles: { team: { path: storage.stashDir } },
        defaultBundle: "team",
        scheduler: {
          enabled: [{ kind: "task", ref: "team//tasks/nightly", sourceId: staleSourceId }],
        },
      }),
    );
    resetConfigCache();

    expect(findConfigSchedulerSourceIdMigration(configPath).changes).toEqual([]);
    expect(applyConfigSchedulerSourceIdMigration(configPath).applied).toBe(false);
    resetConfigCache();
    expect(schedulerActivations(loadConfig())).toEqual([
      { kind: "task", ref: "team//tasks/nightly", sourceId: staleSourceId },
    ]);
  });

  test("leaves an already-granted activation alone when its bundle isn't configured right now", () => {
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const staleSourceId = filesystemBundleSourceId(path.join(storage.stashDir, "..", "different-origin"));
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        scheduler: { enabled: [{ kind: "task", ref: "removed//tasks/nightly", sourceId: staleSourceId }] },
      }),
    );
    resetConfigCache();

    expect(findConfigSchedulerSourceIdMigration(configPath).changes).toEqual([]);
    expect(applyConfigSchedulerSourceIdMigration(configPath).applied).toBe(false);
    resetConfigCache();
    expect(schedulerActivations(loadConfig())).toEqual([
      { kind: "task", ref: "removed//tasks/nightly", sourceId: staleSourceId },
    ]);
  });

  test("binds an environment-only working bundle instead of dropping its grant", () => {
    const bundleId = deriveBundleId(undefined, storage.stashDir, new Set());
    fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
    fs.writeFileSync(
      getConfigPath(),
      JSON.stringify({
        configVersion: "0.9.0",
        scheduler: { enabled: [{ kind: "task", ref: `${bundleId}//tasks/nightly` }] },
      }),
    );

    const result = applyConfigSchedulerSourceIdMigration(getConfigPath());

    expect(result.changes).toEqual([
      {
        kind: "bind",
        ref: `${bundleId}//tasks/nightly`,
        sourceId: filesystemBundleSourceId(storage.stashDir),
      },
    ]);
  });
});
