// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm-migrate` runs every migration in one plan, in order: config.json in
 * its current shape, pending state.db migrations, task files, residue sweep.
 * These prove the two steps the CLI proper refuses to do on its own -- the
 * config rewrite (retired keys dropped), and the
 * historical-destructive state migration an ordinary open refuses (#895) --
 * and that they run BEFORE the task-file step, which loads config itself.
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
import { runMigrations } from "../../src/storage/sqlite-migrations";
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

test("status names the pending state migrations without applying them", async () => {
  const file = getStateDbPath();
  seedBefore018(file);

  const plan = await runMigration({ apply: false });

  expect(plan.stateMigrations).toEqual({ pending: FROM_018 });
  // Pending state reads as "ready" (apply would change state.db), never "blocked".
  expect(plan.status).toBe("ready");
  expect(ledgerLength(file)).toBe(BEFORE_018.length);
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
  // The task-file step ran after it and found nothing to do.
  expect(plan.status).toBe("current");
  expect(plan.taskFiles?.changed).toBe(0);
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
});

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

test("a pre-0.9.15 stashDir/sources config is not converted: apply blocks on it, naming akm 0.9.x, and leaves the file unchanged", async () => {
  const configPath = writeLegacySourceShapeConfig(storage.configDir, storage.stashDir);
  const before = fs.readFileSync(configPath, "utf8");

  const plan = await runMigration({ apply: true });

  expect(plan.configFile).toBeUndefined();
  expect(plan.status).toBe("blocked");
  expect(plan.blockers.join("\n")).toMatch(/predates akm 0\.9\.15.*akm migrate apply.* with akm 0\.9\.x/);
  expect(fs.readFileSync(configPath, "utf8")).toBe(before);
});
