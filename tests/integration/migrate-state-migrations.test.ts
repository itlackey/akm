// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm-migrate` runs every migration in one plan, in order: legacy config
 * lift, pending state.db migrations, the task generations, residue sweeps.
 * These prove the two steps the CLI proper refuses to do on its own -- the
 * config lift a failing `loadConfig` names as its own remedy, and the
 * historical-destructive state migration an ordinary open refuses (#895) --
 * and that they run BEFORE the task migrators, which load config and open
 * state.db themselves.
 *
 * Integration: seeds and opens a real state.db under an isolated data dir.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runMigration } from "../../scripts/akm-migrate/run-migrate";
import { loadConfig, resetConfigCache } from "../../src/core/config/config";
import { STATE_MIGRATIONS } from "../../src/core/state/migrations";
import { getStateDbPath, openStateDatabase } from "../../src/core/state-db";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../src/core/warn";
import { openDatabase } from "../../src/storage/database";
import { runMigrations } from "../../src/storage/engines/sqlite-migrations";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

const BEFORE_018 = STATE_MIGRATIONS.slice(
  0,
  STATE_MIGRATIONS.findIndex((migration) => migration.id === "018-drop-dead-lane-schema"),
);
const FROM_018 = STATE_MIGRATIONS.slice(BEFORE_018.length).map((migration) => migration.id);

let storage: IsolatedAkmStorage;
beforeEach(() => {
  storage = withIsolatedAkmStorage();
  resetConfigCache();
});
afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

/** A state.db whose ledger stops exactly before 018, holding a dead-lane row 018 drops. */
function seedBefore018(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const seeded = openDatabase(file);
  runMigrations(seeded, BEFORE_018);
  seeded
    .prepare("INSERT INTO consolidation_judged (entry_key, content_hash, judged_at, outcome) VALUES (?, ?, ?, ?)")
    .run("memories/hostile", "seeded-before-018", "2026-08-24T03:00:00.000Z", "actioned");
  seeded.close();
}

function ledgerLength(file: string): number {
  const db = openDatabase(file, { readonly: true });
  try {
    return (db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count;
  } finally {
    db.close();
  }
}

function stateDbOpens(file: string): boolean {
  try {
    openStateDatabase(file).close();
    return true;
  } catch {
    return false;
  }
}

/** A config whose only fault is a liftable legacy extraParams key. */
function writeLegacyExtraParamsConfig(configDir: string): string {
  const configPath = path.join(configDir, "akm", "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      configVersion: "0.9.0",
      engines: {
        "my-llm": {
          kind: "llm",
          endpoint: "https://example.com/v1/chat/completions",
          model: "test-model",
          extraParams: { temperature: 0.7 },
        },
      },
    }),
  );
  return configPath;
}

/** A config carrying one live and one retired `experimental.*` key. */
function writeRetiredExperimentalKeysConfig(configDir: string): string {
  const configPath = path.join(configDir, "akm", "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      configVersion: "0.9.0",
      experimental: { improveAutonomy: true, workflowEngine: true },
    }),
  );
  return configPath;
}

test("status names the pending state migrations without applying them", async () => {
  const file = getStateDbPath();
  seedBefore018(file);

  const plan = await runMigration({ apply: false });

  expect(plan.stateMigrations).toEqual({ pending: FROM_018 });
  // Pending state reads as "ready" (apply would change state.db), never "blocked".
  expect(plan.status).toBe("ready");
  expect(ledgerLength(file)).toBe(BEFORE_018.length);
  // The ordinary open still refuses, and points at the two commands that run this.
  expect(() => openStateDatabase(file).close()).toThrow(/018-drop-dead-lane-schema.*akm migrate apply/i);
});

test("apply applies the pending state migrations, with the safety copy, and the task migrators then open state.db", async () => {
  const file = getStateDbPath();
  seedBefore018(file);

  const plan = await runMigration({ apply: true });

  const state = plan.stateMigrations as { applied: string[]; safetyCopyPath?: string };
  expect(state.applied).toEqual(FROM_018);
  expect(state.safetyCopyPath).toMatch(/state\.db\.pre-018-drop-dead-lane-schema\./);
  expect(fs.existsSync(state.safetyCopyPath as string)).toBe(true);
  expect(ledgerLength(file)).toBe(STATE_MIGRATIONS.length);
  expect(stateDbOpens(file)).toBe(true);
  // Both task generations ran against a migrated state.db and found nothing to do.
  expect(plan.status).toBe("current");
  expect(plan.taskV3Migration?.changed).toBe(0);
  expect(plan.taskV4Migration?.changed).toBe(0);
  // The row 018 dropped survives in the verified safety copy.
  const copy = openDatabase(state.safetyCopyPath as string, { readonly: true });
  try {
    expect((copy.prepare("SELECT COUNT(*) AS count FROM consolidation_judged").get() as { count: number }).count).toBe(
      1,
    );
  } finally {
    copy.close();
  }
});

