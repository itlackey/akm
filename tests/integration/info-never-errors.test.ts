// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm info` must behave like a help command (owner ruling): it always
 * prints a report and exits 0, whatever else is happening — never a config
 * error, never a lock wait past about a second, never a refusal.
 *
 * Companion to `tests/integration/info-command.test.ts` (which covers the
 * per-section degrade shapes — including `configError`/`bundleDirError` —
 * via direct `assembleInfo()` calls). This file covers what needs a real
 * process boundary: a broken config.json at startup, an environment where
 * path resolution itself fails (the `infoCommand` backstop in
 * stash-cli.ts), an unrecognized flag, and genuine cross-connection lock
 * contention on index.db, where what matters is wall-clock time on the real
 * CLI invocation.
 *
 * `shouldBypassConfigStartup` no longer allowlists `info` (a10-info
 * follow-up: bypassing it also skipped a user's configured
 * `output.format`/`output.detail`) — that contract is pinned in
 * `help-hints-config-bypass.test.ts` instead, alongside its `help`/`hints`
 * siblings.
 *
 * Integration-scoped (ORG-03/06): spawns real child processes and opens a
 * real index.db connection.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { formatInfoPlain } from "../../src/output/text/command-format";
import { closeDatabase, openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { runCliCapture } from "../_helpers/cli";
import {
  type Cleanup,
  type IsolatedAkmStorage,
  sandboxHome,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
  withIsolatedAkmStorage,
} from "../_helpers/sandbox";

const repoRoot = path.resolve(import.meta.dir, "../..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

/** Bounded-time budget every real-process scenario below must finish within (owner ruling: "about 1 second" per read; generously bounded for a loaded CI box). */
const MAX_MS = 4_000;

interface ChildResult {
  code: number;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

/** Spawn a real `akm` child. `envOverrides`' `undefined` values UNSET that var in the child (not "the string undefined"), so a test can guarantee e.g. HOME is genuinely absent regardless of what this test file's own process happens to have. */
async function spawnAkm(args: string[], envOverrides: Record<string, string | undefined> = {}): Promise<ChildResult> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const start = Date.now();
  const child = Bun.spawn(["bun", cliPath, ...args], { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr, elapsedMs: Date.now() - start };
}

describe("akm info against a config akm cannot load (a10-info)", () => {
  let cleanup: Cleanup | undefined;

  function setUpBrokenConfig(): void {
    const home = sandboxHome();
    const cfg = sandboxXdgConfigHome(home.cleanup);
    const cache = sandboxXdgCacheHome(cfg.cleanup);
    cleanup = sandboxXdgDataHome(cache.cleanup).cleanup;
    const configPath = path.join(process.env.XDG_CONFIG_HOME as string, "akm", "config.json");
    fs.writeFileSync(configPath, "{ not valid json\n");
  }

  function tearDown(): void {
    cleanup?.();
    cleanup = undefined;
  }

  test.each([
    "json",
    "text",
    "yaml",
  ] as const)("akm info --format %s reports configError at exit 0 instead of refusing", async (format) => {
    setUpBrokenConfig();
    try {
      const { code, stdout, stderr } = await runCliCapture(["info", "--format", format]);
      expect(code, stderr).toBe(0);
      expect(stdout).toContain("configError");
      if (format === "json") {
        const parsed = JSON.parse(stdout);
        expect(parsed.ok).toBe(true);
        expect(typeof parsed.configError).toBe("string");
        expect(parsed.configError.length).toBeGreaterThan(0);
        // Still a full report — fields that do not depend on config are
        // populated normally.
        expect(Array.isArray(parsed.assetTypes)).toBe(true);
        expect(parsed.assetTypes.length).toBeGreaterThan(0);
      }
    } finally {
      tearDown();
    }
  });

  test("akm info --quiet still exits 0 and prints the full JSON report", async () => {
    setUpBrokenConfig();
    try {
      const { code, stdout, stderr } = await runCliCapture(["info", "--format", "json", "--quiet"]);
      expect(code).toBe(0);
      expect(stderr).toBe("");
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(typeof parsed.configError).toBe("string");
    } finally {
      tearDown();
    }
  });
});

describe("akm info on a genuinely fresh install — no config, no bundle dir yet (a10-info)", () => {
  test("reports the platform-default bundleDir instead of throwing STASH_DIR_NOT_FOUND", async () => {
    const home = sandboxHome();
    const cfg = sandboxXdgConfigHome(home.cleanup);
    const cache = sandboxXdgCacheHome(cfg.cleanup);
    const cleanup = sandboxXdgDataHome(cache.cleanup).cleanup;
    try {
      // No AKM_BUNDLE_DIR, no configured bundle, and no `<home>/akm` on disk —
      // resolveStashDir() throws ConfigError("STASH_DIR_NOT_FOUND") here (pinned
      // by the fact that this env shape is exactly what production hits before
      // `akm setup`/`akm bundle create` ever runs).
      const { code, stdout, stderr } = await runCliCapture(["info", "--format", "json"]);
      expect(code, stderr).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.defaultBundle).toBeNull();
      expect(typeof parsed.bundleDir).toBe("string");
      expect(parsed.bundleDir).toBe(path.join(process.env.HOME as string, "akm"));
      expect(parsed.configError).toBeUndefined();
      expect(parsed.bundleDirError).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});

describe("akm info when environment resolution itself fails (a10-info, infoCommand backstop)", () => {
  test("NODE_ENV=test leaking into a real invocation (e.g. from a JS test runner) with no data-dir override still exits 0", async () => {
    const home = sandboxHome();
    const cleanup = sandboxXdgConfigHome(home.cleanup).cleanup;
    try {
      // getDataDir() refuses to guess under NODE_ENV=test unless XDG_DATA_HOME
      // or AKM_DATA_DIR is set (core/paths.ts's TEST_ISOLATION_MISSING guard,
      // there to stop a REAL test suite from writing into a developer's
      // ~/.local/share/akm) — a real, reachable shape when akm is invoked as
      // a subprocess from Jest/Vitest/etc, which set NODE_ENV=test on their
      // own process and whose children inherit it.
      const result = await spawnAkm(["info", "--format", "json"], {
        NODE_ENV: "test",
        XDG_DATA_HOME: undefined,
        AKM_DATA_DIR: undefined,
      });
      expect(result.code, result.stderr).toBe(0);
      expect(result.elapsedMs).toBeLessThan(MAX_MS);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      // Only the data-dir-derived sections degrade; everything else still
      // reports normally (assembleInfo's per-section degradation, not the
      // whole-report backstop).
      expect(parsed.dataDir).toBe("");
      expect(parsed.indexStats.unavailable).toBeDefined();
      expect(Array.isArray(parsed.assetTypes)).toBe(true);
      expect(parsed.assetTypes.length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  test("HOME entirely unset (nothing resolvable) still exits 0 with the full report, not just the minimal fallback", async () => {
    const result = await spawnAkm(["info", "--format", "json"], {
      HOME: undefined,
      XDG_CONFIG_HOME: undefined,
      XDG_DATA_HOME: undefined,
      XDG_CACHE_HOME: undefined,
      XDG_STATE_HOME: undefined,
      AKM_BUNDLE_DIR: undefined,
      AKM_CONFIG_DIR: undefined,
      AKM_DATA_DIR: undefined,
      AKM_CACHE_DIR: undefined,
      AKM_STATE_DIR: undefined,
      // This test's own process runs under `bun test`, which sets BUN_TEST
      // (inherited by spawnAkm's child otherwise) — clearing it isolates
      // "HOME unset" from the SEPARATE NODE_ENV=test/TEST_ISOLATION_MISSING
      // scenario covered above, so getDataDir()/getCacheDir()/getStateDir()
      // exercise their real "homeless" fallback here, not that guard.
      BUN_TEST: undefined,
      NODE_ENV: undefined,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.elapsedMs).toBeLessThan(MAX_MS);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    // getDataDir()/getCacheDir()/getStateDir() each fall back to a
    // uid-scoped tmpdir without HOME (core/paths.ts's own "homeless"
    // fallback) — only bundleDir/configDir have no such fallback, so
    // assembleInfo()'s own per-section guards (not infoCommand's backstop)
    // handle this: a blank path with a reason attached, not a throw.
    expect(parsed.bundleDir).toBe("");
    expect(typeof parsed.bundleDirError).toBe("string");
    expect(parsed.bundleDirError.length).toBeGreaterThan(0);
    expect(parsed.configDir).toBe("");
    expect(typeof parsed.configError).toBe("string");
    expect(parsed.dataDir.length).toBeGreaterThan(0);
    expect(parsed.cacheDir.length).toBeGreaterThan(0);
    expect(parsed.stateDir.length).toBeGreaterThan(0);
    // The rest of the report is unaffected — this is NOT the minimal
    // last-resort shape infoCommand's own try/catch (stash-cli.ts) would
    // produce if assembleInfo() itself still threw.
    expect(parsed.error).toBeUndefined();
    expect(Array.isArray(parsed.registries)).toBe(true);
    expect(parsed.registries.length).toBeGreaterThan(0);
  });
});

describe("akm info --format text renders the degrade fields too (a10-info)", () => {
  test("bundleDirError renders in --format text, not just JSON", async () => {
    const home = sandboxHome();
    const cfg = sandboxXdgConfigHome(home.cleanup);
    const cache = sandboxXdgCacheHome(cfg.cleanup);
    const cleanup = sandboxXdgDataHome(cache.cleanup).cleanup;
    try {
      const configPath = path.join(process.env.XDG_CONFIG_HOME as string, "akm", "config.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          configVersion: "0.9.0",
          semanticSearchMode: "off",
          bundles: { main: { path: "/nonexistent/definitely-not-here" } },
          defaultBundle: "main",
        }),
      );
      const { code, stdout, stderr } = await runCliCapture(["info", "--format", "text"]);
      expect(code, stderr).toBe(0);
      expect(stdout).toContain("bundleDirError: ");
      expect(stdout).toContain("/nonexistent/definitely-not-here");
    } finally {
      cleanup();
    }
  });

  // The whole-report fallback (infoCommand's own try/catch, stash-cli.ts) is
  // no longer reachable via a realistic environment on this platform — the
  // per-section guards above (bundleDir, dataDir/cacheDir/stateDir's own
  // "homeless" fallbacks) close off every repro this suite can construct.
  // Tested directly instead: formatInfoPlain must still render that shape's
  // `error` field legibly if it's ever hit some other way (a future
  // resolver that throws with no per-section guard of its own).
  test("the whole-report fallback's `error` field renders in --format text", () => {
    const text = formatInfoPlain({
      schemaVersion: 1,
      version: "0.0.0-test",
      error: "something unresolvable happened",
      assetTypes: ["skill"],
      searchModes: ["fts"],
    });
    expect(text).toContain("error: something unresolvable happened");
  });
});

describe("akm info tolerates an unrecognized flag instead of refusing (a10-info)", () => {
  test("akm info --bogus warns and still exits 0 with a normal report", async () => {
    const { code, stdout, stderr } = await runCliCapture(["info", "--bogus", "--format", "json"]);
    expect(code, stderr).toBe(0);
    expect(stderr).toContain('ignoring unknown flag "--bogus"');
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.version).toBe("string");
  });
});

describe("akm info under real index.db lock contention (a10-info)", () => {
  test("index.db held under BEGIN EXCLUSIVE (DELETE journal mode) — exit 0, bounded time, unavailable reason", async () => {
    const storage: IsolatedAkmStorage = withIsolatedAkmStorage();

    // Build a real (empty) index, then hold it EXCLUSIVE from a second
    // connection. WAL readers never block on a writer (SQLite's whole
    // design point — a BEGIN IMMEDIATE or even BEGIN EXCLUSIVE holder under
    // WAL does not reproduce this), so this forces the DELETE/TRUNCATE
    // journal mode the network-filesystem fallback (and
    // AKM_SQLITE_JOURNAL_MODE) can also select in production, where a
    // reader genuinely does wait on a held writer lock — the real shape of
    // the bug this fix closes, confirmed empirically before this fix
    // (a ~30s wait) and after (bounded here).
    const holder = openIndexDatabase();
    holder.exec("PRAGMA journal_mode=DELETE");
    holder.exec("BEGIN EXCLUSIVE");

    try {
      const result = await spawnAkm(["info", "--format", "json"]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.elapsedMs).toBeLessThan(MAX_MS);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.indexStats.unavailable).toBeDefined();
      expect(parsed.indexStats.unavailable).toContain("locked");
      // A locked read must fail safe to the empty shape, not partial/stale data.
      expect(parsed.indexStats.entryCount).toBe(0);
    } finally {
      try {
        holder.exec("ROLLBACK");
      } catch {
        // Best-effort — the connection is closed unconditionally next.
      }
      closeDatabase(holder);
      storage.cleanup();
    }
  }, 15_000);
});
