// Regression tests for docs/technical/incidents/2026-05-23-setup-clobbers-user-config.md.
//
// Two layers of defense, both tested here:
//   1. assertSetupSandbox (in src/setup/setup.ts): refuses `akm setup --dir
//      /tmp/X` unless AKM_FORCE_SETUP_TMP_STASH=1. Tested indirectly by
//      invoking runSetupWithDefaults / runSetupFromConfig with /tmp paths.
//   2. getConfigDir (in src/core/paths.ts): when AKM_STASH_DIR points at a
//      transient path, isolates config writes into $STASH/.akm/. Tested
//      end-to-end by running setup with the escape hatch and asserting the
//      host config file is untouched.
//
// Both layers are intentionally redundant: layer 1 fails fast for the
// common case; layer 2 ensures that even when the user opts in to the
// escape hatch, the host config is still preserved.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSetupFromConfig, runSetupWithDefaults } from "../src/setup/setup";

const SAVED_ENV: Record<string, string | undefined> = {};
const TRACKED_ENV = [
  "AKM_STASH_DIR",
  "AKM_DATA_DIR",
  "AKM_STATE_DIR",
  "AKM_CACHE_DIR",
  "AKM_CONFIG_DIR",
  "AKM_FORCE_SETUP_TMP_STASH",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "HOME",
];

beforeEach(() => {
  for (const key of TRACKED_ENV) SAVED_ENV[key] = process.env[key];
});

