/**
 * Tests for issue #511: safe-by-default `akm setup` config management.
 *
 * Covers the three non-interactive write paths (`runSetupFromConfig` and
 * `runSetupWithDefaults`) and their merge / backup guarantees:
 *   - `--file` / `--config` deep-merge: a partial input only updates the keys
 *     it carries and never drops sibling subkeys.
 *   - `--yes` idempotency: running N times == running once (fill-missing-only,
 *     never overwrite an existing value).
 *   - `--yes --file`: deep-merge plus defaults-fill, no prompts.
 *   - no pre-existing key is silently dropped in any mode.
 *   - a real (timestamped) backup is taken when a config already exists.
 *
 * Each test drives the setup functions directly inside an isolated XDG sandbox
 * so config reads/writes/backups land in temp dirs, never the host config.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { _setAkmInitForTests } from "../../../src/commands/sources/init";
import { resetConfigCache } from "../../../src/core/config/config";
import { getConfigLockPath } from "../../../src/core/config/config-io";
import { getConfigPath } from "../../../src/core/paths";
import { rebaseSetupChanges, runSetupFromConfig, runSetupWithDefaults } from "../../../src/setup/setup";
import {
  type Cleanup,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
  sandboxXdgStateHome,
  withEnv,
  withMockedFetch,
  writeSandboxConfig,
} from "../../_helpers/sandbox";

let cleanup: Cleanup | undefined;

beforeEach(() => {
  // Chain isolated XDG dirs so config (write), cache (backups), data & state
  // all resolve into temp dirs for the duration of the test.
  const cfg = sandboxXdgConfigHome();
  const cache = sandboxXdgCacheHome(cfg.cleanup);
  const data = sandboxXdgDataHome(cache.cleanup);
  const state = sandboxXdgStateHome(data.cleanup);
  cleanup = state.cleanup;
  resetConfigCache();
});

afterEach(() => {
  _setAkmInitForTests();
  cleanup?.();
  cleanup = undefined;
});

function readWrittenConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as Record<string, unknown>;
}

function backupDir(): string {
  return path.join(process.env.XDG_CACHE_HOME as string, "akm", "config-backups");
}

/** A fully-populated, persistent (non-transient) starting config. */
function seedFullConfig(): void {
  writeSandboxConfig({
    stashDir: "/home/tester/akm",
    semanticSearchMode: "off",
    output: { format: "json", detail: "full" },
    engines: { claude: { kind: "agent", platform: "claude", bin: "claude" } },
    defaults: { engine: "claude" },
    sources: [{ path: "/home/tester/akm/skills", type: "filesystem" }],
    registries: [{ name: "default", url: "https://example.com/registry" }],
  });
  // writeSandboxConfig writes straight to disk, bypassing saveConfig's cache
  // invalidation — drop the cache so loadUserConfig re-reads the seed.
  resetConfigCache();
}

