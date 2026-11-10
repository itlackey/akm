// Regression tests for the 2026-05-23 setup-clobbers-user-config incident.
//
// Two layers of defense, both tested here:
//   1. assertSetupSandbox (in src/setup/setup.ts): refuses `akm setup --dir
//      /tmp/X` unless AKM_FORCE_SETUP_TMP_STASH=1. Tested indirectly by
//      invoking runSetupWithDefaults / runSetupFromConfig with /tmp paths.
//   2. isolateTransientSetup (in src/setup/setup.ts): `akm setup --dir
//      <transient>` writes its config to $STASH/.akm/config.json (with
//      `paths.cache` beside it) and points AKM_CONFIG_FILE at it for the run.
//      Tested end-to-end by running setup and asserting the host config
//      file and cache are untouched.
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

import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getCacheDir } from "../src/core/paths";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import { assertSetupSandbox, runSetupFromConfig, runSetupWithDefaults } from "../src/setup/setup";
import { fakeOpencodeMajor } from "./_helpers/opencode-version";
import { makeSandboxDir, withBundle, withEnv } from "./_helpers/sandbox";

// Setup asks the PATH `opencode` which major it is; no suite runs a real one.
beforeEach(() => fakeOpencodeMajor(1));

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
      await withEnv({ XDG_DATA_HOME: path.join(tmpDir, "data"), XDG_STATE_HOME: path.join(tmpDir, "state") }, () =>
        withBundle(tmpDir, async () => {
          await expect(runSetupWithDefaults({ dir: tmpDir, noInit: true })).resolves.toMatchObject({
            bundleDir: tmpDir,
          });
          expect(warnings.some((w) => w.includes("transient/sandbox"))).toBe(true);
          expect(warnings.some((w) => w.includes(tmpDir))).toBe(true);
        }),
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
      await withEnv({ XDG_DATA_HOME: path.join(tmpDir, "data"), XDG_STATE_HOME: path.join(tmpDir, "state") }, () =>
        withBundle(tmpDir, async () => {
          await expect(runSetupFromConfig({ configJson: "{}", dir: tmpDir, noInit: true })).resolves.toBeDefined();
          expect(warnings.some((w) => w.includes("transient/sandbox"))).toBe(true);
        }),
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

// ── Layer 1.5: --dir alone (no AKM_CONFIG_FILE pre-set) still isolates ───────

describe("setup points AKM_CONFIG_FILE into the stash when --dir is transient (so layer 2 fires)", () => {
  test("--dir /tmp/X without a pre-set config routes config and cache into the stash too", async () => {
    // Reproduces the exact bug Copilot flagged: a CLI caller who passes
    // --dir /tmp/X but pre-arranges nothing would, without isolateTransientSetup,
    // still see getConfigPath() fall through to the host ~/.config/akm and
    // clobber it. Setup must choose a config file under the stash for the run.
    const { dir: tmpDir, cleanup: cleanupTmp } = makeSandboxDir("akm-setup-isolation-cli-");
    const { dir: fakeHome, cleanup: cleanupHome } = makeSandboxDir("akm-setup-fakehome-cli-");
    const hostConfigDir = path.join(fakeHome, ".config", "akm");
    fs.mkdirSync(hostConfigDir, { recursive: true });
    const hostConfigPath = path.join(hostConfigDir, "config.json");
    // Canary uses a real schema key — the host config must round-trip cleanly
    // through strict validation as part of the protected pre-condition.
    const hostConfigContent = '{"semanticSearchMode":"off"}\n';
    fs.writeFileSync(hostConfigPath, hostConfigContent);
    const hostMtimeBefore = fs.statSync(hostConfigPath).mtimeMs;
    const hostCache = path.join(fakeHome, ".cache", "akm");

    try {
      await withEnv(
        {
          HOME: fakeHome,
          // CRITICALLY: pre-arrange no config location. This mirrors the CLI
          // invocation `akm setup --dir /tmp/X` with no env pre-arrangement.
          AKM_CONFIG_FILE: undefined,
          XDG_CONFIG_HOME: undefined,
          XDG_CACHE_HOME: undefined,
          XDG_DATA_HOME: path.join(tmpDir, "data"),
          XDG_STATE_HOME: path.join(tmpDir, "state"),
        },
        async () => {
          await runSetupWithDefaults({ dir: tmpDir, noInit: true });

          // The host config must be byte-identical, even though nothing was
          // pre-arranged.
          const hostConfigAfter = fs.readFileSync(hostConfigPath, "utf8");
          expect(hostConfigAfter).toBe(hostConfigContent);
          expect(fs.statSync(hostConfigPath).mtimeMs).toBe(hostMtimeBefore);

          // And the isolated config must have landed in the stash, with its cache beside it
          // (the config backups are written there, not under the host's ~/.cache/akm).
          const isolated = path.join(tmpDir, ".akm", "config.json");
          expect(fs.existsSync(isolated)).toBe(true);
          expect(JSON.parse(fs.readFileSync(isolated, "utf8")).paths).toEqual({ cache: "cache" });
          expect(getCacheDir()).toBe(path.join(tmpDir, ".akm", "cache"));
          expect(fs.existsSync(hostCache)).toBe(false);

          // Setup chose the file for the duration of the run (withEnv restores it afterward).
          expect(process.env.AKM_CONFIG_FILE).toBe(isolated);
        },
      );
    } finally {
      cleanupTmp();
      cleanupHome();
    }
  });

  test("a config file the operator chose wins over the auto-set (existing env preserved)", async () => {
    // If the operator already exported AKM_CONFIG_FILE=somewhere-else, do not
    // overwrite it, and write nothing into the stash.
    const { dir: stashDir, cleanup: cleanupStash } = makeSandboxDir("akm-setup-prefer-env-stash-");
    const { dir: otherDir, cleanup: cleanupOther } = makeSandboxDir("akm-setup-prefer-env-other-");
    const chosen = path.join(otherDir, "chosen.json");

    try {
      await withEnv(
        {
          AKM_CONFIG_FILE: chosen,
          XDG_DATA_HOME: path.join(stashDir, "data"),
          XDG_STATE_HOME: path.join(stashDir, "state"),
        },
        async () => {
          await runSetupWithDefaults({ dir: stashDir, noInit: true });

          expect(process.env.AKM_CONFIG_FILE).toBe(chosen);
          expect(fs.existsSync(chosen)).toBe(true);
          expect(fs.existsSync(path.join(stashDir, ".akm", "config.json"))).toBe(false);
        },
      );
    } finally {
      cleanupStash();
      cleanupOther();
    }
  });

  test("an XDG_CONFIG_HOME the operator pre-arranged wins too, and a persistent --dir is not isolated", async () => {
    const { dir: stashDir, cleanup: cleanupStash } = makeSandboxDir("akm-setup-prefer-xdg-");
    const xdg = path.join(stashDir, "xdg-config");
    try {
      await withEnv({ AKM_CONFIG_FILE: undefined, XDG_CONFIG_HOME: xdg }, async () => {
        await runSetupWithDefaults({ dir: stashDir, noInit: true });
        expect(process.env.AKM_CONFIG_FILE).toBeUndefined();
        expect(fs.existsSync(path.join(xdg, "akm", "config.json"))).toBe(true);
        expect(fs.existsSync(path.join(stashDir, ".akm", "config.json"))).toBe(false);
      });
    } finally {
      cleanupStash();
    }
  });
});

// ── Layer 2: the stash-held config under a transient --dir ──────────────────

describe("setup config isolation (layer 2: isolateTransientSetup under a transient stash)", () => {
  test("config writes do NOT touch host ~/.config/akm/config.json", async () => {
    // Verify the second layer: setup routes config writes into the stash
    // regardless of the layer-1 warning. The host config file at
    // ~/.config/akm/config.json must not be modified.
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
          // Important: no AKM_CONFIG_FILE and no XDG_CONFIG_HOME: the isolation
          // rule fires only when the operator pre-arranged neither.
          AKM_CONFIG_FILE: undefined,
          XDG_CONFIG_HOME: undefined,
          XDG_DATA_HOME: path.join(tmpDir, "data"),
          XDG_STATE_HOME: path.join(tmpDir, "state"),
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