afterEach(() => {
  for (const key of TRACKED_ENV) {
    if (SAVED_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED_ENV[key];
  }
});

// ── Layer 1: assertSetupSandbox refuses /tmp/* explicit --dir ───────────────

describe("setup tmp-stash guard (layer 1: assertSetupSandbox)", () => {
  test("runSetupWithDefaults refuses --dir /tmp/X by default", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-setup-guard-"));
    try {
      // Set up the transient stash env so getConfigDir would isolate (layer
      // 2). Layer 1 should still throw before we reach saveConfig.
      process.env.AKM_STASH_DIR = tmpDir;
      process.env.AKM_DATA_DIR = path.join(tmpDir, "data");
      process.env.AKM_STATE_DIR = path.join(tmpDir, "state");
      process.env.XDG_DATA_HOME = path.join(tmpDir, "data");
      process.env.XDG_STATE_HOME = path.join(tmpDir, "state");
      // Make sure the escape hatch is NOT set.
      delete process.env.AKM_FORCE_SETUP_TMP_STASH;

      await expect(runSetupWithDefaults({ dir: tmpDir, noInit: true })).rejects.toThrow(
        /SETUP_TMP_STASH_REFUSED|transient\/sandbox/,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("runSetupFromConfig refuses --dir /tmp/X by default", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-setup-guard-"));
    try {
      process.env.AKM_STASH_DIR = tmpDir;
      process.env.AKM_DATA_DIR = path.join(tmpDir, "data");
      process.env.AKM_STATE_DIR = path.join(tmpDir, "state");
      process.env.XDG_DATA_HOME = path.join(tmpDir, "data");
      process.env.XDG_STATE_HOME = path.join(tmpDir, "state");
      delete process.env.AKM_FORCE_SETUP_TMP_STASH;

      await expect(runSetupFromConfig({ configJson: "{}", dir: tmpDir, noInit: true })).rejects.toThrow(
        /SETUP_TMP_STASH_REFUSED|transient\/sandbox/,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("AKM_FORCE_SETUP_TMP_STASH=1 opts out of the refusal", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-setup-guard-"));
    try {
      process.env.AKM_STASH_DIR = tmpDir;
      process.env.AKM_DATA_DIR = path.join(tmpDir, "data");
      process.env.AKM_STATE_DIR = path.join(tmpDir, "state");
      process.env.XDG_DATA_HOME = path.join(tmpDir, "data");
      process.env.XDG_STATE_HOME = path.join(tmpDir, "state");
      process.env.AKM_FORCE_SETUP_TMP_STASH = "1";

      // Should NOT throw the SETUP_TMP_STASH_REFUSED error. We do not assert
      // the call fully succeeds (it depends on a lot of subsystems being
      // available); we just assert the guard doesn't fire.
      await expect(runSetupWithDefaults({ dir: tmpDir, noInit: true })).resolves.toMatchObject({ stashDir: tmpDir });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("a persistent --dir (e.g. ~/test-stash) is NOT refused", async () => {
    const persistentDir = fs.mkdtempSync(path.join(os.homedir(), ".akm-setup-guard-test-"));
    try {
      process.env.AKM_STASH_DIR = persistentDir;
      process.env.AKM_DATA_DIR = path.join(persistentDir, "data");
      process.env.AKM_STATE_DIR = path.join(persistentDir, "state");
      process.env.XDG_DATA_HOME = path.join(persistentDir, "data");
      process.env.XDG_STATE_HOME = path.join(persistentDir, "state");
      // Critically: persistentDir is under HOME (not /tmp), so guard does
      // not fire. Need a config-dir override since persistent stash does
      // not trigger the isolation rule.
      process.env.AKM_CONFIG_DIR = path.join(persistentDir, "config");
      delete process.env.AKM_FORCE_SETUP_TMP_STASH;

      await expect(runSetupWithDefaults({ dir: persistentDir, noInit: true })).resolves.toMatchObject({
        stashDir: persistentDir,
      });
    } finally {
      fs.rmSync(persistentDir, { recursive: true, force: true });
    }
  });
});

// ── Layer 1.5: --dir alone (no AKM_STASH_DIR pre-set) still isolates ───────

describe("setup pre-sets AKM_STASH_DIR when --dir is given (so layer 2 fires)", () => {
  test("--dir /tmp/X without pre-set AKM_STASH_DIR routes config into the stash too", async () => {
    // Reproduces the exact bug Copilot flagged: a CLI caller who passes
    // --dir /tmp/X but does NOT pre-export AKM_STASH_DIR would, without
    // applyStashIsolationToEnv, still see getConfigDir() fall through to
    // the host ~/.config/akm and clobber it. Setup must propagate the
    // operator's --dir choice to AKM_STASH_DIR so the isolation rule fires.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-setup-isolation-cli-"));
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "akm-setup-fakehome-cli-"));
    const hostConfigDir = path.join(fakeHome, ".config", "akm");
    fs.mkdirSync(hostConfigDir, { recursive: true });
    const hostConfigPath = path.join(hostConfigDir, "config.json");
    // Canary uses a real schema key — the host config must round-trip cleanly
    // through strict validation as part of the protected pre-condition.
    const hostConfigContent = '{"semanticSearchMode":"off"}\n';
    fs.writeFileSync(hostConfigPath, hostConfigContent);
    const hostMtimeBefore = fs.statSync(hostConfigPath).mtimeMs;

    try {
      process.env.HOME = fakeHome;
      // CRITICALLY: do NOT set AKM_STASH_DIR before the call. We want the
      // setup code to set it for us. This mirrors the CLI invocation
      // `akm setup --dir /tmp/X` with no env pre-arrangement.
      delete process.env.AKM_STASH_DIR;
      process.env.AKM_DATA_DIR = path.join(tmpDir, "data");
      process.env.AKM_STATE_DIR = path.join(tmpDir, "state");
      process.env.XDG_DATA_HOME = path.join(tmpDir, "data");
      process.env.XDG_STATE_HOME = path.join(tmpDir, "state");
      delete process.env.AKM_CONFIG_DIR;
      delete process.env.XDG_CONFIG_HOME;
      process.env.AKM_FORCE_SETUP_TMP_STASH = "1"; // opt past layer 1

      await runSetupWithDefaults({ dir: tmpDir, noInit: true });

      // The host config must be byte-identical, even though we did not
      // pre-set AKM_STASH_DIR ourselves.
      const hostConfigAfter = fs.readFileSync(hostConfigPath, "utf8");
      expect(hostConfigAfter).toBe(hostConfigContent);
      expect(fs.statSync(hostConfigPath).mtimeMs).toBe(hostMtimeBefore);

      // And the isolated config must have landed in the stash.
      expect(fs.existsSync(path.join(tmpDir, ".akm", "config.json"))).toBe(true);

      // Setup is expected to have pre-set AKM_STASH_DIR for the duration
      // of the call (we don't reset it; the afterEach hook does).
      expect(process.env.AKM_STASH_DIR ?? "").toBe(tmpDir);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test("operator-set AKM_STASH_DIR wins over the auto-set (existing env preserved)", async () => {
    // If the operator already exported AKM_STASH_DIR=somewhere-else, do not
    // overwrite it. (Defense against a setup call that uses --dir for stash
    // bootstrap but expects config to follow a different env-anchored path.)
    const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-setup-prefer-env-stash-"));
    const envStashDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-setup-prefer-env-other-"));

    try {
      process.env.AKM_STASH_DIR = envStashDir;
      process.env.AKM_DATA_DIR = path.join(stashDir, "data");
      process.env.AKM_STATE_DIR = path.join(stashDir, "state");
      process.env.XDG_DATA_HOME = path.join(stashDir, "data");
      process.env.XDG_STATE_HOME = path.join(stashDir, "state");
      process.env.AKM_FORCE_SETUP_TMP_STASH = "1";

      await runSetupWithDefaults({ dir: stashDir, noInit: true });

      // The pre-existing AKM_STASH_DIR was NOT overwritten by the --dir value.
      expect(process.env.AKM_STASH_DIR ?? "").toBe(envStashDir);
    } finally {
      fs.rmSync(stashDir, { recursive: true, force: true });
      fs.rmSync(envStashDir, { recursive: true, force: true });
    }
  });
});

// ── Layer 2: getConfigDir isolation under transient AKM_STASH_DIR ──────────

describe("setup config isolation (layer 2: getConfigDir under transient stash)", () => {
  test("even with escape hatch, config writes do NOT touch host ~/.config/akm/config.json", async () => {
    // Verify the second layer: when AKM_FORCE_SETUP_TMP_STASH is set
    // (operator override), the assertSetupSandbox guard yields — but the
    // getConfigDir isolation rule still routes config writes into the
    // stash. The host config file at ~/.config/akm/config.json must not
    // be modified.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-setup-isolation-"));
    const hostConfigContent = '{"hostConfigCanary":true,"stashDir":"/home/test/host-akm"}\n';

    // Synthesize a host config in a sandboxed HOME so we can assert it
    // really stays untouched. (Pointing HOME at the temp dir effectively
    // moves the host's ~/.config/akm into our sandbox; if isolation
    // works, the file at HOME/.config/akm/config.json remains as
    // hostConfigContent. If isolation fails, setup overwrites it.)
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "akm-setup-fakehome-"));
    const hostConfigDir = path.join(fakeHome, ".config", "akm");
    fs.mkdirSync(hostConfigDir, { recursive: true });
    const hostConfigPath = path.join(hostConfigDir, "config.json");
    fs.writeFileSync(hostConfigPath, hostConfigContent);
    const hostMtimeBefore = fs.statSync(hostConfigPath).mtimeMs;

    try {
      process.env.HOME = fakeHome;
      process.env.AKM_STASH_DIR = tmpDir;
      process.env.AKM_DATA_DIR = path.join(tmpDir, "data");
      process.env.AKM_STATE_DIR = path.join(tmpDir, "state");
      process.env.XDG_DATA_HOME = path.join(tmpDir, "data");
      process.env.XDG_STATE_HOME = path.join(tmpDir, "state");
      // Important: do NOT set AKM_CONFIG_DIR — we want to verify the
      // isolation rule fires (which it does only when AKM_CONFIG_DIR is
      // unset and AKM_STASH_DIR is transient).
      delete process.env.AKM_CONFIG_DIR;
      delete process.env.XDG_CONFIG_HOME;
      process.env.AKM_FORCE_SETUP_TMP_STASH = "1";

      await runSetupWithDefaults({ dir: tmpDir, noInit: true });

      // The host config must be byte-identical to what we wrote before.
      const hostConfigAfter = fs.readFileSync(hostConfigPath, "utf8");
      expect(hostConfigAfter).toBe(hostConfigContent);
      const hostMtimeAfter = fs.statSync(hostConfigPath).mtimeMs;
      expect(hostMtimeAfter).toBe(hostMtimeBefore);

      // The isolated config must have been written into the stash.
      const isolatedConfigPath = path.join(tmpDir, ".akm", "config.json");
      expect(fs.existsSync(isolatedConfigPath)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