describe("runSetupFromConfig — deep merge", () => {
  test("three-way rebase preserves disjoint edits and rejects same-field edits", () => {
    const original = { output: { format: "json", detail: "brief" } };
    const desired = { output: { format: "text", detail: "brief" } };
    expect(rebaseSetupChanges(original, desired, { output: { format: "json", detail: "full" } })).toEqual({
      output: { format: "text", detail: "full" },
    });
    expect(() => rebaseSetupChanges(original, desired, { output: { format: "yaml", detail: "brief" } })).toThrow(
      /Setup config conflict at output\.format/,
    );
  });

  test("detects a same-field race before stash initialization", async () => {
    seedFullConfig();
    const seeded = readWrittenConfig();
    seeded.engines = {
      ...(seeded.engines as Record<string, unknown>),
      fast: {
        kind: "llm",
        endpoint: "https://example.test/v1/chat/completions",
        model: "test-model",
      },
    };
    seeded.defaults = { ...(seeded.defaults as Record<string, unknown>), llmEngine: "fast" };
    fs.writeFileSync(getConfigPath(), `${JSON.stringify(seeded)}\n`);
    resetConfigCache();
    let initCalls = 0;
    _setAkmInitForTests(async () => {
      initCalls += 1;
      return { stashDir: "/unused", created: true, configPath: getConfigPath(), defaultStashUpdated: false };
    });

    await withMockedFetch(
      async () => {
        await expect(
          runSetupFromConfig({ configJson: JSON.stringify({ output: { format: "text" } }), probe: true }),
        ).rejects.toThrow(/Setup config conflict at output\.format/);
      },
      () => {
        const concurrent = readWrittenConfig();
        concurrent.output = { ...(concurrent.output as Record<string, unknown>), format: "yaml" };
        fs.writeFileSync(getConfigPath(), `${JSON.stringify(concurrent)}\n`);
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '{"ok":true,"ingest":true,"lint":true}' } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );

    expect(initCalls).toBe(0);
    expect((readWrittenConfig().output as Record<string, unknown>).format).toBe("yaml");
  });

  test("partial --file updates a nested key but preserves sibling subkeys", async () => {
    seedFullConfig();

    await runSetupFromConfig({
      configJson: JSON.stringify({ output: { format: "text" } }),
      noInit: true,
    });

    const written = readWrittenConfig();
    const output = written.output as Record<string, unknown>;
    // The updated subkey changed...
    expect(output.format).toBe("text");
    // ...but its sibling survived (the bug this fixes: shallow replace dropped it).
    expect(output.detail).toBe("full");
    // And unrelated top-level keys are untouched.
    expect(written.engines).toEqual({ claude: { kind: "agent", platform: "claude", bin: "claude" } });
    expect(written.defaults).toEqual({ engine: "claude" });
    expect(written.sources).toEqual([{ path: "/home/tester/akm/skills", type: "filesystem" }]);
    expect(written.registries).toEqual([{ name: "default", url: "https://example.com/registry" }]);
  });

  test("--config follows the identical deep-merge semantics as --file", async () => {
    seedFullConfig();

    // --config and --file share runSetupFromConfig; this asserts the JSON-blob
    // path deep-merges too (sibling subkey survives).
    await runSetupFromConfig({
      configJson: JSON.stringify({ output: { detail: "brief" } }),
      noInit: true,
    });

    const output = readWrittenConfig().output as Record<string, unknown>;
    expect(output.detail).toBe("brief");
    expect(output.format).toBe("json");
  });

  test("nested engines merge key-by-key (sibling agent engine survives)", async () => {
    seedFullConfig();

    // Adding a second agent engine must not drop the seeded `claude` engine.
    await runSetupFromConfig({
      configJson: JSON.stringify({
        engines: { opencode: { kind: "agent", platform: "opencode", bin: "opencode" } },
      }),
      noInit: true,
    });

    const engines = readWrittenConfig().engines as Record<string, unknown>;
    expect(engines.claude).toEqual({ kind: "agent", platform: "claude", bin: "claude" });
    expect(engines.opencode).toEqual({ kind: "agent", platform: "opencode", bin: "opencode" });
  });

  test("an empty --config drops no pre-existing key", async () => {
    seedFullConfig();
    const before = readWrittenConfig();

    await runSetupFromConfig({ configJson: "{}", noInit: true });

    const after = readWrittenConfig();
    for (const key of Object.keys(before)) {
      expect(after[key]).toEqual(before[key]);
    }
  });
});

describe("runSetupFromConfig — backup guarantees", () => {
  test("creates a real timestamped backup when a config already exists", async () => {
    seedFullConfig();

    const result = await runSetupFromConfig({
      configJson: JSON.stringify({ output: { format: "text" } }),
      noInit: true,
    });
    expect(result.written).toBe(true);

    const entries = fs.readdirSync(backupDir());
    expect(entries.some((n) => /^config-.*\.json$/.test(n) && n !== "config.latest.json")).toBe(true);
    expect(entries).toContain("config.latest.json");
  });

  test("creates the mandatory backup before stash initialization", async () => {
    seedFullConfig();
    let backupExistedAtInit = false;
    _setAkmInitForTests(async () => {
      backupExistedAtInit = fs.existsSync(path.join(backupDir(), "config.latest.json"));
      return { stashDir: "/unused", created: true, configPath: getConfigPath(), defaultStashUpdated: false };
    });

    await runSetupFromConfig({ configJson: JSON.stringify({ output: { format: "text" } }) });

    expect(backupExistedAtInit).toBe(true);
  });

  test("refuses stash initialization when the mandatory backup cannot be created", async () => {
    seedFullConfig();
    const unusableCacheRoot = path.join(process.env.HOME as string, "cache-root-file");
    fs.writeFileSync(unusableCacheRoot, "not a directory");
    let initCalls = 0;
    _setAkmInitForTests(async () => {
      initCalls++;
      return { stashDir: "/unused", created: true, configPath: getConfigPath(), defaultStashUpdated: false };
    });

    await withEnv({ XDG_CACHE_HOME: unusableCacheRoot }, async () => {
      await expect(
        runSetupFromConfig({ configJson: JSON.stringify({ output: { format: "text" } }) }),
      ).rejects.toThrow();
    });

    expect(initCalls).toBe(0);
    expect((readWrittenConfig().output as Record<string, unknown>).format).toBe("json");
  });
});

