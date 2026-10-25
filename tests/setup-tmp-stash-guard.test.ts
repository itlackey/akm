// Regression tests for the 2026-05-23 setup-clobbers-user-config incident.
//
// Two layers of defense, both tested here:
//   1. assertSetupSandbox (in src/setup/setup.ts): refuses `akm setup --dir
//      /tmp/X` unless AKM_FORCE_SETUP_TMP_STASH=1. Tested indirectly by
//      invoking runSetupWithDefaults / runSetupFromConfig with /tmp paths.
//   2. getConfigDir (in src/core/paths.ts): when AKM_BUNDLE_DIR points at a
//      transient path, isolates config writes into $STASH/.akm/. Tested
//      end-to-end by running setup with the escape hatch and asserting the
//      host config file is untouched.
//
// Both layers are intentionally redundant: layer 1 fails fast for the
// common case; layer 2 ensures that even when the user opts in to the
// escape hatch, the host config is still preserved.
//
// Requires TMPDIR (if set) to be a /tmp-family path: fixtures are built
// under os.tmpdir() (via makeSandboxDir), and isTransientStashPath()
// deliberately hardcodes /tmp, /var/tmp, and their macOS /private
// equivalents rather than reading TMPDIR. A relocated TMPDIR makes these
// fixtures fail for reasons unrelated to the guard under test.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import { assertSetupSandbox, runSetupFromConfig, runSetupWithDefaults } from "../src/setup/setup";
import { makeSandboxDir, withEnv } from "./_helpers/sandbox";

function captureWarnings(): { warnings: string[]; restore: () => void } {
  const warnings: string[] = [];
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
  return {
    warnings,
    restore: () => {
      _setWarnSinkForTests(undefined);
      _resetWarnOnceForTests();
    },
  };
}

// ── Layer 1: assertSetupSandbox warns on /tmp/* explicit --dir ─────────────

describe("setup tmp-stash guard (layer 1: assertSetupSandbox)", () => {
  test("runSetupWithDefaults warns and proceeds for --dir /tmp/X", async () => {
    const { dir: tmpDir, cleanup } = makeSandboxDir("akm-setup-guard-");
    const { warnings, restore } = captureWarnings();
    try {
      await withEnv(
        {
          AKM_BUNDLE_DIR: tmpDir,
          AKM_DATA_DIR: path.join(tmpDir, "data"),
          AKM_STATE_DIR: path.join(tmpDir, "state"),
          XDG_DATA_HOME: path.join(tmpDir, "data"),
          XDG_STATE_HOME: path.join(tmpDir, "state"),
        },
        async () => {
          await expect(runSetupWithDefaults({ dir: tmpDir, noInit: true })).resolves.toMatchObject({
            bundleDir: tmpDir,
          });
          expect(warnings.some((w) => w.includes("transient/sandbox"))).toBe(true);
          expect(warnings.some((w) => w.includes(tmpDir))).toBe(true);
        },
      );
    } finally {
      restore();
      cleanup();
    }
  });

  test("runSetupFromConfig warns and proceeds for --dir /tmp/X", async () => {
    const { dir: tmpDir, cleanup } = makeSandboxDir("akm-setup-guard-");
    const { warnings, restore } = captureWarnings();
    try {
      await withEnv(
        {
          AKM_BUNDLE_DIR: tmpDir,
          AKM_DATA_DIR: path.join(tmpDir, "data"),
          AKM_STATE_DIR: path.join(tmpDir, "state"),
          XDG_DATA_HOME: path.join(tmpDir, "data"),
          XDG_STATE_HOME: path.join(tmpDir, "state"),
        },
        async () => {
          await expect(runSetupFromConfig({ configJson: "{}", dir: tmpDir, noInit: true })).resolves.toBeDefined();
          expect(warnings.some((w) => w.includes("transient/sandbox"))).toBe(true);
        },
      );
    } finally {
      restore();
      cleanup();
    }
  });

  test("a persistent --dir is NOT refused and does not warn", () => {
    const { warnings, restore } = captureWarnings();
    try {
      expect(() => assertSetupSandbox("/home/example/akm", true)).not.toThrow();
      expect(warnings).toHaveLength(0);
    } finally {
      restore();
    }
  });

  test("assertSetupSandbox warns at most once per stash path per process", () => {
    const { warnings, restore } = captureWarnings();
    try {
      assertSetupSandbox("/tmp/akm-dedupe-example", true);
      assertSetupSandbox("/tmp/akm-dedupe-example", true);
      expect(warnings).toHaveLength(1);
    } finally {
      restore();
    }
  });
});

