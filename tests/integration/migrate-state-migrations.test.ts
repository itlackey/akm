// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm-migrate` runs every migration in one plan, in order: config.json in
 * its current shape, pending state.db migrations, asset keys and refs. These
 * prove the config rewrite (retired keys dropped), that a state.db at the
 * 0.9.32 floor is current, and that one below it is refused whole with the
 * 0.9.32 recipe before any step runs.
 *
 * Integration: seeds and opens a real state.db under an isolated data dir.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runMigration } from "../../scripts/akm-migrate/run-migrate";
import { loadConfig, resetConfigCache } from "../../src/core/config/config";
import { STATE_BASELINE_IDS, STATE_MIGRATIONS } from "../../src/core/state/migrations";
import { getStateDbPath, openStateDatabase } from "../../src/core/state-db";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../src/core/warn";
import { openDatabase } from "../../src/storage/database";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
beforeEach(() => {
  storage = withIsolatedAkmStorage();
  resetConfigCache();
});
afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

function ledgerLength(file: string): number {
  const db = openDatabase(file, { readonly: true });
  try {
    return (db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count;
  } finally {
    db.close();
  }
}

/** A state.db whose ledger stops one short of the 0.9.32 floor: nothing a 0.9.32 akm ever opened. */
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

function stateDbOpens(file: string): boolean {
  try {
    openStateDatabase(file).close();
    return true;
  } catch {
    return false;
  }
}

/** A config on the legacy `stashDir`/`sources[]` shape, pointing `stashDir` at an existing dir. */
function writeLegacySourceShapeConfig(configDir: string, stashDir: string): string {
  const configPath = path.join(configDir, "akm", "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      configVersion: "0.9.0",
      stashDir,
      sources: [{ type: "git", url: "https://example.com/team.git", name: "team" }],
    }),
  );
  return configPath;
}

/** A config carrying a retired top-level key, a live and a retired `experimental.*` key. */
function writeRetiredConfigKeysConfig(configDir: string): string {
  const configPath = path.join(configDir, "akm", "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      configVersion: "0.9.0",
      llm: { model: "gpt-4" },
      experimental: { improveAutonomy: true, workflowEngine: true },
    }),
  );
  return configPath;
}

test("a state.db at the 0.9.32 floor is current: status and apply report nothing pending", async () => {
  const file = getStateDbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  openStateDatabase(file).close();

  const status = await runMigration({ apply: false });
  expect(status.stateMigrations).toEqual({ pending: [] });
  expect(status.status).toBe("current");

  const applied = await runMigration({ apply: true });
  expect(applied.stateMigrations).toEqual({ applied: [] });
  expect(applied.status).toBe("current");
  expect(ledgerLength(file)).toBe(STATE_MIGRATIONS.length);
  expect(stateDbOpens(file)).toBe(true);
});

for (const apply of [false, true]) {
  test(`${apply ? "apply" : "status"}: a state.db below the floor is refused whole, naming the recipe, before any step runs`, async () => {
    const file = getStateDbPath();
    seedBelowFloor(file);
    const configPath = writeRetiredConfigKeysConfig(storage.configDir);
    const configBefore = fs.readFileSync(configPath, "utf8");

    const plan = await runMigration({ apply });

    expect(plan.status).toBe("blocked");
    expect(plan.blockers).toHaveLength(1);
    expect(plan.blockers[0]).toMatch(/predates akm 0\.9\.32.*akm-cli@0\.9\.32 && akm migrate apply && akm task sync/);
    // No step ran: no section in the plan, config.json and state.db exactly as they were.
    expect(plan.configFile).toBeUndefined();
    expect(plan.stateMigrations).toBeUndefined();
    expect(fs.readFileSync(configPath, "utf8")).toBe(configBefore);
    expect(ledgerLength(file)).toBe(STATE_BASELINE_IDS.length - 1);
  });
}

test("dry-run reports a pending retired top-level and nested key removal, leaving the config file unchanged", async () => {
  const configPath = writeRetiredConfigKeysConfig(storage.configDir);

  const plan = await runMigration({ apply: false });

  expect(plan.configFile).toMatchObject({ changed: true, applied: false });
  expect(plan.configFile?.keys).toEqual(expect.arrayContaining(["experimental", "llm"]));
  // apply will rewrite config.json, so the preview must not claim "current".
  expect(plan.status).toBe("ready");
  const written = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    llm: unknown;
    experimental: Record<string, unknown>;
  };
  expect(written.llm).toEqual({ model: "gpt-4" });
  expect(written.experimental).toEqual({ improveAutonomy: true, workflowEngine: true });
});

test("apply removes the retired top-level and nested keys, keeps the live one, and the next loadConfig warns nothing about it", async () => {
  const configPath = writeRetiredConfigKeysConfig(storage.configDir);

  const plan = await runMigration({ apply: true });

  expect(plan.configFile?.applied).toBe(true);
  expect(plan.configFile?.keys).toEqual(expect.arrayContaining(["experimental", "llm"]));
  const written = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    llm?: unknown;
    experimental: Record<string, unknown>;
  };
  expect(written.llm).toBeUndefined();
  expect(written.experimental).toEqual({ improveAutonomy: true });

  resetConfigCache();
  _resetWarnOnceForTests();
  const warnings: string[] = [];
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
  try {
    loadConfig();
  } finally {
    _setWarnSinkForTests(undefined);
  }
  expect(warnings.some((w) => w.includes("workflowEngine"))).toBe(false);
  expect(warnings.some((w) => w.includes("retired config key"))).toBe(false);
});

test("a pre-0.9.32 stashDir/sources config is not converted: apply blocks on it, naming the 0.9.32 recipe, and leaves the file unchanged", async () => {
  const configPath = writeLegacySourceShapeConfig(storage.configDir, storage.stashDir);
  const before = fs.readFileSync(configPath, "utf8");

  const plan = await runMigration({ apply: true });

  expect(plan.configFile).toBeUndefined();
  expect(plan.status).toBe("blocked");
  expect(plan.blockers.join("\n")).toMatch(/predates akm 0\.9\.32.*akm-cli@0\.9\.32 && akm migrate apply/);
  expect(fs.readFileSync(configPath, "utf8")).toBe(before);
});