describe("runSetupFromConfig — --yes (applyDefaults) deep-merge + fill", () => {
  test("deep-merges the file and leaves non-file keys untouched", async () => {
    seedFullConfig();

    await runSetupFromConfig({
      configJson: JSON.stringify({ output: { format: "text" } }),
      noInit: true,
      applyDefaults: true,
    });

    const written = readWrittenConfig();
    const output = written.output as Record<string, unknown>;
    expect(output.format).toBe("text");
    expect(output.detail).toBe("full");
    // Existing values preserved; defaults only fill what was missing.
    expect(written.stashDir).toBe("/home/tester/akm");
    expect(written.defaults).toEqual({ engine: "claude" });
  });
});

describe("runSetupWithDefaults — idempotency", () => {
  test("preserves every existing value and is idempotent across runs", async () => {
    seedFullConfig();

    await runSetupWithDefaults({ noInit: true });
    const first = fs.readFileSync(getConfigPath(), "utf8");

    await runSetupWithDefaults({ noInit: true });
    const second = fs.readFileSync(getConfigPath(), "utf8");

    // Idempotency contract: running N times == running once. Detection
    // (#514) may legitimately inject engines (e.g. a live local LLM), so the
    // first run is not a no-op — but the SECOND run must add/change nothing.
    // Compare structurally rather than byte-for-byte: JSON object key
    // insertion order is not part of the config's identity, and the apply
    // helpers can reorder `engines`/`defaults` keys without altering content.
    expect(JSON.parse(second)).toEqual(JSON.parse(first));

    // No pre-existing value was overwritten by a default.
    const written = JSON.parse(first) as Record<string, unknown>;
    expect(written.stashDir).toBe("/home/tester/akm");
    expect(written.output).toEqual({ format: "json", detail: "full" });
    expect(written.sources).toEqual([{ path: "/home/tester/akm/skills", type: "filesystem" }]);
    expect(written.registries).toEqual([{ name: "default", url: "https://example.com/registry" }]);
    // The pre-existing agent default must survive untouched. Detection (#514)
    // may ADD other defaults (e.g. an LLM engine when a live local server is
    // present on the host), but it must never overwrite the seeded agent engine.
    expect((written.defaults as Record<string, unknown>).engine).toBe("claude");
  });

  test("on a fresh install writes config and takes no backup", async () => {
    // No seed: no config on disk yet.
    expect(fs.existsSync(getConfigPath())).toBe(false);

    const result = await runSetupWithDefaults({ noInit: true });
    expect(result.written).toBe(true);
    expect(fs.existsSync(getConfigPath())).toBe(true);

    // Nothing to back up on a fresh install → no backup files written.
    expect(fs.existsSync(backupDir())).toBe(false);
  });

  test("full initialization still performs only setup's one final config write", async () => {
    const result = await withEnv({ AKM_FORCE_INIT_TMP_STASH: "1" }, () => runSetupWithDefaults({ noInit: false }));
    expect(result.stashCreated).toBe(true);
    expect(fs.existsSync(getConfigPath())).toBe(true);
    expect(fs.existsSync(backupDir())).toBe(false);
  });

  test("rejects a conflicting engine kind before config or stash side effects", async () => {
    const stashDir = path.join(process.env.HOME as string, "akm");
    fs.rmSync(stashDir, { recursive: true, force: true });
    await expect(
      runSetupFromConfig({
        configJson: JSON.stringify({
          engines: { agent: { kind: "agent", platform: "claude" } },
          defaults: { llmEngine: "agent" },
        }),
        noInit: false,
      }),
    ).rejects.toThrow(/llmEngine must name an LLM engine/);
    expect(fs.existsSync(getConfigPath())).toBe(false);
    expect(fs.existsSync(stashDir)).toBe(false);
  });

  test("fails a config-lock conflict before initializing the stash", async () => {
    const stashDir = path.join(process.env.HOME as string, "setup-lock-boundary");
    fs.rmSync(stashDir, { recursive: true, force: true });
    await withEnv(
      {
        AKM_STASH_DIR: stashDir,
        AKM_FORCE_SETUP_TMP_STASH: "1",
        AKM_FORCE_INIT_TMP_STASH: "1",
      },
      async () => {
        fs.mkdirSync(path.dirname(getConfigLockPath()), { recursive: true });
        fs.writeFileSync(getConfigLockPath(), String(process.pid));
        try {
          await expect(
            runSetupFromConfig({
              configJson: JSON.stringify({ stashDir, semanticSearchMode: "off" }),
              noInit: false,
            }),
          ).rejects.toThrow(/Timed out waiting for config lock/);
          expect(fs.existsSync(path.join(stashDir, "memories"))).toBe(false);
        } finally {
          fs.rmSync(getConfigLockPath(), { force: true });
        }
      },
    );
  });
});