test("apply is idempotent: a second run reports nothing pending and takes no copy", async () => {
  const file = getStateDbPath();
  seedBefore018(file);
  await runMigration({ apply: true });

  const again = await runMigration({ apply: true });

  expect(again.stateMigrations).toEqual({ applied: [] });
  expect(fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".bak"))).toHaveLength(1);
});

test("dry-run reports the pending state migrations and applies nothing", async () => {
  const file = getStateDbPath();
  seedBefore018(file);

  const plan = await runMigration({ apply: false });

  expect(plan.stateMigrations).toEqual({ pending: FROM_018 });
  expect(plan.status).toBe("ready");
  expect(ledgerLength(file)).toBe(BEFORE_018.length);
  expect(stateDbOpens(file)).toBe(false);
});

test("apply lifts a legacy extraParams config to disk, and later steps that load config still run", async () => {
  // `loadConfig` itself now auto-lifts a legacy extraParams config in memory
  // (warning once) rather than failing closed, so this step is no longer a
  // precondition for every LATER step's `loadConfig()` call to succeed —
  // but `akm migrate apply` still persists the lift to disk (silencing the
  // warning permanently) and this proves it still runs, and still runs
  // before the state/task steps that themselves load config and open
  // state.db. The seeded state.db proves the state step ran after it.
  const configPath = writeLegacyExtraParamsConfig(storage.configDir);
  seedBefore018(getStateDbPath());
  expect(loadConfig().engines?.["my-llm"]?.temperature).toBe(0.7);

  const plan = await runMigration({ apply: true });

  const written = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    engines: { "my-llm": { temperature?: number; extraParams?: unknown } };
  };
  expect(written.engines["my-llm"].temperature).toBe(0.7);
  expect(written.engines["my-llm"].extraParams).toBeUndefined();
  expect((plan.configExtraParams as { applied?: boolean }).applied).toBe(true);
  expect((plan.stateMigrations as { applied: string[] }).applied).toEqual(FROM_018);
  expect(plan.status).toBe("current");
});

test("status names a pending config lift as the blocker instead of dying on the config it describes", async () => {
  writeLegacyExtraParamsConfig(storage.configDir);
  seedBefore018(getStateDbPath());

  const plan = await runMigration({ apply: false });

  expect(plan.status).toBe("blocked");
  expect(plan.blockers).toEqual(["engines.my-llm.extraParams.temperature -> engines.my-llm.temperature"]);
  // Read-only still reports what state is waiting behind the lift.
  expect(plan.stateMigrations).toEqual({ pending: FROM_018 });
  expect(plan.taskV3Migration).toBeUndefined();
});

test("dry-run reports a pending retired experimental key removal, leaving the config file unchanged", async () => {
  const configPath = writeRetiredExperimentalKeysConfig(storage.configDir);

  const plan = await runMigration({ apply: false });

  expect(plan.configRetiredExperimentalKeys).toEqual({ pending: { removed: ["experimental.workflowEngine"] } });
  // apply will rewrite config.json, so the preview must not claim "current".
  expect(plan.status).toBe("ready");
  const written = JSON.parse(fs.readFileSync(configPath, "utf8")) as { experimental: Record<string, unknown> };
  expect(written.experimental).toEqual({ improveAutonomy: true, workflowEngine: true });
});

test("apply removes the retired experimental key, keeps the live one, and the next loadConfig warns nothing about it", async () => {
  const configPath = writeRetiredExperimentalKeysConfig(storage.configDir);

  const plan = await runMigration({ apply: true });

  expect(plan.configRetiredExperimentalKeys).toEqual({ applied: true, removed: ["experimental.workflowEngine"] });
  const written = JSON.parse(fs.readFileSync(configPath, "utf8")) as { experimental: Record<string, unknown> };
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
});
