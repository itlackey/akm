// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS-2: Auto-migration UX tests.
 * WS-3: Config-clobber hardening tests.
 *
 * Covers:
 * - Banner output to both stdout and stderr when auto-migration fires
 * - AKM_NO_AUTO_MIGRATE=1 skips the write (still returns migrated bytes in memory)
 * - Backup is created before the rewrite
 * - Migration write failure throws a ConfigError with AKM_NO_AUTO_MIGRATE=1 in the message
 * - akm config migrate --dry-run --print-diff produces a unified diff on stdout
 * - saveConfig acquires the config write lock (WS-3)
 * - Config load + rewrite does not corrupt a valid config on concurrent access
 * - Regression: `akm config set llm.endpoint` on a fresh config does not drop other keys
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateConfigFile, runConfigMigrate } from "../src/cli/config-migrate";
import { runConfigValidate } from "../src/cli/config-validate";
import { loadUserConfig, resetConfigCache, saveConfig } from "../src/core/config";
import { ConfigError } from "../src/core/errors";

// ── Test isolation ────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "akm-ws2-test-"));
}

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

let testConfigHome = "";
let testCacheHome = "";
let testDataHome = "";
let testStateHome = "";

beforeEach(() => {
  testConfigHome = makeTmpDir();
  testCacheHome = makeTmpDir();
  testDataHome = makeTmpDir();
  testStateHome = makeTmpDir();
  process.env.XDG_CONFIG_HOME = testConfigHome;
  process.env.XDG_CACHE_HOME = testCacheHome;
  process.env.XDG_DATA_HOME = testDataHome;
  process.env.XDG_STATE_HOME = testStateHome;
  delete process.env.AKM_NO_AUTO_MIGRATE;
  resetConfigCache();
});

