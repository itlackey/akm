// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Regression for R-056: `akm index` auto-detects a bundle's adapter and
 * persists it to config.json (`bundles.<id>.components.<component>.adapter`)
 * whenever a resolved source has no adapter recorded yet. That write used to
 * have ZERO disclosure — absent from the result envelope, silent on stderr,
 * undocumented. This pins that the write is now surfaced two ways:
 *   1. `IndexResponse.configUpdated.detectedAdapters` names every bundle the
 *      run persisted an adapter for.
 *   2. A `warn()` call (stderr in production) names the same bundle/adapter
 *      pairs and says they were persisted to config.json.
 * A second bundle whose adapter is already configured must NOT be reported
 * (the write — and therefore the disclosure — only fires for bundles that
 * actually changed).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadUserConfig, resetConfigCache } from "../../src/core/config/config";
import { getDbPath, getStateDbPathInDataDir } from "../../src/core/paths";
import { STATE_MIGRATIONS } from "../../src/core/state/migrations";
import { _setWarnSinkForTests } from "../../src/core/warn";
import { akmIndex } from "../../src/indexer/indexer";
import { openDatabaseFinalizing } from "../../src/storage/database";
import { runMigrations as runSqliteMigrations } from "../../src/storage/sqlite-migrations";
import {
  type IsolatedAkmStorage,
  makeStashDir,
  type SandboxedDir,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../_helpers/sandbox";
import { overrideSeam } from "../_helpers/seams";

let storage: IsolatedAkmStorage;
let secondary: SandboxedDir;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  secondary = makeStashDir();
});

afterEach(() => {
  secondary.cleanup();
  storage.cleanup();
});

test("akmIndex discloses an auto-detected, newly-persisted bundle adapter in the result and on stderr", async () => {
  // `secondary` has NO adapter recorded on its (implicit) component — the
  // indexer must auto-detect one (via detectAdapterId) and persist it.
  writeSandboxConfig({
    semanticSearchMode: "off",
    bundles: {
      primary: { path: storage.stashDir, writable: true },
      team: { path: secondary.dir },
    },
    defaultBundle: "primary",
  });
  resetConfigCache();

  const warnCalls: string[] = [];
  overrideSeam(_setWarnSinkForTests, (level, args) => {
    if (level !== "warn") return;
    warnCalls.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  });

  const result = await akmIndex({ stashDir: storage.stashDir, full: true });

  // 1. Disclosed in the result envelope.
  expect(result.configUpdated?.detectedAdapters.team).toBeDefined();

  // 2. Disclosed on stderr via warn().
  expect(warnCalls.some((m) => m.includes("persisted to config.json") && m.includes("team") && m.includes("→"))).toBe(
    true,
  );

  // 3. The write actually landed in config.json.
  resetConfigCache();
  const config = loadUserConfig();
  const teamBundle = config.bundles?.team;
  const component = Object.values(teamBundle?.components ?? {})[0];
  expect(component?.adapter).toBe(result.configUpdated?.detectedAdapters.team);
});

test("akmIndex automatically advances a known additive state prefix before indexing", async () => {
  writeSandboxConfig({
    semanticSearchMode: "off",
    bundles: {
      primary: { path: storage.stashDir, writable: true },
      team: { path: secondary.dir },
    },
    defaultBundle: "primary",
  });
  resetConfigCache();
  const statePath = getStateDbPathInDataDir();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const state = openDatabaseFinalizing(statePath);
  runSqliteMigrations(state, STATE_MIGRATIONS.slice(0, -1));
  state.close();
  await expect(akmIndex({ stashDir: storage.stashDir, full: true })).resolves.toMatchObject({ totalEntries: 0 });

  expect(fs.existsSync(getDbPath())).toBe(true);
  const advanced = openDatabaseFinalizing(statePath, { readonly: true });
  expect((advanced.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count).toBe(
    STATE_MIGRATIONS.length,
  );
  advanced.close();
});

test("akmIndex does not re-report a bundle whose adapter is already configured", async () => {
  writeSandboxConfig({
    semanticSearchMode: "off",
    bundles: {
      // Both bundles pre-declare their adapter so neither triggers detection
      // — a bare `path`-only bundle (no `components`) also lacks an adapter
      // and would otherwise confound this "already configured" assertion.
      primary: { path: storage.stashDir, writable: true, components: { main: { root: ".", adapter: "akm" } } },
      team: { path: secondary.dir, components: { main: { root: ".", adapter: "akm" } } },
    },
    defaultBundle: "primary",
  });
  resetConfigCache();

  const warnCalls: string[] = [];
  overrideSeam(_setWarnSinkForTests, (level, args) => {
    if (level !== "warn") return;
    warnCalls.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  });

  const result = await akmIndex({ stashDir: storage.stashDir, full: true });

  expect(result.configUpdated).toBeUndefined();
  expect(warnCalls.some((m) => m.includes("persisted to config.json"))).toBe(false);
});

test("an implicit auto-index still reports the write in the envelope but stays off stderr", async () => {
  // A read command's inline auto-index must not print the disclosure notice:
  // its stderr carries the JSON error envelope, so an extra human-readable
  // line makes `JSON.parse(stderr)` fail for callers, and it would leak past
  // `--quiet`. The structured disclosure is never lost — only the notice is
  // suppressed. Regression for two goldens (d-quiet-search, f-not-found) that
  // this notice broke when it fired unconditionally.
  writeSandboxConfig({
    semanticSearchMode: "off",
    bundles: {
      primary: { path: storage.stashDir, writable: true },
      team: { path: secondary.dir },
    },
    defaultBundle: "primary",
  });
  resetConfigCache();

  const warnCalls: string[] = [];
  overrideSeam(_setWarnSinkForTests, (level, args) => {
    if (level !== "warn") return;
    warnCalls.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  });

  const result = await akmIndex({ stashDir: storage.stashDir, full: true, implicit: true });

  expect(result.configUpdated?.detectedAdapters).toBeDefined();
  expect(warnCalls.some((m) => m.includes("persisted to config.json"))).toBe(false);
});
