// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm-migrate` runs every migration in one plan, in order: config.json in
 * its current shape, pending state.db migrations, task files, residue sweep.
 * These prove the two steps the CLI proper refuses to do on its own -- the
 * config lift a failing `loadConfig` names as its own remedy, and the
 * historical-destructive state migration an ordinary open refuses (#895) --
 * and that they run BEFORE the task-file step, which loads config itself.
 *
 * Integration: seeds and opens a real state.db under an isolated data dir.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runMigration } from "../../scripts/akm-migrate/run-migrate";
import { resolveStashDir } from "../../src/core/common";
import { loadConfig, resetConfigCache } from "../../src/core/config/config";
import { STATE_MIGRATIONS } from "../../src/core/state/migrations";
import { getStateDbPath, openStateDatabase } from "../../src/core/state-db";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../src/core/warn";
import { openDatabase } from "../../src/storage/database";
import { runMigrations } from "../../src/storage/engines/sqlite-migrations";
import { type IsolatedAkmStorage, withEnvSync, withIsolatedAkmStorage } from "../_helpers/sandbox";

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
  expect(plan.configFile?.applied).toBe(true);
  expect((plan.stateMigrations as { applied: string[] }).applied).toEqual(FROM_018);
  expect(plan.status).toBe("current");
});

test("status reports a pending config lift as ready instead of dying on the config it describes", async () => {
  writeLegacyExtraParamsConfig(storage.configDir);
  seedBefore018(getStateDbPath());

  const plan = await runMigration({ apply: false });

  expect(plan.status).toBe("ready");
  expect(plan.blockers).toEqual([]);
  expect(plan.configFile).toMatchObject({ changed: true, applied: false });
  expect(plan.configFile?.keys).toContain("engines");
  // Read-only still reports what state is waiting behind the lift.
  expect(plan.stateMigrations).toEqual({ pending: FROM_018 });
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

test("dry-run reports a pending legacy stashDir/sources conversion, leaving the config file and resolved stash unchanged", async () => {
  const configPath = writeLegacySourceShapeConfig(storage.configDir, storage.stashDir);
  const beforeStashDir = withEnvSync({ AKM_BUNDLE_DIR: undefined }, () => resolveStashDir());

  const plan = await runMigration({ apply: false });

  expect(plan.configFile).toMatchObject({ changed: true, applied: false });
  expect(plan.configFile?.keys).toEqual(expect.arrayContaining(["sources", "stashDir"]));
  expect(plan.status).toBe("ready");
  const written = JSON.parse(fs.readFileSync(configPath, "utf8")) as { stashDir: unknown; sources: unknown };
  expect(written.stashDir).toBe(storage.stashDir);
  expect(written.sources).toEqual([{ type: "git", url: "https://example.com/team.git", name: "team" }]);
  const afterStashDir = withEnvSync({ AKM_BUNDLE_DIR: undefined }, () => resolveStashDir());
  expect(afterStashDir).toBe(beforeStashDir);
});

test("apply converts the legacy stashDir/sources shape to bundles/defaultBundle; resolveStashDir and the bundle ids are unchanged, and the next loadConfig warns nothing about it", async () => {
  const configPath = writeLegacySourceShapeConfig(storage.configDir, storage.stashDir);
  const beforeStashDir = withEnvSync({ AKM_BUNDLE_DIR: undefined }, () => resolveStashDir());
  const beforeBundleIds = withEnvSync({ AKM_BUNDLE_DIR: undefined }, () => Object.keys(loadConfig().bundles ?? {}));
  resetConfigCache();

  const plan = await runMigration({ apply: true });

  expect(plan.configFile?.applied).toBe(true);
  expect(plan.configFile?.keys).toEqual(expect.arrayContaining(["sources", "stashDir"]));
  const written = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    stashDir?: unknown;
    sources?: unknown;
    defaultBundle: string;
    bundles: Record<string, unknown>;
  };
  expect(written.stashDir).toBeUndefined();
  expect(written.sources).toBeUndefined();
  expect(written.defaultBundle).toBe("stash");
  expect(written.bundles.stash).toEqual({ path: storage.stashDir, writable: true });
  expect(written.bundles.team).toEqual({ git: "https://example.com/team.git", writable: false });

  const afterStashDir = withEnvSync({ AKM_BUNDLE_DIR: undefined }, () => resolveStashDir());
  expect(afterStashDir).toBe(beforeStashDir);
  resetConfigCache();
  const afterBundleIds = withEnvSync({ AKM_BUNDLE_DIR: undefined }, () => Object.keys(loadConfig().bundles ?? {}));
  expect(new Set(afterBundleIds)).toEqual(new Set(beforeBundleIds));

  resetConfigCache();
  _resetWarnOnceForTests();
  const warnings: string[] = [];
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
  try {
    withEnvSync({ AKM_BUNDLE_DIR: undefined }, () => loadConfig());
  } finally {
    _setWarnSinkForTests(undefined);
  }
  expect(warnings.some((w) => w.includes("legacy-source-shape") || w.includes("stashDir"))).toBe(false);
});