// ── Layer 1.5: --dir alone (no AKM_BUNDLE_DIR pre-set) still isolates ───────

describe("setup pre-sets AKM_BUNDLE_DIR when --dir is given (so layer 2 fires)", () => {
  test("--dir /tmp/X without pre-set AKM_BUNDLE_DIR routes config into the stash too", async () => {
    // Reproduces the exact bug Copilot flagged: a CLI caller who passes
    // --dir /tmp/X but does NOT pre-export AKM_BUNDLE_DIR would, without
    // applyStashIsolationToEnv, still see getConfigDir() fall through to
    // the host ~/.config/akm and clobber it. Setup must propagate the
    // operator's --dir choice to AKM_BUNDLE_DIR so the isolation rule fires.
    const { dir: tmpDir, cleanup: cleanupTmp } = makeSandboxDir("akm-setup-isolation-cli-");
    const { dir: fakeHome, cleanup: cleanupHome } = makeSandboxDir("akm-setup-fakehome-cli-");
    const hostConfigDir = path.join(fakeHome, ".config", "akm");
    fs.mkdirSync(hostConfigDir, { recursive: true });
    const hostConfigPath = path.join(hostConfigDir, "config.json");
    // Canary uses a real schema key — the host config must round-trip cleanly
    // through strict validation as part of the protected pre-condition.
    const hostConfigContent = '{"configVersion":"0.9.0","semanticSearchMode":"off"}\n';
    fs.writeFileSync(hostConfigPath, hostConfigContent);
    const hostMtimeBefore = fs.statSync(hostConfigPath).mtimeMs;

    try {
      await withEnv(
        {
          HOME: fakeHome,
          // CRITICALLY: do NOT set AKM_BUNDLE_DIR before the call. We want the
          // setup code to set it for us. This mirrors the CLI invocation
          // `akm setup --dir /tmp/X` with no env pre-arrangement.
          AKM_BUNDLE_DIR: undefined,
          AKM_DATA_DIR: path.join(tmpDir, "data"),
          AKM_STATE_DIR: path.join(tmpDir, "state"),
          XDG_DATA_HOME: path.join(tmpDir, "data"),
          XDG_STATE_HOME: path.join(tmpDir, "state"),
          AKM_CONFIG_DIR: undefined,
          XDG_CONFIG_HOME: undefined,
        },
        async () => {
          await runSetupWithDefaults({ dir: tmpDir, noInit: true });

          // The host config must be byte-identical, even though we did not
          // pre-set AKM_BUNDLE_DIR ourselves.
          const hostConfigAfter = fs.readFileSync(hostConfigPath, "utf8");
          expect(hostConfigAfter).toBe(hostConfigContent);
          expect(fs.statSync(hostConfigPath).mtimeMs).toBe(hostMtimeBefore);

          // And the isolated config must have landed in the stash.
          expect(fs.existsSync(path.join(tmpDir, ".akm", "config.json"))).toBe(true);

          // Setup is expected to have pre-set AKM_BUNDLE_DIR for the duration
          // of the call (withEnv restores it afterward).
          expect(process.env.AKM_BUNDLE_DIR ?? "").toBe(tmpDir);
        },
      );
    } finally {
      cleanupTmp();
      cleanupHome();
    }
  });

  test("operator-set AKM_BUNDLE_DIR wins over the auto-set (existing env preserved)", async () => {
    // If the operator already exported AKM_BUNDLE_DIR=somewhere-else, do not
    // overwrite it. (Defense against a setup call that uses --dir for stash
    // bootstrap but expects config to follow a different env-anchored path.)
    const { dir: stashDir, cleanup: cleanupStash } = makeSandboxDir("akm-setup-prefer-env-stash-");
    const { dir: envStashDir, cleanup: cleanupEnvStash } = makeSandboxDir("akm-setup-prefer-env-other-");

    try {
      await withEnv(
        {
          AKM_BUNDLE_DIR: envStashDir,
          AKM_DATA_DIR: path.join(stashDir, "data"),
          AKM_STATE_DIR: path.join(stashDir, "state"),
          XDG_DATA_HOME: path.join(stashDir, "data"),
          XDG_STATE_HOME: path.join(stashDir, "state"),
        },
        async () => {
          await runSetupWithDefaults({ dir: stashDir, noInit: true });

          // The pre-existing AKM_BUNDLE_DIR was NOT overwritten by the --dir value.
          expect(process.env.AKM_BUNDLE_DIR ?? "").toBe(envStashDir);
        },
      );
    } finally {
      cleanupStash();
      cleanupEnvStash();
    }
  });
});

