// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm info` must behave like a help command (owner ruling): it always
 * prints a report and exits 0, whatever else is happening — never a config
 * error, never a lock wait past about a second, never a refusal.
 *
 * Companion to `tests/integration/info-command.test.ts` (which covers the
 * per-section degrade shapes via direct `assembleInfo()` calls). This file
 * covers the scenarios that need a REAL process boundary: startup's own
 * config load (`shouldBypassConfigStartup`, src/cli.ts) running before
 * `assembleInfo()` ever gets a chance to degrade anything, and genuine
 * cross-connection lock contention on index.db/state.db, where what matters
 * is wall-clock time on the real CLI invocation, not an in-process function
 * call.
 *
 * Integration-scoped (ORG-03/06): spawns real child processes and opens real
 * index.db/state.db connections.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { shouldBypassConfigStartup } from "../../src/cli";
import { getStateDbPath, openStateDatabase } from "../../src/core/state-db";
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

/** Bounded-time budget every scenario below must finish within (owner ruling: "about 1 second", generously bounded for a loaded CI box). */
const MAX_MS = 3_000;

interface ChildResult {
  code: number;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

async function spawnAkm(args: string[], env: Record<string, string | undefined> = {}): Promise<ChildResult> {
  const start = Date.now();
  const child = Bun.spawn(["bun", cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr, elapsedMs: Date.now() - start };
}

describe("shouldBypassConfigStartup allowlists info (a10-info)", () => {
  test("info and its format/quiet variants bypass the startup config load", () => {
    for (const args of [
      ["bun", "cli.ts", "info"],
      ["bun", "cli.ts", "info", "--format", "text"],
      ["bun", "cli.ts", "info", "--format", "yaml"],
      ["bun", "cli.ts", "info", "--quiet"],
    ]) {
      expect(shouldBypassConfigStartup(args), args.join(" ")).toBe(true);
    }
  });
});

describe("akm info / --help / --version against a config akm cannot load (a10-info)", () => {
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

  test("akm info reports configError at exit 0 instead of refusing (json)", async () => {
    setUpBrokenConfig();
    try {
      const { code, stdout, stderr } = await runCliCapture(["info", "--format", "json"]);
      expect(code, stderr).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      expect(typeof parsed.configError).toBe("string");
      expect(parsed.configError.length).toBeGreaterThan(0);
      // Still a full report — the fields that do not depend on config are
      // populated normally.
      expect(Array.isArray(parsed.assetTypes)).toBe(true);
      expect(parsed.assetTypes.length).toBeGreaterThan(0);
    } finally {
      tearDown();
    }
  });

  test("akm info reports configError at exit 0 instead of refusing (text)", async () => {
    setUpBrokenConfig();
    try {
      const { code, stdout, stderr } = await runCliCapture(["info", "--format", "text"]);
      expect(code, stderr).toBe(0);
      expect(stdout).toContain("configError:");
    } finally {
      tearDown();
    }
  });

  test("akm info reports configError at exit 0 instead of refusing (yaml)", async () => {
    setUpBrokenConfig();
    try {
      const { code, stdout, stderr } = await runCliCapture(["info", "--format", "yaml"]);
      expect(code, stderr).toBe(0);
      expect(stdout).toContain("configError:");
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

  test("akm --help and akm --version still pass against the same broken config", async () => {
    setUpBrokenConfig();
    try {
      const help = await runCliCapture(["--help"]);
      expect(help.code, help.stderr).toBe(0);
      expect(help.stdout).toContain("akm");

      const version = await runCliCapture(["--version"]);
      expect(version.code, version.stderr).toBe(0);
      expect(version.stdout.trim().length).toBeGreaterThan(0);
    } finally {
      tearDown();
    }
  });

  test("sanity check: a command that DOES need config still reports the config error (fix is scoped to info, not a blanket bypass)", async () => {
    setUpBrokenConfig();
    try {
      const { code, stderr } = await runCliCapture(["search", "anything"]);
      expect(code).toBe(78);
      const parsed = JSON.parse(stderr.trim());
      expect(parsed.code).toBe("INVALID_CONFIG_FILE");
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
    } finally {
      cleanup();
    }
  });
});

describe("akm info under real lock contention (a10-info)", () => {
  let storage: IsolatedAkmStorage | undefined;

  function tearDown(): void {
    storage?.cleanup();
    storage = undefined;
  }

  test("index.db held under BEGIN EXCLUSIVE (DELETE journal mode) — exit 0, bounded time, unavailable reason", async () => {
    storage = withIsolatedAkmStorage();

    // Build a real (empty) index, then hold it EXCLUSIVE from a second
    // connection. WAL readers never block on a writer (SQLite's whole
    // design point), so this forces the DELETE/TRUNCATE journal mode the
    // network-filesystem fallback (and AKM_SQLITE_JOURNAL_MODE) can also
    // select in production, where a reader genuinely does wait on a held
    // writer lock — the real shape of the bug this fix closes.
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
      tearDown();
    }
  }, 15_000);

  test("state.db held under BEGIN IMMEDIATE — akm info is completely unaffected (exit 0, bounded time, clean report)", async () => {
    storage = withIsolatedAkmStorage();

    const holder = openStateDatabase(getStateDbPath());
    holder.exec("BEGIN IMMEDIATE");

    try {
      const result = await spawnAkm(["info", "--format", "json"]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.elapsedMs).toBeLessThan(MAX_MS);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
      // akm info never reads state.db at all — a held state.db transaction
      // must leave it looking exactly like an ordinary healthy run.
      expect(parsed.indexStats.unavailable).toBeUndefined();
      expect(parsed.indexStats.unreadable).toBeUndefined();
      expect(parsed.configError).toBeUndefined();
    } finally {
      try {
        holder.exec("ROLLBACK");
      } catch {
        // Best-effort — the connection is closed unconditionally next.
      }
      closeDatabase(holder);
      tearDown();
    }
  }, 15_000);

  test("a real `akm index --full` in progress on a throwaway home — concurrent akm info stays bounded", async () => {
    storage = withIsolatedAkmStorage();

    // Enough real files that indexing takes a real, non-instant moment
    // (calibrated: ~1000 small knowledge docs is on the order of a second
    // of wall time), so the concurrently-launched `akm info` below has a
    // genuine chance to overlap with the indexer's own DB writes rather
    // than racing a sub-50ms no-op.
    const knowledgeDir = path.join(storage.stashDir, "knowledge");
    fs.mkdirSync(knowledgeDir, { recursive: true });
    for (let i = 0; i < 1000; i++) {
      fs.writeFileSync(
        path.join(knowledgeDir, `doc-${i}.md`),
        `---\ndescription: throwaway doc ${i}\n---\n\nContent for doc ${i}.\n`,
      );
    }

    try {
      const [indexResult, infoResult] = await Promise.all([
        spawnAkm(["index", "--full", "--format", "json"]),
        spawnAkm(["info", "--format", "json"]),
      ]);

      expect(infoResult.code, infoResult.stderr).toBe(0);
      expect(infoResult.elapsedMs).toBeLessThan(MAX_MS);
      const parsed = JSON.parse(infoResult.stdout);
      expect(parsed.ok).toBe(true);

      // Sanity check on the test's own setup: the indexer should have
      // actually succeeded too (not a prerequisite for info's bound, but a
      // failure here would mean the scenario wasn't what it claims to be).
      expect(indexResult.code, indexResult.stderr).toBe(0);
    } finally {
      tearDown();
    }
  }, 30_000);
});