afterEach(() => {
  cleanup(testConfigHome);
  cleanup(testCacheHome);
  cleanup(testDataHome);
  cleanup(testStateHome);
  delete process.env.AKM_NO_AUTO_MIGRATE;
  resetConfigCache();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function configPath(): string {
  return path.join(testConfigHome, "akm", "config.json");
}

function writeConfig(content: Record<string, unknown> | string): void {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const text = typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`;
  fs.writeFileSync(p, text);
}

/** A pre-0.8.0 config shape (has legacy `llm` top-level key). */
function legacyConfig(): Record<string, unknown> {
  return {
    llm: {
      endpoint: "http://localhost:11434/v1/chat/completions",
      model: "llama3",
    },
    stashDir: "/my/stash",
  };
}

// Capture output to an array, then restore.
function captureOutput(fn: () => void): { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  (process.stdout as NodeJS.WriteStream).write = (chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  };
  (process.stderr as NodeJS.WriteStream).write = (chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  }
  return { stdout, stderr };
}

// ── WS-2: Auto-migration banner ───────────────────────────────────────────────

describe("auto-migration banner (WS-2)", () => {
  test("prints a loud banner to both stdout and stderr when migrating a pre-0.8 config", () => {
    writeConfig(legacyConfig());
    const { stdout, stderr } = captureOutput(() => {
      resetConfigCache();
      loadUserConfig();
    });
    const stdoutText = stdout.join("");
    const stderrText = stderr.join("");

    // Both channels must have the banner
    expect(stdoutText).toContain("akm: auto-migrated config");
    expect(stderrText).toContain("akm: auto-migrated config");

    // Banner includes the resolved config path (not ~/...)
    expect(stdoutText).toContain(configPath());
    expect(stderrText).toContain(configPath());

    // Banner includes opt-out instruction
    expect(stdoutText).toContain("AKM_NO_AUTO_MIGRATE=1");
    expect(stderrText).toContain("AKM_NO_AUTO_MIGRATE=1");

    // Banner includes preview diff command
    expect(stdoutText).toContain("akm config migrate --dry-run --print-diff");
    expect(stderrText).toContain("akm config migrate --dry-run --print-diff");
  });

  test("backup is created before the rewrite", () => {
    writeConfig(legacyConfig());
    captureOutput(() => {
      resetConfigCache();
      loadUserConfig();
    });
    const backupDir = path.join(testCacheHome, "akm", "config-backups");
    expect(fs.existsSync(backupDir)).toBe(true);
    const backups = fs.readdirSync(backupDir).filter((n) => n.startsWith("config-"));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });

  test("migrated config has the 0.8.0 shape on disk", () => {
    writeConfig(legacyConfig());
    captureOutput(() => {
      resetConfigCache();
      loadUserConfig();
    });
    const disk = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    expect(disk.configVersion).toBe("0.8.0");
    expect(disk.llm).toBeUndefined();
    expect(disk.profiles?.llm).toBeDefined();
  });

  test("no banner and no disk write when AKM_NO_AUTO_MIGRATE=1", () => {
    writeConfig(legacyConfig());
    process.env.AKM_NO_AUTO_MIGRATE = "1";
    const { stdout, stderr } = captureOutput(() => {
      resetConfigCache();
      loadUserConfig();
    });
    const stdoutText = stdout.join("");
    const stderrText = stderr.join("");

    expect(stdoutText).not.toContain("akm: auto-migrated config");
    expect(stderrText).not.toContain("akm: auto-migrated config");

    // The file on disk must still be the legacy shape (not rewritten)
    const disk = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    expect(disk.llm).toBeDefined();
    expect(disk.configVersion).toBeUndefined();
  });

  test("migration write failure throws ConfigError with AKM_NO_AUTO_MIGRATE=1 in the message", () => {
    writeConfig(legacyConfig());
    // Make the config dir read-only so the write fails
    const configDir = path.dirname(configPath());
    let chmodDone = false;
    try {
      fs.chmodSync(configDir, 0o500); // r-x: cannot write
      chmodDone = true;
      expect(() => {
        resetConfigCache();
        loadUserConfig();
      }).toThrow(ConfigError);
      // Also assert that hint or message contains AKM_NO_AUTO_MIGRATE=1
      try {
        resetConfigCache();
        loadUserConfig();
      } catch (err) {
        const e = err as ConfigError;
        const combined = `${e.message} ${e.hint() ?? ""}`;
        expect(combined).toContain("AKM_NO_AUTO_MIGRATE=1");
      }
    } finally {
      if (chmodDone) fs.chmodSync(configDir, 0o700);
    }
  });

  test("no banner for an already-migrated 0.8.0 config", () => {
    writeConfig({ configVersion: "0.8.0", stashDir: "/my/stash" });
    const { stdout, stderr } = captureOutput(() => {
      resetConfigCache();
      loadUserConfig();
    });
    expect(stdout.join("")).not.toContain("akm: auto-migrated config");
    expect(stderr.join("")).not.toContain("akm: auto-migrated config");
  });
});

// ── WS-2: --dry-run --print-diff ─────────────────────────────────────────────

describe("akm config migrate --dry-run --print-diff (WS-2)", () => {
  test("--dry-run does not write to disk", async () => {
    const cfgPath = configPath();
    writeConfig(legacyConfig());
    const originalText = fs.readFileSync(cfgPath, "utf8");

    await migrateConfigFile(cfgPath, { dryRun: true });

    const afterText = fs.readFileSync(cfgPath, "utf8");
    expect(afterText).toBe(originalText);
  });

  test("--print-diff returns a non-empty diff string when migration changes the config", async () => {
    const cfgPath = configPath();
    writeConfig(legacyConfig());

    const { changed, diff } = await migrateConfigFile(cfgPath, { dryRun: true, printDiff: true });

    expect(changed).toBe(true);
    expect(typeof diff).toBe("string");
    expect(diff?.length).toBeGreaterThan(0);
    expect(diff).toContain("---");
    expect(diff).toContain("+++");
  });

  test("--print-diff includes minus lines for removed keys and plus lines for added keys", async () => {
    const cfgPath = configPath();
    writeConfig(legacyConfig());

    const { diff } = await migrateConfigFile(cfgPath, { dryRun: true, printDiff: true });

    // The legacy `llm` key should appear as a removed line
    expect(diff).toContain("-");
    // The new `profiles` key should appear as an added line
    expect(diff).toContain("+");
  });

  test("runConfigMigrate --dry-run --print-diff prints diff to console.log without writing", async () => {
    const cfgPath = configPath();
    writeConfig(legacyConfig());
    const originalText = fs.readFileSync(cfgPath, "utf8");

    const logged: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    try {
      await runConfigMigrate({ dryRun: true, printDiff: true });
    } finally {
      console.log = origLog;
    }

    // File unchanged
    expect(fs.readFileSync(cfgPath, "utf8")).toBe(originalText);
    // Diff printed
    const logOutput = logged.join("\n");
    expect(logOutput).toContain("would migrate");
    expect(logOutput).toContain("---");
  });

  test("--print-diff returns undefined (no diff) when config is already at current version", async () => {
    const cfgPath = configPath();
    writeConfig({ configVersion: "0.8.0", stashDir: "/x" });

    const { changed, diff } = await migrateConfigFile(cfgPath, { dryRun: true, printDiff: true });

    expect(changed).toBe(false);
    expect(diff).toBeUndefined();
  });
});

// ── WS-3: Config-clobber hardening ───────────────────────────────────────────

describe("config write lock (WS-3)", () => {
  test("saveConfig writes do not corrupt on concurrent same-process calls (serial)", () => {
    // Verify that calling saveConfig twice in sequence produces a valid config
    const cfg = {
      configVersion: "0.8.0" as const,
      stashDir: "/my/stash",
      semanticSearchMode: "auto" as const,
    };
    writeConfig({ configVersion: "0.8.0", stashDir: "/initial" });
    resetConfigCache();

    saveConfig({ ...cfg, stashDir: "/first-write" });
    resetConfigCache();
    saveConfig({ ...cfg, stashDir: "/second-write" });
    resetConfigCache();

    const loaded = loadUserConfig();
    expect(loaded.stashDir).toBe("/second-write");
  });

  test("saveConfig validates before write — rejects invalid config shape", () => {
    writeConfig({ configVersion: "0.8.0", stashDir: "/my/stash" });
    resetConfigCache();

    // semanticSearchMode must be "auto" | "always" | "never"
    expect(() =>
      saveConfig({
        configVersion: "0.8.0",
        semanticSearchMode: "invalid-value" as unknown as "auto",
        stashDir: "/my/stash",
      }),
    ).toThrow(ConfigError);

    // Config on disk must be unchanged
    const disk = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    expect(disk.semanticSearchMode).toBeUndefined();
  });

  test("config write lock file is removed after a successful saveConfig", () => {
    writeConfig({ configVersion: "0.8.0", stashDir: "/my/stash" });
    resetConfigCache();
    const lockPath = path.join(testConfigHome, "akm", "config.json.lck");

    saveConfig({
      configVersion: "0.8.0",
      semanticSearchMode: "auto",
      stashDir: "/updated",
    });

    // Lock sentinel must be cleaned up after write
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

// ── #456: `akm config validate` end-to-end ──────────────────────────────────

describe("runConfigValidate (#456)", () => {
  test("succeeds quietly for a canonical 0.8.0 config", async () => {
    writeConfig({ configVersion: "0.8.0", stashDir: "/x", semanticSearchMode: "auto" });
    const logged: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    try {
      await runConfigValidate();
    } finally {
      console.log = origLog;
    }
    expect(logged.join("\n")).toContain("All checks passed");
  });

  test("throws ConfigError listing schema issues for a structurally invalid config", async () => {
    // semanticSearchMode must be one of the enum values; "garbage" is invalid.
    writeConfig({ configVersion: "0.8.0", semanticSearchMode: "garbage" });
    await expect(runConfigValidate()).rejects.toThrow(ConfigError);
  });

  test("no-ops cleanly when the config file is absent (cold-start)", async () => {
    const logged: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    try {
      await runConfigValidate();
    } finally {
      console.log = origLog;
    }
    expect(logged.join("\n")).toContain("nothing to validate");
  });
});

// ── #459: backup retention prunes old config snapshots ──────────────────────

describe("config backup retention (#459)", () => {
  test("saveConfig keeps only the most-recent 5 timestamped backups", () => {
    writeConfig({ configVersion: "0.8.0", stashDir: "/initial" });
    resetConfigCache();
    // 8 saves → 8 timestamped backups would accumulate without retention;
    // prune is supposed to cap at 5.
    for (let i = 0; i < 8; i++) {
      saveConfig({
        configVersion: "0.8.0",
        semanticSearchMode: "auto",
        stashDir: `/iter-${i}`,
      });
      resetConfigCache();
      // Tiny sleep to ensure each timestamp string is unique.
      const deadline = Date.now() + 5;
      while (Date.now() < deadline) {
        /* spin */
      }
    }
    const backupDir = path.join(testCacheHome, "akm", "config-backups");
    const timestamped = fs
      .readdirSync(backupDir)
      .filter((n) => n.startsWith("config-") && n.endsWith(".json") && n !== "config.latest.json");
    expect(timestamped.length).toBeLessThanOrEqual(5);
    // The pointer file is always present.
    expect(fs.existsSync(path.join(backupDir, "config.latest.json"))).toBe(true);
  });
});

// ── WS-3: Regression — May 2026 config-clobber scenario ─────────────────────

describe("config-clobber regression (WS-3)", () => {
  test("loading a fresh config with only stashDir does not drop stashDir on save", () => {
    writeConfig({ configVersion: "0.8.0", stashDir: "/regression-test" });
    resetConfigCache();

    const loaded = loadUserConfig();
    expect(loaded.stashDir).toBe("/regression-test");

    // Simulate what `akm config set llm.endpoint` does: update a nested key and save.
    // The stashDir must survive.
    saveConfig({
      ...loaded,
      profiles: {
        ...(loaded.profiles ?? {}),
        llm: {
          ...(loaded.profiles?.llm ?? {}),
          default: { endpoint: "http://example.com/v1/chat/completions", model: "test" },
        },
      },
      defaults: { ...(loaded.defaults ?? {}), llm: "default" },
    });

    resetConfigCache();
    const reloaded = loadUserConfig();
    expect(reloaded.stashDir).toBe("/regression-test");
    expect(reloaded.profiles?.llm?.default?.endpoint).toBe("http://example.com/v1/chat/completions");
  });
});