// ── Layer 2: getConfigDir isolation under transient AKM_BUNDLE_DIR ──────────

describe("setup config isolation (layer 2: getConfigDir under transient stash)", () => {
  test("config writes do NOT touch host ~/.config/akm/config.json", async () => {
    // Verify the second layer: the getConfigDir isolation rule routes
    // config writes into the stash regardless of the layer-1 warning. The
    // host config file at ~/.config/akm/config.json must not be modified.
    const { dir: tmpDir, cleanup: cleanupTmp } = makeSandboxDir("akm-setup-isolation-");
    const hostConfigContent = '{"hostConfigCanary":true,"stashDir":"/home/test/host-akm"}\n';

    // Synthesize a host config in a sandboxed HOME so we can assert it
    // really stays untouched. (Pointing HOME at the temp dir effectively
    // moves the host's ~/.config/akm into our sandbox; if isolation
    // works, the file at HOME/.config/akm/config.json remains as
    // hostConfigContent. If isolation fails, setup overwrites it.)
    const { dir: fakeHome, cleanup: cleanupHome } = makeSandboxDir("akm-setup-fakehome-");
    const hostConfigDir = path.join(fakeHome, ".config", "akm");
    fs.mkdirSync(hostConfigDir, { recursive: true });
    const hostConfigPath = path.join(hostConfigDir, "config.json");
    fs.writeFileSync(hostConfigPath, hostConfigContent);
    const hostMtimeBefore = fs.statSync(hostConfigPath).mtimeMs;

    try {
      await withEnv(
        {
          HOME: fakeHome,
          AKM_BUNDLE_DIR: tmpDir,
          AKM_DATA_DIR: path.join(tmpDir, "data"),
          AKM_STATE_DIR: path.join(tmpDir, "state"),
          XDG_DATA_HOME: path.join(tmpDir, "data"),
          XDG_STATE_HOME: path.join(tmpDir, "state"),
          // Important: do NOT set AKM_CONFIG_DIR — we want to verify the
          // isolation rule fires (which it does only when AKM_CONFIG_DIR is
          // unset and AKM_BUNDLE_DIR is transient).
          AKM_CONFIG_DIR: undefined,
          XDG_CONFIG_HOME: undefined,
        },
        async () => {
          await runSetupWithDefaults({ dir: tmpDir, noInit: true });

          // The host config must be byte-identical to what we wrote before.
          const hostConfigAfter = fs.readFileSync(hostConfigPath, "utf8");
          expect(hostConfigAfter).toBe(hostConfigContent);
          const hostMtimeAfter = fs.statSync(hostConfigPath).mtimeMs;
          expect(hostMtimeAfter).toBe(hostMtimeBefore);

          // The isolated config must have been written into the stash.
          const isolatedConfigPath = path.join(tmpDir, ".akm", "config.json");
          expect(fs.existsSync(isolatedConfigPath)).toBe(true);
        },
      );
    } finally {
      cleanupTmp();
      cleanupHome();
    }
  });
});
